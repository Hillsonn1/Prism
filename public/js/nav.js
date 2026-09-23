// Navigation between views.

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
  if (backBtn) backBtn.style.visibility = state.navHistory.length ? 'visible' : 'hidden'; // keeps its space so the nav never jumps
  window.scrollTo({ top: 0 });

  if (view === 'dashboard') renderDashboard();
  if (view === 'transactions') renderTransactions();
  if (view === 'upload') {
    document.getElementById('upload-zone').style.display = '';
    document.getElementById('pending-upload-panel').style.display = 'none';
    renderImportPage();
  }
  if (view === 'merchants') renderMerchants();
  if (view === 'budget') renderBudget();
  if (view === 'settings') renderSettings();
}

function goBack() {
  if (!state.navHistory.length) return;
  switchView(state.navHistory.pop(), { skipHistory: true });
}

// Jump to a section on a page (e.g. the bank-sync card in Settings)
function goToSection(view, sectionId) {
  switchView(view);
  requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function rerenderCurrentView() {
  const v = state.currentView;
  if (v === 'dashboard') renderDashboard();
  else if (v === 'transactions') renderTransactions();
  else if (v === 'merchants') renderMerchants();
  else if (v === 'budget') renderBudget();
  else if (v === 'settings') renderSettings();
  else if (v === 'upload') renderImportPage();
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    switchView(link.dataset.view, { clearHistory: true });
  });
});
