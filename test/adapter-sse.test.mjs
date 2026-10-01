// WebMCP Translator Kit — SSE streaming adapter unit tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirect9Router } from '../extension/src/adapter/direct9router.mjs';

const fastOptions = {
  timeoutMs: 5000,
  listModelsTimeoutMs: 1000,
  maxRetries: 0,
  maxTimeoutRetries: 0,
  retryInitialDelayMs: 10,
  retryMaxDelayMs: 20,
  retryTimeoutDelayMs: 10,
  retryJitterRatio: 0
};

const ITEMS = [
  { id: 'T1', revision: 0, text: 'Hello world' },
  { id: 'T2', revision: 0, text: 'Thank you' }
];

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseContentFrame(text) {
  return sseChunk({ id: 'chatcmpl-test', object: 'chat.completion.chunk', model: 'ag/x', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

// Fake fetchImpl serving a fixed byte sequence as SSE (or JSON) response
function stubFetch({ status = 200, contentType = 'text/event-stream', byteSlices = [] }) {
  const seen = { count: 0, lastBody: null, lastHeaders: null };
  const fetchImpl = async (url, opts) => {
    seen.count++;
    seen.lastBody = opts?.body;
    seen.lastHeaders = opts?.headers;
    const enc = new TextEncoder();
    const bufs = byteSlices.map((s) => enc.encode(s));
    let idx = 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { get: (name) => (/^content-type$/i.test(name) ? contentType : null) },
      body: {
        getReader: () => ({
          read: async () => (idx < bufs.length ? { done: false, value: bufs[idx++] } : { done: true, value: undefined }),
          cancel: async () => {}
        })
      }
    };
  };
  return { fetchImpl, seen };
}

function splitBytes(str, cuts) {
  // cuts: array of sizes; returns slices covering str
  const out = [];
  let i = 0;
  for (const c of cuts) {
    out.push(str.slice(i, i + c));
    i += c;
  }
  out.push(str.slice(i));
  return out.filter((s) => s.length > 0);
}

test('SSE: progressive onProgress per item + validated final results', async () => {
  const full = sseContentFrame('{"results": [') +
    sseContentFrame(JSON.stringify(ITEMS[0]) + ',') +
    sseContentFrame(JSON.stringify(ITEMS[1]) + ']}') +
    'data: [DONE]\n\n';
  // adversarial split: 13-byte slices cut mid-string, mid-escape, mid-frame
  const { fetchImpl, seen } = stubFetch({ byteSlices: splitBytes(full, [13, 13, 13, 29, 7, 41, 5]) });
  const router = createDirect9Router({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'ag/gemini-3.1-pro-low', fetchImpl, ...fastOptions });

  const progress = [];
  const result = await router.translateBatch({
    items: ITEMS,
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    model: 'ag/gemini-3.1-pro-low',
    onProgress: (it) => progress.push(it)
  });

  assert.ok(!result.error, `Expected success, got ${JSON.stringify(result.error)}`);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].text, ITEMS[0].text);
  // Progressive: both items emitted via onProgress (order preserved)
  assert.deepEqual(progress.map((p) => p.id), ['T1', 'T2']);
  // Request asked for streaming
  assert.equal(JSON.parse(seen.lastBody).stream, true);
  assert.ok(String(seen.lastHeaders.Accept).includes('text/event-stream'));
});

test('SSE: non-SSE JSON response still works (legacy fallback)', async () => {
  const body = JSON.stringify({
    id: 'x', object: 'chat.completion', model: 'm',
    choices: [{ message: { content: JSON.stringify({ results: ITEMS }) } }]
  });
  const { fetchImpl } = stubFetch({ contentType: 'application/json', byteSlices: [body] });
  const router = createDirect9Router({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'ag/gemini-3.1-pro-low', fetchImpl, ...fastOptions });
  let progressCalls = 0;
  const result = await router.translateBatch({
    items: ITEMS, sourceLanguage: 'auto', targetLanguage: 'vi',
    model: 'ag/gemini-3.1-pro-low', onProgress: () => { progressCalls++; }
  });
  assert.ok(!result.error, `Expected success, got ${JSON.stringify(result.error)}`);
  assert.equal(result.results.length, 2);
  assert.equal(progressCalls, 0);
});

test('SSE: truncated stream -> INVALID_SCHEMA (no partial accept)', async () => {
  const full = sseContentFrame('{"results": [' + JSON.stringify(ITEMS[0]) + ', {"id": "T2", "text": "cut');
  const { fetchImpl } = stubFetch({ byteSlices: [full] });
  const router = createDirect9Router({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'ag/gemini-3.1-pro-low', fetchImpl, ...fastOptions });
  const result = await router.translateBatch({ items: ITEMS, sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/gemini-3.1-pro-low' });
  assert.ok(result.error, 'Expected error for truncated stream');
  assert.equal(result.error.code, 'INVALID_SCHEMA');
});

test('SSE: HTTP 401 keeps typed error path', async () => {
  const { fetchImpl } = stubFetch({ status: 401, contentType: 'application/json', byteSlices: ['{"error":{}}'] });
  const router = createDirect9Router({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'bad', model: 'ag/gemini-3.1-pro-low', fetchImpl, ...fastOptions });
  const result = await router.translateBatch({ items: ITEMS, sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/gemini-3.1-pro-low' });
  assert.ok(result.error);
  assert.equal(result.error.code, 'HTTP_401');
});
