// Transactions view: filters and quick chips, a day-grouped list (or grouped
// by merchant), the inline category popup, and the add/edit modal with tags,
// spending flags and refund links.

const LARGE_PURCHASE = 100;

function getFilters() {
  const v = id => document.getElementById(id)?.value || '';
  return {
    cat: v('filter-category'),
    search: v('filter-merchant').toLowerCase(),
    card: v('filter-card'),
    tag: v('filter-tag'),
    from: v('filter-date-from'),
    to: v('filter-date-to'),
    min: parseFloat(v('filter-amount-min')),
    max: parseFloat(v('filter-amount-max')),
  };
}

// Everything but the quick chips, so chip counts reflect the current view
function getBaseFiltered() {
  const f = getFilters();
  return state.transactions.filter(t => {
    if (f.cat === '__uncategorized__' && t.category) return false;
    if (f.cat && f.cat !== '__uncategorized__' && (t.category || '') !== f.cat) return false;
    if (f.search && ![t.merchant, t.notes, t.category, t.card, t.rawSource, ...(t.tags || [])].some(v => (v || '').toLowerCase().includes(f.search))) return false;
    if (f.card && (t.card || '') !== f.card) return false;
    if (f.tag && !(t.tags || []).includes(f.tag)) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (!Number.isNaN(f.min) && Math.abs(t.amount) < f.min) return false;
    if (!Number.isNaN(f.max) && Math.abs(t.amount) > f.max) return false;
    return true;
  });
}

const CHIP_TESTS = {
  uncategorized: t => !t.category,
  pending: t => Boolean(t.pending),
  refunds: t => t.amount < 0,
  large: t => t.amount >= LARGE_PURCHASE,
  excluded: t => Boolean(t.excluded),
  reimbursable: t => Boolean(t.reimbursable),
};
const CHIP_LABELS = { uncategorized: 'Uncategorized', pending: 'Pending', refunds: 'Refunds', large: `Over $${LARGE_PURCHASE}`, excluded: 'Excluded', reimbursable: 'Owed to me' };

function getFiltered() {
  const rows = getBaseFiltered();
  const chips = [...state.quickFilters];
  return chips.length ? rows.filter(t => chips.every(c => CHIP_TESTS[c](t))) : rows;
}

function getSorted(rows) {
  const mode = state.sortMode;
  return [...rows].sort((a, b) => {
    if (mode === 'largest') return Math.abs(b.amount) - Math.abs(a.amount) || b.date.localeCompare(a.date);
    if (mode === 'smallest') return Math.abs(a.amount) - Math.abs(b.amount) || b.date.localeCompare(a.date);
    const byDate = mode === 'oldest' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
    return byDate || (b.importedAt || '').localeCompare(a.importedAt || '');
  });
}

// Refunds linked to each purchase, rebuilt when the data changes
let _refundIndex = { version: -1, map: new Map() };
function refundsOf(purchaseId) {
  if (_refundIndex.version !== state.txVersion) {
    const map = new Map();
    for (const t of state.transactions) if (t.refundOf) map.set(t.refundOf, [...(map.get(t.refundOf) || []), t]);
    _refundIndex = { version: state.txVersion, map };
  }
  return _refundIndex.map.get(purchaseId) || [];
}

function rowActions(t) {
  const pre = 'event.stopPropagation();';
  const identify = (!t.category || t.category === 'Unknown') && state.hasApiKey
    ? html`<button class="icon-btn icon-btn-ai" id="identify-btn-${t.id}" onclick="${raw(pre)}identifyMerchant('${t.id}')" title="Identify with AI" aria-label="Identify merchant with AI">${icon('sparkle')}</button>` : '';
  return html`<div class="row-actions">${identify}
    <button class="icon-btn" onclick="${raw(pre)}openEditModal('${t.id}')" title="Edit" aria-label="Edit transaction">${icon('pencil')}</button>
    <button class="icon-btn icon-btn-danger" onclick="${raw(pre)}deleteTransactionById('${t.id}')" title="Delete" aria-label="Delete transaction">${icon('trash')}</button>
  </div>`;
}

// Small labels after the merchant name: tags, pending, flags, refund links
function txnPills(t) {
  const pills = [];
  for (const tag of t.tags || []) pills.push(tagChip(tag, { onclick: `event.stopPropagation();filterByTag('${escAttr(tag)}')` }));
  if (t.pending) pills.push(html`<span class="txn-pill txn-pill-pending">pending</span>`);
  if (t.excluded) pills.push(html`<span class="txn-pill txn-pill-muted" title="Left out of totals">${icon('eye-off')} excluded</span>`);
  if (t.reimbursable) pills.push(t.reimbursedAt
    ? html`<span class="txn-pill txn-pill-good" title="Paid back ${fmtDate(t.reimbursedAt)}">${icon('check')} repaid</span>`
    : html`<span class="txn-pill txn-pill-warn" title="Someone owes you this">${icon('receipt')} owed</span>`);
  if (t.refundOf) {
    const p = state.transactions.find(x => x.id === t.refundOf);
    pills.push(html`<span class="txn-pill txn-pill-good" title="${p ? `Refund of ${fmt(p.amount)} at ${p.merchant} on ${fmtDate(p.date)}` : 'Linked to a purchase'}">${icon('undo')} refund${p ? html` of ${fmtDate(p.date)}` : ''}</span>`);
  }
  const refunds = t.amount > 0 ? refundsOf(t.id) : [];
  if (refunds.length) {
    const back = refunds.reduce((s, r) => s + Math.abs(r.amount), 0);
    pills.push(html`<span class="txn-pill txn-pill-good" title="${refunds.map(r => `${fmt(Math.abs(r.amount))} on ${fmtDate(r.date)}`).join(', ')}">${icon('undo')} ${back >= t.amount - 0.005 ? 'refunded' : `${fmt(back)} refunded`}</span>`);
  }
  return pills.length ? html`<span class="txn-pills">${pills}</span>` : '';
}

