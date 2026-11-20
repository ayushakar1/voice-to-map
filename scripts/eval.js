// Intent-extraction eval: runs every utterance in test/fixtures/eval-set.json through extractIntent
// (Featherless or Mistral when configured, else the rule parser) and scores each expected field.
// Usage: node scripts/eval.js [path/to/eval-set.json]
import fs from 'node:fs';
import { extractIntent } from '../server/intent.js';
import { normalizeCallsign } from '../server/pipeline.js';
import { normalize } from '../server/text.js';

const file = process.argv[2] ?? new URL('../test/fixtures/eval-set.json', import.meta.url);
const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
const field = {}; const lat = []; let allOk = 0; let engine = '';

for (const c of cases) {
  const { intent, ms, engine: eng } = await extractIntent(c.text, {});
  engine = eng; lat.push(ms);
  const misses = [];
  for (const [k, want] of Object.entries(c.expect)) {
    let got, ok;
    if (k === 'category') { got = intent.anchor?.category; ok = got === want; }
    else if (k === 'anchor' || k === 'anchor2') { const a = intent[k]; got = `${a?.name ?? ''}|${a?.text ?? ''}`; ok = normalize(got).includes(normalize(want)); }
    else if (k === 'callsign') { got = normalizeCallsign(intent.callsign); ok = got === want; }
    else if (k === 'note') { got = intent.note; ok = !!got === want; }
    else if (k === 'distance_m') { got = intent.distance_m; ok = got !== null && Math.abs(got - want) <= want * 0.2; }
    else { got = intent[k]; ok = got === want; }
    field[k] ??= { ok: 0, n: 0 }; field[k].n++; if (ok) field[k].ok++;
    if (!ok) misses.push(`${k}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  }
  if (!misses.length) allOk++;
  console.log(`${misses.length ? '✗' : '✓'} ${String(ms).padStart(5)} ms  ${c.text}${misses.length ? '\n      ' + misses.join('\n      ') : ''}`);
}
lat.sort((a, b) => a - b);
console.log(`\nEngine: ${engine}`);
console.log(`Fully correct: ${allOk}/${cases.length} (${Math.round((100 * allOk) / cases.length)}%)`);
for (const [k, v] of Object.entries(field)) console.log(`  ${k.padEnd(12)} ${v.ok}/${v.n}`);
console.log(`Latency p50 ${lat[Math.floor(lat.length / 2)]} ms · p95 ${lat[Math.floor(lat.length * 0.95)]} ms`);
