'use strict';
const express = require('express');
const { getConfig: plaidConfig } = require('../plaid');
const { str, num, route } = require('../validate');
const { anomalies, spendingInsights } = require('../insights');
const { categoryFromDescription } = require('../categories');
const ai = require('../ai');

const SITE_URL = 'https://prismspendtracker.netlify.app';
const UPDATE_URL = `${SITE_URL}/version.json`;

function semverGt(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

module.exports = function settingsRoutes({ store, version, apiKey, fx, dataDir, openFolder = null, secrets }) {
  const router = express.Router();

  router.get('/version', (_req, res) => res.json({ version }));

  router.get('/about', (_req, res) => {
    res.json({
      version,
      dataDir,
      encrypted: secrets.available,
      transactions: store.read('transactions').length,
      backups: store.backups('transactions').length,
      canOpen: Boolean(openFolder),
    });
  });

  router.post('/about/open-data-folder', (_req, res) => {
    if (!openFolder) return res.json({ opened: false, path: dataDir });
    try { openFolder(dataDir); res.json({ opened: true }); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Latest released version, from the download site (cached for a few hours)
  let updateCache = { at: 0, data: null };
  router.get('/update', async (_req, res) => {
    if (Date.now() - updateCache.at < 6 * 3600 * 1000 && updateCache.data) return res.json(updateCache.data);
    try {
      const r = await fetch(UPDATE_URL, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
      const remote = await r.json();
      const latest = String(remote.version || '');
      const data = { current: version, latest, siteUrl: remote.siteUrl || SITE_URL, updateAvailable: Boolean(latest) && semverGt(latest, version) };
      updateCache = { at: Date.now(), data };
      res.json(data);
    } catch {
      res.json({ current: version, latest: null, siteUrl: SITE_URL, updateAvailable: false });
    }
  });

  // Never exposes the keys themselves
  router.get('/settings', (_req, res) => {
    const s = store.read('settings');
    res.json({
      hasApiKey: Boolean(s.anthropicApiKey),
      plaidConfigured: Boolean(plaidConfig(store)),
      budgets: s.budgets || {},
      monthlyBudget: s.monthlyBudget || 0,
      location: s.location || '',
      prefs: s.prefs || {},
      currency: { ilsRate: s.currency?.ilsRate || 'auto', latest: fx.latestCached() },
    });
  });

  // ILS per USD: a number to fix the rate, or 'auto' for the daily ECB rate
  router.post('/settings/currency', route((req, res) => {
    const raw = req.body.ilsRate;
    const ilsRate = raw === 'auto' || raw === '' || raw === null || raw === undefined ? 'auto' : num(raw, { field: 'ilsRate', min: 0.5, max: 20 });
    store.update('settings', s => { s.currency = { ...(s.currency || {}), ilsRate }; });
    res.json({ success: true, ilsRate });
  }));

  router.get('/fx/ils', route(async (req, res) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    res.json(await fx.rate(date));
  }));

  router.post('/settings', route((req, res) => {
    const key = str(req.body.anthropicApiKey, { field: 'anthropicApiKey', max: 300, required: true });
    store.update('settings', s => { s.anthropicApiKey = secrets.seal(key); });
    res.json({ success: true });
  }));

  router.delete('/settings/api-key', (_req, res) => {
    store.update('settings', s => { delete s.anthropicApiKey; });
    res.json({ success: true });
  });

  router.post('/location', route((req, res) => {
    if (typeof req.body.location !== 'string') return res.status(400).json({ error: 'location string required' });
    const location = str(req.body.location, { max: 120 }) || '';
    store.update('settings', s => { s.location = location; });
    res.json({ success: true });
  }));

  // Small UI preferences (dismissed alerts, theme) kept with the data rather
  // than in the browser, which the desktop app recreates on a new port
  router.put('/prefs', route((req, res) => {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'object required' });
    const prefs = store.update('settings', s => {
      s.prefs = { ...(s.prefs || {}), ...req.body };
      if (JSON.stringify(s.prefs).length > 20000) throw Object.assign(new Error('prefs too large'), { status: 400 });
    }).prefs;
    res.json(prefs);
  }));

  router.get('/anomalies', (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : '';
    res.json({ anomalies: anomalies(store.read('transactions'), month) });
  });

  // Local, instant observations for the dashboard
  router.get('/insights/local', (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : '';
    res.json({ insights: spendingInsights(store.read('transactions'), month) });
  });

  // ---- AI-assisted helpers ----
  router.post('/text-to-category', route(async (req, res) => {
    const text = str(req.body.text, { max: 200 });
    if (!text) return res.status(400).json({ error: 'text required' });
    const local = categoryFromDescription(text);
    if (local) return res.json({ category: local, source: 'local' });
    const key = apiKey();
    if (!key) return res.json({ category: null });
    try {
      res.json({ category: await ai.textToCategory(text, str(req.body.merchant, { max: 120 }) || null, key), source: 'ai' });
    } catch {
      res.json({ category: null }); // fail quietly so typing in the modal never breaks
    }
  }));

  router.post('/identify-merchant', route(async (req, res) => {
    const merchant = str(req.body.merchant, { field: 'merchant', max: 200, required: true });
    const key = apiKey();
    if (!key) return res.status(400).json({ error: 'No API key configured — add one in Settings.' });
    const result = await ai.identifyMerchant({
      merchant,
      rawMerchant: str(req.body.rawMerchant, { max: 200 }),
      location: store.read('settings').location,
    }, key);
    res.json(result);
  }));

  router.post('/insights', route(async (req, res) => {
    const key = apiKey();
    if (!key) return res.status(400).json({ error: 'No API key configured — add one in Settings.' });
    const month = typeof req.body.month === 'string' && /^\d{4}-\d{2}$/.test(req.body.month) ? req.body.month : '';
    const all = store.read('transactions');
    const txns = month ? all.filter(t => t.date?.startsWith(month)) : all;
    if (!txns.length) return res.json({ summary: null });

    const total = txns.reduce((s, t) => s + t.amount, 0);
    const catTotals = {};
    for (const t of txns) { const c = t.category || 'Uncategorized'; catTotals[c] = (catTotals[c] || 0) + t.amount; }
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([cat, amt]) => `${cat}: $${amt.toFixed(0)}`).join(', ');
    const topTxn = [...txns].sort((a, b) => b.amount - a.amount)[0];

    let priorContext = '';
    let periodLabel = 'all time';
    if (month) {
      const [yr, mo] = month.split('-').map(Number);
      periodLabel = new Date(yr, mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
      const pd = new Date(yr, mo - 2, 1);
      const prior = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`;
      const priorTxns = all.filter(t => t.date?.startsWith(prior));
      if (priorTxns.length) {
        const priorTotal = priorTxns.reduce((s, t) => s + t.amount, 0);
        const pct = ((total - priorTotal) / priorTotal * 100).toFixed(0);
        priorContext = ` (${pct > 0 ? `up ${pct}%` : `down ${Math.abs(pct)}%`} vs ${pd.toLocaleString('default', { month: 'long' })})`;
      }
    }
    const summary = await ai.spendingInsight({ periodLabel, total, priorContext, count: txns.length, topCats, topTxn }, key);
    res.json({ summary });
  }));

  return router;
};
