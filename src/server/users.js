'use strict';
// Accounts for the hosted version: email + password (scrypt), signed session
// cookies (HMAC with the server secret), and a small rate limit on sign-in.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bad } = require('./validate');

const SESSION_DAYS = 30;
const COOKIE = 'prism_session';
const ATTEMPTS = 20;              // per IP…
const ATTEMPT_WINDOW = 15 * 60e3; // …per 15 minutes

const normalizeEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hash, 'base64');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

function createUsers({ dataDir, secret }) {
  if (!secret || secret.length < 16) throw new Error('PRISM_SECRET must be set (at least 16 characters) to run the hosted version');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'users.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { users: [] }; } };
  const save = data => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  const publicUser = u => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt });

  function signup({ email, password, name }) {
    email = normalizeEmail(email);
    if (!validEmail(email)) throw bad('Enter a valid email address');
    if (typeof password !== 'string' || password.length < 8) throw bad('Use a password of at least 8 characters');
    if (password.length > 200) throw bad('That password is too long');
    const data = load();
    if (data.users.some(u => u.email === email)) throw bad('There is already an account with that email');
    const user = { id: crypto.randomUUID(), email, name: String(name || '').trim().slice(0, 80) || email.split('@')[0], passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    data.users.push(user);
    save(data);
    return publicUser(user);
  }

  function login({ email, password }) {
    email = normalizeEmail(email);
    const user = load().users.find(u => u.email === email);
    // Same work and same message whether or not the account exists
    const ok = user ? verifyPassword(String(password || ''), user.passwordHash) : (hashPassword(String(password || '')), false);
    if (!ok) throw Object.assign(new Error('Wrong email or password'), { status: 401 });
    return publicUser(user);
  }

  const byId = id => { const u = load().users.find(x => x.id === id); return u ? publicUser(u) : null; };
  const count = () => load().users.length;

  function changePassword(id, current, next) {
    if (typeof next !== 'string' || next.length < 8) throw bad('Use a password of at least 8 characters');
    const data = load();
    const user = data.users.find(u => u.id === id);
    if (!user || !verifyPassword(String(current || ''), user.passwordHash)) throw Object.assign(new Error('Current password is wrong'), { status: 401 });
    user.passwordHash = hashPassword(next);
    save(data);
  }

  // ---- Sessions: "<uid>.<expires>.<signature>" ----
  const sign = s => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  function sessionToken(uid) {
    const exp = Date.now() + SESSION_DAYS * 86400e3;
    const body = `${uid}.${exp}`;
    return `${body}.${sign(body)}`;
  }
  function verifySession(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [uid, exp, sig] = parts;
    const expected = sign(`${uid}.${exp}`);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Number(exp) < Date.now()) return null;
    return byId(uid);
  }
  const cookieFor = (uid, { secure }) => `${COOKIE}=${sessionToken(uid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  const clearCookie = ({ secure }) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  const readCookie = req => {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  };

  // ---- Rate limit for sign-in attempts ----
  const attempts = new Map();
  function allowAttempt(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter(t => now - t < ATTEMPT_WINDOW);
    if (list.length >= ATTEMPTS) { attempts.set(ip, list); return false; }
    list.push(now);
    attempts.set(ip, list);
    return true;
  }

  return { signup, login, byId, count, changePassword, verifySession, cookieFor, clearCookie, readCookie, allowAttempt, COOKIE };
}

module.exports = { createUsers, hashPassword, verifyPassword };
