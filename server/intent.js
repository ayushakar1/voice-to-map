// Intent extraction: transcript -> structured position/movement report.
// Featherless or Mistral chat completion in JSON mode, with a rule-based fallback.
import { config } from './config.js';
import { categoryFromWord } from './categories.js';

export const RELATIONS = [
  'at', 'near', 'north_of', 'north_east_of', 'east_of', 'south_east_of', 'south_of', 'south_west_of', 'west_of', 'north_west_of',
  'behind', 'in_front_of', 'across_from', 'along', 'intersection', 'between', 'towards', 'away_from', 'direction_only',
];

const SYSTEM_PROMPT = `You convert short radio-style position reports into JSON for a live map.
Reports may be in English or French and may contain speech-recognition errors.

Return ONLY a JSON object with these keys:
{
  "callsign": string|null,          // unit name if spoken ("Alpha 2 here" -> "Alpha 2"), else null
  "type": "position"|"movement"|"status"|"unknown",
                                     // position = where I am now; movement = I moved/am moving; status = no location change (e.g. "holding", "all clear")
  "relation": one of ${JSON.stringify(RELATIONS)},
                                     // how the unit relates to the anchor. "moved to X" / "arrived at X" -> "at" with type "movement".
                                     // "moving towards X" / "heading to X" -> "towards". "moved 200 m north" (no anchor) -> "direction_only".
  "anchor": {"text": string, "name": string|null, "category": string|null, "kind": "landmark"|"street"} | null,
                                     // text = words as spoken; name = best real place name (prefer an exact name from NEARBY PLACES if it clearly matches);
                                     // category = generic type in English singular (church, street, bridge, park, school, station, square, cafe...)
  "anchor2": same shape | null,      // second street for "corner of A and B" (relation "intersection") or second place for "between"
  "distance_m": number|null,         // explicit distance if spoken ("200 meters", "a block" = 100, "a few metres" = 15)
  "bearing": "N"|"NE"|"E"|"SE"|"S"|"SW"|"W"|"NW"|null,   // for direction_only movement
  "note": string|null,               // anything else operationally relevant (e.g. "under fire", "2 casualties")
  "confidence": number               // 0..1, how sure you are of the parse
}
Rules:
- "behind", "in front of", "across from/opposite" keep that relation; do not convert them to compass directions.
- "the church" without a name: name=null, category="church".
- Numbered streets: write "35th Street" style. French: keep French names ("Rue Saint-Antoine").
- Never invent a place that was not mentioned.`;

const FEWSHOT = [
  ['I am south of the church', { callsign: null, type: 'position', relation: 'south_of', anchor: { text: 'the church', name: null, category: 'church', kind: 'landmark' }, anchor2: null, distance_m: null, bearing: null, note: null, confidence: 0.95 }],
  ['Alpha 2, moved towards thirty fifth street', { callsign: 'Alpha 2', type: 'movement', relation: 'towards', anchor: { text: 'thirty fifth street', name: '35th Street', category: 'street', kind: 'street' }, anchor2: null, distance_m: null, bearing: null, note: null, confidence: 0.9 }],
  ["Bravo, on est au coin de la rue de Rivoli et de la rue du Temple", { callsign: 'Bravo', type: 'position', relation: 'intersection', anchor: { text: 'rue de Rivoli', name: 'Rue de Rivoli', category: 'street', kind: 'street' }, anchor2: { text: 'rue du Temple', name: 'Rue du Temple', category: 'street', kind: 'street' }, distance_m: null, bearing: null, note: null, confidence: 0.9 }],
];

function buildMessages(transcript, ctx) {
  const context = [
    ctx.defaultCallsign ? `Reporting unit (if not spoken): ${ctx.defaultCallsign}` : null,
    ctx.lastPositionText ? `Unit's last known position: ${ctx.lastPositionText}` : 'Unit has no known position yet.',
    ctx.nearbyNames?.length ? `NEARBY PLACES: ${ctx.nearbyNames.join('; ')}` : null,
  ].filter(Boolean).join('\n');
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const [u, a] of FEWSHOT) {
    msgs.push({ role: 'user', content: `REPORT: ${u}` });
    msgs.push({ role: 'assistant', content: JSON.stringify(a) });
  }
  msgs.push({ role: 'user', content: `${context}\nREPORT: ${transcript}` });
  return msgs;
}

