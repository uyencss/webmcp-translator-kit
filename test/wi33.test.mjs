// WebMCP Translator Kit — WI-33 Unit Tests
// Fix 4 findings Sol round 16:
// 1. aborted-settle: ABORTED items settle permanently in current run and watchdog never resurrects them (2 sends instead of 4)
// 2. empty-no-retry: empty-stream / zero-trace settles immediately, no watchdog retry (2 sends instead of 4)
// 3. error-JSON-no-bisect: complete error JSON (e.g. {"error":"Unauthorized"}) errors immediately, no bisect (1 call instead of 15)
// 4. min-split-bound: batch < 8 is never split into children < 4; retries once then errors (no [4,2,2])
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createDirect9Router } from '../extension/src/adapter/direct9router.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function setupDomEnvironment() {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  function fakeEl(tagName = 'DIV') {
    return {
      nodeType: 1, style: {}, dataset: {}, tagName, id: '', isConnected: true,
      setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener() {}, removeEventListener() {}, appendChild() {},
      querySelector: () => fakeEl(), querySelectorAll: () => [],
      setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 50, height: 50 }),
      textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
      focus() {}, click() {}, isContentEditable: false, parentElement: null
    };
  }

  const parent = fakeEl('P');
  const nodes = [];
  for (let i = 0; i < 32; i++) {
    nodes.push({
      nodeType: 3,
      nodeValue: `Text item number ${i}`,
      parentElement: parent,
      isConnected: true
    });
  }

  const win = {
    innerHeight: 800, innerWidth: 1200, top: null,
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
    scrollTo() {}
  };
  win.top = win;

  const sentMessages = [];
  let batchResponseHandler = null;

  const runtime = {
    id: 'test-ext-id',
    lastError: null,
    onMessage: { addListener() {} },
    sendMessage: (msg, cb) => {
      sentMessages.push(msg);
      if (msg?.action === 'WIDGET_GET_STATE') {
        if (cb) cb({ effective: 'on', permission: true, hasKey: true, autoStart: false, widgetVisible: true });
      } else if (msg?.action === 'TRANSLATE_BATCH') {
        if (batchResponseHandler) {
          batchResponseHandler(msg, cb);
        }
      } else if (msg?.action === 'RECORD_ERROR_LOG') {
        if (cb) cb({ ok: true });
      }
      return Promise.resolve({ ok: true });
    }
  };

  globalThis.window = win;
  globalThis.document = {
    documentElement: fakeEl('HTML'),
    body: fakeEl('BODY'),
    createElement: (t) => fakeEl(t),
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: (sel) => (sel === 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote' ? [parent] : []),
    createTreeWalker: () => {
      let i = 0;
      return {
        nextNode: () => (i < nodes.length ? nodes[i++] : null)
      };
    }
  };
  globalThis.location = { href: 'http://example.com/test', origin: 'http://example.com' };
  globalThis.chrome = {
    runtime,
    storage: { session: { set: async () => {}, get: async () => ({}) }, local: { get: async () => ({}) } }
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  globalThis.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {} disconnect() {}
  };

  vm.runInThisContext(contentSrc);

  const dom = win.__translatorDom;

  function restore() {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }

  return {
    dom,
    sentMessages,
    setBatchResponseHandler: (fn) => { batchResponseHandler = fn; },
    restore
  };
}

