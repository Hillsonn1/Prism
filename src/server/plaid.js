'use strict';
// Bank sync through Plaid, built for a local app: the user's own client ID and
// secret live in settings, linked Items (access tokens, accounts, cursors) in
// plaid.json, banks are linked through Plaid's Hosted Link page in the system
// browser, and instead of webhooks the server polls /transactions/sync on
// launch, on a timer, and on demand.

const crypto = require('crypto');
const express = require('express');
const { isPayment, isCardCredit, mapPlaidCategory, LOW_CONFIDENCE } = require('./categories');
const { localCategory, dedupKeys, aiPass, applyRedirects } = require('./importer');
const { autoMatchRefunds } = require('./refunds');

const HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const COUNTRY_CODES = ['US'];
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_DAYS = 90;          // history pulled when a bank is first linked
const LINK_LIFETIME_S = 60 * 60;  // how long a Hosted Link page stays valid
const LIABILITIES_TTL_MS = 6 * 3600 * 1000; // Plaid refreshes liabilities about daily

function getConfig(store, secrets = null) {
  const p = store.read('settings').plaid || {};
  if (!p.clientId || !p.secret) return null;
  return { clientId: p.clientId, secret: secrets ? secrets.open(p.secret) : p.secret, env: p.env === 'production' ? 'production' : 'sandbox' };
}

// What the UI is allowed to see — never the access token
function publicItem(item) {
  const { accessToken, ...rest } = item;
  return rest;
}

// Payments, transfers and income aren't spending. Refunds stay in as negative
// amounts, the same way statement imports treat credits.
function isSpend(p, account) {
  const primary = p.personal_finance_category?.primary || '';
  const detailed = p.personal_finance_category?.detailed || '';
  if (primary === 'TRANSFER_IN' || primary === 'TRANSFER_OUT' || primary === 'INCOME') return false;
  if (detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return false;
  // On a credit card, a "loan payment" is the card itself being paid off
  if (primary === 'LOAN_PAYMENTS' && account.type === 'credit') return false;
  // Name checks only for money coming in: a payment never posts as a charge,
  // and this keeps merchants like "Payment Processing Inc" out of the net
  if (p.amount >= 0) return true;
  if ([p.name, p.merchant_name].filter(Boolean).some(isPayment)) return false;
  return !isCardCredit(p.name, p.amount, detailed || primary);
}

// Plaid's cleaned-up merchant name, unless it looks like a mismatch (it once
// turned "RAV KAV ONLINE" into a clothing brand): keep it only when it shares
// a word with the bank's own descriptor.
function merchantLabel(p) {
  const rawName = p.name || '';
  const enriched = p.merchant_name || '';
  if (!enriched) return rawName || 'Unknown';
  if (!rawName) return enriched;
  const words = enriched.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 3);
  const rawKey = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return words.some(w => rawKey.includes(w)) ? enriched : rawName;
}

// Plaid's merchant logo, only when its merchant name was trusted (see merchantLabel)
function logoFor(p) {
  if (!p.merchant_name || merchantLabel(p) !== p.merchant_name) return undefined;
  return p.logo_url || (p.counterparties || []).find(c => c.type === 'merchant' && c.logo_url)?.logo_url || undefined;
}
// Where the card was used, when the bank says
function locationFor(p) {
  const l = p.location;
  if (!l || (!l.city && !l.country)) return undefined;
  return { ...(l.city ? { city: l.city } : {}), ...(l.country ? { country: l.country } : {}) };
}

// Purchase date rather than posting date, so a charge keeps its date when it settles
const txnDate = p => (p.authorized_date || p.date || '').slice(0, 10);
const txnAmount = p => Math.round(p.amount * 100) / 100;

// Talks to Plaid over HTTPS; tests pass their own implementation
async function httpRequest(cfg, endpoint, body) {
  // PRISM_PLAID_HOST points the client at a local mock for development
  const host = process.env.PRISM_PLAID_HOST || HOSTS[cfg.env];
  const res = await fetch(host + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PLAID-CLIENT-ID': cfg.clientId, 'PLAID-SECRET': cfg.secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_message || `Plaid request failed (${res.status})`);
    err.plaidCode = data.error_code;
    err.status = 502;
    throw err;
  }
  return data;
}

