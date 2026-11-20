/* global L */
// Voice-to-Map client: push-to-talk, live shared map over WebSocket, history + replay, operator correction.

const $ = (id) => document.getElementById(id);
const state = {
  events: [], colors: {}, ao: null, caps: {}, replayT: null, selected: null, placing: null,
  arrivals: new Map(), clientLatency: new Map(), landmarks: null,
};

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomControl: true, preferCanvas: false }).setView([48.8566, 2.3522], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
const layers = { units: L.layerGroup().addTo(map), ao: L.layerGroup().addTo(map), landmarks: L.layerGroup() };

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colorOf = (unit) => state.colors[unit] ?? '#ccc';

function drawAO() {
  layers.ao.clearLayers();
  if (!state.ao) return;
  const [s, w, n, e] = state.ao.bbox;
  L.rectangle([[s, w], [n, e]], { color: '#7d8b96', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(layers.ao);
}

function render() {
  const live = state.replayT === null;
  const visible = live ? state.events : state.events.filter((e) => e.ts <= state.replayT);
  layers.units.clearLayers();

  const byUnit = new Map();
  for (const e of visible) if (e.position) { if (!byUnit.has(e.unit)) byUnit.set(e.unit, []); byUnit.get(e.unit).push(e); }

  for (const [unit, evs] of byUnit) {
    const c = colorOf(unit);
    const pts = evs.map((e) => [e.position.lat, e.position.lon]);
    if (pts.length > 1) L.polyline(pts, { color: c, weight: 3, opacity: 0.85 }).addTo(layers.units);
    evs.slice(0, -1).forEach((e) => {
      L.circleMarker([e.position.lat, e.position.lon], { radius: 4, color: c, weight: 1, fillColor: c, fillOpacity: 0.6 })
        .bindTooltip(`<b>${esc(unit)}</b> ${fmtTime(e.ts)}<br>“${esc(e.transcript)}”`).on('click', () => select(e.id)).addTo(layers.units);
    });
    const last = evs[evs.length - 1];
    const p = [last.position.lat, last.position.lon];
    L.circle(p, { radius: last.position.accuracyM ?? 30, color: c, weight: 1, opacity: 0.5, fillOpacity: 0.08, interactive: false }).addTo(layers.units);
    L.circleMarker(p, { radius: 9, color: '#fff', weight: 2, fillColor: c, fillOpacity: 1 })
      .bindTooltip(`<b style="color:${c}">●</b> ${esc(unit.toUpperCase())} · ${fmtTime(last.ts)}`, { permanent: true, direction: 'right', offset: [10, 0], className: 'unit-label' })
      .on('click', () => select(last.id)).addTo(layers.units);
    // Movement intent: dashed line to where they said they are heading
    const latestEvent = [...visible].reverse().find((e) => e.unit === unit);
    if (latestEvent?.result?.target && latestEvent.position) {
      const t = latestEvent.result.target;
      L.polyline([p, [t.lat, t.lon]], { color: c, weight: 2, dashArray: '6 6', opacity: 0.9 }).addTo(layers.units);
      L.circleMarker([t.lat, t.lon], { radius: 5, color: c, weight: 2, fill: false })
        .bindTooltip(`Heading: ${esc(latestEvent.result.anchor?.name)}`).addTo(layers.units);
    }
  }

  // Highlight anchor(s) of the selected (or latest) event
  const focus = visible.find((e) => e.id === state.selected) ?? visible[visible.length - 1];
  for (const a of [focus?.result?.anchor, focus?.result?.anchor2]) {
    if (!a) continue;
    const ap = a.point ?? a;
    L.marker([ap.lat, ap.lon], {
      icon: L.divIcon({ className: '', html: '<div style="width:12px;height:12px;border:2px solid #f5a623;transform:rotate(45deg);background:rgba(245,166,35,.25)"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
    }).bindTooltip(`Anchor: ${esc(a.name)} (${esc(a.category)})`).addTo(layers.units);
  }
  renderTimeline();
}

// ---------------------------------------------------------------- timeline
const TYPE_LABEL = { position: 'POS', movement: 'MOVE', status: 'STATUS', unknown: '?' };

function renderTimeline() {
  const ol = $('events');
  const units = [...new Set(state.events.map((e) => e.unit))];
  $('units').innerHTML = units.map((u) => `<option value="${esc(u)}">`).join('');
  ol.innerHTML = '';
  for (const e of [...state.events].reverse()) {
    const r = e.result ?? {};
    const li = document.createElement('li');
    li.style.setProperty('--c', colorOf(e.unit));
    if (state.replayT !== null && e.ts > state.replayT) li.classList.add('future');
    if (state.selected === e.id) li.classList.add('sel');
    const status = r.status === 'resolved' ? (r.method === 'manual' ? ['ok', 'manual'] : (r.confidence ?? 1) < 0.5 ? ['warn', `low conf ${r.confidence}`] : ['ok', `conf ${r.confidence ?? '-'}`])
      : r.status === 'no_move' ? ['', 'no move'] : ['bad', 'unresolved'];
    const lat = e.latency ?? {};
    const client = state.clientLatency.get(e.id);
    const i = e.intent ?? {};
    li.innerHTML = `
      <div class="ev-top"><span><span class="ev-unit">${esc(e.unit)}</span> · ${e.source === 'text' ? '⌨' : '🎙'} ${fmtTime(e.ts)}</span>
        <span title="server: STT ${lat.sttMs ?? '-'} ms · LLM ${lat.llmMs} ms · geo ${lat.geoMs} ms">${client ? `⏱ ${(client / 1000).toFixed(1)} s` : `⚙ ${lat.serverMs} ms`}</span></div>
      <div class="ev-text">“${esc(e.transcript)}”${e.interpretedAs ? `<div class="ev-expl">heard as: ${esc(e.interpretedAs)}</div>` : ''}</div>
      <div class="ev-meta">
        <span class="chip">${TYPE_LABEL[i.type] ?? '?'} ${esc(i.relation ?? '')}</span>
        ${r.anchor ? `<span class="chip">${esc(r.anchor.name)}</span>` : ''}
        ${r.anchor2 ? `<span class="chip">${esc(r.anchor2.name)}</span>` : ''}
        <span class="chip ${status[0]}">${status[1]}</span>
        <span class="chip" title="intent engine">${esc((e.intentEngine ?? '').replace(/^(mistral|llm):/, '').split('/').pop())}</span>
        ${i.note ? `<span class="chip warn">${esc(i.note)}</span>` : ''}
      </div>
      <div class="ev-expl">${esc(r.explanation ?? '')}</div>
      <div class="ev-actions"></div>`;
    const actions = li.querySelector('.ev-actions');
    const fix = document.createElement('button');
    fix.textContent = r.status === 'resolved' ? 'Fix on map' : 'Place on map';
    fix.onclick = (ev) => { ev.stopPropagation(); startPlacing(e.id); };
    actions.append(fix);
    if ((r.candidates?.length ?? 0) > 1) {
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">Other match…</option>` + r.candidates.map((c) =>
        `<option value="${esc(c.id)}" ${c.id === r.anchor?.id ? 'disabled' : ''}>${esc(c.name)} · ${c.distM} m${c.id === r.anchor?.id ? ' (current)' : ''}</option>`).join('');
      sel.onclick = (ev) => ev.stopPropagation();
      sel.onchange = async () => { if (sel.value) await api(`/api/events/${e.id}/choose`, { candidateId: sel.value }); };
      actions.append(sel);
    }
    li.onclick = () => select(e.id, true);
    ol.append(li);
  }
}

function select(id, fly = false) {
  state.selected = id;
  const e = state.events.find((x) => x.id === id);
  if (fly && e?.position) map.flyTo([e.position.lat, e.position.lon], Math.max(map.getZoom(), 17), { duration: 0.6 });
  render();
}

// ---------------------------------------------------------------- server comms
async function api(url, body, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? res.statusText);
  return j;
}

function upsert(ev) {
  const i = state.events.findIndex((e) => e.id === ev.id);
  if (i >= 0) state.events[i] = ev; else { state.events.push(ev); state.events.sort((a, b) => a.ts - b.ts); }
  if (ev.color) state.colors[ev.unit] = ev.color;
  if (!state.arrivals.has(ev.id)) state.arrivals.set(ev.id, performance.now());
}

let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { $('live').textContent = '● LIVE'; $('live').classList.remove('off'); };
  ws.onclose = () => { $('live').textContent = '● OFFLINE'; $('live').classList.add('off'); setTimeout(connect, 1500); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'snapshot') {
      const aoChanged = JSON.stringify(state.ao?.bbox) !== JSON.stringify(msg.ao?.bbox);
      Object.assign(state, { events: msg.events, colors: msg.colors, ao: msg.ao, caps: msg.capabilities });
      renderHeader(msg);
      drawAO();
      if (aoChanged && msg.ao) { const [s, w, n, e] = msg.ao.bbox; map.fitBounds([[s, w], [n, e]]); state.landmarks = null; if ($('showLandmarks').checked) loadLandmarks(); }
      render();
    } else if (msg.type === 'event' || msg.type === 'event_updated') {
      upsert(msg.event);
      if (msg.type === 'event' && state.replayT === null && msg.event.position && !map.getBounds().contains([msg.event.position.lat, msg.event.position.lon])) {
        map.panTo([msg.event.position.lat, msg.event.position.lon]);
      }
      render();
    } else if (msg.type === 'speaking') showSpeaking(msg);
  };
}
const wsSend = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };

