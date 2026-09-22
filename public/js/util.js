// Formatting and small helpers shared by every view.

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---- Safe HTML ----
// html`...` escapes every interpolated value. Nested html`` results and raw()
// values pass through untouched, so markup composes without double-escaping.
class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
function raw(s) { return new SafeHtml(String(s)); }
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += toHtml(v) + strings[i + 1];
  });
  return new SafeHtml(out);
}
function toHtml(v) {
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// For a value inside a single-quoted JS string in an onclick="..." attribute:
// escaped for JS first, then for HTML, and marked safe so html`` leaves it alone.
// (Plain HTML-escaping breaks on apostrophes: the browser decodes &#39; back
// to ' before running the handler, which then fails to parse.)
function escAttr(str) {
  return raw(esc(String(str ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")));
}

// ---- Money and dates ----
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const ils = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'ILS', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 });

function fmt(amount) {
  return usd.format(amount);
}

// The original amount for purchases made in another currency ("₪120")
function fmtOriginal(t) {
  if (!t || t.originalCurrency !== 'ILS' || typeof t.originalAmount !== 'number') return '';
  const n = Math.abs(t.originalAmount);
  return ils.format(Number.isInteger(n) ? n : Math.round(n * 100) / 100).replace(/\.00$/, '');
}

// Dollar amount with the original currency beside it, as markup
function amountHtml(t, opts = {}) {
  const orig = fmtOriginal(t);
  const cls = ['amount', t.amount < 0 ? 'amount-credit' : '', opts.small ? 'amount-sm' : ''].filter(Boolean).join(' ');
  return html`<span class="${cls}">${fmt(t.amount)}</span>${orig ? html` <span class="amount-orig" title="Charged in shekels">${orig}</span>` : ''}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

function fmtMonth(m, style = 'long') {
  const [yr, mo] = m.split('-');
  return new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: style, year: 'numeric' });
}

function fmtShort(amt) {
  if (amt >= 1000) return '$' + (amt / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '$' + Math.round(amt);
}

function fmtAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  return fmtDate(iso.slice(0, 10));
}

function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`;
}
