'use strict';
// The one pipeline every source of transactions goes through: statement
// uploads, Plaid syncs, manual re-categorization. It deduplicates against what
// is already stored, assigns categories locally (merchant memory → keyword
// rules → the bank's or Plaid's own category), then asks Claude about whatever
// is left when a key is configured.

const crypto = require('crypto');
const { quickNormalizeName } = require('./normalize');
const {
  autoCategory, genericCategory, findSimilarMerchant, mapBankCategory, mapPlaidCategory,
  HIGH_CONFIDENCE, LOW_CONFIDENCE,
} = require('./categories');
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

// Best local guess for a raw merchant string, with how sure we are:
// the user's own memory (exact, then a close match) → brand rules → the
// category the bank or Plaid supplied → generic business-type words.
// Returns { name, category, confidence, learned }; category may be null.
function localCategory(rawMerchant, merchants, hint) {
  const name = quickNormalizeName(rawMerchant);
  const remembered = merchants[name] || merchants[rawMerchant];
  if (remembered) return { name, category: remembered, confidence: 1, learned: false };

  const similar = findSimilarMerchant(name, merchants);
  if (similar) return { name, category: similar.category, confidence: similar.score, learned: true };

  const brand = autoCategory(rawMerchant) || autoCategory(name);
  if (brand) return { name, category: brand, confidence: 0.9, learned: true };
  if (hint) return { name, category: hint, confidence: 0.85, learned: true };

  const generic = genericCategory(rawMerchant) || genericCategory(name);
  if (generic) return { name, category: generic, confidence: 0.7, learned: true };
  return { name, category: null, confidence: 0, learned: false };
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

  const guesses = new Map(); // normalized name → { category, confidence } for the user to confirm

  for (const r of rows) {
    const raw = r.merchant;
    const guess = localCategory(raw, merchants, mapBankCategory(r.csvCategory));
    const { name } = guess;
    const keyRaw = `${r.date}|${raw}|${r.amount}`;
    const keyNorm = `${r.date}|${name}|${r.amount}`;
    if (existing.has(keyRaw) || existing.has(keyNorm)) continue;
    existing.add(keyRaw);
    existing.add(keyNorm);

    let category = null;
    if (guess.category && guess.confidence >= HIGH_CONFIDENCE) {
      category = guess.category;
      if (guess.learned) merchants[name] = category;
    } else if (guess.category) {
      guesses.set(name, { category: guess.category, confidence: guess.confidence });
    } else {
      unknown.set(raw, name);
    }
    fresh.push({
      id: crypto.randomUUID(),
      date: r.date,
      merchant: name,
      _raw: raw,
      rawSource: raw,
      amount: r.amount,
      ...(r.originalCurrency ? { originalAmount: r.originalAmount, originalCurrency: r.originalCurrency, fxRate: r.fxRate } : {}),
      category,
      card: meta.card || undefined,
      source: meta.source,
      importedAt: new Date().toISOString(),
    });
  }

  let suggestions = [...guesses].map(([merchant, g]) => ({ merchant, ...g }));
  let unknownMerchants = [...unknown.values()];
  if (unknown.size && apiKey) {
    const fromAI = await aiPass(unknown, fresh, merchants, apiKey, onProgress);
    suggestions.push(...fromAI.suggestions);
    unknownMerchants = fromAI.unknownMerchants;
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
  const guesses = new Map();
  for (const [merchant, list] of byMerchant) {
    const guess = localCategory(merchant, merchants, null);
    if (guess.category && guess.confidence >= HIGH_CONFIDENCE) {
      merchants[merchant] = guess.category;
      for (const t of list) { t.category = guess.category; autoUpdated++; }
    } else if (guess.category) {
      guesses.set(merchant, { category: guess.category, confidence: guess.confidence });
    } else {
      unknown.set(merchant, merchant);
      for (const t of list) { t._raw = merchant; rows.push(t); }
    }
  }

  let suggestions = [...guesses].map(([merchant, g]) => ({ merchant, ...g }));
  let unknownMerchants = [...unknown.keys()];
  if (unknown.size && apiKey) {
    const before = rows.filter(t => !t.category).length;
    const fromAI = await aiPass(unknown, rows, merchants, apiKey, onProgress);
    suggestions.push(...fromAI.suggestions);
    unknownMerchants = fromAI.unknownMerchants;
    autoUpdated += before - rows.filter(t => !t.category).length;
  }
  for (const t of rows) delete t._raw;

  store.write('transactions', transactions);
  store.write('merchants', merchants);
  return { autoUpdated, suggestions, unknownMerchants };
}

module.exports = { importRows, categorizeUncategorized, localCategory, dedupKeys, aiPass, mapPlaidCategory };
