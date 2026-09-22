'use strict';
// Secrets at rest. In the desktop app, Electron's safeStorage encrypts values
// with the OS keychain (macOS Keychain, Windows DPAPI); plain node keeps them
// as-is. Sealed values are stored as "enc:<base64>" so both forms coexist.

const PREFIX = 'enc:';

function createSecrets(safeStorage = null) {
  const available = Boolean(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());

  function seal(value) {
    if (!available || typeof value !== 'string' || !value || value.startsWith(PREFIX)) return value;
    return PREFIX + safeStorage.encryptString(value).toString('base64');
  }

  function open(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
    if (!available) throw new Error('This value was encrypted by the desktop app and can only be read there.');
    return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'));
  }

  // Seals any plaintext secrets already on disk (first launch after upgrading)
  function migrate(store) {
    if (!available) return;
    store.update('settings', s => {
      if (s.anthropicApiKey) s.anthropicApiKey = seal(s.anthropicApiKey);
      if (s.plaid?.secret) s.plaid.secret = seal(s.plaid.secret);
    });
    store.update('plaid', data => {
      for (const item of data.items) if (item.accessToken) item.accessToken = seal(item.accessToken);
    });
  }

  return { available, seal, open, migrate };
}

module.exports = { createSecrets };
