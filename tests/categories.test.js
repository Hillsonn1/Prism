'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { autoCategory, mapBankCategory, mapPlaidCategory, isPayment, CATEGORIES } = require('../src/server/categories');

test('keyword rules cover common merchants', () => {
  assert.equal(autoCategory('WHOLEFDS MKT'), 'Groceries');
  assert.equal(autoCategory('Starbucks'), 'Dining & Restaurants');
  assert.equal(autoCategory('SHELL OIL 12345'), 'Gas & Fuel');
  assert.equal(autoCategory('Netflix'), 'Subscriptions & Streaming');
  assert.equal(autoCategory('AMAZON WEB SERVICES'), 'Business Expenses');
  assert.equal(autoCategory('Some Unknown Place'), null);
});

test('every rule category is a real category', () => {
  const { AUTO_RULES } = require('../src/server/categories');
  for (const [, cat] of AUTO_RULES) assert.ok(CATEGORIES.includes(cat), cat);
});

test('bank and Plaid categories map to ours', () => {
  assert.equal(mapBankCategory('Food & Drink'), 'Dining & Restaurants');
  assert.equal(mapBankCategory('nonsense'), null);
  assert.equal(mapPlaidCategory({ primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }), 'Groceries');
  assert.equal(mapPlaidCategory({ primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' }), 'Gas & Fuel');
  assert.equal(mapPlaidCategory({ primary: 'GENERAL_SERVICES', detailed: 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES' }), null);
  assert.equal(mapPlaidCategory(null), null);
});

test('payment detection', () => {
  for (const s of ['Payment Thank You-Mobile', 'AUTOMATIC PAYMENT - THANK YOU', 'CAPITAL ONE AUTOPAY PYMT', 'ONLINE PAYMENT THANK YOU'])
    assert.ok(isPayment(s), s);
  for (const s of ['Starbucks', 'Netflix', 'Whole Foods Market'])
    assert.ok(!isPayment(s), s);
});
