// Merchants view: the saved merchant → category memory.

function renderMerchants() {
  const entries = Object.entries(state.merchants);
  const search = (document.getElementById('merchant-search')?.value || '').toLowerCase();
  const filtered = search ? entries.filter(([m]) => m.toLowerCase().includes(search)) : entries;
  const txnCounts = {};
  const totals = {};
  const logos = {};
  const thisMonth = new Date().toISOString().slice(0, 7);
  const months = monthsEndingAt(thisMonth, 6);
  const series = {};
  for (const t of state.transactions) {
    txnCounts[t.merchant] = (txnCounts[t.merchant] || 0) + 1;
    if (t.logoUrl && !logos[t.merchant]) logos[t.merchant] = t.logoUrl;
    if (!countsAsSpend(t)) continue;
    totals[t.merchant] = (totals[t.merchant] || 0) + t.amount;
    const m = t.date?.slice(0, 7);
    const i = months.indexOf(m);
    if (i !== -1 && t.amount > 0) (series[t.merchant] = series[t.merchant] || months.map(() => 0))[i] += t.amount;
  }

  const { col, dir } = state.merchantSort;
  filtered.sort((a, b) => {
    let av, bv;
    if (col === 'name') { av = a[0].toLowerCase(); bv = b[0].toLowerCase(); }
    else if (col === 'category') { av = (a[1] || '').toLowerCase(); bv = (b[1] || '').toLowerCase(); }
    else if (col === 'total') { av = totals[a[0]] || 0; bv = totals[b[0]] || 0; }
    else { av = txnCounts[a[0]] || 0; bv = txnCounts[b[0]] || 0; }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  for (const c of ['name', 'category', 'count', 'total']) {
    const el = document.getElementById(`msort-${c}`);
    if (!el) continue;
    el.textContent = col === c ? (dir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
    el.closest('th')?.classList.toggle('msort-active', col === c);
  }

  const empty = document.getElementById('merchants-empty');
  const table = document.getElementById('merchants-table');
  const countEl = document.getElementById('merchants-count');
  if (countEl) countEl.textContent = plural(entries.length, 'merchant');
  if (!filtered.length) {
    empty.style.display = '';
    empty.querySelector('p').textContent = search ? `No merchants match "${search}"` : 'No merchants yet. Import a statement or connect a bank to get started.';
    table.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  table.style.display = '';
  document.getElementById('merchants-body').innerHTML = html`${filtered.map(([merchant, category]) => html`
    <tr>
      <td><div class="merchant-cell">${merchantAvatar(merchant, { logoUrl: logos[merchant], category, size: 'sm' })}<div class="merchant-cell-main"><span class="merchant-link" onclick="jumpToMerchant('${escAttr(merchant)}')" title="See transactions">${merchant}</span>${state.merchantInfo?.[merchant]?.type ? html`<span class="merchant-type muted">${state.merchantInfo[merchant].type}${state.merchantInfo[merchant].nativeName ? html` · <span dir="auto">${state.merchantInfo[merchant].nativeName}</span>` : ''}</span>` : ''}</div></div></td>
      <td>${categoryBadge(category, `openCategoryPopupForMerchant(event,'${escAttr(merchant)}')`)}</td>
      <td>${txnCounts[merchant] || 0}</td>
      <td><div class="merchant-total">${series[merchant] && series[merchant].filter(Boolean).length > 1 ? html`<span class="chart-spark" title="Last 6 months">${sparkline(series[merchant], { width: 48, height: 16, color: categoryColor(category) })}</span>` : ''}<span class="amount">${fmt(totals[merchant] || 0)}</span></div></td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" onclick="showMerchantChart('${escAttr(merchant)}')" title="Spending over time" aria-label="Spending over time">${icon('chart')}</button>
          <button class="icon-btn icon-btn-danger" onclick="deleteMerchant('${escAttr(merchant)}')" title="Forget this merchant" aria-label="Forget this merchant">${icon('trash')}</button>
        </div>
      </td>
    </tr>`)}`;
}

document.getElementById('merchant-search').addEventListener('input', debounce(renderMerchants, 180));
document.querySelectorAll('.m-sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (state.merchantSort.col === col) state.merchantSort.dir = state.merchantSort.dir === 'asc' ? 'desc' : 'asc';
    else { state.merchantSort.col = col; state.merchantSort.dir = col === 'count' || col === 'total' ? 'desc' : 'asc'; }
    renderMerchants();
  });
});

function goToMerchant(merchant) {
  switchView('merchants');
  const search = document.getElementById('merchant-search');
  if (search) search.value = merchant;
  renderMerchants();
}

function showMerchantChart(merchant) {
  const monthly = {};
  for (const t of state.transactions) {
    if (t.merchant !== merchant || t.amount <= 0 || !countsAsSpend(t)) continue;
    const m = t.date?.slice(0, 7);
    if (m) monthly[m] = (monthly[m] || 0) + t.amount;
  }
  const months = Object.keys(monthly);
  if (!months.length) { showToast('No purchases from this merchant yet', 'info'); return; }
  const total = months.reduce((s, m) => s + monthly[m], 0);
  document.getElementById('mcht-modal-title').textContent = merchant;
  document.getElementById('mcht-modal-sub').textContent = `${fmt(total)} total · ${fmt(total / months.length)}/mo avg · ${plural(months.length, 'month')}`;
  document.getElementById('mcht-modal-chart').innerHTML = monthlyBarChart(monthly, categoryColor(state.merchants[merchant] || 'Other'));
  document.getElementById('merchant-chart-overlay').style.display = 'flex';
}

function closeMerchantChart() {
  const overlay = document.getElementById('merchant-chart-overlay');
  overlay.classList.add('closing');
  setTimeout(() => { overlay.style.display = 'none'; overlay.classList.remove('closing'); }, 200);
}

async function deleteMerchant(merchant) {
  if (!await confirmAction(`Forget "${merchant}"?`, 'Its saved category will be removed. Existing transactions keep theirs.', 'Forget')) return;
  try {
    await api('DELETE', `/api/merchants/${encodeURIComponent(merchant)}`);
    state.merchants = await api('GET', '/api/merchants');
    renderMerchants();
    showToast('Merchant forgotten', 'success');
  } catch (err) {
    showToast('Could not remove: ' + err.message, 'error');
  }
}
