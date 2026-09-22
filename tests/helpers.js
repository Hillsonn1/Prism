'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/server/storage');

// A throwaway data directory with a fresh Store
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  return { dir, store: new Store(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { tempStore };
