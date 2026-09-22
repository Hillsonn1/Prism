'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempStore } = require('./helpers');

test('read returns defaults, write persists, update mutates in place', () => {
  const { dir, store, cleanup } = tempStore();
  try {
    assert.deepEqual(store.read('transactions'), []);
    store.update('transactions', list => { list.push({ id: 1 }); });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'transactions.json'), 'utf8')), [{ id: 1 }]);
    const next = store.update('transactions', list => list.filter(t => t.id !== 1));
    assert.deepEqual(next, []);
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0);
  } finally { cleanup(); }
});

test('a corrupt file is set aside and the newest backup restored', () => {
  const { dir, store, cleanup } = tempStore();
  try {
    store.write('merchants', { a: 'Groceries' });
    store.write('merchants', { a: 'Groceries', b: 'Shopping' }); // creates today's backup of the first version
    fs.writeFileSync(path.join(dir, 'merchants.json'), '{not json');
    const fresh = new (require('../src/server/storage').Store)(dir);
    assert.deepEqual(fresh.read('merchants'), { a: 'Groceries' });
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('merchants.json.corrupt-')));
  } finally { cleanup(); }
});

test('unknown store names are rejected', () => {
  const { store, cleanup } = tempStore();
  try { assert.throws(() => store.read('nope'), /Unknown store/); } finally { cleanup(); }
});
