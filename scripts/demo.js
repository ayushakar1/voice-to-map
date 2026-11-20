// Replays a scripted scenario against a running server (no microphone needed).
// Usage: node scripts/demo.js [scenario] [delayMs] [baseUrl]
//   scenario: paris-marais (default) | nyc-midtown | path/to/file.json
import fs from 'node:fs';
const [scenario = 'paris-marais', delay = '2500', base = 'http://localhost:3000'] = process.argv.slice(2);
const file = scenario.endsWith('.json') ? scenario : new URL(`./scenarios/${scenario}.json`, import.meta.url);
const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const s of steps) {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: s.text, unit: s.unit }) });
  const e = await res.json();
  const r = e.result ?? {};
  console.log(`${String(Date.now() - t0).padStart(5)} ms  ${e.unit?.padEnd(8)} "${s.text}"\n         -> ${e.intent?.type}/${e.intent?.relation} · ${r.status} · ${r.explanation ?? e.error}`);
  await new Promise((r) => setTimeout(r, Number(delay)));
}
