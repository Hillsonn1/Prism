'use strict';
// Assembles the Prism server. Both entry points use it: server.js for a plain
// web app on localhost, electron/main.js for the desktop app.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Store } = require('./storage');
const { createPlaid } = require('./plaid');
const { createFx } = require('./fx');
const { createSecrets } = require('./secrets');
const { toTitleCase } = require('./normalize');
const { inferCategorySources } = require('./importer');
const { createClaude } = require('./claude');
const { createAssistant } = require('./assistant');
const { createMerchantIntel } = require('./merchantInfo');
const { createHygiene } = require('./hygiene');
const { createVision } = require('./vision');
const { als, contextualStore, contextualObject, createRegistry } = require('./tenancy');
const { createUsers } = require('./users');

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

// hosted: accounts and a data folder per user (the website); otherwise the
// single local store the desktop app and `npm start` use.
function createApp({ dataDir, uploadsDir, openExternal = null, openFolder = null, safeStorage = null, log = console,
  hosted = process.env.PRISM_HOSTED === '1', secret = process.env.PRISM_SECRET || null, secureCookies = process.env.PRISM_SECURE_COOKIES === '1' || process.env.NODE_ENV === 'production' }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  const secrets = createSecrets(safeStorage, { softwareKey: hosted ? secret : null });
  const prepare = s => { migrate(s); inferCategorySources(s); secrets.migrate(s); };

  let store, plaidState, intelState, users = null, registry = null;
  if (hosted) {
    users = createUsers({ dataDir, secret });
    registry = createRegistry({ dataDir, prepare });
    store = contextualStore(null);
    plaidState = contextualObject('plaidState', {});
    intelState = contextualObject('intelState', {});
  } else {
    store = new Store(dataDir);
    prepare(store);
    plaidState = null;
    intelState = null;
  }

  const apiKey = () => secrets.open(store.read('settings').anthropicApiKey) || null;
  const claude = createClaude({ store, apiKey, log });
  const intel = createMerchantIntel({ store, claude, log, state: intelState });
  const forEachUser = hosted ? async fn => {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8')).users || []; } catch {}
    for (const u of list) await registry.runAs(u.id, fn);
  } : null;
  const plaid = createPlaid({ store, openExternal: hosted ? null : openExternal, log, secrets, onChange: () => intel.inBackground(), state: plaidState, forEachUser });
  const fx = createFx({ store, log });
  const assistant = createAssistant({ store, claude, plaid, log });
  const hygiene = createHygiene({ store, claude, log });
  const vision = createVision({ claude, store });

  const app = express();
  app.disable('x-powered-by');
  if (hosted) app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  if (hosted) {
    // Who is asking, and whose data to use for the rest of the request
    app.use((req, res, next) => {
      req.user = users.verifySession(users.readCookie(req));
      if (!req.user) return next();
      als.run(registry.context(req.user.id), () => next());
    });
    app.use('/api', require('./routes/auth')({ users, secure: secureCookies }));
    // The app itself needs a session; assets and the sign-in page do not
    app.get(['/', '/index.html'], (req, res, next) => (req.user ? next() : res.redirect('/login')));
    app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.sendFile(path.join(PUBLIC_DIR, 'login.html'))));
    app.use('/api', (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in to continue', signedOut: true })));
  }
  app.use(express.static(PUBLIC_DIR));
  app.use('/api', require('./routes/transactions')({ store, plaid, fx }));
  app.use('/api', require('./routes/import')({ store, uploadsDir, apiKey, fx, vision, claude, intel }));
  app.use('/api', require('./routes/budget')({ store, apiKey }));
  app.use('/api', require('./routes/settings')({ store, version, apiKey, fx, dataDir: hosted ? null : dataDir, openFolder: hosted ? null : openFolder, secrets, hosted }));
  app.use('/api', require('./routes/categories')({ store }));
  app.use('/api', require('./routes/trips')({ store }));
  app.use('/api', require('./routes/ai')({ store, claude, assistant, intel, hygiene, fx }));
  app.use('/api/plaid', plaid.router);
  app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (!err.status || err.status >= 500) log.error(err);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
  });

  return { app, store, plaid, fx, users, registry, hosted };
}

// Listens on localhost only: this is personal financial data, and the app is
// the only client. port 0 lets the OS pick a free port (the desktop app does
// this so it can never collide with something else on the machine).
async function start({ port = 0, host = process.env.PRISM_HOSTED === '1' ? '0.0.0.0' : '127.0.0.1', ...options }) {
  const { app, store, plaid, fx, users, registry, hosted } = createApp(options);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
  plaid.startScheduler();
  const actualPort = server.address().port;
  return {
    app, store, plaid, fx, users, registry, hosted, server,
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
