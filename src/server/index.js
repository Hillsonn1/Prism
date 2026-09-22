'use strict';
// Assembles the Prism server. Both entry points use it: server.js for a plain
// web app on localhost, electron/main.js for the desktop app.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Store } = require('./storage');
const { createPlaid } = require('./plaid');
const { createFx } = require('./fx');
const { toTitleCase } = require('./normalize');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const { version } = require('../../package.json');

// One-time data migrations, tracked in settings
function migrate(store) {
  const settings = store.read('settings');
  if (!settings.titleCaseMigrated) {
    store.update('transactions', list => { for (const t of list) if (t.merchant) t.merchant = toTitleCase(t.merchant); });
    store.update('merchants', m => {
      const updated = {};
      for (const [name, cat] of Object.entries(m)) updated[toTitleCase(name)] = cat;
      return updated;
    });
    store.update('settings', s => { s.titleCaseMigrated = true; });
  }
}

function createApp({ dataDir, uploadsDir, openExternal = null, log = console }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  const store = new Store(dataDir);
  migrate(store);

  const apiKey = () => store.read('settings').anthropicApiKey || null;
  const plaid = createPlaid({ store, openExternal, log });
  const fx = createFx({ store, log });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(PUBLIC_DIR));
  app.use('/api', require('./routes/transactions')({ store, plaid, fx }));
  app.use('/api', require('./routes/import')({ store, uploadsDir, apiKey, fx }));
  app.use('/api', require('./routes/budget')({ store, apiKey }));
  app.use('/api', require('./routes/settings')({ store, version, apiKey, fx }));
  app.use('/api/plaid', plaid.router);
  app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (!err.status || err.status >= 500) log.error(err);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
  });

  return { app, store, plaid, fx };
}

// Listens on localhost only: this is personal financial data, and the app is
// the only client. port 0 lets the OS pick a free port (the desktop app does
// this so it can never collide with something else on the machine).
async function start({ port = 0, host = '127.0.0.1', ...options }) {
  const { app, store, plaid, fx } = createApp(options);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  plaid.startScheduler();
  const actualPort = server.address().port;
  return {
    app, store, plaid, fx, server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise(resolve => { plaid.stop(); server.close(resolve); }),
  };
}

// Appends crash details to error.log in the data dir so failures are never invisible
function logCrashes(dataDir, log = console) {
  process.on('uncaughtException', err => {
    log.error('\n=== Prism crashed ===\n' + (err.stack || err.message));
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'error.log'), `[${new Date().toISOString()}]\n${err.stack}\n\n`);
    } catch {}
  });
}

module.exports = { createApp, start, logCrashes, version };
