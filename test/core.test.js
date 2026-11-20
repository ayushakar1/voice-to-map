import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as turf from '@turf/turf';
import { normalize, nameSimilarity } from '../server/text.js';
import { ruleParse } from '../server/intent.js';
import { Gazetteer } from '../server/gazetteer.js';
import { resolve } from '../server/resolver.js';

process.env.GAZETTEER_FILE = path.resolve('test/fixtures/synthetic-gazetteer.json');
const gaz = new Gazetteer();
await gaz.load({ id: 'test', bbox: [48.850, 2.350, 48.862, 2.368] });
const center = { lat: 48.856, lon: 2.359 };
const d = (a, b) => turf.distance([a.lon, a.lat], [b.lon, b.lat], { units: 'meters' });
const bearing = (a, b) => turf.bearing([a.lon, a.lat], [b.lon, b.lat]);

test('normalisation', () => {
  assert.equal(normalize('thirty fifth street'), '35th street');
  assert.equal(normalize('35th St'), '35th street');
  assert.equal(normalize('35 street'), '35th street');
  assert.equal(normalize('St Paul'), 'saint paul');
  assert.equal(normalize('35th st and 5th ave'), '35th street and 5th avenue');
  assert.equal(normalize("l'Église Saint-Paul"), 'l eglise saint paul');
  assert.ok(nameSimilarity('saint paul church', 'Église Saint-Paul-Saint-Louis', new Set(['church', 'eglise'])) > 0.7);
});

test('rule parser: phrasings from the brief', () => {
  let i = ruleParse('I am South of the church.');
  assert.equal(i.type, 'position'); assert.equal(i.relation, 'south_of'); assert.equal(i.anchor.category, 'church');
  i = ruleParse('I moved towards 35th street');
  assert.equal(i.type, 'movement'); assert.equal(i.relation, 'towards'); assert.equal(i.anchor.kind, 'street');
  i = ruleParse('Alpha 2 here, I am behind the church');
  assert.equal(i.callsign, 'Alpha 2'); assert.equal(i.relation, 'behind');
  i = ruleParse('Bravo one, corner of rue de Rivoli and rue du Temple');
  assert.equal(i.callsign, 'Bravo 1'); assert.equal(i.relation, 'intersection'); assert.equal(i.anchor2.text, 'rue du temple');
  i = ruleParse("Je suis derrière l'église");
  assert.equal(i.relation, 'behind'); assert.equal(i.anchor.category, 'church');
  i = ruleParse("c'est au sud de la place des Vosges");
  assert.equal(i.relation, 'south_of');
  i = ruleParse('moved 200 meters north');
  assert.equal(i.relation, 'direction_only'); assert.equal(i.bearing, 'N'); assert.equal(i.distance_m, 200);
  i = ruleParse('holding position');
  assert.equal(i.type, 'status');
});

test('gazetteer: generic reference picks the nearest church', () => {
  const nearTemple = { lat: 48.8526, lon: 2.3660 };
  const r = gaz.search({ query: 'church', category: 'church', near: nearTemple });
  assert.equal(r[0].feature.name, 'Temple du Marais');
  const r2 = gaz.search({ query: 'church', category: 'church', near: { lat: 48.8548, lon: 2.3605 } });
  assert.equal(r2[0].feature.name, 'Église Saint-Paul-Saint-Louis');
});

test('gazetteer: named church beats same-named street', () => {
  const r = gaz.search({ query: 'Saint Paul church', category: 'church', near: center });
  assert.equal(r[0].feature.name, 'Église Saint-Paul-Saint-Louis');
  const s = gaz.search({ query: 'rue saint paul', category: 'street', near: center, kind: 'street' });
  assert.equal(s[0].feature.name, 'Rue Saint-Paul');
});

test('resolver: south of the church', async () => {
  const intent = ruleParse('I am south of the church');
  const prev = { lat: 48.8548, lon: 2.3605 };
  const r = await resolve(gaz, intent, prev, center);
  assert.equal(r.status, 'resolved');
  assert.equal(r.anchor.name, 'Église Saint-Paul-Saint-Louis');
  assert.ok(r.lat < r.anchor.lat, 'should be south of anchor');
  assert.ok(Math.abs(d(r, r.anchor) - 60) < 2);
});

test('resolver: behind = far side relative to approach', async () => {
  const church = { lat: 48.8545, lon: 2.3612 };
  const prev = { lat: 48.8545, lon: 2.3590 }; // approaching from the west
  const r = await resolve(gaz, ruleParse('I am behind the church'), prev, center);
  assert.ok(r.lon > church.lon, 'should be east of church');
  assert.ok(Math.abs(bearing(church, r) - 90) < 5);
});

test('resolver: moved towards 35th street moves a step north, keeps target', async () => {
  const prev = { lat: 48.8545, lon: 2.3612 };
  const r = await resolve(gaz, ruleParse('I moved towards thirty fifth street'), prev, center);
  assert.equal(r.method, 'towards');
  assert.ok(Math.abs(r.target.lat - 48.8600) < 1e-4, 'target is nearest point on 35th St');
  assert.ok(Math.abs(d(prev, r) - 150) < 2, 'moved one default step');
  assert.ok(r.lat > prev.lat);
});

test('resolver: towards when already close = arrived', async () => {
  const prev = { lat: 48.8595, lon: 2.3612 };
  const r = await resolve(gaz, ruleParse('heading to 35th street'), prev, center);
  assert.equal(r.method, 'towards_arrived');
});

test('resolver: street intersection', async () => {
  const r = await resolve(gaz, ruleParse('corner of rue de Rivoli and rue du Temple'), null, center);
  assert.equal(r.method, 'intersection');
  assert.ok(d(r, { lat: 48.8550, lon: 2.3550 }) < 5);
});

test('resolver: near-miss intersection (ways do not touch)', async () => {
  // Rue Saint-Paul ends exactly on Rue Saint-Antoine -> exact; check it resolves near (48.8535, 2.3620)
  const r = await resolve(gaz, ruleParse('corner of rue Saint-Paul and rue Saint-Antoine'), null, center);
  assert.ok(d(r, { lat: 48.8535, lon: 2.3620 }) < 40, `got ${JSON.stringify(r)}`);
});

test('resolver: dead reckoning and unresolved cases', async () => {
  const prev = { lat: 48.8545, lon: 2.3612 };
  const r = await resolve(gaz, ruleParse('moved 200 meters north'), prev, center);
  assert.ok(Math.abs(d(prev, r) - 200) < 2 && r.lat > prev.lat);
  const u = await resolve(gaz, ruleParse('moved 200 meters north'), null, center);
  assert.equal(u.status, 'unresolved');
  const s = await resolve(gaz, ruleParse('holding position'), prev, center);
  assert.equal(s.status, 'no_move');
});

test('resolver: "across from" and "between"', async () => {
  const prev = { lat: 48.8545, lon: 2.3590 };
  const a = await resolve(gaz, ruleParse('across from the school'), prev, center);
  assert.equal(a.anchor.name, 'Lycée Charlemagne');
  const b = await resolve(gaz, ruleParse('between the bridge and the school'), prev, center);
  assert.equal(b.method, 'between');
});
