// ---- Utilities ----
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---- State ----
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
  insightsCache: {},
  anomaliesCache: {},
  dismissedAnomalies: new Set(),
  hasApiKey: false,
  groupByVendor: false,
  expandedMerchants: new Set(),
  jumpToCategory: null,
  jumpToMonth: null,
  navHistory: [],
  merchantFilter: null,
  editingTxnId: null,
  pendingMerchants: [],
  pendingItems: { suggestions: [], unknowns: [] },
  categoryPopup: null,
  txVersion: 0,        // incremented whenever state.transactions content changes
  _dropdownVersion: -1, // tracks last txVersion when dropdowns were rebuilt
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

function fmt(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

// ---- API ----
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadAll() {
  const [txns, merchants, settings] = await Promise.all([
    api('GET', '/api/transactions'),
    api('GET', '/api/merchants'),
    api('GET', '/api/settings'),
  ]);
  state.transactions = Array.isArray(txns) ? txns : [];
  state.merchants = merchants && typeof merchants === 'object' ? merchants : {};
  state.budgets = settings.budgets || {};
  state.hasApiKey = !!settings.hasApiKey;
  state.txVersion++;
  clearDashboardCaches();
}

// ---- Navigation ----
function switchView(view, { skipHistory = false, clearHistory = false } = {}) {
  if (clearHistory) {
    state.navHistory = [];
  } else if (!skipHistory && state.currentView && state.currentView !== view) {
    state.navHistory.push(state.currentView);
  }
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`[data-view="${view}"]`).classList.add('active');
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.style.display = state.navHistory.length ? '' : 'none';

  if (view === 'dashboard') renderDashboard();
  if (view === 'transactions') renderTransactions();
  if (view === 'upload') renderSources();
  if (view === 'merchants') renderMerchants();
  if (view === 'budget') renderBudget();
  if (view === 'settings') renderSettings();
}

function goBack() {
  if (!state.navHistory.length) return;
  const prev = state.navHistory.pop();
  switchView(prev, { skipHistory: true });
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    switchView(link.dataset.view, { clearHistory: true });
  });
});

