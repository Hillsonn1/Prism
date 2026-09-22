'use strict';
// Finds merchant names that are really the same merchant, without AI:
// spelling variants ("Krispykreme" / "Krispy Kreme"), punctuation and number
// differences, and longer variants of a name already in use ("Amazon Mktpl"
// → "Amazon"). Returns proposals for the user to review; nothing is merged here.

const { simpleKey } = require('./categories');

const compactKey = name => simpleKey(name).replace(/\s+/g, '');

// Levenshtein distance, only used on short strings
function editDistance(a, b) {
  const rows = a.length + 1, cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 1; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[rows - 1][cols - 1];
}

// transactions → [{ from, to, count, reason }], grouped so each name appears once
function mergeProposals(transactions, merchants = {}) {
  const counts = new Map();
  for (const t of transactions) counts.set(t.merchant, (counts.get(t.merchant) || 0) + 1);
  const names = [...counts.keys()];
  const category = name => merchants[name] || transactions.find(t => t.merchant === name)?.category || null;
  const proposals = new Map(); // from → { to, reason }
  const propose = (from, to, reason) => {
    if (from === to || proposals.has(from) || proposals.has(to)) return;
    const a = category(from), b = category(to);
    if (a && b && a !== b) return; // probably different businesses after all
    proposals.set(from, { to, reason });
  };
  // Prefer the name with more transactions, then one the user has categorized,
  // then the more natural spelling (more words, not missing letters)
  const words = n => n.trim().split(/\s+/).length;
  const canonical = group => [...group].sort((x, y) =>
    (counts.get(y) - counts.get(x)) || ((merchants[y] ? 1 : 0) - (merchants[x] ? 1 : 0)) || (words(y) - words(x)) || (y.length - x.length))[0];

  // 1. Same once punctuation, numbers and spacing are ignored
  const byCompact = new Map();
  for (const n of names) {
    const k = compactKey(n);
    if (k.length < 4) continue;
    (byCompact.get(k) || byCompact.set(k, []).get(k)).push(n);
  }
  for (const group of byCompact.values()) {
    if (group.length < 2) continue;
    const to = canonical(group);
    for (const n of group) propose(n, to, 'same name');
  }

  // 2. A name that is another name plus extra words
  const keyed = names.map(n => ({ n, k: simpleKey(n) })).filter(x => x.k.length >= 6);
  for (const long of keyed) {
    let best = null;
    for (const short of keyed) {
      if (short === long || short.k.length >= long.k.length) continue;
      if (long.k.startsWith(short.k + ' ') && (!best || short.k.length > best.k.length)) best = short;
    }
    if (best) propose(long.n, best.n, `variant of "${best.n}"`);
  }

  // 3. One or two characters apart (typos, truncation)
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const a = keyed[i], b = keyed[j];
      if (a.k.length < 8 || Math.abs(a.k.length - b.k.length) > 2) continue;
      if (editDistance(a.k, b.k) <= 2) {
        const to = canonical([a.n, b.n]);
        propose(to === a.n ? b.n : a.n, to, 'spelling');
      }
    }
  }

  return [...proposals].map(([from, { to, reason }]) => ({ from, to, count: counts.get(from), reason }))
    .sort((x, y) => x.to.localeCompare(y.to) || y.count - x.count);
}

module.exports = { mergeProposals, editDistance, compactKey };
