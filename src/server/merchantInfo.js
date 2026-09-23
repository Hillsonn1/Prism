'use strict';
// Merchant intelligence: what each merchant actually is — a clean name, the
// native-script name and meaning for transliterated ones, the kind of
// business, whether it's a subscription — learned once and kept in
// merchant-info.json. Rules and Plaid cover the obvious merchants; this is
// for the long tail, and it also feeds the "Explain" button.

const { getCategories } = require('./categoryConfig');
const { isCounted } = require('./spend');

const BATCH = 12;          // merchants per knowledge call
const LOOKUP_LIMIT = 12;   // web-search lookups per run
const LOW = 0.6;           // below this, the knowledge pass wasn't sure → look it up
const APPLY = 0.7;         // at or above this, an uncategorized merchant takes the category

function recordTool(categoryNames) {
  return {
    name: 'record_merchants',
    description: 'Record what each merchant is. Use exactly the merchant strings you were given.',
    input_schema: {
      type: 'object',
      properties: {
        merchants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              merchant: { type: 'string', description: 'The merchant string exactly as given' },
              displayName: { type: 'string', description: 'Clean, readable business name' },
              nativeName: { type: 'string', description: 'The name in its native script (Hebrew, Thai, Arabic…) when the given name is a transliteration; empty otherwise' },
              meaning: { type: 'string', description: 'English meaning of a non-English name, e.g. "Fruit & Vegetables"; empty when the name is English or a brand' },
              type: { type: 'string', description: 'Kind of business in one to three words: greengrocer, gas station, mobile carrier, ride hailing, pharmacy chain…' },
              category: { type: 'string', enum: categoryNames },
              isSubscription: { type: 'boolean', description: 'True for services billed on a schedule (streaming, software, phone plans, memberships)' },
              country: { type: 'string', description: 'ISO 3166-1 alpha-2 country where this business operates, if known; empty otherwise' },
              description: { type: 'string', description: 'One short sentence saying what the business is' },
              confidence: { type: 'number', description: '0 to 1: how sure you are about what this merchant is' },
            },
            required: ['merchant', 'displayName', 'type', 'category', 'isSubscription', 'description', 'confidence'],
          },
        },
      },
      required: ['merchants'],
    },
  };
}

const SYSTEM = `You identify businesses from credit-card statement strings for a personal spending tracker.
The user lives in Israel and also spends in Thailand and the United States on US cards, so many names are Hebrew or Thai transliterated into Latin letters (e.g. "SHEVACH PRI VAYEREK" is שבח פרי וירק, a greengrocer; "PAZ" is a gas station chain; "KUPAT HOLIM MEUHEDET" is a health fund).
Be precise and honest about confidence: 0.9+ when the business is well known or unmistakable, 0.6–0.8 when the name clearly says what it is, below 0.6 when you are guessing. Never invent a native-script name you are not sure of — leave it empty instead.`;

function cleanInfo(r, categoryNames) {
  const s = v => (typeof v === 'string' ? v.trim() : '');
  return {
    displayName: s(r.displayName),
    nativeName: s(r.nativeName),
    meaning: s(r.meaning),
    type: s(r.type).toLowerCase(),
    category: categoryNames.includes(r.category) ? r.category : null,
    isSubscription: Boolean(r.isSubscription),
    country: /^[A-Za-z]{2}$/.test(s(r.country)) ? s(r.country).toUpperCase() : '',
    description: s(r.description),
    confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
  };
}

