'use strict';
// Statement upload (two steps: receive the file, then stream progress while it
// is parsed and categorized) and the clean-up tools in Settings.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { parseCSV, parsePDF } = require('../parsers/statements');
const { importRows, categorizeUncategorized } = require('../importer');
const { quickNormalizeName } = require('../normalize');
const { isPayment } = require('../categories');
const { mergeProposals } = require('../dedupe');
const ai = require('../ai');
const { str, route } = require('../validate');

const UPLOAD_TTL_MS = 10 * 60 * 1000;

function sse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return (progress, message, extra = {}) => res.write(`data: ${JSON.stringify({ progress, message, ...extra })}\n\n`);
}

// Drops merchant-memory entries no transaction uses any more
function pruneMerchants(store) {
  const active = new Set(store.read('transactions').map(t => t.merchant));
  store.update('merchants', m => { for (const name of Object.keys(m)) if (!active.has(name)) delete m[name]; });
}

// Applies a rename map to transactions and carries categories across in memory
function applyRenames(store, renames) {
  let changed = 0;
  store.update('transactions', list => {
    for (const t of list) {
      const next = renames.get(t.merchant);
      if (next && next !== t.merchant) { t.merchant = next; changed++; }
    }
  });
  store.update('merchants', m => {
    for (const [oldName, newName] of renames) {
      if (m[oldName] !== undefined && !m[newName]) m[newName] = m[oldName];
      delete m[oldName];
    }
  });
  pruneMerchants(store);
  return changed;
}

// Statement rows in shekels become dollar rows that remember the shekel amount
async function convertRows(rows, fx) {
  const out = [];
  for (const r of rows) {
    const conv = await fx.toUSD(r.amount, r.date);
    out.push({ ...r, ...conv });
  }
  return out;
}

module.exports = function importRoutes({ store, uploadsDir, apiKey, fx }) {
  const router = express.Router();
  const upload = multer({ dest: uploadsDir, limits: { fileSize: 25 * 1024 * 1024 } });
  const pendingUploads = new Map(); // uploadId → { filePath, originalName, cardName, statementName }
  const discard = file => { try { fs.unlinkSync(file); } catch {} };

  // Step 1: receive the file and hand back an id for the progress stream
  router.post('/upload/start', upload.single('file'), route((req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.csv' && ext !== '.pdf') {
      discard(req.file.path);
      return res.status(400).json({ error: 'Only CSV and PDF files are supported.' });
    }
    const uploadId = crypto.randomUUID();
    pendingUploads.set(uploadId, {
      filePath: req.file.path,
      originalName: req.file.originalname,
      cardName: str(req.body.cardName, { max: 60 }) || '',
      statementName: str(req.body.statementName, { max: 120 }) || '',
      currency: req.body.currency === 'ILS' ? 'ILS' : 'USD',
    });
    setTimeout(() => {
      const u = pendingUploads.get(uploadId);
      if (u) { discard(u.filePath); pendingUploads.delete(uploadId); }
    }, UPLOAD_TTL_MS).unref();
    res.json({ uploadId });
  }));

  // Step 2: parse, deduplicate, categorize and save, streaming progress
  router.get('/upload/stream/:id', async (req, res) => {
    const pending = pendingUploads.get(req.params.id);
    if (!pending) return res.status(404).json({ error: 'Upload not found or expired.' });
    pendingUploads.delete(req.params.id);
    const send = sse(res);
    const { filePath, originalName, cardName, statementName, currency } = pending;
    try {
      send(10, 'Parsing file…');
      const ext = path.extname(originalName).toLowerCase();
      let rows = ext === '.csv'
        ? parseCSV(fs.readFileSync(filePath, 'utf8'))
        : await parsePDF(fs.readFileSync(filePath));
      discard(filePath);
      if (!rows.length) {
        send(0, 'No transactions found in this file. The format may not be supported.', { error: true });
        return res.end();
      }
      if (currency === 'ILS') {
        send(20, 'Converting shekels to dollars…');
        rows = await convertRows(rows, fx);
      }
      send(30, 'Processing transactions…');
      const result = await importRows(store, rows, { source: statementName || originalName, card: cardName }, {
        apiKey: apiKey(),
        onProgress: (frac, msg) => send(Math.round(40 + frac * 48), msg),
      });
      send(92, 'Saving…');
      send(100, 'Done!', { done: true, result });
    } catch (err) {
      discard(filePath);
      send(0, err.message, { error: true });
    }
    res.end();
  });

  // ---- Clean-up tools ----
  router.post('/cleanup/payments', (_req, res) => {
    let removed = 0;
    store.update('transactions', list => {
      const next = list.filter(t => !isPayment(t.merchant) && !isPayment(t.rawSource || ''));
      removed = list.length - next.length;
      return next;
    });
    res.json({ removed });
  });

  router.post('/cleanup/normalize', (_req, res) => {
    const renames = new Map();
    for (const t of store.read('transactions')) {
      const normalized = quickNormalizeName(t.merchant);
      if (normalized !== t.merchant) renames.set(t.merchant, normalized);
    }
    const updated = applyRenames(store, renames);
    res.json({ updated });
  });

  // Smart Clean: propose merges locally, apply only what the user kept
  router.post('/cleanup/dedupe/preview', (_req, res) => {
    res.json({ proposals: mergeProposals(store.read('transactions'), store.read('merchants')) });
  });

  router.post('/cleanup/dedupe/apply', route((req, res) => {
    const mapping = req.body.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return res.status(400).json({ error: 'mapping object required' });
    const renames = new Map();
    for (const [from, to] of Object.entries(mapping)) {
      const f = str(from, { max: 120 }), t = str(to, { max: 120 });
      if (f && t && f !== t) renames.set(f, t);
    }
    const merged = applyRenames(store, renames);
    res.json({ merged, renamed: renames.size });
  }));

  router.post('/cleanup/ai-deduplicate', route(async (_req, res) => {
    const key = apiKey();
    if (!key) return res.status(400).json({ error: 'No API key configured — add one in Settings.' });
    const uniqueNames = [...new Set(store.read('transactions').map(t => t.merchant))].sort();
    if (!uniqueNames.length) return res.json({ merged: 0, mapping: {} });
    const mapping = await ai.dedupeMerchants(uniqueNames, key);
    const merged = applyRenames(store, new Map(Object.entries(mapping)));
    res.json({ merged, mapping });
  }));

  // Works without a key (rules and memory only); with one, Claude handles the rest
  router.get('/cleanup/categorize/stream', async (_req, res) => {
    const send = sse(res);
    try {
      send(10, 'Applying categorization rules…');
      const result = await categorizeUncategorized(store, {
        apiKey: apiKey(),
        onProgress: (frac, msg) => send(Math.round(30 + frac * 60), msg),
      });
      send(95, 'Saving…');
      send(100, 'Complete!', { done: true, result });
    } catch (err) {
      send(0, `Error: ${err.message}`, { error: true });
    }
    res.end();
  });

  return router;
};
