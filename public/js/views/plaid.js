// Bank Sync (Plaid) settings and background sync polling.

async function renderPlaidSettings() {
  let s;
  try { s = await api('GET', '/api/plaid/status'); } catch { return; }
  state.plaidChangeCounter = s.changeCounter;

  const statusEl = document.getElementById('plaid-status');
  if (statusEl) {
    statusEl.innerHTML = s.configured
      ? html`<span class="key-status set">${s.env === 'production' ? 'Production' : 'Sandbox'} keys</span>`
      : html`<span class="key-status free">Not set up</span>`;
  }
  const envEl = document.getElementById('plaid-env');
  if (envEl) envEl.value = s.env || 'sandbox';
  const idEl = document.getElementById('plaid-client-id');
  if (idEl && s.clientId) idEl.value = s.clientId;
  const secretEl = document.getElementById('plaid-secret');
  if (secretEl) secretEl.placeholder = s.configured ? 'Secret (saved)' : 'Secret';

  const toggle = document.getElementById('plaid-keys-toggle');
  if (toggle) toggle.textContent = s.configured ? 'Change keys' : 'Set up Plaid keys';
  const keys = document.getElementById('plaid-keys');
  if (keys && !s.configured) keys.style.display = '';

  const connectBtn = document.getElementById('plaid-connect-btn');
  if (connectBtn) {
    connectBtn.disabled = !s.configured;
    connectBtn.title = s.configured ? '' : 'Save your Plaid keys first';
  }

  const list = document.getElementById('plaid-connections');
  if (!list) return;
  if (!s.items.length) {
    list.innerHTML = s.configured
      ? html`<p class="muted" style="margin:0 0 .5rem">No banks connected yet.</p>`
      : html`<p class="muted" style="margin:0 0 .5rem">You'll need a free Plaid developer account — keys go below.</p>`;
    return;
  }
  const note = s.syncing ? 'Syncing…' : s.lastSyncAt ? `Last checked ${fmtAgo(s.lastSyncAt)} · every ${s.syncIntervalMinutes} min` : '';
  list.innerHTML = html`${note ? html`<p class="muted plaid-sync-note">${note}</p>` : ''}${s.items.map(renderPlaidItem)}`;
  renderSidebarFooter(s);
}

function renderPlaidItem(item) {
  const err = item.lastError;
  const historyPending = !err && item.updateStatus && item.updateStatus !== 'HISTORICAL_UPDATE_COMPLETE';
  const meta = err ? `⚠️ ${esc(err.message)}`
    : !item.lastSyncAt ? 'Waiting for first sync…'
    : historyPending ? `Synced ${fmtAgo(item.lastSyncAt)} · Plaid is still pulling history`
    : `Synced ${fmtAgo(item.lastSyncAt)}`;
  const accounts = item.accounts.map(a => `
    <div class="plaid-account">
      <label class="plaid-account-toggle">
        <input type="checkbox" ${a.enabled ? 'checked' : ''}
          onchange="plaidUpdateAccount('${escAttr(item.itemId)}','${escAttr(a.accountId)}',{enabled:this.checked})" />
        <span>${esc(a.name)} <span class="muted">••${esc(a.mask)}</span></span>
      </label>
      <input type="text" value="${esc(a.card || '')}" placeholder="Card nickname" list="card-suggestions"
        onchange="plaidUpdateAccount('${escAttr(item.itemId)}','${escAttr(a.accountId)}',{card:this.value})" />
    </div>`).join('');
  return `
    <div class="plaid-item${err ? ' has-error' : ''}">
      <div class="plaid-item-head">
        <div>
          <div class="plaid-item-name">${esc(item.institutionName)}</div>
          <div class="muted plaid-item-meta">${meta}</div>
        </div>
        <div class="plaid-item-actions">
          ${err ? `<button class="btn btn-sm btn-primary" onclick="plaidConnect('${escAttr(item.itemId)}')">Reconnect</button>` : ''}
          <button class="btn btn-sm btn-secondary" onclick="plaidSyncNow('${escAttr(item.itemId)}')">Sync now</button>
          <button class="btn btn-sm btn-danger" onclick="plaidDisconnect('${escAttr(item.itemId)}','${escAttr(item.institutionName)}')">Disconnect</button>
        </div>
      </div>
      <div class="plaid-accounts">${accounts}</div>
    </div>`;
}

