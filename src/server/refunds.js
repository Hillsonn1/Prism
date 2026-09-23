'use strict';
// Pairs a refund (a negative amount) with the purchase it reverses, so the
// two show together and the refund inherits the purchase's category.

const DAY = 86400000;
const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameMerchant = (a, b) => {
  const ka = key(a), kb = key(b);
  return Boolean(ka && kb) && (ka === kb || ka.startsWith(kb) || kb.startsWith(ka));
};
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

// Purchases that could be what this refund reverses, best first
function refundCandidates(refund, all, { windowDays = 120, limit = 8 } = {}) {
  if (!refund || !(refund.amount < 0) || !refund.date) return [];
  const value = Math.abs(refund.amount);
  const out = [];
  for (const p of all) {
    if (p.id === refund.id || !(p.amount > 0) || !p.date) continue;
    const days = daysBetween(p.date, refund.date);
    if (days < -3 || days > windowDays) continue; // a few days of slack for authorization vs posting dates
    const exact = Math.abs(p.amount - value) < 0.005;
    const merchant = sameMerchant(p.merchant, refund.merchant) || sameMerchant(p.rawSource, refund.rawSource);
    if (!exact && !merchant) continue;
    let score = 0;
    if (exact) score += 4;
    else if (p.amount > value) score += 1; // partial refund
    else continue;                       // a refund can't exceed its purchase
    if (merchant) score += 3;
    score += Math.max(0, 1 - Math.max(days, 0) / windowDays);
    out.push({ id: p.id, merchant: p.merchant, date: p.date, amount: p.amount, category: p.category || null, exact, sameMerchant: merchant, score });
  }
  return out.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, limit);
}

// The one purchase this refund clearly reverses, or null when it's ambiguous
function bestMatch(refund, all) {
  const sure = refundCandidates(refund, all).filter(c => c.exact && c.sameMerchant);
  return sure.length === 1 ? sure[0] : null;
}

// Links every unlinked refund with an unambiguous match. Returns how many.
function autoMatchRefunds(all) {
  const linked = new Map(); // purchase id → refunded so far
  for (const t of all) if (t.refundOf && t.amount < 0) linked.set(t.refundOf, (linked.get(t.refundOf) || 0) + Math.abs(t.amount));
  let matched = 0;
  for (const t of all) {
    if (!(t.amount < 0) || t.refundOf) continue;
    const best = bestMatch(t, all);
    if (!best) continue;
    const purchase = all.find(p => p.id === best.id);
    if (!purchase || (linked.get(best.id) || 0) + Math.abs(t.amount) > purchase.amount + 0.005) continue; // already refunded
    linkRefund(t, purchase);
    linked.set(best.id, (linked.get(best.id) || 0) + Math.abs(t.amount));
    matched++;
  }
  return matched;
}

// The refund takes the purchase's category; the merchant name follows when it was a bank-side variant
function linkRefund(refund, purchase) {
  refund.refundOf = purchase.id;
  if (purchase.category && !refund.category) { refund.category = purchase.category; refund.categorySource = 'auto'; }
  if (purchase.category && refund.category !== purchase.category && refund.categorySource !== 'user') { refund.category = purchase.category; refund.categorySource = 'auto'; }
}

module.exports = { refundCandidates, bestMatch, autoMatchRefunds, linkRefund };
