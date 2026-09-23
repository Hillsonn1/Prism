'use strict';
// Everything that needs the API key beyond the importer's own pass: the
// assistant, vision imports of receipts, merchant intelligence, the category
// review, "explain this charge", and the usage tally.
const express = require('express');
const { str, route } = require('../validate');

function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return data => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

module.exports = function aiRoutes({ store, claude, assistant, intel, hygiene, fx }) {
  const router = express.Router();

  router.get('/ai/status', (_req, res) => res.json({
    available: claude.available(),
    model: claude.model('assistant'),
    usage: claude.usageThisMonth(),
    merchantIntel: store.read('settings').prefs?.merchantIntel !== false,
    known: Object.keys(store.read('merchantInfo')).length,
  }));

  // ---- Ask Prism (streams) ----
  router.post('/ask', async (req, res) => {
    const question = str(req.body.question, { field: 'question', max: 2000 });
    if (!question) return res.status(400).json({ error: 'Ask something first' });
    if (!claude.available()) return res.status(400).json({ error: 'Add an Anthropic API key in Settings to ask Prism' });
    const send = sse(res);
    const alive = () => !res.destroyed && !res.writableEnded; // the user may close the panel mid-answer
    try {
      await assistant.ask({ conversationId: req.body.conversationId, question }, data => { if (alive()) send(data); });
    } catch (err) {
      if (alive()) send({ type: 'error', message: err.message || 'Something went wrong' });
    }
    res.end();
  });

  router.post('/ask/apply', route((req, res) => {
    res.json(assistant.applyProposal(String(req.body.proposalId || '')));
  }));

  router.post('/ask/reset', (req, res) => { assistant.reset(String(req.body.conversationId || '')); res.json({ ok: true }); });

  // ---- Explain this charge ----
  router.post('/explain/:id', route(async (req, res) => {
    const txn = store.read('transactions').find(t => t.id === req.params.id);
    if (!txn) return res.status(404).json({ error: 'Not found' });
    const stats = intel.stats(txn.merchant);
    const known = store.read('merchantInfo')[txn.merchant] || null;
    const info = req.body.lookup === false ? known : await intel.explain(txn.merchant, { force: Boolean(req.body.force) });
    res.json({ info, stats });
  }));

  // ---- Merchant intelligence ----
  router.get('/merchants/intel', (_req, res) => res.json(store.read('merchantInfo')));
  router.get('/merchants/intel/run', async (_req, res) => {
    const send = sse(res);
    try {
      if (!claude.available()) throw new Error('Add an Anthropic API key in Settings first');
      const r = await intel.enrich({ limit: 60, onProgress: (frac, message) => send({ progress: Math.round(frac * 90), message }) });
      send({ progress: 100, done: true, result: r });
    } catch (err) { send({ progress: 0, error: true, message: err.message }); }
    res.end();
  });

  // ---- Category review ----
  router.get('/cleanup/review/run', async (_req, res) => {
    const send = sse(res);
    try {
      if (!claude.available()) throw new Error('Add an Anthropic API key in Settings first');
      const r = await hygiene.review({ onProgress: (frac, message) => send({ progress: Math.round(frac * 95), message }) });
      send({ progress: 100, done: true, result: r });
    } catch (err) { send({ progress: 0, error: true, message: err.message }); }
    res.end();
  });
  router.post('/cleanup/review/apply', route((req, res) => {
    const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
    res.json(hygiene.apply(changes.map(c => ({ merchant: str(c.merchant, { max: 120 }), category: str(c.category, { max: 60 }) }))));
  }));

  // ---- A receipt read by vision becomes one purchase, or one per category ----
  router.post('/upload/receipt', route(async (req, res) => {
    const r = req.body.receipt || {};
    const merchant = str(r.merchant, { field: 'merchant', max: 120, required: true });
    const date = str(r.date, { field: 'date', max: 10, required: true });
    const currency = /^[A-Za-z]{3}$/.test(String(r.currency || '')) ? String(r.currency).toUpperCase() : 'USD';
    const card = str(req.body.card, { max: 60 }) || undefined;
    const split = Boolean(req.body.split);
    const items = Array.isArray(r.items) ? r.items.filter(i => i && Number(i.amount)) : [];
    const total = Number(r.total) || items.reduce((s, i) => s + Number(i.amount), 0);
    const parts = split && items.length > 1
      ? Object.entries(items.reduce((acc, i) => { const k = i.category || 'Other'; acc[k] = (acc[k] || 0) + Number(i.amount); return acc; }, {})).map(([category, amount]) => ({ category, amount, note: items.filter(i => (i.category || 'Other') === category).map(i => i.label).join(', ').slice(0, 200) }))
      : [{ category: items[0]?.category || null, amount: total, note: '' }];
    const crypto = require('crypto');
    const existing = store.read('transactions');
    const created = [];
    for (const part of parts) {
      const conv = currency !== 'USD' ? await fx.toUSD(Math.round(part.amount * 100) / 100, date, currency) : { amount: Math.round(part.amount * 100) / 100 };
      const dup = existing.some(t => t.date === date && t.merchant === merchant && Math.abs(t.amount - conv.amount) < 0.005);
      if (dup) continue;
      created.push({
        id: crypto.randomUUID(), date, merchant, rawSource: merchant, amount: conv.amount,
        ...(currency !== 'USD' ? { originalAmount: conv.originalAmount, originalCurrency: currency, fxRate: conv.fxRate } : {}),
        category: part.category || null, ...(part.category ? { categorySource: 'auto' } : {}),
        ...(card ? { card } : {}), ...(part.note && split ? { notes: part.note } : {}),
        source: 'Receipt', importedAt: new Date().toISOString(), manual: true,
      });
    }
    store.update('transactions', list => { list.push(...created); });
    res.json({ created: created.length, skipped: parts.length - created.length, transactions: created });
  }));

  return router;
};