function sanitize(o) {
  const out = {
    callsign: typeof o.callsign === 'string' && o.callsign.trim() ? o.callsign.trim() : null,
    type: ['position', 'movement', 'status', 'unknown'].includes(o.type) ? o.type : 'unknown',
    relation: RELATIONS.includes(o.relation) ? o.relation : (o.anchor ? 'at' : null),
    anchor: o.anchor && (o.anchor.text || o.anchor.name || o.anchor.category) ? o.anchor : null,
    anchor2: o.anchor2 && (o.anchor2.text || o.anchor2.name) ? o.anchor2 : null,
    distance_m: Number.isFinite(Number(o.distance_m)) && o.distance_m !== null ? Number(o.distance_m) : null,
    bearing: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].includes(o.bearing) ? o.bearing : null,
    note: o.note ?? null,
    confidence: Math.max(0, Math.min(1, Number(o.confidence ?? 0.5))),
  };
  for (const a of [out.anchor, out.anchor2]) {
    if (!a) continue;
    a.category = categoryFromWord(a.category) ?? categoryFromWord(a.text) ?? null;
    if (!a.kind) a.kind = a.category === 'street' ? 'street' : 'landmark';
  }
  return out;
}

export async function extractIntent(transcript, ctx = {}) {
  if (config.llmKey) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${config.llmBase.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llmKey}` },
        body: JSON.stringify({
          model: config.llmModel,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: 'json_object' },
          messages: buildMessages(transcript, ctx),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${config.llmProvider} ${res.status}: ${(await res.text()).replaceAll(config.llmKey, '[redacted]').slice(0, 200)}`);
      const j = await res.json();
      const parsed = JSON.parse(j.choices[0].message.content);
      return { intent: sanitize(parsed), engine: `${config.llmProvider}:${config.llmModel}`, ms: Date.now() - t0 };
    } catch (e) {
      console.warn(`[intent] LLM failed, using rule parser: ${e.message}`);
      const t0 = Date.now();
      return { intent: ruleParse(transcript), engine: 'rules (LLM error)', ms: Date.now() - t0, error: e.message };
    }
  }
  const t0 = Date.now();
  return { intent: ruleParse(transcript), engine: 'rules', ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------------------------
// Rule-based fallback. Deliberately simple: covers the demo phrasings in EN + FR.

const BEARING_WORDS = {
  N: ['north', 'nord'], NE: ['north east', 'northeast', 'nord est'], E: ['east', 'est'], SE: ['south east', 'southeast', 'sud est'],
  S: ['south', 'sud'], SW: ['south west', 'southwest', 'sud ouest'], W: ['west', 'ouest'], NW: ['north west', 'northwest', 'nord ouest'],
};
const BEARING_REL = { N: 'north_of', NE: 'north_east_of', E: 'east_of', SE: 'south_east_of', S: 'south_of', SW: 'south_west_of', W: 'west_of', NW: 'north_west_of' };

function bearingFrom(text) {
  for (const b of ['NE', 'SE', 'SW', 'NW', 'N', 'S', 'E', 'W']) {
    for (const w of BEARING_WORDS[b]) if (new RegExp(`\\b${w}\\b`).test(text)) return b;
  }
  return null;
}

function anchorFrom(text) {
  let t = text.split(/[,;]/)[0].trim().replace(/^(the|a|an|la|le|les|l|de la|du|des|de)\s+/i, '').replace(/[.,!?]+$/, '').trim();
  t = t.replace(/\s+(now|right now|over|out|maintenant)$/i, '').trim();
  if (!t) return null;
  const category = categoryFromWord(t);
  const kind = category === 'street' ? 'street' : 'landmark';
  return { text: t, name: null, category, kind };
}

function distanceFrom(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(m|meters?|metres?|mètres?|km|kilometers?|kilometres?|yards?|blocks?)\b/i);
  if (!m) {
    if (/\ba (city )?block\b/i.test(text)) return 100;
    return null;
  }
  const v = Number(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  if (u.startsWith('k')) return v * 1000;
  if (u.startsWith('y')) return v * 0.9144;
  if (u.startsWith('b')) return v * 100;
  return v;
}

const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six_: 6, dix: 10,
  vingt: 20, trente: 30, quarante: 40, cinquante: 50 };
/** "two hundred meters" -> "200 meters", "cent metres" -> "100 metres" (only before a distance unit) */
function spokenNumbers(t) {
  return t.replace(/\b((?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|un|deux|trois|quatre|cinq|dix|vingt|trente|quarante|cinquante|hundred|cents?|and|et)\s+)+)(m|meters?|metres?|km|yards?|blocks?)\b/g, (all, words, unit) => {
    let total = 0, cur = 0, any = false;
    for (const w of words.trim().split(/\s+/)) {
      if (w === 'and' || w === 'et') continue;
      if (w === 'a') { cur = cur || 1; any = true; continue; }
      if (w === 'hundred' || w === 'cent' || w === 'cents') { cur = (cur || 1) * 100; any = true; continue; }
      if (NUMW[w] !== undefined) { cur += NUMW[w]; any = true; }
    }
    total += cur;
    return any ? `${total} ${unit}` : all;
  });
}
const bearingOnly = (s) => /^(?:the\s+|le\s+|l\s+)?(north|south|east|west|nord|sud|est|ouest)(\s*(east|west|est|ouest))?$/.test(s.trim());

