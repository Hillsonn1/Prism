// Dashboard view.

const prevMonthOf = m => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const spendOf = list => list.filter(t => t.amount > 0 && countsAsSpend(t)).reduce((s, t) => s + t.amount, 0);
// Spend per month for the six months ending at `month`, optionally for one category
function monthlySeries(month, category = null) {
  const months = monthsEndingAt(month, 6);
  const totals = Object.fromEntries(months.map(m => [m, 0]));
  for (const t of state.transactions) {
    const m = t.date?.slice(0, 7);
    if (!(m in totals) || t.amount <= 0 || !countsAsSpend(t)) continue;
    if (category && (t.category || 'Uncategorized') !== category) continue;
    totals[m] += t.amount;
  }
  return months.map(m => totals[m]);
}

// First visit lands on the current month (or the latest one with data)
function defaultDashboardMonth(allMonths) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (allMonths.includes(thisMonth)) return thisMonth;
  return allMonths[0] || '';
}

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
  if (state.dashboardMonth === undefined || (state.dashboardMonth && !allMonths.includes(state.dashboardMonth))) state.dashboardMonth = defaultDashboardMonth(allMonths);
  const month = state.dashboardMonth;
  document.getElementById('dashboard-filter-bar').innerHTML = html`
    <select id="dash-month-select" class="period-select" aria-label="Period" onchange="state.dashboardMonth=this.value;renderDashboard()">
      ${allMonths.map(m => html`<option value="${m}" ${m === month ? 'selected' : ''}>${fmtMonth(m)}</option>`)}
      <option value="" ${!month ? 'selected' : ''}>All time</option>
    </select>`;

  // Charts sweep in when the period changes; every other re-render paints in place
  const animate = state._dashDrawnKey !== (month || 'all');
  state._dashDrawnKey = month || 'all';

  const txns = month ? state.transactions.filter(t => t.date?.startsWith(month)) : state.transactions;
  const total = spendOf(txns);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const isCurrent = month === thisMonth;
  const uncategorized = txns.filter(t => !t.category);
  const catTotals = {};
  for (const t of txns) {
    if (t.amount <= 0 || !countsAsSpend(t)) continue;
    const c = t.category || 'Uncategorized';
    catTotals[c] = (catTotals[c] || 0) + t.amount;
  }
  const sorted = Object.entries(catTotals).filter(([, amt]) => amt > 0).sort((a, b) => b[1] - a[1]);
  const topCat = sorted.find(([c]) => c !== 'Uncategorized');

  // ---- Stat tiles ----
  const tiles = [];
  if (month) {
    const prior = spendOf(state.transactions.filter(t => t.date?.startsWith(prevMonthOf(month))));
    const delta = prior ? Math.round((total - prior) / prior * 100) : null;
    const target = state.monthlyBudget;
    tiles.push({
      label: isCurrent ? 'Spent so far' : 'Spent',
      value: fmt(total),
      sub: delta === null ? plural(txns.length, 'purchase')
        : html`<span class="${delta > 0 ? 'delta-up' : 'delta-down'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span> vs ${fmtMonth(prevMonthOf(month), 'short')}`,
      spark: monthlySeries(month),
      bar: target ? { pct: Math.min(total / target, 1), over: total > target, warn: total / target > 0.85, note: total > target ? `${fmt(total - target)} over the ${fmt(target)} target` : `${fmt(target - total)} left of ${fmt(target)}` } : null,
    });
    if (isCurrent) {
      const day = new Date().getDate();
      const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      tiles.push({ label: 'On pace for', value: fmt(day ? total / day * days : 0), sub: `Day ${day} of ${days} · ${fmt(total / Math.max(day, 1))} a day` });
    } else {
      tiles.push({ label: 'Purchases', value: String(txns.filter(t => t.amount > 0).length), sub: `${fmt(total / new Date(+month.slice(0, 4), +month.slice(5), 0).getDate())} a day` });
    }
  } else {
    const months = allMonths.length;
    tiles.push({ label: 'Total spent', value: fmt(total), sub: `${plural(months, 'month')} · ${plural(txns.length, 'purchase')}` });
    tiles.push({ label: 'Monthly average', value: fmt(total / Math.max(months, 1)), sub: 'across all months' });
  }
  tiles.push(topCat
    ? { label: 'Biggest category', value: topCat[0], sub: `${fmt(topCat[1])} · ${Math.round(topCat[1] / total * 100)}%`, small: true, action: `drillCategory('${escAttr(topCat[0])}')`, color: categoryColor(topCat[0]), spark: month ? monthlySeries(month, topCat[0]) : null }
    : { label: 'Biggest category', value: '—', sub: '' });
  const uncatMerchants = new Set(uncategorized.map(t => t.merchant)).size;
  // Only asks for attention when something needs it
  if (uncategorized.length) tiles.push({ label: 'Needs a category', value: String(uncategorized.length), sub: html`${plural(uncatMerchants, 'merchant')} · <b>categorize</b>`, action: 'openUncategorizedModal()', attention: true });

  document.getElementById('summary-cards').innerHTML = html`${tiles.map(t => statTile(t))}`;

  // ---- Category breakdown ----
  document.getElementById('category-note').textContent = month ? fmtMonth(month) : 'All time';
  const max = sorted[0]?.[1] || 1;
  document.getElementById('pie-chart').innerHTML = donutChart({ slices: sorted, total, onSliceClick: 'drillCategory', animate });
  document.getElementById('category-chart').innerHTML = html`${sorted.map(([cat, amt]) => {
    const budget = state.budgets[cat];
    const showBudget = month && budget;
    const pct = showBudget ? amt / budget : 1;
    let barColor = categoryColor(cat);
    let extra = '';
    if (showBudget) {
      if (pct > 1) { barColor = 'var(--danger)'; extra = html` <span class="budget-amt">/ ${fmt(budget)} over</span>`; }
      else if (pct > .8) { barColor = 'var(--warning)'; extra = html` <span class="budget-amt">/ ${fmt(budget)}</span>`; }
      else extra = html` <span class="budget-amt">/ ${fmt(budget)}</span>`;
    }
    const series = month ? monthlySeries(month, cat) : null;
    return html`
      <div class="chart-row chart-clickable" onclick="drillCategory('${escAttr(cat)}')" title="See ${cat} transactions">
        <div class="chart-label"><span class="chart-label-icon" style="color:${categoryColor(cat)}">${icon(categoryIcon(cat))}</span>${cat}</div>
        <div class="chart-bar-wrap"><div class="chart-bar" style="width:${animate ? 0 : (amt / max * 100).toFixed(1) + '%'};background:${barColor}" data-w="${(amt / max * 100).toFixed(1)}%"></div></div>
        ${series && series.filter(Boolean).length > 1 ? html`<span class="chart-spark" title="Last 6 months">${sparkline(series, { width: 48, height: 16, color: categoryColor(cat) })}</span>` : html`<span class="chart-spark"></span>`}
        <div class="chart-amount">${fmt(amt)}${extra}</div>
      </div>`;
  })}`;

  // ---- Month by month (all data, selected month highlighted) ----
  const monthTotals = {};
  for (const t of state.transactions) {
    const m = t.date?.slice(0, 7);
    if (m && t.amount > 0 && countsAsSpend(t)) monthTotals[m] = (monthTotals[m] || 0) + t.amount;
  }
  const allTrendMonths = Object.keys(monthTotals).sort();
  const trendMonths = state.trendShowAll ? allTrendMonths : allTrendMonths.slice(-6);
  const toggle = document.getElementById('trend-toggle');
  if (toggle) {
    toggle.textContent = state.trendShowAll ? 'Show recent' : `Show all ${allTrendMonths.length}`;
    toggle.style.display = allTrendMonths.length > 6 ? '' : 'none';
  }
  const trendMax = Math.max(...Object.values(monthTotals), 1);
  document.getElementById('trend-chart').innerHTML = html`${trendMonths.map(m => {
    const isSelected = m === month;
    return html`
      <div class="chart-row chart-clickable ${isSelected ? 'chart-row-selected' : ''}" onclick="state.dashboardMonth='${m}';renderDashboard()" title="${fmtMonth(m)}">
        <div class="chart-label">${fmtMonth(m, 'short')}</div>
        <div class="chart-bar-wrap"><div class="chart-bar ${isSelected ? 'chart-bar-selected' : 'chart-bar-muted'}" style="width:${animate ? 0 : (monthTotals[m] / trendMax * 100).toFixed(1) + '%'}" data-w="${(monthTotals[m] / trendMax * 100).toFixed(1)}%"></div></div>
        <div class="chart-amount">${fmt(monthTotals[m])}</div>
      </div>`;
  })}`;

  const recent = [...txns].sort((a, b) => b.date.localeCompare(a.date) || (b.importedAt || '').localeCompare(a.importedAt || '')).slice(0, 7);
  document.getElementById('recent-transactions').innerHTML = html`${recent.map(t => html`
    <div class="recent-row ${countsAsSpend(t) ? '' : 'txn-item-out'}" onclick="openEditModal('${t.id}')" title="Edit">
      ${merchantAvatar(t.merchant, { logoUrl: t.logoUrl, category: t.category, size: 'sm' })}
      <div class="recent-main">
        <div class="recent-merchant">${t.merchant}${t.pending ? html` <span class="txn-pending-badge">pending</span>` : ''}</div>
        <div class="recent-date">${fmtDate(t.date)}${t.category ? html` · <span style="color:${categoryColor(t.category)}">${t.category}</span>` : html` · <span class="muted">uncategorized</span>`}</div>
      </div>
      <div class="recent-amount">${amountHtml(t, { small: true })}</div>
    </div>`)}`;

  renderTopMerchants(txns);
  renderRecurring();
  renderAsyncWidgets();

  if (animate) requestAnimationFrame(() => {
    document.querySelectorAll('.chart-bar[data-w]').forEach(b => { b.style.width = b.dataset.w; });
  });
}

