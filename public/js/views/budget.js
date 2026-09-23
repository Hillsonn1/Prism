// Budget view: income, fixed expenses, targets and per-category limits.

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
    const barColor = pct > 1 ? 'var(--danger)' : pct > 0.85 ? 'var(--warning)' : 'var(--success)';
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

  // Sweep the chart in when the month changes; otherwise repaint in place
  const animate = state._budgetDrawnKey !== month;
  state._budgetDrawnKey = month;

  const catRowsHtml = sortedCats.map(([cat, catSpent]) => {
    const catBudget = state.budgets[cat] || 0;
    const overCat = catBudget > 0 && catSpent > catBudget;
    const barW = (catSpent / ccSpent * 100).toFixed(1);
    const barColor = overCat ? 'var(--danger)' : categoryColor(cat);
    const pctLabel = (catSpent / ccSpent * 100).toFixed(0) + '%';
    return `<div class="budget-cat-row" onclick="jumpToBudgetCategory('${escAttr(cat)}')" title="View ${esc(cat)} transactions">
      <div class="budget-cat-row-label">
        <span class="budget-cat-dot" style="background:${categoryColor(cat)}"></span>
        <span class="budget-cat-row-name">${esc(cat)}</span>
        ${overCat ? `<span class="budget-cat-over-badge">+${fmt(catSpent - catBudget)}</span>` : ''}
      </div>
      <div class="budget-cat-row-bar-wrap">
        <div class="budget-cat-row-bar" style="width:${animate ? 0 : barW + '%'};background:${barColor};opacity:.85" data-w="${barW}%"></div>
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
      <div class="bud-pie-wrap">${donutChart({ slices: sortedCats, total: ccSpent, size: 240, thickness: 41, centerLabel: 'Spending', animate })}</div>
      <div class="bud-cat-list">${catRowsHtml}</div>
    </div>
    <details class="bud-limits-details">
      <summary class="budget-summary">Per-category limits <span class="muted" style="font-weight:400">(optional)</span></summary>
      <p class="muted" style="margin:.6rem 0 1rem;font-size:.82rem">Set a cap per category — any that go over will be flagged above.</p>
      <div class="budget-grid">${budgetFormHtml}</div>
      <div style="margin-top:1rem;display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="saveBudgets()">Save Limits</button>
        <button class="btn btn-secondary" onclick="suggestBudgets()">Suggest from history${state.hasApiKey ? ' <span class="ai-badge">AI</span>' : ''}</button>
        <span id="budget-suggest-status" class="muted" style="font-size:.8rem"></span>
      </div>
    </details>
  `;

  if (animate) requestAnimationFrame(() => {
    document.querySelectorAll('.budget-cat-row-bar[data-w]').forEach(b => { b.style.width = b.dataset.w; });
  });
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


async function suggestBudgets() {
  const statusEl = document.getElementById('budget-suggest-status');
  if (statusEl) statusEl.textContent = 'Calculating…';
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

