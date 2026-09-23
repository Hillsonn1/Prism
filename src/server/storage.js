'use strict';
// JSON-file store with an in-memory cache, atomic writes, and daily backups.
//
// read(name) returns the cached, mutable object for a file; callers mutate it
// and then write(name, data) to persist. Writes go to a temp file and are
// renamed into place, so a crash mid-write never leaves a half-written file.
// The first write of each day copies the previous version into backups/.

const fs = require('fs');
const path = require('path');

const FILES = {
  transactions: { file: 'transactions.json', empty: () => [] },
  merchants:    { file: 'merchants.json',    empty: () => ({}) },
  settings:     { file: 'settings.json',     empty: () => ({}) },
  income:       { file: 'income.json',       empty: () => ({}) },
  expenses:     { file: 'expenses.json',     empty: () => ({}) },
  plaid:        { file: 'plaid.json',        empty: () => ({ items: [] }) },
  fx:           { file: 'fx.json',           empty: () => ({}) },
  merchantInfo: { file: 'merchant-info.json', empty: () => ({}) },
};

const BACKUPS_TO_KEEP = 7;

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, 'backups');
    this.cache = new Map();
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  pathFor(name) {
    const spec = FILES[name];
    if (!spec) throw new Error(`Unknown store: ${name}`);
    return path.join(this.dataDir, spec.file);
  }

  read(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const file = this.pathFor(name);
    let data;
    if (fs.existsSync(file)) {
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        data = this.recover(name, file, err);
      }
    }
    if (data === undefined) data = FILES[name].empty();
    this.cache.set(name, data);
    return data;
  }

  write(name, data) {
    const file = this.pathFor(name);
    this.cache.set(name, data);
    this.backup(name, file);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  // Update in one step: fn receives the current data and returns what to save
  // (or mutates in place and returns nothing).
  update(name, fn) {
    const current = this.read(name);
    const next = fn(current);
    this.write(name, next === undefined ? current : next);
    return this.read(name);
  }

  // A corrupt file is set aside (never silently overwritten) and the newest
  // backup takes its place.
  recover(name, file, err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${file}.corrupt-${stamp}`;
    try { fs.renameSync(file, aside); } catch {}
    console.error(`${path.basename(file)} could not be parsed (${err.message}); moved to ${path.basename(aside)}`);
    const latest = this.backups(name)[0];
    if (!latest) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(latest, 'utf8'));
      console.error(`Restored ${path.basename(file)} from ${path.basename(latest)}`);
      return data;
    } catch {
      return undefined;
    }
  }

  backup(name, file) {
    if (!fs.existsSync(file)) return;
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `${name}-${today}.json`);
    if (fs.existsSync(target)) return;
    try {
      fs.copyFileSync(file, target);
      for (const old of this.backups(name).slice(BACKUPS_TO_KEEP)) fs.unlinkSync(old);
    } catch (err) {
      console.error(`Backup of ${name} failed:`, err.message);
    }
  }

  // Newest first
  backups(name) {
    let files;
    try { files = fs.readdirSync(this.backupDir); } catch { return []; }
    return files
      .filter(f => f.startsWith(`${name}-`) && f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => path.join(this.backupDir, f));
  }
}

module.exports = { Store, FILES };