function renderHeader(msg) {
  const c = msg.capabilities ?? {};
  const g = msg.gazetteer ?? {};
  $('caps').innerHTML = [
    `<span class="cap ${c.llm ? 'on' : ''}">intent: ${c.llm ? esc(c.llmModel) : 'rule parser'}</span>`,
    `<span class="cap ${c.serverStt ? 'on' : ''}">server STT: ${c.serverStt ? esc(c.sttModel) : 'off'}</span>`,
    `<span class="cap ${g.total ? 'on' : ''}" title="${esc(g.source)}">gazetteer: ${g.landmarks ?? 0} places · ${g.streets ?? 0} streets</span>`,
  ].join('');
  const sel = $('aoSelect');
  sel.innerHTML = Object.entries(msg.aoPresets ?? {}).map(([k, v]) => `<option value="${k}" ${msg.ao?.id === k ? 'selected' : ''}>${esc(v)}</option>`).join('')
    + (msg.ao?.id === 'custom' ? '<option selected>Custom AO</option>' : '');
  if (!c.serverStt && $('sttMode').value === 'voxtral') $('sttMode').value = 'browser';
}

let speakingTimer;
function showSpeaking({ unit, partial, done }) {
  const el = $('speaking');
  clearTimeout(speakingTimer);
  if (done) { speakingTimer = setTimeout(() => el.classList.add('hidden'), 1200); return; }
  el.innerHTML = `🎙 <b>${esc(unit)}</b> ${partial ? `“${esc(partial)}”` : 'is talking…'}`;
  el.classList.remove('hidden');
  speakingTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}

