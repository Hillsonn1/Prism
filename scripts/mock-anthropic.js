// A stand-in for the Messages API so the Claude features can be exercised
// without a key: streaming with a tool call then an answer, and the forced
// tool calls the extraction, review and merchant-intelligence jobs make.
//
//   node scripts/mock-anthropic.js
//   PRISM_ANTHROPIC_HOST=http://localhost:3998 npm start   (save any key in Settings)
'use strict';
const http = require('http');

const usage = { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// Streams one assistant message as Messages API server-sent events
function streamMessage(res, model, blocks, stopReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const piece of b.text.match(/.{1,12}/g) || []) ev('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 } });
  ev('message_stop', {});
  res.end();
}

function plainMessage(res, model, blocks, stopReason) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage }));
}

// Merchant strings out of a prompt like: - "Name" (…)
const quoted = text => [...String(text).matchAll(/^- "([^"]+)"/gm)].map(m => m[1]);
const lastUserText = body => {
  const last = [...body.messages].reverse().find(m => m.role === 'user');
  return typeof last.content === 'string' ? last.content : last.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
};

function handle(body, res) {
  const model = body.model;
  const forced = body.tool_choice?.type === 'tool' ? body.tool_choice.name : body.tool_choice?.type === 'any' ? body.tools.find(t => t.name !== 'web_search')?.name : null;
  const text = lastUserText(body);

  if (forced === 'record_merchants') {
    const searched = body.tools.some(t => t.name === 'web_search'); // the lookup pass is sure where the knowledge pass wasn't
    const merchants = quoted(text).map(m => ({ merchant: m, displayName: m, nativeName: /pri/i.test(m) ? 'שבח פרי וירק' : '', meaning: /pri/i.test(m) ? 'Fruit & Vegetables' : '', type: /pri/i.test(m) ? 'greengrocer' : 'shop', category: /pri|super/i.test(m) ? 'Groceries' : 'Shopping', isSubscription: /netflix/i.test(m), country: 'IL', description: `${m} is a shop.`, confidence: /mystery/i.test(m) && !searched ? 0.3 : 0.9 }));
    return plainMessage(res, model, [{ type: 'tool_use', id: 'toolu_m', name: 'record_merchants', input: { merchants } }], 'tool_use');
  }
  if (forced === 'report_review') {
    const merchants = quoted(text);
    const verdicts = merchants.map((m, i) => (i === 0 ? { merchant: m, verdict: 'change', category: 'Personal Care', reason: `${m} is a pharmacy chain.`, confidence: 0.85 } : { merchant: m, verdict: 'keep', confidence: 0.9 }));
    return plainMessage(res, model, [{ type: 'tool_use', id: 'toolu_r', name: 'report_review', input: { verdicts } }], 'tool_use');
  }
  if (forced === 'record_extraction') {
    const hasImage = body.messages[0].content.some(b => b.type === 'image');
    const input = hasImage
      ? { kind: 'receipt', currency: 'ILS', receipt: { merchant: 'Supersal', date: '2026-09-20', total: 150, currency: 'ILS', items: [{ label: 'Milk', amount: 30, category: 'Groceries' }, { label: 'Detergent', amount: 120, category: 'Home & Garden' }] } }
      : { kind: 'statement', currency: 'USD', card: '7333', rows: [{ date: '2026-09-18', description: 'GETT', amount: 18.51 }, { date: '2026-09-17', description: 'PAYMENT THANK YOU', amount: -200, isPayment: true }, { date: '2026-09-16', description: 'KOLBO', amount: 4.94 }], notes: 'Year assumed from the statement period.' };
    const blocks = [{ type: 'tool_use', id: 'toolu_x', name: 'record_extraction', input }];
    return body.stream ? streamMessage(res, model, blocks, 'tool_use') : plainMessage(res, model, blocks, 'tool_use');
  }
  // The assistant: first turn calls a tool, the next answers with the total it got back
  const toolResult = [...body.messages].reverse().find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
  if (!toolResult) {
    return streamMessage(res, model, [{ type: 'tool_use', id: 'toolu_1', name: 'summarize_spending', input: { groupBy: 'category', from: '2026-09-01', to: '2026-09-30' } }], 'tool_use');
  }
  const resultText = toolResult.content.find(b => b.type === 'tool_result').content;
  const total = (() => { try { return JSON.parse(typeof resultText === 'string' ? resultText : resultText[0].text).total; } catch { return '?'; } })();
  if (/tag/i.test(text) || body.messages.some(m => typeof m.content === 'string' && /tag it/i.test(m.content))) {
    const proposed = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.name === 'propose_changes'));
    if (!proposed) return streamMessage(res, model, [{ type: 'tool_use', id: 'toolu_2', name: 'propose_changes', input: { selection: { from: '2026-09-01', to: '2026-09-30' }, set: { addTags: ['September'] }, summary: 'Tag September purchases' } }], 'tool_use');
  }
  return streamMessage(res, model, [{ type: 'text', text: `You spent **$${total}** this month.` }], 'end_turn');
}

function createMockAnthropic() {
  return http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end('{}'); }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { handle(JSON.parse(raw), res); }
      catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } })); }
    });
  });
}

module.exports = { createMockAnthropic };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3998;
  createMockAnthropic().listen(port, () => console.log(`Mock Anthropic API on http://localhost:${port}`));
}
