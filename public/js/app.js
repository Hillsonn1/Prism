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
  checkForUpdate();
  api('GET', '/api/version').then(v => { const el = document.getElementById('sidebar-version'); if (el) el.textContent = `Prism ${v.version}`; }).catch(() => {});
  pollPlaidChanges();
  setInterval(pollPlaidChanges, 60000);
})();
