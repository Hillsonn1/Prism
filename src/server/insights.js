'use strict';
// Local analysis of the transaction list: things worth a second look.
// No network, no AI.

const { isCounted } = require('./spend');
const DAY = 86400000;

// Same merchant and amount charged more than once within a few days
function duplicateCharges(txns, windowDays = 5) {
  const windows = new Map(); // "merchant|amount" → [{ start, txns }]
  const sorted = [...txns].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  for (const t of sorted) {
    const key = `${t.merchant}|${t.amount.toFixed(2)}`;
    const when = new Date(t.date);
    const list = windows.get(key) || [];
    const match = list.find(w => Math.abs(when - w.start) <= windowDays * DAY);
    if (match) match.txns.push(t); else list.push({ start: when, txns: [t] });
    windows.set(key, list);
  }
  const out = [];
  for (const list of windows.values()) {
    for (const { txns: group } of list) {
      if (group.length < 2) continue;
      const { merchant, amount } = group[0];
      out.push({
        type: 'duplicate',
        label: 'Possible duplicate',
        detail: `${merchant} — $${amount.toFixed(2)} charged ${group.length}× within ${windowDays} days`,
        txnIds: group.map(t => t.id),
      });
    }
  }
  return out;
}

// Large charges from merchants never seen before the given month
function newMerchants(all, month, minAmount = 150) {
  const before = all.filter(t => t.date && t.date < month);
  const known = new Set(before.map(t => t.merchant.toLowerCase()));
  return all
    .filter(t => t.date?.startsWith(month) && t.amount >= minAmount && !known.has(t.merchant.toLowerCase()))
    .map(t => ({
      type: 'new-merchant',
      label: 'New merchant',
      detail: `First charge from ${t.merchant} — $${t.amount.toFixed(2)}`,
      txnId: t.id,
    }));
}

function anomalies(input, month) {
  const all = input.filter(isCounted);
  if (!all.length) return [];
  const current = month ? all.filter(t => t.date?.startsWith(month)) : all;
  const out = duplicateCharges(current);
  if (month) out.push(...newMerchants(all, month));
  return out.slice(0, 8);
}

const money = n => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'long' }); };
const prevMonth = m => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const sum = list => list.reduce((s, t) => s + t.amount, 0);
const byCategory = list => { const out = {}; for (const t of list) { if (t.amount <= 0) continue; const c = t.category || 'Uncategorized'; out[c] = (out[c] || 0) + t.amount; } return out; };

