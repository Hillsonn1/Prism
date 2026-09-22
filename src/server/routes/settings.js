'use strict';
const express = require('express');
const { getConfig: plaidConfig } = require('../plaid');
const { str, route } = require('../validate');
const { anomalies } = require('../insights');
const ai = require('../ai');

module.exports = function settingsRoutes({ store, version, apiKey }) {
  const router = express.Router();

  router.get('/version', (_req, res) => res.json({ version }));

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
    });
  });

  router.post('/settings', route((req, res) => {
    const key = str(req.body.anthropicApiKey, { field: 'anthropicApiKey', max: 300, required: true });
    store.update('settings', s => { s.anthropicApiKey = key; });
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

  // ---- AI-assisted helpers ----
  router.post('/text-to-category', route(async (req, res) => {
    const text = str(req.body.text, { max: 200 });
    if (!text) return res.status(400).json({ error: 'text required' });
    const key = apiKey();
    if (!key) return res.json({ category: null });
    try {
      res.json({ category: await ai.textToCategory(text, str(req.body.merchant, { max: 120 }) || null, key) });
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
