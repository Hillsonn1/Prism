// Application state and the category palette.

const state = {
  transactions: [],
  merchants: {},
  budgets: {},
  currentView: 'dashboard',
  sort: { col: 'date', dir: 'desc' },
  merchantSort: { col: 'name', dir: 'asc' },
  dashboardMonth: undefined,
  budgetMonth: '',
  monthlyBudget: 0,
  income: {},
  expenses: {},
  editingIncomeId: null,
  addingIncome: false,
  editingExpenseId: null,
  addingExpense: false,
  editingBudgetTarget: false,
  budgetInsight: {},
  trendShowAll: false,
  insightsCache: {},       // AI write-ups, per period
  dashboardCache: {},      // anomalies + local insights + bank status, per period
  _dashSeq: 0,             // guards against out-of-order dashboard fetches
  _dashDrawnKey: null,     // period whose charts are currently painted
  dismissedAnomalies: new Set(),
  hasApiKey: false,
  prefs: {},
  currency: { ilsRate: 'auto', latest: null },
  groupByVendor: false,
  expandedMerchants: new Set(),
  jumpToCategory: null,
  jumpToMonth: null,
  navHistory: [],
  merchantFilter: null,
  editingTxnId: null,
  addingTransaction: false,
  pendingItems: { suggestions: [], unknowns: [] },
  txVersion: 0,          // incremented whenever state.transactions content changes
  _dropdownVersion: -1,  // tracks last txVersion when dropdowns were rebuilt
  plaidChangeCounter: undefined,
};

// Built-in category names; the live list (with colors, icons, hidden ones and
// the user's own categories) comes from the server on load
const CATEGORIES = [
  'Groceries', 'Dining & Restaurants', 'Gas & Fuel', 'Shopping', 'Entertainment', 'Travel & Transport',
  'Health & Medical', 'Utilities & Bills', 'Subscriptions & Streaming', 'Personal Care', 'Home & Garden',
  'Education', 'Gifts & Donations', 'Business Expenses', 'Other', 'Unknown',
];
const DEFAULT_CATEGORY_COLORS = {
  'Groceries': '#34c759', 'Dining & Restaurants': '#ff9500', 'Gas & Fuel': '#ffcc00', 'Shopping': '#af52de',
  'Entertainment': '#ff2d55', 'Travel & Transport': '#32ade6', 'Health & Medical': '#00c7be', 'Utilities & Bills': '#8e8e93',
  'Subscriptions & Streaming': '#5e5ce6', 'Personal Care': '#30b0c7', 'Home & Garden': '#a2c33b', 'Education': '#007aff',
  'Gifts & Donations': '#ff375f', 'Business Expenses': '#5ac8fa', 'Other': '#8e8e93', 'Unknown': '#ff9f0a',
};

state.categories = CATEGORIES.map(name => ({ name, color: DEFAULT_CATEGORY_COLORS[name], icon: 'tag', hidden: false, builtIn: true }));
state.trips = [];
state.quickFilters = new Set();  // 'uncategorized' | 'pending' | 'refunds' | 'large' | 'excluded' | 'reimbursable'
state.sortMode = 'newest';       // 'newest' | 'oldest' | 'largest' | 'smallest'
state.editTags = [];             // tags being edited in the transaction modal
state._categoryMap = null;

function setCategories(list) {
  if (Array.isArray(list) && list.length) state.categories = list;
  state._categoryMap = new Map(state.categories.map(c => [c.name, c]));
}
function categoryInfo(name) {
  if (!state._categoryMap) setCategories(state.categories);
  return state._categoryMap.get(name) || null;
}
function categoryColor(cat) {
  if (!cat || cat === 'Uncategorized') return '#aeaeb2';
  return categoryInfo(cat)?.color || DEFAULT_CATEGORY_COLORS[cat] || '#aeaeb2';
}
function categoryIcon(cat) {
  if (!cat || cat === 'Uncategorized') return 'circle-dashed';
  return categoryInfo(cat)?.icon || 'tag';
}
// What the user can pick: nothing hidden, and "Unknown" only ever comes from automatic categorization
function selectableCategories() {
  return state.categories.filter(c => !c.hidden && !c.redirect && c.name !== 'Unknown').map(c => c.name);
}

// <option> list for a category <select>; a category in use but hidden is still offered when selected
function categoryOptions(selected, { blank = null, custom = true } = {}) {
  const names = selectableCategories();
  if (selected && !names.includes(selected)) names.push(selected);
  return html`${blank !== null ? html`<option value="">${blank}</option>` : ''}${names.map(c => html`<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`)}${custom ? html`<option value="__custom__">+ New category…</option>` : ''}`;
}

// A colored category pill with its icon; onclick is a trusted JS snippet
function categoryBadge(cat, onclick = '') {
  const color = categoryColor(cat || 'Uncategorized');
  return html`<span class="category-badge ${cat ? '' : 'uncategorized'}" style="${cat ? `background:${color}1f;color:${color}` : ''}" ${onclick ? raw(`onclick="${onclick}"`) : ''}>${cat ? icon(categoryIcon(cat), 'category-icon') : ''}${cat || '+ Add category'}</span>`;
}
