// Trips view: a tag plus a date range, with a report per trip.

state.tripId = null;      // open trip, or null for the list
state.editingTripId = null;
state.tripSuggestions = [];

const tripTxns = trip => state.transactions.filter(t => (t.tags || []).includes(trip.tag));
const tripDays = trip => Math.round((Date.parse(trip.end) - Date.parse(trip.start)) / 86400000) + 1;
function tripStats(trip) {
  const txns = tripTxns(trip);
  const counted = txns.filter(countsAsSpend);
  const total = counted.reduce((s, t) => s + t.amount, 0);
  const byCat = {};
  for (const t of counted) { if (t.amount <= 0) continue; const c = t.category || 'Uncategorized'; byCat[c] = (byCat[c] || 0) + t.amount; }
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const ils = counted.filter(t => t.originalCurrency === 'ILS').reduce((s, t) => s + (t.originalAmount || 0), 0);
  const days = tripDays(trip);
  return { txns, counted, total, cats, ils, days, perDay: total / Math.max(days, 1) };
}
const tripRange = trip => `${fmtDate(trip.start, { year: 'auto' })} – ${fmtDate(trip.end, { year: 'auto' })}`;

async function renderTrips() {
  try {
    const data = await api('GET', '/api/trips');
    state.trips = data.trips || [];
    state.tripSuggestions = data.suggestions || [];
  } catch {}
  const trip = state.tripId ? state.trips.find(t => t.id === state.tripId) : null;
  if (state.tripId && !trip) state.tripId = null;
  renderTripSuggestions();
  const el = document.getElementById('trips-content');
  if (!el) return;
  if (trip) { renderTripDetail(el, trip); return; }
  if (!state.trips.length) {
    el.innerHTML = html`
      <div class="card empty-state">
        <div class="empty-icon">${icon('map-pin')}</div>
        <h2>No trips yet</h2>
        <p>A trip gathers everything you spent between two dates — with the total, the daily average and where it went.</p>
        <div class="empty-actions"><button class="btn btn-primary" onclick="openTripModal()">${icon('plus')} New trip</button></div>
        <p class="empty-hint">You can also tag any purchase with a trip's name from its edit window.</p>
      </div>`;
    return;
  }
  const sorted = [...state.trips].sort((a, b) => b.start.localeCompare(a.start));
  el.innerHTML = html`<div class="trip-grid">${sorted.map(trip => {
    const s = tripStats(trip);
    const max = s.cats[0]?.[1] || 1;
    return html`
      <div class="card trip-card" onclick="openTrip('${trip.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openTrip('${trip.id}')">
        <div class="trip-card-head">
          <div><div class="trip-name">${trip.name}</div><div class="trip-dates muted">${tripRange(trip)} · ${plural(s.days, 'day')}</div></div>
          <div class="trip-total">${fmt(s.total)}</div>
        </div>
        <div class="trip-card-meta muted">${fmt(s.perDay)} a day · ${plural(s.counted.length, 'purchase')}${s.ils ? html` · ${ils.format(Math.round(s.ils))}` : ''}</div>
        <div class="trip-cats">${s.cats.slice(0, 4).map(([c, amt]) => html`
          <div class="trip-cat-row"><span class="trip-cat-name" style="color:${categoryColor(c)}">${icon(categoryIcon(c))} ${c}</span><span class="chart-bar-wrap"><span class="chart-bar" style="width:${(amt / max * 100).toFixed(1)}%;background:${categoryColor(c)}"></span></span><span class="trip-cat-amt">${fmt(amt)}</span></div>`)}</div>
      </div>`;
  })}</div>`;
}

function renderTripSuggestions() {
  const el = document.getElementById('trip-suggestions');
  if (!el) return;
  const list = state.tripId ? [] : state.tripSuggestions;
  el.innerHTML = html`${list.map((sg, i) => html`
    <div class="anomaly-row trip-suggestion">
      <span class="anomaly-icon">${icon('map-pin')}</span>
      <div style="flex:1"><span class="anomaly-label">Looks like a trip</span><span class="anomaly-detail">${fmtDate(sg.start)} – ${fmtDate(sg.end)} · ${plural(sg.purchases, 'purchase')} in ${sg.country} · ${fmt(sg.total)}</span></div>
      <button class="btn btn-sm btn-primary" onclick="openTripModal(null, ${i})">Create trip</button>
    </div>`)}`;
}