// One transaction row; showDate is for flat (sorted) lists without day headers
function txnItem(t, { showDate = false } = {}) {
  const sub = [];
  if (showDate) sub.push(html`<span>${fmtDate(t.date)}</span>`);
  sub.push(categoryBadge(t.category, `event.stopPropagation();openCategoryPopup(event,'${t.id}')`));
  if (t.card) sub.push(html`<span class="txn-sub-card">${t.card}</span>`);
  if (t.notes) sub.push(html`<span class="txn-sub-note">${t.notes}</span>`);
  return html`
    <div class="txn-item ${countsAsSpend(t) ? '' : 'txn-item-out'}" onclick="openEditModal('${t.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openEditModal('${t.id}')">
      ${merchantAvatar(t.merchant, { logoUrl: t.logoUrl, category: t.category })}
      <div class="txn-main">
        <div class="txn-merchant"><span class="merchant-link" onclick="event.stopPropagation();goToMerchant('${escAttr(t.merchant)}')" title="All purchases from ${t.merchant}">${t.merchant}</span>${txnPills(t)}</div>
        <div class="txn-sub">${sub.map((x, i) => html`${i ? html`<span class="txn-sub-dot">·</span>` : ''}${x}`)}</div>
      </div>
      <div class="txn-right">${amountHtml(t)}</div>
      ${rowActions(t)}
    </div>`;
}

function dayLabel(date) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (date === today) return 'Today';
  if (date === yesterday) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
  return `${weekday}, ${fmtDate(date)}`;
}

function renderChips(baseRows) {
  const el = document.getElementById('txn-chips');
  if (!el) return;
  const counts = {};
  for (const k of Object.keys(CHIP_TESTS)) counts[k] = baseRows.filter(CHIP_TESTS[k]).length;
  el.innerHTML = html`${Object.keys(CHIP_TESTS).map(k => {
    const active = state.quickFilters.has(k);
    if (!counts[k] && !active) return '';
    return html`<button type="button" class="chip ${active ? 'chip-active' : ''}" onclick="toggleChip('${k}')" aria-pressed="${active}">${CHIP_LABELS[k]}<span class="chip-count">${counts[k]}</span></button>`;
  })}`;
}

function toggleChip(key) {
  if (state.quickFilters.has(key)) state.quickFilters.delete(key); else state.quickFilters.add(key);
  renderTransactions();
}