export function ruleParse(raw) {
  const original = raw.trim();
  let t = original.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, ' ').replace(/-/g, ' ');
  t = spokenNumbers(t);
  const out = { callsign: null, type: 'unknown', relation: null, anchor: null, anchor2: null, distance_m: null, bearing: null, note: null, confidence: 0.5 };

  // Callsign: "Alpha 2 here", "this is Bravo one", "Alpha two, ..."
  const cs = original.match(/^\s*(?:this is\s+)?((?:alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|x-?ray|yankee|zulu|team\s+\w+|unit\s+\w+)(?:[\s-]+(?:\d+|one|two|three|four|five|six|seven|eight|nine|un|deux|trois))?)\b(?:\s+here|\s+ici)?[\s,:.-]*/i);
  if (cs) {
    out.callsign = cs[1].replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bOne\b/, '1').replace(/\bTwo\b/, '2').replace(/\bThree\b/, '3');
    t = t.slice(cs[0].length);
  }

  if (/\b(holding|hold position|stationary|no change|all clear|en position|on tient|statu quo)\b/.test(t)) {
    out.type = 'status'; out.note = original; out.confidence = 0.7; return out;
  }

  const isMove = /\b(moved?|moving|heading|going|advancing|proceeding|walking|running|driving|crossing|arrived|reached|je me deplace|on se deplace|on avance|j avance|en route|direction|vers|arriv\w*|parti)\b/.test(t);
  out.type = isMove ? 'movement' : 'position';
  out.distance_m = distanceFrom(t);

  // Intersection: "corner of A and B", "intersection of A and B", "au coin de A et B"
  let m = t.match(/\b(?:corner of|intersection of|junction of|au coin de|a l angle de|au croisement de|carrefour)\s+(.+?)\s+(?:and|et|&)\s+(.+)$/);
  if (m) {
    out.relation = 'intersection';
    out.anchor = { ...anchorFrom(m[1]), kind: 'street', category: 'street' };
    out.anchor2 = { ...anchorFrom(m[2]), kind: 'street', category: 'street' };
    out.confidence = 0.75; return out;
  }
  m = t.match(/\b(?:between|entre)\s+(.+?)\s+(?:and|et)\s+(.+)$/);
  if (m) { out.relation = 'between'; out.anchor = anchorFrom(m[1]); out.anchor2 = anchorFrom(m[2]); out.confidence = 0.7; return out; }

  const patterns = [
    [/\b(?:towards?|toward|heading (?:to|for)|en direction de|direction|vers)\s+(.+)$/, 'towards'],
    [/\b(?:away from|loin de|s eloigne de)\s+(.+)$/, 'away_from'],
    [/\b(?:behind|derriere)\s+(.+)$/, 'behind'],
    [/\b(?:in front of|devant|en face de l entree de)\s+(.+)$/, 'in_front_of'],
    [/\b(?:across from|opposite|across the street from|en face de|en face du)\s+(.+)$/, 'across_from'],
    [/\b(?:along|on|down|up|le long de|sur)\s+((?:the\s+)?(?:\d+\w*\s+)?(?:\w+\s+){0,3}(?:street|avenue|road|boulevard|lane|quai|rue)\b.*)$/, 'along'],
    [/\b(?:north|south|east|west|northeast|northwest|southeast|southwest|north east|north west|south east|south west|nord|sud|est|ouest)(?:\s+(?:est|ouest))?\s+(?:of|de|du|de la)\s+(.+)$/, 'compass'],
    [/\b(?:near|next to|close to|by|beside|pres de|a cote de|proche de)\s+(.+)$/, 'near'],
    [/\b(?:arrived at|reached|at|in|inside|au|a la|a l|dans|sur la|sur le)\s+(.+)$/, 'at'],
    [/\b(?:moved to|moving to|going to|went to|to)\s+(.+)$/, 'at'],
  ];
  for (const [re, rel] of patterns) {
    m = t.match(re);
    if (!m) continue;
    const anchor = anchorFrom(m[1]);
    if (!anchor) continue;
    if (bearingOnly(anchor.text)) break; // "vers le nord" = pure direction, handled below
    if (rel === 'compass') {
      const b = bearingFrom(m[0].slice(0, m[0].length - m[1].length));
      out.relation = BEARING_REL[b] ?? 'near';
    } else out.relation = rel;
    out.anchor = anchor;
    out.confidence = 0.7;
    return out;
  }

  // Pure direction: "moved 200 meters north"
  const b = bearingFrom(t);
  if (b && isMove) {
    out.relation = 'direction_only'; out.bearing = b; out.distance_m ??= config.moveStepM; out.confidence = 0.6; return out;
  }
  out.type = 'unknown'; out.confidence = 0.1;
  return out;
}