function statTile(t) {
  return html`
    <div class="stat-tile ${t.cls || ''} ${t.action ? 'stat-clickable' : ''} ${t.attention ? 'stat-attention' : ''} ${t.good ? 'stat-good' : ''} ${t.over ? 'stat-overdue' : ''}" ${t.action ? raw(`onclick="${t.action}" role="button" tabindex="0"`) : ''}>
      ${t.spark && t.spark.some(Boolean) ? html`<span class="stat-spark" style="color:${t.color || 'var(--accent)'}">${sparkline(t.spark, { width: 56, height: 20 })}</span>` : ''}
      <div class="stat-label">${t.label}</div>
      <div class="stat-value ${t.small ? 'stat-value-sm' : ''}" ${t.color ? raw(`style="color:${t.color}"`) : ''}>${t.value}</div>
      <div class="stat-sub">${t.sub}</div>
      ${t.bar ? html`<div class="stat-bar"><div class="stat-bar-fill ${t.bar.over ? 'over' : t.bar.warn ? 'warn' : ''}" style="width:${(t.bar.pct * 100).toFixed(1)}%"></div></div><div class="stat-bar-note">${t.bar.note}</div>` : ''}
    </div>`;
}

// Anomalies, insights and card due dates come from one request and paint together
async function renderAsyncWidgets() {
  const cacheKey = state.dashboardMonth || 'all';
  if (!state.dashboardCache[cacheKey]) {
    const params = state.dashboardMonth ? `?month=${state.dashboardMonth}` : '';
    const seq = ++state._dashSeq;
    let data;
    try { data = await api('GET', `/api/dashboard${params}`); }
    catch { data = { anomalies: [], insights: [], plaid: null }; }
    if (seq !== state._dashSeq) return; // a newer render took over
    state.dashboardCache[cacheKey] = data;
  }
  if ((state.dashboardMonth || 'all') !== cacheKey) return;
  const d = state.dashboardCache[cacheKey];
  displayAnomalies(d.anomalies || []);
  renderInsights(d.insights || []);
  renderCardsDue(d.plaid);
  renderSafeToSpendTile(d.budget);
  renderOwedTile();
}

