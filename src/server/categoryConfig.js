'use strict';
// The category list as the user sees it: the built-in set plus their own,
// each with a color and an icon, any of them hidden from pickers, and
// built-ins that were merged away redirected to their replacement.

const { CATEGORIES } = require('./categories');
const { bad } = require('./validate');

const DEFAULT_COLORS = {
  'Groceries': '#34c759', 'Dining & Restaurants': '#ff9500', 'Gas & Fuel': '#ffcc00', 'Shopping': '#af52de',
  'Entertainment': '#ff2d55', 'Travel & Transport': '#32ade6', 'Health & Medical': '#00c7be', 'Utilities & Bills': '#8e8e93',
  'Subscriptions & Streaming': '#5e5ce6', 'Personal Care': '#30b0c7', 'Home & Garden': '#a2c33b', 'Education': '#007aff',
  'Gifts & Donations': '#ff375f', 'Business Expenses': '#5ac8fa', 'Other': '#8e8e93', 'Unknown': '#ff9f0a',
};
const DEFAULT_ICONS = {
  'Groceries': 'cart', 'Dining & Restaurants': 'utensils', 'Gas & Fuel': 'fuel', 'Shopping': 'bag', 'Entertainment': 'ticket',
  'Travel & Transport': 'plane', 'Health & Medical': 'heart', 'Utilities & Bills': 'zap', 'Subscriptions & Streaming': 'repeat',
  'Personal Care': 'scissors', 'Home & Garden': 'home', 'Education': 'book', 'Gifts & Donations': 'gift',
  'Business Expenses': 'briefcase', 'Other': 'dots', 'Unknown': 'help',
};
// Colors handed to new custom categories, in turn
const CUSTOM_PALETTE = ['#ff6482', '#64d2ff', '#ffd60a', '#bf5af2', '#30d158', '#ff9f0a', '#0a84ff', '#ac8e68', '#ff453a', '#66d4cf'];
const ICON_NAMES = ['cart', 'utensils', 'fuel', 'bag', 'ticket', 'plane', 'heart', 'zap', 'repeat', 'scissors', 'home', 'book', 'gift', 'briefcase',
  'dots', 'help', 'coffee', 'car', 'paw', 'baby', 'music', 'dumbbell', 'wine', 'shirt', 'phone', 'wifi', 'wrench', 'tree', 'star', 'bus',
  'camera', 'gamepad', 'pill', 'globe', 'umbrella', 'tag', 'building', 'palette'];

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const norm = s => String(s || '').trim().toLowerCase();

function getCategories(store) {
  const s = store.read('settings');
  const cfg = s.categoryConfig || {};
  const custom = (s.customCategories || []).filter(c => !CATEGORIES.includes(c));
  const names = [...CATEGORIES.filter(c => c !== 'Unknown'), ...custom, 'Unknown'];
  return names.map((name, i) => ({
    name,
    color: cfg[name]?.color || DEFAULT_COLORS[name] || CUSTOM_PALETTE[i % CUSTOM_PALETTE.length],
    icon: cfg[name]?.icon || DEFAULT_ICONS[name] || 'tag',
    hidden: Boolean(cfg[name]?.hidden),
    redirect: cfg[name]?.redirect || undefined,
    builtIn: CATEGORIES.includes(name),
  }));
}

// Built-ins merged into another category still come out of the rules; send them on
function redirectMap(store) {
  const cfg = store.read('settings').categoryConfig || {};
  const out = {};
  for (const [name, c] of Object.entries(cfg)) if (c.redirect) out[name] = c.redirect;
  return out;
}
const resolve = (map, category) => (category && map[category]) || category;

function findName(store, name) {
  return getCategories(store).find(c => norm(c.name) === norm(name)) || null;
}

function cleanName(name) {
  const s = String(name || '').trim().replace(/\s+/g, ' ');
  if (!s) throw bad('Category name is required');
  if (s.length > 40) throw bad('Category name is too long');
  if (s.startsWith('__')) throw bad('That name is reserved');
  return s;
}

