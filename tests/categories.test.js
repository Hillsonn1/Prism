'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { autoCategory, genericCategory, findSimilarMerchant, categoryFromDescription, mapBankCategory, mapPlaidCategory, isPayment, CATEGORIES } = require('../src/server/categories');

test('keyword rules cover common merchants', () => {
  assert.equal(autoCategory('WHOLEFDS MKT'), 'Groceries');
  assert.equal(autoCategory('Starbucks'), 'Dining & Restaurants');
  assert.equal(autoCategory('SHELL OIL 12345'), 'Gas & Fuel');
  assert.equal(autoCategory('Netflix'), 'Subscriptions & Streaming');
  assert.equal(autoCategory('AMAZON WEB SERVICES'), 'Business Expenses');
  assert.equal(autoCategory('Some Unknown Place'), null);
});

test('every rule category is a real category', () => {
  const { AUTO_RULES, ISRAEL_RULES, GENERIC_RULES, DESCRIPTION_RULES } = require('../src/server/categories');
  for (const rules of [AUTO_RULES, ISRAEL_RULES, GENERIC_RULES, DESCRIPTION_RULES])
    for (const [, cat] of rules) assert.ok(CATEGORIES.includes(cat), cat);
});

test('Israeli chains', () => {
  const cases = {
    'Shufersal Sheli': 'Groceries', 'Rami Levy': 'Groceries', 'Super-Pharm Dizengoff': 'Health & Medical',
    'Paz Yellow': 'Gas & Fuel', 'Cofix': 'Dining & Restaurants', 'Egged': 'Travel & Transport',
    'Rav Kav Online': 'Travel & Transport', 'Bezeq': 'Utilities & Bills', 'Castro': 'Shopping',
    'Meuhedet': 'Health & Medical', 'Yeshivat Hakotel': 'Education', 'Kupat Hair': 'Gifts & Donations',
    'Cinema City': 'Entertainment', 'Wolt': 'Dining & Restaurants',
  };
  for (const [m, cat] of Object.entries(cases)) assert.equal(autoCategory(m), cat, m);
});

test('generic business words are a second tier', () => {
  assert.equal(autoCategory('Main Street Hardware'), null);
  assert.equal(genericCategory('Main Street Hardware'), 'Home & Garden');
  assert.equal(genericCategory('Elite Nails'), 'Personal Care');
  assert.equal(genericCategory('Acme Consulting LLC'), 'Business Expenses');
  assert.equal(genericCategory('Blue Door'), null);
});

test('describe-it text maps to a category locally', () => {
  const cases = { gas: 'Gas & Fuel', 'lunch with a client': 'Dining & Restaurants', 'weekly groceries': 'Groceries',
    haircut: 'Personal Care', netflix: 'Subscriptions & Streaming', 'flight to la': 'Travel & Transport',
    'vaad bayit': 'Utilities & Bills', 'new sneakers': 'Shopping', '': null, 'xyzzy': null };
  for (const [t, cat] of Object.entries(cases)) assert.equal(categoryFromDescription(t), cat, t);
});

test('fuzzy memory only matches on a whole leading word', () => {
  const mem = { Starbucks: 'Dining & Restaurants', Amazon: 'Shopping', Shell: 'Gas & Fuel' };
  assert.equal(findSimilarMerchant('Starbucks Store', mem).category, 'Dining & Restaurants');
  assert.equal(findSimilarMerchant('Amazon Mktpl', mem).category, 'Shopping');
  assert.equal(findSimilarMerchant('Shell Beach Cafe', mem), null); // too short a stem to trust
  assert.equal(findSimilarMerchant('Starbuck', mem), null);
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
