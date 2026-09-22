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
    assert.deepEqual(r.unknownMerchants, ['Weird Shop']);
    const cats = Object.fromEntries(store.read('transactions').map(t => [t.merchant, t.category]));
    assert.deepEqual(cats, { Netflix: 'Subscriptions & Streaming', 'Weird Shop': null, Known: 'Other' });
  } finally { cleanup(); }
});