// Merchants charged in three or more months for about the same amount each time
function recurringCharges(input) {
  const all = input.filter(isCounted);
  const byMerchant = new Map();
  for (const t of all) {
    if (t.amount <= 0 || !t.date) continue;
    const m = t.date.slice(0, 7);
    const entry = byMerchant.get(t.merchant) || byMerchant.set(t.merchant, new Map()).get(t.merchant);
    entry.set(m, [...(entry.get(m) || []), t.amount]);
  }
  const out = [];
  for (const [merchant, months] of byMerchant) {
    if (months.size < 3) continue;
    // One charge a month, for about the same amount each time
    if ([...months.values()].some(list => list.length !== 1)) continue;
    const amounts = [...months.values()].map(list => list[0]);
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const steady = amounts.every(a => Math.abs(a - avg) <= Math.max(avg * 0.15, 2));
    if (steady) out.push({ merchant, months: months.size, amount: Math.round(avg * 100) / 100 });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// Plain-language observations about a month (or all time). No network, no AI.
function spendingInsights(input, month, today = new Date()) {
  const all = input.filter(isCounted);
  const out = [];
  if (!all.length) return out;
  const spend = all.filter(t => t.amount > 0);
  const current = month ? spend.filter(t => t.date?.startsWith(month)) : spend;
  const total = sum(current);
  if (!current.length) return out;

  if (month) {
    const prior = spend.filter(t => t.date?.startsWith(prevMonth(month)));
    if (prior.length) {
      const change = pct(total, sum(prior));
      out.push({ kind: 'total', text: `You spent ${money(total)} in ${monthLabel(month)}, ${change === 0 ? 'the same as' : `${Math.abs(change)}% ${change > 0 ? 'more than' : 'less than'}`} ${monthLabel(prevMonth(month))}.` });
    } else {
      out.push({ kind: 'total', text: `You spent ${money(total)} in ${monthLabel(month)} across ${current.length} purchases.` });
    }
    const thisMonth = today.toISOString().slice(0, 7);
    if (month === thisMonth) {
      const day = today.getDate();
      const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      if (day >= 5 && day < days) out.push({ kind: 'pace', text: `At this pace you'll end the month around ${money(total / day * days)}.` });
    }
  } else {
    const months = new Set(current.map(t => t.date?.slice(0, 7)).filter(Boolean));
    if (months.size > 1) {
      const perMonth = {};
      for (const t of current) perMonth[t.date.slice(0, 7)] = (perMonth[t.date.slice(0, 7)] || 0) + t.amount;
      const [topMonth, topAmt] = Object.entries(perMonth).sort((a, b) => b[1] - a[1])[0];
      out.push({ kind: 'total', text: `You average ${money(total / months.size)} a month over ${months.size} months; ${monthLabel(topMonth)} ${topMonth.slice(0, 4)} was the highest at ${money(topAmt)}.`, month: topMonth });
    }
  }

  const cats = Object.entries(byCategory(current)).sort((a, b) => b[1] - a[1]);
  if (cats.length && cats[0][0] !== 'Uncategorized') {
    const [cat, amt] = cats[0];
    out.push({ kind: 'top-category', category: cat, text: `${cat} was your biggest category at ${money(amt)} (${Math.round(amt / total * 100)}% of spending).` });
  }

  if (month) {
    // Largest swing vs the average of the three months before
    const window = [1, 2, 3].map(() => null).map((_, i) => { let m = month; for (let k = 0; k <= i; k++) m = prevMonth(m); return m; });
    const history = spend.filter(t => window.includes(t.date?.slice(0, 7)));
    const monthsWithData = new Set(history.map(t => t.date.slice(0, 7))).size;
    if (monthsWithData >= 2) {
      const avgByCat = byCategory(history);
      for (const k of Object.keys(avgByCat)) avgByCat[k] /= monthsWithData;
      let biggest = null;
      for (const [cat, amt] of cats) {
        if (cat === 'Uncategorized' || !avgByCat[cat] || avgByCat[cat] < 25) continue;
        const diff = amt - avgByCat[cat];
        if (Math.abs(diff) >= 50 && Math.abs(diff) / avgByCat[cat] >= 0.25 && (!biggest || Math.abs(diff) > Math.abs(biggest.diff))) biggest = { cat, amt, avg: avgByCat[cat], diff };
      }
      if (biggest) out.push({ kind: 'swing', category: biggest.cat, text: `${biggest.cat} is ${biggest.diff > 0 ? 'up' : 'down'} ${Math.abs(pct(biggest.amt, biggest.avg))}% vs your ${monthsWithData}-month average (${money(biggest.amt)} vs ${money(biggest.avg)}).` });
    }
  }

  const uncategorized = current.filter(t => !t.category);
  if (uncategorized.length) out.push({ kind: 'uncategorized', text: `${uncategorized.length} purchase${uncategorized.length !== 1 ? 's' : ''} worth ${money(sum(uncategorized))} still need${uncategorized.length === 1 ? 's' : ''} a category.` });

  const largest = [...current].sort((a, b) => b.amount - a.amount)[0];
  if (largest && largest.amount >= Math.max(total * 0.08, 40)) {
    const d = new Date(largest.date);
    out.push({ kind: 'largest', merchant: largest.merchant, text: `Largest purchase: ${money(largest.amount)} at ${largest.merchant}${Number.isNaN(d) ? '' : ` on ${d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`}.` });
  }

  const recurring = recurringCharges(all);
  if (recurring.length >= 2) {
    const monthly = recurring.reduce((s, r) => s + r.amount, 0);
    const names = recurring.slice(0, 3).map(r => r.merchant).join(', ');
    out.push({ kind: 'recurring', text: `Recurring charges add up to about ${money(monthly)} a month (${names}${recurring.length > 3 ? ` and ${recurring.length - 3} more` : ''}).` });
  }

  const refunds = (month ? all.filter(t => t.date?.startsWith(month)) : all).filter(t => t.amount < 0);
  if (refunds.length) out.push({ kind: 'refunds', text: `${money(sum(refunds))} came back in refunds and credits (${refunds.length}).` });

  return out.slice(0, 6);
}

module.exports = { anomalies, duplicateCharges, newMerchants, recurringCharges, spendingInsights };
