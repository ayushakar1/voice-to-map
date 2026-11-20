// transcript -> intent -> resolved position -> event
import crypto from 'node:crypto';
import { extractIntent } from './intent.js';
import { resolve } from './resolver.js';
import { gazetteer } from './gazetteer.js';
import { store } from './store.js';

const NUM = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', zero: '0', un: '1', deux: '2', trois: '3' };
export function normalizeCallsign(s) {
  if (!s) return null;
  return s.trim().replace(/[-_]+/g, ' ').split(/\s+/)
    .map((w) => NUM[w.toLowerCase()] ?? (w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

/** Spoken "Bravo" from a client set to "Bravo 2" is the same unit; spoken "Bravo 1" is not. */
export function matchCallsign(spoken, defaultUnit) {
  if (!spoken) return defaultUnit;
  if (spoken === defaultUnit) return spoken;
  if (defaultUnit.toLowerCase().startsWith(spoken.toLowerCase() + ' ')) return defaultUnit;
  const known = [...new Set(store.events.map((e) => e.unit))];
  const prefixed = known.filter((u) => u.toLowerCase().startsWith(spoken.toLowerCase() + ' '));
  return prefixed.length === 1 ? prefixed[0] : spoken;
}

export function aoCenter() {
  const [s, w, n, e] = gazetteer.ao.bbox;
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

export async function processReport({ transcript, unit, source = 'text', stt = null, receivedAt = Date.now() }) {
  const t0 = Date.now();
  const defaultUnit = normalizeCallsign(unit) || 'Unit 1';
  const prevForPrompt = store.lastPosition(defaultUnit);
  const ctx = {
    defaultCallsign: defaultUnit,
    lastPositionText: prevForPrompt?.label ?? null,
    nearbyNames: gazetteer.namesNear(prevForPrompt ?? aoCenter(), 80),
  };
  const { intent, engine, ms: llmMs, error: llmError } = await extractIntent(transcript, ctx);
  const callsign = matchCallsign(normalizeCallsign(intent.callsign), defaultUnit);
  const prev = store.lastPosition(callsign);

  const g0 = Date.now();
  const result = await resolve(gazetteer, intent, prev, aoCenter());
  const geoMs = Date.now() - g0;

  const position = result.status === 'resolved' ? { lat: result.lat, lon: result.lon, accuracyM: result.accuracyM } : null;
  const event = {
    id: crypto.randomUUID(),
    ts: receivedAt,
    unit: callsign,
    source,
    transcript,
    stt,
    intent,
    intentEngine: engine,
    llmError: llmError ?? null,
    result,
    position,
    prevPosition: prev ? { lat: prev.lat, lon: prev.lon } : null,
    latency: { sttMs: stt?.ms ?? null, llmMs, geoMs, serverMs: Date.now() - t0 + (stt?.ms ?? 0) },
  };
  return store.add(event);
}

/** Operator correction: click on the map to fix (or place) a report. */
export function correctEvent(id, { lat, lon }) {
  const e = store.get(id);
  if (!e) return null;
  return store.update(id, {
    position: { lat, lon, accuracyM: 10 },
    corrected: { at: Date.now(), from: e.position },
    result: { ...e.result, status: 'resolved', method: 'manual', explanation: `Manually placed by operator${e.result?.explanation ? ` (was: ${e.result.explanation})` : ''}` },
  });
}

/** Operator picks a different candidate for the anchor (ambiguous "the church"): re-run spatial resolution. */
export async function chooseCandidate(id, candidateId) {
  const e = store.get(id);
  if (!e) return null;
  const candidates = e.result?.candidates ?? [];
  const prev = e.prevPosition;
  const result = await resolve(gazetteer, e.intent, prev, aoCenter(), { forceAnchorId: candidateId });
  result.candidates = candidates; // keep the original list so the operator can switch again
  const position = result.status === 'resolved' ? { lat: result.lat, lon: result.lon, accuracyM: result.accuracyM } : e.position;
  return store.update(id, { result, position, corrected: { at: Date.now(), from: e.position, candidateId } });
}
