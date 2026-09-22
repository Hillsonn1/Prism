// Startup.

mountIcons();

(async () => {
  try {
    await loadAll();
  } catch (err) {
    const el = document.getElementById('dashboard-empty');
    if (el) el.innerHTML = html`<p class="load-error">Failed to load data — is the server running?<br><small>${err.message}</small></p>`;
  }
  renderDashboard();
  checkForUpdate();
  pollPlaidChanges();
  setInterval(pollPlaidChanges, 60000);
})();
