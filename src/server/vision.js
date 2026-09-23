'use strict';
// Reads statements, app screenshots and receipts with Claude's vision:
// a PDF or image goes in, transaction rows (or a receipt's line items) come out.

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;

function extractionTool(categoryNames) {
  return {
    name: 'record_extraction',
    description: 'Record everything you can read from the document.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['statement', 'receipt', 'none'], description: '"statement" for a list of transactions (bank/card statement, app screenshot), "receipt" for one purchase with line items, "none" if there is nothing financial here' },
        currency: { type: 'string', description: 'ISO 4217 code the amounts are in (USD, ILS, THB…). Use the per-row field when it varies.' },
        card: { type: 'string', description: 'Card name or last four digits if shown; empty otherwise' },
        rows: {
          type: 'array',
          description: 'Every transaction on a statement, in order. Leave empty for a receipt.',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD. Use the transaction date, not the posting date, when both appear. Infer the year from the statement period if the rows only show day and month.' },
              description: { type: 'string', description: 'The merchant text exactly as printed' },
              amount: { type: 'number', description: 'Positive for purchases and charges, negative for refunds and credits' },
              currency: { type: 'string', description: 'ISO code for this row when it differs from the document currency' },
              originalAmount: { type: 'number', description: 'When the statement also shows the amount in the currency it was paid in (e.g. a ₪ or ฿ figure next to the dollar amount), that figure' },
              originalCurrency: { type: 'string', description: 'ISO code of originalAmount' },
              isPayment: { type: 'boolean', description: 'True for payments to the card, transfers, interest and fees — anything that is not a purchase' },
            },
            required: ['date', 'description', 'amount'],
          },
        },
        receipt: {
          type: 'object',
          description: 'For a receipt: the purchase and its line items',
          properties: {
            merchant: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD' },
            total: { type: 'number', description: 'The amount actually paid' },
            currency: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  amount: { type: 'number' },
                  category: { type: 'string', enum: categoryNames, description: 'Best spending category for this item' },
                },
                required: ['label', 'amount', 'category'],
              },
            },
          },
          required: ['merchant', 'total', 'items'],
        },
        notes: { type: 'string', description: 'Anything the user should know: unreadable rows, a cut-off page, an assumed year' },
      },
      required: ['kind', 'currency'],
    },
  };
}

const SYSTEM = `You read financial documents for a personal spending tracker: bank and credit-card statements (PDF or screenshots of a banking app, in any language including Hebrew and Thai) and shop receipts.
Read every row carefully; amounts must be exact. Dates are YYYY-MM-DD. Do not include running balances, totals, headers or footers as rows. Mark card payments, transfers, interest and fees with isPayment instead of leaving them out, so the user can see they were recognized.
If the document is a receipt, group the line items into a handful of sensible spending categories rather than listing every tiny item separately when there are many — but never change the amounts, and make the item amounts add up to the total (put tax and tip into the largest item).`;

// Which files this can read, and what to send
function describeFile(filename, size) {
  const ext = require('path').extname(filename || '').toLowerCase();
  if (ext === '.pdf') return size <= MAX_PDF_BYTES ? { media: 'application/pdf', block: 'document' } : null;
  if (IMAGE_TYPES[ext]) return size <= MAX_IMAGE_BYTES ? { media: IMAGE_TYPES[ext], block: 'image' } : null;
  return null;
}

function createVision({ claude, store }) {
  async function extract({ buffer, filename, hint = {} }) {
    const file = describeFile(filename, buffer.length);
    if (!file) throw Object.assign(new Error('That file is too large or not a PDF or image'), { status: 400 });
    const { getCategories } = require('./categoryConfig');
    const categoryNames = getCategories(store).filter(c => !c.hidden && !c.redirect && c.name !== 'Unknown').map(c => c.name);
    const model = claude.model('vision');
    const hints = [];
    if (hint.currency && hint.currency !== 'USD') hints.push(`The user says the amounts are in ${hint.currency}.`);
    if (hint.card) hints.push(`The card is called "${hint.card}".`);
    const content = [
      { type: file.block, source: { type: 'base64', media_type: file.media, data: buffer.toString('base64') } },
      { type: 'text', text: `Extract the transactions or the receipt from this document.${hints.length ? ' ' + hints.join(' ') : ''}` },
    ];
    // Long statements mean long outputs: stream and wait for the whole message
    const stream = claude.client().messages.stream({
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [extractionTool(categoryNames)],
      tool_choice: { type: 'tool', name: 'record_extraction' },
      messages: [{ role: 'user', content }],
    });
    const msg = await stream.finalMessage();
    claude.record('vision-import', model, msg.usage);
    const out = claude.toolInput(msg, 'record_extraction');
    if (!out) throw new Error('Could not read anything from that file');
    return normalize(out);
  }

  function normalize(out) {
    const cur = s => (typeof s === 'string' && /^[A-Za-z]{3}$/.test(s.trim()) ? s.trim().toUpperCase() : null);
    const docCurrency = cur(out.currency) || 'USD';
    const rows = (out.rows || []).map(r => ({
      date: String(r.date || '').slice(0, 10),
      description: String(r.description || '').trim(),
      amount: Number(r.amount),
      currency: cur(r.currency) || docCurrency,
      originalAmount: Number.isFinite(Number(r.originalAmount)) && cur(r.originalCurrency) ? Number(r.originalAmount) : null,
      originalCurrency: Number.isFinite(Number(r.originalAmount)) ? cur(r.originalCurrency) : null,
      isPayment: Boolean(r.isPayment),
    })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.description && Number.isFinite(r.amount) && r.amount !== 0);
    const receipt = out.receipt && out.kind === 'receipt' ? {
      merchant: String(out.receipt.merchant || '').trim() || 'Receipt',
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(out.receipt.date || '')) ? out.receipt.date : new Date().toISOString().slice(0, 10),
      total: Number(out.receipt.total) || 0,
      currency: cur(out.receipt.currency) || docCurrency,
      items: (out.receipt.items || []).map(i => ({ label: String(i.label || '').trim(), amount: Number(i.amount) || 0, category: i.category || null })).filter(i => i.label && i.amount),
    } : null;
    return { kind: out.kind === 'receipt' && receipt ? 'receipt' : rows.length ? 'statement' : 'none', currency: docCurrency, card: String(out.card || '').trim(), rows, receipt, notes: String(out.notes || '').trim() };
  }

  return { extract, describeFile, normalize };
}

module.exports = { createVision, IMAGE_TYPES };
