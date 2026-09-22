// Writes site/version.json so the landing page and the in-app update check
// advertise a version that actually exists as a release.
//
//   node scripts/write-version.js          → the version in package.json
//   node scripts/write-version.js 1.2.1    → an explicit version (the site
//                                            deploy passes the latest release)
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || require('../package.json').version).replace(/^v/, '');
const file = path.join(__dirname, '..', 'site', 'version.json');

let current = {};
try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

fs.writeFileSync(file, JSON.stringify({ ...current, version }, null, 2) + '\n');
console.log(`site/version.json -> ${version}`);
