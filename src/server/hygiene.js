'use strict';
// A category review with reasons: Claude looks over every merchant whose
// category Prism guessed on its own (or never found) and says, with a
// one-line reason, which ones are wrong. Nothing changes until the user
// applies the proposals they agree with.

const { getCategories } = require('./categoryConfig');

const BATCH = 20;
const MAX_MERCHANTS = 160;
const MIN_CONFIDENCE = 0.6;

function reviewTool(categoryNames) {
  return {
    name: 'report_review',
    description: 'Report your verdict on each merchant.',
    input_schema: {
      type: 'object',
      properties: {
        verdicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              merchant: { type: 'string', description: 'The merchant string exactly as given' },
              verdict: { type: 'string', enum: ['keep', 'change'] },
              category: { type: 'string', enum: categoryNames, description: 'The right category when the verdict is "change"' },
              reason: { type: 'string', description: 'One short sentence: what this business is and why it belongs there' },
              confidence: { type: 'number', description: '0 to 1' },
            },
            required: ['merchant', 'verdict', 'confidence'],
          },
        },
      },
      required: ['verdicts'],
    },
  };
}

const SYSTEM = `You review how a personal spending tracker categorized merchants. The user lives in Israel and also spends in Thailand and the US; names are often Hebrew or Thai transliterations.
For each merchant you get the current category (or "uncategorized"), how it appeared on the statement, the bank's own code when there is one, and what is already known about the business.
Say "keep" when the category is right or defensible. Say "change" only when you are reasonably sure it is wrong or missing, and give the category it belongs in with a one-line reason. Do not nitpick between neighbouring categories (Dining vs Groceries for a bakery is a judgment call — keep it). Be honest in confidence.`;

function createHygiene({ store, claude, log = console }) {
  // Merchants whose category was never set by hand
  function candidates() {
    const userSet = new Set();
    const groups = new Map();
    const info = store.read('merchantInfo');
    for (const t of store.read('transactions')) {
      if (!t.merchant) continue;
      if (t.categorySource === 'user') userSet.add(t.merchant);
      const g = groups.get(t.merchant) || groups.set(t.merchant, { merchant: t.merchant, count: 0, category: null, raw: '', plaidCategory: '' }).get(t.merchant);
      g.count++;
      if (!g.category && t.category) g.category = t.category;
      if (!g.raw && t.rawSource && t.rawSource !== t.merchant) g.raw = t.rawSource;
      if (!g.plaidCategory && t.plaidCategory) g.plaidCategory = t.plaidCategory;
    }
    return [...groups.values()]
      .filter(g => !userSet.has(g.merchant))
      .map(g => ({ ...g, info: info[g.merchant] || null }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_MERCHANTS);
  }

  const describe = g => `- "${g.merchant}": ${g.category || 'uncategorized'}; ${g.count} purchase${g.count === 1 ? '' : 's'}${g.raw ? `; on the statement: "${g.raw}"` : ''}${g.plaidCategory ? `; bank code ${g.plaidCategory}` : ''}${g.info ? `; known: ${g.info.type || ''}${g.info.description ? ` — ${g.info.description}` : ''}` : ''}`;

  async function review({ onProgress = () => {} } = {}) {
    const categoryNames = getCategories(store).filter(c => !c.hidden && !c.redirect && c.name !== 'Unknown').map(c => c.name);
    const todo = candidates();
    const proposals = [];
    let reviewed = 0;
    const model = claude.model('review');
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      onProgress(i / Math.max(todo.length, 1), `Reviewing ${batch[0].merchant}…`);
      const msg = await claude.client().messages.create({
        model,
        max_tokens: 6000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [reviewTool(categoryNames)],
        tool_choice: { type: 'tool', name: 'report_review' },
        messages: [{ role: 'user', content: `Valid categories: ${categoryNames.join(' | ')}\n\nReview these merchants:\n${batch.map(describe).join('\n')}` }],
      });
      claude.record('category-review', model, msg.usage);
      const verdicts = claude.toolInput(msg, 'report_review')?.verdicts || [];
      const byName = new Map(batch.map(g => [g.merchant.toLowerCase(), g]));
      for (const v of verdicts) {
        const g = byName.get(String(v.merchant || '').trim().toLowerCase());
        if (!g) continue;
        reviewed++;
        const conf = Math.min(1, Math.max(0, Number(v.confidence) || 0));
        if (v.verdict !== 'change' || !categoryNames.includes(v.category) || v.category === g.category || conf < MIN_CONFIDENCE) continue;
        proposals.push({ merchant: g.merchant, from: g.category, to: v.category, count: g.count, reason: String(v.reason || '').trim(), confidence: conf });
      }
    }
    proposals.sort((a, b) => b.count - a.count || b.confidence - a.confidence);
    return { reviewed, candidates: todo.length, proposals };
  }

  // The user agreed: every row from these merchants moves, and it counts as set by hand
  function apply(changes) {
    const wanted = new Map(changes.filter(c => c && c.merchant && c.category).map(c => [c.merchant, c.category]));
    let moved = 0;
    store.update('transactions', list => {
      for (const t of list) {
        const cat = wanted.get(t.merchant);
        if (cat && t.category !== cat) { t.category = cat; t.categorySource = 'user'; moved++; }
        else if (cat) t.categorySource = 'user';
      }
    });
    store.update('merchants', m => { for (const [merchant, cat] of wanted) m[merchant] = cat; });
    return { moved, merchants: wanted.size };
  }

  return { review, apply, candidates };
}

module.exports = { createHygiene };
