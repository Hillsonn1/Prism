'use strict';
// Shekel → dollar conversion for purchases made in ILS. Dollars are what
// Prism computes with; the shekel amount is kept on the transaction and shown
// beside it. Rates are ECB reference rates from frankfurter.dev (free, no key),
// cached per day in fx.json. A manual rate in Settings overrides the lookup so
// imports work offline. All rates are expressed as ILS per 1 USD.

const RATE_HOST = process.env.PRISM_FX_HOST || 'https://api.frankfurter.dev/v1';
const FALLBACK_RATE = 3.6; // only when nothing better is available

function createFx({ store, log = console }) {
  const manualRate = () => {
    const r = store.read('settings').currency?.ilsRate;
    return typeof r === 'number' && r > 0 ? r : null;
  };

  const cached = (date, cur) => store.read('fx')[cur]?.[date] || null;
  const latestCached = (cur = 'ILS') => {
    const all = store.read('fx')[cur] || {};
    const dates = Object.keys(all).sort();
    return dates.length ? { date: dates[dates.length - 1], rate: all[dates[dates.length - 1]] } : null;
  };

  async function fetchRate(date, cur) {
    const today = new Date().toISOString().slice(0, 10);
    const path = date && date < today ? date : 'latest';
    const res = await fetch(`${RATE_HOST}/${path}?base=USD&symbols=${cur}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`rate lookup failed (${res.status})`);
    const data = await res.json();
    const rate = data.rates?.[cur];
    if (!(rate > 0)) throw new Error(`rate lookup returned no ${cur} rate`);
    store.update('fx', fx => { (fx[cur] = fx[cur] || {})[date || data.date] = rate; });
    return rate;
  }

  // Units of `currency` per USD for a given date, with where it came from.
  // The manual rate in Settings applies to shekels only.
  async function rate(date, currency = 'ILS') {
    const cur = String(currency || 'ILS').toUpperCase();
    const manual = cur === 'ILS' ? manualRate() : null;
    if (manual) return { rate: manual, source: 'manual', date };
    const day = (date || new Date().toISOString()).slice(0, 10);
    const hit = cached(day, cur);
    if (hit) return { rate: hit, source: 'ecb', date: day };
    try {
      return { rate: await fetchRate(day, cur), source: 'ecb', date: day };
    } catch (err) {
      log.error('FX rate lookup failed:', err.message);
      const latest = latestCached(cur);
      if (latest) return { rate: latest.rate, source: 'ecb-stale', date: latest.date };
      if (cur === 'ILS') return { rate: FALLBACK_RATE, source: 'fallback', date: day };
      throw new Error(`No exchange rate available for ${cur}`);
    }
  }

  // Converts a foreign amount to dollars, returning both plus the rate used
  async function toUSD(original, date, currency = 'ILS') {
    const cur = String(currency || 'ILS').toUpperCase();
    const r = await rate(date, cur);
    return { amount: Math.round((original / r.rate) * 100) / 100, originalAmount: original, originalCurrency: cur, fxRate: r.rate, fxSource: r.source };
  }

  return { rate, toUSD, manualRate, latestCached };
}

module.exports = { createFx, FALLBACK_RATE };