function createMerchantIntel({ store, claude, log = console }) {
  let running = null;

  // Merchants we haven't looked at yet, busiest first
  function candidates(limit) {
    const info = store.read('merchantInfo');
    const seen = new Map(); // merchant → { count, raw, category, plaidCategory }
    for (const t of store.read('transactions')) {
      if (!t.merchant || info[t.merchant]) continue;
      const e = seen.get(t.merchant) || seen.set(t.merchant, { merchant: t.merchant, count: 0, raw: t.rawSource || '', category: t.category || null, plaidCategory: t.plaidCategory || '' }).get(t.merchant);
      e.count++;
      if (!e.raw && t.rawSource) e.raw = t.rawSource;
      if (!e.category && t.category) e.category = t.category;
    }
    return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }

  const describe = e => `- "${e.merchant}"${e.raw && e.raw !== e.merchant ? ` (on the statement: "${e.raw}")` : ''}, ${e.count} purchase${e.count === 1 ? '' : 's'}${e.category ? `, currently filed under ${e.category}` : ', uncategorized'}${e.plaidCategory ? `, the bank's code is ${e.plaidCategory}` : ''}`;

  // One call for a batch of merchants, from knowledge alone
  async function knowledgePass(entries, categoryNames) {
    const model = claude.model('enrich');
    const msg = await claude.client().messages.create({
      model,
      max_tokens: 4000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [recordTool(categoryNames)],
      tool_choice: { type: 'tool', name: 'record_merchants' },
      messages: [{ role: 'user', content: `Identify these merchants:\n${entries.map(describe).join('\n')}` }],
    });
    claude.record('merchant-intel', model, msg.usage);
    return claude.toolInput(msg, 'record_merchants')?.merchants || [];
  }

  // One merchant, with the web when knowledge isn't enough
  async function lookupPass(entry, categoryNames) {
    const model = claude.model('lookup');
    const msg = await claude.client().messages.create({
      model,
      max_tokens: 2000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [claude.webSearchTool(model, { maxUses: 2 }), recordTool(categoryNames)],
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: `Search the web if you need to, then record this merchant:\n${describe(entry)}` }],
    });
    claude.record('merchant-lookup', model, msg.usage);
    return claude.toolInput(msg, 'record_merchants')?.merchants?.[0] || null;
  }

  function save(merchant, info, source) {
    store.update('merchantInfo', all => { all[merchant] = { ...info, source, at: new Date().toISOString() }; });
  }

  // Confident answers categorize what was still uncategorized
  function applyCategories(results) {
    let categorized = 0;
    const byMerchant = new Map(results.filter(r => r.info.category && r.info.confidence >= APPLY).map(r => [r.merchant, r.info.category]));
    if (!byMerchant.size) return 0;
    store.update('transactions', list => {
      for (const t of list) {
        const cat = byMerchant.get(t.merchant);
        if (cat && !t.category) { t.category = cat; t.categorySource = 'auto'; categorized++; }
      }
    });
    store.update('merchants', m => { for (const [merchant, cat] of byMerchant) if (!m[merchant]) m[merchant] = cat; });
    return categorized;
  }

  // Learn up to `limit` new merchants. One run at a time; callers share it.
  function enrich({ limit = 40, onProgress = () => {} } = {}) {
    if (running) return running;
    running = (async () => {
      const categoryNames = getCategories(store).filter(c => !c.hidden && !c.redirect && c.name !== 'Unknown').map(c => c.name);
      const todo = candidates(limit);
      const result = { merchants: todo.length, enriched: 0, lookedUp: 0, categorized: 0 };
      if (!todo.length) return result;
      const results = [];
      const uncertain = [];
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        onProgress(i / todo.length, `Identifying ${batch[0].merchant}…`);
        let answers = [];
        try { answers = await knowledgePass(batch, categoryNames); }
        catch (err) { log.error('Merchant intelligence failed:', err.message); break; }
        const byName = new Map(answers.map(a => [String(a.merchant || '').trim().toLowerCase(), a]));
        for (const e of batch) {
          const a = byName.get(e.merchant.toLowerCase());
          if (!a) continue;
          const info = cleanInfo(a, categoryNames);
          if (info.confidence < LOW && uncertain.length < LOOKUP_LIMIT) { uncertain.push({ entry: e, info }); continue; }
          save(e.merchant, info, 'knowledge');
          results.push({ merchant: e.merchant, info });
          result.enriched++;
        }
      }
      for (const { entry, info: first } of uncertain) {
        onProgress(0.8, `Looking up ${entry.merchant}…`);
        let answer = null;
        try { answer = await lookupPass(entry, categoryNames); } catch (err) { log.error('Merchant lookup failed:', err.message); }
        const info = answer ? cleanInfo(answer, categoryNames) : first;
        save(entry.merchant, info, answer ? 'web' : 'knowledge');
        results.push({ merchant: entry.merchant, info });
        result.enriched++;
        if (answer) result.lookedUp++;
      }
      result.categorized = applyCategories(results);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  // Kicks off a run without waiting for it; nothing happens without a key
  function inBackground() {
    if (!claude.available() || store.read('settings').prefs?.merchantIntel === false) return;
    enrich().catch(err => log.error('Merchant intelligence failed:', err.message));
  }

  // The full picture for one merchant, looking it up if it isn't known yet
  async function explain(merchant, { force = false } = {}) {
    const categoryNames = getCategories(store).filter(c => !c.hidden && !c.redirect && c.name !== 'Unknown').map(c => c.name);
    let info = store.read('merchantInfo')[merchant] || null;
    if (!info || force || (info.confidence < LOW && info.source !== 'web')) {
      const txns = store.read('transactions').filter(t => t.merchant === merchant);
      const entry = { merchant, count: txns.length, raw: txns.find(t => t.rawSource)?.rawSource || '', category: txns.find(t => t.category)?.category || null, plaidCategory: txns.find(t => t.plaidCategory)?.plaidCategory || '' };
      const answer = await lookupPass(entry, categoryNames);
      if (answer) { info = cleanInfo(answer, categoryNames); save(merchant, info, 'web'); info = store.read('merchantInfo')[merchant]; }
    }
    return info;
  }

  // What the ledger itself says about a merchant
  function stats(merchant) {
    const txns = store.read('transactions').filter(t => t.merchant === merchant).sort((a, b) => a.date.localeCompare(b.date));
    const spend = txns.filter(t => t.amount > 0 && isCounted(t));
    const months = new Map();
    for (const t of spend) { const m = t.date.slice(0, 7); months.set(m, (months.get(m) || 0) + 1); }
    const amounts = spend.map(t => t.amount);
    const avg = amounts.length ? amounts.reduce((s, a) => s + a, 0) / amounts.length : 0;
    const steady = amounts.length >= 3 && amounts.every(a => Math.abs(a - avg) <= Math.max(avg * 0.15, 2));
    const oncePerMonth = months.size >= 3 && [...months.values()].every(n => n === 1);
    return {
      count: txns.length,
      total: Math.round(spend.reduce((s, t) => s + t.amount, 0) * 100) / 100,
      average: Math.round(avg * 100) / 100,
      first: txns[0]?.date || null,
      last: txns[txns.length - 1]?.date || null,
      months: months.size,
      looksRecurring: steady && oncePerMonth,
      refunds: txns.filter(t => t.amount < 0).length,
    };
  }

  return { enrich, inBackground, explain, stats, candidates };
}

module.exports = { createMerchantIntel };