// ============================================================================
// 1. F1 Repro: aborted-settle (32 aborted items -> 2 sends instead of 4)
// ============================================================================
test('F1: aborted-settle (32 aborted items produce 2 sends instead of 4, no watchdog requeue)', async () => {
  const env = setupDomEnvironment();
  try {
    env.setBatchResponseHandler((msg, cb) => {
      setTimeout(() => {
        cb({
          error: { code: 'ABORTED', message: 'Operation aborted by caller', retryable: false },
          fatal: true,
          applied: 0,
          failed: msg.payload?.items?.length || 0
        });
      }, 5);
    });

    const dom = env.dom;
    const collected = dom.collect();
    assert.equal(collected.length, 32, 'Must collect 32 nodes');

    // Start scroll session with fast watchdog backoff
    dom.startScrollFollowSession({ watchdogBackoffMs: 10 });
    const sess = dom.getScrollSession();
    assert.equal(sess.watching, true);

    // Initial batch dispatch will trigger 2 chunks of 16
    dom.flushReadyBlocks();

    // Wait for initial batches and potential watchdog rounds
    await new Promise((r) => setTimeout(r, 150));

    // Filter TRANSLATE_BATCH messages
    const translateSends = env.sentMessages.filter((m) => m?.action === 'TRANSLATE_BATCH');
    assert.equal(
      translateSends.length,
      2,
      `32 aborted items must produce exactly 2 batch sends, got ${translateSends.length} (must not be 4)`
    );

    const status = dom.getStatus();
    assert.equal(status.stable, true, 'Status must be marked stable');
    assert.equal(status.totalFailed, 32, 'totalFailed must show all 32 items');
    assert.equal(sess.failedIds.size, 32, 'failedIds must settle all 32 items permanently in this run');
    assert.equal(sess.abortedIds.size, 32, 'abortedIds must record all 32 aborted items');

    // Starting a new user session clears failedIds and abortedIds
    dom.startScrollFollowSession({ watchdogBackoffMs: 10 });
    assert.equal(sess.failedIds.size, 0, 'New session must clear failedIds');
    assert.equal(sess.abortedIds.size, 0, 'New session must clear abortedIds');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 2. F2 Repro: empty-no-retry (contentBytes: 0, rawHead: '' -> 2 sends instead of 4)
// ============================================================================
test('F2: empty-no-retry (empty stream contentBytes 0 settles immediately, 2 sends instead of 4)', async () => {
  const env = setupDomEnvironment();
  try {
    env.setBatchResponseHandler((msg, cb) => {
      setTimeout(() => {
        cb({
          error: {
            code: 'INVALID_SCHEMA',
            message: 'Translated content missing results array',
            details: { contentBytes: 0, rawHead: '', streamBytes: 0, zeroItem: true }
          },
          fatal: true,
          applied: 0,
          failed: msg.payload?.items?.length || 0
        });
      }, 5);
    });

    const dom = env.dom;
    dom.collect();

    dom.startScrollFollowSession({ watchdogBackoffMs: 10 });
    const sess = dom.getScrollSession();

    dom.flushReadyBlocks();

    await new Promise((r) => setTimeout(r, 150));

    const translateSends = env.sentMessages.filter((m) => m?.action === 'TRANSLATE_BATCH');
    assert.equal(
      translateSends.length,
      2,
      `Empty-stream items must produce exactly 2 batch sends, got ${translateSends.length} (must not be 4)`
    );

    const status = dom.getStatus();
    assert.equal(status.stable, true, 'Status must be marked stable');
    assert.equal(status.totalFailed, 32, 'totalFailed must be 32 immediately');
    assert.equal(sess.failedIds.size, 32, 'failedIds must record all 32 items immediately');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 3. F3 Repro: error-JSON-no-bisect ({"error":"Unauthorized"} -> 1 call instead of 15)
// ============================================================================
test('F3: error-JSON-no-bisect ({"error":"Unauthorized"} produces 1 provider call for 16 items instead of 15)', async () => {
  const items = [];
  for (let i = 0; i < 16; i++) {
    items.push({ id: `item_${i}`, revision: 0, text: `Sentence number ${i} to translate.` });
  }

  let callCount = 0;
  const calls = [];
  const enc = new TextEncoder();

  const fetchImpl = async (url, opts) => {
    callCount++;
    const payload = JSON.parse(opts.body);
    const userMsg = JSON.parse(payload.messages[1].content);
    calls.push(userMsg.length);

    // Provider returns SSE stream with complete error JSON
    const errorJson = JSON.stringify({ error: 'Unauthorized' });
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: errorJson } }] })}\n\n`,
      'data: [DONE]\n\n'
    ];
    let idx = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => idx < chunks.length ? { done: false, value: enc.encode(chunks[idx++]) } : { done: true },
          cancel: async () => {}
        })
      }
    };
  };

  const router = createDirect9Router({
    baseURL: 'http://127.0.0.1:9090/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.8-flash',
    fetchImpl,
    ...fastOptions
  });

  const res = await router.translateBatch({ items });

  assert.ok(res.error, 'Must return error on unauthorized JSON');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
  assert.equal(
    callCount,
    1,
    `Error JSON {"error":"Unauthorized"} must produce exactly 1 call without bisecting, got ${callCount} (must not be 15)`
  );
  assert.deepEqual(calls, [16], 'Must only call with initial batch of 16 items');
});

// ============================================================================
// 4. F4 Repro: min-split-bound (batch < 8 is never split into children < 4; e.g. no [4,2,2])
// ============================================================================
test('F4: min-split-bound (batch of 4 retries once as [4,4], never splits into [4,2,2])', async () => {
  const items4 = [];
  for (let i = 0; i < 4; i++) {
    items4.push({ id: `item_${i}`, revision: 0, text: `Short line ${i}` });
  }

  const calls = [];
  const enc = new TextEncoder();

  const fetchImpl = async (url, opts) => {
    const payload = JSON.parse(opts.body);
    const userMsg = JSON.parse(payload.messages[1].content);
    calls.push(userMsg.length);

    // Truncated stream with valid results trace
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"results": [{"id": "' + userMsg[0].id + '"' } }] })}\n\n`,
      'data: [DONE]\n\n'
    ];
    let idx = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => idx < chunks.length ? { done: false, value: enc.encode(chunks[idx++]) } : { done: true },
          cancel: async () => {}
        })
      }
    };
  };

  const router = createDirect9Router({
    baseURL: 'http://127.0.0.1:9090/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.8-flash',
    fetchImpl,
    ...fastOptions
  });

  const res = await router.translateBatch({ items: items4 });

  assert.ok(res.error, 'Must return error after retry fails');
  assert.deepEqual(
    calls,
    [4, 4],
    `Batch of 4 items must only retry whole batch once [4, 4], never split into children < 4 (got ${JSON.stringify(calls)})`
  );
  // Ensure no child < 4 was ever requested
  for (const c of calls) {
    assert.ok(c >= 4, `Every requested batch size must be >= 4, got ${c}`);
  }
});

