// Writes site/version.json from package.json so the landing page and the
// in-app update check always advertise the version that was actually built.
// Run by both deploy workflows before publishing site/.
const fs = require('fs');
const path = require('path');

const { version } = require('../package.json');
const file = path.join(__dirname, '..', 'site', 'version.json');

let current = {};
try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

fs.writeFileSync(file, JSON.stringify({ ...current, version }, null, 2) + '\n');
console.log(`site/version.json -> ${version}`);