// ---- Pie / donut chart ----
function renderPieChart(slices, total) {
  if (!slices.length || total === 0) return '';

  const cx = 95, cy = 95, R = 82, r = 50, size = 190;

  // Single-category: stroke-dashoffset sweep from top
  if (slices.length === 1) {
    const color = categoryColor(slices[0][0]);
    const mid = (R + r) / 2, sw = R - r;
    const circ = +(2 * Math.PI * mid).toFixed(2);
    return `<svg viewBox="0 0 ${size} ${size}" style="width:170px;height:170px;display:block;margin:0 auto 1rem">
      <circle cx="${cx}" cy="${cy}" r="${mid}" fill="none" stroke="${color}" stroke-width="${sw}" opacity=".9"
        stroke-dasharray="${circ}" stroke-dashoffset="${circ}" transform="rotate(-90 ${cx} ${cy})">
        <animate attributeName="stroke-dashoffset" from="${circ}" to="0" dur=".65s" fill="freeze"
          calcMode="spline" keyTimes="0;1" keySplines=".25,.1,.25,1"/>
      </circle>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="10" fill="#64748b">Total</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="13" font-weight="700" fill="#1e293b">${fmt(total)}</text>
    </svg>`;
  }

  // Multi-slice: render empty paths, animate the sweep via rAF
  const svgId = `pie-${Date.now()}`;
  const sliceInfo = slices.map(([cat, amt]) => ({
    cat, amt, pct: amt / total, color: categoryColor(cat),
  }));

  const pathsHtml = sliceInfo.map((s, i) =>
    `<path data-i="${i}" data-pct="${s.pct}" fill="${s.color}" opacity=".9" style="cursor:pointer"
      onclick="drillCategory('${escAttr(s.cat)}')" title="${esc(s.cat)}: ${fmt(s.amt)} (${Math.round(s.pct * 100)}%)">
      <title>${esc(s.cat)}: ${fmt(s.amt)} (${Math.round(s.pct * 100)}%)</title>
    </path>`
  ).join('');

  requestAnimationFrame(() => {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    const paths = [...svg.querySelectorAll('path[data-pct]')];
    const t0 = performance.now();
    const dur = 700;

    function frame(now) {
      const raw = Math.min((now - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - raw, 3); // cubic ease-out
      const progress = ease * 2 * Math.PI;   // total angle drawn so far

      let startAngle = -Math.PI / 2;
      let cumAngle = 0;

      paths.forEach(path => {
        const pct = +path.dataset.pct;
        const full = pct * 2 * Math.PI;
        const drawn = Math.max(0, Math.min(full, progress - cumAngle));
        cumAngle += full;

        if (drawn < 0.0001) {
          path.setAttribute('d', '');
          startAngle += full;
          return;
        }

        const end = startAngle + drawn;
        const large = drawn > Math.PI ? 1 : 0;
        const x1 = cx + R * Math.cos(startAngle), y1 = cy + R * Math.sin(startAngle);
        const x2 = cx + R * Math.cos(end),         y2 = cy + R * Math.sin(end);
        const x3 = cx + r * Math.cos(end),          y3 = cy + r * Math.sin(end);
        const x4 = cx + r * Math.cos(startAngle),   y4 = cy + r * Math.sin(startAngle);
        path.setAttribute('d',
          `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
          `L${x3.toFixed(2)} ${y3.toFixed(2)} A${r} ${r} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`
        );
        startAngle += full;
      });

      if (raw < 1) requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  });

  return `<svg id="${svgId}" viewBox="0 0 ${size} ${size}" style="width:170px;height:170px;display:block;margin:0 auto 1rem">
    ${pathsHtml}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="10" fill="#64748b">Total</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="13" font-weight="700" fill="#1e293b">${fmt(total)}</text>
  </svg>`;
}

// ---- Dashboard ----
function renderDashboard() {
  const empty = document.getElementById('dashboard-empty');
  const data = document.getElementById('dashboard-data');

  if (!state.transactions.length) {
    empty.style.display = '';
    data.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  data.style.display = '';

  // Build month selector from available data
  const allMonths = [...new Set(
    state.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean)
  )].sort().reverse();

  document.getElementById('dashboard-filter-bar').innerHTML = `
    <div class="dash-filter-row">
      <label class="dash-filter-label">Period</label>
      <select id="dash-month-select" onchange="state.dashboardMonth=this.value;renderDashboard()">
        <option value="">All time</option>
        ${allMonths.map(m => {
          const [yr, mo] = m.split('-');
          const label = new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
          return `<option value="${m}" ${m === state.dashboardMonth ? 'selected' : ''}>${label}</option>`;
        }).join('')}
      </select>
    </div>
  `;

  // Filter by selected month
  const txns = state.dashboardMonth
    ? state.transactions.filter(t => t.date?.startsWith(state.dashboardMonth))
    : state.transactions;

  // Summary cards
  const total = txns.reduce((s, t) => s + t.amount, 0);
  const uncategorizedMerchants = [...new Set(txns.filter(t => !t.category).map(t => t.merchant))].length;
  const uncategorized = txns.filter(t => !t.category).length;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthTotal = txns
    .filter(t => t.date && t.date.startsWith(thisMonth))
    .reduce((s, t) => s + t.amount, 0);

  const periodLabel = state.dashboardMonth ? (() => {
    const [yr, mo] = state.dashboardMonth.split('-');
    return new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  })() : null;

  document.getElementById('summary-cards').innerHTML = `
    <div class="summary-card">
      <div class="label">${periodLabel ? 'Period Total' : 'Total Spending'}</div>
      <div class="value">${fmt(total)}</div>
      <div class="sub">${txns.length} transactions</div>
    </div>
    ${!state.dashboardMonth ? `
    <div class="summary-card">
      <div class="label">This Month</div>
      <div class="value">${fmt(monthTotal)}</div>
      <div class="sub">${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}</div>
    </div>` : ''}
  `;

  const banner = document.getElementById('uncategorized-banner');
  if (uncategorized) {
    banner.style.display = '';
    banner.innerHTML = `⚠️ <strong>${uncategorizedMerchants} merchant${uncategorizedMerchants !== 1 ? 's' : ''}</strong> uncategorized — <a href="#" class="categorize-link" onclick="openUncategorizedModal();return false">Categorize now →</a>`;
  } else {
    banner.style.display = 'none';
  }

  // Monthly trend chart (always uses all transactions, highlights selected month)
  const monthTotals = {};
  for (const t of state.transactions) {
    const m = t.date?.slice(0, 7);
    if (m) monthTotals[m] = (monthTotals[m] || 0) + t.amount;
  }
  const allTrendMonths = Object.keys(monthTotals).sort();
  const trendMonths = state.trendShowAll ? allTrendMonths : allTrendMonths.slice(-6);
  const toggle = document.getElementById('trend-toggle');
  if (toggle) toggle.textContent = state.trendShowAll ? 'Show recent' : 'Show all';
  const trendMax = Math.max(...Object.values(monthTotals), 1);
  document.getElementById('trend-chart').innerHTML = trendMonths.map(m => {
    const amt = monthTotals[m];
    const [yr, mo] = m.split('-');
    const label = new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'short', year: 'numeric' });
    const isSelected = m === state.dashboardMonth;
    const color = isSelected ? '#2563eb' : '#cbd5e1';
    return `
      <div class="chart-row chart-clickable" onclick="state.dashboardMonth='${m}';renderDashboard()" title="${label}">
        <div class="chart-label">${label}</div>
        <div class="chart-bar-wrap">
          <div class="chart-bar" style="width:0;background:${color}" data-w="${(amt / trendMax * 100).toFixed(1)}%"></div>
        </div>
        <div class="chart-amount" style="${isSelected ? 'color:#2563eb;font-weight:700' : ''}">${fmt(amt)}</div>
      </div>`;
  }).join('');

  // Category chart — each row is clickable to drill into that category
  const catTotals = {};
  for (const t of txns) {
    if (t.amount <= 0) continue;
    const c = t.category || 'Uncategorized';
    catTotals[c] = (catTotals[c] || 0) + t.amount;
  }
  const sorted = Object.entries(catTotals).filter(([, amt]) => amt > 0).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;

  document.getElementById('pie-chart').innerHTML = renderPieChart(sorted, total);

  document.getElementById('category-chart').innerHTML = sorted.map(([cat, amt]) => {
    const budget = state.budgets[cat];
    const showBudget = state.dashboardMonth && budget;
    const pct = showBudget ? amt / budget : 1;
    let barColor = categoryColor(cat);
    let amtLabel = fmt(amt);
    if (showBudget) {
      if (pct > 1)      { barColor = '#dc2626'; amtLabel += ` <span class="budget-amt">/ ${fmt(budget)} ⚠ over</span>`; }
      else if (pct > .8){ barColor = '#f97316'; amtLabel += ` <span class="budget-amt">/ ${fmt(budget)}</span>`; }
      else              {                        amtLabel += ` <span class="budget-amt">/ ${fmt(budget)}</span>`; }
    }
    return `
      <div class="chart-row chart-clickable" onclick="drillCategory('${escAttr(cat)}')" title="Click to see ${esc(cat)} transactions">
        <div class="chart-label">${cat}</div>
        <div class="chart-bar-wrap">
          <div class="chart-bar" style="width:0;background:${barColor}" data-w="${(amt / max * 100).toFixed(1)}%"></div>
        </div>
        <div class="chart-amount">${amtLabel}</div>
      </div>`;
  }).join('');

  // Recent transactions
  const recent = [...txns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);

  document.getElementById('recent-transactions').innerHTML = recent.map(t => `
    <div class="recent-row">
      <div>
        <div class="recent-merchant">${esc(t.merchant)}</div>
        <div class="recent-date">${fmtDate(t.date)}</div>
      </div>
      <div class="recent-amount">${fmt(t.amount)}</div>
    </div>
  `).join('');

  renderTopMerchants(txns);
  renderRecurring();
  renderAnomalies();
  renderInsightsShell();

  // Animate bars from 0 → target width (triggers the CSS transition)
  requestAnimationFrame(() => {
    document.querySelectorAll('.chart-bar[data-w]').forEach(b => { b.style.width = b.dataset.w; });
  });
}

async function renderAnomalies() {
  const card = document.getElementById('anomalies-card');
  const list = document.getElementById('anomalies-list');
  if (!card || !list) return;

  const cacheKey = state.dashboardMonth || 'all';
  if (state.anomaliesCache[cacheKey] !== undefined) {
    displayAnomalies(state.anomaliesCache[cacheKey]);
    return;
  }

  try {
    const params = state.dashboardMonth ? `?month=${state.dashboardMonth}` : '';
    const data = await api('GET', `/api/anomalies${params}`);
    state.anomaliesCache[cacheKey] = data.anomalies || [];
    displayAnomalies(state.anomaliesCache[cacheKey]);
  } catch {}
}

function anomalyKey(a) { return `${a.label}||${a.detail}`; }

function displayAnomalies(anomalies) {
  const card = document.getElementById('anomalies-card');
  const list = document.getElementById('anomalies-list');
  const visible = anomalies.filter(a => !state.dismissedAnomalies.has(anomalyKey(a)));
  if (!visible.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const typeIcon = { 'duplicate': '⚠️', 'new-merchant': '🆕', 'price-increase': '📈' };
  list.innerHTML = visible.map((a, i) => `
    <div class="anomaly-row" id="anomaly-row-${i}">
      <span class="anomaly-icon">${typeIcon[a.type] || '⚠️'}</span>
      <div style="flex:1">
        <span class="anomaly-label">${esc(a.label)}</span>
        <span class="anomaly-detail">${esc(a.detail)}</span>
      </div>
      <button class="anomaly-dismiss" onclick="dismissAnomaly(${i},${JSON.stringify(anomalyKey(a)).replace(/"/g,'&quot;')})" title="Dismiss">Dismiss</button>
    </div>`).join('');
}

function dismissAnomaly(i, key) {
  state.dismissedAnomalies.add(key);
  const row = document.getElementById(`anomaly-row-${i}`);
  if (row) row.remove();
  const card = document.getElementById('anomalies-card');
  if (card && !card.querySelector('.anomaly-row')) card.style.display = 'none';
}

function renderInsightsShell() {
  const card = document.getElementById('insights-card');
  if (!card) return;
  card.style.display = '';
  const genState = document.getElementById('insights-generate-state');
  const content = document.getElementById('insights-content');
  const refreshBtn = document.getElementById('insights-refresh-btn');
  if (!state.hasApiKey) {
    genState.innerHTML = '<p class="insights-no-key">Add an API key in <a href="#" onclick="switchView(\'settings\');return false">Settings</a> to unlock AI insights.</p>';
    genState.style.display = '';
    content.style.display = 'none';
    refreshBtn.style.display = 'none';
    return;
  }
  const cacheKey = state.dashboardMonth || 'all';
  if (state.insightsCache[cacheKey]) {
    showInsightsContent(state.insightsCache[cacheKey]);
  } else {
    genState.innerHTML = '<button id="insights-generate-btn" class="insights-generate-btn" onclick="generateInsights()">✦ Generate insights</button>';
    genState.style.display = '';
    content.style.display = 'none';
    content.innerHTML = '';
    refreshBtn.style.display = 'none';
  }
}

async function generateInsights() {
  const btn = document.getElementById('insights-generate-btn');
  const genState = document.getElementById('insights-generate-state');
  const content = document.getElementById('insights-content');
  if (btn) btn.disabled = true;
  genState.style.display = 'none';
  content.style.display = '';
  content.innerHTML = `
    <div class="progress-bar-wrap" style="margin-bottom:.4rem"><div class="progress-bar-fill" id="insights-bar" style="width:4%"></div></div>
    <div class="progress-message" id="insights-msg">Analyzing your spending…</div>`;

  let fakeP = 4;
  const ticker = setInterval(() => {
    fakeP = Math.min(fakeP + Math.random() * 11, 88);
    const bar = document.getElementById('insights-bar');
    const msg = document.getElementById('insights-msg');
    if (bar) bar.style.width = fakeP + '%';
    if (msg && fakeP > 55) msg.textContent = 'Writing insights…';
  }, 900);

  try {
    const data = await api('POST', '/api/insights', { month: state.dashboardMonth || '' });
    clearInterval(ticker);
    if (data.summary) {
      const cacheKey = state.dashboardMonth || 'all';
      state.insightsCache[cacheKey] = data.summary;
      showInsightsContent(data.summary);
    }
  } catch (err) {
    clearInterval(ticker);
    content.innerHTML = `<p style="color:var(--danger,#ef4444);font-size:.85rem">Failed to generate insights. ${esc(err.message || 'Please try again.')}</p>`;
    content.style.display = '';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showInsightsContent(summary) {
  const content = document.getElementById('insights-content');
  const paras = summary.split(/\n+/).map(s => s.trim()).filter(Boolean);
  content.innerHTML = paras.map(p => `<p>${esc(p)}</p>`).join('');
  content.style.display = '';
  document.getElementById('insights-generate-state').style.display = 'none';
  document.getElementById('insights-refresh-btn').style.display = '';
}

function refreshInsights() {
  const cacheKey = state.dashboardMonth || 'all';
  delete state.insightsCache[cacheKey];
  document.getElementById('insights-refresh-btn').style.display = 'none';
  document.getElementById('insights-content').style.display = 'none';
  document.getElementById('insights-content').innerHTML = '';
  generateInsights();
}

function clearDashboardCaches() {
  state.anomaliesCache = {};
}

function clearAllCaches() {
  state.insightsCache = {};
  state.anomaliesCache = {};
  state.budgetInsight = {};
}

function toggleTrendView() {
  state.trendShowAll = !state.trendShowAll;
  renderDashboard();
}

function drillCategory(category) {
  clearFilterInputs();
  state.jumpToCategory = category;
  state.jumpToMonth = state.dashboardMonth; // carry the active month filter across
  state.groupByVendor = false;
  switchView('transactions');
}

function openUncategorizedModal() {
  const pool = state.dashboardMonth
    ? state.transactions.filter(t => t.date?.startsWith(state.dashboardMonth))
    : state.transactions;
  const merchants = [...new Set(pool.filter(t => !t.category).map(t => t.merchant))];
  if (merchants.length) showCategoryModal([], merchants);
}

// ---- Budget Tab ----
async function renderBudget() {
  try {
    const data = await api('GET', '/api/settings');
    state.budgets = data.budgets || {};
    state.monthlyBudget = data.monthlyBudget || 0;
  } catch {}

  const allMonths = [...new Set(state.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (!state.budgetMonth || !allMonths.includes(state.budgetMonth))
    state.budgetMonth = allMonths.includes(thisMonth) ? thisMonth : (allMonths[0] || thisMonth);

  const sel = document.getElementById('budget-month-select');
  if (sel) {
    sel.innerHTML = allMonths.map(m => {
      const [yr, mo] = m.split('-');
      const label = new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
      return `<option value="${m}"${m === state.budgetMonth ? ' selected' : ''}>${label}</option>`;
    }).join('');
  }

  renderBudgetPerformance();
}

async function renderBudgetPerformance({ skipAI = false } = {}) {
  state.editingIncomeId = null;
  state.addingIncome = false;
  state.editingExpenseId = null;
  state.addingExpense = false;
  state.editingBudgetTarget = false;
  try {
    const [inc, exp] = await Promise.all([
      api('GET', `/api/income/${state.budgetMonth}`),
      api('GET', `/api/expenses/${state.budgetMonth}`),
    ]);
    state.income[state.budgetMonth] = inc;
    state.expenses[state.budgetMonth] = exp;
  } catch {}
  renderBudgetOverview({ skipAI });
  renderBudgetBreakdown();
}

function renderBudgetOverview({ skipAI = false } = {}) {
  const month = state.budgetMonth;
  const incomeSources = state.income[month] || [];
  const fixedExpenses = state.expenses[month] || [];
  const txns = state.transactions.filter(t => t.date?.startsWith(month));

  const totalIncome = incomeSources.reduce((s, e) => s + e.amount, 0);
  const fixedTotal = fixedExpenses.reduce((s, e) => s + e.amount, 0);
  const ccSpent = txns.reduce((s, t) => s + t.amount, 0);
  const totalSpent = fixedTotal + ccSpent;
  const net = totalIncome - totalSpent;
  const hasIncome = incomeSources.length > 0;

  const monthlyBudget = state.monthlyBudget;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [yr, mo] = (month || thisMonth).split('-');
  const daysInMonth = new Date(+yr, +mo, 0).getDate();
  const isCurrentMonth = month === thisMonth;
  const dayOfMonth = isCurrentMonth ? new Date().getDate() : daysInMonth;

  const el = document.getElementById('bud-overview-content');
  if (!el) return;

  // ---- Income rows ----
  const incomeRowsHtml = incomeSources.map(src => state.editingIncomeId === src.id ? `
    <div class="bud-edit-row">
      <input class="bud-edit-label" type="text" id="inc-label-${src.id}" value="${esc(src.label)}" placeholder="e.g. Salary" />
      <div class="bud-edit-amount-wrap"><span class="bud-edit-dollar">$</span>
        <input class="bud-edit-amount" type="number" id="inc-amt-${src.id}" value="${src.amount}" min="0" step="1" />
      </div>
      <select class="bud-recur-select" id="inc-recur-${src.id}">
        <option value="recurring" ${src.recurring ? 'selected' : ''}>Every month</option>
        <option value="once"      ${!src.recurring ? 'selected' : ''}>This month</option>
      </select>
      <button class="btn btn-sm btn-primary" onclick="saveEditIncome('${src.id}')">Save</button>
      <button class="btn btn-sm btn-ghost" onclick="cancelEditIncome()">Cancel</button>
    </div>` : `
    <div class="bud-row">
      <span class="bud-row-name">${esc(src.label)}${src.recurring ? '<span class="bud-recur-badge">monthly</span>' : ''}</span>
      <span class="bud-row-actions">
        <button class="edit-btn" onclick="startEditIncome('${src.id}')" title="Edit">✏</button>
        <button class="delete-btn" onclick="deleteIncome('${src.id}')" title="Remove">🗑</button>
      </span>
      <span class="bud-row-dots"></span>
      <span class="bud-row-amount">${fmt(src.amount)}</span>
    </div>`).join('');

  const addIncomeHtml = state.addingIncome ? `
    <div class="bud-edit-row">
      <input class="bud-edit-label" type="text" id="inc-new-label" placeholder="e.g. Salary, Freelance…" />
      <div class="bud-edit-amount-wrap"><span class="bud-edit-dollar">$</span>
        <input class="bud-edit-amount" type="number" id="inc-new-amt" min="0" step="1" placeholder="0" />
      </div>
      <select class="bud-recur-select" id="inc-new-recur">
        <option value="recurring">Every month</option>
        <option value="once">This month</option>
      </select>
      <button class="btn btn-sm btn-primary" onclick="saveAddIncome()">Add</button>
      <button class="btn btn-sm btn-ghost" onclick="cancelAddIncome()">Cancel</button>
    </div>` : '';

  // ---- Fixed expense rows ----
  const expRowsHtml = fixedExpenses.map(src => state.editingExpenseId === src.id ? `
    <div class="bud-edit-row">
      <input class="bud-edit-label" type="text" id="exp-label-${src.id}" value="${esc(src.label)}" placeholder="e.g. Rent" />
      <div class="bud-edit-amount-wrap"><span class="bud-edit-dollar">$</span>
        <input class="bud-edit-amount" type="number" id="exp-amt-${src.id}" value="${src.amount}" min="0" step="1" />
      </div>
      <select class="bud-recur-select" id="exp-recur-${src.id}">
        <option value="recurring" ${src.recurring ? 'selected' : ''}>Every month</option>
        <option value="once"      ${!src.recurring ? 'selected' : ''}>This month</option>
      </select>
      <button class="btn btn-sm btn-primary" onclick="saveEditExpense('${src.id}')">Save</button>
      <button class="btn btn-sm btn-ghost" onclick="cancelEditExpense()">Cancel</button>
    </div>` : `
    <div class="bud-row">
      <span class="bud-row-name">${esc(src.label)}${src.recurring ? '<span class="bud-recur-badge">monthly</span>' : ''}</span>
      <span class="bud-row-actions">
        <button class="edit-btn" onclick="startEditExpense('${src.id}')" title="Edit">✏</button>
        <button class="delete-btn" onclick="deleteExpense('${src.id}')" title="Remove">🗑</button>
      </span>
      <span class="bud-row-dots"></span>
      <span class="bud-row-amount">${fmt(src.amount)}</span>
    </div>`).join('');

  const addExpHtml = state.addingExpense ? `
    <div class="bud-edit-row">
      <input class="bud-edit-label" type="text" id="exp-new-label" placeholder="e.g. Rent, Utilities, Netflix…" />
      <div class="bud-edit-amount-wrap"><span class="bud-edit-dollar">$</span>
        <input class="bud-edit-amount" type="number" id="exp-new-amt" min="0" step="1" placeholder="0" />
      </div>
      <select class="bud-recur-select" id="exp-new-recur">
        <option value="recurring">Every month</option>
        <option value="once">This month</option>
      </select>
      <button class="btn btn-sm btn-primary" onclick="saveAddExpense()">Add</button>
      <button class="btn btn-sm btn-ghost" onclick="cancelAddExpense()">Cancel</button>
    </div>` : '';

  // ---- CC row ----
  const ccRowHtml = txns.length || fixedExpenses.length ? `
    <div class="bud-row bud-row-cc">
      <span class="bud-row-name">Credit card${txns.length ? ` <span class="bud-cc-count">${txns.length} transactions</span>` : ''}</span>
      <span class="bud-row-dots"></span>
      <span class="bud-row-amount">${fmt(ccSpent)}</span>
    </div>` : '';

  // ---- Net callout ----
  let netHtml = '';
  if (hasIncome && (ccSpent > 0 || fixedTotal > 0)) {
    const positive = net >= 0;
    const pct = totalIncome > 0 ? Math.abs(Math.round(net / totalIncome * 100)) : 0;
    netHtml = `
      <div class="bud-net ${positive ? 'bud-net-pos' : 'bud-net-neg'}">
        <div class="bud-net-main">
          <span class="bud-net-label">${positive ? 'Saved this month' : 'Over income'}</span>
          <span class="bud-net-amount">${fmt(Math.abs(net))}</span>
        </div>
        <div class="bud-net-sub">${positive ? `${pct}% of income saved` : `Spent ${pct}% more than earned`}</div>
      </div>`;
  }

  // ---- Budget target + bar ----
  let targetHtml = '';
  if (state.editingBudgetTarget) {
    targetHtml = `
      <div class="bud-target-edit-wrap">
        <span class="bud-target-edit-lbl">Monthly spend target</span>
        <div class="bud-target-input-row">
          <span class="bud-edit-dollar">$</span>
          <input class="bud-target-input" type="number" id="budget-total-input" min="0" step="100"
            value="${monthlyBudget || ''}" placeholder="5000" />
          <button class="btn btn-sm btn-primary" onclick="saveMonthlyBudget()">Save</button>
          <button class="btn btn-sm btn-ghost" onclick="cancelBudgetTargetEdit()">Cancel</button>
        </div>
      </div>`;
  } else if (monthlyBudget > 0) {
    const pct = totalSpent / monthlyBudget;
    const barColor = pct > 1 ? '#dc2626' : pct > 0.85 ? '#f97316' : '#22c55e';
    const expectedPct = (dayOfMonth / daysInMonth * 100).toFixed(1);
    const remaining = monthlyBudget - totalSpent;
    const pace = isCurrentMonth && dayOfMonth > 0 ? totalSpent / dayOfMonth * daysInMonth : null;
    targetHtml = `
      <div class="bud-target-set">
        <div class="bud-target-hdr">
          <span class="bud-target-lbl">Spend target <strong>${fmt(monthlyBudget)}</strong>/mo</span>
          <button class="btn btn-xs btn-ghost" onclick="startBudgetTargetEdit()">Edit</button>
        </div>
        <div class="budget-track-bar-wrap" style="height:8px;margin:.55rem 0 .3rem">
          <div class="budget-track-bar-fill" style="width:0;background:${barColor}" data-w="${Math.min(pct * 100, 100).toFixed(1)}%"></div>
          ${isCurrentMonth ? `<div class="budget-expected-line" style="left:${expectedPct}%"></div>` : ''}
        </div>
        <div class="bud-target-meta">
          <span class="${pct > 1 ? 'bud-over-label' : ''}">${fmt(totalSpent)} spent · ${remaining >= 0 ? fmt(remaining) + ' left' : fmt(-remaining) + ' over'}</span>
          ${pace ? `<span>Day ${dayOfMonth}/${daysInMonth} · on pace for ${fmt(pace)}</span>` : ''}
        </div>
      </div>`;
  } else {
    targetHtml = `
      <div class="bud-target-empty">
        <button class="btn btn-sm btn-ghost" onclick="startBudgetTargetEdit()">+ Set a monthly spend target</button>
      </div>`;
  }

  // ---- AI insight section (manual trigger) ----
  const hasData = ccSpent > 0 || fixedTotal > 0;
  const cachedInsight = state.budgetInsight[month];
  let aiHtml = '';
  if (state.hasApiKey && hasData) {
    if (cachedInsight === 'loading') {
      aiHtml = `<div class="bud-ai-wrap"><span class="muted" style="font-size:.82rem">Analyzing your month…</span></div>`;
    } else if (cachedInsight) {
      aiHtml = `<div class="bud-ai-wrap">
        <div class="bud-ai-hdr">
          <span class="bud-ai-title">AI Insight <span class="ai-badge">AI</span></span>
          <button class="btn btn-xs btn-ghost" onclick="generateBudgetInsight()">Refresh</button>
        </div>
        <p class="bud-ai-text">${esc(cachedInsight)}</p>
      </div>`;
    } else {
      aiHtml = `<div class="bud-ai-wrap bud-ai-idle">
        <button class="bud-ai-gen-btn" onclick="generateBudgetInsight()">✦ Get AI insight <span class="ai-badge">AI</span></button>
      </div>`;
    }
  }

  el.innerHTML = `
    <div class="bud-section">
      <div class="bud-section-hdr">
        <span class="bud-section-title">Income</span>
        <button class="btn btn-sm btn-ghost bud-add-btn" onclick="startAddIncome()">+ Add</button>
      </div>
      ${incomeRowsHtml}
      ${addIncomeHtml}
      ${!incomeRowsHtml && !state.addingIncome ? `<p class="bud-empty-hint">Add your income sources to see your full picture.</p>` : ''}
      ${incomeSources.length ? `<div class="bud-subtotal"><span>Total income</span><span>${fmt(totalIncome)}</span></div>` : ''}
    </div>

    <div class="bud-divider"></div>

    <div class="bud-section">
      <div class="bud-section-hdr">
        <span class="bud-section-title">Spending</span>
        <button class="btn btn-sm btn-ghost bud-add-btn" onclick="startAddExpense()">+ Fixed expense</button>
      </div>
      ${expRowsHtml}
      ${addExpHtml}
      ${ccRowHtml}
      ${!ccRowHtml && !expRowsHtml && !state.addingExpense ? `<p class="bud-empty-hint">No transactions yet this month.</p>` : ''}
      <div class="bud-subtotal bud-subtotal-total"><span>Total spending</span><span>${fmt(totalSpent)}</span></div>
    </div>

    ${netHtml ? `<div class="bud-divider"></div>${netHtml}` : ''}

    <div class="bud-divider bud-divider-sm"></div>
    ${targetHtml}
    ${aiHtml}
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll('.budget-track-bar-fill[data-w]').forEach(b => { b.style.width = b.dataset.w; });
    if (state.addingIncome) document.getElementById('inc-new-label')?.focus();
    else if (state.addingExpense) document.getElementById('exp-new-label')?.focus();
    else if (state.editingBudgetTarget) document.getElementById('budget-total-input')?.focus();
  });
}

async function generateBudgetInsight() {
  const month = state.budgetMonth;
  state.budgetInsight[month] = 'loading';
  renderBudgetOverview({ skipAI: true });

  const incomeSources = state.income[month] || [];
  const fixedExpenses = state.expenses[month] || [];
  const txns = state.transactions.filter(t => t.date?.startsWith(month));
  const totalIncome = incomeSources.reduce((s, e) => s + e.amount, 0);
  const ccSpent = txns.reduce((s, t) => s + t.amount, 0);
  const catSpent = {};
  for (const t of txns) { const c = t.category || 'Uncategorized'; catSpent[c] = (catSpent[c] || 0) + t.amount; }

  try {
    const data = await api('POST', '/api/budget/insights', {
      month,
      totalSpent: ccSpent,
      monthlyBudget: state.monthlyBudget,
      categories: Object.entries(catSpent).sort((a, b) => b[1] - a[1]).map(([name, s]) => ({ name, spent: s, budget: state.budgets[name] || 0 })),
      totalIncome,
      manualExpenses: fixedExpenses.map(e => ({ label: e.label, amount: e.amount })),
    });
    state.budgetInsight[month] = data.insight || null;
  } catch {
    state.budgetInsight[month] = null;
  }
  renderBudgetOverview({ skipAI: true });
}

function renderBudgetBreakdown() {
  const month = state.budgetMonth;
  const txns = state.transactions.filter(t => t.date?.startsWith(month));
  const spent = {};
  for (const t of txns) { const cat = t.category || 'Uncategorized'; spent[cat] = (spent[cat] || 0) + t.amount; }
  const sortedCats = Object.entries(spent).sort((a, b) => b[1] - a[1]);
  const ccSpent = sortedCats.reduce((s, [, v]) => s + v, 0);

  const card = document.getElementById('bud-breakdown-card');
  const el = document.getElementById('bud-breakdown-content');
  if (!el) return;

  if (!sortedCats.length) {
    if (card) card.style.display = 'none';
    return;
  }
  if (card) card.style.display = '';

  const catRowsHtml = sortedCats.map(([cat, catSpent]) => {
    const catBudget = state.budgets[cat] || 0;
    const overCat = catBudget > 0 && catSpent > catBudget;
    const barW = (catSpent / ccSpent * 100).toFixed(1);
    const barColor = overCat ? '#dc2626' : categoryColor(cat);
    const pctLabel = (catSpent / ccSpent * 100).toFixed(0) + '%';
    return `<div class="budget-cat-row" onclick="jumpToBudgetCategory('${escAttr(cat)}')" title="View ${esc(cat)} transactions">
      <div class="budget-cat-row-label">
        <span class="budget-cat-dot" style="background:${categoryColor(cat)}"></span>
        <span class="budget-cat-row-name">${esc(cat)}</span>
        ${overCat ? `<span class="budget-cat-over-badge">+${fmt(catSpent - catBudget)}</span>` : ''}
      </div>
      <div class="budget-cat-row-bar-wrap">
        <div class="budget-cat-row-bar" style="width:0;background:${barColor};opacity:.85" data-w="${barW}%"></div>
      </div>
      <div class="budget-cat-row-amt">
        <span class="budget-cat-row-spent">${fmt(catSpent)}</span>
        ${catBudget > 0 ? `<span class="budget-cat-row-limit">/ ${fmt(catBudget)}</span>` : `<span class="budget-cat-row-pct">${pctLabel}</span>`}
      </div>
    </div>`;
  }).join('');

  const budgetFormHtml = CATEGORIES.map(cat => {
    const key = btoa(cat).replace(/=/g, '');
    const val = state.budgets[cat] || '';
    return `<div class="budget-row">
      <label class="budget-cat-label" for="budget-${key}">${esc(cat)}</label>
      <div class="budget-input-wrap">
        <span class="budget-dollar">$</span>
        <input type="number" class="budget-input" id="budget-${key}" min="0" step="1" placeholder="—" value="${val}" />
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <h2 class="card-title" style="margin-bottom:1.25rem">Spending Breakdown</h2>
    <div class="bud-breakdown-layout">
      <div class="bud-pie-wrap">${renderBudgetPieChart(sortedCats, ccSpent)}</div>
      <div class="bud-cat-list">${catRowsHtml}</div>
    </div>
    <details class="bud-limits-details">
      <summary class="budget-summary">Per-category limits <span class="muted" style="font-weight:400">(optional)</span></summary>
      <p class="muted" style="margin:.6rem 0 1rem;font-size:.82rem">Set a cap per category — any that go over will be flagged above.</p>
      <div class="budget-grid">${budgetFormHtml}</div>
      <div style="margin-top:1rem;display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="saveBudgets()">Save Limits</button>
        <button class="btn btn-secondary" onclick="suggestBudgets()">${state.hasApiKey ? 'AI Suggest' : 'Suggest from history'}</button>
        <span id="budget-suggest-status" class="muted" style="font-size:.8rem"></span>
      </div>
    </details>
  `;

  requestAnimationFrame(() => {
    document.querySelectorAll('.budget-cat-row-bar[data-w]').forEach(b => { b.style.width = b.dataset.w; });
  });
}

// Pie chart — budget variant (240px, no drill-down click)
function renderBudgetPieChart(slices, total) {
  if (!slices.length || total === 0) return '';
  const cx = 120, cy = 120, R = 105, r = 64, size = 240;

  if (slices.length === 1) {
    const color = categoryColor(slices[0][0]);
    const mid = (R + r) / 2, sw = R - r;
    const circ = +(2 * Math.PI * mid).toFixed(2);
    return `<svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;display:block;margin:0 auto">
      <circle cx="${cx}" cy="${cy}" r="${mid}" fill="none" stroke="${color}" stroke-width="${sw}" opacity=".9"
        stroke-dasharray="${circ}" stroke-dashoffset="${circ}" transform="rotate(-90 ${cx} ${cy})">
        <animate attributeName="stroke-dashoffset" from="${circ}" to="0" dur=".65s" fill="freeze"
          calcMode="spline" keyTimes="0;1" keySplines=".25,.1,.25,1"/>
      </circle>
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="11" fill="#64748b">Total</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="17" font-weight="700" fill="#1e293b">${fmt(total)}</text>
    </svg>`;
  }

  const svgId = `bpie-${Date.now()}`;
  const sliceInfo = slices.map(([cat, amt]) => ({ cat, amt, pct: amt / total, color: categoryColor(cat) }));
  const pathsHtml = sliceInfo.map((s, i) =>
    `<path data-i="${i}" data-pct="${s.pct}" fill="${s.color}" opacity=".9">
      <title>${esc(s.cat)}: ${fmt(s.amt)} (${Math.round(s.pct * 100)}%)</title>
    </path>`
  ).join('');

  requestAnimationFrame(() => {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    const paths = [...svg.querySelectorAll('path[data-pct]')];
    const t0 = performance.now(), dur = 700;
    function frame(now) {
      const raw = Math.min((now - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - raw, 3);
      const progress = ease * 2 * Math.PI;
      let startAngle = -Math.PI / 2, cumAngle = 0;
      paths.forEach(path => {
        const pct = +path.dataset.pct;
        const full = pct * 2 * Math.PI;
        const drawn = Math.max(0, Math.min(full, progress - cumAngle));
        cumAngle += full;
        if (drawn < 0.0001) { path.setAttribute('d', ''); startAngle += full; return; }
        const end = startAngle + drawn;
        const large = drawn > Math.PI ? 1 : 0;
        const x1 = cx + R * Math.cos(startAngle), y1 = cy + R * Math.sin(startAngle);
        const x2 = cx + R * Math.cos(end),         y2 = cy + R * Math.sin(end);
        const x3 = cx + r * Math.cos(end),          y3 = cy + r * Math.sin(end);
        const x4 = cx + r * Math.cos(startAngle),   y4 = cy + r * Math.sin(startAngle);
        path.setAttribute('d',
          `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
          `L${x3.toFixed(2)} ${y3.toFixed(2)} A${r} ${r} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`
        );
        startAngle += full;
      });
      if (raw < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });

  return `<svg id="${svgId}" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;display:block;margin:0 auto">
    ${pathsHtml}
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="11" fill="#64748b">CC Spending</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="17" font-weight="700" fill="#1e293b">${fmt(total)}</text>
  </svg>`;
}

async function saveMonthlyBudget() {
  const val = parseFloat(document.getElementById('budget-total-input')?.value);
  if (isNaN(val) || val < 0) { showToast('Enter a valid amount', 'error'); return; }
  await api('POST', '/api/budget/monthly', { amount: val });
  state.monthlyBudget = val;
  state.editingBudgetTarget = false;
  renderBudgetOverview();
  showToast('Budget saved', 'success');
}

function startBudgetTargetEdit() { state.editingBudgetTarget = true; renderBudgetOverview({ skipAI: true }); }
function cancelBudgetTargetEdit() { state.editingBudgetTarget = false; renderBudgetOverview({ skipAI: true }); }

// ---- Income CRUD ----
function startAddIncome() { state.addingIncome = true; state.editingIncomeId = null; renderBudgetOverview({ skipAI: true }); }
function cancelAddIncome() { state.addingIncome = false; renderBudgetOverview({ skipAI: true }); }

async function saveAddIncome() {
  const label = document.getElementById('inc-new-label')?.value.trim();
  const amount = parseFloat(document.getElementById('inc-new-amt')?.value);
  const recurring = document.getElementById('inc-new-recur')?.value === 'recurring';
  if (!label || isNaN(amount) || amount < 0) { showToast('Enter a label and amount', 'error'); return; }
  const month = state.budgetMonth;
  const entry = await api('POST', `/api/income/${month}`, { label, amount, recurring });
  if (!state.income[month]) state.income[month] = [];
  state.income[month].push(entry);
  state.addingIncome = false;
  renderBudgetOverview({ skipAI: true });
}

function startEditIncome(id) { state.editingIncomeId = id; state.addingIncome = false; renderBudgetOverview({ skipAI: true }); }
function cancelEditIncome() { state.editingIncomeId = null; renderBudgetOverview({ skipAI: true }); }

async function saveEditIncome(id) {
  const label = document.getElementById(`inc-label-${id}`)?.value.trim();
  const amount = parseFloat(document.getElementById(`inc-amt-${id}`)?.value);
  const recurring = document.getElementById(`inc-recur-${id}`)?.value === 'recurring';
  if (!label || isNaN(amount) || amount < 0) { showToast('Enter a label and amount', 'error'); return; }
  const month = state.budgetMonth;
  const updated = await api('PUT', `/api/income/${month}/${id}`, { label, amount, recurring });
  const idx = (state.income[month] || []).findIndex(e => e.id === id);
  if (idx !== -1) state.income[month][idx] = updated;
  state.editingIncomeId = null;
  renderBudgetOverview({ skipAI: true });
}

async function deleteIncome(id) {
  const month = state.budgetMonth;
  await api('DELETE', `/api/income/${month}/${id}`);
  state.income[month] = (state.income[month] || []).filter(e => e.id !== id);
  renderBudgetOverview({ skipAI: true });
}

// ---- Fixed Expense CRUD ----
function startAddExpense() { state.addingExpense = true; state.editingExpenseId = null; renderBudgetOverview({ skipAI: true }); }
function cancelAddExpense() { state.addingExpense = false; renderBudgetOverview({ skipAI: true }); }

async function saveAddExpense() {
  const label = document.getElementById('exp-new-label')?.value.trim();
  const amount = parseFloat(document.getElementById('exp-new-amt')?.value);
  const recurring = document.getElementById('exp-new-recur')?.value === 'recurring';
  if (!label || isNaN(amount) || amount < 0) { showToast('Enter a label and amount', 'error'); return; }
  const month = state.budgetMonth;
  const entry = await api('POST', `/api/expenses/${month}`, { label, amount, recurring });
  if (!state.expenses[month]) state.expenses[month] = [];
  state.expenses[month].push(entry);
  state.addingExpense = false;
  renderBudgetOverview({ skipAI: true });
}

function startEditExpense(id) { state.editingExpenseId = id; state.addingExpense = false; renderBudgetOverview({ skipAI: true }); }
function cancelEditExpense() { state.editingExpenseId = null; renderBudgetOverview({ skipAI: true }); }

async function saveEditExpense(id) {
  const label = document.getElementById(`exp-label-${id}`)?.value.trim();
  const amount = parseFloat(document.getElementById(`exp-amt-${id}`)?.value);
  const recurring = document.getElementById(`exp-recur-${id}`)?.value === 'recurring';
  if (!label || isNaN(amount) || amount < 0) { showToast('Enter a label and amount', 'error'); return; }
  const month = state.budgetMonth;
  const updated = await api('PUT', `/api/expenses/${month}/${id}`, { label, amount, recurring });
  const idx = (state.expenses[month] || []).findIndex(e => e.id === id);
  if (idx !== -1) state.expenses[month][idx] = updated;
  state.editingExpenseId = null;
  renderBudgetOverview({ skipAI: true });
}

async function deleteExpense(id) {
  const month = state.budgetMonth;
  await api('DELETE', `/api/expenses/${month}/${id}`);
  state.expenses[month] = (state.expenses[month] || []).filter(e => e.id !== id);
  renderBudgetOverview({ skipAI: true });
}

// ---- Settings ----
async function renderSettings() {
  try {
    const data = await api('GET', '/api/settings');
    state.budgets = data.budgets || {};
    state.hasApiKey = !!data.hasApiKey;

    const el = document.getElementById('settings-key-status');
    if (el) {
      el.innerHTML = data.hasApiKey
        ? `<span class="key-status set">✓ AI enabled</span>`
        : `<span class="key-status free">No key set</span>`;
    }

    const cardsEl = document.getElementById('cards-list');
    if (cardsEl) {
      const cards = [...new Set(state.transactions.map(t => t.card).filter(Boolean))].sort();
      if (!cards.length) {
        cardsEl.innerHTML = '<p class="muted">No cards yet. Enter a nickname when uploading a statement.</p>';
      } else {
        cardsEl.innerHTML = cards.map((c, i) => `
          <div class="card-rename-row">
            <input type="text" id="card-rename-${i}" value="${esc(c)}" style="flex:1;min-width:0" />
            <button class="btn btn-sm btn-primary" onclick="renameCard('${esc(c)}',${i})">Rename</button>
          </div>`).join('');
      }
    }

    const locationEl = document.getElementById('settings-location');
    if (locationEl && data.location) locationEl.value = data.location;
    const locationStatus = document.getElementById('location-status');
    if (locationStatus) {
      locationStatus.innerHTML = data.location
        ? `<span class="key-status set">✓ Location set: ${esc(data.location)}</span>`
        : `<span class="key-status unset">No location set — web search uses global results</span>`;
    }

  } catch {}
}

async function saveBudgets() {
  const budgets = {};
  CATEGORIES.forEach(cat => {
    const key = btoa(cat).replace(/=/g, '');
    const val = parseFloat(document.getElementById(`budget-${key}`)?.value);
    if (!isNaN(val) && val > 0) budgets[cat] = val;
  });
  try {
    await api('POST', '/api/budgets', { budgets });
    state.budgets = budgets;
    showToast('Budgets saved!', 'success');
    if (state.currentView === 'dashboard') renderDashboard();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

async function identifyMerchant(txnId) {
  const txn = state.transactions.find(t => t.id === txnId);
  if (!txn) return;
  const btn = document.getElementById(`identify-btn-${txnId}`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const data = await api('POST', '/api/identify-merchant', {
      merchant: txn.merchant,
      rawMerchant: txn.rawSource || txn.merchant,
    });
    if (data.category) {
      await api('PUT', `/api/transactions/${txnId}`, { category: data.category });
      txn.category = data.category;
      await api('POST', '/api/merchants', { merchant: txn.merchant, category: data.category });
      state.merchants = await api('GET', '/api/merchants');
      state.txVersion++;
      renderTransactions();
      if (state.currentView === 'dashboard') { clearDashboardCaches(); renderDashboard(); }
      showToast(`Identified as ${data.name} · category set to "${data.category}"`, 'success');
    } else {
      showToast(`Identified as ${data.name} — no category found`, 'info');
    }
  } catch (err) {
    showToast('Could not identify merchant: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍'; }
  }
}

async function suggestBudgets() {
  const statusEl = document.getElementById('budget-suggest-status');
  if (statusEl) statusEl.textContent = state.hasApiKey ? 'Asking AI…' : 'Calculating…';
  try {
    const data = await api('POST', '/api/budgets/suggest', {});
    const suggestions = data.suggestions || {};
    if (!Object.keys(suggestions).length) {
      if (statusEl) statusEl.textContent = 'Not enough history yet.';
      return;
    }
    CATEGORIES.forEach(cat => {
      const key = btoa(cat).replace(/=/g, '');
      const input = document.getElementById(`budget-${key}`);
      if (input && suggestions[cat]) input.value = suggestions[cat];
    });
    if (statusEl) statusEl.textContent = data.aiUsed ? 'AI suggestions from full history — adjust and save.' : 'Suggestions from full history — adjust and save.';
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Could not load suggestions.';
  }
}

async function saveSettings() {
  const key = document.getElementById('settings-api-key')?.value.trim();
  if (!key) { showToast('Please enter an API key', 'error'); return; }
  try {
    await api('POST', '/api/settings', { anthropicApiKey: key });
    document.getElementById('settings-api-key').value = '';
    showToast('API key saved!', 'success');
    renderSettings();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

async function renameCard(oldName, idx) {
  const newName = document.getElementById(`card-rename-${idx}`)?.value.trim();
  if (!newName || newName === oldName) return;
  try {
    await api('POST', '/api/cards/rename', { oldName, newName });
    await loadAll();
    renderSettings();
    showToast('Card renamed!', 'success');
  } catch (err) {
    showToast('Could not rename: ' + err.message, 'error');
  }
}

async function saveLocation() {
  const location = document.getElementById('settings-location')?.value.trim() || '';
  try {
    await api('POST', '/api/location', { location });
    showToast('Location saved!', 'success');
    renderSettings();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

// ---- Transactions ----
function getFiltered() {
  const cat = document.getElementById('filter-category')?.value || '';
  const merchant = (document.getElementById('filter-merchant')?.value || '').toLowerCase();
  const card = document.getElementById('filter-card')?.value || '';
  const from = document.getElementById('filter-date-from')?.value || '';
  const to = document.getElementById('filter-date-to')?.value || '';

  return state.transactions.filter(t => {
    if (cat === '__uncategorized__' && t.category) return false;
    if (cat && cat !== '__uncategorized__' && (t.category || '') !== cat) return false;
    if (merchant && !t.merchant.toLowerCase().includes(merchant) && !(t.notes || '').toLowerCase().includes(merchant)) return false;
    if (card && (t.card || '') !== card) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    return true;
  });
}

function getSorted(rows) {
  const { col, dir } = state.sort;
  return [...rows].sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    if (col === 'amount') { va = +va; vb = +vb; }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function renderTransactions() {
  populateFilterDropdowns();

  // Apply merchant filter jump (from Top Merchants widget)
  if (state.merchantFilter !== null) {
    const merchantEl = document.getElementById('filter-merchant');
    if (merchantEl) merchantEl.value = state.merchantFilter;
    state.merchantFilter = null;
  }

  // Apply month jump (from drillCategory) to the date inputs now that the select is populated
  if (state.jumpToMonth !== null) {
    const month = state.jumpToMonth;
    state.jumpToMonth = null;
    const fromEl = document.getElementById('filter-date-from');
    const toEl = document.getElementById('filter-date-to');
    if (!month) {
      fromEl.value = '';
      toEl.value = '';
    } else {
      const [yr, mo] = month.split('-').map(Number);
      fromEl.value = `${month}-01`;
      toEl.value = `${month}-${String(new Date(yr, mo, 0).getDate()).padStart(2, '0')}`;
    }
  }

  const filtered = getSorted(getFiltered());
  const tbody = document.getElementById('transactions-body');
  const empty = document.getElementById('transactions-empty');
  const table = document.getElementById('transactions-table');
  const countEl = document.getElementById('txn-count');
  const totalEl = document.getElementById('txn-total');

  const runningTotal = filtered.reduce((s, t) => s + t.amount, 0);
  countEl.textContent = `${filtered.length} transaction${filtered.length !== 1 ? 's' : ''}`;
  if (totalEl) totalEl.textContent = filtered.length ? fmt(runningTotal) : '';

  // Update group toggle button appearance
  const groupBtn = document.getElementById('group-toggle');
  if (groupBtn) {
    groupBtn.textContent = state.groupByVendor ? 'Show individual' : 'Group by vendor';
    groupBtn.classList.toggle('btn-active', state.groupByVendor);
  }

  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    table.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  table.style.display = '';

  if (state.groupByVendor) {
    const groups = {};
    for (const t of filtered) {
      if (!groups[t.merchant]) {
        groups[t.merchant] = { merchant: t.merchant, amount: 0, count: 0, category: t.category || null, txns: [] };
      }
      groups[t.merchant].amount += t.amount;
      groups[t.merchant].count++;
      groups[t.merchant].txns.push(t);
      if (!groups[t.merchant].category && t.category) groups[t.merchant].category = t.category;
    }

    const rows = Object.values(groups).sort((a, b) => b.amount - a.amount);
    tbody.innerHTML = rows.map(g => {
      const cat = g.category || '';
      const color = categoryColor(cat || 'Uncategorized');
      const expanded = state.expandedMerchants.has(g.merchant);
      const arrow = expanded ? '▾' : '▸';

      const groupRow = `
        <tr class="vendor-group-row" onclick="toggleVendorGroup('${escAttr(g.merchant)}')">
          <td class="vendor-count">${arrow} ${g.count}×</td>
          <td style="font-weight:600">
            <span class="merchant-link" onclick="event.stopPropagation();goToMerchant('${escAttr(g.merchant)}')">${esc(g.merchant)}</span>
          </td>
          <td><span class="amount" style="${g.amount < 0 ? 'color:var(--success)' : ''}">${fmt(g.amount)}</span></td>
          <td>
            <span class="category-badge ${cat ? '' : 'uncategorized'}"
              style="${cat ? `background:${color}18;color:${color}` : ''}"
              onclick="event.stopPropagation();openCategoryPopupForMerchant(event,'${escAttr(g.merchant)}')">
              ${cat ? `<span class="category-dot" style="background:${color}"></span>` : ''}
              ${esc(cat || '+ Add category')}
            </span>
          </td>
          <td>
            <div class="row-actions">
              <button class="edit-btn" onclick="event.stopPropagation();renameVendorGroup('${escAttr(g.merchant)}')" title="Rename all">✏</button>
              <button class="delete-btn" onclick="event.stopPropagation();deleteVendorGroup('${escAttr(g.merchant)}',${g.count})" title="Delete all">🗑</button>
            </div>
          </td>
        </tr>`;

      const detailRows = expanded ? g.txns
        .slice().sort((a, b) => b.date.localeCompare(a.date))
        .map(t => {
          const tc = t.category || '';
          const tc_color = categoryColor(tc || 'Uncategorized');
          return `
            <tr class="vendor-detail-row">
              <td class="vendor-detail-date">${fmtDate(t.date)}</td>
              <td>
                ${t.notes ? `<span class="txn-note">${esc(t.notes)}</span>` : ''}
                ${t.card ? `<span class="txn-card-badge">${esc(t.card)}</span>` : ''}
              </td>
              <td><span class="amount" style="font-size:.85rem;${t.amount < 0 ? 'color:var(--success)' : ''}">${fmt(t.amount)}</span></td>
              <td>
                <span class="category-badge ${tc ? '' : 'uncategorized'}"
                  style="${tc ? `background:${tc_color}18;color:${tc_color}` : ''}"
                  onclick="event.stopPropagation();openCategoryPopup(event,'${t.id}')">
                  ${tc ? `<span class="category-dot" style="background:${tc_color}"></span>` : ''}
                  ${esc(tc || '+ Add category')}
                </span>
              </td>
              <td>
                <div class="row-actions">
                  ${(!tc || tc === 'Unknown') && state.hasApiKey ? `<button class="identify-btn" id="identify-btn-${t.id}" onclick="event.stopPropagation();identifyMerchant('${t.id}')" title="Identify with AI">🔍</button>` : ''}
                  <button class="edit-btn" onclick="event.stopPropagation();openEditModal('${t.id}')" title="Edit">✏</button>
                  <button class="delete-btn" onclick="event.stopPropagation();deleteTransactionById('${t.id}')" title="Delete">🗑</button>
                </div>
              </td>
            </tr>`;
        }).join('') : '';

      return groupRow + detailRows;
    }).join('');
  } else {
    // Individual rows
    tbody.innerHTML = filtered.map(t => {
      const cat = t.category || '';
      const color = categoryColor(cat || 'Uncategorized');
      const badgeClass = cat ? '' : 'uncategorized';
      const badgeText = cat || '+ Add category';
      return `
        <tr>
          <td>${fmtDate(t.date)}</td>
          <td>
            <div><span class="merchant-link" onclick="goToMerchant('${escAttr(t.merchant)}')">${esc(t.merchant)}</span></div>
            ${t.notes ? `<div class="txn-note">${esc(t.notes)}</div>` : ''}
            ${t.card ? `<div class="txn-card-badge">${esc(t.card)}</div>` : ''}
          </td>
          <td><span class="amount" style="${t.amount < 0 ? 'color:var(--success)' : ''}">${fmt(t.amount)}</span></td>
          <td>
            <div style="display:flex;align-items:center;gap:.4rem">
              <span class="category-badge ${badgeClass}"
                style="${cat ? `background:${color}18;color:${color}` : ''}"
                onclick="openCategoryPopup(event, '${t.id}')">
                ${cat ? `<span class="category-dot" style="background:${color}"></span>` : ''}
                ${esc(badgeText)}
              </span>
              ${(!cat || cat === 'Unknown') && state.hasApiKey ? `<button class="identify-btn" id="identify-btn-${t.id}" onclick="identifyMerchant('${t.id}')" title="Identify with AI">🔍</button>` : ''}
            </div>
          </td>
          <td>
            <div class="row-actions">
              <button class="edit-btn" onclick="openEditModal('${t.id}')" title="Edit">✏</button>
              <button class="delete-btn" onclick="deleteTransactionById('${t.id}')" title="Delete">🗑</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    // Update sort arrows (flat view only)
    document.querySelectorAll('.sortable').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      if (!arrow) return;
      if (th.dataset.col === state.sort.col) {
        arrow.textContent = state.sort.dir === 'asc' ? ' ↑' : ' ↓';
        th.classList.add('sort-active');
      } else {
        arrow.textContent = ' ↕';
        th.classList.remove('sort-active');
      }
    });
  }
}

function toggleGroup() {
  state.groupByVendor = !state.groupByVendor;
  state.expandedMerchants.clear();
  renderTransactions();
}

function toggleVendorGroup(merchant) {
  if (state.expandedMerchants.has(merchant)) {
    state.expandedMerchants.delete(merchant);
  } else {
    state.expandedMerchants.add(merchant);
  }
  renderTransactions();
}

async function renameVendorGroup(merchant) {
  const newName = prompt(`Rename all transactions from "${merchant}" to:`, merchant)?.trim();
  if (!newName || newName === merchant) return;
  try {
    await api('POST', '/api/merchants/rename', { oldName: merchant, newName });
    for (const t of state.transactions) {
      if (t.merchant === merchant) t.merchant = newName;
    }
    if (state.merchants[merchant] !== undefined) {
      state.merchants[newName] = state.merchants[merchant];
      delete state.merchants[merchant];
    }
    state.txVersion++;
    renderTransactions();
    showToast('Merchant renamed across all transactions', 'success');
  } catch (err) {
    showToast('Could not rename: ' + err.message, 'error');
  }
}

async function deleteVendorGroup(merchant, count) {
  if (!confirm(`Delete all ${count} transaction${count !== 1 ? 's' : ''} from "${merchant}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/transactions?merchant=${encodeURIComponent(merchant)}`);
    state.transactions = state.transactions.filter(t => t.merchant !== merchant);
    state.txVersion++;
    renderTransactions();
    if (state.currentView === 'dashboard') { clearDashboardCaches(); renderDashboard(); }
    showToast(`${count} transaction${count !== 1 ? 's' : ''} deleted`, 'success');
  } catch (err) {
    showToast('Could not delete: ' + err.message, 'error');
  }
}

function populateFilterDropdowns() {
  if (state._dropdownVersion === state.txVersion && state.jumpToCategory === null) return; // data unchanged, skip rebuild
  state._dropdownVersion = state.txVersion;

  const cats = [...new Set(state.transactions.map(t => t.category).filter(Boolean))].sort();
  const months = [...new Set(state.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  const cards = [...new Set(state.transactions.map(t => t.card).filter(Boolean))].sort();

  const catSel = document.getElementById('filter-category');
  const curCat = state.jumpToCategory !== null ? state.jumpToCategory : catSel.value;
  state.jumpToCategory = null;
  catSel.innerHTML = `<option value="">All Categories</option>` +
    cats.map(c => `<option value="${esc(c)}" ${c === curCat ? 'selected' : ''}>${esc(c)}</option>`).join('') +
    `<option value="__uncategorized__" ${curCat === '__uncategorized__' ? 'selected' : ''}>Uncategorized</option>`;
  catSel.value = curCat || '';

  const monthSel = document.getElementById('filter-month');
  if (monthSel) {
    const curMonth = state.jumpToMonth !== null ? state.jumpToMonth : monthSel.value;
    monthSel.innerHTML = `<option value="">Any time</option>` +
      months.map(m => {
        const [yr, mo] = m.split('-');
        const label = new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
        return `<option value="${m}" ${m === curMonth ? 'selected' : ''}>${label}</option>`;
      }).join('');
  }

  const cardSel = document.getElementById('filter-card');
  if (cardSel) {
    const curCard = cardSel.value;
    cardSel.innerHTML = `<option value="">All cards</option>` +
      cards.map(c => `<option value="${esc(c)}" ${c === curCard ? 'selected' : ''}>${esc(c)}</option>`).join('');
  }
}

function onMonthFilterSelect() {
  const month = document.getElementById('filter-month')?.value;
  const fromEl = document.getElementById('filter-date-from');
  const toEl = document.getElementById('filter-date-to');
  if (!month) {
    fromEl.value = '';
    toEl.value = '';
  } else {
    const [yr, mo] = month.split('-').map(Number);
    fromEl.value = `${month}-01`;
    const lastDay = new Date(yr, mo, 0).getDate();
    toEl.value = `${month}-${String(lastDay).padStart(2, '0')}`;
  }
  renderTransactions();
}

function onDateRangeChange() {
  // When user picks a custom date range, clear the month quick-select
  const monthSel = document.getElementById('filter-month');
  if (monthSel) monthSel.value = '';
  renderTransactions();
}

// Reset all filter inputs to blank (shared by clearFilters and dashboard drills)
function clearFilterInputs() {
  document.getElementById('filter-category').value = '';
  document.getElementById('filter-merchant').value = '';
  document.getElementById('filter-month').value = '';
  document.getElementById('filter-card').value = '';
  document.getElementById('filter-date-from').value = '';
  document.getElementById('filter-date-to').value = '';
}

function clearFilters() {
  clearFilterInputs();
  renderTransactions();
}

// Sort clicks
document.querySelectorAll('.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (state.sort.col === col) {
      state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort.col = col;
      state.sort.dir = col === 'date' || col === 'amount' ? 'desc' : 'asc';
    }
    renderTransactions();
  });
});

// Filter inputs
const debouncedRender = debounce(renderTransactions, 180);
document.getElementById('filter-merchant')?.addEventListener('input', debouncedRender);
['filter-category', 'filter-card'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', renderTransactions);
});

// Date inputs — clear month quick-select when user types a custom date
const dateHandler = debounce(() => {
  const ms = document.getElementById('filter-month');
  if (ms) ms.value = '';
  renderTransactions();
}, 180);
['filter-date-from', 'filter-date-to'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', dateHandler);
});

// ---- Category Popup ----
let popupTxnId = null;
let popupMerchant = null;

function openCategoryPopup(e, txnId) {
  e.stopPropagation();
  popupTxnId = txnId;

  const txn = state.transactions.find(t => t.id === txnId);
  const popup = document.getElementById('category-popup');
  const sel = document.getElementById('category-popup-select');

  sel.innerHTML = `<option value="">-- Select category --</option>` +
    CATEGORIES.map(c => `<option value="${esc(c)}" ${txn?.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('') +
    `<option value="__custom__">+ Custom…</option>`;

  const anchor = e.currentTarget || e.target.closest('.category-badge') || e.target;
  const rect = anchor.getBoundingClientRect();
  popup.style.top = (rect.bottom + 6) + 'px';
  popup.style.left = rect.left + 'px';
  // Retrigger animation each open
  popup.style.animation = 'none';
  popup.style.display = 'flex';
  void popup.offsetWidth; // force reflow
  popup.style.animation = '';
}

function closeCategoryPopup() {
  document.getElementById('category-popup').style.display = 'none';
  popupTxnId = null;
  popupMerchant = null;
}

function openCategoryPopupForMerchant(e, merchant) {
  e.stopPropagation();
  popupTxnId = null;
  popupMerchant = merchant;

  const existing = state.merchants[merchant] || state.transactions.find(t => t.merchant === merchant)?.category || '';
  const popup = document.getElementById('category-popup');
  const sel = document.getElementById('category-popup-select');

  sel.innerHTML = `<option value="">-- Select category --</option>` +
    CATEGORIES.map(c => `<option value="${esc(c)}" ${c === existing ? 'selected' : ''}>${esc(c)}</option>`).join('') +
    `<option value="__custom__">+ Custom…</option>`;

  const anchor = e.currentTarget || e.target.closest('.category-badge') || e.target;
  const rect = anchor.getBoundingClientRect();
  popup.style.top = (rect.bottom + 6) + 'px';
  popup.style.left = rect.left + 'px';
  popup.style.animation = 'none';
  popup.style.display = 'flex';
  void popup.offsetWidth;
  popup.style.animation = '';
}

async function saveCategoryPopup() {
  let cat = document.getElementById('category-popup-select').value;
  if (!cat) { closeCategoryPopup(); return; }

  if (cat === '__custom__') {
    cat = prompt('Enter custom category name:')?.trim();
    if (!cat) return;
  }

  if (popupMerchant) {
    // Vendor-group mode: apply category to all transactions for this merchant
    const merchant = popupMerchant;
    closeCategoryPopup();
    await api('POST', '/api/merchants', { merchant, category: cat });
    state.merchants = await api('GET', '/api/merchants');
    // Update all local transactions for immediate UI consistency
    let count = 0;
    for (const t of state.transactions) {
      if (t.merchant === merchant) { t.category = cat; count++; }
    }
    state.txVersion++;
    renderTransactions();
    showToast(`Category set for ${count} transaction${count !== 1 ? 's' : ''}!`, 'success');
  } else {
    await api('PUT', `/api/transactions/${popupTxnId}`, { category: cat });
    const txn = state.transactions.find(t => t.id === popupTxnId);
    if (txn) { txn.category = cat; state.txVersion++; }
    if (txn) await api('POST', '/api/merchants', { merchant: txn.merchant, category: cat });
    state.merchants = await api('GET', '/api/merchants');
    closeCategoryPopup();
    renderTransactions();
    showToast('Category saved!', 'success');
  }
}

document.addEventListener('click', e => {
  if (!document.getElementById('category-popup').contains(e.target)) {
    closeCategoryPopup();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeCategoryPopup();
    closeEditModal();
  }
});

// ---- Edit / Add Transaction Modal ----
function _populateCategorySelect(currentCategory) {
  const sel = document.getElementById('edit-category');
  sel.innerHTML = '<option value="">— Uncategorized —</option>' +
    CATEGORIES.map(c => `<option value="${c}"${c === currentCategory ? ' selected' : ''}>${c}</option>`).join('');
}

function openAddModal() {
  state.editingTxnId = null;
  state.addingTransaction = true;
  document.getElementById('edit-modal-title').textContent = 'Add Transaction';
  document.getElementById('edit-modal-subtitle').textContent = 'Enter the details for a new transaction.';
  document.getElementById('edit-merchant').value = '';
  document.getElementById('edit-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('edit-amount').value = '';
  document.getElementById('edit-notes').value = '';
  _populateCategorySelect('');
  document.getElementById('edit-modal-overlay').style.display = 'flex';
  document.getElementById('edit-merchant').focus();
}

function openEditModal(txnId) {
  const txn = state.transactions.find(t => t.id === txnId);
  if (!txn) return;
  state.editingTxnId = txnId;
  state.addingTransaction = false;
  document.getElementById('edit-modal-title').textContent = 'Edit Transaction';
  document.getElementById('edit-modal-subtitle').textContent = 'Fix parsing errors or add a personal note.';
  document.getElementById('edit-merchant').value = txn.merchant || '';
  document.getElementById('edit-date').value = txn.date || '';
  document.getElementById('edit-amount').value = txn.amount || '';
  document.getElementById('edit-notes').value = txn.notes || '';
  _populateCategorySelect(txn.category || '');
  document.getElementById('edit-modal-overlay').style.display = 'flex';
  document.getElementById('edit-merchant').focus();
}

function closeEditModal() {
  const overlay = document.getElementById('edit-modal-overlay');
  overlay.classList.add('closing');
  setTimeout(() => {
    overlay.style.display = 'none';
    overlay.classList.remove('closing');
    state.editingTxnId = null;
    state.addingTransaction = false;
  }, 200);
}

async function saveEditModal() {
  const merchant = document.getElementById('edit-merchant').value.trim();
  const date = document.getElementById('edit-date').value;
  const amount = parseFloat(document.getElementById('edit-amount').value);
  const category = document.getElementById('edit-category').value || null;
  const notes = document.getElementById('edit-notes').value.trim();
  if (!merchant || !date || isNaN(amount)) {
    showToast('Merchant, date, and amount are required', 'error');
    return;
  }
  if (state.addingTransaction) {
    const newTxn = await api('POST', '/api/transactions', { merchant, date, amount, category, notes });
    state.transactions.push(newTxn);
    state.txVersion++;
    closeEditModal();
    renderTransactions();
    clearDashboardCaches();
    renderDashboard();
    showToast('Transaction added', 'success');
    return;
  }
  const txnId = state.editingTxnId;
  if (!txnId) return;
  await api('PUT', `/api/transactions/${txnId}`, { merchant, date, amount, category, notes });
  const txn = state.transactions.find(t => t.id === txnId);
  if (txn) { Object.assign(txn, { merchant, date, amount, category, notes }); state.txVersion++; }
  closeEditModal();
  clearDashboardCaches();
  renderTransactions();
  showToast('Transaction updated', 'success');
}

async function deleteTransaction() {
  const txnId = state.editingTxnId;
  if (!txnId) return;
  if (!confirm('Delete this transaction? This cannot be undone.')) return;
  await api('DELETE', `/api/transactions/${txnId}`);
  state.transactions = state.transactions.filter(t => t.id !== txnId);
  state.txVersion++;
  clearDashboardCaches();
  closeEditModal();
  renderTransactions();
  showToast('Transaction deleted', 'success');
}

async function deleteTransactionById(id) {
  if (!confirm('Delete this transaction? This cannot be undone.')) return;
  await api('DELETE', `/api/transactions/${id}`);
  state.transactions = state.transactions.filter(t => t.id !== id);
  state.txVersion++;
  clearDashboardCaches();
  renderTransactions();
  if (state.currentView === 'dashboard') renderDashboard();
  showToast('Transaction deleted', 'success');
}

function exportCSV() {
  const filtered = getSorted(getFiltered());
  if (!filtered.length) { showToast('No transactions to export', 'error'); return; }
  const rows = [
    ['Date', 'Merchant', 'Amount', 'Category', 'Card', 'Notes'],
    ...filtered.map(t => [
      t.date || '',
      `"${(t.merchant || '').replace(/"/g, '""')}"`,
      t.amount.toFixed(2),
      `"${(t.category || '').replace(/"/g, '""')}"`,
      `"${(t.card || '').replace(/"/g, '""')}"`,
      `"${(t.notes || '').replace(/"/g, '""')}"`,
    ]),
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderTopMerchants(txns) {
  const el = document.getElementById('top-merchants');
  if (!el) return;
  const totals = {};
  for (const t of txns) {
    totals[t.merchant] = (totals[t.merchant] || 0) + t.amount;
  }
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!top.length) {
    el.innerHTML = '<p class="muted" style="font-size:.85rem">No data</p>';
    return;
  }
  el.innerHTML = top.map(([merchant, amt]) => `
    <div class="top-merchant-row" onclick="jumpToMerchant('${escAttr(merchant)}')" title="View ${esc(merchant)} transactions">
      <div class="top-merchant-name">${esc(merchant)}</div>
      <div class="top-merchant-amt">${fmt(amt)}</div>
    </div>
  `).join('');
}

function jumpToMerchant(merchant) {
  clearFilterInputs();
  state.merchantFilter = merchant;
  state.jumpToMonth = state.dashboardMonth;
  switchView('transactions');
}

function jumpToBudgetCategory(cat) {
  clearFilterInputs();
  state.jumpToCategory = cat;
  state.jumpToMonth = state.budgetMonth;
  switchView('transactions');
}

function renderRecurring() {
  const merchantMonths = {};
  const merchantTotals = {};
  for (const t of state.transactions) {
    const m = t.date?.slice(0, 7);
    if (!m) continue;
    if (!merchantMonths[t.merchant]) { merchantMonths[t.merchant] = new Set(); merchantTotals[t.merchant] = 0; }
    merchantMonths[t.merchant].add(m);
    merchantTotals[t.merchant] += t.amount;
  }
  const recurring = Object.entries(merchantMonths)
    .filter(([, months]) => months.size >= 3)
    .map(([merchant, months]) => ({ merchant, months: months.size, avg: merchantTotals[merchant] / months.size }))
    .sort((a, b) => b.avg - a.avg);

  const card = document.getElementById('recurring-card');
  const list = document.getElementById('recurring-list');
  if (!card || !list) return;
  if (!recurring.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  list.innerHTML = recurring.map(r => `
    <div class="recurring-row">
      <div class="recurring-merchant">${esc(r.merchant)}</div>
      <div class="recurring-meta">
        <span class="recurring-months">${r.months} months</span>
        <span class="recurring-avg">${fmt(r.avg)}/mo avg</span>
      </div>
    </div>
  `).join('');
}

// ---- Upload ----
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');

let pendingFile = null;

function showPendingUpload(file) {
  pendingFile = file;
  document.getElementById('pending-upload-filename').textContent = `📄 ${file.name}`;
  document.getElementById('pending-upload-panel').style.display = '';
  document.getElementById('upload-zone').style.display = 'none';
  document.getElementById('upload-result').style.display = 'none';
  document.getElementById('statement-name-input').value = '';
  document.getElementById('card-name-input').value = '';
}

function cancelPendingUpload() {
  pendingFile = null;
  document.getElementById('pending-upload-panel').style.display = 'none';
  document.getElementById('upload-zone').style.display = '';
  fileInput.value = '';
}

function startUpload() {
  if (!pendingFile) return;
  document.getElementById('pending-upload-panel').style.display = 'none';
  document.getElementById('upload-zone').style.display = 'none';
  uploadFile(pendingFile);
  pendingFile = null;
}

uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) showPendingUpload(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) showPendingUpload(fileInput.files[0]);
  fileInput.value = '';
});

