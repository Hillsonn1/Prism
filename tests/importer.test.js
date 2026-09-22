'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempStore } = require('./helpers');
const { importRows, categorizeUncategorized } = require('../src/server/importer');

test('import categorizes locally, remembers merchants, and skips duplicates', async () => {
  const { store, cleanup } = tempStore();
  try {
    store.write('merchants', { 'Blue Door': 'Personal Care' });
    const rows = [
      { date: '2026-09-01', merchant: 'WHOLEFDS MKT 10234', amount: 84.12 },
      { date: '2026-09-02', merchant: 'SQ *BLUE DOOR 4410', amount: 41 },
      { date: '2026-09-03', merchant: 'MYSTERY PLACE', amount: 12, csvCategory: 'Gas' },
      { date: '2026-09-04', merchant: 'TOTALLY UNKNOWN', amount: 9 },
    ];
    const r1 = await importRows(store, rows, { source: 'Sept', card: 'Chase' });
    assert.equal(r1.imported, 4);
    assert.deepEqual(r1.unknownMerchants, ['Totally Unknown']);
    assert.deepEqual(r1.suggestions, []);
    const txns = store.read('transactions');
    const byName = Object.fromEntries(txns.map(t => [t.merchant, t]));
    assert.equal(byName['Whole Foods'].category, 'Groceries');
    assert.equal(byName['Blue Door'].category, 'Personal Care');   // from memory
    assert.equal(byName['Mystery Place'].category, 'Gas & Fuel');   // from the bank's column
    assert.equal(byName['Totally Unknown'].category, null);
    assert.equal(byName['Whole Foods'].card, 'Chase');
    assert.equal(store.read('merchants')['Whole Foods'], 'Groceries');

    const r2 = await importRows(store, rows, { source: 'Sept again' });
    assert.equal(r2.imported, 0);
    assert.equal(r2.duplicates, 4);
    assert.equal(store.read('transactions').length, 4);
  } finally { cleanup(); }
});

test('categorizeUncategorized applies memory and rules without AI', async () => {
  const { store, cleanup } = tempStore();
  try {
    store.write('transactions', [
      { id: '1', date: '2026-09-01', merchant: 'Netflix', amount: 15, category: null },
      { id: '2', date: '2026-09-01', merchant: 'Weird Shop', amount: 15, category: null },
      { id: '3', date: '2026-09-01', merchant: 'Known', amount: 15, category: null },
    ]);
    store.write('merchants', { Known: 'Other' });
    const r = await categorizeUncategorized(store);
    assert.equal(r.autoUpdated, 2);
    assert.deepEqual(r.unknownMerchants, []);
    // "Shop" is a generic hint, so it becomes a suggestion to confirm rather than a fact
    assert.deepEqual(r.suggestions, [{ merchant: 'Weird Shop', category: 'Shopping', confidence: 0.7 }]);
    const cats = Object.fromEntries(store.read('transactions').map(t => [t.merchant, t.category]));
    assert.deepEqual(cats, { Netflix: 'Subscriptions & Streaming', 'Weird Shop': null, Known: 'Other' });
  } finally { cleanup(); }
});

test('close matches to remembered merchants come back as suggestions', async () => {
  const { store, cleanup } = tempStore();
  try {
    store.write('merchants', { Starbucks: 'Business Expenses' });
    const r = await importRows(store, [{ date: '2026-09-01', merchant: 'STARBUCKS STORE 08812', amount: 5 }], { source: 's' });
    // normalization already strips "STORE 08812", so this is an exact memory hit
    assert.equal(store.read('transactions')[0].category, 'Business Expenses');
    const r2 = await importRows(store, [{ date: '2026-09-02', merchant: 'STARBUCKS RESERVE ROASTERY', amount: 9 }], { source: 's' });
    assert.deepEqual(r2.suggestions.map(s => [s.merchant, s.category]), [['Starbucks Reserve Roastery', 'Business Expenses']]);
    assert.equal(store.read('transactions')[1].category, null);
    assert.equal(r.imported + r2.imported, 2);
  } finally { cleanup(); }
});

test('merge proposals and local insights', () => {
  const { mergeProposals } = require('../src/server/dedupe');
  const { spendingInsights, recurringCharges } = require('../src/server/insights');
  const tx = [];
  const add = (date, merchant, amount, category = null) => tx.push({ id: String(tx.length), date, merchant, amount, category });
  add('2026-09-01', 'Amazon', 10, 'Shopping'); add('2026-09-02', 'Amazon', 12, 'Shopping'); add('2026-09-03', 'Amazon Mktpl', 9, 'Shopping');
  add('2026-09-04', 'Krispy Kreme', 5); add('2026-09-05', 'Krispykreme', 5);
  add('2026-09-06', 'Target', 30, 'Shopping'); add('2026-09-07', 'Target Optical', 90, 'Health & Medical');
  add('2026-09-08', 'Blue Bottle Coffee', 6); add('2026-09-09', 'Blue Bottle Cofee', 6);
  const proposals = mergeProposals(tx, { Target: 'Shopping', 'Target Optical': 'Health & Medical' });
  assert.deepEqual(proposals.map(p => [p.from, p.to]), [
    ['Amazon Mktpl', 'Amazon'], ['Blue Bottle Cofee', 'Blue Bottle Coffee'], ['Krispykreme', 'Krispy Kreme'],
  ]);

  for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) { add(`${m}-03`, 'Netflix', 15.49, 'Subscriptions & Streaming'); add(`${m}-08`, 'Whole Foods', 220, 'Groceries'); add(`${m}-15`, 'Whole Foods', 180, 'Groceries'); }
  assert.deepEqual(recurringCharges(tx).map(r => r.merchant), ['Netflix']);
  const texts = spendingInsights(tx, '2026-09', new Date('2026-09-23T12:00:00Z')).map(i => i.kind);
  assert.ok(texts.includes('total') && texts.includes('top-category') && texts.includes('uncategorized'), texts.join(','));
  assert.deepEqual(spendingInsights([], '2026-09'), []);
});
