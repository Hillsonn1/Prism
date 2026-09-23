// Settings view: AI key, currency, appearance, cards, location, clean-up tools.

async function renderSettings() {
  renderPlaidSettings();
  let data;
  try { data = await api('GET', '/api/settings'); } catch { return; }
  applySettings(data);

  const keyStatus = document.getElementById('settings-key-status');
  keyStatus.innerHTML = data.hasApiKey
    ? html`<span class="key-status set">✓ AI enabled</span> <button class="btn-link" onclick="removeApiKey()">Remove key</button>`
    : html`<span class="key-status free">No key set</span>`;

  const cardsEl = document.getElementById('cards-list');
  const cards = [...new Set(state.transactions.map(t => t.card).filter(Boolean))].sort();
  cardsEl.innerHTML = cards.length
    ? html`${cards.map((c, i) => html`
      <div class="card-rename-row">
        <input type="text" id="card-rename-${i}" value="${c}" aria-label="Card name" />
        <button class="btn btn-sm btn-primary" onclick="renameCard('${escAttr(c)}',${i})">Rename</button>
      </div>`)}`
    : html`<p class="muted">No cards yet. Give a statement a card nickname when you import it, or connect a bank.</p>`;

  const locationEl = document.getElementById('settings-location');
  if (data.location) locationEl.value = data.location;
  document.getElementById('location-status').textContent = data.location
    ? `Web searches for unfamiliar merchants are biased toward ${data.location}.`
    : 'City and country, e.g. "Jerusalem, Israel" — helps Claude identify local businesses.';
  renderAbout();

  // Currency
  const cur = data.currency || {};
  const rateSel = document.getElementById('currency-mode');
  const rateInput = document.getElementById('currency-rate');
  rateSel.value = cur.ilsRate === 'auto' ? 'auto' : 'manual';
  rateInput.value = cur.ilsRate === 'auto' ? '' : cur.ilsRate;
  rateInput.style.display = cur.ilsRate === 'auto' ? 'none' : '';
  document.getElementById('currency-status').innerHTML = cur.ilsRate === 'auto'
    ? (cur.latest ? html`<span class="key-status set">₪${cur.latest.rate} per $1 · ECB rate for ${fmtDate(cur.latest.date)}</span>` : html`<span class="key-status free">Daily ECB rate, fetched when needed</span>`)
    : html`<span class="key-status set">Fixed at ₪${cur.ilsRate} per $1</span>`;

  // Appearance
  const theme = state.prefs.theme || 'system';
  document.querySelectorAll('#theme-picker button').forEach(b => b.classList.toggle('btn-active', b.dataset.theme === theme));

  document.getElementById('categorize-btn').textContent = state.hasApiKey ? 'Run' : 'Run (no AI)';
}