test('F4 (b): batch of 8 splits into halves both >= 4 [8, 4, 4]', async () => {
  const items8 = [];
  for (let i = 0; i < 8; i++) {
    items8.push({ id: `item_${i}`, revision: 0, text: `Item text ${i}` });
  }

  const calls = [];
  const enc = new TextEncoder();

  const fetchImpl = async (url, opts) => {
    const payload = JSON.parse(opts.body);
    const userMsg = JSON.parse(payload.messages[1].content);
    calls.push(userMsg.length);

    if (userMsg.length === 8) {
      // 8 items fails with truncated results
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"results": [{"id": "' + userMsg[0].id + '"' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ];
      let idx = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: async () => idx < chunks.length ? { done: false, value: enc.encode(chunks[idx++]) } : { done: true },
            cancel: async () => {}
          })
        }
      };
    }

    // Halves of 4 succeed
    const results = userMsg.map((it) => ({ id: it.id, revision: it.revision, text: `[vi] ${it.text}` }));
    const sseBody = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ results }) } }] })}\n\ndata: [DONE]\n\n`;
    let readDone = false;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => {
            if (!readDone) {
              readDone = true;
              return { done: false, value: enc.encode(sseBody) };
            }
            return { done: true };
          },
          cancel: async () => {}
        })
      }
    };
  };

  const router = createDirect9Router({
    baseURL: 'http://127.0.0.1:9090/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.8-flash',
    fetchImpl,
    ...fastOptions
  });

  const res = await router.translateBatch({ items: items8 });

  assert.ok(!res.error, 'Must succeed after bisecting 8 into two 4s');
  assert.equal(res.results.length, 8);
  assert.deepEqual(
    calls,
    [8, 4, 4],
    `Batch of 8 must bisect into two halves of 4, got ${JSON.stringify(calls)}`
  );
  for (const c of calls) {
    assert.ok(c >= 4, `Every requested batch size must be >= 4, got ${c}`);
  }
});
