'use strict';
// End-to-end over the Claude features against a mock Messages API: the
// streaming assistant with a tool call and a proposal, merchant intelligence,
// the category review, "explain", and vision imports of a statement and a receipt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/server');
const { createMockAnthropic } = require('../scripts/mock-anthropic');

async function boot() {
  const mock = createMockAnthropic();
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  process.env.PRISM_ANTHROPIC_HOST = `http://127.0.0.1:${mock.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-ai-'));
  const srv = await start({ dataDir: path.join(dir, 'data'), uploadsDir: path.join(dir, 'uploads'), port: 0, log: { error() {} } });
  const api = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const sse = async (method, p, body) => {
    const res = await fetch(srv.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return text.split('\n\n').filter(Boolean).map(chunk => JSON.parse(chunk.split('\n').find(l => l.startsWith('data: ')).slice(6)));
  };
  await api('POST', '/api/settings', { anthropicApiKey: 'sk-test-key' });
  return { api, sse, srv, close: async () => { await srv.close(); mock.close(); delete process.env.PRISM_ANTHROPIC_HOST; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('ask: streams text, runs a tool, hands back a proposal that applies on request', async () => {
  const { api, sse, close } = await boot();
  try {
    await api('POST', '/api/transactions', { date: '2026-09-10', merchant: 'Supersal', amount: 84.5, category: 'Groceries' });
    await api('POST', '/api/transactions', { date: '2026-09-12', merchant: 'Wolt', amount: 22, category: 'Dining & Restaurants' });
    const events = await sse('POST', '/api/ask', { question: 'How much this month?' });
    const types = events.map(e => e.type);
    assert.ok(types.includes('start') && types.includes('tool') && types.includes('done'), types.join(','));
    assert.equal(events.find(e => e.type === 'tool').name, 'summarize_spending');
    const done = events.find(e => e.type === 'done');
    assert.equal(done.text, 'You spent **$106.5** this month.');
    assert.equal(events.filter(e => e.type === 'text').map(e => e.delta).join(''), done.text);
    const conversationId = done.conversationId;

    const second = await sse('POST', '/api/ask', { conversationId, question: 'tag it all as September' });
    const proposal = second.find(e => e.type === 'proposal')?.proposal;
    assert.ok(proposal, 'a proposal came back');
    assert.equal(proposal.affected, 2);
    assert.equal((await api('GET', '/api/transactions')).data[0].tags, undefined, 'nothing applied yet');
    const applied = (await api('POST', '/api/ask/apply', { proposalId: proposal.id })).data;
    assert.equal(applied.affected, 2);
    assert.ok((await api('GET', '/api/transactions')).data.every(t => t.tags?.includes('September')));
    const status = (await api('GET', '/api/ai/status')).data;
    assert.ok(status.available && status.usage.calls >= 2);
  } finally { await close(); }
});

test('merchant intelligence learns merchants, explains a charge, and the review proposes changes', async () => {
  const { api, sse, close } = await boot();
  try {
    await api('POST', '/api/transactions', { date: '2026-09-10', merchant: 'Shevach Pri Vayerek', amount: 30 });
    await api('POST', '/api/transactions', { date: '2026-09-11', merchant: 'Mystery Place', amount: 12 });
    const { data: gett } = await api('POST', '/api/transactions', { date: '2026-09-12', merchant: 'Super-Pharm', amount: 40, category: 'Groceries' });
    await api('PUT', `/api/transactions/${gett.id}`, { category: 'Groceries' }); // set by hand
    const run = await sse('GET', '/api/merchants/intel/run');
    const result = run.find(e => e.done).result;
    assert.equal(result.enriched, 3);
    assert.equal(result.lookedUp, 1, 'the uncertain one was looked up');
    assert.equal(result.categorized, 2, 'confident answers categorized the uncategorized rows');
    const info = (await api('GET', '/api/merchants/intel')).data;
    assert.equal(info['Shevach Pri Vayerek'].nativeName, 'שבח פרי וירק');
    assert.equal(info['Mystery Place'].source, 'web');
    const txns = (await api('GET', '/api/transactions')).data;
    assert.equal(txns.find(t => t.merchant === 'Shevach Pri Vayerek').category, 'Groceries');

    const explained = (await api('POST', `/api/explain/${txns[0].id}`, {})).data;
    assert.equal(explained.info.type, 'greengrocer');
    assert.equal(explained.stats.count, 1);

    const review = await sse('GET', '/api/cleanup/review/run');
    const r = review.find(e => e.done).result;
    assert.ok(r.reviewed >= 2);
    assert.ok(!r.proposals.some(p => p.merchant === 'Super-Pharm'), 'hand-set merchants are not reviewed');
    assert.equal(r.proposals[0].to, 'Personal Care');
    assert.match(r.proposals[0].reason, /pharmacy/);
    const applied = (await api('POST', '/api/cleanup/review/apply', { changes: r.proposals.map(p => ({ merchant: p.merchant, category: p.to })) })).data;
    assert.equal(applied.merchants, 1);
  } finally { await close(); }
});

test('vision: a PDF becomes rows (payments skipped) and an image becomes a receipt to confirm', async () => {
  const { srv, sse, close } = await boot();
  try {
    const upload = async (name, type, bytes) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), name);
      form.append('cardName', 'Visa');
      const res = await fetch(srv.url + '/api/upload/start', { method: 'POST', body: form });
      return (await res.json()).uploadId;
    };
    const pdfId = await upload('statement.pdf', 'application/pdf', Buffer.from('%PDF-1.4 mock'));
    const events = await sse('GET', `/api/upload/stream/${pdfId}`);
    const done = events.find(e => e.done);
    assert.equal(done.result.imported, 2, 'two purchases; the payment is skipped');
    assert.equal(done.result.readBy, 'claude');
    assert.ok(events.some(e => /Year assumed/.test(e.message)));

    const pngId = await upload('receipt.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const rEvents = await sse('GET', `/api/upload/stream/${pngId}`);
    const receipt = rEvents.find(e => e.done).result.receipt;
    assert.equal(receipt.merchant, 'Supersal');
    assert.equal(receipt.items.length, 2);
    assert.equal(receipt.currency, 'ILS');
  } finally { await close(); }
});
