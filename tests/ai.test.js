'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempStore } = require('./helpers');
const { createClaude } = require('../src/server/claude');
const { createAssistant } = require('../src/server/assistant');
const { createVision } = require('../src/server/vision');
const { createHygiene } = require('../src/server/hygiene');
const { createMerchantIntel } = require('../src/server/merchantInfo');

const T = (id, merchant, date, amount, extra = {}) => ({ id, merchant, date, amount, ...extra });
const seed = store => store.write('transactions', [
  T('a', 'Supersal', '2026-09-02', 84.5, { category: 'Groceries', categorySource: 'auto', rawSource: 'SUPERSAL DEAL 123' }),
  T('b', 'Supersal', '2026-09-10', 40, { category: 'Groceries', categorySource: 'auto' }),
  T('c', 'Wolt', '2026-09-11', 22, { category: 'Dining & Restaurants', categorySource: 'user', tags: ['Thailand'] }),
  T('d', 'Apple', '2026-08-20', 900, { category: 'Shopping', excluded: true }),
  T('e', 'Amazon', '2026-08-21', -15, { category: 'Shopping' }),
  T('f', 'Gett', '2026-08-22', 18.5, { category: 'Travel & Transport', categorySource: 'auto' }),
]);
const fakePlaid = { status: () => ({ items: [], env: 'production' }) };

test('assistant tools: summaries skip excluded rows, searches match filters, proposals wait for Apply', async () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    const claude = createClaude({ store, apiKey: () => 'k' });
    const assistant = createAssistant({ store, claude, plaid: fakePlaid, log: { error() {} } });
    const events = [];
    const tools = Object.fromEntries(assistant.tools(e => events.push(e)).map(t => [t.name, t]));

    const sept = JSON.parse(await tools.summarize_spending.run({ groupBy: 'category', from: '2026-09-01', to: '2026-09-30' }));
    assert.equal(sept.total, 146.5);
    assert.deepEqual(sept.groups.map(g => g.group), ['Groceries', 'Dining & Restaurants']);
    const aug = JSON.parse(await tools.summarize_spending.run({ groupBy: 'month', from: '2026-08-01', to: '2026-08-31' }));
    assert.equal(aug.total, 3.5, 'Apple is excluded; the Amazon refund nets against Gett');

    const found = JSON.parse(await tools.search_transactions.run({ merchant: 'super' }));
    assert.equal(found.matched, 2);
    assert.equal(found.rows[0].date, '2026-09-10');
    assert.equal(JSON.parse(await tools.search_transactions.run({ tag: 'thailand' })).matched, 1);
    assert.equal(JSON.parse(await tools.search_transactions.run({ onlyRefunds: true })).rows[0].merchant, 'Amazon');
    assert.equal(JSON.parse(await tools.search_transactions.run({ category: 'Uncategorized' })).matched, 0);

    const overview = JSON.parse(await tools.get_overview.run({}));
    assert.equal(overview.thisMonth.month.length, 7);
    assert.deepEqual(overview.tags, ['Thailand']);

    const details = JSON.parse(await tools.merchant_details.run({ merchant: 'supersal' }));
    assert.equal(details.purchases, 2);
    assert.equal(details.total, 124.5);

    const r = JSON.parse(await tools.propose_changes.run({ selection: { merchant: 'Supersal' }, set: { addTags: ['Groceries run'], category: 'Groceries' }, summary: 'Tag Supersal' }));
    assert.equal(r.affected, 2);
    assert.equal(events.filter(e => e.type === 'proposal').length, 1);
    assert.equal(store.read('transactions').find(t => t.id === 'a').tags, undefined, 'nothing changed yet');
    const applied = assistant.applyProposal(r.proposalId);
    assert.equal(applied.affected, 2);
    assert.deepEqual(store.read('transactions').find(t => t.id === 'a').tags, ['Groceries run']);
    assert.equal(store.read('transactions').find(t => t.id === 'a').categorySource, 'user');
    assert.match(JSON.parse(await tools.propose_changes.run({ selection: { merchant: 'Nobody' }, set: {}, summary: 'x' })).error, /No transactions/);
    assert.match(JSON.parse(await tools.propose_changes.run({ selection: { ids: ['a'] }, set: { category: 'Nope' }, summary: 'x' })).error, /Unknown category/);

    const trip = JSON.parse(await tools.propose_trip.run({ name: 'Bangkok', start: '2026-09-01', end: '2026-09-30' }));
    assert.equal(trip.purchasesInRange, 3);
    assistant.applyProposal(trip.proposalId);
    assert.equal(store.read('settings').trips.length, 1);
    assert.throws(() => assistant.applyProposal('nope'), /expired/);
  } finally { cleanup(); }
});

