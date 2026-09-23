'use strict';
const express = require('express');
const { route, str } = require('../validate');
const cfg = require('../categoryConfig');

module.exports = function categoryRoutes({ store }) {
  const router = express.Router();

  router.get('/categories', (_req, res) => res.json({ categories: cfg.getCategories(store), icons: cfg.ICON_NAMES }));

  router.post('/categories', route((req, res) => {
    res.json(cfg.addCategory(store, { name: req.body.name, color: req.body.color, icon: req.body.icon }));
  }));

  router.put('/categories/:name', route((req, res) => {
    const { color, icon, hidden } = req.body;
    res.json(cfg.updateCategory(store, req.params.name, { color, icon, hidden: hidden === undefined ? undefined : Boolean(hidden) }));
  }));

  router.post('/categories/rename', route((req, res) => {
    res.json(cfg.renameCategory(store, str(req.body.from, { field: 'from', required: true }), str(req.body.to, { field: 'to', required: true })));
  }));

  router.post('/categories/merge', route((req, res) => {
    res.json(cfg.mergeCategory(store, str(req.body.from, { field: 'from', required: true }), str(req.body.to, { field: 'to', required: true })));
  }));

  router.post('/categories/restore', route((req, res) => {
    res.json(cfg.restoreCategory(store, str(req.body.name, { field: 'name', required: true })));
  }));

  return router;
};
