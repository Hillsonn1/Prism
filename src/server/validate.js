'use strict';
// Small request-body validators. Each returns the cleaned value or throws a
// 400-tagged error that the route layer turns into a JSON response.

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function str(value, { field = 'value', max = 200, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw bad(`${field} must be text`);
  const s = value.trim();
  if (required && !s) throw bad(`${field} is required`);
  return s.slice(0, max);
}

function num(value, { field = 'value', required = false, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${field} is required`);
    return undefined;
  }
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) throw bad(`${field} must be a number`);
  if (n < min || n > max) throw bad(`${field} is out of range`);
  return Math.round(n * 100) / 100;
}

function isoDate(value, { field = 'date', required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${field} is required`);
    return undefined;
  }
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${field} must be YYYY-MM-DD`);
  return s;
}

function month(value, { field = 'month' } = {}) {
  const s = String(value || '');
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) throw bad(`${field} must be YYYY-MM`);
  return s;
}

// Wraps an async/sync route so thrown errors become JSON responses
const route = fn => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  }
};

module.exports = { bad, str, num, isoDate, month, route };
