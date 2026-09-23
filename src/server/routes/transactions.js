'use strict';
const crypto = require('crypto');
const express = require('express');
const { str, num, isoDate, bad, route } = require('../validate');

// Fields a client may set on a transaction; everything else is system-managed
function transactionFields(body, { partial = false } = {}) {
  const out = {};
  const has = k => body[k] !== undefined;
  const shekels = body.originalCurrency === 'ILS';
  // merchant, date and amount can be changed but never blanked; a shekel
  // entry may omit the dollar amount, which is then computed from the rate
  if (!partial || has('merchant')) out.merchant = str(body.merchant, { field: 'merchant', max: 120, required: true });
  if (!partial || has('date')) out.date = isoDate(body.date, { field: 'date', required: true });
  if (!partial || has('amount')) out.amount = num(body.amount, { field: 'amount', required: !shekels });
  if (has('category')) out.category = body.category === null ? null : str(body.category, { field: 'category', max: 60 }) || null;
  if (has('card')) out.card = str(body.card, { field: 'card', max: 60 });
  if (has('notes')) out.notes = str(body.notes, { field: 'notes', max: 500 });
  if (has('originalCurrency') || has('originalAmount')) {
    const cur = body.originalCurrency === 'ILS' ? 'ILS' : null;
    out.originalCurrency = cur;
    out.originalAmount = cur ? num(body.originalAmount, { field: 'originalAmount', required: true }) : undefined;
  }
  return out;
}

// A shekel purchase without a dollar amount gets one from the day's rate
async function fillFromShekels(txn, fields, fx) {
  if (fields.originalCurrency === 'ILS' && fields.amount === undefined) {
    const conv = await fx.toUSD(fields.originalAmount, fields.date || txn.date);
    fields.amount = conv.amount;
    fields.fxRate = conv.fxRate;
  }
  if (fields.originalCurrency === null) { fields.originalAmount = undefined; fields.fxRate = undefined; }
}

