'use strict';
// Ask Prism: a conversation over the ledger. Claude answers with tools that
// query and summarize the data; anything that would change the data comes
// back as a proposal the user applies with a click. Only what a tool returns
// for the question at hand leaves the machine.

const crypto = require('crypto');
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
const { isCounted } = require('./spend');
const { getCategories } = require('./categoryConfig');
const { recurringCharges } = require('./insights');
const trips = require('./trips');

const CONVERSATION_TTL = 2 * 60 * 60 * 1000;
const PROPOSAL_TTL = 60 * 60 * 1000;
const MAX_HISTORY = 40;   // messages kept per conversation
const ROW_LIMIT = 60;
const RECURRING = '_recurring';

const money = n => Math.round(n * 100) / 100;
const compactRow = t => ({
  id: t.id, date: t.date, merchant: t.merchant, amount: t.amount,
  ...(t.originalCurrency && t.originalCurrency !== 'USD' ? { paid: `${t.originalAmount} ${t.originalCurrency}` } : {}),
  category: t.category || null,
  ...(t.card ? { card: t.card } : {}),
  ...(t.tags?.length ? { tags: t.tags } : {}),
  ...(t.notes ? { notes: t.notes } : {}),
  ...(t.excluded ? { excluded: true } : {}),
  ...(t.reimbursable ? { reimbursable: true, repaid: Boolean(t.reimbursedAt) } : {}),
  ...(t.refundOf ? { refundOf: t.refundOf } : {}),
  ...(t.pending ? { pending: true } : {}),
});

const FILTER_SCHEMA = {
  from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
  to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
  category: { type: 'string', description: 'Exact category name, or "Uncategorized"' },
  merchant: { type: 'string', description: 'Merchant name, matched case-insensitively as a substring' },
  tag: { type: 'string', description: 'Exact tag (trip names are tags)' },
  card: { type: 'string', description: 'Card name, substring match' },
  text: { type: 'string', description: 'Free text matched against merchant, notes and the raw statement descriptor' },
  minAmount: { type: 'number' },
  maxAmount: { type: 'number' },
  onlyRefunds: { type: 'boolean', description: 'Only credits/refunds (negative amounts)' },
  ids: { type: 'array', items: { type: 'string' }, description: 'Specific transaction ids from earlier results' },
};

function matches(t, f) {
  if (f.ids?.length) return f.ids.includes(t.id);
  if (f.from && t.date < f.from) return false;
  if (f.to && t.date > f.to) return false;
  if (f.category) {
    if (f.category.toLowerCase() === 'uncategorized') { if (t.category) return false; }
    else if ((t.category || '').toLowerCase() !== f.category.toLowerCase()) return false;
  }
  if (f.merchant && !t.merchant.toLowerCase().includes(f.merchant.toLowerCase())) return false;
  if (f.tag && !(t.tags || []).some(x => x.toLowerCase() === f.tag.toLowerCase())) return false;
  if (f.card && !(t.card || '').toLowerCase().includes(f.card.toLowerCase())) return false;
  if (f.text) {
    const q = f.text.toLowerCase();
    if (![t.merchant, t.notes, t.rawSource, t.category, ...(t.tags || [])].some(v => (v || '').toLowerCase().includes(q))) return false;
  }
  if (f.minAmount !== undefined && Math.abs(t.amount) < f.minAmount) return false;
  if (f.maxAmount !== undefined && Math.abs(t.amount) > f.maxAmount) return false;
  if (f.onlyRefunds && !(t.amount < 0)) return false;
  return true;
}

