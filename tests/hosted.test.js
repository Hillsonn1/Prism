'use strict';
// The hosted (website) version: accounts, sessions, and one data folder per user.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/server');
const { createSecrets } = require('../src/server/secrets');

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-hosted-'));
  const srv = await start({ dataDir: path.join(dir, 'data'), uploadsDir: path.join(dir, 'uploads'), port: 0, log: { error() {} }, hosted: true, secret: 'test-secret-that-is-long-enough', secureCookies: false });
  // A tiny client that keeps its cookie jar
  const client = () => {
    let cookie = '';
    const call = async (method, p, body, { redirect = 'manual' } = {}) => {
      const res = await fetch(srv.url + p, { method, redirect, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      return { status: res.status, data, text, location: res.headers.get('location') };
    };
    return { call, get cookie() { return cookie; } };
  };
  return { srv, dir, client, close: async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('accounts: sign up, sign in, sign out, and the app is gated', async () => {
  const { client, close } = await boot();
  try {
    const anon = client();
    assert.equal((await anon.call('GET', '/api/transactions')).status, 401);
    const home = await anon.call('GET', '/');
    assert.equal(home.status, 302);
    assert.equal(home.location, '/login');
    assert.equal((await anon.call('GET', '/login')).status, 200);
    assert.equal((await anon.call('GET', '/style.css')).status, 200, 'assets are public');

    const a = client();
    assert.equal((await a.call('POST', '/api/auth/signup', { email: 'bad', password: 'password1' })).status, 400);
    assert.equal((await a.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'short' })).status, 400);
    const signup = await a.call('POST', '/api/auth/signup', { email: 'A@Example.com', password: 'password1', name: 'Ava' });
    assert.equal(signup.status, 200);
    assert.equal(signup.data.user.email, 'a@example.com');
    assert.ok(a.cookie.startsWith('prism_session='));
    assert.equal((await a.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password1' })).status, 400, 'no duplicates');
    assert.equal((await a.call('GET', '/api/auth/me')).data.user.name, 'Ava');
    assert.equal((await a.call('GET', '/')).status, 200, 'signed in users get the app');

    const b = client();
    assert.equal((await b.call('POST', '/api/auth/login', { email: 'a@example.com', password: 'nope' })).status, 401);
    assert.equal((await b.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'password1' })).status, 401);
    assert.equal((await b.call('POST', '/api/auth/login', { email: 'a@example.com', password: 'password1' })).status, 200);

    assert.equal((await b.call('POST', '/api/auth/password', { current: 'wrong', next: 'password2' })).status, 401);
    assert.equal((await b.call('POST', '/api/auth/password', { current: 'password1', next: 'password2' })).status, 200);
    await b.call('POST', '/api/auth/logout');
    assert.equal((await b.call('GET', '/api/transactions')).status, 401);
    assert.equal((await b.call('POST', '/api/auth/login', { email: 'a@example.com', password: 'password2' })).status, 200);
  } finally { await close(); }
});

test('each user has their own data; keys are sealed with the server secret', async () => {
  const { client, dir, close } = await boot();
  try {
    const a = client(), b = client();
    const ua = (await a.call('POST', '/api/auth/signup', { email: 'a@x.com', password: 'password1' })).data.user;
    await b.call('POST', '/api/auth/signup', { email: 'b@x.com', password: 'password1' });
    await a.call('POST', '/api/transactions', { date: '2026-09-10', merchant: 'Supersal', amount: 84.5, category: 'Groceries' });
    await b.call('POST', '/api/transactions', { date: '2026-09-11', merchant: 'Wolt', amount: 22 });
    assert.deepEqual((await a.call('GET', '/api/transactions')).data.map(t => t.merchant), ['Supersal']);
    assert.deepEqual((await b.call('GET', '/api/transactions')).data.map(t => t.merchant), ['Wolt']);
    assert.equal((await a.call('GET', '/api/dashboard?month=2026-09')).data.insights.length > 0, true);
    assert.equal((await b.call('GET', '/api/plaid/status')).data.items.length, 0);
    assert.equal((await a.call('GET', '/api/settings')).data.hosted, true);

    await a.call('POST', '/api/settings', { anthropicApiKey: 'sk-ant-test-123' });
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'users', ua.id, 'data', 'settings.json'), 'utf8'));
    assert.ok(settings.anthropicApiKey.startsWith('enc2:'), 'sealed, not plaintext');
    assert.equal((await a.call('GET', '/api/settings')).data.hasApiKey, true);
    assert.equal((await b.call('GET', '/api/settings')).data.hasApiKey, false);

    const about = (await a.call('GET', '/api/about')).data;
    assert.equal(about.hosted, true);
    assert.equal(about.dataDir, null);
    assert.equal(about.encrypted, true);
  } finally { await close(); }
});

test('software-sealed secrets round-trip and reject a different secret', () => {
  const one = createSecrets(null, { softwareKey: 'secret-one-long-enough' });
  const sealed = one.seal('sk-ant-hello');
  assert.ok(sealed.startsWith('enc2:'));
  assert.equal(one.open(sealed), 'sk-ant-hello');
  assert.equal(one.seal(sealed), sealed, 'never sealed twice');
  const other = createSecrets(null, { softwareKey: 'secret-two-long-enough' });
  assert.throws(() => other.open(sealed));
  const none = createSecrets(null);
  assert.equal(none.seal('plain'), 'plain');
  assert.throws(() => none.open(sealed), /PRISM_SECRET/);
});