module.exports = function transactionsRoutes({ store, plaid, fx }) {
  const router = express.Router();

  router.get('/transactions', (_req, res) => res.json(store.read('transactions')));

  router.post('/transactions', route(async (req, res) => {
    const fields = transactionFields(req.body);
    await fillFromShekels({}, fields, fx);
    const txn = {
      id: crypto.randomUUID(),
      ...fields,
      category: fields.category || null,
      source: 'Manual',
      importedAt: new Date().toISOString(),
      manual: true,
    };
    for (const k of ['card', 'notes', 'originalAmount', 'originalCurrency', 'fxRate']) if (txn[k] === undefined || txn[k] === null || txn[k] === '') delete txn[k];
    store.update('transactions', list => { list.push(txn); });
    if (txn.category) { txn.categorySource = 'user'; store.update('merchants', m => { m[txn.merchant] = txn.category; }); }
    res.json(txn);
  }));

  router.put('/transactions/:id', route(async (req, res) => {
    const fields = transactionFields(req.body, { partial: true });
    const existing = store.read('transactions').find(t => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await fillFromShekels(existing, fields, fx);
    let updated = null;
    store.update('transactions', list => {
      const txn = list.find(t => t.id === req.params.id);
      if (!txn) return;
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === '' || v === null) delete txn[k]; else txn[k] = v;
      }
      if (fields.category === null) txn.category = null;
      if ('category' in fields) { if (txn.category) txn.categorySource = 'user'; else delete txn.categorySource; }
      updated = txn;
    });
    res.json(updated);
  }));

  router.delete('/transactions/:id', (req, res) => {
    let found = false;
    store.update('transactions', list => {
      const next = list.filter(t => t.id !== req.params.id);
      found = next.length !== list.length;
      return next;
    });
    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  // Delete by source or merchant; with neither, everything
  router.delete('/transactions', (req, res) => {
    const { source, merchant } = req.query;
    store.update('transactions', list => {
      if (source) return list.filter(t => t.source !== source);
      if (merchant) return list.filter(t => t.merchant !== merchant);
      return [];
    });
    res.json({ success: true });
  });

  router.get('/summary', (_req, res) => {
    const summary = {};
    let grandTotal = 0;
    for (const t of store.read('transactions')) {
      const cat = t.category || 'Uncategorized';
      if (!summary[cat]) summary[cat] = { total: 0, count: 0 };
      summary[cat].total += t.amount;
      summary[cat].count++;
      grandTotal += t.amount;
    }
    const categories = Object.entries(summary)
      .map(([category, d]) => ({ category, total: +d.total.toFixed(2), count: d.count }))
      .sort((a, b) => b.total - a.total);
    res.json({ categories, grandTotal: +grandTotal.toFixed(2) });
  });

  router.get('/sources', (_req, res) => {
    const sources = [...new Set(store.read('transactions').map(t => t.source))].filter(Boolean);
    res.json(sources);
  });

  // Rename a statement and/or assign a card to all its transactions
  router.post('/sources/update', route((req, res) => {
    const oldName = str(req.body.oldName, { field: 'oldName', max: 120, required: true });
    const newName = str(req.body.newName, { field: 'newName', max: 120, required: true });
    const card = str(req.body.card, { field: 'card', max: 60 }) || '';
    store.update('transactions', list => {
      for (const t of list) {
        if (t.source !== oldName) continue;
        t.source = newName;
        if (card) t.card = card; else delete t.card;
      }
    });
    plaid.renameSource(oldName, newName, card);
    res.json({ success: true });
  }));

  router.post('/cards/rename', route((req, res) => {
    const oldName = str(req.body.oldName, { field: 'oldName', max: 60, required: true });
    const newName = str(req.body.newName, { field: 'newName', max: 60, required: true });
    let updated = 0;
    store.update('transactions', list => {
      for (const t of list) if (t.card === oldName) { t.card = newName; updated++; }
    });
    plaid.renameCard(oldName, newName);
    res.json({ success: true, updated });
  }));

  // ---- Merchant memory ----
  router.get('/merchants', (_req, res) => res.json(store.read('merchants')));

  // Remember a merchant's category. Fills in that merchant's uncategorized
  // rows; with applyToAll, every row of the merchant follows.
  router.post('/merchants', route((req, res) => {
    const merchant = str(req.body.merchant, { field: 'merchant', max: 120, required: true });
    const category = str(req.body.category, { field: 'category', max: 60, required: true });
    const applyToAll = Boolean(req.body.applyToAll);
    store.update('merchants', m => { m[merchant] = category; });
    let updated = 0;
    store.update('transactions', list => {
      for (const t of list) {
        if (t.merchant !== merchant || (t.category && !applyToAll)) continue;
        if (t.category !== category) updated++;
        t.category = category;
        t.categorySource = 'user';
      }
    });
    res.json({ success: true, updated });
  }));

  router.post('/merchants/bulk', route((req, res) => {
    if (!Array.isArray(req.body.mappings)) throw bad('mappings array required');
    const mappings = req.body.mappings
      .map(m => ({ merchant: str(m.merchant, { max: 120 }), category: str(m.category, { max: 60 }) }))
      .filter(m => m.merchant && m.category);
    store.update('merchants', mem => { for (const { merchant, category } of mappings) mem[merchant] = category; });
    store.update('transactions', list => {
      const byMerchant = new Map(mappings.map(m => [m.merchant, m.category]));
      for (const t of list) if (!t.category && byMerchant.has(t.merchant)) { t.category = byMerchant.get(t.merchant); t.categorySource = 'user'; }
    });
    res.json({ success: true });
  }));

  router.post('/merchants/rename', route((req, res) => {
    const oldName = str(req.body.oldName, { field: 'oldName', max: 120, required: true });
    const newName = str(req.body.newName, { field: 'newName', max: 120, required: true });
    let updated = 0;
    store.update('transactions', list => {
      for (const t of list) if (t.merchant === oldName) { t.merchant = newName; updated++; }
    });
    store.update('merchants', m => {
      if (m[oldName] !== undefined && !m[newName]) m[newName] = m[oldName];
      delete m[oldName];
    });
    res.json({ success: true, updated });
  }));

  router.delete('/merchants/:merchant', (req, res) => {
    store.update('merchants', m => { delete m[req.params.merchant]; });
    res.json({ success: true });
  });

  return router;
};
