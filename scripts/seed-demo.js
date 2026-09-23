// Fills ./data with four months of realistic transactions for developing the
// UI. Wipes whatever is in ./data first — dev only.
//
//   node scripts/seed-demo.js && npm start

const fs = require('fs');
const path = require('path');
const { Store } = require('../src/server/storage');
const { importRows } = require('../src/server/importer');

const dataDir = process.env.PRISM_DATA_DIR || path.join(__dirname, '..', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const store = new Store(dataDir);

// Deterministic pseudo-random so the screens look the same every run
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = arr => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => Math.round((a + rand() * (b - a)) * 100) / 100;

const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09'];
const TODAY = '2026-09-23';
const day = (m, d) => `${m}-${String(d).padStart(2, '0')}`;

// [descriptor, min, max, per-month count]
const US = [
  ['WHOLEFDS MKT 10234 BROOKLYN NY', 60, 180, 4], ['TRADER JOES 552', 35, 90, 3], ['AMZN Mktp US*2K3', 12, 120, 5],
  ['STARBUCKS STORE 08812', 4.5, 9, 6], ['NETFLIX.COM', 15.49, 15.49, 1], ['SPOTIFY USA', 10.99, 10.99, 1],
  ['SHELL OIL 57442', 40, 75, 2], ['UBER *TRIP HELP.UBER.COM', 9, 38, 3], ['CVS/PHARMACY #0921', 8, 45, 2],
  ['TST* JOES PIZZA - NEW YORK NY', 14, 32, 2], ['SQ *BLUE BOTTLE COFFEE 0142', 5, 12, 3], ['APPLE.COM/BILL', 2.99, 9.99, 1],
  ['CHIPOTLE 1834', 11, 24, 2], ['TARGET 00021234', 20, 140, 2], ['VERIZON WRLS 855-836-3987', 85, 85, 1],
  ['DOORDASH*SWEETGREEN', 16, 34, 2], ['PLANET FITNESS', 24.99, 24.99, 1], ['HOME DEPOT #1234', 18, 160, 1],
  ['SQ *THE BLUE DOOR 44', 30, 60, 1], ['PAYPAL *ETSY', 15, 70, 1], ['LYFT *RIDE', 12, 28, 2],
];
const IL = [
  ['SHUFERSAL DEAL BNEI BRAK', 120, 480, 4], ['RAMI LEVY SHIVUK HASHIKMA', 150, 520, 2], ['SUPER-PHARM DIZENGOFF', 40, 210, 2],
  ['AROMA ESPRESSO BAR TEL AVIV', 18, 52, 4], ['COFIX LTDJERUSALEM', 6, 24, 5], ['PAZ YELLOW 12', 180, 320, 2],
  ['RAV KAV ONLINE', 60, 180, 1], ['CASTRO HAMOSHAVA PETAH TIKVA', 90, 350, 1], ['WOLT *LANDWER', 70, 160, 2],
  ['MEUHEDET', 45, 45, 1], ['BEZEQ INTERNATIONAL', 79.9, 79.9, 1], ['MAX STOCK BEIT SHEMESH', 35, 120, 1],
  ['GETT TAXI', 40, 95, 2], ['KSP COMPUTERS', 150, 900, 0.3], ['HAKATZAV SHEL HAMOSHAVA', 120, 300, 1],
];

const settings = { plaid: {}, currency: { ilsRate: 3.35 }, monthlyBudget: 4500, budgets: { Groceries: 900, 'Dining & Restaurants': 500, Shopping: 600, 'Gas & Fuel': 250 }, prefs: { theme: 'system' } };
store.write('settings', settings);
store.write('income', { _recurring: [{ id: 'inc-1', label: 'Salary', amount: 6400 }], '2026-08': [{ id: 'inc-2', label: 'Freelance project', amount: 1200 }] });
store.write('expenses', { _recurring: [{ id: 'exp-1', label: 'Rent', amount: 1850 }, { id: 'exp-2', label: 'Car insurance', amount: 140 }] });

(async () => {
  for (const m of MONTHS) {
    const lastDay = m === '2026-09' ? 23 : 30;
    const usRows = [];
    const ilRows = [];
    const emit = (list, rows) => {
      for (const [name, min, max, n] of list) {
        const count = n < 1 ? (rand() < n ? 1 : 0) : n;
        for (let i = 0; i < count; i++) rows.push({ date: day(m, 1 + Math.floor(rand() * lastDay)), merchant: name, amount: between(min, max) });
      }
    };
    emit(US, usRows);
    emit(IL, ilRows);
    if (m === '2026-09') { usRows.push({ date: day(m, 12), merchant: 'UNITED AIRLINES 0162345678', amount: 486 }); usRows.push({ date: day(m, 14), merchant: 'ZARA USA', amount: -45 }); }
    if (m === '2026-08') usRows.push({ date: day(m, 9), merchant: 'BEST BUY 00001234', amount: 329.99 });
    await importRows(store, usRows.map(r => ({ ...r, date: r.date })), { source: `Chase ${m}`, card: 'Chase Sapphire' });
    const converted = ilRows.map(r => ({ ...r, originalAmount: r.amount, originalCurrency: 'ILS', fxRate: 3.35, amount: Math.round(r.amount / 3.35 * 100) / 100 }));
    await importRows(store, converted, { source: `Isracard ${m}`, card: 'Isracard' });
  }
  // A trip to Thailand in August: baht purchases, then the trip itself
  const TH = [
    ['GRAB* RIDE BANGKOK', 60, 180, 'Travel & Transport'], ['7-ELEVEN 12045 SUKHUMVIT', 45, 210, 'Groceries'], ['SOMTUM DER SILOM', 320, 640, 'Dining & Restaurants'],
    ['AGODA HOTEL BKK', 1800, 3200, 'Travel & Transport'], ['BIG C SUPERCENTER', 400, 900, 'Groceries'], ['THAI SMILE CAFE', 90, 240, 'Dining & Restaurants'],
    ['JIM THOMPSON STORE', 900, 2400, 'Shopping'], ['BTS SKYTRAIN', 44, 120, 'Travel & Transport'], ['ANGTHONG SEA TOUR', 1500, 2500, 'Entertainment'],
  ];
  const thRows = [];
  for (const [name, min, max, category] of TH) for (let i = 0; i < 2; i++) thRows.push({ date: day('2026-08', 3 + Math.floor(rand() * 11)), merchant: name, amount: between(min, max), category });
  await importRows(store, thRows.map(r => ({ date: r.date, merchant: r.merchant, originalAmount: r.amount, originalCurrency: 'THB', fxRate: 33.2, amount: Math.round(r.amount / 33.2 * 100) / 100 })), { source: 'Chase 2026-08', card: 'Chase Sapphire' });
  store.update('transactions', list => { for (const t of list) { const spec = TH.find(x => x[0] === t.rawSource); if (spec && !t.category) { t.category = spec[3]; t.categorySource = 'auto'; } } });
  require('../src/server/trips').createTrip(store, { name: 'Thailand', start: '2026-08-03', end: '2026-08-14' });

  // A couple of bank-synced rows, one pending, and something unrecognizable
  store.update('transactions', list => {
    list.push(
      { id: 'p1', date: '2026-09-22', merchant: 'Sweetgreen', rawSource: 'SWEETGREEN NYC', amount: 14.5, category: 'Dining & Restaurants', card: 'Capital One ••3333', source: 'Capital One ••3333', importedAt: new Date().toISOString(), plaidId: 'x1', plaidAccountId: 'acc', pending: true },
      { id: 'p2', date: '2026-09-21', merchant: 'Madison Bicycle Shop', rawSource: 'MADISON BICYCLE SHOP', amount: 78, category: null, card: 'Capital One ••3333', source: 'Capital One ••3333', importedAt: new Date().toISOString(), plaidId: 'x2', plaidAccountId: 'acc' },
      { id: 'p3', date: '2026-09-19', merchant: 'Tectra', rawSource: 'TECTRA INC', amount: 500, category: null, card: 'Capital One ••3333', source: 'Capital One ••3333', importedAt: new Date().toISOString(), plaidId: 'x3', plaidAccountId: 'acc' },
      { id: 'p4', date: '2026-09-20', merchant: 'Sweetgreen', rawSource: 'SWEETGREEN NYC', amount: 14.5, category: 'Dining & Restaurants', card: 'Capital One ••3333', source: 'Capital One ••3333', importedAt: new Date().toISOString(), plaidId: 'x4', plaidAccountId: 'acc' },
    );
  });
  const t = store.read('transactions');
  console.log(`seeded ${t.length} transactions, ${t.filter(x => !x.category).length} uncategorized, ${Object.keys(store.read('merchants')).length} merchants remembered`);
})();
