'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecrets } = require('../src/server/secrets');
const { tempStore } = require('./helpers');

// Stands in for Electron's safeStorage
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`sealed(${s})`),
  decryptString: b => b.toString().replace(/^sealed\((.*)\)$/, '$1'),
};

test('seals and opens with safeStorage, passes through without it', () => {
  const on = createSecrets(fakeSafeStorage);
  const sealed = on.seal('access-sandbox-123');
  assert.ok(sealed.startsWith('enc:'));
  assert.equal(on.open(sealed), 'access-sandbox-123');
  assert.equal(on.seal(sealed), sealed, 'sealing twice is a no-op');
  assert.equal(on.open('plain'), 'plain');
  const off = createSecrets(null);
  assert.equal(off.seal('x'), 'x');
  assert.throws(() => off.open(sealed), /desktop app/);
});

test('migration seals plaintext secrets already on disk', () => {
  const { store, cleanup } = tempStore();
  try {
    store.write('settings', { anthropicApiKey: 'sk-ant-1', plaid: { clientId: 'c', secret: 's3cret', env: 'sandbox' } });
    store.write('plaid', { items: [{ itemId: 'i', accessToken: 'access-1', accounts: [] }] });
    const secrets = createSecrets(fakeSafeStorage);
    secrets.migrate(store);
    const settings = store.read('settings');
    assert.ok(settings.anthropicApiKey.startsWith('enc:'));
    assert.ok(settings.plaid.secret.startsWith('enc:'));
    assert.equal(settings.plaid.clientId, 'c', 'client id is not a secret');
    assert.equal(secrets.open(store.read('plaid').items[0].accessToken), 'access-1');
  } finally { cleanup(); }
});