function openTrip(id) {
  state.tripId = id;
  renderTrips();
  window.scrollTo({ top: 0 });
}
function closeTrip() {
  state.tripId = null;
  renderTrips();
}

function renderTripDetail(el, trip) {
  const s = tripStats(trip);
  const max = s.cats[0]?.[1] || 1;
  const days = [];
  for (const t of getSorted(s.txns)) {
    const last = days[days.length - 1];
    if (last && last.date === t.date) last.txns.push(t); else days.push({ date: t.date, txns: [t] });
  }
  const untagged = state.transactions.filter(t => t.date >= trip.start && t.date <= trip.end && !(t.tags || []).includes(trip.tag)).length;
  el.innerHTML = html`
    <div class="trip-detail-head">
      <button class="btn btn-secondary btn-sm" onclick="closeTrip()">${icon('arrow-left')} All trips</button>
      <div class="trip-detail-title"><h2>${trip.name}</h2><div class="muted">${tripRange(trip)} · ${plural(s.days, 'day')}</div></div>
      <div class="header-actions">
        ${untagged ? html`<button class="btn btn-secondary btn-sm" onclick="retagTrip('${trip.id}')" title="Tag purchases in these dates that aren't tagged yet">${icon('plus')} Add ${plural(untagged, 'purchase')} from these dates</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="filterByTag('${escAttr(trip.tag)}')">${icon('list')} In Transactions</button>
        <button class="btn btn-secondary btn-sm" onclick="openTripModal('${trip.id}')">${icon('pencil')} Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTrip('${trip.id}')">${icon('trash')} Delete</button>
      </div>
    </div>
    <div class="stat-tiles">
      <div class="stat-tile"><div class="stat-label">Spent</div><div class="stat-value">${fmt(s.total)}</div><div class="stat-sub">${plural(s.counted.length, 'purchase')}${s.txns.length !== s.counted.length ? ` · ${s.txns.length - s.counted.length} left out` : ''}</div></div>
      <div class="stat-tile"><div class="stat-label">Per day</div><div class="stat-value">${fmt(s.perDay)}</div><div class="stat-sub">over ${plural(s.days, 'day')}</div></div>
      ${s.cats[0] ? html`<div class="stat-tile stat-clickable" onclick="drillTripCategory('${escAttr(trip.tag)}','${escAttr(s.cats[0][0])}')"><div class="stat-label">Biggest category</div><div class="stat-value stat-value-sm" style="color:${categoryColor(s.cats[0][0])}">${s.cats[0][0]}</div><div class="stat-sub">${fmt(s.cats[0][1])} · ${Math.round(s.cats[0][1] / Math.max(s.total, 1) * 100)}%</div></div>` : ''}
      ${s.ils ? html`<div class="stat-tile"><div class="stat-label">In shekels</div><div class="stat-value">${ils.format(Math.round(s.ils))}</div><div class="stat-sub">converted at each day's rate</div></div>` : ''}
    </div>
    ${s.cats.length ? html`<div class="card"><h2 class="card-title">Where it went</h2>${s.cats.map(([c, amt]) => html`
      <div class="chart-row chart-clickable" onclick="drillTripCategory('${escAttr(trip.tag)}','${escAttr(c)}')">
        <div class="chart-label" style="color:${categoryColor(c)}">${icon(categoryIcon(c))} ${c}</div>
        <div class="chart-bar-wrap"><div class="chart-bar" style="width:${(amt / max * 100).toFixed(1)}%;background:${categoryColor(c)}"></div></div>
        <div class="chart-amount">${fmt(amt)}</div>
      </div>`)}</div>` : ''}
    <div class="card table-card">
      ${s.txns.length ? html`<div class="txn-list">${days.map(d => html`
        <div class="txn-day">
          <div class="txn-day-head"><span class="txn-day-label">${dayLabel(d.date)}</span><span class="txn-day-total">${fmt(d.txns.filter(countsAsSpend).reduce((a, t) => a + t.amount, 0))}</span></div>
          <div class="txn-day-body">${d.txns.map(t => txnItem(t))}</div>
        </div>`)}</div>`
      : html`<div class="empty-state"><p>Nothing tagged "${trip.tag}" yet.</p>${untagged ? html`<button class="btn btn-primary btn-sm" onclick="retagTrip('${trip.id}')">Add the ${plural(untagged, 'purchase')} from these dates</button>` : ''}</div>`}
    </div>`;
}

function drillTripCategory(tag, category) {
  clearFilterInputs();
  state.jumpToCategory = category === 'Uncategorized' ? '__uncategorized__' : category;
  switchView('transactions');
  const sel = document.getElementById('filter-tag');
  if (sel) { sel.value = tag; renderTransactions(); }
}

// ---- Create / edit ----
function openTripModal(tripId = null, suggestionIndex = null) {
  const trip = tripId ? state.trips.find(t => t.id === tripId) : null;
  const sg = suggestionIndex !== null ? state.tripSuggestions[suggestionIndex] : null;
  state.editingTripId = trip?.id || null;
  document.getElementById('trip-modal-title').textContent = trip ? 'Edit trip' : 'New trip';
  document.getElementById('trip-name').value = trip?.name || (sg ? `${sg.country} · ${fmtMonth(sg.start.slice(0, 7), 'short')}` : '');
  document.getElementById('trip-start').value = trip?.start || sg?.start || '';
  document.getElementById('trip-end').value = trip?.end || sg?.end || '';
  document.getElementById('trip-include-all').checked = false;
  document.getElementById('trip-include-all-wrap').style.display = trip ? 'none' : '';
  document.getElementById('trip-save-btn').textContent = trip ? 'Save' : 'Create trip';
  document.getElementById('trip-modal-hint').textContent = trip ? 'Renaming the trip renames its tag on every purchase.' : '';
  const overlay = document.getElementById('trip-modal-overlay');
  overlay.style.display = 'flex';
  requestAnimationFrame(() => document.getElementById('trip-name').focus());
}
function closeTripModal() {
  const overlay = document.getElementById('trip-modal-overlay');
  if (overlay.style.display === 'none') return;
  overlay.classList.add('closing');
  setTimeout(() => { overlay.style.display = 'none'; overlay.classList.remove('closing'); state.editingTripId = null; }, 200);
}
async function saveTripModal() {
  const name = document.getElementById('trip-name').value.trim();
  const start = document.getElementById('trip-start').value;
  const end = document.getElementById('trip-end').value;
  const includeAll = document.getElementById('trip-include-all').checked;
  if (!name || !start || !end) { showToast('Give the trip a name and both dates', 'error'); return; }
  try {
    if (state.editingTripId) {
      await api('PUT', `/api/trips/${state.editingTripId}`, { name, start, end });
      showToast('Trip updated', 'success');
    } else {
      const r = await api('POST', '/api/trips', { name, start, end, includeAll });
      state.tripId = r.trip.id;
      showToast(r.tagged ? `Trip created — ${plural(r.tagged, 'purchase')} tagged` : 'Trip created', 'success');
    }
    closeTripModal();
    await loadAll();
    renderTrips();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
async function retagTrip(id) {
  try {
    const r = await api('POST', `/api/trips/${id}/retag`, { includeAll: true });
    await loadAll();
    renderTrips();
    showToast(r.tagged ? `${plural(r.tagged, 'purchase')} added to the trip` : 'Nothing new to add', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}
async function deleteTrip(id) {
  const trip = state.trips.find(t => t.id === id);
  if (!trip) return;
  const answer = await confirmDialog({
    title: `Delete "${trip.name}"?`,
    message: 'The trip report goes away. Your purchases stay.',
    okText: 'Delete',
    danger: true,
    checkbox: { label: `Also remove the "${trip.tag}" tag from its purchases`, checked: true },
  });
  if (!answer) return;
  try {
    await api('DELETE', `/api/trips/${id}?removeTags=${answer.checked ? 1 : 0}`);
    state.tripId = null;
    await loadAll();
    renderTrips();
    showToast('Trip deleted', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}
document.getElementById('trip-modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeTripModal(); });
document.getElementById('trip-modal-overlay')?.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); saveTripModal(); } });
