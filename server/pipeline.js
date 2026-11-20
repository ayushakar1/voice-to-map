// transcript -> intent -> resolved position -> event
import crypto from "node:crypto";
import { extractIntent } from "./intent.js";
import { resolve } from "./resolver.js";
import { gazetteer } from "./gazetteer.js";
import { store } from "./store.js";
import { config } from "./config.js";

const NUM = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  zero: "0",
  un: "1",
  deux: "2",
  trois: "3",
};
export function normalizeCallsign(s) {
  if (!s) return null;
  return s
    .trim()
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .map(
      (w) =>
        NUM[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");
}

/** Spoken "Bravo" from a client set to "Bravo 2" is the same unit; spoken "Bravo 1" is not. */
export function matchCallsign(spoken, defaultUnit) {
  if (!spoken) return defaultUnit;
  if (spoken === defaultUnit) return spoken;
  if (defaultUnit.toLowerCase().startsWith(spoken.toLowerCase() + " "))
    return defaultUnit;
  const known = [...new Set(store.events.map((e) => e.unit))];
  const prefixed = known.filter((u) =>
    u.toLowerCase().startsWith(spoken.toLowerCase() + " "),
  );
  return prefixed.length === 1 ? prefixed[0] : spoken;
}

export function aoCenter() {
  const [s, w, n, e] = gazetteer.ao.bbox;
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

const NUM_SOUNDS = {
  1: ["1", "one", "won", "wan", "un"],
  2: ["2", "two", "to", "too", "tu", "deux"],
  3: ["3", "three", "tree", "free", "trois"],
  4: ["4", "four", "for", "fore", "quatre"],
  5: ["5", "five", "fife", "cinq"],
  6: ["6", "six", "sicks"],
  7: ["7", "seven"],
  8: ["8", "eight", "ate", "huit"],
  9: ["9", "nine", "niner", "neuf"],
};
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
};

/**
 * Speech recognisers mangle callsigns ("brows to" / "Broward to" for "Bravo 2").
 * If the report starts with something that sounds like a KNOWN unit, rewrite it to the real callsign.
 */
export function repairCallsign(transcript, knownUnits) {
  const m = transcript.match(
    /^\s*(?:this is\s+)?([A-Za-zÀ-ÿ]+)[\s,-]+([A-Za-z0-9]+)\b[\s,.:]*/i,
  );
  if (!m) return transcript;
  const [w0, w1] = [m[1].toLowerCase(), m[2].toLowerCase()];
  for (const u of knownUnits) {
    const p = u.match(/^([A-Za-z]+)\s+(\d)$/);
    if (!p) continue;
    const word = p[1].toLowerCase();
    if (w0 === word) continue; // already correct, let the parser handle it
    const sounds = NUM_SOUNDS[p[2]] ?? [];
    if (
      w0.slice(0, 2) === word.slice(0, 2) &&
      lev(w0, word) <= 4 &&
      sounds.includes(w1)
    ) {
      return `${u}, ${transcript.slice(m[0].length)}`;
    }
  }
  return transcript;
}

/** Other units' last positions, so "approaching Alpha 1" can resolve to a unit instead of a landmark. */
function otherUnits(self) {
  return [...new Set(store.events.map((e) => e.unit))]
    .filter((u) => u !== self)
    .map((u) => ({ unit: u, pos: store.lastPosition(u) }))
    .filter((x) => x.pos)
    .map((x) => ({ name: x.unit, lat: x.pos.lat, lon: x.pos.lon }));
}

// ---------------------------------------------------------------------------------------------
// Per-unit ordering (Fix 1).
// A report is interpreted relative to the unit's previous position, so two reports from the same
// unit must not run at the same time: the second has to see the first one's result.
// Different units still run fully in parallel.

/** unit key -> tail of that unit's promise chain */
const unitChains = new Map();

/**
 * Public entry point. Queues the report behind any earlier report from the same unit.
 * The caller still gets the real result (or the real error) of its own report.
 */
export function processReport(args) {
  const key = normalizeCallsign(args.unit) || "Unit 1";
  const previous = unitChains.get(key) ?? Promise.resolve();

  // Run after the previous report has finished (whether it succeeded or failed).
  const run = previous.then(() => doProcessReport(args));

  // The stored tail swallows errors so one failed report can never block the ones behind it.
  const tail = run.catch(() => {});
  unitChains.set(key, tail);

  // Clean up when the queue for this unit is empty, so the map does not grow forever.
  tail.then(() => {
    if (unitChains.get(key) === tail) unitChains.delete(key);
  });

  return run;
}

async function doProcessReport({
  transcript: rawTranscript,
  unit,
  source = "text",
  stt = null,
  receivedAt = Date.now(),
}) {
  const t0 = Date.now();
  const defaultUnit = normalizeCallsign(unit) || "Unit 1";
  const knownUnits = [
    ...new Set([defaultUnit, ...store.events.map((e) => e.unit)]),
  ];
  const transcript = repairCallsign(rawTranscript, knownUnits);
  const prevForPrompt = store.lastPosition(defaultUnit);
  const ctx = {
    defaultCallsign: defaultUnit,
    knownUnits,
    lastPositionText: prevForPrompt?.label ?? null,
    nearbyNames: gazetteer.namesNear(
      prevForPrompt ?? aoCenter(),
      config.llmNearbyNames,
    ),
  };
  const {
    intent,
    engine,
    ms: llmMs,
    error: llmError,
  } = await extractIntent(transcript, ctx);
  const callsign = matchCallsign(
    normalizeCallsign(intent.callsign),
    defaultUnit,
  );
  const prev = store.lastPosition(callsign, receivedAt);  // adding the received time for the files processed

  const g0 = Date.now();
  const result = await resolve(gazetteer, intent, prev, aoCenter(), {
    units: otherUnits(callsign),
  });
  const geoMs = Date.now() - g0;

  const position =
    result.status === "resolved"
      ? { lat: result.lat, lon: result.lon, accuracyM: result.accuracyM }
      : null;
  const event = {
    id: crypto.randomUUID(),
    ts: receivedAt,
    unit: callsign,
    source,
    transcript: rawTranscript,
    interpretedAs: transcript !== rawTranscript ? transcript : undefined,
    stt,
    intent,
    intentEngine: engine,
    llmError: llmError ?? null,
    result,
    position,
    prevPosition: prev ? { lat: prev.lat, lon: prev.lon } : null,
    latency: {
      sttMs: stt?.ms ?? null,
      llmMs,
      geoMs,
      serverMs: Date.now() - t0 + (stt?.ms ?? 0),
    },
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
    result: {
      ...e.result,
      status: "resolved",
      method: "manual",
      explanation: `Manually placed by operator${e.result?.explanation ? ` (was: ${e.result.explanation})` : ""}`,
    },
  });
}

/** Operator picks a different candidate for the anchor (ambiguous "the church"): re-run spatial resolution. */
export async function chooseCandidate(id, candidateId) {
  const e = store.get(id);
  if (!e) return null;
  const candidates = e.result?.candidates ?? [];
  const prev = e.prevPosition;
  const result = await resolve(gazetteer, e.intent, prev, aoCenter(), {
    forceAnchorId: candidateId,
    units: otherUnits(e.unit),
  });
  result.candidates = candidates; // keep the original list so the operator can switch again
  const position =
    result.status === "resolved"
      ? { lat: result.lat, lon: result.lon, accuracyM: result.accuracyM }
      : e.position;
  return store.update(id, {
    result,
    position,
    corrected: { at: Date.now(), from: e.position, candidateId },
  });
}
