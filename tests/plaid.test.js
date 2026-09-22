'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempStore } = require('./helpers');
const { createPlaid, isSpend } = require('../src/server/plaid');

const pfc = (primary, detailed) => ({ primary, detailed });
const credit = { type: 'credit' };
const checking = { type: 'depository' };

test('isSpend keeps purchases and refunds, drops payments, transfers and income', () => {
  assert.ok(isSpend({ name: 'STARBUCKS', amount: 4.5, personal_finance_category: pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE') }, credit));
  assert.ok(isSpend({ name: 'STARBUCKS', amount: -4.5, personal_finance_category: pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE') }, credit), 'refund');
  assert.ok(isSpend({ name: 'PAYMENT PROCESSING INC', amount: 49 }, credit), 'merchant with payment in its name');
  assert.ok(isSpend({ name: 'ROCKET MORTGAGE', amount: 2100, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT') }, checking));
  assert.ok(!isSpend({ name: 'AUTOMATIC PAYMENT - THANK', amount: 2078.5, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_OTHER_PAYMENT') }, credit));
  assert.ok(!isSpend({ name: 'AUTOMATIC PAYMENT - THANK YOU', amount: -1500 }, credit));
  assert.ok(!isSpend({ name: 'CHASE CREDIT CRD AUTOPAY', amount: 900, personal_finance_category: pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') }, checking));
  assert.ok(!isSpend({ name: 'GUSTO PAY', amount: -5850, personal_finance_category: pfc('INCOME', 'INCOME_WAGES') }, checking));
  assert.ok(!isSpend({ name: 'VENMO', amount: 50, personal_finance_category: pfc('TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER') }, checking));
});

// A fake Plaid that serves scripted /transactions/sync pages
function fakePlaid(pages) {
  const calls = [];
  return {
    calls,
    request: async (_cfg, endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint !== '/transactions/sync') return {};
      const page = pages[body.cursor || 'start'];
      if (!page) throw Object.assign(new Error('bad cursor'), { plaidCode: 'INVALID_FIELD' });
      return { added: [], modified: [], removed: [], ...page };
    },
  };
}

function setup(pages) {
  const t = tempStore();
  t.store.write('settings', { plaid: { clientId: 'c', secret: 's', env: 'sandbox' } });
  t.store.write('plaid', { items: [{
    itemId: 'item-1', accessToken: 'tok', institutionName: 'Mock Bank', cursor: null, accounts: [
      { accountId: 'card', type: 'credit', enabled: true, source: 'Mock ••1', card: 'Mock ••1' },
      { accountId: 'sav', type: 'depository', enabled: false, source: 'Mock ••2', card: 'Mock ••2' },
    ] }] });
  const fake = fakePlaid(pages);
  const plaid = createPlaid({ store: t.store, request: fake.request, log: { error() {} } });
  return { ...t, plaid, fake };
}

const T = (id, acct, name, amount, date, cat, extra = {}) =>
  ({ transaction_id: id, account_id: acct, name, merchant_name: null, amount, date, authorized_date: date, pending: false, personal_finance_category: cat, ...extra });

test('sync walks pages, imports spend only, keeps cursor', async () => {
  const { store, plaid, fake, cleanup } = setup({
    start: { added: [T('a', 'card', 'WHOLEFDS MKT', 84.12, '2026-09-01', pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'))], next_cursor: 'c1', has_more: true },
    c1: { added: [
      T('b', 'card', 'STARBUCKS', 5.5, '2026-09-02', pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'), { pending: true }),
      T('c', 'card', 'PAYMENT THANK YOU', -500, '2026-09-02', pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')),
      T('d', 'sav', 'INTEREST', -1, '2026-09-02', pfc('INCOME', 'INCOME_INTEREST_EARNED')),
    ], next_cursor: 'c2', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
  });
  try {
    const r = await plaid.syncItems();
    assert.deepEqual(r, { added: 2, updated: 0, removed: 0, skipped: 1, errors: 0 });
    const txns = store.read('transactions');
    assert.deepEqual(txns.map(t => [t.merchant, t.amount, t.category, Boolean(t.pending)]), [
      ['Whole Foods', 84.12, 'Groceries', false],
      ['Starbucks', 5.5, 'Dining & Restaurants', true],
    ]);
    const item = store.read('plaid').items[0];
    assert.equal(item.cursor, 'c2');
    assert.equal(item.updateStatus, 'HISTORICAL_UPDATE_COMPLETE');
    assert.equal(plaid.state.changeCounter, 1);
    assert.equal(fake.calls.filter(c => c.endpoint === '/transactions/sync').length, 2);
  } finally { cleanup(); }
});

test('pending → posted keeps the row and user edits; modified and removed apply', async () => {
  const { store, plaid, cleanup } = setup({
    start: { added: [
      T('p1', 'card', 'STARBUCKS', 5.5, '2026-09-02', pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'), { pending: true }),
      T('x', 'card', 'AMAZON', 32.99, '2026-09-03', pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES')),
      T('gone', 'card', 'ZARA', 20, '2026-09-04', pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES')),
    ], next_cursor: 'c1', has_more: false },
    c1: {
      added: [T('p2', 'card', 'STARBUCKS', 5.75, '2026-09-02', pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'), { pending_transaction_id: 'p1' })],
      modified: [T('x', 'card', 'AMAZON', 35.99, '2026-09-03', pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES'))],
      removed: [{ transaction_id: 'p1' }, { transaction_id: 'gone' }],
      next_cursor: 'c2', has_more: false,
    },
  });
  try {
    await plaid.syncItems();
    const pending = store.read('transactions').find(t => t.plaidId === 'p1');
    pending.category = 'Business Expenses';
    pending.notes = 'client coffee';
    store.write('transactions', store.read('transactions'));

    const r = await plaid.syncItems();
    assert.deepEqual(r, { added: 0, updated: 2, removed: 1, skipped: 0, errors: 0 });
    const txns = store.read('transactions');
    assert.equal(txns.length, 2);
    const sbux = txns.find(t => t.merchant === 'Starbucks');
    assert.equal(sbux.id, pending.id);
    assert.equal(sbux.plaidId, 'p2');
    assert.equal(sbux.amount, 5.75);
    assert.equal(sbux.category, 'Business Expenses');
    assert.equal(sbux.notes, 'client coffee');
    assert.equal(sbux.pending, undefined);
    assert.equal(txns.find(t => t.merchant === 'Amazon').amount, 35.99);
  } finally { cleanup(); }
});

test('a failing item records the error and does not block others', async () => {
  const { store, plaid, cleanup } = setup({});
  try {
    const r = await plaid.syncItems();
    assert.equal(r.errors, 1);
    assert.match(store.read('plaid').items[0].lastError.message, /bad cursor/);
  } finally { cleanup(); }
});
