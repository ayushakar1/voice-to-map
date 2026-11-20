import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import { extractIntent } from '../server/intent.js';

const report = {
  type: 'position', relation: 'at', callsign: 'Demo Walker',
  anchor: { text: 'Place des Vosges', name: 'Place des Vosges', category: 'square', kind: 'landmark' },
  anchor2: null, distance_m: null, bearing: null, note: null, confidence: 0.9,
};

for (const provider of ['featherless', 'mistral']) {
  test(`${provider} intent request uses its configured endpoint, key and engine label`, async (t) => {
    const original = { ...config };
    t.after(() => Object.assign(config, original));
    Object.assign(config, {
      llmProvider: provider, llmKey: 'test-key',
      llmBase: `https://${provider}.example/v1/`, llmModel: 'test-model',
    });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, `https://${provider}.example/v1/chat/completions`);
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-model');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.match(body.messages.at(-1).content, /Place des Vosges/);
      return Response.json({ choices: [{ message: { content: JSON.stringify(report) } }] });
    });
    const result = await extractIntent('I am at Place des Vosges');
    assert.equal(result.engine, `${provider}:test-model`);
    assert.equal(result.intent.anchor.name, 'Place des Vosges');
    assert.equal(result.error, undefined);
  });
}

test('intent runs offline when no language model key is configured', async (t) => {
  const key = config.llmKey;
  t.after(() => { config.llmKey = key; });
  config.llmKey = '';
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const result = await extractIntent('I am at Place des Vosges');
  assert.equal(result.engine, 'rules');
  assert.equal(fetch.mock.callCount(), 0);
});

test('provider errors fall back to rules and redact the key', async (t) => {
  const original = { ...config };
  t.after(() => Object.assign(config, original));
  Object.assign(config, { llmKey: 'secret-test-key', llmProvider: 'featherless' });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('Rejected secret-test-key', { status: 401 }));
  const result = await extractIntent('I am at Place des Vosges');
  assert.equal(result.engine, 'rules (LLM error)');
  assert.match(result.error, /featherless 401/);
  assert.doesNotMatch(result.error, /secret-test-key/);
  assert.equal(result.intent.type, 'position');
});

test('invalid provider JSON falls back to the rule parser', async (t) => {
  const key = config.llmKey;
  t.after(() => { config.llmKey = key; });
  config.llmKey = 'test-key';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'invalid JSON' } }] }));
  const result = await extractIntent('I am at Place des Vosges');
  assert.equal(result.engine, 'rules (LLM error)');
  assert.equal(result.intent.type, 'position');
  assert.ok(result.error);
});