// ---------------------------------------------------------------- reporting
const unit = () => $('callsign').value.trim() || 'Alpha 1';
let releaseAt = 0;

async function submitText(text, source = 'text', stt = null) {
  setBusy(true);
  try {
    const ev = await api('/api/report', { text, unit: unit(), source, stt });
    finishLatency(ev);
  } catch (e) { note(`Error: ${e.message}`); } finally { setBusy(false); }
}

function finishLatency(ev) {
  upsert(ev);
  const arrived = state.arrivals.get(ev.id) ?? performance.now();
  if (releaseAt) {
    const ms = Math.round(arrived - releaseAt);
    state.clientLatency.set(ev.id, ms);
    const l = ev.latency ?? {};
    note(`Release → map: ${(ms / 1000).toFixed(2)} s  (STT ${l.sttMs ?? 'browser'} · LLM ${l.llmMs} · geo ${l.geoMs} ms)`);
  }
  releaseAt = 0;
  render();
}

const note = (t) => { $('lastLatency').textContent = t; };
const setBusy = (b) => $('ptt').classList.toggle('busy', b);
const showPartial = (t) => { $('partial').textContent = t; };

$('textForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('textInput').value.trim();
  if (!t) return;
  $('textInput').value = '';
  releaseAt = performance.now();
  submitText(t, 'text');
});

// --- Browser STT (Chrome/Edge: Web Speech API; audio goes to the browser vendor's cloud)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, finalText = '', lastPartial = '';
function startBrowserSTT() {
  if (!SR) { note('Web Speech API not available in this browser – use Chrome/Edge, Voxtral, or type.'); return false; }
  rec = new SR();
  rec.lang = $('lang').value;
  rec.interimResults = true;
  rec.continuous = true;
  finalText = ''; lastPartial = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' '; else interim += r[0].transcript;
    }
    lastPartial = (finalText + interim).trim();
    showPartial(lastPartial);
    wsSend({ type: 'speaking', unit: unit(), partial: lastPartial });
  };
  rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') note(`Speech error: ${e.error}`); };
  rec.onend = () => {
    const text = (finalText.trim() || lastPartial).trim();
    wsSend({ type: 'speaking', unit: unit(), done: true });
    rec = null;
    if (text) submitText(text, 'voice', { engine: 'web-speech', ms: releaseAt ? Math.round(performance.now() - releaseAt) : null });
    else { note('No speech recognised'); setBusy(false); }
  };
  rec.start();
  return true;
}
function stopBrowserSTT() { if (rec) { setBusy(true); rec.stop(); } }