function createAssistant({ store, claude, plaid, log = console }) {
  const conversations = new Map();
  const proposals = new Map();

  function sweep() {
    const now = Date.now();
    for (const [id, c] of conversations) if (now - c.updatedAt > CONVERSATION_TTL) conversations.delete(id);
    for (const [id, p] of proposals) if (now - p.createdAt > PROPOSAL_TTL) proposals.delete(id);
  }

  const categoryNames = () => getCategories(store).filter(c => !c.hidden && !c.redirect).map(c => c.name);

  function systemPrompt() {
    const settings = store.read('settings');
    const today = new Date().toISOString().slice(0, 10);
    const cats = categoryNames().join(', ');
    return `You are Prism's assistant: a sharp, friendly analyst of the user's own card spending, living inside their local spending tracker.

Today is ${today}. Amounts are US dollars; purchases made in other currencies keep their original figure ("paid"). Refunds are negative amounts. Rows marked excluded or reimbursable are left out of spending totals (the tools already do this); mention them only when relevant.
Categories: ${cats}. Tags are free labels; a trip is a tag plus a date range.${settings.location ? ` The user lives in ${settings.location}.` : ''}

How to work:
- Use the tools for every number. Never guess or estimate from memory; if a tool returns nothing, say so.
- Prefer summarize_spending for totals and comparisons, search_transactions for specific purchases, merchant_details for one merchant, get_overview for the big picture, budget, cards and what is due.
- When the user asks to change data (categorize, tag, exclude, mark repaid, rename, create a trip), use a propose_* tool. Nothing changes until they click Apply, so describe what you proposed in one line and stop.
- Answer in plain, compact prose. Lead with the number. Use short bullet lists for more than three items and **bold** for the key figure. No headings, no preamble, no restating the question.
- Dates like "Sep 18"; money like $1,234.56; keep it under ~120 words unless the user asks for detail.`;
  }

  // ---- Tools ----
  function makeTools(emit) {
    const all = () => store.read('transactions');

    const get_overview = betaTool({
      name: 'get_overview',
      description: 'The big picture: spend by month, this month so far, budget (income, fixed expenses, target, per-category limits), credit cards with statement balances and due dates, trips, recurring charges, available tags and categories.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => {
        const txns = all();
        const months = {};
        for (const t of txns) { if (!t.date || t.amount <= 0 || !isCounted(t)) continue; const m = t.date.slice(0, 7); months[m] = (months[m] || 0) + t.amount; }
        const monthList = Object.keys(months).sort().slice(-12).map(m => ({ month: m, spend: money(months[m]) }));
        const thisMonth = new Date().toISOString().slice(0, 7);
        const cur = txns.filter(t => t.date?.startsWith(thisMonth));
        const settings = store.read('settings');
        const income = store.read('income'), expenses = store.read('expenses');
        const sum = (all, m) => [...(all[RECURRING] || []), ...(all[m] || [])].reduce((s, e) => s + (e.amount || 0), 0);
        const status = plaid.status();
        const cards = [];
        for (const item of status.items || []) {
          if (item.env && item.env !== status.env) continue;
          for (const a of item.accounts || []) if (a.enabled) cards.push({ name: a.card || a.name, mask: a.mask, type: a.type, balance: a.balance?.current ?? null, limit: a.balance?.limit ?? null, ...(a.liability ? { statementBalance: a.liability.lastStatementBalance, statementDate: a.liability.lastStatementIssueDate, minimumPayment: a.liability.minimumPaymentAmount, dueDate: a.liability.nextPaymentDueDate, lastPayment: a.liability.lastPaymentAmount, lastPaymentDate: a.liability.lastPaymentDate, overdue: a.liability.isOverdue } : {}) });
        }
        return JSON.stringify({
          today: new Date().toISOString().slice(0, 10),
          months: monthList,
          thisMonth: { month: thisMonth, spend: money(cur.filter(t => t.amount > 0 && isCounted(t)).reduce((s, t) => s + t.amount, 0)), purchases: cur.filter(t => t.amount > 0).length, uncategorized: cur.filter(t => !t.category).length },
          budget: { income: money(sum(income, thisMonth)), fixedExpenses: money(sum(expenses, thisMonth)), monthlyTarget: settings.monthlyBudget || 0, categoryLimits: settings.budgets || {} },
          cards,
          trips: (settings.trips || []).map(t => ({ name: t.name, start: t.start, end: t.end })),
          recurring: recurringCharges(txns).slice(0, 10),
          tags: [...new Set(txns.flatMap(t => t.tags || []))],
          owedToYou: money(txns.filter(t => t.reimbursable && !t.reimbursedAt).reduce((s, t) => s + t.amount, 0)),
          totalTransactions: txns.length,
        });
      },
    });

    const search_transactions = betaTool({
      name: 'search_transactions',
      description: 'Find specific transactions. Returns matching rows (newest first, up to the limit), how many matched in total, and their sum.',
      inputSchema: { type: 'object', properties: { ...FILTER_SCHEMA, limit: { type: 'number', description: `Rows to return, default 30, max ${ROW_LIMIT}` } }, additionalProperties: false },
      run: f => {
        const rows = all().filter(t => matches(t, f)).sort((a, b) => b.date.localeCompare(a.date));
        const limit = Math.min(Math.max(1, f.limit || 30), ROW_LIMIT);
        return JSON.stringify({
          matched: rows.length,
          sum: money(rows.reduce((s, t) => s + t.amount, 0)),
          sumCounted: money(rows.filter(isCounted).reduce((s, t) => s + t.amount, 0)),
          rows: rows.slice(0, limit).map(compactRow),
          ...(rows.length > limit ? { note: `Showing ${limit} of ${rows.length}; narrow the filter or raise the limit.` } : {}),
        });
      },
    });

    const summarize_spending = betaTool({
      name: 'summarize_spending',
      description: 'Totals of counted spending (refunds netted, excluded and reimbursable rows left out) grouped by category, month, week, day, merchant, card or tag, within optional filters. Use this for "how much", comparisons and breakdowns.',
      inputSchema: {
        type: 'object',
        properties: { ...FILTER_SCHEMA, groupBy: { type: 'string', enum: ['category', 'month', 'week', 'day', 'merchant', 'card', 'tag', 'none'] }, top: { type: 'number', description: 'Groups to return, default 15' } },
        required: ['groupBy'],
        additionalProperties: false,
      },
      run: f => {
        const rows = all().filter(t => matches(t, f) && isCounted(t));
        const key = t => {
          switch (f.groupBy) {
            case 'category': return t.category || 'Uncategorized';
            case 'month': return t.date.slice(0, 7);
            case 'day': return t.date;
            case 'week': { const d = new Date(t.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return 'week of ' + d.toISOString().slice(0, 10); }
            case 'merchant': return t.merchant;
            case 'card': return t.card || 'no card';
            case 'tag': return null; // handled below
            default: return 'all';
          }
        };
        const groups = {};
        const add = (k, t) => { const g = groups[k] || (groups[k] = { total: 0, purchases: 0, refunds: 0 }); g.total += t.amount; if (t.amount > 0) g.purchases++; else g.refunds++; };
        for (const t of rows) {
          if (f.groupBy === 'tag') { for (const tag of (t.tags?.length ? t.tags : ['no tag'])) add(tag, t); }
          else add(key(t), t);
        }
        const list = Object.entries(groups).map(([k, g]) => ({ group: k, total: money(g.total), purchases: g.purchases, ...(g.refunds ? { refunds: g.refunds } : {}) }))
          .sort((a, b) => (['month', 'day', 'week'].includes(f.groupBy) ? a.group.localeCompare(b.group) : b.total - a.total));
        const top = Math.min(Math.max(1, f.top || 15), 60);
        return JSON.stringify({ total: money(rows.reduce((s, t) => s + t.amount, 0)), purchases: rows.filter(t => t.amount > 0).length, groups: list.slice(0, top), ...(list.length > top ? { note: `${list.length - top} smaller groups not shown` } : {}) });
      },
    });

    const merchant_details = betaTool({
      name: 'merchant_details',
      description: 'Everything about one merchant: totals, how often, monthly history, category, what the business is (when known), and its most recent purchases.',
      inputSchema: { type: 'object', properties: { merchant: { type: 'string', description: 'Merchant name (substring, case-insensitive)' } }, required: ['merchant'], additionalProperties: false },
      run: ({ merchant }) => {
        const q = merchant.toLowerCase();
        const names = [...new Set(all().filter(t => t.merchant.toLowerCase().includes(q)).map(t => t.merchant))];
        if (!names.length) return JSON.stringify({ error: `No merchant matching "${merchant}"` });
        const info = store.read('merchantInfo');
        const out = names.slice(0, 5).map(name => {
          const rows = all().filter(t => t.merchant === name).sort((a, b) => a.date.localeCompare(b.date));
          const spend = rows.filter(t => t.amount > 0 && isCounted(t));
          const monthly = {};
          for (const t of spend) monthly[t.date.slice(0, 7)] = money((monthly[t.date.slice(0, 7)] || 0) + t.amount);
          return {
            merchant: name, total: money(spend.reduce((s, t) => s + t.amount, 0)), purchases: spend.length, refunds: rows.filter(t => t.amount < 0).length,
            average: spend.length ? money(spend.reduce((s, t) => s + t.amount, 0) / spend.length) : 0, first: rows[0].date, last: rows[rows.length - 1].date,
            category: store.read('merchants')[name] || rows.find(t => t.category)?.category || null, monthly,
            ...(info[name] ? { about: { type: info[name].type, description: info[name].description, nativeName: info[name].nativeName, meaning: info[name].meaning, subscription: info[name].isSubscription } } : {}),
            recent: rows.slice(-5).reverse().map(compactRow),
          };
        });
        return JSON.stringify(out.length === 1 ? out[0] : { matches: out });
      },
    });

    const propose_changes = betaTool({
      name: 'propose_changes',
      description: 'Propose edits to a set of transactions (by ids from earlier results, or by a filter): category, add/remove tags, exclude from spending, mark reimbursable or paid back, set a note, rename the merchant. Returns a proposal the user must apply; the data is NOT changed by this call.',
      inputSchema: {
        type: 'object',
        properties: {
          selection: { type: 'object', properties: FILTER_SCHEMA, additionalProperties: false, description: 'Which rows: ids, or a filter' },
          set: {
            type: 'object',
            properties: {
              category: { type: 'string' }, addTags: { type: 'array', items: { type: 'string' } }, removeTags: { type: 'array', items: { type: 'string' } },
              excluded: { type: 'boolean' }, reimbursable: { type: 'boolean' }, repaid: { type: 'boolean', description: 'Mark reimbursable rows as paid back' },
              notes: { type: 'string' }, merchant: { type: 'string', description: 'New merchant name' },
            },
            additionalProperties: false,
          },
          summary: { type: 'string', description: 'One line describing the change, for the user' },
        },
        required: ['selection', 'set', 'summary'],
        additionalProperties: false,
      },
      run: ({ selection, set, summary }) => {
        if (set.category && !categoryNames().includes(set.category)) return JSON.stringify({ error: `Unknown category "${set.category}". Valid: ${categoryNames().join(', ')}` });
        const rows = all().filter(t => matches(t, selection));
        if (!rows.length) return JSON.stringify({ error: 'No transactions match that selection' });
        if (rows.length > 500) return JSON.stringify({ error: `${rows.length} rows is too many for one change; narrow the selection` });
        const p = { id: crypto.randomUUID(), kind: 'update', summary, ids: rows.map(t => t.id), set, affected: rows.length, preview: rows.slice(0, 8).map(compactRow), createdAt: Date.now() };
        proposals.set(p.id, p);
        emit({ type: 'proposal', proposal: publicProposal(p) });
        return JSON.stringify({ proposalId: p.id, affected: rows.length, status: 'waiting for the user to apply' });
      },
    });

    const propose_merchant_category = betaTool({
      name: 'propose_merchant_category',
      description: 'Propose a category for a merchant so Prism remembers it: applies to that merchant\'s uncategorized purchases, or to all of them with applyToAll. Returns a proposal the user must apply.',
      inputSchema: { type: 'object', properties: { merchant: { type: 'string', description: 'Exact merchant name' }, category: { type: 'string' }, applyToAll: { type: 'boolean' } }, required: ['merchant', 'category'], additionalProperties: false },
      run: ({ merchant, category, applyToAll }) => {
        if (!categoryNames().includes(category)) return JSON.stringify({ error: `Unknown category "${category}"` });
        const rows = all().filter(t => t.merchant === merchant && (applyToAll || !t.category));
        const exists = all().some(t => t.merchant === merchant);
        if (!exists) return JSON.stringify({ error: `No merchant named exactly "${merchant}"` });
        const p = { id: crypto.randomUUID(), kind: 'merchant_category', summary: `${merchant} → ${category}${applyToAll ? ' (all purchases)' : ''}`, merchant, category, applyToAll: Boolean(applyToAll), affected: rows.length, preview: rows.slice(0, 5).map(compactRow), createdAt: Date.now() };
        proposals.set(p.id, p);
        emit({ type: 'proposal', proposal: publicProposal(p) });
        return JSON.stringify({ proposalId: p.id, affected: rows.length, status: 'waiting for the user to apply' });
      },
    });

    const propose_trip = betaTool({
      name: 'propose_trip',
      description: 'Propose a new trip (a tag over a date range). Purchases in the range get the tag when applied; recurring charges and bills stay out unless includeAll. Returns a proposal the user must apply.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, start: { type: 'string', description: 'YYYY-MM-DD' }, end: { type: 'string', description: 'YYYY-MM-DD' }, includeAll: { type: 'boolean' } }, required: ['name', 'start', 'end'], additionalProperties: false },
      run: ({ name, start, end, includeAll }) => {
        if (trips.listTrips(store).some(t => t.name.toLowerCase() === name.toLowerCase())) return JSON.stringify({ error: `There is already a trip called "${name}"` });
        const rows = all().filter(t => t.date >= start && t.date <= end);
        const p = { id: crypto.randomUUID(), kind: 'trip', summary: `Trip "${name}", ${start} to ${end}`, name, start, end, includeAll: Boolean(includeAll), affected: rows.length, preview: rows.slice(0, 5).map(compactRow), createdAt: Date.now() };
        proposals.set(p.id, p);
        emit({ type: 'proposal', proposal: publicProposal(p) });
        return JSON.stringify({ proposalId: p.id, purchasesInRange: rows.length, status: 'waiting for the user to apply' });
      },
    });

    return [get_overview, search_transactions, summarize_spending, merchant_details, propose_changes, propose_merchant_category, propose_trip];
  }

  const publicProposal = p => ({ id: p.id, kind: p.kind, summary: p.summary, affected: p.affected, preview: p.preview, set: p.set || null, applied: Boolean(p.applied) });

  // ---- Conversation ----
  async function ask({ conversationId, question }, emit) {
    sweep();
    const id = conversationId && conversations.has(conversationId) ? conversationId : crypto.randomUUID();
    const conv = conversations.get(id) || { messages: [], updatedAt: Date.now() };
    conversations.set(id, conv);
    conv.messages.push({ role: 'user', content: question });
    if (conv.messages.length > MAX_HISTORY) conv.messages.splice(0, conv.messages.length - MAX_HISTORY);
    // History must start with a user turn and never open on a tool result
    while (conv.messages.length && (conv.messages[0].role !== 'user' || (Array.isArray(conv.messages[0].content) && conv.messages[0].content.some(b => b.type === 'tool_result')))) conv.messages.shift();
    emit({ type: 'start', conversationId: id });

    const model = claude.model('assistant');
    const runner = claude.client().beta.messages.toolRunner({
      model,
      max_tokens: 8000,
      system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: conv.messages,
      tools: makeTools(emit),
      thinking: { type: 'adaptive' },
      stream: true,
      max_iterations: 8,
    });
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    try {
      for await (const stream of runner) {
        stream.on('text', delta => emit({ type: 'text', delta }));
        const msg = await stream.finalMessage();
        for (const k of Object.keys(usage)) usage[k] += msg.usage?.[k] || 0;
        for (const b of msg.content) if (b.type === 'tool_use') emit({ type: 'tool', name: b.name, input: b.input });
      }
      const final = await runner.done();
      conv.messages = runner.params.messages;
      conv.updatedAt = Date.now();
      claude.record('ask', model, usage);
      emit({ type: 'done', conversationId: id, text: claude.textOf(final), usd: claude.estimateUsd(model, usage) });
    } catch (err) {
      // Leave the conversation as it was before this question
      conv.messages = conv.messages.filter((m, i) => !(i === conv.messages.length - 1 && m.role === 'user' && m.content === question));
      throw err;
    }
  }

  function applyProposal(id) {
    const p = proposals.get(id);
    if (!p) throw Object.assign(new Error('That proposal has expired — ask again'), { status: 404 });
    if (p.applied) return { applied: true, affected: p.affected };
    let affected = 0;
    if (p.kind === 'update') {
      const set = p.set;
      const ids = new Set(p.ids);
      store.update('transactions', list => {
        for (const t of list) {
          if (!ids.has(t.id)) continue;
          affected++;
          if (set.category) { t.category = set.category; t.categorySource = 'user'; }
          if (set.addTags?.length) t.tags = [...new Set([...(t.tags || []), ...set.addTags.map(x => x.trim()).filter(Boolean)])];
          if (set.removeTags?.length) { t.tags = (t.tags || []).filter(x => !set.removeTags.some(r => r.toLowerCase() === x.toLowerCase())); if (!t.tags.length) delete t.tags; }
          if (set.excluded !== undefined) { if (set.excluded) t.excluded = true; else delete t.excluded; }
          if (set.reimbursable !== undefined) { if (set.reimbursable) t.reimbursable = true; else { delete t.reimbursable; delete t.reimbursedAt; } }
          if (set.repaid !== undefined && t.reimbursable) { if (set.repaid) t.reimbursedAt = t.reimbursedAt || new Date().toISOString().slice(0, 10); else delete t.reimbursedAt; }
          if (set.notes !== undefined) { if (set.notes) t.notes = set.notes; else delete t.notes; }
          if (set.merchant) t.merchant = set.merchant.trim();
        }
      });
      if (set.category) {
        const merchants = new Set(store.read('transactions').filter(t => ids.has(t.id)).map(t => t.merchant));
        store.update('merchants', m => { for (const name of merchants) m[name] = set.category; });
      }
    } else if (p.kind === 'merchant_category') {
      store.update('transactions', list => { for (const t of list) if (t.merchant === p.merchant && (p.applyToAll || !t.category)) { t.category = p.category; t.categorySource = 'user'; affected++; } });
      store.update('merchants', m => { m[p.merchant] = p.category; });
    } else if (p.kind === 'trip') {
      const r = trips.createTrip(store, { name: p.name, start: p.start, end: p.end, includeAll: p.includeAll });
      affected = r.tagged;
    }
    p.applied = true;
    return { applied: true, affected };
  }

  function reset(conversationId) { conversations.delete(conversationId); }

  return { ask, applyProposal, reset, tools: makeTools, proposals };
}

module.exports = { createAssistant };
