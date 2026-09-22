// Application state and the category palette.

const state = {
  transactions: [],
  merchants: {},
  budgets: {},
  currentView: 'dashboard',
  sort: { col: 'date', dir: 'desc' },
  merchantSort: { col: 'name', dir: 'asc' },
  dashboardMonth: '',
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
  localInsightsCache: {},  // local observations, per period
  anomaliesCache: {},
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

const CATEGORIES = [
  'Groceries',
  'Dining & Restaurants',
  'Gas & Fuel',
  'Shopping',
  'Entertainment',
  'Travel & Transport',
  'Health & Medical',
  'Utilities & Bills',
  'Subscriptions & Streaming',
  'Personal Care',
  'Home & Garden',
  'Education',
  'Gifts & Donations',
  'Business Expenses',
  'Other',
  'Unknown',
];
// What the user can pick; "Unknown" only ever comes from automatic categorization
const SELECTABLE_CATEGORIES = CATEGORIES.filter(c => c !== 'Unknown');

const CATEGORY_COLORS = {
  'Groceries': '#22c55e',
  'Dining & Restaurants': '#f97316',
  'Gas & Fuel': '#eab308',
  'Shopping': '#8b5cf6',
  'Entertainment': '#ec4899',
  'Travel & Transport': '#06b6d4',
  'Health & Medical': '#0891b2',
  'Utilities & Bills': '#64748b',
  'Subscriptions & Streaming': '#a855f7',
  'Personal Care': '#14b8a6',
  'Home & Garden': '#84cc16',
  'Education': '#3b82f6',
  'Gifts & Donations': '#f43f5e',
  'Business Expenses': '#0ea5e9',
  'Uncategorized': '#94a3b8',
  'Other': '#6b7280',
  'Unknown': '#f59e0b',
};

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || '#94a3b8';
}

// <option> list for a category <select>
function categoryOptions(selected, { blank = null, custom = true } = {}) {
  return html`${blank !== null ? html`<option value="">${blank}</option>` : ''}${SELECTABLE_CATEGORIES.map(c => html`<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`)}${custom ? html`<option value="__custom__">+ Custom…</option>` : ''}`;
}

// A colored category pill; onclick is a trusted JS snippet
function categoryBadge(cat, onclick = '') {
  const color = categoryColor(cat || 'Uncategorized');
  return html`<span class="category-badge ${cat ? '' : 'uncategorized'}" style="${cat ? `background:${color}18;color:${color}` : ''}" ${onclick ? raw(`onclick="${onclick}"`) : ''}>${cat ? html`<span class="category-dot" style="background:${color}"></span>` : ''}${cat || '+ Add category'}</span>`;
}
