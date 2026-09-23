'use strict';
// What counts as your own spending. Excluded rows (bought for someone else,
// work expenses you'll get back) stay in the list but out of every total.

const isCounted = t => !t.excluded && !t.reimbursable;

module.exports = { isCounted };