function createPlaid({ store, openExternal = null, log = console, request = httpRequest, secrets = { seal: v => v, open: v => v, available: false } }) {
  const token = item => secrets.open(item.accessToken);
  const state = { syncing: false, lastSyncAt: null, lastResult: null, lastChange: null, changeCounter: 0 };

  // Items belong to the environment they were linked in; a Sandbox connection
  // can't sync with Production keys, so it's set aside rather than failing.
  function itemsForCurrentEnv() {
    const cfg = getConfig(store);
    const data = store.read('plaid');
    let changed = false;
    for (const item of data.items) {
      if (!item.env && cfg) { item.env = cfg.env; changed = true; } // linked before environments were recorded
    }
    if (changed) store.write('plaid', data);
    return { data, active: cfg ? data.items.filter(i => i.env === cfg.env) : [] };
  }
  const pendingLinks = new Map(); // link_token → { itemId, expiresAt, result }
  let syncPromise = null;
  const timers = [];

  async function post(endpoint, body) {
    const cfg = getConfig(store, secrets);
    if (!cfg) {
      const err = new Error("Plaid isn't set up yet — add your client ID and secret in Settings.");
      err.status = 400;
      throw err;
    }
    return request(cfg, endpoint, body);
  }

  // Apply one Item's /transactions/sync result to the transaction store.
  async function applyUpdates(item, { added, modified, removed }) {
    const result = { added: 0, updated: 0, removed: 0, skipped: 0 };
    const accounts = Object.fromEntries(item.accounts.map(a => [a.accountId, a]));
    const merchants = store.read('merchants');

    // Phase 1: decide what's new, against a snapshot (AI calls below take a while)
    const snapshot = store.read('transactions');
    const knownIds = new Set(snapshot.filter(t => t.plaidId).map(t => t.plaidId));
    const existing = dedupKeys(snapshot);
    const fresh = [];
    const rekeys = [];          // pending charges that have now posted
    const unknown = new Map();  // raw name → normalized name

    for (const p of added) {
      const account = accounts[p.account_id];
      if (!account || !account.enabled || knownIds.has(p.transaction_id)) continue;
      if (p.pending_transaction_id && knownIds.has(p.pending_transaction_id)) { rekeys.push(p); continue; }
      if (!isSpend(p, account)) { result.skipped++; continue; }

      const amount = txnAmount(p);
      const date = txnDate(p);
      const raw = merchantLabel(p);
      // No user in the loop during a background sync: apply any plausible guess
      const guess = localCategory(raw, merchants, mapPlaidCategory(p.personal_finance_category));
      const name = guess.name;
      const category = guess.confidence >= LOW_CONFIDENCE ? guess.category : null;
      const learned = Boolean(category) && guess.learned;
      const keyRaw = `${date}|${p.name}|${amount}`;
      const keyNorm = `${date}|${name}|${amount}`;
      // Already imported from a statement for the same card
      if (existing.has(keyRaw) || existing.has(keyNorm)) { result.skipped++; continue; }
      existing.add(keyRaw);
      existing.add(keyNorm);
      if (learned) merchants[name] = category;
      if (!category) unknown.set(raw, name);

      fresh.push({
        id: crypto.randomUUID(),
        date,
        merchant: name,
        _raw: raw,
        rawSource: p.name || raw,
        amount,
        category,
        ...(category ? { categorySource: 'auto' } : {}),
        card: account.card || undefined,
        source: account.source,
        importedAt: new Date().toISOString(),
        plaidId: p.transaction_id,
        plaidAccountId: p.account_id,
        plaidCategory: p.personal_finance_category?.detailed || undefined,
        logoUrl: logoFor(p),
        location: locationFor(p),
        ...(p.pending ? { pending: true } : {}),
      });
    }

    const apiKey = store.read('settings').anthropicApiKey || null;
    if (unknown.size && apiKey) await aiPass(unknown, fresh, merchants, apiKey);
    for (const t of fresh) { delete t._raw; if (!t.logoUrl) delete t.logoUrl; if (!t.location) delete t.location; }
    applyRedirects(store, fresh, merchants);
    autoMatchRefunds([...store.read('transactions'), ...fresh]);

    // Phase 2: apply against the live store, so edits made meanwhile survive
    const transactions = store.read('transactions');
    const byPlaidId = new Map(transactions.filter(t => t.plaidId).map(t => [t.plaidId, t]));
    for (const p of rekeys) {
      const row = byPlaidId.get(p.pending_transaction_id);
      if (!row || byPlaidId.has(p.transaction_id)) continue; // user deleted it, or already re-keyed
      Object.assign(row, { plaidId: p.transaction_id, amount: txnAmount(p), date: txnDate(p) });
      delete row.pending;
      byPlaidId.delete(p.pending_transaction_id);
      byPlaidId.set(p.transaction_id, row);
      result.updated++;
    }
    for (const p of modified) {
      const row = byPlaidId.get(p.transaction_id);
      if (!row) continue;
      row.amount = txnAmount(p);
      row.date = txnDate(p);
      if (p.pending) row.pending = true; else delete row.pending;
      const logo = logoFor(p), loc = locationFor(p);
      if (logo) row.logoUrl = logo;
      if (loc) row.location = loc;
      result.updated++;
    }
    const removedIds = new Set(removed.map(r => r.transaction_id));
    const next = transactions.filter(t => !(t.plaidId && removedIds.has(t.plaidId)));
    result.removed = transactions.length - next.length;
    const toAdd = fresh.filter(t => !byPlaidId.has(t.plaidId));
    next.push(...toAdd);
    result.added = toAdd.length;

    store.write('transactions', next);
    store.write('merchants', merchants);
    return result;
  }

  async function syncItem(item) {
    const startCursor = item.cursor || undefined;
    for (let attempt = 1; ; attempt++) {
      let cursor = startCursor;
      let status = null;
      const updates = { added: [], modified: [], removed: [] };
      try {
        for (;;) {
          const body = { access_token: token(item), count: 500, options: { include_personal_finance_category: true } };
          if (cursor) body.cursor = cursor;
          const page = await post('/transactions/sync', body);
          updates.added.push(...(page.added || []));
          updates.modified.push(...(page.modified || []));
          updates.removed.push(...(page.removed || []));
          status = page.transactions_update_status || status;
          cursor = page.next_cursor;
          if (!page.has_more) break;
        }
      } catch (err) {
        // Plaid changed the data mid-pagination: start the whole update over
        if (err.plaidCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 3) continue;
        throw err;
      }
      const result = await applyUpdates(item, updates);
      item.cursor = cursor;
      item.updateStatus = status;
      item.lastSyncAt = new Date().toISOString();
      item.lastError = null;
      return result;
    }
  }

  // Rows synced before logos and locations were kept: read the Item's history
  // again from the start and fill those fields in. Nothing is added or removed.
  async function enrichItem(item) {
    const byId = new Map();
    let cursor;
    for (;;) {
      const body = { access_token: token(item), count: 500, options: { include_personal_finance_category: true } };
      if (cursor) body.cursor = cursor;
      const page = await post('/transactions/sync', body);
      for (const p of page.added || []) byId.set(p.transaction_id, p);
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    let filled = 0;
    store.update('transactions', list => {
      for (const t of list) {
        const p = t.plaidId && byId.get(t.plaidId);
        if (!p) continue;
        const logo = logoFor(p), loc = locationFor(p);
        let touched = false;
        if (logo && !t.logoUrl) { t.logoUrl = logo; touched = true; }
        if (loc && !t.location) { t.location = loc; touched = true; }
        if (!t.plaidCategory && p.personal_finance_category?.detailed) { t.plaidCategory = p.personal_finance_category.detailed; touched = true; }
        if (touched) filled++;
      }
    });
    item.enrichedAt = new Date().toISOString();
    return filled;
  }

  // Statement balance, due date and minimum payment for each credit card.
  // Never fails the sync: banks that don't support it just show nothing.
  async function refreshLiabilities(item, { force = false } = {}) {
    if (!force && item.liabilitiesAt && Date.now() - Date.parse(item.liabilitiesAt) < LIABILITIES_TTL_MS) return;
    let data;
    try {
      data = await post('/liabilities/get', { access_token: token(item) });
    } catch (err) {
      item.liabilitiesError = err.plaidCode || 'ERROR';
      item.liabilitiesAt = new Date().toISOString();
      return;
    }
    const balances = Object.fromEntries((data.accounts || []).map(a => [a.account_id, a.balances || {}]));
    const credit = Object.fromEntries((data.liabilities?.credit || []).map(c => [c.account_id, c]));
    for (const account of item.accounts) {
      const b = balances[account.accountId];
      if (b) account.balance = { current: b.current ?? null, available: b.available ?? null, limit: b.limit ?? null };
      const c = credit[account.accountId];
      if (!c) continue;
      account.liability = {
        nextPaymentDueDate: c.next_payment_due_date || null,
        minimumPaymentAmount: c.minimum_payment_amount ?? null,
        lastStatementBalance: c.last_statement_balance ?? null,
        lastStatementIssueDate: c.last_statement_issue_date || null,
        lastPaymentAmount: c.last_payment_amount ?? null,
        lastPaymentDate: c.last_payment_date || null,
        isOverdue: Boolean(c.is_overdue),
        apr: (c.aprs || []).find(a => a.apr_type === 'purchase_apr')?.apr_percentage ?? null,
      };
    }
    item.liabilitiesError = null;
    item.liabilitiesAt = new Date().toISOString();
  }

  // One sync at a time; concurrent callers share the in-flight run.
  function syncItems(itemId = null) {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const totals = { added: 0, updated: 0, removed: 0, skipped: 0, errors: 0 };
      const { data, active } = itemsForCurrentEnv();
      const items = active.filter(i => !itemId || i.itemId === itemId);
      if (!items.length) return totals;
      state.syncing = true;
      try {
        for (const item of items) {
          try {
            const syncedBefore = Boolean(item.cursor);
            const r = await syncItem(item);
            for (const k of Object.keys(r)) totals[k] += r[k];
            await refreshLiabilities(item, { force: itemId !== null });
            if (!item.enrichedAt) { // one-time backfill for rows synced before logos and locations were kept
              if (syncedBefore) {
                const filled = await enrichItem(item);
                if (filled) totals.updated += filled;
              } else item.enrichedAt = new Date().toISOString();
            }
          } catch (err) {
            item.lastError = { code: err.plaidCode || 'ERROR', message: err.message, at: new Date().toISOString() };
            totals.errors++;
            log.error(`Plaid sync failed for ${item.institutionName}:`, err.message);
          }
        }
        store.write('plaid', data);
        state.lastSyncAt = new Date().toISOString();
        state.lastResult = totals;
        if (totals.added || totals.updated || totals.removed) {
          state.lastChange = { ...totals, at: state.lastSyncAt };
          state.changeCounter++;
        }
      } finally {
        state.syncing = false;
      }
      return totals;
    })().finally(() => { syncPromise = null; });
    return syncPromise;
  }

  const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); timers.push(t); };

  // Plaid's first pull for a new Item lands a little after linking; check a few times.
  function scheduleFollowUps() {
    for (const ms of [8000, 45000, 3 * 60 * 1000]) later(() => syncItems().catch(() => {}), ms);
  }

  function startScheduler() {
    later(() => syncItems().catch(() => {}), 5000);
    const t = setInterval(() => syncItems().catch(() => {}), SYNC_INTERVAL_MS);
    t.unref();
    timers.push(t);
  }

  function stop() {
    for (const t of timers) clearTimeout(t);
  }

  // One look at a Hosted Link session: a result once it's over, null while it's open
  async function checkLink(token, pending) {
    const data = await post('/link/token/get', { link_token: token });
    let publicToken = null;
    let finished = false;
    let exited = false;
    for (const s of data.link_sessions || []) {
      publicToken = s.results?.item_add_results?.[0]?.public_token || s.on_success?.public_token || null;
      if (publicToken) break;
      if (s.finished_at) { finished = true; if (s.on_exit) exited = true; }
    }
    const plaidData = store.read('plaid');

    if (pending.itemId) {
      // Update mode: no new token, a finished session means credentials were refreshed
      const item = plaidData.items.find(i => i.itemId === pending.itemId);
      if (item && (publicToken || (finished && !exited))) {
        item.lastError = null;
        store.write('plaid', plaidData);
        scheduleFollowUps();
        return { status: 'linked', item: publicItem(item) };
      }
    } else if (publicToken) {
      const ex = await post('/item/public_token/exchange', { public_token: publicToken });
      const acc = await post('/accounts/get', { access_token: ex.access_token });
      const institutionId = acc.item?.institution_id || null;
      let institutionName = acc.item?.institution_name;
      if (!institutionName && institutionId) {
        try {
          const inst = await post('/institutions/get_by_id', { institution_id: institutionId, country_codes: COUNTRY_CODES });
          institutionName = inst.institution?.name;
        } catch {}
      }
      institutionName = institutionName || 'Bank';
      const item = {
        itemId: ex.item_id,
        accessToken: secrets.seal(ex.access_token),
        env: getConfig(store).env,
        institutionId,
        institutionName,
        addedAt: new Date().toISOString(),
        cursor: null,
        updateStatus: null,
        lastSyncAt: null,
        lastError: null,
        accounts: (acc.accounts || []).map(a => {
          const label = `${institutionName} ••${a.mask || a.name}`;
          return {
            accountId: a.account_id,
            name: a.official_name || a.name,
            mask: a.mask || '',
            type: a.type,
            subtype: a.subtype,
            enabled: a.type === 'credit' || a.type === 'depository',
            source: label,
            card: label,
          };
        }),
      };
      plaidData.items.push(item);
      store.write('plaid', plaidData);
      syncItems().catch(() => {});
      scheduleFollowUps();
      return { status: 'linked', item: publicItem(item) };
    }

    if (exited) return { status: 'exited' };
    return null;
  }

  // The server watches each Hosted Link session itself, so the link completes
  // even if the user wanders off the Settings page before finishing.
  function watchLink(token) {
    const tick = async () => {
      const pending = pendingLinks.get(token);
      if (!pending || pending.result) return;
      try {
        const result = await checkLink(token, pending);
        if (result) { pending.result = result; return; }
      } catch (err) {
        log.error('Plaid link check failed:', err.message); // transient; keep watching until expiry
      }
      if (Date.now() > pending.expiresAt) { pending.result = { status: 'expired' }; return; }
      later(tick, 3000);
    };
    later(tick, 3000);
  }

  const error = (res, err) => res.status(err.status || 500).json({ error: err.message, code: err.plaidCode });

  const router = express.Router();

  // Everything the UI shows about bank sync (also folded into /api/dashboard)
  function status() {
    const settings = store.read('settings');
    const cfg = getConfig(store);
    return {
      configured: Boolean(cfg),
      env: cfg ? cfg.env : (settings.plaid?.env || 'sandbox'),
      clientId: settings.plaid?.clientId || '',
      syncing: state.syncing,
      lastSyncAt: state.lastSyncAt,
      lastResult: state.lastResult,
      lastChange: state.lastChange,
      changeCounter: state.changeCounter,
      syncIntervalMinutes: SYNC_INTERVAL_MS / 60000,
      items: itemsForCurrentEnv().data.items.map(publicItem),
    };
  }

  router.get('/status', (_req, res) => res.json(status()));

  router.post('/settings', async (req, res) => {
    const clientId = String(req.body.clientId || '').trim();
    const env = req.body.env === 'production' ? 'production' : 'sandbox';
    const settings = store.read('settings');
    const secret = String(req.body.secret || '').trim() || (settings.plaid?.secret ? secrets.open(settings.plaid.secret) : '');
    if (!clientId) return res.status(400).json({ error: 'Client ID is required' });
    if (!secret) return res.status(400).json({ error: 'Secret is required' });
    settings.plaid = { ...(settings.plaid || {}), clientId, secret: secrets.seal(secret), env };
    store.write('settings', settings);

    // Cheap call to confirm the keys match the chosen environment
    let verified = false;
    try {
      await post('/institutions/get', { count: 1, offset: 0, country_codes: COUNTRY_CODES });
      verified = true;
    } catch (err) {
      if (err.plaidCode === 'INVALID_API_KEYS') {
        delete settings.plaid.secret;
        store.write('settings', settings);
        return res.status(400).json({ error: `Plaid rejected these keys for ${env}. Check the client ID, the secret, and that the secret belongs to the ${env} environment.` });
      }
    }
    res.json({ success: true, verified });
  });

  router.post('/link/start', async (req, res) => {
    const settings = store.read('settings');
    if (!getConfig(store)) return res.status(400).json({ error: "Plaid isn't set up yet — add your client ID and secret first." });
    if (!settings.plaid.userId) {
      settings.plaid.userId = crypto.randomUUID();
      store.write('settings', settings);
    }
    const body = {
      client_name: 'Prism',
      language: 'en',
      country_codes: COUNTRY_CODES,
      user: { client_user_id: settings.plaid.userId },
      hosted_link: { url_lifetime_seconds: LINK_LIFETIME_S },
    };
    const itemId = req.body.itemId || null;
    if (itemId) {
      // Update mode: refresh credentials on an existing Item
      const item = store.read('plaid').items.find(i => i.itemId === itemId);
      if (!item) return res.status(404).json({ error: 'Unknown bank connection' });
      body.access_token = token(item);
    } else {
      body.products = ['transactions'];
      body.optional_products = ['liabilities']; // statement balance and due date, where the bank supports it
      body.transactions = { days_requested: HISTORY_DAYS };
    }
    try {
      const data = await post('/link/token/create', body);
      for (const [token, p] of pendingLinks) if (Date.now() > p.expiresAt + 3600000) pendingLinks.delete(token);
      const expiresAt = Date.parse(data.expiration) || Date.now() + LINK_LIFETIME_S * 1000;
      pendingLinks.set(data.link_token, { itemId, expiresAt, result: null });
      watchLink(data.link_token);
      let opened = false;
      if (openExternal) { try { opened = openExternal(data.hosted_link_url) !== false; } catch { opened = false; } }
      res.json({ linkToken: data.link_token, url: data.hosted_link_url, expiration: data.expiration, opened });
    } catch (err) {
      error(res, err);
    }
  });

  router.get('/link/status/:token', (req, res) => {
    const pending = pendingLinks.get(req.params.token);
    if (!pending) return res.status(404).json({ error: 'Unknown link session' });
    res.json(pending.result || { status: 'pending' });
  });

  router.post('/sync', async (req, res) => {
    if (!getConfig(store)) return res.status(400).json({ error: "Plaid isn't set up yet." });
    try {
      const totals = await syncItems(req.body.itemId || null);
      res.json({ ...totals, changeCounter: state.changeCounter });
    } catch (err) {
      error(res, err);
    }
  });

  // Pull logos and locations again for everything from this bank
  router.post('/items/:itemId/enrich', async (req, res) => {
    const { data, active } = itemsForCurrentEnv();
    const item = active.find(i => i.itemId === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Unknown bank connection' });
    try {
      const filled = await enrichItem(item);
      store.write('plaid', data);
      if (filled) state.changeCounter++;
      res.json({ filled });
    } catch (err) { error(res, err); }
  });

  router.put('/items/:itemId/accounts/:accountId', (req, res) => {
    const data = store.read('plaid');
    const item = data.items.find(i => i.itemId === req.params.itemId);
    const account = item && item.accounts.find(a => a.accountId === req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Unknown account' });
    if (typeof req.body.enabled === 'boolean') account.enabled = req.body.enabled;
    if (typeof req.body.card === 'string') {
      const card = req.body.card.trim().slice(0, 60);
      store.update('transactions', transactions => {
        for (const t of transactions) {
          if (t.plaidAccountId === account.accountId) { if (card) t.card = card; else delete t.card; }
        }
      });
      account.card = card;
    }
    store.write('plaid', data);
    res.json({ success: true, account });
  });

  router.delete('/items/:itemId', async (req, res) => {
    const data = store.read('plaid');
    const idx = data.items.findIndex(i => i.itemId === req.params.itemId);
    if (idx === -1) return res.status(404).json({ error: 'Unknown bank connection' });
    const item = data.items[idx];
    try {
      await post('/item/remove', { access_token: token(item) });
    } catch (err) {
      log.error('Plaid item/remove failed:', err.message); // still drop it locally
    }
    data.items.splice(idx, 1);
    store.write('plaid', data);

    let removedTransactions = 0;
    if (req.query.deleteTransactions === '1') {
      const ids = new Set(item.accounts.map(a => a.accountId));
      store.update('transactions', transactions => {
        const next = transactions.filter(t => !ids.has(t.plaidAccountId));
        removedTransactions = transactions.length - next.length;
        return next;
      });
    }
    state.changeCounter++;
    res.json({ success: true, removedTransactions });
  });

  // Keep account mappings in step when the user renames a card or a source
  function renameCard(oldName, newName) {
    store.update('plaid', data => {
      for (const item of data.items) for (const a of item.accounts) if (a.card === oldName) a.card = newName;
    });
  }
  function renameSource(oldName, newName, card) {
    store.update('plaid', data => {
      for (const item of data.items) for (const a of item.accounts) {
        if (a.source === oldName) { a.source = newName; a.card = card; }
      }
    });
  }

  return { router, syncItems, startScheduler, stop, state, status, renameCard, renameSource };
}

module.exports = { createPlaid, getConfig, isSpend, merchantLabel, txnDate, txnAmount, SYNC_INTERVAL_MS };