// What's left of this month's income after fixed expenses and what's already spent, per remaining day
function renderSafeToSpendTile(budget) {
  const tiles = document.getElementById('summary-cards');
  if (!tiles) return;
  tiles.querySelector('.stat-tile-safe')?.remove();
  const month = state.dashboardMonth;
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (!budget || month !== thisMonth) return;
  const spent = spendOf(state.transactions.filter(t => t.date?.startsWith(month)));
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - today.getDate() + 1;
  let t;
  if (!budget.hasIncome) {
    t = { cls: 'stat-tile-safe', label: 'Safe to spend', value: '—', sub: html`Add your income in <b>Budget</b> to see this`, action: "switchView('budget')" };
  } else {
    const left = budget.income - budget.fixed - spent;
    const perDay = left / Math.max(daysLeft, 1);
    t = left < 0
      ? { cls: 'stat-tile-safe', label: 'Safe to spend', value: fmt(0), sub: html`<b>${fmt(-left)} over</b> this month's income after ${fmt(budget.fixed)} fixed`, over: true, action: "switchView('budget')" }
      : { cls: 'stat-tile-safe', label: 'Safe to spend', value: `${fmt(perDay)}/day`, sub: `${fmt(left)} left · ${plural(daysLeft, 'day')} to go`, action: "switchView('budget')", bar: { pct: Math.min(spent / Math.max(budget.income - budget.fixed, 1), 1), warn: spent / Math.max(budget.income - budget.fixed, 1) > 0.85, over: false, note: `${fmt(budget.income)} income − ${fmt(budget.fixed)} fixed` } };
  }
  const el = document.createElement('div');
  el.innerHTML = statTile(t);
  const node = el.firstElementChild;
  const first = tiles.querySelector('.stat-tile');
  if (first?.nextSibling) tiles.insertBefore(node, first.nextSibling); else tiles.appendChild(node);
}