async function uploadFile(file) {
  const resultEl = document.getElementById('upload-result');
  resultEl.style.display = '';

  const showProgress = (pct, msg) => {
    if (!resultEl.querySelector('.progress-bar-fill')) {
      resultEl.innerHTML = `
        <div class="upload-progress-label"></div>
        <div class="progress-bar-wrap" style="margin-top:.5rem">
          <div class="progress-bar-fill" style="width:0%"></div>
        </div>`;
    }
    resultEl.querySelector('.upload-progress-label').textContent = msg;
    requestAnimationFrame(() => {
      const bar = resultEl.querySelector('.progress-bar-fill');
      if (bar) bar.style.width = pct + '%';
    });
  };

  showProgress(5, `Uploading ${file.name}…`);

  const form = new FormData();
  form.append('file', file);
  const cardName = document.getElementById('card-name-input')?.value.trim() || '';
  const statementName = document.getElementById('statement-name-input')?.value.trim() || '';
  if (cardName) form.append('cardName', cardName);
  if (statementName) form.append('statementName', statementName);

  let uploadId;
  try {
    const res = await fetch('/api/upload/start', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) { resultEl.innerHTML = `<div class="result-error">❌ ${esc(data.error)}</div>`; return; }
    uploadId = data.uploadId;
  } catch (err) {
    resultEl.innerHTML = `<div class="result-error">❌ ${esc(err.message)}</div>`;
    return;
  }

  showProgress(10, 'Processing…');

  const es = new EventSource(`/api/upload/stream/${uploadId}`);

  es.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    if (data.done || data.error) {
      es.close();
      if (data.error) {
        resultEl.innerHTML = `<div class="result-error">❌ ${esc(data.message)}</div>`;
        return;
      }

      const { imported, duplicates, suggestions, unknownMerchants } = data.result;
      const unknowns = unknownMerchants || [];
      const suggs = suggestions || [];

      resultEl.innerHTML = `
        <div class="result-success">✅ Successfully imported <strong>${imported}</strong> transaction${imported !== 1 ? 's' : ''}</div>
        <div class="upload-stats">
          <div class="upload-stat"><div class="stat-label">Imported</div><div class="stat-value">${imported}</div></div>
          <div class="upload-stat"><div class="stat-label">Duplicates skipped</div><div class="stat-value">${duplicates}</div></div>
          ${suggs.length ? `<div class="upload-stat"><div class="stat-label">AI suggestions</div><div class="stat-value">${suggs.length}</div></div>` : ''}
          <div class="upload-stat"><div class="stat-label">Needs input</div><div class="stat-value">${unknowns.length}</div></div>
        </div>`;

      clearAllCaches();
      await loadAll();
      if (suggs.length + unknowns.length > 0) showCategoryModal(suggs, unknowns);
      else showToast('Import complete!', 'success');
    } else {
      showProgress(data.progress, data.message);
    }
  };

  es.onerror = () => {
    es.close();
    resultEl.innerHTML = `<div class="result-error">❌ Upload failed — check the server is running.</div>`;
  };
}

