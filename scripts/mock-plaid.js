// Mock of the Plaid endpoints Prism uses, for developing bank sync without
// real keys. Run it, then start the server pointed at it:
//
//   node scripts/mock-plaid.js
//   PRISM_PLAID_HOST=http://localhost:3999 npm start
//
// Save keys "mock-client" / "mock-secret" in Settings, click Connect a bank,
// press "Finish linking" on the page that opens. POST /mock/stage {"stage":1}
// makes the next sync post the pending Starbucks charge and correct Amazon.
const http = require('http');
const PORT = 3999;
const state = { finished: false, stage: 0, calls: [] };
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const pfc = (primary, detailed) => ({ primary, detailed, confidence_level: 'VERY_HIGH' });
const T = (id, account_id, name, merchant_name, amount, d, cat, extra = {}) =>
  ({ transaction_id: id, account_id, name, merchant_name, amount, date: d, authorized_date: d, pending: false, personal_finance_category: cat, iso_currency_code: 'USD', ...extra });

const ACCOUNTS = [
  { account_id: 'acc-card', name: 'Sapphire', official_name: 'Chase Sapphire Preferred', mask: '1234', type: 'credit', subtype: 'credit card' },
  { account_id: 'acc-chk', name: 'Checking', official_name: 'Total Checking', mask: '5678', type: 'depository', subtype: 'checking' },
  { account_id: 'acc-sav', name: 'Savings', official_name: 'Savings', mask: '9999', type: 'depository', subtype: 'savings' },
];
const PAGE1 = [
  T('txn-wf', 'acc-card', 'WHOLEFDS MKT 10234', 'Whole Foods', 84.12, day(3), pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')),
  T('txn-amazon', 'acc-card', 'AMZN Mktp US*2K3', 'Amazon', 32.99, day(5), pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES')),
  T('txn-pay', 'acc-card', 'Payment Thank You-Mobile', null, -500, day(6), pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')),
];
const PAGE2 = [
  T('txn-sbux-pending', 'acc-card', 'STARBUCKS STORE 08812', 'Starbucks', 5.5, day(1), pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'), { pending: true }),
  T('txn-payroll', 'acc-chk', 'ACME CORP PAYROLL', 'Acme Corp', -2400, day(2), pfc('INCOME', 'INCOME_WAGES')),
  T('txn-uber', 'acc-chk', 'UBER *TRIP HELP.UBER.COM', 'Uber', 18.4, day(2), pfc('TRANSPORTATION', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')),
  T('txn-sav', 'acc-sav', 'INTEREST PAYMENT', null, -1.02, day(4), pfc('INCOME', 'INCOME_INTEREST_EARNED')),
  T('txn-mystery', 'acc-card', 'SQ *BLUE DOOR 44', 'Blue Door', 41, day(2), pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES')),
];
// stage 1: Starbucks posts (amount changes), Amazon amount corrected
const STAGE1 = {
  added: [T('txn-sbux-posted', 'acc-card', 'STARBUCKS STORE 08812', 'Starbucks', 5.75, day(1), pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE'), { pending_transaction_id: 'txn-sbux-pending' })],
  modified: [T('txn-amazon', 'acc-card', 'AMZN Mktp US*2K3', 'Amazon', 35.99, day(5), pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES'))],
  removed: [{ transaction_id: 'txn-sbux-pending', account_id: 'acc-card' }],
};

function sync(cursor) {
  const empty = { added: [], modified: [], removed: [] };
  if (!cursor) return { ...empty, added: PAGE1, next_cursor: 'c1', has_more: true, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' };
  if (cursor === 'c1') return { ...empty, added: PAGE2, next_cursor: 'c2', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' };
  if (cursor === 'c2' && state.stage >= 1) return { ...STAGE1, next_cursor: 'c3', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' };
  return { ...empty, next_cursor: cursor, has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' };
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = req.url.split('?')[0];
    if (!url.startsWith('/mock') && !url.startsWith('/hosted')) {
      state.calls.push(url);
      if (req.headers['plaid-client-id'] !== 'mock-client' || req.headers['plaid-secret'] !== 'mock-secret')
        return json(400, { error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS', error_message: 'invalid client_id or secret provided' });
    }
    switch (url) {
      case '/institutions/get': return json(200, { institutions: [{ name: 'Mock Bank' }], total: 1 });
      case '/link/token/create':
        return json(200, { link_token: 'link-mock-token', expiration: new Date(Date.now() + 3600000).toISOString(), hosted_link_url: `http://localhost:${PORT}/hosted/link-mock-token` });
      case '/link/token/get':
        return json(200, { link_token: body.link_token, link_sessions: state.finished
          ? [{ link_session_id: 'ls-1', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), results: { item_add_results: [{ public_token: 'public-mock', item_id: 'item-mock' }] } }]
          : [] });
      case '/item/public_token/exchange': return json(200, { access_token: 'access-mock', item_id: 'item-mock' });
      case '/accounts/get': return json(200, { accounts: ACCOUNTS, item: { item_id: 'item-mock', institution_id: 'ins_mock', institution_name: 'Mock Bank' } });
      case '/institutions/get_by_id': return json(200, { institution: { name: 'Mock Bank' } });
      case '/transactions/sync':
        if (body.access_token !== 'access-mock') return json(400, { error_code: 'INVALID_ACCESS_TOKEN', error_message: 'bad token' });
        return json(200, { accounts: ACCOUNTS, ...sync(body.cursor) });
      case '/item/remove': return json(200, { removed: true });
      case '/liabilities/get': {
        const soon = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
        return json(200, {
          accounts: ACCOUNTS.map(a => ({ ...a, balances: { current: a.type === 'credit' ? 1266.77 : 4210.5, available: a.type === 'credit' ? 8733.23 : 4210.5, limit: a.type === 'credit' ? 10000 : null } })),
          liabilities: { credit: [{
            account_id: 'acc-card', is_overdue: false, last_payment_amount: 980.12, last_payment_date: day(28),
            last_statement_issue_date: day(3), last_statement_balance: 1266.77, minimum_payment_amount: 40,
            next_payment_due_date: soon, aprs: [{ apr_percentage: 24.99, apr_type: 'purchase_apr' }],
          }] },
        });
      }
      case '/hosted/link-mock-token':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<h1>Mock Plaid Link</h1><form method="POST" action="/mock/finish"><button>Finish linking</button></form>');
      case '/mock/finish': state.finished = true; return json(200, { ok: true });
      case '/mock/stage': state.stage = body.stage; return json(200, { stage: state.stage });
      case '/mock/calls': return json(200, state.calls);
      default: return json(404, { error_code: 'NOT_FOUND', error_message: `no mock for ${url}` });
    }
  });
}).listen(PORT, () => console.log(`mock plaid on ${PORT}`));
