'use strict';
const crypto = require('crypto');
const express = require('express');
const { str, num, isoDate, bad, route } = require('../validate');
const { anomalies, spendingInsights } = require('../insights');
const { refundCandidates, autoMatchRefunds, linkRefund } = require('../refunds');
const { redirectMap, resolve } = require('../categoryConfig');

const RECURRING = '_recurring';
// Income and fixed expenses entered on the Budget page for a month
function budgetFor(store, month) {
  const sum = name => { const all = store.read(name); return [...(all[RECURRING] || []), ...(all[month] || [])].reduce((s, e) => s + (e.amount || 0), 0); };
  const income = store.read('income');
  const hasIncome = Boolean((income[RECURRING] || []).length || (income[month] || []).length);
  return { income: sum('income'), fixed: sum('expenses'), hasIncome };
}

// Free-form labels: trimmed, deduplicated regardless of case, a handful at most
function tagList(value) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw bad('tags must be a list');
  const out = [];
  for (const v of value) {
    const s = str(v, { field: 'tag', max: 40 });
    if (s && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, 12);
}

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
  if (has('tags')) out.tags = tagList(body.tags);
  // Flags are stored only when set, so untouched rows stay small
  if (has('excluded')) out.excluded = body.excluded ? true : null;
  if (has('reimbursable')) out.reimbursable = body.reimbursable ? true : null;
  if (has('reimbursedAt')) out.reimbursedAt = body.reimbursedAt === null || body.reimbursedAt === false ? null : isoDate(body.reimbursedAt === true ? new Date().toISOString() : body.reimbursedAt, { field: 'reimbursedAt' });
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
    for (const k of ['card', 'notes', 'originalAmount', 'originalCurrency', 'fxRate', 'excluded', 'reimbursable', 'reimbursedAt']) if (txn[k] === undefined || txn[k] === null || txn[k] === '') delete txn[k];
    if (!txn.tags?.length) delete txn.tags;
    if (txn.category) txn.category = resolve(redirectMap(store), txn.category);
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
        if (v === undefined || v === '' || v === null || (Array.isArray(v) && !v.length)) delete txn[k]; else txn[k] = v;
      }
      if (fields.category === null) txn.category = null;
      if (fields.reimbursable === null) delete txn.reimbursedAt;
      if ('category' in fields) { if (txn.category) txn.categorySource = 'user'; else delete txn.categorySource; }
      updated = txn;
    });
    res.json(updated);
  }));

  // ---- Refunds ----
  router.get('/transactions/:id/refund-candidates', (req, res) => {
    const all = store.read('transactions');
    const refund = all.find(t => t.id === req.params.id);
    if (!refund) return res.status(404).json({ error: 'Not found' });
    const taken = new Set(all.filter(t => t.refundOf && t.id !== refund.id).map(t => t.refundOf));
    res.json({ candidates: refundCandidates(refund, all).map(c => ({ ...c, alsoRefunded: taken.has(c.id) })) });
  });

  // Link a refund to the purchase it reverses (purchaseId null unlinks)
  router.post('/transactions/:id/refund-of', route((req, res) => {
    const purchaseId = req.body.purchaseId ?? null;
    let updated = null;
    store.update('transactions', list => {
      const refund = list.find(t => t.id === req.params.id);
      if (!refund) throw Object.assign(new Error('Not found'), { status: 404 });
      if (purchaseId === null) { delete refund.refundOf; updated = refund; return; }
      if (!(refund.amount < 0)) throw bad('Only a refund (a credit) can be linked to a purchase');
      const purchase = list.find(t => t.id === purchaseId);
      if (!purchase || !(purchase.amount > 0)) throw bad('Pick a purchase to link this refund to');
      if (Math.abs(refund.amount) > purchase.amount + 0.005) throw bad('The refund is larger than that purchase');
      linkRefund(refund, purchase);
      updated = refund;
    });
    res.json(updated);
  }));

  router.post('/cleanup/refunds', (_req, res) => {
    let matched = 0;
    store.update('transactions', list => { matched = autoMatchRefunds(list); });
    res.json({ matched });
  });

  router.delete('/transactions/:id', (req, res) => {
    let found = false;
    store.update('transactions', list => {
      const next = list.filter(t => t.id !== req.params.id);
      found = next.length !== list.length;
      for (const t of next) if (t.refundOf === req.params.id) delete t.refundOf;
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

  // One round trip for the dashboard's async widgets so the page paints whole
  router.get('/dashboard', (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : '';
    const txns = store.read('transactions');
    res.json({ anomalies: anomalies(txns, month), insights: spendingInsights(txns, month), plaid: plaid.status(), budget: month ? budgetFor(store, month) : null });
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
