// Startup.

mountIcons();
if (navigator.userAgent.includes('Electron')) document.documentElement.dataset.electron = 'true';
if (navigator.platform.startsWith('Mac')) document.documentElement.dataset.platform = 'mac';

(async () => {
  try {
    await loadAll();
  } catch (err) {
    const el = document.getElementById('dashboard-empty');
    if (el) { el.innerHTML = html`<p class="load-error">Failed to load data — is the server running?<br><small>${err.message}</small></p>`; el.style.display = ''; }
  }
  renderDashboard();
  if (state.hosted) renderAccount(); else checkForUpdate();
  api('GET', '/api/version').then(v => { const el = document.getElementById('sidebar-version'); if (el) el.textContent = `Prism ${v.version}`; }).catch(() => {});
  pollPlaidChanges();
  setInterval(pollPlaidChanges, 60000);
})();

// Hosted version: who's signed in, and a way out
async function renderAccount() {
  try {
    const { user } = await api('GET', '/api/auth/me');
    state.user = user;
    const el = document.getElementById('sidebar-account');
    if (el && user) el.innerHTML = html`<span class="sidebar-user" title="${user.email}">${user.name || user.email}</span><button class="btn-link sidebar-signout" onclick="signOut()">Sign out</button>`;
  } catch {}
}
async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch {}
  location.href = '/login';
}
