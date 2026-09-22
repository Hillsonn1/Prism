// Statements view: upload flow and imported statements.

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
  document.getElementById('statement-currency').value = state.prefs.uploadCurrency === 'ILS' ? 'ILS' : 'USD';
  document.getElementById('statement-name-input').focus();
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
      resultEl.innerHTML = html`
        <div class="upload-progress-label"></div>
        <div class="progress-bar-wrap" style="margin-top:.5rem"><div class="progress-bar-fill" style="width:0%"></div></div>`;
    }
    resultEl.querySelector('.upload-progress-label').textContent = msg;
    requestAnimationFrame(() => { const bar = resultEl.querySelector('.progress-bar-fill'); if (bar) bar.style.width = pct + '%'; });
  };
  const fail = msg => {
    resultEl.innerHTML = html`<div class="result-error">❌ ${msg}</div>`;
    document.getElementById('upload-zone').style.display = '';
  };

  showProgress(5, `Uploading ${file.name}…`);
  const form = new FormData();
  form.append('file', file);
  const cardName = document.getElementById('card-name-input')?.value.trim() || '';
  const statementName = document.getElementById('statement-name-input')?.value.trim() || '';
  const currency = document.getElementById('statement-currency')?.value || 'USD';
  if (cardName) form.append('cardName', cardName);
  if (statementName) form.append('statementName', statementName);
  form.append('currency', currency);
  savePrefs({ uploadCurrency: currency });

  let uploadId;
  try {
    const res = await fetch('/api/upload/start', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) return fail(data.error);
    uploadId = data.uploadId;
  } catch (err) {
    return fail(err.message);
  }

  showProgress(10, 'Processing…');
  let data;
  try {
    data = await streamProgress(`/api/upload/stream/${uploadId}`, showProgress);
  } catch (err) {
    return fail(err.message);
  }

  const { imported, duplicates, suggestions = [], unknownMerchants = [] } = data.result;
  resultEl.innerHTML = html`
    <div class="result-success">✅ Imported <strong>${plural(imported, 'transaction')}</strong>${currency === 'ILS' ? ' (converted from shekels)' : ''}</div>
    <div class="upload-stats">
      <div class="upload-stat"><div class="stat-label">Imported</div><div class="stat-value">${imported}</div></div>
      <div class="upload-stat"><div class="stat-label">Duplicates skipped</div><div class="stat-value">${duplicates}</div></div>
      ${suggestions.length ? html`<div class="upload-stat"><div class="stat-label">To confirm</div><div class="stat-value">${suggestions.length}</div></div>` : ''}
      <div class="upload-stat"><div class="stat-label">Needs input</div><div class="stat-value">${unknownMerchants.length}</div></div>
    </div>`;
  clearAllCaches();
  await loadAll();
  document.getElementById('upload-zone').style.display = '';
  if (suggestions.length + unknownMerchants.length > 0) showCategoryModal(suggestions, unknownMerchants);
  else showToast('Import complete', 'success');
}

// ---- The page: bank sync at a glance, then statements ----
async function renderImportPage() {
  renderImportBankCard();
  renderSources();
}

