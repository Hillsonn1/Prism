'use strict';
// Sign up, sign in, sign out, who am I — only mounted in hosted mode.
const express = require('express');
const { route } = require('../validate');

module.exports = function authRoutes({ users, secure }) {
  const router = express.Router();
  const ip = req => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';

  router.post('/auth/signup', route((req, res) => {
    if (!users.allowAttempt(ip(req))) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
    const user = users.signup({ email: req.body.email, password: req.body.password, name: req.body.name });
    res.setHeader('Set-Cookie', users.cookieFor(user.id, { secure }));
    res.json({ user });
  }));

  router.post('/auth/login', route((req, res) => {
    if (!users.allowAttempt(ip(req))) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
    const user = users.login({ email: req.body.email, password: req.body.password });
    res.setHeader('Set-Cookie', users.cookieFor(user.id, { secure }));
    res.json({ user });
  }));

  router.post('/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', users.clearCookie({ secure }));
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => res.json({ hosted: true, user: req.user || null }));

  router.post('/auth/password', route((req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    users.changePassword(req.user.id, req.body.current, req.body.next);
    res.json({ ok: true });
  }));

  return router;
};
