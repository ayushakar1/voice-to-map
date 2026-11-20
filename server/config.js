// Central config. Reads .env (if present) without extra dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadDotEnv();

const env = (k, d) => (process.env[k] ?? '').trim() !== '' ? process.env[k].trim() : d;

// Areas of operation. bbox = [south, west, north, east]
export const AO_PRESETS = {
  'paris-marais': {
    label: 'Paris – Le Marais / Saint-Paul',
    bbox: [48.8500, 2.3500, 48.8620, 2.3680],
    lang: 'fr',
  },
  'paris-latin': {
    label: 'Paris – Quartier Latin',
    bbox: [48.8440, 2.3380, 48.8550, 2.3560],
    lang: 'fr',
  },
  'nyc-midtown': {
    label: 'New York – Midtown (has 35th St)',
    bbox: [40.7440, -73.9950, 40.7560, -73.9780],
    lang: 'en',
  },
};

export const config = {
  port: Number(env('PORT', 3000)),
  mistralKey: env('MISTRAL_API_KEY', ''),
  mistralBase: env('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1'),
  llmModel: env('LLM_MODEL', env('MISTRAL_LLM_MODEL', 'mistral-small-latest')),
  // Intent LLM can live on any OpenAI-compatible provider (e.g. Featherless). Defaults to Mistral.
  llmBase: env('LLM_BASE_URL', env('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1')),
  llmKey: env('LLM_API_KEY', env('MISTRAL_API_KEY', '')),
  llmJsonMode: env('LLM_JSON_MODE', 'true') !== 'false',
  llmNearbyNames: Number(env('LLM_NEARBY_NAMES', 80)), // place names sent in the prompt; lower for small-context models
  sttModel: env('MISTRAL_STT_MODEL', 'voxtral-mini-latest'),
  overpassUrl: env('OVERPASS_URL', 'https://overpass-api.de/api/interpreter'),
  nominatimUrl: env('NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
  userAgent: env('HTTP_USER_AGENT', 'voice-to-map-edth-hackathon/0.1 (contact: change-me@example.com)'),
  aoPreset: env('AO_PRESET', 'paris-marais'),
  aoBbox: env('AO_BBOX', ''), // "south,west,north,east" overrides preset
  // Spatial heuristics (metres)
  offsetDefaultM: Number(env('OFFSET_DEFAULT_M', 60)),   // "south of the church"
  behindOffsetM: Number(env('BEHIND_OFFSET_M', 40)),     // "behind the church"
  moveStepM: Number(env('MOVE_STEP_M', 150)),            // "moved towards X" without arrival
  arriveRadiusM: Number(env('ARRIVE_RADIUS_M', 120)),    // closer than this => treat as arrived
  dataDir: path.join(ROOT, 'data'),
};

export function currentAO() {
  if (config.aoBbox) {
    const b = config.aoBbox.split(',').map(Number);
    if (b.length === 4 && b.every(Number.isFinite)) return { id: 'custom', label: 'Custom AO', bbox: b, lang: 'en' };
  }
  const p = AO_PRESETS[config.aoPreset] ?? AO_PRESETS['paris-marais'];
  return { id: config.aoPreset, ...p };
}
