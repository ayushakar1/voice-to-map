# Voice-to-Map

Spoken position reports → live shared map. EDTH Paris 2026 · Lysk challenge.

> "Alpha 2, I moved towards 35th street" → transcribed → `movement / towards / 35th Street` →
> street geocoded from OSM → marker steps toward the nearest point of 35th St, dashed line shows
> the intended destination, timestamped in a replayable history. Every connected screen updates over WebSocket.

## Quick start

```bash
npm install
cp .env.example .env        # add MISTRAL_API_KEY (works without one, in a reduced mode)
npm start                   # http://localhost:3000
```

Open it in **Chrome or Edge**, hold the button (or Space), speak, release.

| Mode | Needs | What you get |
|---|---|---|
| No key | nothing | Browser speech recognition + rule-based parser. Good for UI work. |
| `MISTRAL_API_KEY` | key | Mistral LLM intent extraction + Voxtral STT option. **Demo mode.** |
| Offline | `GAZETTEER_FILE=test/fixtures/synthetic-gazetteer.json` | No OSM calls; tests and dry-runs without Wi-Fi. |

**Intent on Featherless (or any OpenAI-compatible host):** set `LLM_BASE_URL=https://api.featherless.ai/v1`,
`LLM_API_KEY`, and `LLM_MODEL` to a Mistral model id from their catalogue. Speech-to-text still needs either
`MISTRAL_API_KEY` (Voxtral) or browser speech. If the provider rejects JSON mode, the app retries without it
and extracts the JSON from the reply.

Other commands:

```bash
npm test                          # resolver + parser unit tests (offline)
npm run demo -- paris-marais 2500 # replays a scripted scenario into a running server (no mic)
npm run eval                      # intent accuracy + latency on test/fixtures/eval-set.json
```

**Phones / other laptops on the venue Wi-Fi:** the microphone only works on `https://` or `localhost`.
Expose the server with a tunnel: `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`)
and open the https URL on each device.

## Pipeline

```
PTT ──► STT ───────────► Intent (Mistral JSON) ──► Resolver ──────────────► Event log ──► WebSocket ──► all maps
        Web Speech        type/relation/anchor      AO gazetteer (Overpass,     events.json   snapshot +
        or Voxtral        callsign/distance         preloaded, fuzzy match)     replayable    live events
        (context-biased                             + turf.js geometry
         with AO names)                             + Nominatim fallback
```

| File | Role |
|---|---|
| `server/stt.js` | Voxtral `POST /v1/audio/transcriptions`, biased with place names from the AO |
| `server/intent.js` | Mistral chat completion in JSON mode (schema + few-shot, EN/FR). `ruleParse()` fallback |
| `server/gazetteer.js` | Preloads every named POI + street in the AO from Overpass once, caches to `data/`, fuzzy search with distance bias |
| `server/categories.js` | Spoken generic words (church/église, bridge/pont…) ↔ OSM tags |
| `server/resolver.js` | Relation → coordinates: offsets, behind/in-front relative to approach direction, street intersections, towards/away, dead reckoning |
| `server/pipeline.js` | Glues it together, measures latency per stage, operator corrections |
| `server/store.js` | Event log; unit state is derived from it, so replay is just "events up to T" |
| `public/app.js` | Leaflet map, push-to-talk, timeline, replay slider, click-to-correct, ambiguity picker |

### Spatial rules (resolver.js)

| Spoken | Placement |
|---|---|
| at / arrived at X | X (streets: nearest point to last position) |
| north/south/… of X | X offset by spoken distance, default 60 m |
| behind X | Far side of X along the line *last position → X* (40 m past) |
| in front of / across from X | Near side of X, towards last position |
| on X street | Nearest point on the street to last position |
| corner of A and B | Exact intersection of the two OSM ways (nearest one); near-miss tolerant |
| between A and B | Midpoint |
| towards X | One step (150 m, or spoken distance) along the line to X; arrives if < 120 m. Dashed line shows destination |
| away from X | One step from last position, directly away from X |
| moved 200 m north | Dead reckoning from last position |
| holding / all clear | Logged, no move |

Every placement carries an accuracy radius (drawn as a circle) and a confidence; generic references
("the church") pick the nearest match to the unit's last position and flag ambiguity when two candidates are
close in score but far apart. The operator can switch candidate or click the map to fix any report.

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/state` | – |
| POST | `/api/report` | `{ text, unit }` |
| POST | `/api/voice` | multipart `audio`, `unit`, `lang` |
| POST | `/api/events/:id/correct` | `{ lat, lon }` |
| POST | `/api/events/:id/choose` | `{ candidateId }` |
| POST | `/api/ao` | `{ preset }` or `{ bbox: [s,w,n,e] }` |
| DELETE | `/api/events` | – |
| GET | `/api/gazetteer/search?q=` | debug |
| WS | `/ws` | server → `snapshot`, `event`, `event_updated`, `speaking` |

## Known limits / next steps

- Web Speech API sends audio to the browser vendor's cloud and only works in Chrome/Edge. Voxtral is the path to keep for the demo.
- Voxtral is used in batch mode (upload on release). Streaming (`/audio/transcriptions#stream` or Voxtral Realtime) would cut ~0.5 s.
- `context_bias` field encoding for Voxtral is sent as repeated multipart fields; if the API rejects it, the call is retried without bias (check server log).
- Overpass is slow (5–30 s) on first load per AO; it is cached to `data/` afterwards. Preload your demo AO before the pitch.
- Correcting an old report does not re-compute later reports that were placed relative to it.
