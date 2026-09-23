// Ask Prism: a conversation over your data, in a side panel. Answers stream
// in; anything that would change data arrives as a proposal with an Apply button.

const ask = { open: false, conversationId: null, messages: [], busy: false, available: null, model: '' };

const ASK_SUGGESTIONS = [
  'What did I spend this month, and on what?',
  "What's due on my cards and when?",
  'Biggest purchases in the last 30 days',
  'How does this month compare to last month?',
  'Which subscriptions am I paying for?',
];

// A small, safe markdown: paragraphs, bullet and numbered lists, **bold**, `code`
function renderMarkdown(text) {
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const blocks = String(text || '').trim().split(/\n{2,}/);
  return raw(blocks.map(block => {
    const lines = block.split('\n');
    if (lines.every(l => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\s*\d+[.)]/.test(lines[0]);
      return `<${ordered ? 'ol' : 'ul'}>${lines.map(l => `<li>${inline(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
    }
    return `<p>${lines.map(l => inline(l.replace(/^#+\s*/, ''))).join('<br>')}</p>`;
  }).join(''));
}

async function loadAskStatus() {
  try {
    const s = await api('GET', '/api/ai/status');
    ask.available = s.available;
    ask.model = s.model;
  } catch { ask.available = false; }
}

function toggleAsk(open = !ask.open) {
  ask.open = open;
  const panel = document.getElementById('ask-panel');
  panel.classList.toggle('ask-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  document.getElementById('ask-fab')?.classList.toggle('ask-fab-hidden', open);
  if (open) {
    if (ask.available === null) loadAskStatus().then(renderAsk); else renderAsk();
    requestAnimationFrame(() => document.getElementById('ask-input')?.focus());
  }
}

function resetAsk() {
  if (ask.conversationId) api('POST', '/api/ask/reset', { conversationId: ask.conversationId }).catch(() => {});
  ask.conversationId = null;
  ask.messages = [];
  renderAsk();
  document.getElementById('ask-input')?.focus();
}

const TOOL_LABELS = { get_overview: 'Looked at the big picture', search_transactions: 'Searched transactions', summarize_spending: 'Summarized spending', merchant_details: 'Looked up a merchant', propose_changes: 'Drafted a change', propose_merchant_category: 'Drafted a category', propose_trip: 'Drafted a trip' };

function renderAsk() {
  const list = document.getElementById('ask-messages');
  const suggest = document.getElementById('ask-suggest');
  const foot = document.getElementById('ask-foot');
  if (!list) return;
  if (ask.available === false) {
    list.innerHTML = html`<div class="ask-empty"><p>Ask Prism needs an Anthropic API key.</p><button class="btn btn-secondary btn-sm" onclick="toggleAsk(false);goToSection('settings','ai-card')">Add a key in Settings</button></div>`;
    suggest.innerHTML = '';
    foot.textContent = '';
    return;
  }
  if (!ask.messages.length) {
    list.innerHTML = html`<div class="ask-empty"><p>Ask anything about your spending. Only what's needed to answer leaves your Mac.</p></div>`;
    suggest.innerHTML = html`${ASK_SUGGESTIONS.map(q => html`<button class="chip" onclick="askQuestion('${escAttr(q)}')">${q}</button>`)}`;
  } else {
    suggest.innerHTML = '';
    list.innerHTML = html`${ask.messages.map((m, i) => m.role === 'user'
      ? html`<div class="ask-msg ask-user">${m.text}</div>`
      : html`<div class="ask-msg ask-assistant" id="ask-msg-${i}">
          ${m.tools.length ? html`<div class="ask-tools">${m.tools.map(t => html`<span class="ask-tool">${TOOL_LABELS[t] || t}</span>`)}</div>` : ''}
          <div class="ask-text">${m.text ? renderMarkdown(m.text) : (m.done ? '' : html`<span class="ask-thinking"><span></span><span></span><span></span></span>`)}</div>
          ${m.proposals.map(p => renderProposal(p))}
          ${m.error ? html`<div class="ask-error">${m.error}</div>` : ''}
        </div>`)}`;
    list.scrollTop = list.scrollHeight;
  }
  const last = [...ask.messages].reverse().find(m => m.role === 'assistant' && m.done);
  foot.textContent = `${ask.model.includes('opus') ? 'Opus 5' : ask.model.includes('sonnet') ? 'Sonnet 5' : ask.model}${last?.usd !== undefined ? ` · about $${last.usd < 0.01 ? '0.01' : last.usd.toFixed(2)} for that answer` : ''}`;
}

function renderProposal(p) {
  return html`
    <div class="ask-proposal ${p.applied ? 'ask-proposal-applied' : ''}" id="proposal-${p.id}">
      <div class="ask-proposal-head">
        <span class="ask-proposal-summary">${p.summary}</span>
        <span class="muted">${plural(p.affected, p.kind === 'trip' ? 'purchase in range' : 'transaction', p.kind === 'trip' ? 'purchases in range' : 'transactions')}</span>
      </div>
      ${p.preview?.length ? html`<div class="ask-proposal-preview">${p.preview.map(r => html`<div class="ask-preview-row"><span>${fmtDate(r.date)}</span><span class="ask-preview-merchant">${r.merchant}</span><span class="amount amount-sm">${fmt(r.amount)}</span></div>`)}${p.affected > p.preview.length ? html`<div class="muted ask-preview-more">…and ${p.affected - p.preview.length} more</div>` : ''}</div>` : ''}
      <div class="ask-proposal-actions">
        ${p.applied ? html`<span class="txn-pill txn-pill-good">${icon('check')} applied</span>` : html`
          <button class="btn btn-primary btn-sm" onclick="applyProposal('${p.id}')">Apply</button>
          <button class="btn btn-ghost btn-sm" onclick="dismissProposal('${p.id}')">Dismiss</button>`}
      </div>
    </div>`;
}

function askQuestion(q) {
  const input = document.getElementById('ask-input');
  if (input) input.value = q;
  submitAsk();
}

function submitAsk(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('ask-input');
  const question = input.value.trim();
  if (!question || ask.busy) return;
  input.value = '';
  input.style.height = '';
  sendAsk(question);
}

async function sendAsk(question) {
  ask.busy = true;
  ask.messages.push({ role: 'user', text: question });
  const reply = { role: 'assistant', text: '', tools: [], proposals: [], done: false };
  ask.messages.push(reply);
  renderAsk();
  const idx = ask.messages.length - 1;
  const paint = () => {
    const el = document.getElementById(`ask-msg-${idx}`);
    if (!el) { renderAsk(); return; }
    const textEl = el.querySelector('.ask-text');
    if (textEl && reply.text) textEl.innerHTML = renderMarkdown(reply.text);
    const list = document.getElementById('ask-messages');
    list.scrollTop = list.scrollHeight;
  };
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: ask.conversationId, question }) });
    if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'Request failed'); }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'start') ask.conversationId = ev.conversationId;
        else if (ev.type === 'text') { reply.text += ev.delta; paint(); }
        else if (ev.type === 'tool') { if (!reply.tools.includes(ev.name)) reply.tools.push(ev.name); renderAsk(); }
        else if (ev.type === 'proposal') { reply.proposals.push(ev.proposal); renderAsk(); }
        else if (ev.type === 'done') { reply.text = ev.text || reply.text; reply.usd = ev.usd; reply.done = true; }
        else if (ev.type === 'error') { reply.error = ev.message; reply.done = true; }
      }
    }
  } catch (err) {
    reply.error = err.message;
  }
  reply.done = true;
  ask.busy = false;
  renderAsk();
}

async function applyProposal(id) {
  try {
    const r = await api('POST', '/api/ask/apply', { proposalId: id });
    for (const m of ask.messages) for (const p of m.proposals || []) if (p.id === id) { p.applied = true; p.affected = r.affected; }
    clearAllCaches();
    await loadAll();
    rerenderCurrentView();
    renderAsk();
    showToast(`Applied to ${plural(r.affected, 'transaction')}`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

function dismissProposal(id) {
  for (const m of ask.messages) if (m.proposals) m.proposals = m.proposals.filter(p => p.id !== id);
  renderAsk();
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); toggleAsk(); }
  if (e.key === 'Escape' && ask.open && document.activeElement?.id === 'ask-input') toggleAsk(false);
});
document.getElementById('ask-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAsk(); }
});
document.getElementById('ask-input')?.addEventListener('input', e => {
  e.target.style.height = '';
  e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
});
