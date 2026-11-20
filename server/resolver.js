// Spatial reasoning: (intent + unit's previous position + gazetteer) -> estimated coordinates.
import * as turf from '@turf/turf';
import { config } from './config.js';
import { normalize } from './text.js';

const BEARING_DEG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: -135, W: -90, NW: -45 };
const REL_BEARING = { north_of: 'N', north_east_of: 'NE', east_of: 'E', south_east_of: 'SE', south_of: 'S', south_west_of: 'SW', west_of: 'W', north_west_of: 'NW' };

const pt = (p) => turf.point([p.lon, p.lat]);
const ll = (f) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
const dest = (p, m, deg) => ll(turf.destination(pt(p), m, deg, { units: 'meters' }));
const dist = (a, b) => turf.distance(pt(a), pt(b), { units: 'meters' });
const brg = (a, b) => turf.bearing(pt(a), pt(b));
const cardinal = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function featureSummary(f) {
  return { id: f.id, name: f.name, category: f.category, kind: f.kind, lat: f.lat, lon: f.lon };
}

/** Find the best gazetteer feature for an anchor; Nominatim as fallback. */
const unitKey = (s) => normalize(String(s ?? '')).replace(/\b(one|won)\b/g, '1').replace(/\b(two|to|too)\b/g, '2').replace(/\b(three)\b/g, '3').replace(/\s+/g, ' ').trim();

export async function resolveAnchor(gaz, anchor, near, forceId = null, units = []) {
  if (!anchor) return { best: null, candidates: [] };
  // Another team as the reference point ("approaching Alpha 1")
  for (const u of units) {
    const k = unitKey(u.name);
    if ([anchor.name, anchor.text].some((t) => t && (unitKey(t) === k || unitKey(t).startsWith(k + ' ')))) {
      const f = { id: `unit:${u.name}`, kind: 'unit', category: 'unit', name: u.name, names: [u.name], lat: u.lat, lon: u.lon };
      return { best: { feature: f, nameScore: 1, distM: Math.round(gaz.distanceTo(f, near)), score: 1, via: 'unit' }, candidates: [] };
    }
  }
  if (forceId) {
    const f = gaz.features.find((x) => x.id === forceId) ?? [...gaz.nominatimCache.values()].flat().find((x) => x.id === forceId);
    if (f) return { best: { feature: f, nameScore: 1, distM: Math.round(gaz.distanceTo(f, near)), score: 1, via: 'operator' }, candidates: [] };
  }
  const query = anchor.name || anchor.text;
  const kind = anchor.kind === 'street' || anchor.category === 'street' ? 'street' : null;
  let cands = gaz.search({ query, category: anchor.category, near, kind });
  // Try the raw spoken text too if the LLM's "name" didn't match.
  if ((!cands.length || cands[0].score < 0.6) && anchor.name && anchor.text && anchor.text !== anchor.name) {
    const alt = gaz.search({ query: anchor.text, category: anchor.category, near, kind });
    cands = [...cands, ...alt].sort((a, b) => b.score - a.score);
  }
  if (!cands.length || cands[0].score < 0.55) {
    const nom = await gaz.nominatim(query);
    for (const f of nom) {
      if (kind === 'street' && f.kind !== 'street') continue;
      const d = gaz.distanceTo(f, near);
      cands.push({ feature: f, nameScore: 0.7, distM: Math.round(d), score: 0.7 - 0.15 * Math.min(d / 1500, 1), via: 'nominatim' });
    }
    cands.sort((a, b) => b.score - a.score);
  }
  // De-duplicate by id
  const seen = new Set();
  cands = cands.filter((c) => (seen.has(c.feature.id) ? false : seen.add(c.feature.id)));
  return { best: cands[0] ?? null, candidates: cands.slice(0, 4) };
}

function anchorPoint(gaz, f, prev) {
  if (f.kind === 'street' && f.lines && prev) {
    const np = gaz.nearestPointOnStreet(f, prev);
    return { lat: np.lat, lon: np.lon };
  }
  return { lat: f.lat, lon: f.lon };
}

