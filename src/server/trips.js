'use strict';
// Trips: a tag plus a date range. Everything tagged with the trip shows up in
// its report; creating a trip tags the purchases in its range for you.

const crypto = require('crypto');
const { bad, str, isoDate } = require('./validate');
const { recurringCharges } = require('./insights');

const DAY = 86400000;
// Categories that keep running while you're away, so they're left out by default
const AT_HOME_CATEGORIES = new Set(['Utilities & Bills', 'Subscriptions & Streaming']);
const COUNTRIES = {
  israel: 'IL', 'united states': 'US', usa: 'US', 'u.s.': 'US', america: 'US', thailand: 'TH', 'united kingdom': 'GB', uk: 'GB', england: 'GB',
  france: 'FR', germany: 'DE', italy: 'IT', spain: 'ES', canada: 'CA', mexico: 'MX', japan: 'JP', greece: 'GR', cyprus: 'CY', portugal: 'PT',
  netherlands: 'NL', switzerland: 'CH', austria: 'AT', turkey: 'TR', 'united arab emirates': 'AE', dubai: 'AE', india: 'IN', australia: 'AU',
};

// "Jerusalem, Israel" → "IL"; unknown → null
function homeCountry(settings) {
  const text = String(settings.location || '').toLowerCase();
  for (const [name, code] of Object.entries(COUNTRIES)) if (text.includes(name)) return code;
  return null;
}

const inRange = (t, trip) => t.date >= trip.start && t.date <= trip.end;
const hasTag = (t, tag) => Array.isArray(t.tags) && t.tags.includes(tag);
const addTag = (t, tag) => { if (!hasTag(t, tag)) t.tags = [...(t.tags || []), tag]; };
const removeTag = (t, tag) => { if (hasTag(t, tag)) { t.tags = t.tags.filter(x => x !== tag); if (!t.tags.length) delete t.tags; } };

function validateTrip(body, existing = {}) {
  const name = body.name !== undefined ? str(body.name, { field: 'name', max: 60, required: true }) : existing.name;
  const start = body.start !== undefined ? isoDate(body.start, { field: 'start', required: true }) : existing.start;
  const end = body.end !== undefined ? isoDate(body.end, { field: 'end', required: true }) : existing.end;
  if (!name || !start || !end) throw bad('A trip needs a name, a start and an end');
  if (end < start) throw bad('The trip ends before it starts');
  const notes = body.notes !== undefined ? str(body.notes, { field: 'notes', max: 500 }) || undefined : existing.notes;
  return { name, start, end, notes };
}

// Tags the purchases inside the range. Recurring charges and at-home
// categories stay out unless includeAll is set. Returns how many were tagged.
function tagRange(store, trip, { includeAll = false } = {}) {
  let tagged = 0;
  store.update('transactions', list => {
    const recurring = includeAll ? new Set() : new Set(recurringCharges(list).map(r => r.merchant));
    for (const t of list) {
      if (!inRange(t, trip) || hasTag(t, trip.tag)) continue;
      if (!includeAll && (recurring.has(t.merchant) || AT_HOME_CATEGORIES.has(t.category))) continue;
      addTag(t, trip.tag);
      tagged++;
    }
  });
  return tagged;
}

function listTrips(store) { return store.read('settings').trips || []; }

function createTrip(store, body) {
  const fields = validateTrip(body);
  if (listTrips(store).some(t => t.name.toLowerCase() === fields.name.toLowerCase())) throw bad(`There's already a trip called "${fields.name}"`);
  const trip = { id: crypto.randomUUID(), ...fields, tag: fields.name, createdAt: new Date().toISOString() };
  store.update('settings', s => { (s.trips = s.trips || []).push(trip); });
  const tagged = body.tagRange === false ? 0 : tagRange(store, trip, { includeAll: Boolean(body.includeAll) });
  return { trip, tagged };
}

function updateTrip(store, id, body) {
  const existing = listTrips(store).find(t => t.id === id);
  if (!existing) throw bad('No such trip');
  const fields = validateTrip(body, existing);
  const renamed = fields.name !== existing.name;
  if (renamed && listTrips(store).some(t => t.id !== id && t.name.toLowerCase() === fields.name.toLowerCase())) throw bad(`There's already a trip called "${fields.name}"`);
  const trip = { ...existing, ...fields, tag: renamed ? fields.name : existing.tag };
  if (renamed) store.update('transactions', list => { for (const t of list) if (hasTag(t, existing.tag)) { removeTag(t, existing.tag); addTag(t, trip.tag); } });
  store.update('settings', s => { s.trips = (s.trips || []).map(t => (t.id === id ? trip : t)); });
  return trip;
}

function deleteTrip(store, id, { removeTags = false } = {}) {
  const existing = listTrips(store).find(t => t.id === id);
  if (!existing) throw bad('No such trip');
  store.update('settings', s => { s.trips = (s.trips || []).filter(t => t.id !== id); });
  if (removeTags) store.update('transactions', list => { for (const t of list) removeTag(t, existing.tag); });
  return existing;
}

// Runs of purchases away from home, from the bank's location data. Nothing
// to say when the bank doesn't send locations or home isn't set.
function suggestTrips(store, { minPurchases = 4, maxGapDays = 3 } = {}) {
  const settings = store.read('settings');
  const home = homeCountry(settings);
  if (!home) return [];
  const trips = settings.trips || [];
  const away = store.read('transactions')
    .filter(t => t.date && t.location?.country && t.location.country !== home && t.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const clusters = [];
  for (const t of away) {
    const last = clusters[clusters.length - 1];
    if (last && (Date.parse(t.date) - Date.parse(last.end)) / DAY <= maxGapDays) { last.end = t.date; last.txns.push(t); }
    else clusters.push({ start: t.date, end: t.date, txns: [t] });
  }
  return clusters
    .filter(c => c.txns.length >= minPurchases && c.start !== c.end)
    .filter(c => !trips.some(tr => c.start <= tr.end && c.end >= tr.start))
    .map(c => {
      const countries = {};
      for (const t of c.txns) countries[t.location.country] = (countries[t.location.country] || 0) + 1;
      const country = Object.entries(countries).sort((a, b) => b[1] - a[1])[0][0];
      return { start: c.start, end: c.end, country, purchases: c.txns.length, total: Math.round(c.txns.reduce((s, t) => s + t.amount, 0) * 100) / 100 };
    });
}

module.exports = { listTrips, createTrip, updateTrip, deleteTrip, tagRange, suggestTrips, homeCountry, AT_HOME_CATEGORIES };
