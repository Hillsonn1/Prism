// Settings view: AI key, currency, appearance, cards, location, clean-up tools.

const SETTINGS_TABS = ['general', 'bank', 'ai', 'categories', 'cleanup', 'about'];
function showSettingsTab(tab) {
  if (!SETTINGS_TABS.includes(tab)) tab = 'general';
  state.settingsTab = tab;
  document.querySelectorAll('#view-settings [data-tab]').forEach(el => {
    if (el.tagName === 'BUTTON') el.classList.toggle('seg-active', el.dataset.tab === tab);
    else el.style.display = el.dataset.tab === tab ? '' : 'none';
  });
}

async function renderSettings() {
  showSettingsTab(state.settingsTab || 'general');
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
  document.getElementById('review-btn').disabled = !state.hasApiKey;
  renderCategorySettings();
  renderAiSettings();
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

// ---- Categories ----
let _iconNames = [];

async function renderCategorySettings() {
  const el = document.getElementById('categories-list');
  if (!el) return;
  try {
    const data = await api('GET', '/api/categories');
    setCategories(data.categories);
    _iconNames = data.icons || [];
  } catch { return; }
  const counts = {};
  for (const t of state.transactions) if (t.category) counts[t.category] = (counts[t.category] || 0) + 1;
  const rows = state.categories.filter(c => c.name !== 'Unknown' || counts.Unknown);
  el.innerHTML = html`${rows.map(c => {
    const n = counts[c.name] || 0;
    const merged = Boolean(c.redirect);
    return html`
      <div class="cat-row ${c.hidden ? 'cat-row-hidden' : ''}" id="cat-row-${catKey(c.name)}">
        <button type="button" class="cat-icon-btn" style="--av:${c.color}" onclick="openIconPicker(event,'${escAttr(c.name)}')" title="Change icon" aria-label="Change icon for ${c.name}">${icon(c.icon)}</button>
        <label class="cat-color" title="Change color"><input type="color" value="${c.color}" onchange="setCategoryColor('${escAttr(c.name)}', this.value)" aria-label="Color for ${c.name}" /><span class="cat-color-swatch" style="background:${c.color}"></span></label>
        <div class="cat-main">
          <div class="cat-name">${c.name}${c.builtIn ? '' : html` <span class="cat-custom">yours</span>`}${merged ? html` <span class="cat-custom">merged into ${c.redirect}</span>` : c.hidden ? html` <span class="cat-custom">hidden</span>` : ''}</div>
          <div class="cat-meta muted">${n ? plural(n, 'purchase') : 'No purchases yet'}</div>
        </div>
        <div class="cat-actions">
          ${merged
            ? html`<button class="btn btn-sm btn-secondary" onclick="restoreCategory('${escAttr(c.name)}')">Restore</button>`
            : html`
              ${c.builtIn ? '' : html`<button class="icon-btn" onclick="renameCategory('${escAttr(c.name)}')" title="Rename" aria-label="Rename ${c.name}">${icon('pencil')}</button>`}
              <button class="icon-btn" onclick="setCategoryHidden('${escAttr(c.name)}', ${c.hidden ? 'false' : 'true'})" title="${c.hidden ? 'Show in pickers' : 'Hide from pickers'}" aria-label="${c.hidden ? 'Show' : 'Hide'} ${c.name}">${icon(c.hidden ? 'eye' : 'eye-off')}</button>
              <button class="icon-btn" onclick="mergeCategoryPrompt('${escAttr(c.name)}')" title="Merge into another category" aria-label="Merge ${c.name}">${icon('link')}</button>`}
        </div>
      </div>`;
  })}`;
}

async function afterCategoryChange(msg) {
  const settings = await api('GET', '/api/settings');
  setCategories(settings.categories);
  await loadAll();
  clearAllCaches();
  renderCategorySettings();
  if (msg) showToast(msg, 'success');
}

async function addCategoryFromSettings() {
  const name = await createCategoryFromPrompt();
  if (name) afterCategoryChange(`"${name}" added`);
}

async function setCategoryColor(name, color) {
  try { await api('PUT', `/api/categories/${encodeURIComponent(name)}`, { color }); afterCategoryChange(); }
  catch (err) { showToast(err.message, 'error'); }
}

async function setCategoryHidden(name, hidden) {
  try { await api('PUT', `/api/categories/${encodeURIComponent(name)}`, { hidden }); afterCategoryChange(hidden ? `"${name}" hidden from pickers` : `"${name}" is back in pickers`); }
  catch (err) { showToast(err.message, 'error'); }
}

async function renameCategory(name) {
  const to = await promptDialog({ title: 'Rename category', message: 'Every purchase, merchant and limit follows the new name.', label: 'Name', value: name, okText: 'Rename' });
  if (!to || to === name) return;
  try { await api('POST', '/api/categories/rename', { from: name, to }); afterCategoryChange(`Renamed to "${to}"`); }
  catch (err) { showToast(err.message, 'error'); }
}

async function mergeCategoryPrompt(name) {
  const options = state.categories.filter(c => c.name !== name && !c.redirect && c.name !== 'Unknown').map(c => ({ value: c.name, label: c.name }));
  const to = await selectDialog({ title: `Merge "${name}" into…`, message: 'Its purchases, merchant memory and limit move over. A built-in category can be restored later.', label: 'Category', options, okText: 'Merge', danger: true });
  if (!to) return;
  try {
    const r = await api('POST', '/api/categories/merge', { from: name, to });
    afterCategoryChange(`${plural(r.moved, 'purchase')} moved to "${to}"`);
  } catch (err) { showToast(err.message, 'error'); }
}

async function restoreCategory(name) {
  try { await api('POST', '/api/categories/restore', { name }); afterCategoryChange(`"${name}" restored`); }
  catch (err) { showToast(err.message, 'error'); }
}

function openIconPicker(e, name) {
  e.stopPropagation();
  const popup = document.getElementById('icon-popup');
  const current = categoryIcon(name);
  popup.innerHTML = html`<div class="icon-grid">${_iconNames.map(i => html`<button type="button" class="icon-choice ${i === current ? 'icon-choice-active' : ''}" onclick="setCategoryIcon('${escAttr(name)}','${i}')" title="${i}" aria-label="${i}">${icon(i)}</button>`)}</div>`;
  const rect = e.currentTarget.getBoundingClientRect();
  popup.style.display = 'block';
  const w = popup.offsetWidth || 260, h = popup.offsetHeight || 200;
  const below = rect.bottom + 6;
  popup.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - h) : below) + 'px';
  popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)) + 'px';
}
function closeIconPicker() { const p = document.getElementById('icon-popup'); if (p) p.style.display = 'none'; }
async function setCategoryIcon(name, iconName) {
  closeIconPicker();
  try { await api('PUT', `/api/categories/${encodeURIComponent(name)}`, { icon: iconName }); afterCategoryChange(); }
  catch (err) { showToast(err.message, 'error'); }
}
document.addEventListener('click', e => { const p = document.getElementById('icon-popup'); if (p && !p.contains(e.target)) closeIconPicker(); });

