'use strict';
const express = require('express');
const { route } = require('../validate');
const trips = require('../trips');

module.exports = function tripRoutes({ store }) {
  const router = express.Router();

  router.get('/trips', (_req, res) => res.json({ trips: trips.listTrips(store), suggestions: trips.suggestTrips(store) }));
  router.post('/trips', route((req, res) => res.json(trips.createTrip(store, req.body))));
  router.put('/trips/:id', route((req, res) => res.json(trips.updateTrip(store, req.params.id, req.body))));
  router.delete('/trips/:id', route((req, res) => res.json(trips.deleteTrip(store, req.params.id, { removeTags: req.query.removeTags === '1' }))));

  // Tag whatever is in the trip's range but not tagged yet
  router.post('/trips/:id/retag', route((req, res) => {
    const trip = trips.listTrips(store).find(t => t.id === req.params.id);
    if (!trip) return res.status(404).json({ error: 'No such trip' });
    res.json({ tagged: trips.tagRange(store, trip, { includeAll: Boolean(req.body.includeAll) }) });
  }));

  return router;
};
