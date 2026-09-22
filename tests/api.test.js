'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/server');

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-api-'));
  const srv = await start({ dataDir: path.join(dir, 'data'), uploadsDir: path.join(dir, 'uploads'), port: 0, log: { error() {} } });
  const api = async (method, p, body, raw) => {
    const res = await fetch(srv.url + p, {
      method,
      headers: raw ? {} : { 'Content-Type': 'application/json' },
      body: raw ? body : body && JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { api, srv, close: async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('validation, 404s and malformed JSON come back as JSON errors', async () => {
  const { api, close } = await boot();
  try {
    assert.equal((await api('GET', '/api/version')).data.version, require('../package.json').version);
    assert.equal((await api('GET', '/api/nothing')).status, 404);
    assert.equal((await api('POST', '/api/transactions', {})).status, 400);
    assert.equal((await api('POST', '/api/transactions', { date: '2026-13-01', merchant: 'x', amount: 1 })).status, 400);
    const bad = await fetch((await api('GET', '/api/version')) && '', { method: 'GET' }).catch(() => null); // no-op
    const malformed = await api('POST', '/api/transactions', '{oops', true);
    assert.equal(malformed.status, 400);
  } finally { await close(); }
});

test('transaction lifecycle keeps system fields untouched', async () => {
  const { api, close } = await boot();
  try {
    const { data: t } = await api('POST', '/api/transactions', { date: '2026-09-20', merchant: 'Blue Bottle', amount: '6.50', category: 'Dining & Restaurants' });
    assert.equal(t.amount, 6.5);
    assert.equal(t.source, 'Manual');
    const { data: u } = await api('PUT', `/api/transactions/${t.id}`, { notes: 'hi', id: 'evil', plaidId: 'hack', source: 'nope' });
    assert.equal(u.id, t.id);
    assert.equal(u.source, 'Manual');
    assert.equal(u.plaidId, undefined);
    assert.equal(u.notes, 'hi');
    assert.equal((await api('PUT', `/api/transactions/${t.id}`, { merchant: '' })).status, 400);
    assert.equal((await api('GET', '/api/merchants')).data['Blue Bottle'], 'Dining & Restaurants');
    assert.equal((await api('DELETE', `/api/transactions/${t.id}`)).status, 200);
    assert.equal((await api('DELETE', `/api/transactions/${t.id}`)).status, 404);
  } finally { await close(); }
});

test('CSV upload streams progress and imports once', async () => {
  const { api, srv, close } = await boot();
  try {
    const csv = 'Transaction Date,Description,Category,Type,Amount\n09/15/2026,STARBUCKS #1,Food & Drink,Sale,-4.50\n09/16/2026,Payment Thank You,,Payment,500.00\n';
    const upload = async () => {
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv' }), 'sept.csv');
      form.append('cardName', 'Chase');
      const { uploadId } = await (await fetch(`${srv.url}/api/upload/start`, { method: 'POST', body: form })).json();
      const text = await (await fetch(`${srv.url}/api/upload/stream/${uploadId}`)).text();
      const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));
      return events[events.length - 1];
    };
    const first = await upload();
    assert.equal(first.done, true);
    assert.equal(first.result.imported, 1);
    const second = await upload();
    assert.equal(second.result.imported, 0);
    assert.equal(second.result.duplicates, 1);
    const { data: txns } = await api('GET', '/api/transactions');
    assert.equal(txns.length, 1);
    assert.equal(txns[0].card, 'Chase');
    assert.equal(txns[0].category, 'Dining & Restaurants');
    assert.equal((await api('POST', '/api/upload/start', 'x', true)).status, 400);
  } finally { await close(); }
});

test('prefs and budgets round-trip', async () => {
  const { api, close } = await boot();
  try {
    await api('PUT', '/api/prefs', { dismissedAnomalies: ['a'] });
    assert.deepEqual((await api('GET', '/api/settings')).data.prefs, { dismissedAnomalies: ['a'] });
    assert.equal((await api('POST', '/api/budgets', { budgets: { Groceries: '400' } })).status, 200);
    assert.deepEqual((await api('GET', '/api/settings')).data.budgets, { Groceries: 400 });
    assert.equal((await api('POST', '/api/income/2026-13', { label: 'x', amount: 1 })).status, 400);
    const { data: inc } = await api('POST', '/api/income/2026-09', { label: 'Salary', amount: 5000, recurring: true });
    assert.equal((await api('GET', '/api/income/2026-10')).data.length, 1);
    await api('PUT', `/api/income/2026-09/${inc.id}`, { recurring: false });
    assert.equal((await api('GET', '/api/income/2026-10')).data.length, 0);
  } finally { await close(); }
});

test('shekel purchases keep the original amount and compute dollars from the rate', async () => {
  const { api, srv, close } = await boot();
  try {
    // a fixed manual rate makes the test deterministic and offline
    assert.equal((await api('POST', '/api/settings/currency', { ilsRate: 4 })).status, 200);
    const { data: t } = await api('POST', '/api/transactions', { date: '2026-09-20', merchant: 'Cofix', originalAmount: 120, originalCurrency: 'ILS' });
    assert.equal(t.amount, 30);
    assert.equal(t.originalAmount, 120);
    assert.equal(t.originalCurrency, 'ILS');
    assert.equal(t.fxRate, 4);
    // editing the shekel amount recomputes the dollars
    const { data: u } = await api('PUT', `/api/transactions/${t.id}`, { originalAmount: 200, originalCurrency: 'ILS' });
    assert.equal(u.amount, 50);
    // switching back to dollars drops the shekel fields
    const { data: v } = await api('PUT', `/api/transactions/${t.id}`, { originalCurrency: 'USD', amount: 12 });
    assert.equal(v.amount, 12);
    assert.equal(v.originalAmount, undefined);
    assert.equal((await api('GET', '/api/settings')).data.currency.ilsRate, 4);
    assert.equal((await api('GET', '/api/fx/ils')).data.rate, 4);

    // an ILS statement converts every row
    const csv = 'Date,Description,Amount\n2026-09-15,SHUFERSAL DEAL,-200.00\n2026-09-16,COFIX,-40.00\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'isracard.csv');
    form.append('currency', 'ILS');
    const { uploadId } = await (await fetch(`${srv.url}/api/upload/start`, { method: 'POST', body: form })).json();
    const text = await (await fetch(`${srv.url}/api/upload/stream/${uploadId}`)).text();
    const last = JSON.parse(text.split('\n').filter(l => l.startsWith('data:')).pop().slice(5));
    assert.equal(last.result.imported, 2);
    const { data: txns } = await api('GET', '/api/transactions');
    const shuf = txns.find(x => x.merchant === 'Shufersal Deal');
    assert.equal(shuf.amount, 50);
    assert.equal(shuf.originalAmount, 200);
    assert.equal(shuf.category, 'Groceries');
  } finally { await close(); }
});
