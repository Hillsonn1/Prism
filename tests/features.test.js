'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempStore } = require('./helpers');
const { refundCandidates, bestMatch, autoMatchRefunds } = require('../src/server/refunds');
const cfg = require('../src/server/categoryConfig');
const trips = require('../src/server/trips');
const { applyRedirects, importRows } = require('../src/server/importer');
const { spendingInsights, anomalies } = require('../src/server/insights');

const T = (id, merchant, date, amount, extra = {}) => ({ id, merchant, date, amount, ...extra });

test('refunds: exact same-merchant matches win, ambiguous ones are left alone', () => {
  const all = [
    T('p1', 'Amazon', '2026-09-01', 40, { category: 'Shopping' }),
    T('p2', 'Amazon', '2026-09-03', 25, { category: 'Shopping' }),
    T('p3', 'Amazon', '2026-09-04', 25, { category: 'Shopping' }),
    T('r1', 'Amazon Mktpl', '2026-09-10', -40),
    T('r2', 'Amazon', '2026-09-11', -25),
    T('r3', 'Zara', '2026-09-12', -40),
    T('old', 'Amazon', '2025-01-01', 40, { category: 'Shopping' }),
  ];
  const c = refundCandidates(all[3], all);
  assert.equal(c[0].id, 'p1');
  assert.ok(c[0].exact && c[0].sameMerchant);
  assert.ok(!c.some(x => x.id === 'old'), 'a purchase from long ago is out of the window');
  assert.equal(bestMatch(all[4], all), null, 'two identical purchases make the match ambiguous');
  assert.equal(bestMatch(all[5], all), null, 'a different merchant is never matched on amount alone');
  assert.equal(autoMatchRefunds(all), 1);
  assert.equal(all[3].refundOf, 'p1');
  assert.equal(all[3].category, 'Shopping');
  assert.equal(autoMatchRefunds(all), 0, 'a second run links nothing new');
});

test('refunds: a purchase is not refunded twice', () => {
  const all = [T('p1', 'Gett', '2026-09-01', 18.5), T('r1', 'Gett', '2026-09-02', -18.5, { refundOf: 'p1' }), T('r2', 'Gett', '2026-09-03', -18.5)];
  assert.equal(autoMatchRefunds(all), 0);
  assert.equal(all[2].refundOf, undefined);
});

test('categories: add, recolor, rename, merge and restore', () => {
  const { store, cleanup } = tempStore();
  try {
    store.write('transactions', [T('a', 'Gymboree', '2026-09-01', 30, { category: 'Shopping' }), T('b', 'Pet Store', '2026-09-02', 12, { category: 'Other' })]);
    store.write('merchants', { 'Pet Store': 'Other' });
    store.update('settings', s => { s.budgets = { Other: 50, Shopping: 100 }; });

    const pets = cfg.addCategory(store, { name: '  Pets ', color: '#FF6482', icon: 'paw' });
    assert.deepEqual([pets.name, pets.color, pets.icon, pets.builtIn], ['Pets', '#ff6482', 'paw', false]);
    assert.throws(() => cfg.addCategory(store, { name: 'pets' }), /already exists/);
    assert.throws(() => cfg.updateCategory(store, 'Pets', { color: 'red' }), /hex/);
    assert.equal(cfg.updateCategory(store, 'Groceries', { color: '#112233', hidden: true }).hidden, true);
    assert.throws(() => cfg.renameCategory(store, 'Groceries', 'Food'), /Built-in/);

    cfg.renameCategory(store, 'Pets', 'Animals');
    assert.ok(cfg.getCategories(store).some(c => c.name === 'Animals' && c.icon === 'paw'));

    const r = cfg.mergeCategory(store, 'Other', 'Animals');
    assert.equal(r.moved, 1);
    assert.equal(store.read('transactions').find(t => t.id === 'b').category, 'Animals');
    assert.equal(store.read('merchants')['Pet Store'], 'Animals');
    assert.deepEqual(store.read('settings').budgets, { Shopping: 100, Animals: 50 });
    const other = cfg.getCategories(store).find(c => c.name === 'Other');
    assert.ok(other.hidden && other.redirect === 'Animals');
    assert.deepEqual(cfg.redirectMap(store), { Other: 'Animals' });

    cfg.restoreCategory(store, 'Other');
    assert.equal(cfg.getCategories(store).find(c => c.name === 'Other').redirect, undefined);
  } finally { cleanup(); }
});