test('vision: extraction output is normalized and bad rows dropped', () => {
  const { store, cleanup } = tempStore();
  try {
    const claude = createClaude({ store, apiKey: () => null });
    const vision = createVision({ claude, store });
    const out = vision.normalize({ kind: 'statement', currency: 'ils', card: '7333', rows: [
      { date: '2026-09-01', description: 'SUPERSAL', amount: 120.5 },
      { date: '2026-09-02', description: 'PAYMENT', amount: -500, isPayment: true },
      { date: 'bad', description: 'x', amount: 1 },
      { date: '2026-09-03', description: 'GRAB', amount: 12, currency: 'thb' },
      { date: '2026-09-04', description: 'AMZN', amount: 30, originalAmount: 108, originalCurrency: 'ILS' },
    ], notes: 'assumed 2026' });
    assert.equal(out.kind, 'statement');
    assert.equal(out.currency, 'ILS');
    assert.equal(out.rows.length, 4);
    assert.equal(out.rows[2].currency, 'THB');
    assert.deepEqual([out.rows[3].originalAmount, out.rows[3].originalCurrency], [108, 'ILS']);
    assert.equal(out.rows[1].isPayment, true);
    const receipt = vision.normalize({ kind: 'receipt', currency: 'USD', receipt: { merchant: 'Target', date: '2026-09-05', total: 30, items: [{ label: 'Milk', amount: 4, category: 'Groceries' }, { label: '', amount: 3, category: 'Other' }] } });
    assert.equal(receipt.kind, 'receipt');
    assert.equal(receipt.receipt.items.length, 1);
    assert.equal(vision.normalize({ kind: 'none', currency: 'USD' }).kind, 'none');
    assert.equal(vision.describeFile('x.heic', 10), null);
    assert.equal(vision.describeFile('x.PDF', 10).block, 'document');
  } finally { cleanup(); }
});

test('review candidates skip hand-set merchants; applying marks them as set by hand', () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    const claude = createClaude({ store, apiKey: () => null });
    const hygiene = createHygiene({ store, claude });
    const names = hygiene.candidates().map(c => c.merchant);
    assert.ok(names.includes('Supersal') && names.includes('Gett'));
    assert.ok(!names.includes('Wolt'), 'set by the user');
    const r = hygiene.apply([{ merchant: 'Gett', category: 'Travel & Transport' }, { merchant: 'Supersal', category: 'Shopping' }]);
    assert.equal(r.moved, 2);
    assert.equal(store.read('transactions').find(t => t.id === 'f').categorySource, 'user');
    assert.equal(store.read('merchants').Supersal, 'Shopping');
  } finally { cleanup(); }
});

test('merchant intelligence: candidates are the unknown merchants, stats read the ledger', () => {
  const { store, cleanup } = tempStore();
  try {
    seed(store);
    store.write('merchantInfo', { Wolt: { type: 'food delivery', confidence: 0.9 } });
    const claude = createClaude({ store, apiKey: () => null });
    const intel = createMerchantIntel({ store, claude });
    const c = intel.candidates(10);
    assert.equal(c[0].merchant, 'Supersal');
    assert.ok(!c.some(x => x.merchant === 'Wolt'));
    assert.equal(c.find(x => x.merchant === 'Supersal').raw, 'SUPERSAL DEAL 123');
    const s = intel.stats('Supersal');
    assert.deepEqual([s.count, s.total, s.average, s.first], [2, 124.5, 62.25, '2026-09-02']);
    assert.equal(claude.available(), false);
  } finally { cleanup(); }
});

test('usage tally and cost estimate', () => {
  const { store, cleanup } = tempStore();
  try {
    const claude = createClaude({ store, apiKey: () => 'k' });
    claude.record('ask', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 500, server_tool_use: { web_search_requests: 2 } });
    claude.record('ask', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 0 });
    const u = claude.usageThisMonth();
    assert.equal(u.calls, 2);
    assert.equal(u.searches, 2);
    assert.ok(u.usd > 0.02 && u.usd < 0.05, `usd ${u.usd}`);
    assert.equal(u.features.ask.calls, 2);
  } finally { cleanup(); }
});
