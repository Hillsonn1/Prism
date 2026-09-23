'use strict';
// Secrets at rest. In the desktop app, Electron's safeStorage encrypts values
// with the OS keychain (macOS Keychain, Windows DPAPI); plain node keeps them
// as-is. Sealed values are stored as "enc:<base64>" so both forms coexist.

const crypto = require('crypto');

const PREFIX = 'enc:';      // Electron safeStorage
const SW_PREFIX = 'enc2:';  // AES-256-GCM with a key derived from the server secret (hosted version)

// The hosted server has no keychain: derive a key from PRISM_SECRET instead
function softwareCipher(secret) {
  const key = crypto.scryptSync(secret, 'prism-secrets', 32);
  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
    },
    decrypt(b64) {
      const buf = Buffer.from(b64, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function createSecrets(safeStorage = null, { softwareKey = null } = {}) {
  const osAvailable = Boolean(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  const sw = !osAvailable && softwareKey ? softwareCipher(softwareKey) : null;
  const available = osAvailable || Boolean(sw);

  function seal(value) {
    if (!available || typeof value !== 'string' || !value || value.startsWith(PREFIX) || value.startsWith(SW_PREFIX)) return value;
    return osAvailable ? PREFIX + safeStorage.encryptString(value).toString('base64') : SW_PREFIX + sw.encrypt(value);
  }

  function open(value) {
    if (typeof value !== 'string') return value;
    if (value.startsWith(SW_PREFIX)) {
      if (!sw) throw new Error('This value was encrypted by the hosted server and needs its PRISM_SECRET.');
      return sw.decrypt(value.slice(SW_PREFIX.length));
    }
    if (!value.startsWith(PREFIX)) return value;
    if (!osAvailable) throw new Error('This value was encrypted by the desktop app and can only be read there.');
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
