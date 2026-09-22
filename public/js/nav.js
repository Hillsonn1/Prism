// Navigation between views.

// ---- Navigation ----
function switchView(view, { skipHistory = false, clearHistory = false } = {}) {
  if (clearHistory) {
    state.navHistory = [];
  } else if (!skipHistory && state.currentView && state.currentView !== view) {
    state.navHistory.push(state.currentView);
  }
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`[data-view="${view}"]`).classList.add('active');
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.style.display = state.navHistory.length ? '' : 'none';

  if (view === 'dashboard') renderDashboard();
  if (view === 'transactions') renderTransactions();
  if (view === 'upload') {
    document.getElementById('upload-zone').style.display = '';
    document.getElementById('pending-upload-panel').style.display = 'none';
    renderSources();
  }
  if (view === 'merchants') renderMerchants();
  if (view === 'budget') renderBudget();
  if (view === 'settings') renderSettings();
}

function goBack() {
  if (!state.navHistory.length) return;
  const prev = state.navHistory.pop();
  switchView(prev, { skipHistory: true });
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    switchView(link.dataset.view, { clearHistory: true });
  });
});

