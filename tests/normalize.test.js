'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quickNormalizeName, toTitleCase } = require('../src/server/normalize');

test('strips processor prefixes, store numbers and locations', () => {
  const cases = {
    'SQ *BLUE BOTTLE COFFEE 0142 BROOKLYN NY': 'Blue Bottle Coffee',
    'WHOLEFDS MKT 10234': 'Whole Foods',
    'AMZN Mktp US*2K3': 'Amazon',
    'UBER *TRIP HELP.UBER.COM': 'Uber',
    'PAYPAL *SPOTIFY': 'Spotify',
    'NETFLIX.COM': 'Netflix',
    'APLPAY STARBUCKS #1234': 'Starbucks',
  };
  for (const [raw, expected] of Object.entries(cases)) {
    assert.equal(quickNormalizeName(raw), expected, raw);
  }
});

// Known gaps, targeted by the normalization work in the local-first pass
test('harder descriptors', { todo: true }, () => {
  assert.equal(quickNormalizeName('TST* JOES PIZZA - NEW YORK NY'), 'Joes Pizza');
  assert.equal(quickNormalizeName('JOES PIZZA NEW YORK NY'), 'Joes Pizza');
  assert.equal(quickNormalizeName('TST* JOES PIZZA BROOKLYN NY'), 'Joes Pizza'); // strips "Pizza" today
  assert.equal(quickNormalizeName('SQ *BLUE DOOR 44'), 'Blue Door');
  assert.equal(quickNormalizeName('STARBUCKS STORE 08812'), 'Starbucks');
  assert.equal(quickNormalizeName("MCDONALD'S F1234 FLUSHING NY"), "McDonald's");
});

test('handles Israeli city suffixes', () => {
  assert.equal(quickNormalizeName('SHUFERSAL DEAL BNEI BRAK'), 'Shufersal Deal');
  assert.equal(quickNormalizeName('AROMA ESPRESSO BAR TEL AVIV'), 'Aroma Espresso Bar');
  assert.equal(quickNormalizeName('COFIX LTDJERUSALEM'), 'Cofix');
});

test('never returns an empty name', () => {
  assert.equal(quickNormalizeName('12345'), '12345');
  assert.equal(quickNormalizeName('   NY  '), 'Ny');
});

test('title case keeps apostrophes and separators', () => {
  assert.equal(toTitleCase("TRADER JOE'S #123"), "Trader Joe's #123");
  assert.equal(toTitleCase('h&m store'), 'H&M Store');
});
