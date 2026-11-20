// AO gazetteer: preloads every named landmark and street in the area of operation from OSM (Overpass),
// caches it to disk, and answers fuzzy lookups locally (no network on the hot path).
// Falls back to Nominatim for names not in the preload.
import fs from 'node:fs';
import path from 'node:path';
import * as turf from '@turf/turf';
import { config } from './config.js';
import { categoryFromTags, GENERIC_WORDS } from './categories.js';
import { nameSimilarity, normalize, tokens } from './text.js';

const OVERPASS_MIRRORS = [
  config.overpassUrl,
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter((v, i, a) => v && a.indexOf(v) === i);

function overpassQuery([s, w, n, e]) {
  return `[out:json][timeout:90][bbox:${s},${w},${n},${e}];
(
  nwr[name][amenity];
  nwr[name][tourism];
  nwr[name][historic];
  nwr[name][leisure];
  nwr[name][building~"^(church|cathedral|chapel|basilica|school|hospital|train_station)$"];
  nwr[name][railway~"^(station|subway_entrance)$"];
  nwr[name][public_transport=station];
  nwr[name][place~"^(square|neighbourhood|quarter)$"];
  nwr[name][shop~"^(supermarket|convenience|bakery|department_store|mall)$"];
  nwr[name][man_made~"^(bridge|tower)$"];
  nwr[name][landuse=cemetery];
)->.pois;
.pois out center tags;
way[name][highway]->.streets;
.streets out geom tags;`;
}

function namesOf(tags) {
  return [...new Set(['name', 'name:en', 'name:fr', 'alt_name', 'official_name', 'short_name', 'old_name', 'loc_name']
    .map((k) => tags[k]).filter(Boolean))];
}

/** Turn raw Overpass JSON into our feature list. Streets with the same name are merged. */
export function buildFeatures(osm) {
  const pois = [];
  const streets = new Map();
  for (const el of osm.elements ?? []) {
    const tags = el.tags ?? {};
    if (!tags.name) continue;
    if (el.type === 'way' && el.geometry && tags.highway && !(tags.area === 'yes')) {
      const key = normalize(tags.name);
      const coords = el.geometry.map((p) => [p.lon, p.lat]);
      if (coords.length < 2) continue;
      if (!streets.has(key)) streets.set(key, { id: `street:${key}`, kind: 'street', category: 'street', name: tags.name, names: namesOf(tags), lines: [], osmIds: [] });
      const s = streets.get(key);
      s.lines.push(coords);
      s.osmIds.push(`w${el.id}`);
      for (const n of namesOf(tags)) if (!s.names.includes(n)) s.names.push(n);
      continue;
    }
    const lat = el.lat ?? el.center?.lat ?? (el.geometry ? el.geometry[Math.floor(el.geometry.length / 2)].lat : undefined);
    const lon = el.lon ?? el.center?.lon ?? (el.geometry ? el.geometry[Math.floor(el.geometry.length / 2)].lon : undefined);
    if (lat === undefined) continue;
    pois.push({ id: `${el.type[0]}${el.id}`, kind: 'landmark', category: categoryFromTags(tags), name: tags.name, names: namesOf(tags), lat, lon });
  }
  const streetFeats = [...streets.values()].map((s) => {
    const ml = turf.multiLineString(s.lines);
    const c = turf.centroid(ml).geometry.coordinates;
    const near = turf.nearestPointOnLine(ml, turf.point(c)).geometry.coordinates;
    return { ...s, lat: near[1], lon: near[0] };
  });
  return [...pois, ...streetFeats];
}

class Gazetteer {
  constructor() { this.features = []; this.ao = null; this.source = 'empty'; this.nominatimCache = new Map(); this.lastNominatim = 0; }

  cacheFile(ao) { return path.join(config.dataDir, `gazetteer-${ao.id}-${ao.bbox.join('_')}.json`); }

  async load(ao, { force = false } = {}) {
    this.ao = ao;
    const fixture = process.env.GAZETTEER_FILE;
    if (fixture) {
      this.features = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      this.source = `fixture:${path.basename(fixture)}`;
      return this.stats();
    }
    const file = this.cacheFile(ao);
    if (!force && fs.existsSync(file)) {
      this.features = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.source = 'disk-cache';
      return this.stats();
    }
    const q = overpassQuery(ao.bbox);
    let lastErr;
    for (const url of OVERPASS_MIRRORS) {
      try {
        const t0 = Date.now();
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.userAgent },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(100_000),
        });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        const osm = await res.json();
        this.features = buildFeatures(osm);
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(this.features));
        this.source = `overpass (${url.split('/')[2]}, ${Date.now() - t0} ms)`;
        return this.stats();
      } catch (e) { lastErr = e; console.warn(`[gazetteer] ${url} failed: ${e.message}`); }
    }
    this.features = [];
    this.source = `empty (Overpass failed: ${lastErr?.message}) – Nominatim fallback only`;
    return this.stats();
  }

  stats() {
    const streets = this.features.filter((f) => f.kind === 'street').length;
    return { source: this.source, total: this.features.length, streets, landmarks: this.features.length - streets };
  }

  /** Distance in metres from a {lat,lon} to a feature (nearest point for streets). */
  distanceTo(f, p) {
    if (!p) return 0;
    if (f.kind === 'street') {
      const np = this.nearestPointOnStreet(f, p);
      return np.distM;
    }
    return turf.distance([p.lon, p.lat], [f.lon, f.lat], { units: 'meters' });
  }

  nearestPointOnStreet(f, p) {
    const ml = turf.multiLineString(f.lines);
    const np = turf.nearestPointOnLine(ml, turf.point([p.lon, p.lat]), { units: 'meters' });
    const [lon, lat] = np.geometry.coordinates;
    return { lat, lon, distM: np.properties.dist ?? np.properties.pointDistance ?? 0 };
  }

  /**
   * Fuzzy search. query: spoken name ("saint paul church", "35th street"), category: our key or null,
   * near: {lat,lon} bias (unit's last position or AO centre), kind: 'street'|'landmark'|null.
   */
  search({ query, category, near, kind, limit = 5 }) {
    const qAll = tokens(query ?? '');
    const qSpecific = qAll.filter((t) => !GENERIC_WORDS.has(t));
    const scoreFeature = (f, nameScore, named) => {
      const catBonus = category && f.category === category ? 0.15 : category && f.category !== category ? -0.1 : 0;
      const d = this.distanceTo(f, near);
      // Distance matters a lot for generic references ("the church"), less for named ones.
      const distPenalty = (named ? 0.15 : 0.5) * Math.min(d / 1500, 1);
      return { feature: f, nameScore, distM: Math.round(d), score: nameScore + catBonus - distPenalty };
    };
    const pool = this.features.filter((f) => !(kind === 'street' && f.kind !== 'street') && !(kind === 'landmark' && f.kind === 'street'));

    // Pass 1: named reference. Specific tokens ("saint paul"), or an exact multi-word name made of
    // generic words ("Rue du Temple").
    const named = [];
    for (const f of pool) {
      let best = 0;
      for (const n of f.names) {
        if (qSpecific.length) best = Math.max(best, nameSimilarity(query, n, GENERIC_WORDS));
        if (qAll.length >= 2) { const full = nameSimilarity(query, n); if (full >= 0.9) best = Math.max(best, full); }
      }
      if (best >= 0.5) named.push(scoreFeature(f, best, true));
    }
    if (named.length) return named.sort((a, b) => b.score - a.score).slice(0, limit);

    // Pass 2: generic reference ("the church", "town hall") -> nearest feature of that category.
    // If the speaker gave a name we could not match, still offer the nearest of that kind, but scored low
    // so the resolver also asks Nominatim and the card is flagged.
    if (!category) return [];
    const generic = pool.filter((f) => f.category === category).map((f) => scoreFeature(f, qSpecific.length ? 0.5 : 0.6, false));
    return generic.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Names near a point, for the LLM prompt (helps it normalise ASR errors to real names). */
  namesNear(p, n = 80) {
    if (!p) return [];
    return this.features
      .map((f) => ({ f, d: turf.distance([p.lon, p.lat], [f.lon, f.lat], { units: 'meters' }) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map(({ f }) => `${f.name} (${f.category})`);
  }

  /** Nominatim fallback, bounded to the AO. Respects the 1 req/s usage policy. */
  async nominatim(query) {
    if (!this.ao || !query) return [];
    const key = query.toLowerCase();
    if (this.nominatimCache.has(key)) return this.nominatimCache.get(key);
    const wait = 1100 - (Date.now() - this.lastNominatim);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastNominatim = Date.now();
    const [s, w, n, e] = this.ao.bbox;
    const url = `${config.nominatimUrl}/search?format=jsonv2&limit=5&bounded=1&polygon_geojson=1&namedetails=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': config.userAgent, 'Accept-Language': 'en,fr' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const arr = await res.json();
      const feats = arr.map((r) => {
        const g = r.geojson;
        const isLine = g && (g.type === 'LineString' || g.type === 'MultiLineString');
        const base = { id: `nom:${r.osm_type?.[0]}${r.osm_id}`, name: r.name || r.display_name.split(',')[0], names: [r.name].filter(Boolean), lat: Number(r.lat), lon: Number(r.lon) };
        if (isLine) return { ...base, kind: 'street', category: 'street', lines: g.type === 'LineString' ? [g.coordinates] : g.coordinates };
        return { ...base, kind: 'landmark', category: categoryFromTags({ [r.category]: r.type }) };
      });
      this.nominatimCache.set(key, feats);
      return feats;
    } catch (e) {
      console.warn(`[nominatim] ${e.message}`);
      return [];
    }
  }
}

export const gazetteer = new Gazetteer();
export { Gazetteer };