async function saveSettings() {
  const key = document.getElementById('settings-api-key')?.value.trim();
  if (!key) { showToast('Please enter an API key', 'error'); return; }
  try {
    await api('POST', '/api/settings', { anthropicApiKey: key });
    document.getElementById('settings-api-key').value = '';
    showToast('API key saved', 'success');
    await loadAll();
    renderSettings();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

async function removeApiKey() {
  if (!await confirmAction('Remove the API key?', 'AI features turn off until you add a key again. Everything else keeps working.', 'Remove')) return;
  try {
    await api('DELETE', '/api/settings/api-key');
    await loadAll();
    renderSettings();
    showToast('API key removed', 'success');
  } catch (err) {
    showToast('Could not remove: ' + err.message, 'error');
  }
}

async function renameCard(oldName, idx) {
  const newName = document.getElementById(`card-rename-${idx}`)?.value.trim();
  if (!newName || newName === oldName) return;
  try {
    await api('POST', '/api/cards/rename', { oldName, newName });
    await loadAll();
    renderSettings();
    showToast('Card renamed', 'success');
  } catch (err) {
    showToast('Could not rename: ' + err.message, 'error');
  }
}

async function saveLocation() {
  const location = document.getElementById('settings-location')?.value.trim() || '';
  try {
    await api('POST', '/api/location', { location });
    showToast('Location saved', 'success');
    renderSettings();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

// ---- Currency ----
function onCurrencyModeChange() {
  const manual = document.getElementById('currency-mode').value === 'manual';
  document.getElementById('currency-rate').style.display = manual ? '' : 'none';
  if (manual) document.getElementById('currency-rate').focus();
}

async function saveCurrency() {
  const manual = document.getElementById('currency-mode').value === 'manual';
  const rate = parseFloat(document.getElementById('currency-rate').value);
  if (manual && !(rate > 0)) { showToast('Enter the shekels per dollar, e.g. 3.6', 'error'); return; }
  try {
    await api('POST', '/api/settings/currency', { ilsRate: manual ? rate : 'auto' });
    showToast('Currency settings saved', 'success');
    renderSettings();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}

// ---- Appearance ----
function setTheme(theme) {
  savePrefs({ theme });
  applyTheme(theme);
  document.querySelectorAll('#theme-picker button').forEach(b => b.classList.toggle('btn-active', b.dataset.theme === theme));
}

// ---- Clean-up tools ----
function cleanupProgress(show, pct = 0, msg = '') {
  const status = document.getElementById('cleanup-status');
  const bar = document.getElementById('cleanup-bar');
  const msgEl = document.getElementById('cleanup-msg');
  if (status) status.style.display = show ? '' : 'none';
  if (bar) bar.style.width = pct + '%';
  if (msgEl) msgEl.textContent = msg;
}

async function withButton(id, label, fn) {
  const btn = document.getElementById(id);
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; if (label) btn.textContent = label; }
  try { await fn(); } finally { if (btn) { btn.disabled = false; btn.textContent = original; } }
}

async function removePayments() {
  await withButton('payments-btn', 'Working…', async () => {
    try {
      const { removed } = await api('POST', '/api/cleanup/payments');
      clearAllCaches();
      await loadAll();
      showToast(removed > 0 ? `${plural(removed, 'payment')} removed` : 'No payments found', 'success');
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
  });
}

async function normalizeNames() {
  await withButton('normalize-btn', 'Working…', async () => {
    try {
      const { updated } = await api('POST', '/api/cleanup/normalize');
      clearAllCaches();
      await loadAll();
      showToast(updated > 0 ? `${plural(updated, 'name')} cleaned up` : 'All names already clean', 'success');
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
  });
}

// Smart Clean: show what would be merged, apply only what the user keeps
async function smartClean() {
  await withButton('dedup-btn', 'Looking…', async () => {
    let proposals;
    try {
      ({ proposals } = await api('POST', '/api/cleanup/dedupe/preview'));
    } catch (err) { showToast('Failed: ' + err.message, 'error'); return; }
    if (!proposals.length) { showToast('No duplicate merchants found — names look clean', 'success'); return; }
    showMergeModal(proposals);
  });
}

function showMergeModal(proposals) {
  document.getElementById('merge-modal-subtitle').textContent = `${plural(proposals.length, 'name')} look like duplicates. Untick any that are really different businesses.`;
  document.getElementById('merge-modal-body').innerHTML = html`${proposals.map((p, i) => html`
    <label class="merge-row">
      <input type="checkbox" class="merge-check" data-from="${p.from}" data-to="${p.to}" checked />
      <span class="merge-from">${p.from}<span class="merchant-count">${p.count}</span></span>
      <span class="merge-arrow">→</span>
      <span class="merge-to">${p.to}</span>
      <span class="merge-reason muted">${p.reason}</span>
    </label>`)}`;
  document.getElementById('merge-modal-overlay').style.display = 'flex';
}

function closeMergeModal() {
  const overlay = document.getElementById('merge-modal-overlay');
  overlay.classList.add('closing');
  setTimeout(() => { overlay.style.display = 'none'; overlay.classList.remove('closing'); }, 200);
}

async function applyMerges() {
  const mapping = {};
  document.querySelectorAll('#merge-modal-body .merge-check:checked').forEach(c => { mapping[c.dataset.from] = c.dataset.to; });
  closeMergeModal();
  if (!Object.keys(mapping).length) return;
  try {
    const { merged, renamed } = await api('POST', '/api/cleanup/dedupe/apply', { mapping });
    clearAllCaches();
    await loadAll();
    showToast(`Merged ${plural(renamed, 'name')} (${plural(merged, 'transaction')} updated)`, 'success');
    rerenderCurrentView();
  } catch (err) { showToast('Could not merge: ' + err.message, 'error'); }
}

async function runCategorize() {
  const btn = document.getElementById('categorize-btn');
  if (btn) btn.disabled = true;
  cleanupProgress(true, 0, 'Starting…');
  try {
    const data = await streamProgress('/api/cleanup/categorize/stream', (p, m) => cleanupProgress(true, p, m));
    clearAllCaches();
    await loadAll();
    const { autoUpdated, suggestions = [], unknownMerchants = [] } = data.result;
    showToast(autoUpdated > 0 ? `${plural(autoUpdated, 'transaction')} categorized` : 'Nothing new to categorize', 'success');
    if (suggestions.length + unknownMerchants.length) showCategoryModal(suggestions, unknownMerchants);
  } catch (err) {
    showToast('Categorization failed: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => cleanupProgress(false), 800);
  }
}

function togglePlaidKeys(force) {
  const form = document.getElementById('plaid-keys');
  const show = force !== undefined ? force : form.style.display === 'none';
  form.style.display = show ? '' : 'none';
  if (show) document.getElementById('plaid-client-id')?.focus();
}

async function renderAbout() {
  const el = document.getElementById('about-content');
  if (!el) return;
  try {
    const a = await api('GET', '/api/about');
    el.innerHTML = html`
      <div class="about-grid">
        <div><span class="about-label">Version</span><span>${a.version}</span></div>
        <div><span class="about-label">Transactions</span><span>${a.transactions.toLocaleString()}</span></div>
        <div><span class="about-label">Backups</span><span>${a.backups} daily copies</span></div>
        <div><span class="about-label">Data folder</span><span class="about-path">${a.dataDir}</span></div>
      </div>
      ${a.canOpen ? html`<button class="btn btn-secondary btn-sm" style="margin-top:.75rem" onclick="api('POST','/api/about/open-data-folder')">Open data folder</button>` : ''}`;
  } catch { el.textContent = ''; }
}

async function recheckCategories() {
  await withButton('recheck-btn', 'Checking…', async () => {
    try {
      const { changed, changes } = await api('POST', '/api/cleanup/recheck');
      clearAllCaches();
      await loadAll();
      if (!changed) { showToast('All automatic categories already match the rules', 'success'); return; }
      const lines = Object.entries(changes).slice(0, 6).map(([m, c]) => `${m}: ${c.from || 'none'} → ${c.to}`);
      showToast(`${plural(changed, 'purchase')} re-categorized`, 'success');
      await confirmDialog({ title: `${plural(changed, 'purchase')} re-categorized`, message: lines.join(' · ') + (Object.keys(changes).length > 6 ? ' · …' : ''), okText: 'OK', cancelText: 'Close' });
      rerenderCurrentView();
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
  });
}
