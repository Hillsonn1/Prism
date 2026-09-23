#!/usr/bin/env node
'use strict';
// Runs Prism as a plain local web app: data in ./data, UI on localhost:3000
// (PORT overrides). The desktop app starts the same server from electron/main.js.
// With PRISM_HOSTED=1 and PRISM_SECRET set it becomes the multi-user website
// version: accounts, a data folder per user, listening on every interface.

const path = require('path');
const { start, logCrashes } = require('./src/server');

const dataDir = process.env.PRISM_DATA_DIR || path.join(__dirname, 'data');
logCrashes(dataDir);

start({
  dataDir,
  uploadsDir: path.join(__dirname, 'uploads'),
  port: Number(process.env.PORT) || 3000,
}).then(({ url, hosted }) => {
  console.log(`\nPrism is running at ${url}${hosted ? ' (hosted mode: accounts on)' : ''}\nPress Ctrl+C to quit.\n`);
}).catch(err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${process.env.PORT || 3000} is already in use. Close the other Prism window, or run with PORT=<number>.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