function streetIntersection(f1, f2, near) {
  const a = turf.multiLineString(f1.lines);
  const b = turf.multiLineString(f2.lines);
  const hits = turf.lineIntersect(a, b).features.map(ll);
  if (hits.length) {
    hits.sort((p, q) => dist(p, near) - dist(q, near));
    return { point: hits[0], exact: true };
  }
  // Near-miss (OSM ways often stop short of each other): closest approach between the two streets.
  let best = null;
  for (const line of f1.lines) for (const [lon, lat] of line) {
    const np = turf.nearestPointOnLine(b, turf.point([lon, lat]), { units: 'meters' });
    const d = np.properties.pointDistance ?? np.properties.dist;
    if (!best || d < best.d) best = { d, p: turf.midpoint(turf.point([lon, lat]), np) };
  }
  if (best && best.d < 60) return { point: ll(best.p), exact: false };
  return null;
}

/**
 * @returns {Promise<{status, lat?, lon?, accuracyM?, method, explanation, anchor?, anchor2?, target?, candidates, confidence}>}
 */
export async function resolve(gaz, intent, prev, aoCenter, { forceAnchorId = null, units = [] } = {}) {
  const near = prev ?? aoCenter;
  const base = { candidates: [], confidence: intent.confidence ?? 0.5 };

  if (intent.type === 'status') return { ...base, status: 'no_move', method: 'status', explanation: 'Status report – position unchanged' };
  if (intent.type === 'unknown' && !intent.anchor && !intent.bearing) return { ...base, status: 'unresolved', method: 'none', explanation: 'Could not understand a position or movement' };

  if (intent.relation === 'direction_only') {
    if (!prev) return { ...base, status: 'unresolved', method: 'direction_only', explanation: 'Relative movement but no previous position for this unit' };
    const m = intent.distance_m ?? config.moveStepM;
    const p = dest(prev, m, BEARING_DEG[intent.bearing] ?? 0);
    return { ...base, status: 'resolved', ...p, accuracyM: Math.max(30, m * 0.3), method: 'dead_reckoning', explanation: `${m} m ${intent.bearing} of previous position` };
  }

  const r1 = await resolveAnchor(gaz, intent.anchor, near, forceAnchorId, units);
  const r2 = intent.anchor2 ? await resolveAnchor(gaz, intent.anchor2, near, null, units) : { best: null, candidates: [] };
  const candidates = r1.candidates.map((c) => ({ ...featureSummary(c.feature), score: +c.score.toFixed(2), distM: c.distM, via: c.via ?? 'gazetteer' }));
  if (!r1.best) {
    return { ...base, candidates, status: 'unresolved', method: 'anchor_not_found', explanation: `No place matching “${intent.anchor?.name || intent.anchor?.text || '?'}” in the area` };
  }
  const f1 = r1.best.feature;
  const a1 = anchorPoint(gaz, f1, near);
  const anchor = { ...featureSummary(f1), point: a1 };
  let confidence = Math.min(1, (intent.confidence ?? 0.7) * Math.min(1, r1.best.score + 0.15));
  let note = '';
  // Ambiguity: two good candidates far apart
  const second = r1.candidates[1];
  if (second && r1.best.score - second.score < 0.05 && second.feature.id !== f1.id &&
      dist({ lat: f1.lat, lon: f1.lon }, { lat: second.feature.lat, lon: second.feature.lon }) > 150) {
    confidence *= 0.7;
    note = ` (ambiguous with ${second.feature.name})`;
  }

  const out = (p, accuracyM, method, explanation, extra = {}) =>
    ({ ...base, candidates, anchor, status: 'resolved', ...p, accuracyM: Math.round(accuracyM), method, explanation: explanation + note, confidence: +confidence.toFixed(2), ...extra });

  const rel = intent.relation ?? 'at';
  const nm = f1.name;

  if (REL_BEARING[rel]) {
    const m = intent.distance_m ?? config.offsetDefaultM;
    return out(dest(a1, m, BEARING_DEG[REL_BEARING[rel]]), Math.max(30, m * 0.5), 'offset', `${m} m ${REL_BEARING[rel]} of ${nm}`);
  }

  switch (rel) {
    case 'at':
      return out(a1, f1.kind === 'street' ? 40 : 25, intent.type === 'movement' ? 'arrived' : 'at', `${intent.type === 'movement' ? 'Arrived at' : 'At'} ${nm}`);
    case 'near':
      return out(a1, 60, 'near', `Near ${nm}`);
    case 'along':
      return out(a1, prev ? 60 : 150, 'along', `On ${nm}${prev ? ' (closest point to last position)' : ''}`);
    case 'behind': {
      if (!prev) return out(a1, 60, 'behind_no_ref', `Behind ${nm} (no approach direction known)`);
      const b = brg(prev, a1);
      const m = intent.distance_m ?? config.behindOffsetM;
      return out(dest(a1, m, b), 35, 'behind', `Far side of ${nm} as seen from last position (approach from ${cardinal(b + 180)})`);
    }
    case 'in_front_of': {
      if (!prev) return out(a1, 50, 'in_front_no_ref', `In front of ${nm}`);
      return out(dest(a1, intent.distance_m ?? 25, brg(a1, prev)), 35, 'in_front_of', `Near side of ${nm} relative to last position`);
    }
    case 'across_from': {
      if (!prev) return out(a1, 50, 'across_no_ref', `Across from ${nm}`);
      return out(dest(a1, intent.distance_m ?? 35, brg(a1, prev)), 40, 'across_from', `Opposite ${nm}, on the side of last position`);
    }
    case 'intersection': {
      if (!r2.best) return out(a1, 120, 'intersection_partial', `On ${nm} (second street not found)`, { confidence: +(confidence * 0.6).toFixed(2) });
      const f2 = r2.best.feature;
      if (!f1.lines || !f2.lines) return out(ll(turf.midpoint(pt(a1), pt(anchorPoint(gaz, f2, near)))), 80, 'intersection_approx', `Between ${nm} and ${f2.name}`);
      const x = streetIntersection(f1, f2, near);
      if (!x) return out(a1, 150, 'intersection_none', `${nm} and ${f2.name} do not meet – placed on ${nm}`, { confidence: +(confidence * 0.5).toFixed(2), anchor2: featureSummary(f2) });
      return out(x.point, x.exact ? 20 : 40, 'intersection', `Corner of ${nm} and ${f2.name}`, { anchor2: featureSummary(f2) });
    }
    case 'between': {
      if (!r2.best) return out(a1, 100, 'between_partial', `Near ${nm} (second place not found)`);
      const a2 = anchorPoint(gaz, r2.best.feature, near);
      const mid = ll(turf.midpoint(pt(a1), pt(a2)));
      return out(mid, Math.max(40, dist(a1, a2) / 3), 'between', `Between ${nm} and ${r2.best.feature.name}`, { anchor2: featureSummary(r2.best.feature) });
    }
    case 'towards': {
      if (!prev) return out(a1, 200, 'towards_no_ref', `Heading to ${nm} (no previous position – placed at destination)`, { target: a1, confidence: +(confidence * 0.5).toFixed(2) });
      const d = dist(prev, a1);
      const stepWanted = intent.distance_m ?? config.moveStepM;
      if (d <= config.arriveRadiusM || d <= stepWanted) return out(a1, 40, 'towards_arrived', `Reached ${nm}`, { target: a1 });
      const step = stepWanted;
      const p = ll(turf.along(turf.lineString([[prev.lon, prev.lat], [a1.lon, a1.lat]]), step, { units: 'meters' }));
      return out(p, Math.max(40, step * 0.4), 'towards', `Moving ${cardinal(brg(prev, a1))} towards ${nm} (${Math.round(d - step)} m to go)`, { target: a1, heading: Math.round(brg(prev, a1)) });
    }
    case 'away_from': {
      if (!prev) return out(a1, 200, 'away_no_ref', `Moving away from ${nm}`);
      const b = brg(a1, prev);
      return out(dest(prev, intent.distance_m ?? config.moveStepM, b), 60, 'away_from', `Moving ${cardinal(b)}, away from ${nm}`, { heading: Math.round(b) });
    }
    default:
      return out(a1, 60, 'at', `At ${nm}`);
  }
}
