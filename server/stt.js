// Speech-to-text via Mistral Voxtral (POST /v1/audio/transcriptions).
// The browser can also do STT itself (Web Speech API) – see public/app.js – in which case this is skipped.
import { config } from './config.js';

/**
 * @param {Buffer} audio  recorded clip (webm/opus from MediaRecorder, or wav/mp3)
 * @param {object} opts   { mimetype, language: 'en'|'fr'|null, bias: string[] }  bias = AO place names to help recognition
 */
export async function transcribe(audio, { mimetype = 'audio/webm', language = null, bias = [] } = {}) {
  if (!config.mistralKey) throw new Error('MISTRAL_API_KEY not set – use browser speech recognition or type the report');
  const ext = mimetype.includes('wav') ? 'wav' : mimetype.includes('mp4') || mimetype.includes('m4a') ? 'm4a' : mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mpeg') ? 'mp3' : 'webm';

  const send = async (withBias) => {
    const fd = new FormData();
    fd.append('model', config.sttModel);
    fd.append('file', new Blob([audio], { type: mimetype }), `report.${ext}`);
    if (language) fd.append('language', language);
    // Context biasing (docs: optimised for English). Sent as repeated fields; dropped on a 4xx.
    if (withBias) for (const w of bias.slice(0, 100)) fd.append('context_bias', w);
    const t0 = Date.now();
    const res = await fetch(`${config.mistralBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.mistralKey}` },
      body: fd,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const err = new Error(`Voxtral ${res.status}: ${body}`);
      err.status = res.status;
      throw err;
    }
    const j = await res.json();
    return { text: (j.text ?? '').trim(), language: j.language ?? language, ms: Date.now() - t0, engine: `mistral:${config.sttModel}` };
  };

  try {
    return await send(bias.length > 0);
  } catch (e) {
    if (bias.length && e.status >= 400 && e.status < 500) {
      console.warn('[stt] retrying without context_bias:', e.message);
      return send(false);
    }
    throw e;
  }
}
