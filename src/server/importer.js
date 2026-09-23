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
// Built-in categories the user merged away are sent on to their replacement
function applyRedirects(store, rows, merchants, suggestions = []) {
  const { redirectMap, resolve } = require('./categoryConfig');
  const map = redirectMap(store);
  if (!Object.keys(map).length) return;
  for (const t of rows) if (t.category) t.category = resolve(map, t.category);
  for (const k of Object.keys(merchants)) merchants[k] = resolve(map, merchants[k]);
  for (const s of suggestions) if (s.category) s.category = resolve(map, s.category);
}

function localCategory(rawMerchant, merchants, hint) {
  const name = quickNormalizeName(rawMerchant);
  const remembered = merchants[name] || merchants[rawMerchant];
  if (remembered) return { name, category: remembered, confidence: 1, learned: false };

  const similar = findSimilarMerchant(name, merchants);
  if (similar) return { name, category: similar.category, confidence: similar.score, learned: true };

  const brand = autoCategory(rawMerchant) || autoCategory(name);
  if (brand) return { name, category: brand, confidence: 0.9, learned: true };
  // A business word in the name ("restaurant", "taxi") beats the bank's guess,
  // which is often a generic bucket or plain wrong for merchants abroad
  const generic = genericCategory(rawMerchant) || genericCategory(name);
  if (generic) return { name, category: generic, confidence: hint === generic ? 0.9 : 0.8, learned: true };
  if (hint) return { name, category: hint, confidence: 0.85, learned: true };
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
          if (t._raw === r.merchant && !t.category) { t.merchant = cleanName; t.category = r.category; t.categorySource = 'auto'; }
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
      ...(category ? { categorySource: 'auto' } : {}),
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
  applyRedirects(store, fresh, merchants, suggestions);

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
      for (const t of list) { t.category = guess.category; t.categorySource = 'auto'; autoUpdated++; }
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
  applyRedirects(store, transactions, merchants, suggestions);

  store.write('transactions', transactions);
  store.write('merchants', merchants);
  return { autoUpdated, suggestions, unknownMerchants };
}


// Re-runs the local rules over every automatically categorized row. Rows and
// merchants the user set by hand are left alone; a confident, different answer
// from the (possibly improved) rules replaces the old guess.
function recheckCategories(store) {
  const transactions = store.read('transactions');
  const merchants = store.read('merchants');
  const { redirectMap, resolve } = require('./categoryConfig');
  const redirects = redirectMap(store);
  const resolveRedirect = c => resolve(redirects, c);
  const userSet = new Set(transactions.filter(t => t.categorySource === 'user').map(t => t.merchant));
  let changed = 0;
  const changes = {};
  for (const t of transactions) {
    if (t.categorySource === 'user' || userSet.has(t.merchant)) continue;
    const hint = mapPlaidCategory(t.plaidCategory);
    const guess = localCategory(t.rawSource || t.merchant, {}, hint);
    const rulesOnly = guess.category && guess.confidence >= HIGH_CONFIDENCE ? resolveRedirect(guess.category) : null;
    if (rulesOnly && rulesOnly !== t.category) {
      changes[t.merchant] = changes[t.merchant] || { from: t.category, to: rulesOnly, count: 0 };
      changes[t.merchant].count++;
      t.category = rulesOnly;
      t.categorySource = 'auto';
      merchants[t.merchant] = rulesOnly;
      changed++;
    }
  }
  store.write('transactions', transactions);
  store.write('merchants', merchants);
  return { changed, changes };
}

// First run on data from before provenance was recorded: a row whose category
// isn't what the rules would have given it can only have been set by hand.
function inferCategorySources(store) {
  const settings = store.read('settings');
  if (settings.categorySourceMigrated) return;
  store.update('transactions', list => {
    for (const t of list) {
      if (!t.category || t.categorySource) continue;
      if (t.manual) { t.categorySource = 'user'; continue; }
      const raw = t.rawSource || t.merchant;
      const hint = mapPlaidCategory(t.plaidCategory);
      const signals = [hint, autoCategory(raw), autoCategory(t.merchant), genericCategory(raw), genericCategory(t.merchant), mapBankCategory(t.csvCategory)];
      t.categorySource = signals.includes(t.category) ? 'auto' : 'user';
    }
  });
  store.update('settings', s => { s.categorySourceMigrated = true; });
}

module.exports = { importRows, categorizeUncategorized, recheckCategories, inferCategorySources, localCategory, dedupKeys, aiPass, mapPlaidCategory, applyRedirects };
