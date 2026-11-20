import http from "node:http";
import path from "node:path";
import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";
import { config, currentAO, AO_PRESETS, ROOT } from "./config.js";
import { gazetteer } from "./gazetteer.js";
import { store } from "./store.js";
import { processReport, correctEvent, chooseCandidate } from "./pipeline.js";
import { transcribe } from "./stt.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use(
  "/vendor/leaflet",
  express.static(path.join(ROOT, "node_modules/leaflet/dist")),
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};

/**
 * Convert the client's report "age" (ms since the user finished speaking, measured on the client's
 * own monotonic clock) into a server-side timestamp. Using an age instead of an absolute time means
 * a device with a wrong clock cannot corrupt the history. Clamped to 0–60 s so a buggy client
 * cannot backdate a report by hours or send one from the future.
 */
const MAX_REPORT_AGE_MS = 60_000;
const receivedAtFrom = (ageMs) =>
  Date.now() - Math.min(MAX_REPORT_AGE_MS, Math.max(0, Number(ageMs) || 0));

function snapshot() {
  return {
    type: "snapshot",
    ao: gazetteer.ao,
    aoPresets: Object.fromEntries(
      Object.entries(AO_PRESETS).map(([k, v]) => [k, v.label]),
    ),
    gazetteer: gazetteer.stats(),
    capabilities: {
      llm: !!config.llmKey,
      serverStt: !!config.mistralKey,
      llmModel: config.llmModel,
      sttModel: config.sttModel,
    },
    events: store.events,
    colors: store.colors,
  };
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify(snapshot()));
  ws.on("message", (raw) => {
    // Live "who is talking" indicator: clients relay interim transcripts; nothing is stored.
    try {
      const m = JSON.parse(raw);
      if (m.type === "speaking")
        broadcast({
          type: "speaking",
          unit: String(m.unit ?? "").slice(0, 40),
          partial: String(m.partial ?? "").slice(0, 300),
          done: !!m.done,
        });
    } catch {
      /* ignore */
    }
  });
});

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

app.get("/api/state", (_req, res) => res.json(snapshot()));

// Text report (typed, or transcribed in the browser)
app.post(
  "/api/report",
  wrap(async (req, res) => {
    const { text, unit, source = "text", stt = null, ageMs } = req.body ?? {};
    if (!text?.trim()) return res.status(400).json({ error: "text required" });
    const ev = await processReport({
      transcript: text.trim(),
      unit,
      source,
      stt,
      receivedAt: receivedAtFrom(ageMs),
    });
    broadcast({ type: "event", event: ev });
    res.json(ev);
  }),
);

// Audio report: Voxtral STT + pipeline in one round trip
app.post(
  "/api/voice",
  upload.single("audio"),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "audio required" });
    // Computed on arrival, before the (slow) speech-to-text call, so STT time is not lost.
    const receivedAt = receivedAtFrom(req.body.ageMs);
    const lang =
      req.body.lang && req.body.lang !== "auto" ? req.body.lang : null;
    const bias = [...new Set(gazetteer.features.map((f) => f.name))].slice(
      0,
      100,
    );
    const stt = await transcribe(req.file.buffer, {
      mimetype: req.file.mimetype,
      language: lang,
      bias,
    });
    if (!stt.text)
      return res.status(422).json({ error: "No speech detected", stt });
    const ev = await processReport({
      transcript: stt.text,
      unit: req.body.unit,
      source: "voice",
      stt,
      receivedAt,
    });
    broadcast({ type: "event", event: ev });
    res.json(ev);
  }),
);

app.post("/api/events/:id/correct", (req, res) => {
  const { lat, lon } = req.body ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    return res.status(400).json({ error: "lat/lon required" });
  const ev = correctEvent(req.params.id, { lat, lon });
  if (!ev) return res.status(404).json({ error: "not found" });
  broadcast({ type: "event_updated", event: ev });
  res.json(ev);
});

app.post(
  "/api/events/:id/choose",
  wrap(async (req, res) => {
    const ev = await chooseCandidate(req.params.id, req.body?.candidateId);
    if (!ev) return res.status(404).json({ error: "not found" });
    broadcast({ type: "event_updated", event: ev });
    res.json(ev);
  }),
);

app.delete("/api/events", (_req, res) => {
  store.reset();
  broadcast(snapshot());
  res.json({ ok: true });
});

app.post(
  "/api/ao",
  wrap(async (req, res) => {
    const { preset, bbox, force } = req.body ?? {};
    let ao;
    if (Array.isArray(bbox) && bbox.length === 4)
      ao = {
        id: "custom",
        label: "Custom AO",
        bbox: bbox.map(Number),
        lang: "en",
      };
    else if (AO_PRESETS[preset]) ao = { id: preset, ...AO_PRESETS[preset] };
    else return res.status(400).json({ error: "preset or bbox required" });
    const stats = await gazetteer.load(ao, { force: !!force });
    broadcast(snapshot());
    res.json({ ao, stats });
  }),
);

// Debug helpers
app.get("/api/gazetteer/search", (req, res) => {
  const [s, w, n, e] = gazetteer.ao.bbox;
  const near = req.query.lat
    ? { lat: Number(req.query.lat), lon: Number(req.query.lon) }
    : { lat: (s + n) / 2, lon: (w + e) / 2 };
  const r = gazetteer.search({
    query: req.query.q ?? "",
    category: req.query.category || null,
    near,
    limit: 10,
  });
  res.json(
    r.map((c) => ({
      name: c.feature.name,
      category: c.feature.category,
      kind: c.feature.kind,
      score: +c.score.toFixed(3),
      distM: c.distM,
    })),
  );
});
app.get("/api/gazetteer/landmarks", (_req, res) => {
  res.json(
    gazetteer.features
      .filter((f) => f.kind === "landmark")
      .map(({ id, name, category, lat, lon }) => ({
        id,
        name,
        category,
        lat,
        lon,
      })),
  );
});

const ao = currentAO();
console.log(`[boot] loading gazetteer for ${ao.label} …`);
gazetteer.load(ao).then((s) => console.log("[boot] gazetteer:", s));
server.listen(config.port, () => {
  console.log(`[boot] Voice-to-Map on http://localhost:${config.port}`);
  console.log(
    `[boot] LLM: ${config.llmKey ? `${config.llmModel} @ ${config.llmBase}` : "OFF (rule parser)"} | server STT: ${config.mistralKey ? config.sttModel : "OFF (use browser STT or typing)"}`,
  );
});
