'use strict';
// Local analysis of the transaction list: things worth a second look.
// No network, no AI.

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

function anomalies(all, month) {
  if (!all.length) return [];
  const current = month ? all.filter(t => t.date?.startsWith(month)) : all;
  const out = duplicateCharges(current);
  if (month) out.push(...newMerchants(all, month));
  return out.slice(0, 8);
}

module.exports = { anomalies, duplicateCharges, newMerchants };