async function renderImportBankCard() {
  const card = document.getElementById('import-bank-card');
  if (!card) return;
  let s;
  try { s = await api('GET', '/api/plaid/status'); } catch { card.style.display = 'none'; return; }
  if (!s.items.length) {
    card.innerHTML = html`
      <div class="bank-cta">
        <div class="bank-cta-icon">${icon('bank')}</div>
        <div class="bank-cta-text">
          <div class="bank-cta-title">Skip the statements</div>
          <div class="muted">Connect a bank or card through Plaid and new purchases show up on their own.</div>
        </div>
        <button class="btn btn-primary" onclick="goToSection('settings','plaid-card')">Connect a bank</button>
      </div>`;
    return;
  }
  card.innerHTML = html`
    <div class="card-title-row">
      <h2 class="card-title" style="margin-bottom:0">Connected banks</h2>
      <div class="header-actions">
        <span class="muted card-title-note">${s.syncing ? 'Syncing…' : s.lastSyncAt ? `Checked ${fmtAgo(s.lastSyncAt)}` : ''}</span>
        <button class="btn btn-secondary btn-sm" onclick="plaidSyncNow()">${icon('refresh')} Sync now</button>
        <button class="btn-link" onclick="goToSection('settings','plaid-card')">Manage</button>
      </div>
    </div>
    <div class="bank-list">${s.items.map(item => html`
      <div class="bank-row ${item.lastError ? 'has-error' : ''}">
        <span class="bank-row-icon">${icon('bank')}</span>
        <div class="bank-row-main">
          <div class="bank-row-name">${item.institutionName}</div>
          <div class="muted bank-row-meta">${item.accounts.filter(a => a.enabled).map(a => a.card || a.name).join(' · ')}</div>
        </div>
        <div class="bank-row-status">${item.lastError ? html`<span class="key-status unset">Needs attention</span>` : item.lastSyncAt ? html`<span class="muted">Synced ${fmtAgo(item.lastSyncAt)}</span>` : html`<span class="muted">First sync pending</span>`}</div>
      </div>`)}</div>`;
}

// ---- Imported statements ----
async function renderSources() {
  const sources = await api('GET', '/api/sources');
  const card = document.getElementById('sources-card');
  const list = document.getElementById('sources-list');
  const allCards = [...new Set(state.transactions.map(t => t.card).filter(Boolean))].sort();
  const dl = document.getElementById('card-suggestions');
  if (dl) dl.innerHTML = html`${allCards.map(c => html`<option value="${c}">`)}`;
  if (!sources.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const rowsFor = s => state.transactions.filter(t => t.source === s);
  list.innerHTML = html`${sources.map((s, i) => {
    const rows = rowsFor(s);
    const cards = [...new Set(rows.map(t => t.card).filter(Boolean))];
    const synced = rows.some(t => t.plaidId);
    return html`
    <li class="source-item">
      <div class="source-edit-row">
        <div class="source-edit-fields">
          <input type="text" class="source-name-input" id="src-name-${i}" value="${s}" placeholder="Statement name" aria-label="Statement name" />
          <input type="text" class="source-card-input" id="src-card-${i}" value="${cards.length === 1 ? cards[0] : ''}" placeholder="Card (optional)" list="card-suggestions" aria-label="Card" />
        </div>
        <div class="source-meta muted">${plural(rows.length, 'transaction')}${synced ? ' · bank sync' : ''}</div>
        <div class="source-actions">
          <button class="btn btn-sm btn-primary" onclick="saveSource('${escAttr(s)}', ${i})">Save</button>
          <button class="btn btn-sm btn-danger" onclick="deleteSource('${escAttr(s)}')">Remove</button>
        </div>
      </div>
    </li>`;
  })}`;
}

async function saveSource(oldName, idx) {
  const newName = document.getElementById(`src-name-${idx}`)?.value.trim();
  const card = document.getElementById(`src-card-${idx}`)?.value.trim();
  if (!newName) { showToast('Statement name cannot be empty', 'error'); return; }
  try {
    await api('POST', '/api/sources/update', { oldName, newName, card });
    await loadAll();
    renderSources();
    showToast('Statement updated', 'success');
  } catch (err) {
    showToast('Could not update: ' + err.message, 'error');
  }
}

async function deleteSource(source) {
  const count = state.transactions.filter(t => t.source === source).length;
  if (!await confirmAction(`Remove "${source}"?`, `${plural(count, 'transaction')} imported from it will be deleted. This cannot be undone.`, 'Remove')) return;
  try {
    await api('DELETE', `/api/transactions?source=${encodeURIComponent(source)}`);
    clearAllCaches();
    await loadAll();
    await renderSources();
    showToast('Statement removed', 'success');
  } catch (err) {
    showToast('Could not remove: ' + err.message, 'error');
  }
}
