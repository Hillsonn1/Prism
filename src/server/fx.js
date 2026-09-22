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

  const cached = date => store.read('fx').ILS?.[date] || null;
  const latestCached = () => {
    const all = store.read('fx').ILS || {};
    const dates = Object.keys(all).sort();
    return dates.length ? { date: dates[dates.length - 1], rate: all[dates[dates.length - 1]] } : null;
  };

  async function fetchRate(date) {
    const today = new Date().toISOString().slice(0, 10);
    const path = date && date < today ? date : 'latest';
    const res = await fetch(`${RATE_HOST}/${path}?base=USD&symbols=ILS`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`rate lookup failed (${res.status})`);
    const data = await res.json();
    const rate = data.rates?.ILS;
    if (!(rate > 0)) throw new Error('rate lookup returned no ILS rate');
    store.update('fx', fx => { (fx.ILS = fx.ILS || {})[date || data.date] = rate; });
    return rate;
  }

  // ILS per USD for a given date, with where it came from
  async function rate(date) {
    const manual = manualRate();
    if (manual) return { rate: manual, source: 'manual', date };
    const day = (date || new Date().toISOString()).slice(0, 10);
    const hit = cached(day);
    if (hit) return { rate: hit, source: 'ecb', date: day };
    try {
      return { rate: await fetchRate(day), source: 'ecb', date: day };
    } catch (err) {
      log.error('FX rate lookup failed:', err.message);
      const latest = latestCached();
      if (latest) return { rate: latest.rate, source: 'ecb-stale', date: latest.date };
      return { rate: FALLBACK_RATE, source: 'fallback', date: day };
    }
  }

  // Converts a shekel amount to dollars, returning both plus the rate used
  async function toUSD(ils, date) {
    const r = await rate(date);
    return { amount: Math.round((ils / r.rate) * 100) / 100, originalAmount: ils, originalCurrency: 'ILS', fxRate: r.rate, fxSource: r.source };
  }

  return { rate, toUSD, manualRate, latestCached };
}

module.exports = { createFx, FALLBACK_RATE };
