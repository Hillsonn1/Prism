'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quickNormalizeName, toTitleCase } = require('../src/server/normalize');

const check = cases => {
  for (const [raw, expected] of Object.entries(cases)) assert.equal(quickNormalizeName(raw), expected, JSON.stringify(raw));
};

test('processor prefixes, ids, store numbers, urls', () => check({
  'SQ *BLUE BOTTLE COFFEE 0142 BROOKLYN NY': 'Blue Bottle Coffee',
  'SQ *BLUE DOOR 44': 'Blue Door',
  'TST* JOES PIZZA - NEW YORK NY': 'Joes Pizza',
  'APLPAY STARBUCKS #1234': 'Starbucks',
  'STARBUCKS STORE 08812': 'Starbucks',
  "MCDONALD'S F1234 FLUSHING NY": "McDonald's",
  'WHOLEFDS MKT 10234': 'Whole Foods',
  'AMZN Mktp US*2K3': 'Amazon',
  'UBER *TRIP HELP.UBER.COM': 'Uber',
  'PAYPAL *SPOTIFY': 'Spotify',
  'NETFLIX.COM': 'Netflix',
  'Google *Google One': 'Google One',
  '24six.appwww.24six': '24six',
  'GETSAUCE.COMDE': 'Getsauce',
  'KEVA1800800199HOL': 'Keva',
  'eBay C 18-13827-63987': 'eBay',
  'Ebay san Joseca': 'eBay',
  'Walmart+ Member 04/28009': 'Walmart+',
  'Etsy Etsy Purchase': 'Etsy',
  'D J*WSJ': 'Wall Street Journal',
  'MTA*NYCT PAYPAL': 'MTA NYC Transit',
}));

test('US locations: known cities, unknown cities, two-word cities, and merchant words kept', () => check({
  'JOES PIZZA BROOKLYN NY': 'Joes Pizza',
  'JOES PIZZA NEW YORK NY': 'Joes Pizza',
  'JOES PIZZA TEANECK NJ': 'Joes Pizza',
  'BIG APPLE PIZZA NY': 'Big Apple Pizza',
  'IN-N-OUT BURGER LOS ANGELES CA': 'In-N-Out Burger',
  'COFFEEMANHASSETNY': 'Coffee',
  "RALPH'S COFFEEMANHASSETNY": "Ralph's Coffee",
  'URBAN PRESSFLUSHINGNY': 'Urban Press',
  'WEB CHAVER424-242-8371NJ': 'Web Chaver',
  'GOOGLE ONE855-836-3987ca -': 'Google One',
}));

test('Israeli cities in every spelling', () => check({
  'SHUFERSAL DEAL BNEI BRAK': 'Shufersal Deal',
  'AROMA ESPRESSO BAR TEL AVIV': 'Aroma Espresso Bar',
  'COFIX LTDJERUSALEM': 'Cofix',
  'MECUHEDETJERUSALEM': 'Mecuhedet',
  'PLACETEL-AVIV': 'Place',
  'MEUHDETtel AVIV': 'Meuhdet',
  'YESHRISHON LEZION': 'Yesh',
  'ARIS BAKERBET SHEMESH': 'Aris Baker',
  'COFIX LTDBNEYBRAK': 'Cofix',
  'COFIX LTDBNEI BRAK': 'Cofix',
  'COFIX LTDBNI BREAK': 'Cofix',
  'Coffee Break': 'Coffee Break',
  'KATZEFET RAMAT ESHKOL': 'Katzefet Ramat Eshkol',
  'YESHLTD': 'Yesh',
}));

test('brand casing and acronyms', () => check({
  'KFC': 'KFC',
  'CVS/PHARMACY #0921': 'CVS Pharmacy',
  'IKEA BROOKLYN': 'IKEA',
  'H&M STORE 123': 'H&M',
  'ITUNES.COM/BILL': 'Apple',
  'DOORDASH*CHIPOTLE': 'DoorDash Chipotle',
  'TRADER JOES 552': "Trader Joe's",
  'DUNKIN #345612': "Dunkin'",
}));

test('numbers that are part of a name survive', () => check({
  'Studio 54': 'Studio 54',
  'Route 66 Diner': 'Route 66 Diner',
  '7-ELEVEN 32145': '7-Eleven',
}));

test('never returns an empty name', () => {
  assert.equal(quickNormalizeName('12345'), '12345');
  assert.equal(quickNormalizeName('   NY  '), 'NY');
});

test('title case keeps apostrophes and separators', () => {
  assert.equal(toTitleCase("TRADER JOE'S #123"), "Trader Joe's #123");
  assert.equal(toTitleCase('h&m store'), 'H&M Store');
});
