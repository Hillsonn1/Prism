// Review modal for suggested and unknown merchants after an import or clean-up.

function confidenceColor(conf) {
  if (conf >= 0.85) return 'var(--success)';
  if (conf >= 0.7) return 'var(--warning)';
  return 'var(--danger)';
}

function showCategoryModal(suggestions, unknowns) {
  state.pendingItems = { suggestions, unknowns };
  document.getElementById('modal-header-title').textContent = suggestions.length ? 'Review New Merchants' : 'Categorize New Merchants';
  const parts = [];
  if (suggestions.length) parts.push(`${plural(suggestions.length, 'suggestion')} to confirm`);
  if (unknowns.length) parts.push(`${unknowns.length} need${unknowns.length === 1 ? 's' : ''} your input`);
  document.getElementById('modal-subtitle').textContent = parts.join(' · ');

  const suggestionRows = suggestions.map((s, i) => html`
    <div class="suggestion-row" id="suggest-row-${i}" data-status="pending">
      <div class="suggestion-top">
        <div class="suggestion-merchant" title="${s.merchant}">${s.merchant}</div>
        <div class="suggestion-controls">
          <span class="ai-category-pill">
            <span class="confidence-dot" style="background:${confidenceColor(s.confidence)}" title="${Math.round(s.confidence * 100)}% confident"></span>
            ${s.category}
          </span>
          <button class="btn btn-sm btn-confirm" id="suggest-confirm-${i}" onclick="confirmSuggestion(${i})">✓ Looks right</button>
          <button class="btn btn-sm btn-secondary" onclick="editSuggestion(${i})">Change</button>
        </div>
      </div>
      <div class="suggestion-edit" id="suggest-edit-${i}" style="display:none">
        <input type="text" id="suggest-text-${i}" placeholder="Describe this charge (e.g. gas, grocery, streaming…)" oninput="onSuggestionTextInput(${i})" class="category-text-input" />
        <select id="suggest-cat-${i}" aria-label="Category">${categoryOptions(s.category)}</select>
      </div>
    </div>`);

  const unknownRows = unknowns.map((m, i) => html`
    <div class="unknown-row">
      <div class="merchant-name">${m}</div>
      <input type="text" id="modal-text-${i}" placeholder="What is this? (e.g. 'gas', 'grocery store', 'streaming service')" oninput="onCategoryTextInput(${i})" class="category-text-input" />
      <div class="cat-or-label">or pick a category:</div>
      <select id="modal-cat-${i}" data-merchant="${m}" aria-label="Category">${categoryOptions('', { blank: '-- Select category --' })}</select>
    </div>`);

  document.getElementById('modal-body').innerHTML = html`
    ${suggestions.length ? html`<div class="modal-section-title">Suggestions <span class="modal-count">${suggestions.length}</span></div>${suggestionRows}` : ''}
    ${suggestions.length && unknowns.length ? html`<div class="modal-spacer"></div>` : ''}
    ${unknowns.length ? html`<div class="modal-section-title">Needs Your Input <span class="modal-count">${unknowns.length}</span></div>${unknownRows}` : ''}`;
  document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay.style.display === 'none') return;
  overlay.classList.add('closing');
  setTimeout(() => {
    overlay.style.display = 'none';
    overlay.classList.remove('closing');
    state.pendingItems = { suggestions: [], unknowns: [] };
  }, 200);
}

function confirmSuggestion(i) {
  const row = document.getElementById(`suggest-row-${i}`);
  if (!row) return;
  row.dataset.status = 'confirmed';
  const btn = document.getElementById(`suggest-confirm-${i}`);
  if (btn) {
    btn.textContent = '✓ Confirmed';
    btn.className = 'btn btn-sm btn-confirmed';
    btn.disabled = true;
    if (btn.nextElementSibling) btn.nextElementSibling.style.display = 'none';
  }
}

function editSuggestion(i) {
  const row = document.getElementById(`suggest-row-${i}`);
  if (!row) return;
  row.dataset.status = 'editing';
  const editDiv = document.getElementById(`suggest-edit-${i}`);
  if (editDiv) editDiv.style.display = 'flex';
  document.getElementById(`suggest-text-${i}`)?.focus();
}

// "Describe it" boxes: answered locally first, by Claude when a key is set
const _describeTimers = {};
function _describe(key, text, merchant, selectId) {
  clearTimeout(_describeTimers[key]);
  if (!text || text.length < 2) return;
  _describeTimers[key] = setTimeout(async () => {
    try {
      const data = await api('POST', '/api/text-to-category', { text, merchant });
      const sel = document.getElementById(selectId);
      if (data.category && sel) sel.value = data.category;
    } catch {}
  }, 300);
}
function onSuggestionTextInput(i) {
  _describe(`s${i}`, document.getElementById(`suggest-text-${i}`)?.value.trim(), state.pendingItems.suggestions[i]?.merchant, `suggest-cat-${i}`);
}
function onCategoryTextInput(i) {
  _describe(`u${i}`, document.getElementById(`modal-text-${i}`)?.value.trim(), state.pendingItems.unknowns[i], `modal-cat-${i}`);
}

async function saveCategories() {
  const mappings = [];
  const { suggestions, unknowns } = state.pendingItems;
  const resolveCustom = async merchant => promptDialog({ title: 'Custom category', message: `For "${merchant}"`, label: 'Category name' });

  for (const [i, s] of suggestions.entries()) {
    const row = document.getElementById(`suggest-row-${i}`);
    const editSel = document.getElementById(`suggest-cat-${i}`);
    let category = row?.dataset.status === 'editing' && editSel ? editSel.value : s.category;
    if (category === '__custom__') category = await resolveCustom(s.merchant);
    if (category) mappings.push({ merchant: s.merchant, category });
  }
  for (const [i, m] of unknowns.entries()) {
    let cat = document.getElementById(`modal-cat-${i}`)?.value;
    if (cat === '__custom__') cat = await resolveCustom(m);
    if (cat) mappings.push({ merchant: m, category: cat });
  }
  if (!mappings.length) { closeModal(); return; }
  try {
    await api('POST', '/api/merchants/bulk', { mappings });
    clearAllCaches();
    await loadAll();
    closeModal();
    showToast(`${plural(mappings.length, 'merchant')} categorized`, 'success');
    rerenderCurrentView();
  } catch (err) {
    showToast('Could not save: ' + err.message, 'error');
  }
}
