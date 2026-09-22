'use strict';
// The one pipeline every source of transactions goes through: statement
// uploads, Plaid syncs, manual re-categorization. It deduplicates against what
// is already stored, assigns categories locally (merchant memory → keyword
// rules → the bank's or Plaid's own category), then asks Claude about whatever
// is left when a key is configured.

const crypto = require('crypto');
const { quickNormalizeName } = require('./normalize');
const { autoCategory, mapBankCategory, mapPlaidCategory, HIGH_CONFIDENCE, LOW_CONFIDENCE } = require('./categories');
const ai = require('./ai');

const AI_BATCH = 20;

// Keys that identify an already-imported transaction, whichever way its
// merchant was written at the time.
function dedupKeys(transactions) {
  const keys = new Set();
  for (const t of transactions) {
    keys.add(`${t.date}|${t.merchant}|${t.amount}`);
    if (t.rawSource) keys.add(`${t.date}|${t.rawSource}|${t.amount}`);
  }
  return keys;
}

// Best local guess for a raw merchant string. Returns { name, category } where
// category may be null; a hint is a category from the bank/Plaid.
function localCategory(rawMerchant, merchants, hint) {
  const name = quickNormalizeName(rawMerchant);
  let category = merchants[name] || merchants[rawMerchant] || null;
  let learned = false;
  if (!category) {
    category = autoCategory(rawMerchant) || autoCategory(name) || hint || null;
    learned = Boolean(category);
  }
  return { name, category, learned };
}

// Runs Claude over unknown merchants. Confident answers are applied to the
// rows and remembered; middling ones come back as suggestions for the user;
// the rest are returned as unknowns.
async function aiPass(unknown, rows, merchants, apiKey, onProgress) {
  const suggestions = [];
  const stillUnknown = new Map(unknown);
  const list = [...unknown.keys()];
  const batches = Math.ceil(list.length / AI_BATCH);
  for (let b = 0; b < batches; b++) {
    const batch = list.slice(b * AI_BATCH, (b + 1) * AI_BATCH);
    if (onProgress) {
      const end = Math.min((b + 1) * AI_BATCH, list.length);
      onProgress(b / batches, batches > 1
        ? `AI: merchants ${b * AI_BATCH + 1}–${end} of ${list.length}…`
        : `AI: categorizing ${list.length} merchant${list.length !== 1 ? 's' : ''}…`);
    }
    let results;
    try {
      results = await ai.categorizeMerchants(batch, apiKey);
    } catch (err) {
      console.error(`AI categorization batch ${b + 1} failed:`, err.message);
      continue;
    }
    for (const r of results) {
      const cleanName = r.normalized || unknown.get(r.merchant) || r.merchant;
      if (r.confidence >= HIGH_CONFIDENCE) {
        merchants[cleanName] = r.category;
        for (const t of rows) {
          if (t._raw === r.merchant && !t.category) { t.merchant = cleanName; t.category = r.category; }
        }
        stillUnknown.delete(r.merchant);
      } else if (r.confidence >= LOW_CONFIDENCE) {
        for (const t of rows) if (t._raw === r.merchant) t.merchant = cleanName;
        suggestions.push({ merchant: cleanName, category: r.category, confidence: r.confidence });
        stillUnknown.delete(r.merchant);
      }
    }
  }
  return { suggestions, unknownMerchants: [...stillUnknown.values()] };
}

// Turns parsed statement rows into stored transactions.
// rows: [{ date, merchant, amount, csvCategory? }]
// meta: { source, card }
async function importRows(store, rows, meta, { apiKey = null, onProgress } = {}) {
  const transactions = store.read('transactions');
  const merchants = store.read('merchants');
  const existing = dedupKeys(transactions);
  const fresh = [];
  const unknown = new Map(); // raw name → normalized name

  for (const r of rows) {
    const raw = r.merchant;
    const { name, category, learned } = localCategory(raw, merchants, mapBankCategory(r.csvCategory));
    const keyRaw = `${r.date}|${raw}|${r.amount}`;
    const keyNorm = `${r.date}|${name}|${r.amount}`;
    if (existing.has(keyRaw) || existing.has(keyNorm)) continue;
    existing.add(keyRaw);
    existing.add(keyNorm);
    if (learned) merchants[name] = category;
    if (!category) unknown.set(raw, name);
    fresh.push({
      id: crypto.randomUUID(),
      date: r.date,
      merchant: name,
      _raw: raw,
      rawSource: raw,
      amount: r.amount,
      category,
      card: meta.card || undefined,
      source: meta.source,
      importedAt: new Date().toISOString(),
    });
  }

  let suggestions = [];
  let unknownMerchants = [...unknown.values()];
  if (unknown.size && apiKey) {
    ({ suggestions, unknownMerchants } = await aiPass(unknown, fresh, merchants, apiKey, onProgress));
  }
  for (const t of fresh) delete t._raw;

  // Re-read: an AI pass takes a while and the user may have edited meanwhile
  const current = store.read('transactions');
  current.push(...fresh);
  store.write('transactions', current);
  store.write('merchants', merchants);

  return {
    imported: fresh.length,
    total: rows.length,
    duplicates: rows.length - fresh.length,
    suggestions,
    unknownMerchants,
  };
}

// Categorizes everything currently uncategorized: local rules first, then AI.
async function categorizeUncategorized(store, { apiKey = null, onProgress } = {}) {
  const transactions = store.read('transactions');
  const merchants = store.read('merchants');
  const byMerchant = new Map(); // merchant → rows
  for (const t of transactions) {
    if (t.category) continue;
    if (!byMerchant.has(t.merchant)) byMerchant.set(t.merchant, []);
    byMerchant.get(t.merchant).push(t);
  }

  let autoUpdated = 0;
  const unknown = new Map();
  const rows = [];
  for (const [merchant, list] of byMerchant) {
    const category = merchants[merchant] || autoCategory(merchant);
    if (category) {
      merchants[merchant] = category;
      for (const t of list) { t.category = category; autoUpdated++; }
    } else {
      unknown.set(merchant, merchant);
      for (const t of list) { t._raw = merchant; rows.push(t); }
    }
  }

  let suggestions = [];
  let unknownMerchants = [...unknown.keys()];
  if (unknown.size && apiKey) {
    const before = rows.filter(t => !t.category).length;
    ({ suggestions, unknownMerchants } = await aiPass(unknown, rows, merchants, apiKey, onProgress));
    autoUpdated += before - rows.filter(t => !t.category).length;
  }
  for (const t of rows) delete t._raw;

  store.write('transactions', transactions);
  store.write('merchants', merchants);
  return { autoUpdated, suggestions, unknownMerchants };
}

module.exports = { importRows, categorizeUncategorized, localCategory, dedupKeys, aiPass, mapPlaidCategory };
