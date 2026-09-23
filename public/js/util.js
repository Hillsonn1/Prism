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

// "Sep 22", with the year only when it isn't this year
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(dateStr, { year = 'auto' } = {}) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  const label = `${MONTHS_SHORT[+m - 1] || m} ${+d}`;
  const showYear = year === 'always' || (year === 'auto' && y !== String(new Date().getFullYear()));
  return showYear ? `${label}, ${y}` : label;
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

// ---- Icons ----
// Inline SVG, stroke-based, sized by CSS (currentColor). Keep the set small.
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  list: '<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  wallet: '<path d="M20 12V7H6a2 2 0 0 1 0-4h13v4"/><path d="M4 5v14a2 2 0 0 0 2 2h14v-5"/><path d="M17 12a2 2 0 0 0 0 4h4v-4Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  store: '<path d="M3 9l1.2-5h15.6L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v9h14v-9"/><path d="M10 21v-5h4v5"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8Z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  bank: '<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z"/><circle cx="7" cy="7" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  'trend-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  'trend-down': '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/>',
};
function icon(name, cls = '') {
  const paths = ICONS[name];
  if (!paths) return raw('');
  return raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`);
}
// Fills every [data-icon] placeholder in static markup
function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
}
