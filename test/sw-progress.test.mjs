// WebMCP Translator Kit — SW progressive-forwarding unit test (SSE leg).
// Dispatches TRANSLATE_BATCH against a local SSE provider with a chrome stub
// and asserts: (1) progress items reach tabs.sendMessage BEFORE the final
// result settles, (2) final aggregated result stays bijection-valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeChromeStub(store) {
  const area = (bucket) => ({
    get: async (keys) => {
      if (keys === null || keys === undefined) return { ...bucket };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) {
        if (typeof k === 'string' && k in bucket) out[k] = bucket[k];
      }
      return out;
    },
    set: async (obj) => { Object.assign(bucket, obj); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete bucket[k]; },
    clear: async () => { for (const k of Object.keys(bucket)) delete bucket[k]; },
    setAccessLevel: async () => {},
    getAccessLevel: async () => 'TRUSTED_CONTEXTS'
  });
  const captures = [];
  return {
    captures,
    chrome: {
      storage: { local: area(store.local), session: area(store.session), onChanged: { addListener() {} } },
      tabs: {
        sendMessage: async (tabId, msg) => { captures.push({ tabId, msg }); return {}; },
        query: async () => [],
        get: async () => { throw new Error('No tab'); },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} }
      },
      runtime: { id: 'test-ext-id', lastError: null, onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, sendMessage: () => {} },
      permissions: { contains: async () => true, request: async () => true, onRemoved: { addListener() {} } },
      scripting: { registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, getRegisteredContentScripts: async () => [], executeScript: async () => [{}] }
    }
  };
}

const SSE_ITEMS = [
  { id: 'S1', revision: 0, text: 'Câu một' },
  { id: 'S2', revision: 0, text: 'Câu hai dài hơn một chút' },
  { id: 'S3', revision: 1, text: 'Câu ba' }
];

function startSseServer({ gapMs = 800 } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const frame = (content) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'ag/m', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
      const full = JSON.stringify({ results: SSE_ITEMS });
      // Split into rough quarters (cuts land mid-string/mid-escape on purpose)
      const q = Math.max(1, Math.floor(full.length / 4));
      const parts = [full.slice(0, q), full.slice(q, 2 * q), full.slice(2 * q, 3 * q), full.slice(3 * q)];
      let i = 0;
      const step = () => {
        if (i < parts.length) {
          try { res.write(frame(parts[i++])); } catch {}
          setTimeout(step, gapMs);
        } else {
          try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
        }
      };
      step();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('SW forwards SSE progress to tab before final result settles', async () => {
  const { server, port } = await startSseServer({ gapMs: 400 });
  const baseURL = `http://127.0.0.1:${port}/v1`;
  const store = {
    local: {
      settings: {
        version: 4, baseURL, model: 'ag/m', fallbacks: [], favoriteModels: [],
        autoTranslateSites: [], translationMode: 'full', widgetVisible: true,
        sourceLanguage: 'auto', targetLanguage: 'vi',
        rateLimits: { windowSeconds: 60, tab: { maxBatches: 100, maxSourceCodePoints: 1e7 }, site: { maxBatches: 100, maxSourceCodePoints: 1e7 } }
      },
      sites: { 'http://127.0.0.1:8091': { createdAt: Date.now() } },
      api_key: 'test-key'
    },
    session: {}
  };
  const { chrome, captures } = makeChromeStub(store);
  globalThis.chrome = chrome;
  globalThis.self = globalThis;
  const sw = await import('../extension/src/sw.js?swprog=' + Date.now()).then((m) => globalThis.__translatorSw);
  assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW test hook must exist');
  const sender = { frameId: 0, tab: { id: 9001, url: 'http://127.0.0.1:8091/fixture.html' }, url: 'http://127.0.0.1:8091/fixture.html' };

  try {
    sw._setTestMode(true);
    sw._setTestPermission('http://127.0.0.1:8091', true);
    sw._registerTestTab(9001, 'http://127.0.0.1:8091/fixture.html');
    sw._setTestRateLimits(null);
    await sw._resetRateStateForTest();

    let settled = false;
    const p = sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      epoch: 7,
      payload: {
        items: SSE_ITEMS.map((it) => ({ id: it.id, revision: it.revision, text: 'SRC ' + it.id })),
        sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m'
      }
    }, sender).then((r) => { settled = true; return r; });

    // Mid-flight: stream gap is 400ms across 2 frames; progress must arrive
    // well before the final result (which needs the whole stream + validation)
    await sleep(1200);
    const progressMsgs = captures.filter((c) => c.msg && c.msg.action === 'TRANSLATE_PROGRESS');
    assert.ok(progressMsgs.length > 0, `Expected progress captures mid-flight, got ${captures.length} total sends`);
    assert.ok(!settled, 'Final result must not have settled yet at mid-flight check');
    assert.equal(progressMsgs[0].tabId, 9001);
    assert.equal(progressMsgs[0].msg.epoch, 7);

    const result = await p;
    assert.ok(!result.error, `Expected success, got ${JSON.stringify(result.error)}`);
    assert.equal(result.results.length, 3);
    const allProgress = captures.filter((c) => c.msg && c.msg.action === 'TRANSLATE_PROGRESS');
    assert.deepEqual(allProgress.map((c) => c.msg.item.id), ['S1', 'S2', 'S3']);
  } finally {
    delete globalThis.chrome;
    try { server.closeAllConnections(); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
});