function renderTransactions() {
  populateFilterDropdowns();

  if (state.merchantFilter !== null) {
    const el = document.getElementById('filter-merchant');
    if (el) el.value = state.merchantFilter;
    state.merchantFilter = null;
  }
  if (state.jumpToMonth !== null) {
    const month = state.jumpToMonth;
    state.jumpToMonth = null;
    setDateRangeToMonth(month);
    const monthSel = document.getElementById('filter-month');
    if (monthSel) monthSel.value = month || '';
  }
  const sortSel = document.getElementById('filter-sort');
  if (sortSel) sortSel.value = state.sortMode;

  const base = getBaseFiltered();
  renderChips(base);
  const filtered = getSorted(getFiltered());
  const f = getFilters();
  const anyFilter = Boolean(f.cat || f.search || f.card || f.tag || f.from || f.to || !Number.isNaN(f.min) || !Number.isNaN(f.max) || state.quickFilters.size);
  const clearBtn = document.getElementById('filter-clear');
  if (clearBtn) clearBtn.style.visibility = anyFilter ? 'visible' : 'hidden';
  const list = document.getElementById('transactions-list');
  const empty = document.getElementById('transactions-empty');
  document.getElementById('txn-count').textContent = plural(filtered.length, 'transaction');
  const totalEl = document.getElementById('txn-total');
  if (totalEl) {
    const counted = filtered.filter(countsAsSpend);
    totalEl.textContent = filtered.length ? fmt(counted.reduce((s, t) => s + t.amount, 0)) : '';
    totalEl.title = counted.length !== filtered.length ? `${plural(filtered.length - counted.length, 'row')} left out of the total` : '';
  }

  const groupBtn = document.getElementById('group-toggle');
  if (groupBtn) {
    groupBtn.textContent = state.groupByVendor ? 'Show individually' : 'Group by merchant';
    groupBtn.classList.toggle('btn-active', state.groupByVendor);
  }

  if (!filtered.length) {
    list.innerHTML = '';
    empty.style.display = '';
    list.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  list.style.display = '';

  if (state.groupByVendor) { renderMerchantGroups(list, filtered); return; }

  // Flat list when sorting by amount; otherwise grouped by day with subtotals
  if (state.sortMode === 'largest' || state.sortMode === 'smallest') {
    list.innerHTML = html`<div class="txn-day"><div class="txn-day-body">${filtered.map(t => txnItem(t, { showDate: true }))}</div></div>`;
    return;
  }
  const days = [];
  for (const t of filtered) {
    const last = days[days.length - 1];
    if (last && last.date === t.date) last.txns.push(t); else days.push({ date: t.date, txns: [t] });
  }
  list.innerHTML = html`${days.map(d => {
    const spend = d.txns.filter(countsAsSpend).reduce((s, t) => s + t.amount, 0);
    return html`
      <div class="txn-day">
        <div class="txn-day-head"><span class="txn-day-label">${dayLabel(d.date)}</span><span class="txn-day-total">${fmt(spend)}</span></div>
        <div class="txn-day-body">${d.txns.map(t => txnItem(t))}</div>
      </div>`;
  })}`;
}

function renderMerchantGroups(list, filtered) {
  const groups = {};
  for (const t of filtered) {
    const g = groups[t.merchant] || (groups[t.merchant] = { merchant: t.merchant, amount: 0, count: 0, category: null, txns: [] });
    if (countsAsSpend(t)) g.amount += t.amount;
    g.count++;
    g.txns.push(t);
    if (!g.category && t.category) g.category = t.category;
  }
  const rows = Object.values(groups).sort((a, b) => b.amount - a.amount);
  list.innerHTML = html`<div class="txn-day"><div class="txn-day-body">${rows.map(g => {
    const expanded = state.expandedMerchants.has(g.merchant);
    const first = g.txns[0];
    return html`
      <div class="txn-item txn-group ${expanded ? 'txn-group-open' : ''}" onclick="toggleVendorGroup('${escAttr(g.merchant)}')" role="button" tabindex="0">
        ${merchantAvatar(g.merchant, { logoUrl: first.logoUrl, category: g.category })}
        <div class="txn-main">
          <div class="txn-merchant"><span class="merchant-link" onclick="event.stopPropagation();goToMerchant('${escAttr(g.merchant)}')">${g.merchant}</span><span class="txn-group-count">${g.count}×</span></div>
          <div class="txn-sub">${categoryBadge(g.category, `event.stopPropagation();openCategoryPopupForMerchant(event,'${escAttr(g.merchant)}')`)}<span class="txn-sub-dot">·</span><span>${fmtDate(g.txns[g.txns.length - 1].date)} – ${fmtDate(first.date)}</span></div>
        </div>
        <div class="txn-right"><span class="amount ${g.amount < 0 ? 'amount-credit' : ''}">${fmt(g.amount)}</span></div>
        <div class="row-actions">
          ${(!g.category || g.category === 'Unknown') && state.hasApiKey ? html`<button class="icon-btn icon-btn-ai" id="identify-btn-${first.id}" onclick="event.stopPropagation();identifyMerchant('${first.id}')" title="Identify with AI" aria-label="Identify merchant with AI">${icon('sparkle')}</button>` : ''}
          <button class="icon-btn" onclick="event.stopPropagation();renameVendorGroup('${escAttr(g.merchant)}')" title="Rename merchant" aria-label="Rename merchant">${icon('pencil')}</button>
          <button class="icon-btn icon-btn-danger" onclick="event.stopPropagation();deleteVendorGroup('${escAttr(g.merchant)}',${g.count})" title="Delete all from this merchant" aria-label="Delete all from merchant">${icon('trash')}</button>
        </div>
      </div>
      ${expanded ? html`<div class="txn-group-detail">${g.txns.slice().sort((a, b) => b.date.localeCompare(a.date)).map(t => txnItem(t, { showDate: true }))}</div>` : ''}`;
  })}</div></div>`;
}

function filterByTag(tag) {
  clearFilterInputs();
  const sel = document.getElementById('filter-tag');
  populateFilterDropdowns();
  if (sel) sel.value = tag;
  if (state.currentView !== 'transactions') switchView('transactions'); else renderTransactions();
}

function setSortMode(mode) {
  state.sortMode = mode;
  renderTransactions();
}

function toggleGroup() {
  state.groupByVendor = !state.groupByVendor;
  state.expandedMerchants.clear();
  renderTransactions();
}

function toggleVendorGroup(merchant) {
  if (state.expandedMerchants.has(merchant)) state.expandedMerchants.delete(merchant);
  else state.expandedMerchants.add(merchant);
  renderTransactions();
}

async function renameVendorGroup(merchant) {
  const newName = await promptDialog({ title: 'Rename merchant', message: `Every transaction from "${merchant}" will use the new name.`, label: 'Merchant name', value: merchant, okText: 'Rename' });
  if (!newName || newName === merchant) return;
  try {
    await api('POST', '/api/merchants/rename', { oldName: merchant, newName });
    for (const t of state.transactions) if (t.merchant === merchant) t.merchant = newName;
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
  if (!await confirmAction(`Delete ${plural(count, 'transaction')}?`, `Everything from "${merchant}" will be removed. This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/transactions?merchant=${encodeURIComponent(merchant)}`);
    state.transactions = state.transactions.filter(t => t.merchant !== merchant);
    state.txVersion++;
    clearDashboardCaches();
    renderTransactions();
    showToast(`${plural(count, 'transaction')} deleted`, 'success');
  } catch (err) {
    showToast('Could not delete: ' + err.message, 'error');
  }
}

// ---- Filters ----
function populateFilterDropdowns() {
  if (state._dropdownVersion === state.txVersion && state.jumpToCategory === null) return;
  state._dropdownVersion = state.txVersion;

  const cats = [...new Set(state.transactions.map(t => t.category).filter(Boolean))].sort();
  const months = [...new Set(state.transactions.map(t => t.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  const cards = [...new Set(state.transactions.map(t => t.card).filter(Boolean))].sort();
  const tags = [...new Set(state.transactions.flatMap(t => t.tags || []))].sort((a, b) => a.localeCompare(b));

  const catSel = document.getElementById('filter-category');
  const curCat = state.jumpToCategory !== null ? state.jumpToCategory : catSel.value;
  state.jumpToCategory = null;
  catSel.innerHTML = html`<option value="">All Categories</option>${cats.map(c => html`<option value="${c}" ${c === curCat ? 'selected' : ''}>${c}</option>`)}<option value="__uncategorized__" ${curCat === '__uncategorized__' ? 'selected' : ''}>Uncategorized</option>`;
  catSel.value = curCat || '';

  const monthSel = document.getElementById('filter-month');
  if (monthSel) {
    const cur = state.jumpToMonth !== null ? state.jumpToMonth : monthSel.value;
    monthSel.innerHTML = html`<option value="">Any time</option>${months.map(m => html`<option value="${m}" ${m === cur ? 'selected' : ''}>${fmtMonth(m)}</option>`)}`;
  }
  const cardSel = document.getElementById('filter-card');
  if (cardSel) {
    const cur = cardSel.value;
    cardSel.innerHTML = html`<option value="">All cards</option>${cards.map(c => html`<option value="${c}" ${c === cur ? 'selected' : ''}>${c}</option>`)}`;
    cardSel.style.display = cards.length ? '' : 'none';
  }
  const tagSel = document.getElementById('filter-tag');
  if (tagSel) {
    const cur = tagSel.value;
    tagSel.innerHTML = html`<option value="">All tags</option>${tags.map(t => html`<option value="${t}" ${t === cur ? 'selected' : ''}>${t}</option>`)}`;
    tagSel.style.display = tags.length ? '' : 'none';
  }
  const tagList = document.getElementById('tag-suggestions');
  if (tagList) tagList.innerHTML = html`${tags.map(t => html`<option value="${t}"></option>`)}`;
}

function setDateRangeToMonth(month) {
  const fromEl = document.getElementById('filter-date-from');
  const toEl = document.getElementById('filter-date-to');
  if (!month) { fromEl.value = ''; toEl.value = ''; return; }
  const [yr, mo] = month.split('-').map(Number);
  fromEl.value = `${month}-01`;
  toEl.value = `${month}-${String(new Date(yr, mo, 0).getDate()).padStart(2, '0')}`;
}

function onMonthFilterSelect() {
  setDateRangeToMonth(document.getElementById('filter-month')?.value);
  renderTransactions();
}

function onDateRangeChange() {
  const monthSel = document.getElementById('filter-month');
  if (monthSel) monthSel.value = '';
  renderTransactions();
}

function clearFilterInputs() {
  for (const id of ['filter-category', 'filter-merchant', 'filter-month', 'filter-card', 'filter-tag', 'filter-date-from', 'filter-date-to', 'filter-amount-min', 'filter-amount-max']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  state.quickFilters.clear();
}

function clearFilters() {
  clearFilterInputs();
  renderTransactions();
}

document.getElementById('filter-merchant')?.addEventListener('input', debounce(renderTransactions, 180));
['filter-category', 'filter-card', 'filter-tag'].forEach(id => document.getElementById(id)?.addEventListener('change', renderTransactions));
['filter-amount-min', 'filter-amount-max'].forEach(id => document.getElementById(id)?.addEventListener('input', debounce(renderTransactions, 220)));
['filter-date-from', 'filter-date-to'].forEach(id => document.getElementById(id)?.addEventListener('change', debounce(onDateRangeChange, 180)));

// ---- Inline category popup ----
let popupTxnId = null;
let popupMerchant = null;

function _showPopup(e, selected, merchant) {
  const popup = document.getElementById('category-popup');
  document.getElementById('category-popup-select').innerHTML = categoryOptions(selected, { blank: '-- Select category --' });
  // Offer to carry the choice across the merchant's other purchases
  const others = merchant ? state.transactions.filter(t => t.merchant === merchant).length - (popupTxnId ? 1 : 0) : 0;
  const allRow = document.getElementById('category-popup-all');
  allRow.style.display = others > 0 ? '' : 'none';
  document.getElementById('category-popup-all-check').checked = true;
  document.getElementById('category-popup-all-text').textContent = popupTxnId
    ? `Also apply to ${plural(others, 'other purchase')} from ${merchant}`
    : `Apply to all ${plural(others, 'purchase')} from ${merchant}`;
  const anchor = e.currentTarget || e.target.closest('.category-badge') || e.target;
  const rect = anchor.getBoundingClientRect();
  popup.style.display = 'flex';
  const width = popup.offsetWidth || 260;
  const height = popup.offsetHeight || 80;
  // Below the badge, or above it when the window ends first
  const below = rect.bottom + 6;
  popup.style.top = (below + height > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - height) : below) + 'px';
  popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
  popup.style.animation = 'none';
  void popup.offsetWidth;
  popup.style.animation = '';
  document.getElementById('category-popup-select').focus();
}

function openCategoryPopup(e, txnId) {
  e.stopPropagation();
  const txn = state.transactions.find(t => t.id === txnId);
  popupTxnId = txnId;
  popupMerchant = null;
  _showPopup(e, txn?.category || '', txn?.merchant);
}

function openCategoryPopupForMerchant(e, merchant) {
  e.stopPropagation();
  popupTxnId = null;
  popupMerchant = merchant;
  _showPopup(e, state.merchants[merchant] || state.transactions.find(t => t.merchant === merchant)?.category || '', merchant);
}

function closeCategoryPopup() {
  document.getElementById('category-popup').style.display = 'none';
  popupTxnId = null;
  popupMerchant = null;
}

async function saveCategoryPopup() {
  let cat = document.getElementById('category-popup-select').value;
  if (!cat) { closeCategoryPopup(); return; }
  if (cat === '__custom__') {
    cat = await createCategoryFromPrompt();
    if (!cat) return;
  }
  const applyAll = document.getElementById('category-popup-all').style.display !== 'none' && document.getElementById('category-popup-all-check').checked;
  const txn = popupTxnId ? state.transactions.find(t => t.id === popupTxnId) : null;
  const merchant = popupMerchant || txn?.merchant;
  closeCategoryPopup();
  try {
    if (txn) await api('PUT', `/api/transactions/${txn.id}`, { category: cat });
    // Remember the merchant; with applyAll every one of its rows follows
    const r = await api('POST', '/api/merchants', { merchant, category: cat, applyToAll: applyAll || !txn });
    if (txn) txn.category = cat;
    for (const t of state.transactions) {
      if (t.merchant === merchant && (applyAll || !txn || !t.category)) t.category = cat;
    }
    state.merchants = await api('GET', '/api/merchants');
    state.txVersion++;
    clearDashboardCaches();
    renderTransactions();
    const n = (txn ? 1 : 0) + (r.updated || 0);
    showToast(n > 1 ? `Category set on ${plural(n, 'purchase')} from ${merchant}` : 'Category saved', 'success');
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

document.addEventListener('click', e => {
  if (!document.getElementById('category-popup').contains(e.target)) closeCategoryPopup();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeCategoryPopup(); closeEditModal(); if (typeof closeTripModal === 'function') closeTripModal(); }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if (e.key === '/' && !typing && state.currentView === 'transactions') { e.preventDefault(); document.getElementById('filter-merchant')?.focus(); }
});


// ---- Add / edit modal ----
// "TRANSPORTATION_PUBLIC_TRANSIT" → "Transportation › Public transit"
const PLAID_PRIMARIES = ['GOVERNMENT_AND_NON_PROFIT', 'GENERAL_MERCHANDISE', 'RENT_AND_UTILITIES', 'HOME_IMPROVEMENT', 'GENERAL_SERVICES',
  'FOOD_AND_DRINK', 'LOAN_PAYMENTS', 'TRANSPORTATION', 'ENTERTAINMENT', 'PERSONAL_CARE', 'TRANSFER_OUT', 'TRANSFER_IN', 'BANK_FEES', 'MEDICAL', 'TRAVEL', 'INCOME', 'OTHER'];
function plaidCategoryLabel(code) {
  if (!code) return '';
  const nice = s => s.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const primary = PLAID_PRIMARIES.find(p => code === p || code.startsWith(p + '_'));
  if (!primary) return nice(code);
  const rest = code.slice(primary.length + 1);
  return rest && rest !== 'OTHER' && !rest.startsWith('OTHER_') ? `${nice(primary)} › ${nice(rest)}` : nice(primary);
}

function renderTxnDetails(txn) {
  const el = document.getElementById('edit-details');
  if (!txn) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const raw = txn.rawSource && txn.rawSource !== txn.merchant ? txn.rawSource : null;
  const facts = [];
  if (txn.card) facts.push(txn.card);
  facts.push(txn.plaidId ? 'Bank sync' : txn.manual ? 'Added by hand' : txn.source ? `Statement: ${txn.source}` : '');
  if (txn.location?.city || txn.location?.country) facts.push([txn.location.city, txn.location.country].filter(Boolean).join(', '));
  if (txn.plaidCategory) facts.push(`Bank says ${plaidCategoryLabel(txn.plaidCategory)}`);
  if (txn.importedAt) facts.push(`Imported ${fmtDate(txn.importedAt.slice(0, 10), { year: 'always' })}`);
  if (txn.pending) facts.push('Pending — the amount may still change');
  if (txn.originalCurrency === 'ILS') facts.push(`Paid ${fmtOriginal(txn)} at ₪${txn.fxRate} per $1`);
  if (txn.category) facts.push(txn.categorySource === 'user' ? 'Category set by you' : 'Category guessed by Prism');
  el.innerHTML = html`
    ${raw ? html`<div class="txn-raw-label">As it appeared on your statement</div>
      <button type="button" class="txn-raw" onclick="copyText('${escAttr(raw)}')" title="Click to copy">${raw}</button>` : ''}
    <div class="txn-facts">${facts.filter(Boolean).map(f => html`<span>${f}</span>`)}</div>`;
  el.style.display = '';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast('Copied', 'success'); } catch { showToast('Could not copy', 'error'); }
}

// ---- Tags in the modal ----
function renderEditTags() {
  const el = document.getElementById('edit-tags');
  if (el) el.innerHTML = html`${state.editTags.map(t => tagChip(t, { removable: true }))}`;
}
function addEditTag(value) {
  const tag = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!tag) return;
  if (!state.editTags.some(t => t.toLowerCase() === tag.toLowerCase())) state.editTags.push(tag);
  renderEditTags();
}
function removeEditTag(tag) {
  state.editTags = state.editTags.filter(t => t !== tag);
  renderEditTags();
}
function onTagInputKey(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addEditTag(e.target.value);
    e.target.value = '';
  } else if (e.key === 'Backspace' && !e.target.value && state.editTags.length) {
    state.editTags.pop();
    renderEditTags();
  }
}
function onTagInputChange(e) { // picked from the suggestions list
  if (e.target.value) { addEditTag(e.target.value); e.target.value = ''; }
}

// ---- Spending flags ----
function onEditFlagsChange() {
  const reimbursable = document.getElementById('edit-reimbursable').checked;
  document.getElementById('edit-reimbursed-wrap').style.display = reimbursable ? '' : 'none';
}

// ---- Refund links ----
function renderRefundSection(txn) {
  const el = document.getElementById('edit-refund');
  if (!el) return;
  const credit = document.getElementById('edit-credit').checked;
  if (!txn || !credit || state.addingTransaction) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const linked = txn.refundOf ? state.transactions.find(t => t.id === txn.refundOf) : null;
  if (linked) {
    el.innerHTML = html`
      <div class="edit-label">Refund of</div>
      <div class="refund-link">
        ${merchantAvatar(linked.merchant, { logoUrl: linked.logoUrl, category: linked.category, size: 'sm' })}
        <div class="refund-link-main"><div>${linked.merchant}</div><div class="muted">${fmt(linked.amount)} on ${fmtDate(linked.date, { year: 'always' })}</div></div>
        <button type="button" class="btn btn-sm btn-secondary" onclick="setRefundOf('${txn.id}', null)">Unlink</button>
      </div>`;
  } else if (txn.refundOf) {
    el.innerHTML = html`<div class="edit-label">Refund of</div><div class="refund-link"><div class="refund-link-main muted">A purchase that's no longer here</div><button type="button" class="btn btn-sm btn-secondary" onclick="setRefundOf('${txn.id}', null)">Unlink</button></div>`;
  } else {
    el.innerHTML = html`<div class="edit-label">Refund of</div><button type="button" class="btn btn-sm btn-secondary" onclick="loadRefundCandidates('${txn.id}')">${icon('link')} Link to the purchase it reverses</button>`;
  }
}

async function loadRefundCandidates(txnId) {
  const el = document.getElementById('edit-refund');
  if (!el) return;
  let candidates = [];
  try { candidates = (await api('GET', `/api/transactions/${txnId}/refund-candidates`)).candidates; }
  catch (err) { showToast('Could not look for matches: ' + err.message, 'error'); return; }
  el.innerHTML = html`
    <div class="edit-label">Refund of</div>
    ${candidates.length ? html`<div class="refund-candidates">${candidates.map(c => html`
      <button type="button" class="refund-candidate ${c.exact && c.sameMerchant ? 'refund-candidate-best' : ''}" onclick="setRefundOf('${txnId}', '${c.id}')">
        ${merchantAvatar(c.merchant, { category: c.category, size: 'sm' })}
        <span class="refund-candidate-main"><span>${c.merchant}</span><span class="muted">${fmtDate(c.date, { year: 'always' })}${c.alsoRefunded ? ' · already has a refund' : ''}</span></span>
        <span class="amount amount-sm">${fmt(c.amount)}</span>
      </button>`)}</div>` : html`<p class="settings-hint">No purchase in the last few months matches this amount or merchant.</p>`}
    <button type="button" class="btn-link" onclick="renderRefundSection(state.transactions.find(t => t.id === '${txnId}'))">Cancel</button>`;
}

async function setRefundOf(txnId, purchaseId) {
  try {
    const updated = await api('POST', `/api/transactions/${txnId}/refund-of`, { purchaseId });
    const idx = state.transactions.findIndex(t => t.id === txnId);
    if (idx !== -1) state.transactions[idx] = updated;
    state.txVersion++;
    clearDashboardCaches();
    if (updated.category) document.getElementById('edit-category').value = updated.category;
    renderRefundSection(updated);
    renderTransactions();
    showToast(purchaseId ? 'Refund linked to its purchase' : 'Refund unlinked', 'success');
  } catch (err) {
    showToast('Could not link: ' + err.message, 'error');
  }
}

function _fillEditModal({ title, subtitle, txn }) {
  document.getElementById('edit-modal-title').textContent = title;
  document.getElementById('edit-modal-subtitle').textContent = subtitle;
  renderTxnDetails(txn);
  document.getElementById('edit-merchant').value = txn?.merchant || '';
  document.getElementById('edit-date').value = txn?.date || new Date().toISOString().slice(0, 10);
  document.getElementById('edit-notes').value = txn?.notes || '';
  document.getElementById('edit-category').innerHTML = categoryOptions(txn?.category || '', { blank: '— Uncategorized —', custom: false });
  const shekels = txn?.originalCurrency === 'ILS';
  document.getElementById('edit-currency').value = shekels ? 'ILS' : 'USD';
  document.getElementById('edit-amount').value = txn ? Math.abs(txn.amount) : '';
  document.getElementById('edit-original').value = shekels ? Math.abs(txn.originalAmount) : '';
  document.getElementById('edit-credit').checked = txn ? txn.amount < 0 : false;
  state.editTags = [...(txn?.tags || [])];
  renderEditTags();
  document.getElementById('edit-tag-input').value = '';
  document.getElementById('edit-excluded').checked = Boolean(txn?.excluded);
  document.getElementById('edit-reimbursable').checked = Boolean(txn?.reimbursable);
  document.getElementById('edit-reimbursed').checked = Boolean(txn?.reimbursedAt);
  onEditFlagsChange();
  onEditCurrencyChange();
  renderRefundSection(txn);
  const refunds = txn && txn.amount > 0 ? refundsOf(txn.id) : [];
  const back = document.getElementById('edit-refunded');
  back.style.display = refunds.length ? '' : 'none';
  back.innerHTML = refunds.length ? html`<div class="edit-label">Refunded</div>${refunds.map(r => html`
    <div class="refund-link"><div class="refund-link-main"><div>${fmt(Math.abs(r.amount))} back on ${fmtDate(r.date, { year: 'always' })}</div></div>
    <button type="button" class="btn btn-sm btn-secondary" onclick="openEditModal('${r.id}')">Open</button></div>`)}` : '';
  document.getElementById('edit-modal-overlay').style.display = 'flex';
  document.getElementById('edit-merchant').focus();
}

function openAddModal() {
  state.editingTxnId = null;
  state.addingTransaction = true;
  _fillEditModal({ title: 'Add Transaction', subtitle: 'Enter the details for a new transaction.', txn: null });
}

function openEditModal(txnId) {
  const txn = state.transactions.find(t => t.id === txnId);
  if (!txn) return;
  state.editingTxnId = txnId;
  state.addingTransaction = false;
  _fillEditModal({ title: txn.merchant, subtitle: `${fmt(txn.amount)} on ${fmtDate(txn.date, { year: 'always' })}`, txn });
}

// Shekel entries take the ₪ amount; the dollar figure is worked out from the day's rate
function onEditCurrencyChange() {
  const shekels = document.getElementById('edit-currency').value === 'ILS';
  document.getElementById('edit-amount-field').style.display = shekels ? 'none' : '';
  document.getElementById('edit-original-field').style.display = shekels ? '' : 'none';
  const hint = document.getElementById('edit-fx-hint');
  if (!shekels) { hint.textContent = ''; return; }
  const latest = state.currency?.latest;
  hint.textContent = state.currency?.ilsRate !== 'auto'
    ? `Converted at your fixed rate of ₪${state.currency.ilsRate} per $1.`
    : latest ? `Converted at the day's ECB rate (latest: ₪${latest.rate} per $1).` : `Converted at the day's ECB rate.`;
}

function onEditCreditChange() {
  renderRefundSection(state.editingTxnId ? state.transactions.find(t => t.id === state.editingTxnId) : null);
}

function closeEditModal() {
  const overlay = document.getElementById('edit-modal-overlay');
  if (overlay.style.display === 'none') return;
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
  const category = document.getElementById('edit-category').value || null;
  const notes = document.getElementById('edit-notes').value.trim();
  const credit = document.getElementById('edit-credit').checked;
  const shekels = document.getElementById('edit-currency').value === 'ILS';
  const sign = credit ? -1 : 1;
  const pendingTag = document.getElementById('edit-tag-input').value;
  if (pendingTag) { addEditTag(pendingTag); document.getElementById('edit-tag-input').value = ''; }
  const reimbursable = document.getElementById('edit-reimbursable').checked;
  const existing = state.editingTxnId ? state.transactions.find(t => t.id === state.editingTxnId) : null;
  const repaid = reimbursable && document.getElementById('edit-reimbursed').checked;
  const body = {
    merchant, date, category, notes,
    tags: state.editTags,
    excluded: document.getElementById('edit-excluded').checked,
    reimbursable,
    reimbursedAt: repaid ? (existing?.reimbursedAt || true) : null,
  };
  if (shekels) {
    const orig = parseFloat(document.getElementById('edit-original').value);
    if (isNaN(orig)) { showToast('Enter the shekel amount', 'error'); return; }
    body.originalCurrency = 'ILS';
    body.originalAmount = sign * Math.abs(orig);
  } else {
    const amount = parseFloat(document.getElementById('edit-amount').value);
    if (isNaN(amount)) { showToast('Enter an amount', 'error'); return; }
    body.amount = sign * Math.abs(amount);
    body.originalCurrency = 'USD';
  }
  if (!merchant || !date) { showToast('Merchant and date are required', 'error'); return; }
  try {
    if (state.addingTransaction) {
      const newTxn = await api('POST', '/api/transactions', body);
      state.transactions.push(newTxn);
      showToast('Transaction added', 'success');
    } else {
      const updated = await api('PUT', `/api/transactions/${state.editingTxnId}`, body);
      const idx = state.transactions.findIndex(t => t.id === state.editingTxnId);
      if (idx !== -1) state.transactions[idx] = updated;
      showToast('Transaction updated', 'success');
    }
    state.txVersion++;
    closeEditModal();
    clearDashboardCaches();
    renderTransactions();
    if (state.currentView === 'dashboard') renderDashboard();
    if (state.currentView === 'trips') renderTrips();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

async function deleteTransaction() {
  const txnId = state.editingTxnId;
  if (!txnId) return;
  closeEditModal();
  deleteTransactionById(txnId);
}

async function deleteTransactionById(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!await confirmAction('Delete this transaction?', t ? `${fmt(t.amount)} at ${t.merchant} on ${fmtDate(t.date)}. This cannot be undone.` : 'This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/transactions/${id}`);
    state.transactions = state.transactions.filter(x => x.id !== id);
    for (const x of state.transactions) if (x.refundOf === id) delete x.refundOf;
    state.txVersion++;
    clearDashboardCaches();
    renderTransactions();
    if (state.currentView === 'dashboard') renderDashboard();
    showToast('Transaction deleted', 'success');
  } catch (err) {
    showToast('Could not delete: ' + err.message, 'error');
  }
}

// "+ New category…" from any picker: name it, and it exists from then on
async function createCategoryFromPrompt() {
  const name = await promptDialog({ title: 'New category', label: 'Category name', placeholder: 'e.g. Baby, Pets, Vacation', okText: 'Create' });
  if (!name) return null;
  try {
    await api('POST', '/api/categories', { name });
    const settings = await api('GET', '/api/settings');
    setCategories(settings.categories);
    return name;
  } catch (err) {
    if (/already exists/.test(err.message)) return name;
    showToast(err.message, 'error');
    return null;
  }
}

async function identifyMerchant(txnId) {
  const txn = state.transactions.find(t => t.id === txnId);
  if (!txn) return;
  const btn = document.getElementById(`identify-btn-${txnId}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '…'; }
  try {
    const data = await api('POST', '/api/identify-merchant', { merchant: txn.merchant, rawMerchant: txn.rawSource || txn.merchant });
    if (data.category) {
      await api('PUT', `/api/transactions/${txnId}`, { category: data.category });
      txn.category = data.category;
      await api('POST', '/api/merchants', { merchant: txn.merchant, category: data.category });
      state.merchants = await api('GET', '/api/merchants');
      state.txVersion++;
      clearDashboardCaches();
      renderTransactions();
      showToast(`Identified as ${data.name} · ${data.category}`, 'success');
    } else {
      showToast(`Identified as ${data.name} — no category found`, 'info');
    }
  } catch (err) {
    showToast('Could not identify merchant: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = icon('sparkle'); }
  }
}

function exportCSV() {
  const filtered = getSorted(getFiltered());
  if (!filtered.length) { showToast('No transactions to export', 'error'); return; }
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['Date', 'Merchant', 'Amount (USD)', 'Original Amount', 'Original Currency', 'Category', 'Card', 'Tags', 'Excluded', 'Reimbursable', 'Repaid', 'Refund Of', 'Notes', 'Source'],
    ...filtered.map(t => [t.date || '', q(t.merchant), t.amount.toFixed(2), t.originalAmount ?? '', t.originalCurrency || '', q(t.category), q(t.card), q((t.tags || []).join('; ')), t.excluded ? 'yes' : '', t.reimbursable ? 'yes' : '', t.reimbursedAt || '', q(t.refundOf ? (state.transactions.find(p => p.id === t.refundOf)?.merchant || t.refundOf) : ''), q(t.notes), q(t.source)]),
  ];
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prism-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
