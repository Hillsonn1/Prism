// Transactions view: filters, table, inline category popup, add/edit modal.

function getFiltered() {
  const cat = document.getElementById('filter-category')?.value || '';
  const search = (document.getElementById('filter-merchant')?.value || '').toLowerCase();
  const card = document.getElementById('filter-card')?.value || '';
  const from = document.getElementById('filter-date-from')?.value || '';
  const to = document.getElementById('filter-date-to')?.value || '';
  return state.transactions.filter(t => {
    if (cat === '__uncategorized__' && t.category) return false;
    if (cat && cat !== '__uncategorized__' && (t.category || '') !== cat) return false;
    if (search && ![t.merchant, t.notes, t.category, t.card, t.rawSource].some(v => (v || '').toLowerCase().includes(search))) return false;
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

function rowActions(t) {
  const pre = 'event.stopPropagation();';
  const identify = (!t.category || t.category === 'Unknown') && state.hasApiKey
    ? html`<button class="icon-btn icon-btn-ai" id="identify-btn-${t.id}" onclick="${raw(pre)}identifyMerchant('${t.id}')" title="Identify with AI" aria-label="Identify merchant with AI">${icon('sparkle')}</button>` : '';
  return html`<div class="row-actions">${identify}
    <button class="icon-btn" onclick="${raw(pre)}openEditModal('${t.id}')" title="Edit" aria-label="Edit transaction">${icon('pencil')}</button>
    <button class="icon-btn icon-btn-danger" onclick="${raw(pre)}deleteTransactionById('${t.id}')" title="Delete" aria-label="Delete transaction">${icon('trash')}</button>
  </div>`;
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

  const filtered = getSorted(getFiltered());
  const anyFilter = ['filter-category', 'filter-merchant', 'filter-card', 'filter-month', 'filter-date-from', 'filter-date-to'].some(id => document.getElementById(id)?.value);
  const clearBtn = document.getElementById('filter-clear');
  if (clearBtn) clearBtn.style.visibility = anyFilter ? 'visible' : 'hidden';
  const tbody = document.getElementById('transactions-body');
  const empty = document.getElementById('transactions-empty');
  const table = document.getElementById('transactions-table');
  document.getElementById('txn-count').textContent = plural(filtered.length, 'transaction');
  const totalEl = document.getElementById('txn-total');
  if (totalEl) totalEl.textContent = filtered.length ? fmt(filtered.reduce((s, t) => s + t.amount, 0)) : '';

  const groupBtn = document.getElementById('group-toggle');
  if (groupBtn) {
    groupBtn.textContent = state.groupByVendor ? 'Show individually' : 'Group by merchant';
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
      const g = groups[t.merchant] || (groups[t.merchant] = { merchant: t.merchant, amount: 0, count: 0, category: null, txns: [] });
      g.amount += t.amount;
      g.count++;
      g.txns.push(t);
      if (!g.category && t.category) g.category = t.category;
    }
    const rows = Object.values(groups).sort((a, b) => b.amount - a.amount);
    tbody.innerHTML = html`${rows.map(g => {
      const expanded = state.expandedMerchants.has(g.merchant);
      const groupRow = html`
        <tr class="vendor-group-row" onclick="toggleVendorGroup('${escAttr(g.merchant)}')">
          <td class="vendor-count">${expanded ? '▾' : '▸'} ${g.count}×</td>
          <td style="font-weight:600"><span class="merchant-link" onclick="event.stopPropagation();goToMerchant('${escAttr(g.merchant)}')">${g.merchant}</span></td>
          <td><span class="amount ${g.amount < 0 ? 'amount-credit' : ''}">${fmt(g.amount)}</span></td>
          <td>${categoryBadge(g.category, `event.stopPropagation();openCategoryPopupForMerchant(event,'${escAttr(g.merchant)}')`)}</td>
          <td>
            <div class="row-actions">
              ${(!g.category || g.category === 'Unknown') && state.hasApiKey ? html`<button class="icon-btn icon-btn-ai" id="identify-btn-${g.txns[0].id}" onclick="event.stopPropagation();identifyMerchant('${g.txns[0].id}')" title="Identify with AI" aria-label="Identify merchant with AI">${icon('sparkle')}</button>` : ''}
              <button class="icon-btn" onclick="event.stopPropagation();renameVendorGroup('${escAttr(g.merchant)}')" title="Rename merchant" aria-label="Rename merchant">${icon('pencil')}</button>
              <button class="icon-btn icon-btn-danger" onclick="event.stopPropagation();deleteVendorGroup('${escAttr(g.merchant)}',${g.count})" title="Delete all from this merchant" aria-label="Delete all from merchant">${icon('trash')}</button>
            </div>
          </td>
        </tr>`;
      const detail = expanded ? g.txns.slice().sort((a, b) => b.date.localeCompare(a.date)).map(t => html`
        <tr class="vendor-detail-row txn-row" onclick="openEditModal('${t.id}')" title="Open transaction">
          <td class="vendor-detail-date">${fmtDate(t.date)}</td>
          <td>
            ${t.notes ? html`<span class="txn-note">${t.notes}</span>` : ''}
            ${t.card ? html`<span class="txn-card-badge">${t.card}</span>` : ''}
            ${t.pending ? html`<span class="txn-pending-badge">pending</span>` : ''}
          </td>
          <td>${amountHtml(t, { small: true })}</td>
          <td>${categoryBadge(t.category, `event.stopPropagation();openCategoryPopup(event,'${t.id}')`)}</td>
          <td>${rowActions(t)}</td>
        </tr>`) : '';
      return html`${groupRow}${detail}`;
    })}`;
    return;
  }

  tbody.innerHTML = html`${filtered.map(t => html`
    <tr class="txn-row" onclick="openEditModal('${t.id}')" title="Open transaction">
      <td>${fmtDate(t.date)}</td>
      <td>
        <div><span class="merchant-link" onclick="event.stopPropagation();goToMerchant('${escAttr(t.merchant)}')" title="All purchases from ${t.merchant}">${t.merchant}</span></div>
        ${t.notes ? html`<div class="txn-note">${t.notes}</div>` : ''}
        ${t.card ? html`<div class="txn-card-badge">${t.card}</div>` : ''}${t.pending ? html`<div class="txn-pending-badge">pending</div>` : ''}
      </td>
      <td>${amountHtml(t)}</td>
      <td><div style="display:flex;align-items:center;gap:.4rem">${categoryBadge(t.category, `openCategoryPopup(event,'${t.id}')`)}</div></td>
      <td>${rowActions(t)}</td>
    </tr>`)}`;

  document.querySelectorAll('.sortable').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    const active = th.dataset.col === state.sort.col;
    arrow.textContent = active ? (state.sort.dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
    th.classList.toggle('sort-active', active);
  });
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
  }
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
  for (const id of ['filter-category', 'filter-merchant', 'filter-month', 'filter-card', 'filter-date-from', 'filter-date-to']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
}

function clearFilters() {
  clearFilterInputs();
  renderTransactions();
}

document.querySelectorAll('.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (state.sort.col === col) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort.col = col; state.sort.dir = col === 'date' || col === 'amount' ? 'desc' : 'asc'; }
    renderTransactions();
  });
});
document.getElementById('filter-merchant')?.addEventListener('input', debounce(renderTransactions, 180));
['filter-category', 'filter-card'].forEach(id => document.getElementById(id)?.addEventListener('change', renderTransactions));
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
    cat = await promptDialog({ title: 'Custom category', label: 'Category name', placeholder: 'e.g. Baby, Pets, Vacation' });
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
  if (e.key === 'Escape') { closeModal(); closeCategoryPopup(); closeEditModal(); }
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
  onEditCurrencyChange();
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
  const body = { merchant, date, category, notes };
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
    state.txVersion++;
    clearDashboardCaches();
    renderTransactions();
    if (state.currentView === 'dashboard') renderDashboard();
    showToast('Transaction deleted', 'success');
  } catch (err) {
    showToast('Could not delete: ' + err.message, 'error');
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
    ['Date', 'Merchant', 'Amount (USD)', 'Original Amount', 'Original Currency', 'Category', 'Card', 'Notes', 'Source'],
    ...filtered.map(t => [t.date || '', q(t.merchant), t.amount.toFixed(2), t.originalAmount ?? '', t.originalCurrency || '', q(t.category), q(t.card), q(t.notes), q(t.source)]),
  ];
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prism-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
