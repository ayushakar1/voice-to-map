import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gazetteer } from '../server/gazetteer.js';
import { AO_PRESETS } from '../server/config.js';
import { resolve } from '../server/resolver.js';
import { ruleParse } from '../server/intent.js';
import { nameSimilarity } from '../server/text.js';
import { store } from '../server/store.js';

const nyc = { id: 'nyc-midtown', ...AO_PRESETS['nyc-midtown'] };
const paris = { id: 'paris-marais', ...AO_PRESETS['paris-marais'] };
const center = { lat: 40.754, lon: -73.9865 };

test('New York loads real regional data even with the Paris fixture configured', async (t) => {
  const previous = process.env.GAZETTEER_FILE;
  process.env.GAZETTEER_FILE = 'test/fixtures/synthetic-gazetteer.json';
  t.after(() => {
    if (previous === undefined) delete process.env.GAZETTEER_FILE;
    else process.env.GAZETTEER_FILE = previous;
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Bundled data should load without network'); });
  t.mock.method(console, 'warn', () => {});
  const gaz = new Gazetteer();
  await gaz.load(paris);
  assert.ok(gaz.features.some(f => f.name === 'Place des Vosges'));
  const stats = await gaz.load(nyc);
  assert.match(stats.source, /OpenStreetMap/);
  assert.equal(stats.loading, false);
  assert.ok(stats.streets >= 50);
  assert.ok(gaz.features.every(f => f.lat > 40 && f.lat < 41 && f.lon < -73));
  assert.ok(!gaz.features.some(f => f.name === 'Place des Vosges'));
  await gaz.load(paris);
  assert.ok(gaz.features.some(f => f.name === 'Place des Vosges'));
});

for (const [text, expected] of [
  ['alpha at thirty fourth street', /34th Street$/],
  ['I am at 35th street', /35th Street$/],
  ['I am on forty second street', /42nd Street$/],
]) {
  test(`NYC report resolves ${text}`, async () => {
    const gaz = new Gazetteer();
    await gaz.load(nyc);
    const result = await resolve(gaz, ruleParse(text), null, center);
    assert.equal(result.status, 'resolved');
    assert.match(result.anchor.name, expected);
    assert.ok(result.lat >= nyc.bbox[0] && result.lat <= nyc.bbox[2]);
    assert.ok(result.lon >= nyc.bbox[1] && result.lon <= nyc.bbox[3]);
  });
}

test('Times Square resolves within the expanded New York area', async () => {
  const gaz = new Gazetteer();
  await gaz.load(nyc);
  const result = await resolve(gaz, ruleParse('I am at Times Square'), null, center);
  assert.equal(result.status, 'resolved');
  assert.equal(result.anchor.name, 'Times Square');
  assert.equal(result.anchor.category, 'square');
  assert.ok(result.lat > 40.756 && result.lat < nyc.bbox[2]);
  assert.ok(result.lon > -73.990 && result.lon < -73.980);
});

test('34th Street and Fifth Avenue resolve to their actual OSM intersection', async () => {
  const gaz = new Gazetteer();
  await gaz.load(nyc);
  const result = await resolve(gaz, ruleParse('corner of 5th Avenue and 34th Street'), null, center);
  assert.equal(result.method, 'intersection');
  assert.ok(Math.abs(result.lat - 40.74845) < 0.001);
  assert.ok(Math.abs(result.lon + 73.98455) < 0.001);
});

test('numbered street matches reject different street numbers', async (t) => {
  assert.equal(nameSimilarity('34th Street', 'West 35th Street'), 0);
  assert.ok(nameSimilarity('34th Street', 'West 34th Street') > 0.8);
  const gaz = new Gazetteer();
  await gaz.load(nyc);
  t.mock.method(gaz, 'nominatim', async () => []);
  const result = await resolve(gaz, ruleParse('I am at 999th street'), null, center);
  assert.equal(result.status, 'unresolved');
});

test('changing cities invalidates cached geocoder matches', async (t) => {
  const previous = process.env.GAZETTEER_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.GAZETTEER_FILE;
    else process.env.GAZETTEER_FILE = previous;
  });
  const gaz = new Gazetteer();
  await gaz.load(nyc);
  gaz.nominatimCache.set('church', [{ name: 'New York church' }]);
  process.env.GAZETTEER_FILE = 'test/fixtures/synthetic-gazetteer.json';
  await gaz.load(paris);
  assert.equal(gaz.ao.id, 'paris-marais');
  assert.equal(gaz.nominatimCache.size, 0);
});

test('previous positions are scoped to the active area, including historical events without AO metadata', (t) => {
  const original = store.events;
  t.after(() => { store.events = original; });
  store.events = [
    { unit: 'Alpha 1', ts: 1, position: { lat: 40.750, lon: -73.985 } },
    { unit: 'Alpha 1', ts: 2, position: { lat: 48.855, lon: 2.36 } },
  ];
  assert.equal(store.lastPosition('Alpha 1', Infinity, nyc.bbox).lat, 40.750);
  assert.equal(store.lastPosition('Alpha 1', Infinity, paris.bbox).lat, 48.855);
  assert.equal(store.lastPosition('Alpha 1').lat, 48.855);
});