test('categories: merged-away built-ins are redirected on import', async () => {
  const { store, cleanup } = tempStore();
  try {
    cfg.addCategory(store, { name: 'Food' });
    cfg.mergeCategory(store, 'Groceries', 'Food');
    await importRows(store, [{ date: '2026-09-01', merchant: 'WHOLEFDS MKT 10234', amount: 84.12 }], { source: 'S' });
    assert.equal(store.read('transactions')[0].category, 'Food');
    const rows = [{ category: 'Groceries' }, { category: 'Shopping' }];
    const merchants = { A: 'Groceries' };
    applyRedirects(store, rows, merchants);
    assert.deepEqual(rows.map(r => r.category), ['Food', 'Shopping']);
    assert.equal(merchants.A, 'Food');
  } finally { cleanup(); }
});

test('trips: creating one tags the range but leaves recurring and at-home charges out', () => {
  const { store, cleanup } = tempStore();
  try {
    const netflix = m => T(`n${m}`, 'Netflix', `2026-0${m}-05`, 15.99, { category: 'Entertainment' });
    store.write('transactions', [
      netflix(6), netflix(7), netflix(8),
      T('a', 'Mojos Street Food', '2026-08-03', 12, { category: 'Dining & Restaurants' }),
      T('b', 'Bezeq', '2026-08-04', 60, { category: 'Utilities & Bills' }),
      T('c', 'Grab', '2026-08-06', 4.5, { category: 'Travel & Transport' }),
      T('d', 'Home Depot', '2026-08-20', 90, { category: 'Home & Garden' }),
    ]);
    const { trip, tagged } = trips.createTrip(store, { name: 'Thailand', start: '2026-08-01', end: '2026-08-10' });
    assert.equal(tagged, 2);
    const byId = Object.fromEntries(store.read('transactions').map(t => [t.id, t]));
    assert.deepEqual(byId.a.tags, ['Thailand']);
    assert.deepEqual(byId.c.tags, ['Thailand']);
    assert.equal(byId.n8.tags, undefined, 'a recurring charge stays out');
    assert.equal(byId.b.tags, undefined, 'bills stay out');
    assert.equal(byId.d.tags, undefined, 'outside the range');
    assert.equal(trips.tagRange(store, trip, { includeAll: true }), 2);
    assert.throws(() => trips.createTrip(store, { name: 'thailand', start: '2026-08-01', end: '2026-08-02' }), /already a trip/);
    assert.throws(() => trips.createTrip(store, { name: 'X', start: '2026-08-10', end: '2026-08-01' }), /ends before/);

    trips.updateTrip(store, trip.id, { name: 'Thailand 2026' });
    assert.deepEqual(store.read('transactions').find(t => t.id === 'a').tags, ['Thailand 2026']);
    trips.deleteTrip(store, trip.id, { removeTags: true });
    assert.equal(store.read('transactions').find(t => t.id === 'a').tags, undefined);
    assert.deepEqual(trips.listTrips(store), []);
  } finally { cleanup(); }
});

test('trips: suggestions come from runs of purchases away from home', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal(trips.homeCountry({ location: 'Jerusalem, Israel' }), 'IL');
    assert.equal(trips.homeCountry({}), null);
    const away = (id, day) => T(id, 'Shop', `2026-08-${String(day).padStart(2, '0')}`, 10, { location: { country: 'TH', city: 'Bangkok' } });
    store.write('transactions', [
      T('h1', 'Supersal', '2026-08-01', 50, { location: { country: 'IL' } }),
      away('t1', 3), away('t2', 3), away('t3', 5), away('t4', 7), away('t5', 8),
      away('lone', 25),
    ]);
    assert.deepEqual(trips.suggestTrips(store), [], 'no home country set yet');
    store.update('settings', s => { s.location = 'Jerusalem, Israel'; });
    const s = trips.suggestTrips(store);
    assert.equal(s.length, 1);
    assert.deepEqual([s[0].start, s[0].end, s[0].country, s[0].purchases], ['2026-08-03', '2026-08-08', 'TH', 5]);
    trips.createTrip(store, { name: 'Bangkok', start: '2026-08-02', end: '2026-08-09' });
    assert.deepEqual(trips.suggestTrips(store), [], 'a trip already covers it');
  } finally { cleanup(); }
});

test('excluded and reimbursable rows stay out of insights and anomalies', () => {
  const rows = [
    T('a', 'Apple', '2026-09-01', 900, { excluded: true }),
    T('b', 'Apple', '2026-09-02', 900, { reimbursable: true }),
    T('c', 'Kolbo', '2026-09-03', 5, { category: 'Groceries' }),
  ];
  const insights = spendingInsights(rows, '2026-09', new Date('2026-09-23T12:00:00Z'));
  assert.ok(insights.every(i => !/Apple/.test(i.text)));
  assert.deepEqual(anomalies(rows, '2026-09'), []);
});
