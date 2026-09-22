'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSV, parseStatementText, normalizeDate, parseCSVRows } = require('../src/server/parsers/statements');

test('Chase-style CSV: negative charges flipped, payments skipped, categories kept', () => {
  const csv = [
    'Transaction Date,Post Date,Description,Category,Type,Amount',
    '01/15/2026,01/16/2026,STARBUCKS #123,Food & Drink,Sale,-4.50',
    '01/16/2026,01/16/2026,Payment Thank You-Mobile,,Payment,500.00',
    '01/17/2026,01/18/2026,AMAZON,Shopping,Sale,-32.99',
    '01/18/2026,01/18/2026,ZARA,Shopping,Return,12.00',
  ].join('\n');
  const rows = parseCSV(csv);
  assert.deepEqual(rows.map(r => [r.date, r.merchant, r.amount, r.csvCategory]), [
    ['2026-01-15', 'STARBUCKS #123', 4.5, 'Food & Drink'],
    ['2026-01-17', 'AMAZON', 32.99, 'Shopping'],
    ['2026-01-18', 'ZARA', -12, 'Shopping'],
  ]);
});

test('debit/credit column CSV', () => {
  const csv = 'Date,Description,Debit,Credit\n2026-02-01,GAS STATION,40.00,\n2026-02-02,REFUND,,15.00\n2026-02-03,ONLINE PAYMENT THANK YOU,,200';
  const rows = parseCSV(csv);
  assert.deepEqual(rows.map(r => [r.merchant, r.amount]), [['GAS STATION', 40], ['REFUND', -15]]);
});

test('unrecognized columns throw a helpful error', () => {
  assert.throws(() => parseCSV('Foo,Bar\n1,2'), /Could not detect CSV format/);
});

test('quoted fields with commas and doubled quotes', () => {
  const rows = parseCSVRows('a,b\n"Smith, John","say ""hi"""');
  assert.deepEqual(rows, [{ a: 'Smith, John', b: 'say "hi"' }]);
});

test('date formats', () => {
  assert.equal(normalizeDate('1/5/2026'), '2026-01-05');
  assert.equal(normalizeDate('01/05/26'), '2026-01-05');
  assert.equal(normalizeDate('2026-01-05T00:00:00'), '2026-01-05');
  assert.equal(normalizeDate('Jan 5, 2026'), '2026-01-05');
  assert.equal(normalizeDate('5 Jan 2026'), '2026-01-05');
});

test('statement text lines', () => {
  const rows = parseStatementText('01/15/2026  WHOLE FOODS MARKET  $84.12\nJan 3, 2026  NETFLIX.COM  15.49\n01/02/2026 01/03/2026 SHELL OIL 10.00\nTotal 1,234.00');
  assert.deepEqual(rows.map(r => [r.date, r.merchant, r.amount]), [
    ['2026-01-15', 'WHOLE FOODS MARKET', 84.12],
    ['2026-01-03', 'NETFLIX.COM', 15.49],
    ['2026-01-02', 'SHELL OIL', 10],
  ]);
});