function addCategory(store, { name, color, icon }) {
  const clean = cleanName(name);
  if (findName(store, clean)) throw bad(`"${clean}" already exists`);
  store.update('settings', s => {
    (s.customCategories = s.customCategories || []).push(clean);
    s.categoryConfig = s.categoryConfig || {};
    const n = s.customCategories.length;
    s.categoryConfig[clean] = {
      color: COLOR_RE.test(color || '') ? color.toLowerCase() : CUSTOM_PALETTE[n % CUSTOM_PALETTE.length],
      icon: ICON_NAMES.includes(icon) ? icon : 'tag',
    };
  });
  return findName(store, clean);
}

function updateCategory(store, name, { color, icon, hidden }) {
  const existing = findName(store, name);
  if (!existing) throw bad('No such category');
  store.update('settings', s => {
    s.categoryConfig = s.categoryConfig || {};
    const c = (s.categoryConfig[existing.name] = s.categoryConfig[existing.name] || {});
    if (color !== undefined) { if (!COLOR_RE.test(color)) throw bad('Color must be a hex value like #ff9500'); c.color = color.toLowerCase(); }
    if (icon !== undefined) { if (!ICON_NAMES.includes(icon)) throw bad('Unknown icon'); c.icon = icon; }
    if (hidden !== undefined) { if (hidden) c.hidden = true; else delete c.hidden; }
  });
  return findName(store, existing.name);
}

// Custom categories can be renamed; every transaction, memory entry and limit follows
function renameCategory(store, from, to) {
  const existing = findName(store, from);
  if (!existing) throw bad('No such category');
  if (existing.builtIn) throw bad('Built-in categories can be hidden or merged, not renamed');
  const clean = cleanName(to);
  if (clean === existing.name) return existing;
  const clash = findName(store, clean);
  if (clash && clash.name !== existing.name) throw bad(`"${clean}" already exists`);
  moveCategory(store, existing.name, clean);
  store.update('settings', s => {
    s.customCategories = (s.customCategories || []).map(c => (c === existing.name ? clean : c));
    if (s.categoryConfig?.[existing.name]) { s.categoryConfig[clean] = s.categoryConfig[existing.name]; delete s.categoryConfig[existing.name]; }
  });
  return findName(store, clean);
}

// Folds one category into another. A built-in source stays hidden and redirected
// so the rules that still produce it land in the right place.
function mergeCategory(store, from, to) {
  const src = findName(store, from);
  const dst = findName(store, to);
  if (!src || !dst) throw bad('No such category');
  if (src.name === dst.name) throw bad('Pick a different category to merge into');
  if (dst.redirect) throw bad(`"${dst.name}" was merged away itself`);
  const moved = moveCategory(store, src.name, dst.name);
  store.update('settings', s => {
    s.categoryConfig = s.categoryConfig || {};
    if (src.builtIn) {
      s.categoryConfig[src.name] = { ...(s.categoryConfig[src.name] || {}), hidden: true, redirect: dst.name };
      // anything that pointed at the source now points at the target
      for (const c of Object.values(s.categoryConfig)) if (c.redirect === src.name) c.redirect = dst.name;
    } else {
      s.customCategories = (s.customCategories || []).filter(c => c !== src.name);
      delete s.categoryConfig[src.name];
    }
  });
  return { from: src.name, to: dst.name, moved };
}

// A merged-away built-in can come back
function restoreCategory(store, name) {
  const existing = findName(store, name);
  if (!existing || !existing.builtIn) throw bad('No such built-in category');
  store.update('settings', s => { if (s.categoryConfig?.[existing.name]) { delete s.categoryConfig[existing.name].redirect; delete s.categoryConfig[existing.name].hidden; } });
  return findName(store, existing.name);
}

function moveCategory(store, from, to) {
  let moved = 0;
  store.update('transactions', list => { for (const t of list) if (t.category === from) { t.category = to; moved++; } });
  store.update('merchants', m => { for (const k of Object.keys(m)) if (m[k] === from) m[k] = to; });
  store.update('settings', s => {
    if (s.budgets?.[from] !== undefined) {
      s.budgets[to] = (s.budgets[to] || 0) + s.budgets[from];
      delete s.budgets[from];
    }
  });
  return moved;
}

module.exports = { getCategories, redirectMap, resolve, addCategory, updateCategory, renameCategory, mergeCategory, restoreCategory, ICON_NAMES, DEFAULT_COLORS, DEFAULT_ICONS };