async function removePayments() {
  const btn = document.getElementById('payments-btn');
  if (btn) btn.disabled = true;
  try {
    const { removed } = await api('POST', '/api/cleanup/payments');
    await loadAll();
    showToast(removed > 0 ? `${removed} payment${removed !== 1 ? 's' : ''} removed.` : 'No payments found.', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function normalizeNames() {
  const btn = document.getElementById('normalize-btn');
  if (btn) btn.disabled = true;
  try {
    const { updated } = await api('POST', '/api/cleanup/normalize');
    await loadAll();
    showToast(updated > 0 ? `${updated} name${updated !== 1 ? 's' : ''} normalized.` : 'All names already clean.', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function aiDeduplicate() {
  const btn = document.getElementById('dedup-btn');
  const statusEl = document.getElementById('cleanup-status');
  const barEl = document.getElementById('cleanup-bar');
  const msgEl = document.getElementById('cleanup-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  if (statusEl) statusEl.style.display = '';
  if (barEl) barEl.style.width = '5%';
  if (msgEl) msgEl.textContent = 'Analyzing merchant names…';

  let fakeP = 5;
  const ticker = setInterval(() => {
    fakeP = Math.min(fakeP + Math.random() * 9, 85);
    if (barEl) barEl.style.width = fakeP + '%';
  }, 700);

  try {
    const { merged, mapping } = await api('POST', '/api/cleanup/ai-deduplicate');
    clearInterval(ticker);
    if (barEl) barEl.style.width = '100%';
    if (msgEl) msgEl.textContent = 'Complete!';
    await loadAll();
    if (merged > 0) {
      const count = Object.keys(mapping).length;
      showToast(`Merged ${count} duplicate merchant${count !== 1 ? 's' : ''} (${merged} transaction${merged !== 1 ? 's' : ''} updated).`, 'success');
    } else {
      showToast('No duplicates found — names look clean!', 'success');
    }
  } catch (err) {
    clearInterval(ticker);
    showToast('Smart Clean failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Smart Clean'; }
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 800);
  }
}

function runAICategorize() {
  const statusEl = document.getElementById('cleanup-status');
  const barEl = document.getElementById('cleanup-bar');
  const msgEl = document.getElementById('cleanup-msg');
  const btn = document.getElementById('categorize-btn');

  if (statusEl) statusEl.style.display = '';
  if (btn) btn.disabled = true;

  const setProgress = (pct, msg) => {
    if (barEl) barEl.style.width = pct + '%';
    if (msgEl) msgEl.textContent = msg;
  };

  setProgress(0, 'Starting…');

  const es = new EventSource('/api/cleanup/categorize/stream');

  es.onmessage = async (e) => {
    const data = JSON.parse(e.data);
    setProgress(data.progress, data.message);

    if (data.done || data.error) {
      es.close();
      if (btn) btn.disabled = false;

      if (data.error) {
        if (statusEl) statusEl.style.display = 'none';
        showToast('AI categorization failed: ' + data.message, 'error');
        return;
      }

      await loadAll();
      setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 800);

      const { autoUpdated, suggestions, unknownMerchants } = data.result;
      showToast(autoUpdated > 0 ? `${autoUpdated} transaction${autoUpdated !== 1 ? 's' : ''} categorized.` : 'Nothing new to categorize.', 'success');

      const needsReview = (suggestions?.length || 0) + (unknownMerchants?.length || 0);
      if (needsReview) showCategoryModal(suggestions || [], unknownMerchants || []);
    }
  };

  es.onerror = () => {
    es.close();
    if (btn) btn.disabled = false;
    if (statusEl) statusEl.style.display = 'none';
    showToast('AI categorization failed — check the server is running.', 'error');
  };
}

async function renderSources() {
  const sources = await api('GET', '/api/sources');
  const card = document.getElementById('sources-card');
  const list = document.getElementById('sources-list');

  if (!sources.length) {
    card.style.display = 'none';
    return;
  }

  // Populate card suggestions datalist on upload form
  const allCards = [...new Set(state.transactions.map(t => t.card).filter(Boolean))].sort();
  const dl = document.getElementById('card-suggestions');
  if (dl) dl.innerHTML = allCards.map(c => `<option value="${esc(c)}">`).join('');

  // Compute current card per source
  const sourceCards = {};
  for (const s of sources) {
    const cards = [...new Set(state.transactions.filter(t => t.source === s).map(t => t.card).filter(Boolean))];
    sourceCards[s] = cards.length === 1 ? cards[0] : '';
  }

  card.style.display = '';
  list.innerHTML = sources.map((s, i) => `
    <li class="source-item">
      <div class="source-edit-row">
        <div class="source-edit-fields">
          <input type="text" class="source-name-input" id="src-name-${i}" value="${esc(s)}" placeholder="Statement name" />
          <input type="text" class="source-card-input" id="src-card-${i}" value="${esc(sourceCards[s])}" placeholder="Card (optional)" list="card-suggestions" />
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-primary" onclick="saveSource('${escAttr(s)}', ${i})">Save</button>
          <button class="btn btn-sm btn-danger" onclick="deleteSource('${escAttr(s)}')">Remove</button>
        </div>
      </div>
    </li>
  `).join('');
}

async function saveSource(oldName, idx) {
  const newName = document.getElementById(`src-name-${idx}`)?.value.trim();
  const card = document.getElementById(`src-card-${idx}`)?.value.trim();
  if (!newName) { showToast('Statement name cannot be empty', 'error'); return; }
  await api('POST', '/api/sources/update', { oldName, newName, card });
  await loadAll();
  renderSources();
  showToast('Statement updated', 'success');
}

async function deleteSource(source) {
  if (!confirm(`Remove all transactions from "${source}"?`)) return;
  try {
    await api('DELETE', `/api/transactions?source=${encodeURIComponent(source)}`);
    clearAllCaches();
    await loadAll();
    await renderSources();
    renderDashboard();
    showToast('File removed', 'success');
  } catch (e) {
    showToast('Failed to remove statement', 'error');
  }
}

// ---- Category Modal ----

function confidenceColor(conf) {
  if (conf >= 0.85) return '#22c55e';
  if (conf >= 0.70) return '#f97316';
  return '#eab308';
}

function showCategoryModal(suggestions, unknowns) {
  state.pendingItems = { suggestions, unknowns };

  const titleEl = document.getElementById('modal-header-title');
  if (titleEl) titleEl.textContent = suggestions.length ? 'Review New Merchants' : 'Categorize New Merchants';

  const parts = [];
  if (suggestions.length) parts.push(`${suggestions.length} AI suggestion${suggestions.length !== 1 ? 's' : ''}`);
  if (unknowns.length) parts.push(`${unknowns.length} need${unknowns.length === 1 ? 's' : ''} your input`);
  document.getElementById('modal-subtitle').textContent = parts.join(' · ');

  let html = '';

  if (suggestions.length) {
    html += `<div class="modal-section-title">AI Suggestions <span class="modal-count">${suggestions.length}</span></div>`;
    suggestions.forEach((s, i) => {
      html += `
        <div class="suggestion-row" id="suggest-row-${i}" data-status="pending">
          <div class="suggestion-top">
            <div class="suggestion-merchant" title="${esc(s.merchant)}">${esc(s.merchant)}</div>
            <div class="suggestion-controls">
              <span class="ai-category-pill">
                <span class="confidence-dot" style="background:${confidenceColor(s.confidence)}" title="${Math.round(s.confidence * 100)}% confident"></span>
                ${esc(s.category)}
              </span>
              <button class="btn btn-sm btn-confirm" id="suggest-confirm-${i}" onclick="confirmSuggestion(${i})">✓ Looks right</button>
              <button class="btn btn-sm btn-secondary" onclick="editSuggestion(${i})">Change</button>
            </div>
          </div>
          <div class="suggestion-edit" id="suggest-edit-${i}" style="display:none">
            <input type="text" id="suggest-text-${i}"
              placeholder="Describe this charge (e.g. gas, grocery, streaming…)"
              oninput="onSuggestionTextInput(${i})"
              class="category-text-input" />
            <select id="suggest-cat-${i}">
              ${CATEGORIES.map(c => `<option value="${esc(c)}" ${c === s.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              <option value="__custom__">+ Custom…</option>
            </select>
          </div>
        </div>`;
    });
  }

  if (unknowns.length) {
    if (suggestions.length) html += `<div class="modal-spacer"></div>`;
    html += `<div class="modal-section-title">Needs Your Input <span class="modal-count">${unknowns.length}</span></div>`;
    unknowns.forEach((m, i) => {
      html += `
        <div class="unknown-row">
          <div class="merchant-name">${esc(m)}</div>
          <input type="text" id="modal-text-${i}"
            placeholder="What is this? (e.g. 'gas', 'grocery store', 'streaming service')"
            oninput="onCategoryTextInput(${i})"
            class="category-text-input" />
          <div class="cat-or-label">or pick a category:</div>
          <select id="modal-cat-${i}" data-merchant="${esc(m)}">
            <option value="">-- Select category --</option>
            ${CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
            <option value="__custom__">+ Custom…</option>
          </select>
        </div>`;
    });
  }

  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('closing');
  setTimeout(() => {
    overlay.style.display = 'none';
    overlay.classList.remove('closing');
    state.pendingMerchants = [];
    state.pendingItems = { suggestions: [], unknowns: [] };
  }, 200);
}

// ---- Suggestion row interactions ----

function confirmSuggestion(i) {
  const row = document.getElementById(`suggest-row-${i}`);
  if (!row) return;
  row.dataset.status = 'confirmed';

  const btn = document.getElementById(`suggest-confirm-${i}`);
  if (btn) {
    btn.textContent = '✓ Confirmed';
    btn.className = 'btn btn-sm btn-confirmed';
    btn.disabled = true;
    const changeBtn = btn.nextElementSibling;
    if (changeBtn) changeBtn.style.display = 'none';
  }
}

function editSuggestion(i) {
  const row = document.getElementById(`suggest-row-${i}`);
  if (!row) return;
  row.dataset.status = 'editing';
  const editDiv = document.getElementById(`suggest-edit-${i}`);
  if (editDiv) { editDiv.style.display = 'flex'; }
  document.getElementById(`suggest-text-${i}`)?.focus();
}

// ---- Debounced text-to-category ----

const _suggestionTimers = {};
const _unknownTimers = {};

function onSuggestionTextInput(i) {
  clearTimeout(_suggestionTimers[i]);
  const text = document.getElementById(`suggest-text-${i}`)?.value.trim();
  if (!text || text.length < 2) return;
  const merchant = state.pendingItems.suggestions[i]?.merchant;

  _suggestionTimers[i] = setTimeout(async () => {
    try {
      const data = await api('POST', '/api/text-to-category', { text, merchant });
      if (data.category) {
        const sel = document.getElementById(`suggest-cat-${i}`);
        if (sel) sel.value = data.category;
      }
    } catch {}
  }, 420);
}

function onCategoryTextInput(i) {
  clearTimeout(_unknownTimers[i]);
  const text = document.getElementById(`modal-text-${i}`)?.value.trim();
  if (!text || text.length < 2) return;
  const merchant = state.pendingItems.unknowns[i];

  _unknownTimers[i] = setTimeout(async () => {
    try {
      const data = await api('POST', '/api/text-to-category', { text, merchant });
      if (data.category) {
        const sel = document.getElementById(`modal-cat-${i}`);
        if (sel) sel.value = data.category;
      }
    } catch {}
  }, 420);
}

async function saveCategories() {
  const mappings = [];
  const { suggestions, unknowns } = state.pendingItems;

  // Collect AI suggestion rows
  suggestions.forEach((s, i) => {
    const row = document.getElementById(`suggest-row-${i}`);
    const editSel = document.getElementById(`suggest-cat-${i}`);
    // If user chose to edit, use their edit dropdown; otherwise accept AI's suggestion
    const category = (row?.dataset.status === 'editing' && editSel)
      ? editSel.value
      : s.category;
    if (category && category !== '__custom__') {
      mappings.push({ merchant: s.merchant, category });
    } else if (category === '__custom__') {
      const custom = prompt(`Custom category for "${s.merchant}":`)?.trim();
      if (custom) mappings.push({ merchant: s.merchant, category: custom });
    }
  });

  // Collect unknown rows
  unknowns.forEach((m, i) => {
    let cat = document.getElementById(`modal-cat-${i}`)?.value;
    if (cat === '__custom__') {
      cat = prompt(`Custom category for "${m}":`)?.trim() || '';
    }
    if (cat) mappings.push({ merchant: m, category: cat });
  });

  if (!mappings.length) { closeModal(); return; }

  await api('POST', '/api/merchants/bulk', { mappings });
  await loadAll();

  closeModal();
  showToast(`${mappings.length} merchant${mappings.length !== 1 ? 's' : ''} categorized!`, 'success');

  if (state.currentView === 'transactions') renderTransactions();
  if (state.currentView === 'dashboard') renderDashboard();
}

// ---- Merchants view ----
function renderMerchants() {
  const entries = Object.entries(state.merchants);
  const search = (document.getElementById('merchant-search')?.value || '').toLowerCase();
  const filtered = search ? entries.filter(([m]) => typeof m === 'string' && m.toLowerCase().includes(search)) : entries;

  const txnCounts = {};
  for (const t of state.transactions) {
    txnCounts[t.merchant] = (txnCounts[t.merchant] || 0) + 1;
  }

  const { col, dir } = state.merchantSort;
  filtered.sort((a, b) => {
    let av, bv;
    if (col === 'name') { av = a[0].toLowerCase(); bv = b[0].toLowerCase(); }
    else if (col === 'category') { av = (a[1] || '').toLowerCase(); bv = (b[1] || '').toLowerCase(); }
    else if (col === 'count') { av = txnCounts[a[0]] || 0; bv = txnCounts[b[0]] || 0; }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  // Update sort arrows
  ['name', 'category', 'count'].forEach(c => {
    const el = document.getElementById(`msort-${c}`);
    if (!el) return;
    const th = el.closest('th');
    if (col === c) {
      el.textContent = dir === 'asc' ? ' ↑' : ' ↓';
      th?.classList.add('msort-active');
    } else {
      el.textContent = ' ↕';
      th?.classList.remove('msort-active');
    }
  });

  const empty = document.getElementById('merchants-empty');
  const table = document.getElementById('merchants-table');
  const tbody = document.getElementById('merchants-body');

  if (!filtered.length) {
    empty.style.display = '';
    empty.querySelector('p').textContent = search ? `No merchants match "${search}"` : 'No merchants saved yet. Upload a statement to get started.';
    table.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  table.style.display = '';

  tbody.innerHTML = filtered.map(([merchant, category], idx) => {
    const color = categoryColor(category);
    const count = txnCounts[merchant] || 0;
    return `
      <tr>
        <td>${esc(merchant)}${count ? ` <span class="merchant-count">${count}</span>` : ''}</td>
        <td>
          <span class="category-badge" style="background:${color}18;color:${color}">
            <span class="category-dot" style="background:${color}"></span>
            ${esc(category)}
          </span>
        </td>
        <td>${count}</td>
        <td>
          <div style="display:flex;gap:.4rem;align-items:center">
            <button class="btn btn-sm btn-secondary" onclick="showMerchantChart('${escAttr(merchant)}')" title="View spend history">📈</button>
            <select id="medit-${idx}" class="merchant-edit-select" style="display:inline-block">
              ${CATEGORIES.map(c => `<option value="${esc(c)}" ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select>
            <button class="btn btn-sm btn-secondary" onclick="saveMerchantEdit('${escAttr(merchant)}', ${idx})">Save</button>
            <button class="btn btn-sm btn-danger" onclick="deleteMerchant('${escAttr(merchant)}')">Delete</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

document.getElementById('merchant-search').addEventListener('input', debounce(renderMerchants, 180));

function goToMerchant(merchant) {
  switchView('merchants');
  const search = document.getElementById('merchant-search');
  if (search) { search.value = merchant; }
  renderMerchants();
}

function fmtShort(amt) {
  if (amt >= 1000) return '$' + (amt / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '$' + Math.round(amt);
}

function showMerchantChart(merchant) {
  const monthly = {};
  for (const t of state.transactions) {
    if (t.merchant !== merchant || t.amount <= 0) continue;
    const m = t.date?.slice(0, 7);
    if (m) monthly[m] = (monthly[m] || 0) + t.amount;
  }
  const months = Object.keys(monthly).sort();
  if (!months.length) return;

  const maxAmt = Math.max(...months.map(m => monthly[m]));
  const color = categoryColor(state.merchants[merchant] || 'Other');
  const total = months.reduce((s, m) => s + monthly[m], 0);
  const avg = total / months.length;

  // SVG dimensions
  const svgW = 500, svgH = 230;
  const padL = 58, padR = 12, padT = 16, padB = 44;
  const cW = svgW - padL - padR;
  const cH = svgH - padT - padB;

  // Y axis gridlines + labels (5 levels)
  const steps = 4;
  const grid = Array.from({ length: steps + 1 }, (_, i) => {
    const y = padT + (i / steps) * cH;
    const val = maxAmt * (1 - i / steps);
    return `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${svgW - padR}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>
      <text x="${padL - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#94a3b8">${fmtShort(val)}</text>`;
  }).join('');

  // Axes
  const axes = `
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + cH}" stroke="#cbd5e1" stroke-width="1.5"/>
    <line x1="${padL}" y1="${padT + cH}" x2="${svgW - padR}" y2="${padT + cH}" stroke="#cbd5e1" stroke-width="1.5"/>`;

  // Bars + x labels
  const barW = cW / months.length;
  const barPad = Math.max(barW * 0.25, 4);
  const bars = months.map((m, i) => {
    const [yr, mo] = m.split('-');
    const label = new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'short' }) + " '" + String(yr).slice(2);
    const barH = Math.max((monthly[m] / maxAmt) * cH, 2);
    const x = padL + i * barW + barPad / 2;
    const y = padT + cH - barH;
    const w = barW - barPad;
    const cx = padL + i * barW + barW / 2;
    const delay = (i * 0.05).toFixed(2);
    const bottom = (padT + cH).toFixed(1);
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="3" opacity="0.9">
        <animate attributeName="height" from="0" to="${barH.toFixed(1)}" dur=".45s" begin="${delay}s" calcMode="spline" keyTimes="0;1" keySplines=".25,1,.5,1" fill="freeze"/>
        <animate attributeName="y" from="${bottom}" to="${y.toFixed(1)}" dur=".45s" begin="${delay}s" calcMode="spline" keyTimes="0;1" keySplines=".25,1,.5,1" fill="freeze"/>
      </rect>
      <text x="${cx.toFixed(1)}" y="${(svgH - padB + 16).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="#64748b">${label}</text>`;
  }).join('');

  const svg = `<svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;height:auto;display:block">${grid}${axes}${bars}</svg>`;

  document.getElementById('mcht-modal-title').textContent = merchant;
  document.getElementById('mcht-modal-sub').textContent = `${fmt(total)} total · ${fmt(avg)}/mo avg · ${months.length} month${months.length !== 1 ? 's' : ''}`;
  document.getElementById('mcht-modal-chart').innerHTML = svg;
  document.getElementById('merchant-chart-overlay').style.display = 'flex';
}

function closeMerchantChart() {
  const overlay = document.getElementById('merchant-chart-overlay');
  overlay.classList.add('closing');
  setTimeout(() => { overlay.style.display = 'none'; overlay.classList.remove('closing'); }, 200);
}

document.querySelectorAll('.m-sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (state.merchantSort.col === col) {
      state.merchantSort.dir = state.merchantSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.merchantSort.col = col;
      state.merchantSort.dir = col === 'count' ? 'desc' : 'asc';
    }
    renderMerchants();
  });
});

async function saveMerchantEdit(merchant, key) {
  const cat = document.getElementById(`medit-${key}`)?.value;
  if (!cat) return;
  await api('POST', '/api/merchants', { merchant, category: cat });
  state.merchants = await api('GET', '/api/merchants');
  state.transactions = await api('GET', '/api/transactions');
  state.txVersion++;
  renderMerchants();
  showToast('Merchant updated', 'success');
}

async function deleteMerchant(merchant) {
  if (!confirm(`Remove saved category for "${merchant}"?`)) return;
  await api('DELETE', `/api/merchants/${encodeURIComponent(merchant)}`);
  state.merchants = await api('GET', '/api/merchants');
  renderMerchants();
  showToast('Merchant removed', 'success');
}

// ---- Toast ----
function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('removing');
    setTimeout(() => t.remove(), 220);
  }, 2600);
}

// ---- Escape HTML ----
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// For use inside HTML attribute values delimited by single quotes (e.g. onclick='...')
function escAttr(str) {
  return esc(str).replace(/'/g,'&#39;');
}

// ---- Init ----
(async () => {
  try {
    await loadAll();
  } catch (err) {
    const el = document.getElementById('dashboard-empty');
    if (el) el.innerHTML = `<p style="color:#ef4444;font-weight:600">Failed to load data — is the server running?<br><small>${esc(err.message)}</small></p>`;
  }
  renderDashboard();
})();
