// Dashboard view.

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

  const allMonths = [...new Set(state.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  if (state.dashboardMonth && !allMonths.includes(state.dashboardMonth)) state.dashboardMonth = '';
  document.getElementById('dashboard-filter-bar').innerHTML = html`
    <div class="dash-filter-row">
      <label class="dash-filter-label" for="dash-month-select">Period</label>
      <select id="dash-month-select" onchange="state.dashboardMonth=this.value;renderDashboard()">
        <option value="">All time</option>
        ${allMonths.map(m => html`<option value="${m}" ${m === state.dashboardMonth ? 'selected' : ''}>${fmtMonth(m)}</option>`)}
      </select>
    </div>`;

  const txns = state.dashboardMonth
    ? state.transactions.filter(t => t.date?.startsWith(state.dashboardMonth))
    : state.transactions;

  const total = txns.reduce((s, t) => s + t.amount, 0);
  const uncategorized = txns.filter(t => !t.category);
  const uncategorizedMerchants = new Set(uncategorized.map(t => t.merchant)).size;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthTotal = txns.filter(t => t.date?.startsWith(thisMonth)).reduce((s, t) => s + t.amount, 0);

  document.getElementById('summary-cards').innerHTML = html`
    <div class="summary-card">
      <div class="label">${state.dashboardMonth ? 'Period Total' : 'Total Spending'}</div>
      <div class="value">${fmt(total)}</div>
      <div class="sub">${plural(txns.length, 'transaction')}</div>
    </div>
    ${!state.dashboardMonth ? html`
    <div class="summary-card">
      <div class="label">This Month</div>
      <div class="value">${fmt(monthTotal)}</div>
      <div class="sub">${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}</div>
    </div>` : ''}`;

  const banner = document.getElementById('uncategorized-banner');
  if (uncategorized.length) {
    banner.style.display = '';
    banner.innerHTML = html`⚠️ <strong>${plural(uncategorizedMerchants, 'merchant')}</strong> uncategorized — <a href="#" class="categorize-link" onclick="openUncategorizedModal();return false">Categorize now →</a>`;
  } else {
    banner.style.display = 'none';
  }

  // Monthly trend (always all transactions, highlights the selected month)
  const monthTotals = {};
  for (const t of state.transactions) {
    const m = t.date?.slice(0, 7);
    if (m) monthTotals[m] = (monthTotals[m] || 0) + t.amount;
  }
  const allTrendMonths = Object.keys(monthTotals).sort();
  const trendMonths = state.trendShowAll ? allTrendMonths : allTrendMonths.slice(-6);
  const toggle = document.getElementById('trend-toggle');
  if (toggle) {
    toggle.textContent = state.trendShowAll ? 'Show recent' : 'Show all';
    toggle.style.display = allTrendMonths.length > 6 ? '' : 'none';
  }
  const trendMax = Math.max(...Object.values(monthTotals), 1);
  document.getElementById('trend-chart').innerHTML = html`${trendMonths.map(m => {
    const amt = monthTotals[m];
    const isSelected = m === state.dashboardMonth;
    return html`
      <div class="chart-row chart-clickable ${isSelected ? 'chart-row-selected' : ''}" onclick="state.dashboardMonth='${m}';renderDashboard()" title="${fmtMonth(m)}">
        <div class="chart-label">${fmtMonth(m, 'short')}</div>
        <div class="chart-bar-wrap">
          <div class="chart-bar ${isSelected ? 'chart-bar-selected' : 'chart-bar-muted'}" style="width:0" data-w="${(amt / trendMax * 100).toFixed(1)}%"></div>
        </div>
        <div class="chart-amount">${fmt(amt)}</div>
      </div>`;
  })}`;

  // Category breakdown, rows drill into the transactions list
  const catTotals = {};
  for (const t of txns) {
    if (t.amount <= 0) continue;
    const c = t.category || 'Uncategorized';
    catTotals[c] = (catTotals[c] || 0) + t.amount;
  }
  const sorted = Object.entries(catTotals).filter(([, amt]) => amt > 0).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;
  document.getElementById('pie-chart').innerHTML = donutChart({ slices: sorted, total: sorted.reduce((s, [, a]) => s + a, 0), onSliceClick: 'drillCategory' });
  document.getElementById('category-chart').innerHTML = html`${sorted.map(([cat, amt]) => {
    const budget = state.budgets[cat];
    const showBudget = state.dashboardMonth && budget;
    const pct = showBudget ? amt / budget : 1;
    let barColor = categoryColor(cat);
    let extra = '';
    if (showBudget) {
      if (pct > 1) { barColor = 'var(--danger)'; extra = html` <span class="budget-amt">/ ${fmt(budget)} ⚠ over</span>`; }
      else if (pct > .8) { barColor = 'var(--warning)'; extra = html` <span class="budget-amt">/ ${fmt(budget)}</span>`; }
      else extra = html` <span class="budget-amt">/ ${fmt(budget)}</span>`;
    }
    return html`
      <div class="chart-row chart-clickable" onclick="drillCategory('${escAttr(cat)}')" title="Click to see ${cat} transactions">
        <div class="chart-label">${cat}</div>
        <div class="chart-bar-wrap">
          <div class="chart-bar" style="width:0;background:${barColor}" data-w="${(amt / max * 100).toFixed(1)}%"></div>
        </div>
        <div class="chart-amount">${fmt(amt)}${extra}</div>
      </div>`;
  })}`;

  const recent = [...txns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  document.getElementById('recent-transactions').innerHTML = html`${recent.map(t => html`
    <div class="recent-row">
      <div>
        <div class="recent-merchant">${t.merchant}</div>
        <div class="recent-date">${fmtDate(t.date)}${t.pending ? html` <span class="txn-pending-badge">pending</span>` : ''}</div>
      </div>
      <div class="recent-amount">${amountHtml(t, { small: true })}</div>
    </div>`)}`;

  renderTopMerchants(txns);
  renderRecurring();
  renderAnomalies();
  renderInsights();

  requestAnimationFrame(() => {
    document.querySelectorAll('.chart-bar[data-w]').forEach(b => { b.style.width = b.dataset.w; });
  });
}

// ---- Anomalies ----
async function renderAnomalies() {
  const card = document.getElementById('anomalies-card');
  const list = document.getElementById('anomalies-list');
  if (!card || !list) return;
  const cacheKey = state.dashboardMonth || 'all';
  if (state.anomaliesCache[cacheKey] === undefined) {
    try {
      const params = state.dashboardMonth ? `?month=${state.dashboardMonth}` : '';
      const data = await api('GET', `/api/anomalies${params}`);
      state.anomaliesCache[cacheKey] = data.anomalies || [];
    } catch { state.anomaliesCache[cacheKey] = []; }
  }
  displayAnomalies(state.anomaliesCache[cacheKey]);
}

function anomalyKey(a) { return `${a.label}||${a.detail}`; }

function displayAnomalies(anomalies) {
  const card = document.getElementById('anomalies-card');
  const list = document.getElementById('anomalies-list');
  const visible = anomalies.filter(a => !state.dismissedAnomalies.has(anomalyKey(a)));
  if (!visible.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const typeIcon = { 'duplicate': '⚠️', 'new-merchant': '🆕', 'price-increase': '📈' };
  list.innerHTML = html`${visible.map((a, i) => html`
    <div class="anomaly-row" id="anomaly-row-${i}">
      <span class="anomaly-icon">${typeIcon[a.type] || '⚠️'}</span>
      <div style="flex:1">
        <span class="anomaly-label">${a.label}</span>
        <span class="anomaly-detail">${a.detail}</span>
      </div>
      <button class="anomaly-dismiss" onclick="dismissAnomaly(${i}, ${JSON.stringify(anomalyKey(a))})" title="Dismiss">Dismiss</button>
    </div>`)}`;
}

function dismissAnomaly(i, key) {
  state.dismissedAnomalies.add(key);
  savePrefs({ dismissedAnomalies: [...state.dismissedAnomalies] });
  document.getElementById(`anomaly-row-${i}`)?.remove();
  const card = document.getElementById('anomalies-card');
  if (card && !card.querySelector('.anomaly-row')) card.style.display = 'none';
}

// ---- Insights: local observations, plus an optional AI write-up ----
async function renderInsights() {
  const card = document.getElementById('insights-card');
  if (!card) return;
  card.style.display = '';
  const list = document.getElementById('insights-list');
  const cacheKey = state.dashboardMonth || 'all';
  if (!state.localInsightsCache[cacheKey]) {
    try {
      const params = state.dashboardMonth ? `?month=${state.dashboardMonth}` : '';
      state.localInsightsCache[cacheKey] = (await api('GET', `/api/insights/local${params}`)).insights || [];
    } catch { state.localInsightsCache[cacheKey] = []; }
  }
  const items = state.localInsightsCache[cacheKey];
  const actions = {
    'top-category': i => `drillCategory('${escAttr(i.category)}')`,
    'swing': i => `drillCategory('${escAttr(i.category)}')`,
    'largest': i => `jumpToMerchant('${escAttr(i.merchant)}')`,
    'uncategorized': () => 'openUncategorizedModal()',
    'total': i => i.month ? `state.dashboardMonth='${i.month}';renderDashboard()` : '',
  };
  list.innerHTML = items.length
    ? html`${items.map(i => {
        const action = actions[i.kind] ? actions[i.kind](i) : '';
        return html`<li class="insight-row ${action ? 'insight-clickable' : ''}" ${action ? raw(`onclick="${action}"`) : ''}>${i.text}</li>`;
      })}`
    : html`<li class="insight-row muted">Nothing to report yet.</li>`;
  renderAiInsight();
}

function renderAiInsight() {
  const wrap = document.getElementById('insights-ai');
  if (!wrap) return;
  const cacheKey = state.dashboardMonth || 'all';
  const cached = state.insightsCache[cacheKey];
  if (!state.hasApiKey) { wrap.innerHTML = ''; return; }
  if (cached === 'loading') {
    wrap.innerHTML = html`<div class="progress-bar-wrap"><div class="progress-bar-fill progress-indeterminate"></div></div><div class="progress-message">Writing a summary…</div>`;
  } else if (cached) {
    wrap.innerHTML = html`<div class="insights-content">${cached.split(/\n+/).filter(Boolean).map(p => html`<p>${p}</p>`)}</div>
      <button class="btn-link" onclick="generateInsights(true)">↺ Rewrite</button>`;
  } else {
    wrap.innerHTML = html`<button class="btn btn-secondary btn-sm" onclick="generateInsights()">✦ Write a summary <span class="ai-badge">AI</span></button>`;
  }
}

async function generateInsights(force = false) {
  const cacheKey = state.dashboardMonth || 'all';
  if (force) delete state.insightsCache[cacheKey];
  state.insightsCache[cacheKey] = 'loading';
  renderAiInsight();
  try {
    const data = await api('POST', '/api/insights', { month: state.dashboardMonth || '' });
    state.insightsCache[cacheKey] = data.summary || null;
  } catch (err) {
    state.insightsCache[cacheKey] = null;
    showToast('Could not write a summary: ' + err.message, 'error');
  }
  renderAiInsight();
}

function clearDashboardCaches() {
  state.anomaliesCache = {};
  state.localInsightsCache = {};
}

function clearAllCaches() {
  state.insightsCache = {};
  state.anomaliesCache = {};
  state.localInsightsCache = {};
  state.budgetInsight = {};
}

function toggleTrendView() {
  state.trendShowAll = !state.trendShowAll;
  renderDashboard();
}

function drillCategory(category) {
  clearFilterInputs();
  state.jumpToCategory = category;
  state.jumpToMonth = state.dashboardMonth;
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

// ---- Widgets ----
function renderTopMerchants(txns) {
  const el = document.getElementById('top-merchants');
  if (!el) return;
  const totals = {};
  for (const t of txns) totals[t.merchant] = (totals[t.merchant] || 0) + t.amount;
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6);
  el.innerHTML = top.length
    ? html`${top.map(([merchant, amt]) => html`
      <div class="top-merchant-row" onclick="jumpToMerchant('${escAttr(merchant)}')" title="View ${merchant} transactions">
        <div class="top-merchant-name">${merchant}</div>
        <div class="top-merchant-amt">${fmt(amt)}</div>
      </div>`)}`
    : html`<p class="muted" style="font-size:.85rem">No data</p>`;
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
  const card = document.getElementById('recurring-card');
  const list = document.getElementById('recurring-list');
  if (!card || !list) return;
  const merchantMonths = {};
  const merchantTotals = {};
  for (const t of state.transactions) {
    const m = t.date?.slice(0, 7);
    if (!m || t.amount <= 0) continue;
    if (!merchantMonths[t.merchant]) { merchantMonths[t.merchant] = new Set(); merchantTotals[t.merchant] = 0; }
    merchantMonths[t.merchant].add(m);
    merchantTotals[t.merchant] += t.amount;
  }
  const recurring = Object.entries(merchantMonths)
    .filter(([, months]) => months.size >= 3)
    .map(([merchant, months]) => ({ merchant, months: months.size, avg: merchantTotals[merchant] / months.size }))
    .sort((a, b) => b.avg - a.avg);
  if (!recurring.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  list.innerHTML = html`${recurring.map(r => html`
    <div class="recurring-row" onclick="jumpToMerchant('${escAttr(r.merchant)}')">
      <div class="recurring-merchant">${r.merchant}</div>
      <div class="recurring-meta">
        <span class="recurring-months">${r.months} months</span>
        <span class="recurring-avg">${fmt(r.avg)}/mo avg</span>
      </div>
    </div>`)}`;
}
