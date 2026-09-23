'use strict';
// Several people, one server. Every request runs inside an async context that
// names the signed-in user; the `store` (and a few per-user state objects) the
// modules were built with are proxies that resolve to that user's own. The
// desktop app never sets a context, so it keeps using its single local store.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Store } = require('./storage');

const als = new AsyncLocalStorage();

// The object the modules hold: read/write/update go to the current user's store
function contextualStore(fallback) {
  const current = () => als.getStore()?.store || fallback;
  return {
    read: name => current().read(name),
    write: (name, data) => current().write(name, data),
    update: (name, fn) => current().update(name, fn),
    backups: name => current().backups(name),
    get dataDir() { return current().dataDir; },
    get isContextual() { return true; },
  };
}

// A plain object whose properties live on the current user's state bag
function contextualObject(key, fallback) {
  const current = () => als.getStore()?.[key] || fallback;
  return new Proxy({}, {
    get: (_, prop) => current()[prop],
    set: (_, prop, value) => { current()[prop] = value; return true; },
    deleteProperty: (_, prop) => { delete current()[prop]; return true; },
    has: (_, prop) => prop in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_, prop) => Object.getOwnPropertyDescriptor(current(), prop),
  });
}

// One Store (and state bag) per user, created on first use
function createRegistry({ dataDir, prepare = () => {} }) {
  const stores = new Map();
  const states = new Map();
  const userDir = uid => path.join(dataDir, 'users', String(uid));

  function storeFor(uid) {
    if (!stores.has(uid)) {
      const dir = path.join(userDir(uid), 'data');
      fs.mkdirSync(dir, { recursive: true });
      const store = new Store(dir);
      stores.set(uid, store);
      prepare(store);
    }
    return stores.get(uid);
  }
  function stateFor(uid) {
    if (!states.has(uid)) states.set(uid, { plaid: {}, intel: {} });
    return states.get(uid);
  }
  function context(uid) {
    const bag = stateFor(uid);
    return { uid, store: storeFor(uid), plaidState: bag.plaid, intelState: bag.intel };
  }
  // Runs fn as this user (for background jobs)
  const runAs = (uid, fn) => als.run(context(uid), fn);
  const forget = uid => { stores.delete(uid); states.delete(uid); };

  return { storeFor, stateFor, context, runAs, forget, userDir };
}

const currentUser = () => als.getStore()?.uid || null;

module.exports = { als, contextualStore, contextualObject, createRegistry, currentUser };