// --- Server STT (Mistral Voxtral): record with MediaRecorder, upload on release
let mediaStream = null, recorder = null, chunks = [];
async function startVoxtral() {
  try {
    mediaStream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { note(`Microphone blocked: ${e.message}`); return false; }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    wsSend({ type: 'speaking', unit: unit(), done: true });
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    if (blob.size < 1500) { note('Too short – hold the button while you speak'); setBusy(false); return; }
    const fd = new FormData();
    fd.append('audio', blob, `report.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`);
    fd.append('unit', unit());
    fd.append('lang', $('lang').value.slice(0, 2));
    setBusy(true);
    showPartial('transcribing…');
    try {
      const res = await fetch('/api/voice', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      showPartial(j.transcript);
      finishLatency(j);
    } catch (e) { note(`Error: ${e.message}`); showPartial(''); } finally { setBusy(false); }
  };
  recorder.start();
  wsSend({ type: 'speaking', unit: unit(), partial: '' });
  return true;
}
function stopVoxtral() { if (recorder?.state === 'recording') recorder.stop(); }

// --- Push-to-talk wiring
let talking = false;
async function pttDown() {
  if (talking) return;
  talking = true;
  showPartial('');
  $('ptt').classList.add('rec');
  const ok = $('sttMode').value === 'voxtral' ? await startVoxtral() : startBrowserSTT();
  if (!ok) { talking = false; $('ptt').classList.remove('rec'); }
}
function pttUp() {
  if (!talking) return;
  talking = false;
  releaseAt = performance.now();
  $('ptt').classList.remove('rec');
  if ($('sttMode').value === 'voxtral') stopVoxtral(); else stopBrowserSTT();
}
$('ptt').addEventListener('pointerdown', (e) => { e.preventDefault(); pttDown(); });
$('ptt').addEventListener('pointerup', pttUp);
$('ptt').addEventListener('pointerleave', pttUp);
const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && !typing()) { e.preventDefault(); pttDown(); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing()) { e.preventDefault(); pttUp(); } });

// ---------------------------------------------------------------- operator correction
function startPlacing(id) { state.placing = id; $('placeHint').classList.remove('hidden'); map.getContainer().style.cursor = 'crosshair'; }
function stopPlacing() { state.placing = null; $('placeHint').classList.add('hidden'); map.getContainer().style.cursor = ''; }
$('cancelPlace').onclick = (e) => { e.preventDefault(); stopPlacing(); };
map.on('click', async (e) => {
  if (!state.placing) return;
  const id = state.placing;
  stopPlacing();
  try { await api(`/api/events/${id}/correct`, { lat: e.latlng.lat, lon: e.latlng.lng }); } catch (err) { note(`Error: ${err.message}`); }
});

// ---------------------------------------------------------------- replay
const scrub = $('scrub');
function timeRange() {
  if (!state.events.length) return null;
  return [state.events[0].ts, state.events[state.events.length - 1].ts];
}
function setReplay(v) {
  const r = timeRange();
  if (!r || v >= 1000) { state.replayT = null; scrub.value = 1000; $('scrubLabel').textContent = 'LIVE'; render(); return; }
  state.replayT = r[0] + (r[1] - r[0]) * (v / 1000);
  $('scrubLabel').textContent = fmtTime(state.replayT);
  render();
}
scrub.addEventListener('input', () => { stopPlay(); setReplay(Number(scrub.value)); });
$('liveBtn').onclick = () => { stopPlay(); setReplay(1000); };
let playTimer = null;
function stopPlay() { clearInterval(playTimer); playTimer = null; $('playBtn').textContent = '▶'; }
$('playBtn').onclick = () => {
  if (playTimer) return stopPlay();
  let v = state.replayT === null ? 0 : Number(scrub.value);
  $('playBtn').textContent = '⏸';
  playTimer = setInterval(() => {
    v += 5; // ~10 s for a full replay
    scrub.value = Math.min(v, 1000);
    setReplay(v);
    if (v >= 1000) stopPlay();
  }, 50);
};

// ---------------------------------------------------------------- misc
$('aoSelect').addEventListener('change', async (e) => {
  note('Loading area (OSM)…');
  try { const r = await api('/api/ao', { preset: e.target.value }); note(`Area loaded: ${r.stats.landmarks} places, ${r.stats.streets} streets (${r.stats.source})`); } catch (err) { note(`Error: ${err.message}`); }
});
$('resetBtn').onclick = async () => { if (confirm('Clear all reports?')) await api('/api/events', null, 'DELETE'); };

async function loadLandmarks() {
  state.landmarks ??= await (await fetch('/api/gazetteer/landmarks')).json();
  layers.landmarks.clearLayers();
  for (const l of state.landmarks) {
    L.circleMarker([l.lat, l.lon], { radius: 3, color: '#9fb0bb', weight: 1, fillOpacity: 0.6 })
      .bindTooltip(`${esc(l.name)} · ${esc(l.category)}`).addTo(layers.landmarks);
  }
}
$('showLandmarks').addEventListener('change', async (e) => {
  if (e.target.checked) { await loadLandmarks(); layers.landmarks.addTo(map); } else map.removeLayer(layers.landmarks);
});

connect();