// ---- More clean-up ----
async function matchRefunds() {
  await withButton('refunds-btn', 'Matching…', async () => {
    try {
      const { matched } = await api('POST', '/api/cleanup/refunds');
      clearAllCaches();
      await loadAll();
      showToast(matched ? `${plural(matched, 'refund')} linked to ${matched === 1 ? 'its purchase' : 'their purchases'}` : 'No unlinked refunds with a clear match', 'success');
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
  });
}

async function fetchLogos() {
  await withButton('logos-btn', 'Fetching…', async () => {
    try {
      const status = await api('GET', '/api/plaid/status');
      const items = (status.items || []).filter(i => !i.env || i.env === status.env);
      if (!items.length) { showToast('Connect a bank first — logos come from Plaid', 'info'); return; }
      let filled = 0;
      for (const item of items) filled += (await api('POST', `/api/plaid/items/${encodeURIComponent(item.itemId)}/enrich`)).filled || 0;
      await loadAll();
      showToast(filled ? `Details filled in on ${plural(filled, 'purchase')}` : 'Everything already had what Plaid offers', 'success');
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
  });
}

// ---- Claude: options, usage, merchant intelligence, category review ----
async function renderAiSettings() {
  let s;
  try { s = await api('GET', '/api/ai/status'); } catch { return; }
  const toggle = document.getElementById('ai-intel-toggle');
  if (toggle) toggle.checked = s.merchantIntel;
  const modelSel = document.getElementById('ai-model-select');
  if (modelSel) modelSel.value = state.prefs.assistantModel === 'fast' ? 'fast' : 'best';
  const usage = document.getElementById('ai-usage');
  if (usage) {
    const u = s.usage || {};
    const parts = Object.entries(u.features || {}).sort((a, b) => b[1].usd - a[1].usd).slice(0, 4).map(([k, v]) => `${k.replace(/-/g, ' ')} $${v.usd.toFixed(2)}`);
    usage.textContent = u.calls
      ? `This month: ${plural(u.calls, 'call')}, about $${u.usd.toFixed(2)} (${parts.join(' · ')}). ${s.known ? `${plural(s.known, 'merchant')} learned so far.` : ''} Estimates from list prices.`
      : `Nothing spent this month.${s.known ? ` ${plural(s.known, 'merchant')} learned so far.` : ''}`;
  }
  document.getElementById('ai-options').style.display = s.available ? '' : 'none';
}

async function toggleMerchantIntel(on) {
  await savePrefs({ merchantIntel: on });
  showToast(on ? 'Prism will learn new merchants after each sync' : 'Merchant learning paused', 'success');
}

async function setAssistantModel(value) {
  await savePrefs({ assistantModel: value === 'fast' ? 'fast' : 'best' });
  if (typeof ask !== 'undefined') ask.available = null;
  showToast(value === 'fast' ? 'Ask Prism will use Sonnet 5' : 'Ask Prism will use Opus 5', 'success');
}

async function runMerchantIntel() {
  await withButton('intel-btn', 'Learning…', async () => {
    cleanupProgress(true, 0, 'Starting…');
    try {
      const data = await streamProgress('/api/merchants/intel/run', (pct, msg) => cleanupProgress(true, pct, msg));
      const r = data.result;
      clearAllCaches();
      await loadAll();
      renderAiSettings();
      showToast(r.enriched ? `Learned ${plural(r.enriched, 'merchant')}${r.lookedUp ? ` (${r.lookedUp} looked up on the web)` : ''}${r.categorized ? ` · ${plural(r.categorized, 'purchase')} categorized` : ''}` : 'Every merchant is already known', 'success');
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    finally { cleanupProgress(false); }
  });
}

let _reviewProposals = [];
async function reviewCategories() {
  await withButton('review-btn', 'Reviewing…', async () => {
    cleanupProgress(true, 0, 'Starting…');
    try {
      const data = await streamProgress('/api/cleanup/review/run', (pct, msg) => cleanupProgress(true, pct, msg));
      const r = data.result;
      if (!r.proposals.length) { showToast(`Claude reviewed ${plural(r.reviewed, 'merchant')} and agrees with all of them`, 'success'); return; }
      showReviewModal(r);
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    finally { cleanupProgress(false); }
  });
}

function showReviewModal(r) {
  _reviewProposals = r.proposals;
  document.getElementById('review-modal-subtitle').textContent = `Claude reviewed ${plural(r.reviewed, 'merchant')} and would change ${r.proposals.length}. Untick anything you disagree with.`;
  document.getElementById('review-modal-body').innerHTML = html`${r.proposals.map((p, i) => html`
    <label class="review-row">
      <input type="checkbox" class="review-check" data-i="${i}" checked />
      <div class="review-main">
        <div class="review-line"><span class="review-merchant">${p.merchant}</span><span class="muted">${plural(p.count, 'purchase')}</span></div>
        <div class="review-change">${categoryBadge(p.from)} <span class="merge-arrow">→</span> ${categoryBadge(p.to)}</div>
        <div class="review-reason muted">${p.reason}</div>
      </div>
    </label>`)}`;
  document.getElementById('review-modal-overlay').style.display = 'flex';
}
function closeReviewModal() {
  const overlay = document.getElementById('review-modal-overlay');
  overlay.classList.add('closing');
  setTimeout(() => { overlay.style.display = 'none'; overlay.classList.remove('closing'); }, 200);
}
async function applyReview() {
  const changes = [...document.querySelectorAll('#review-modal-body .review-check:checked')].map(c => _reviewProposals[+c.dataset.i]).filter(Boolean).map(p => ({ merchant: p.merchant, category: p.to }));
  closeReviewModal();
  if (!changes.length) return;
  try {
    const r = await api('POST', '/api/cleanup/review/apply', { changes });
    clearAllCaches();
    await loadAll();
    rerenderCurrentView();
    showToast(`${plural(r.moved, 'purchase')} re-categorized across ${plural(r.merchants, 'merchant')}`, 'success');
  } catch (err) { showToast('Failed: ' + err.message, 'error'); }
}
document.getElementById('review-modal-overlay')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeReviewModal(); });
