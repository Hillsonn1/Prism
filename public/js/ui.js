// Toasts and in-app dialogs (no native prompt/confirm).

function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('removing');
    setTimeout(() => t.remove(), 220);
  }, 2600);
}

// One dialog element, reused. Resolves with the user's answer.
let _dialogResolve = null;
function _dialogEl() {
  let el = document.getElementById('app-dialog');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'app-dialog';
  el.className = 'modal-overlay';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="modal dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
      <div class="modal-header">
        <h2 id="app-dialog-title"></h2>
        <p class="modal-subtitle" id="app-dialog-message"></p>
      </div>
      <div class="modal-body" id="app-dialog-body"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="app-dialog-cancel" type="button"></button>
        <button class="btn btn-primary" id="app-dialog-ok" type="button"></button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) _closeDialog(null); });
  el.querySelector('#app-dialog-cancel').addEventListener('click', () => _closeDialog(null));
  el.querySelector('#app-dialog-ok').addEventListener('click', () => _closeDialog(_readDialog()));
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); _closeDialog(null); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); _closeDialog(_readDialog()); }
  });
  return el;
}
function _readDialog() {
  const input = document.getElementById('app-dialog-input') || document.getElementById('app-dialog-select');
  const check = document.getElementById('app-dialog-check');
  return { ok: true, value: input ? input.value.trim() : undefined, checked: check ? check.checked : undefined };
}
function _closeDialog(result) {
  const el = document.getElementById('app-dialog');
  if (!el || el.style.display === 'none') return;
  el.classList.add('closing');
  setTimeout(() => { el.style.display = 'none'; el.classList.remove('closing'); }, 160);
  const resolve = _dialogResolve;
  _dialogResolve = null;
  if (resolve) resolve(result);
}
function _openDialog({ title, message, body = '', okText, cancelText = 'Cancel', danger = false }) {
  const el = _dialogEl();
  el.querySelector('#app-dialog-title').textContent = title;
  el.querySelector('#app-dialog-message').textContent = message || '';
  el.querySelector('#app-dialog-message').style.display = message ? '' : 'none';
  el.querySelector('#app-dialog-body').innerHTML = body;
  el.querySelector('#app-dialog-body').style.display = body ? '' : 'none';
  const ok = el.querySelector('#app-dialog-ok');
  ok.textContent = okText;
  ok.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
  el.querySelector('#app-dialog-cancel').textContent = cancelText;
  el.style.display = 'flex';
  return new Promise(resolve => {
    _dialogResolve = resolve;
    requestAnimationFrame(() => (el.querySelector('#app-dialog-input') || ok).focus());
  });
}

// confirmDialog({ title, message, okText, danger, checkbox }) → { ok, checked } or null
async function confirmDialog({ title, message, okText = 'OK', cancelText = 'Cancel', danger = false, checkbox = null }) {
  const body = checkbox ? html`<label class="dialog-check"><input type="checkbox" id="app-dialog-check" ${checkbox.checked ? 'checked' : ''} /> <span>${checkbox.label}</span></label>` : '';
  const r = await _openDialog({ title, message, body, okText, cancelText, danger });
  return r ? { ok: true, checked: Boolean(r.checked) } : null;
}
async function confirmAction(title, message, okText = 'Delete') {
  return Boolean(await confirmDialog({ title, message, okText, danger: true }));
}

// promptDialog({ title, message, label, value, placeholder, okText }) → string or null
async function promptDialog({ title, message, label = '', value = '', placeholder = '', okText = 'Save' }) {
  const body = html`
    <div class="edit-field">
      ${label ? html`<label class="edit-label" for="app-dialog-input">${label}</label>` : ''}
      <input type="text" id="app-dialog-input" value="${value}" placeholder="${placeholder}" autocomplete="off" />
    </div>`;
  const r = await _openDialog({ title, message, body, okText });
  if (!r) return null;
  const el = document.getElementById('app-dialog-input');
  if (el) requestAnimationFrame(() => el.select && el.select());
  return r.value ?? null;
}

// selectDialog({ title, message, label, options: [{ value, label }], value, okText }) → value or null
async function selectDialog({ title, message, label = '', options = [], value = '', okText = 'OK', danger = false }) {
  const body = html`
    <div class="edit-field">
      ${label ? html`<label class="edit-label" for="app-dialog-select">${label}</label>` : ''}
      <select id="app-dialog-select">${options.map(o => html`<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}</option>`)}</select>
    </div>`;
  const r = await _openDialog({ title, message, body, okText, danger });
  return r ? (r.value ?? null) : null;
}

// Themes: 'system' | 'light' | 'dark'
function applyTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Remembered locally too, so the next launch paints the right theme before data loads
  try { localStorage.setItem('prism-theme', theme === 'dark' || theme === 'light' ? theme : 'system'); } catch {}
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme((typeof state !== 'undefined' && state.prefs.theme) || 'system'));