async function savePlaidSettings() {
  const clientId = document.getElementById('plaid-client-id')?.value.trim();
  const secret = document.getElementById('plaid-secret')?.value.trim();
  const env = document.getElementById('plaid-env')?.value;
  if (!clientId) { showToast('Enter your Plaid client ID', 'error'); return; }
  try {
    const r = await api('POST', '/api/plaid/settings', { clientId, secret, env });
    document.getElementById('plaid-secret').value = '';
    showToast(r.verified ? 'Plaid keys verified and saved' : 'Plaid keys saved', 'success');
    renderPlaidSettings();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

let plaidLinkPoll = null;

// Opens Plaid's hosted page in the system browser, then polls until the user finishes there
async function plaidConnect(itemId) {
  try {
    const { linkToken, url, opened } = await api('POST', '/api/plaid/link/start', itemId ? { itemId } : {});
    if (!opened) window.open(url, '_blank'); // outside Electron the server can't open a browser for us
    document.getElementById('plaid-link-open').href = url;
    document.getElementById('plaid-link-wait').style.display = '';
    clearInterval(plaidLinkPoll);
    plaidLinkPoll = setInterval(async () => {
      try {
        const r = await api('GET', `/api/plaid/link/status/${encodeURIComponent(linkToken)}`);
        if (r.status === 'pending') return;
        plaidCancelLink();
        if (r.status === 'linked') {
          showToast(`${r.item.institutionName} connected — pulling transactions…`, 'success');
          renderPlaidSettings();
        } else if (r.status === 'exited') {
          showToast('Bank connection cancelled', 'error');
        } else if (r.status === 'expired') {
          showToast('That Plaid link expired — try again', 'error');
        }
      } catch (err) {
        plaidCancelLink();
        showToast('Could not finish connecting: ' + err.message, 'error');
      }
    }, 3000);
  } catch (err) {
    showToast('Could not start Plaid: ' + err.message, 'error');
  }
}

function plaidCancelLink() {
  clearInterval(plaidLinkPoll);
  plaidLinkPoll = null;
  const wait = document.getElementById('plaid-link-wait');
  if (wait) wait.style.display = 'none';
}

async function plaidSyncNow(itemId) {
  showToast('Syncing…', 'info');
  try {
    const r = await api('POST', '/api/plaid/sync', itemId ? { itemId } : {});
    await loadAll();
    rerenderCurrentView();
    const parts = [];
    if (r.added) parts.push(`${r.added} new`);
    if (r.updated) parts.push(`${r.updated} updated`);
    if (r.removed) parts.push(`${r.removed} removed`);
    if (r.errors) showToast('A bank connection needs attention — see below', 'error');
    else showToast(parts.length ? `Synced: ${parts.join(', ')}` : 'Up to date — nothing new', 'success');
  } catch (err) {
    showToast('Sync failed: ' + err.message, 'error');
    renderPlaidSettings();
  }
}

async function plaidUpdateAccount(itemId, accountId, patch) {
  try {
    await api('PUT', `/api/plaid/items/${encodeURIComponent(itemId)}/accounts/${encodeURIComponent(accountId)}`, patch);
    if ('card' in patch) { await loadAll(); showToast('Card nickname saved', 'success'); }
  } catch (err) {
    showToast('Could not update account: ' + err.message, 'error');
  }
}

async function plaidDisconnect(itemId, name) {
  const answer = await confirmDialog({
    title: `Disconnect ${name}?`,
    message: 'Prism stops syncing this bank. You can connect it again later.',
    okText: 'Disconnect',
    danger: true,
    checkbox: { label: 'Also delete the transactions already imported from it', checked: false },
  });
  if (!answer) return;
  try {
    await api('DELETE', `/api/plaid/items/${encodeURIComponent(itemId)}?deleteTransactions=${answer.checked ? 1 : 0}`);
    clearAllCaches();
    await loadAll();
    renderSettings();
    showToast(`${name} disconnected`, 'success');
  } catch (err) {
    showToast('Could not disconnect: ' + err.message, 'error');
  }
}


// Background syncs happen server-side; pick up their results without a reload
async function pollPlaidChanges() {
  try {
    const s = await api('GET', '/api/plaid/status');
    renderSidebarFooter(s);
    if (state.plaidChangeCounter === undefined) { state.plaidChangeCounter = s.changeCounter; return; }
    if (s.changeCounter === state.plaidChangeCounter) return;
    state.plaidChangeCounter = s.changeCounter;
    await loadAll();
    rerenderCurrentView();
    const added = s.lastChange?.added || 0;
    if (added) showToast(`${added} new transaction${added !== 1 ? 's' : ''} from your bank`, 'success');
  } catch {}
}


// Small status line at the bottom of the sidebar
function renderSidebarFooter(status) {
  const el = document.getElementById('sidebar-footer');
  if (!el) return;
  if (!status || !status.items?.length) { el.innerHTML = ''; return; }
  const err = status.items.some(i => i.lastError);
  el.innerHTML = html`<button class="sidebar-status ${err ? 'has-error' : ''}" onclick="goToSection('settings','plaid-card')" title="Bank sync">
    ${icon('bank')} <span>${err ? 'Bank needs attention' : status.syncing ? 'Syncing…' : status.lastSyncAt ? `Synced ${fmtAgo(status.lastSyncAt)}` : 'Bank connected'}</span></button>`;
}
