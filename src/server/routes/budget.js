'use strict';
// Budget page data: income and fixed expenses per month (with items that
// repeat every month stored under '_recurring'), per-category limits, the
// monthly spend target, and budget suggestions.
const crypto = require('crypto');
const express = require('express');
const ai = require('../ai');
const { str, num, month, bad, route } = require('../validate');

const RECURRING = '_recurring';

// Income and fixed expenses have the same shape and behaviour
function ledgerRoutes(router, store, name, base) {
  router.get(`${base}/:month`, route((req, res) => {
    const all = store.read(name);
    const m = month(req.params.month);
    const recurring = (all[RECURRING] || []).map(e => ({ ...e, recurring: true }));
    const monthly = (all[m] || []).map(e => ({ ...e, recurring: false }));
    res.json([...recurring, ...monthly]);
  }));

  router.post(`${base}/:month`, route((req, res) => {
    const m = month(req.params.month);
    const entry = {
      id: crypto.randomUUID(),
      label: str(req.body.label, { field: 'label', max: 80, required: true }),
      amount: num(req.body.amount, { field: 'amount', required: true, min: 0 }),
    };
    const key = req.body.recurring ? RECURRING : m;
    store.update(name, all => { (all[key] = all[key] || []).push(entry); });
    res.json({ ...entry, recurring: key === RECURRING });
  }));

  router.put(`${base}/:month/:id`, route((req, res) => {
    const m = month(req.params.month);
    const { id } = req.params;
    const label = str(req.body.label, { field: 'label', max: 80 });
    const amount = num(req.body.amount, { field: 'amount', min: 0 });
    let result = null;
    store.update(name, all => {
      for (const key of [RECURRING, m]) {
        const entries = all[key] || [];
        const idx = entries.findIndex(e => e.id === id);
        if (idx === -1) continue;
        const wasRecurring = key === RECURRING;
        const nowRecurring = req.body.recurring !== undefined ? Boolean(req.body.recurring) : wasRecurring;
        const updated = { ...entries[idx], ...(label !== undefined && { label }), ...(amount !== undefined && { amount }) };
        if (nowRecurring !== wasRecurring) {
          all[key] = entries.filter(e => e.id !== id);
          const newKey = nowRecurring ? RECURRING : m;
          (all[newKey] = all[newKey] || []).push(updated);
        } else {
          entries[idx] = updated;
        }
        result = { ...updated, recurring: nowRecurring };
        return;
      }
    });
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  }));

  router.delete(`${base}/:month/:id`, route((req, res) => {
    const m = month(req.params.month);
    let found = false;
    store.update(name, all => {
      for (const key of [RECURRING, m]) {
        const before = (all[key] || []).length;
        all[key] = (all[key] || []).filter(e => e.id !== req.params.id);
        if (all[key].length < before) { found = true; return; }
      }
    });
    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  }));
}

// Average monthly spend per category over every month with data
function categoryHistory(transactions) {
  const relevant = transactions.filter(t => t.category && t.category !== 'Unknown' && t.date);
  const byMonth = {};
  const months = new Set();
  for (const t of relevant) {
    const m = t.date.slice(0, 7);
    months.add(m);
    const totals = byMonth[t.category] || (byMonth[t.category] = {});
    totals[m] = (totals[m] || 0) + t.amount;
  }
  const summary = {};
  for (const [cat, totals] of Object.entries(byMonth)) {
    const values = Object.values(totals);
    summary[cat] = {
      avg: +(values.reduce((s, a) => s + a, 0) / months.size).toFixed(0),
      max: +Math.max(...values).toFixed(0),
      months: values.length,
    };
  }
  return { summary, numMonths: months.size };
}

// Average plus a 10% buffer, rounded up to $25
function simpleSuggestions(summary) {
  const out = {};
  for (const [cat, { avg }] of Object.entries(summary)) out[cat] = Math.ceil((avg * 1.1) / 25) * 25;
  return out;
}

module.exports = function budgetRoutes({ store, apiKey }) {
  const router = express.Router();
  ledgerRoutes(router, store, 'income', '/income');
  ledgerRoutes(router, store, 'expenses', '/expenses');

  router.post('/budget/monthly', route((req, res) => {
    const amount = num(req.body.amount, { field: 'amount', required: true, min: 0 });
    store.update('settings', s => { s.monthlyBudget = amount; });
    res.json({ success: true });
  }));

  router.post('/budgets', route((req, res) => {
    const { budgets } = req.body;
    if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) throw bad('budgets object required');
    const clean = {};
    for (const [cat, val] of Object.entries(budgets)) {
      const n = num(val, { field: cat, min: 0 });
      if (n) clean[str(cat, { max: 60 })] = n;
    }
    store.update('settings', s => { s.budgets = clean; });
    res.json({ success: true });
  }));

  router.post('/budgets/suggest', route(async (_req, res) => {
    const { summary, numMonths } = categoryHistory(store.read('transactions'));
    if (!Object.keys(summary).length) return res.json({ suggestions: {} });
    const key = apiKey();
    if (key) {
      try {
        return res.json({ suggestions: await ai.suggestBudgets(summary, numMonths, key), aiUsed: true });
      } catch (err) {
        console.error('AI budget suggestions failed:', err.message);
      }
    }
    res.json({ suggestions: simpleSuggestions(summary), aiUsed: false });
  }));

  router.post('/budget/insights', route(async (req, res) => {
    const key = apiKey();
    if (!key) return res.json({ insight: null, noKey: true });
    const { month: m, totalSpent, monthlyBudget, categories, totalIncome, manualExpenses } = req.body;
    const [yr, mo] = String(m || '').split('-');
    const monthLabel = yr && mo ? new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' }) : m;
    try {
      const insight = await ai.budgetInsight({
        monthLabel,
        totalSpent: Number(totalSpent) || 0,
        monthlyBudget: Number(monthlyBudget) || 0,
        categories: Array.isArray(categories) ? categories : [],
        totalIncome: Number(totalIncome) || 0,
        manualExpenses: Array.isArray(manualExpenses) ? manualExpenses : [],
      }, key);
      res.json({ insight });
    } catch (err) {
      res.json({ insight: null, error: err.message });
    }
  }));

  return router;
};
