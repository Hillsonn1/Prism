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

// Apple system palette — saturated enough to read on white, calm enough for dark
const CATEGORY_COLORS = {
  'Groceries': '#34c759',
  'Dining & Restaurants': '#ff9500',
  'Gas & Fuel': '#ffcc00',
  'Shopping': '#af52de',
  'Entertainment': '#ff2d55',
  'Travel & Transport': '#32ade6',
  'Health & Medical': '#00c7be',
  'Utilities & Bills': '#8e8e93',
  'Subscriptions & Streaming': '#5e5ce6',
  'Personal Care': '#30b0c7',
  'Home & Garden': '#a2c33b',
  'Education': '#007aff',
  'Gifts & Donations': '#ff375f',
  'Business Expenses': '#5ac8fa',
  'Uncategorized': '#aeaeb2',
  'Other': '#8e8e93',
  'Unknown': '#ff9f0a',
};

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || '#aeaeb2';
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