// Purchases someone still owes you for
function renderOwedTile() {
  const tiles = document.getElementById('summary-cards');
  if (!tiles) return;
  tiles.querySelector('.stat-tile-owed')?.remove();
  const owed = state.transactions.filter(t => t.reimbursable && !t.reimbursedAt);
  if (!owed.length) return;
  const total = owed.reduce((s, t) => s + t.amount, 0);
  const el = document.createElement('div');
  el.innerHTML = statTile({ cls: 'stat-tile-owed', label: 'Owed to you', value: fmt(total), sub: html`${plural(owed.length, 'purchase')} · <b>see them</b>`, action: 'showOwed()' });
  tiles.appendChild(el.firstElementChild);
}
function showOwed() {
  clearFilterInputs();
  state.quickFilters.add('reimbursable');
  switchView('transactions');
}

// ---- Anomalies ----
function anomalyKey(a) { return `${a.label}||${a.detail}`; }

function displayAnomalies(anomalies) {
  const card = document.getElementById('anomalies-card');
  const list = document.getElementById('anomalies-list');
  if (!card || !list) return;
  const visible = anomalies.filter(a => !state.dismissedAnomalies.has(anomalyKey(a)));
  if (!visible.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const typeIcon = { 'duplicate': 'alert', 'new-merchant': 'tag', 'price-increase': 'trend-up' };
  list.innerHTML = html`${visible.map((a, i) => html`
    <div class="anomaly-row" id="anomaly-row-${i}">
      <span class="anomaly-icon">${icon(typeIcon[a.type] || 'alert')}</span>
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
function renderInsights(insights) {
  const list = document.getElementById('insights-list');
  if (!list) return;
  const cacheKey = state.dashboardMonth || 'all';
  // The tiles already show totals, pace, the top category and what's uncategorized
  const items = insights.filter(i => !['total', 'pace', 'top-category', 'uncategorized'].includes(i.kind)).slice(0, 4);
  const actions = {
    'top-category': i => `drillCategory('${escAttr(i.category)}')`,
    'swing': i => `drillCategory('${escAttr(i.category)}')`,
    'largest': i => `jumpToMerchant('${escAttr(i.merchant)}')`,
    'uncategorized': () => 'openUncategorizedModal()',
    'total': i => i.month ? `state.dashboardMonth='${i.month}';renderDashboard()` : '',
  };
  const card = document.getElementById('insights-card');
  const aiText = state.insightsCache[cacheKey];
  card.style.display = items.length || state.hasApiKey ? '' : 'none';
  list.innerHTML = html`${items.map(i => {
    const action = actions[i.kind] ? actions[i.kind](i) : '';
    return html`<li class="insight-row ${action ? 'insight-clickable' : ''}" ${action ? raw(`onclick="${action}"`) : ''}>${i.text}</li>`;
  })}${aiText && aiText !== 'loading' ? html`<li class="insight-row insight-ai"><span class="ai-badge">AI</span> ${aiText}</li>` : ''}`;
  renderAiInsight();
}

function renderAiInsight() {
  const wrap = document.getElementById('insights-ai');
  if (!wrap) return;
  const cacheKey = state.dashboardMonth || 'all';
  const cached = state.insightsCache[cacheKey];
  if (!state.hasApiKey) { wrap.innerHTML = ''; return; }
  if (cached === 'loading') {
    wrap.innerHTML = html`<span class="muted" style="font-size:.8rem">Writing…</span>`;
  } else if (cached) {
    wrap.innerHTML = html`<button class="btn-link" onclick="generateInsights(true)">${icon('refresh')} Rewrite</button>`;
  } else {
    wrap.innerHTML = html`<button class="btn-link" onclick="generateInsights()">${icon('sparkle')} Ask Claude</button>`;
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
  state.dashboardCache = {};
}

function clearAllCaches() {
  state.insightsCache = {};
  state.dashboardCache = {};
  state.budgetInsight = {};
}

function toggleTrendView() {
  state.trendShowAll = !state.trendShowAll;
  renderDashboard();
}

function drillCategory(category) {
  clearFilterInputs();
  state.jumpToCategory = category === 'Uncategorized' ? '__uncategorized__' : category;
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
  const cats = {};
  for (const t of txns) { if (!countsAsSpend(t)) continue; totals[t.merchant] = (totals[t.merchant] || 0) + t.amount; if (t.category && !cats[t.merchant]) cats[t.merchant] = t.category; }
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6);
  el.innerHTML = top.length
    ? html`${top.map(([merchant, amt]) => html`
      <div class="top-merchant-row" onclick="jumpToMerchant('${escAttr(merchant)}')" title="View ${merchant} transactions">
        ${merchantAvatar(merchant, { category: cats[merchant], size: 'sm' })}
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

// Subscriptions: charged once a month, three or more months, for about the same amount
function renderRecurring() {
  const card = document.getElementById('recurring-card');
  const list = document.getElementById('recurring-list');
  if (!card || !list) return;
  const byMerchant = new Map();
  for (const t of state.transactions) {
    const m = t.date?.slice(0, 7);
    if (!m || t.amount <= 0 || !countsAsSpend(t)) continue;
    const months = byMerchant.get(t.merchant) || byMerchant.set(t.merchant, new Map()).get(t.merchant);
    months.set(m, [...(months.get(m) || []), t.amount]);
  }
  const recurring = [];
  for (const [merchant, months] of byMerchant) {
    if (months.size < 3) continue;
    if ([...months.values()].some(list => list.length !== 1)) continue;
    const amounts = [...months.values()].map(l => l[0]);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    if (amounts.every(a => Math.abs(a - avg) <= Math.max(avg * 0.15, 2))) recurring.push({ merchant, months: months.size, avg });
  }
  recurring.sort((a, b) => b.avg - a.avg);
  if (!recurring.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const note = document.getElementById('recurring-note');
  if (note) note.textContent = `about ${fmt(recurring.reduce((s, r) => s + r.avg, 0))} a month`;
  list.innerHTML = html`${recurring.slice(0, 12).map(r => html`
    <div class="recurring-row" onclick="jumpToMerchant('${escAttr(r.merchant)}')" title="See transactions">
      <div class="recurring-merchant">${r.merchant}</div>
      <div class="recurring-meta"><span class="recurring-avg">${fmt(r.avg)}</span><span class="recurring-months">/mo · ${r.months} months</span></div>
    </div>`)}`;
}

// ---- Credit cards: statement balance, due date, paid or not (from Plaid Liabilities) ----
const DAY_MS = 86400000;
function dueStatus(l) {
  const today = new Date().toISOString().slice(0, 10);
  const paid = l.lastStatementIssueDate && l.lastPaymentDate && l.lastPaymentDate >= l.lastStatementIssueDate
    && (l.lastStatementBalance == null || (l.lastPaymentAmount ?? 0) >= l.lastStatementBalance - 0.01);
  if (paid) return { kind: 'paid', text: 'Paid', days: Infinity };
  if (!l.nextPaymentDueDate) return { kind: 'unknown', text: '', days: Infinity };
  const days = Math.round((Date.parse(l.nextPaymentDueDate) - Date.parse(today)) / DAY_MS);
  if (l.isOverdue || days < 0) return { kind: 'overdue', text: days < 0 ? `${plural(-days, 'day')} overdue` : 'Overdue', days };
  if (days === 0) return { kind: 'soon', text: 'Due today', days };
  return { kind: days <= 7 ? 'soon' : 'ok', text: `Due in ${plural(days, 'day')}`, days };
}

function renderCardsDue(status) {
  const card = document.getElementById('cards-due-card');
  const list = document.getElementById('cards-due-list');
  if (!card || !list) return;
  if (!status) { card.style.display = 'none'; renderNextPaymentTile(null); return; }
  const cards = [];
  for (const item of status.items) {
    if (item.env && item.env !== status.env) continue;
    for (const a of item.accounts) if (a.enabled && a.type === 'credit' && a.liability) cards.push({ ...a, institution: item.institutionName, status: dueStatus(a.liability) });
  }
  if (!cards.length) { card.style.display = 'none'; renderNextPaymentTile(null); return; }
  cards.sort((a, b) => a.status.days - b.status.days);
  card.style.display = '';
  const upcoming = cards.filter(c => c.status.kind !== 'paid' && c.status.kind !== 'unknown');
  document.getElementById('cards-due-note').textContent = upcoming.length
    ? `${fmt(upcoming.reduce((s, c) => s + (c.liability.lastStatementBalance || 0), 0))} due across ${plural(upcoming.length, 'card')}`
    : 'Nothing due';
  list.innerHTML = html`${cards.map(c => {
    const l = c.liability;
    return html`
      <div class="due-row due-${c.status.kind}" onclick="clearFilterInputs();document.getElementById('filter-card').value='${escAttr(c.card || '')}';switchView('transactions')" title="See this card's transactions">
        <div class="due-main">
          <div class="due-name">${c.card || c.name}</div>
          <div class="due-meta muted">
            ${l.lastStatementIssueDate ? html`Statement ${fmtDate(l.lastStatementIssueDate)}` : 'No statement yet'}
            ${c.balance?.current != null ? html` · Balance ${fmt(c.balance.current)}` : ''}
            ${c.balance?.limit ? html` of ${fmt(c.balance.limit)}` : ''}
          </div>
        </div>
        <div class="due-amounts">
          <div class="due-statement">${l.lastStatementBalance != null ? fmt(l.lastStatementBalance) : '—'}</div>
          <div class="due-min muted">${l.minimumPaymentAmount != null ? `min ${fmt(l.minimumPaymentAmount)}` : ''}</div>
        </div>
        <div class="due-status"><span class="due-pill">${c.status.text}${c.status.kind !== 'paid' && l.nextPaymentDueDate ? html`<span class="due-date">${fmtDate(l.nextPaymentDueDate)}</span>` : ''}</span></div>
      </div>`;
  })}`;
  renderNextPaymentTile(upcoming[0] || null);
}

// A fifth tile when a payment is coming up
function renderNextPaymentTile(next) {
  const tiles = document.getElementById('summary-cards');
  if (!tiles) return;
  tiles.querySelector('.stat-tile-payment')?.remove();
  if (!next) return;
  const l = next.liability;
  const tile = document.createElement('div');
  tile.className = `stat-tile stat-tile-payment stat-clickable ${next.status.kind === 'overdue' ? 'stat-overdue' : next.status.kind === 'soon' ? 'stat-attention' : ''}`;
  tile.setAttribute('role', 'button');
  tile.setAttribute('tabindex', '0');
  tile.onclick = () => document.getElementById('cards-due-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  tile.innerHTML = html`
    <div class="stat-label">Next payment</div>
    <div class="stat-value stat-value-sm">${l.lastStatementBalance != null ? fmt(l.lastStatementBalance) : '—'}</div>
    <div class="stat-sub">${next.card || next.name} · <b>${next.status.text.toLowerCase()}</b></div>`;
  tiles.appendChild(tile);
}
