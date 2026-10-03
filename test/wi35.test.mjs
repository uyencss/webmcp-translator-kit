// WebMCP Translator Kit — WI-35 Unit & Repro Tests
// Fix 4 findings Sol round 18 (wi1115-sol-verdict18.md):
// F1: terminal fallback zero-item không bị watchdog hồi sinh (2 sends thay vì 4)
// F2: error-JSON hoàn chỉnh terminal ngay, không exhausted, không fallback
// F3: streamed fallback results cumulative accounting không bị reset về 0 (applied: 32)
// F4: log terminal fallback ghi đúng model fallback đã thử cuối cùng thay vì model primary

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createDirect9Router, isErrorJson } from '../extension/src/adapter/direct9router.mjs';
import {
  resolveFallbackPlan,
  resolveFallbackChain,
  executeBatchTranslation,
  _setTranslateBatchForTest,
  _setTestMode,
  _setTestPermission,
  _registerTestTab,
  getErrorLog,
  clearErrorLog,
  STOP_ERROR_CODES
} from '../extension/src/sw.js';

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

function makeChromeStub(store) {
  const area = (bucket) => ({
    get: async (keys) => {
      if (keys === null || keys === undefined) return { ...bucket };
      if (typeof keys === 'string') return { [keys]: bucket[keys] };
      const list = Array.isArray(keys) ? keys : (typeof keys === 'object' ? Object.keys(keys) : [keys]);
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
  return {
    storage: {
      local: area(store.local || {}),
      session: area(store.session || {}),
      onChanged: { addListener() {} }
    },
    tabs: {
      sendMessage: async () => ({}),
      query: async () => [],
      get: async () => ({ id: 101, url: 'http://127.0.0.1:8091/page.html' }),
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    runtime: {
      id: 'test-ext-wi35',
      lastError: null,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: async () => ({})
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
      onRemoved: { addListener() {} }
    }
  };
}

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
  let messageListeners = [];

  const runtime = {
    id: 'test-ext-id',
    lastError: null,
    onMessage: {
      addListener(fn) {
        messageListeners.push(fn);
      }
    },
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
    nodes,
    sentMessages,
    setBatchResponseHandler: (fn) => { batchResponseHandler = fn; },
    dispatchRuntimeMessage: (msg, sendResponse) => {
      for (const fn of messageListeners) {
        fn(msg, {}, sendResponse || (() => {}));
      }
    },
    restore
  };
}

// ============================================================================
// 1. F1 Repro: terminal-không-hồi-sinh
// ============================================================================
test('F1 repro: terminal fallback zero-item không bị watchdog hồi sinh (32 items → 2 sends thay vì 4)', async () => {
  const env = setupDomEnvironment();
  try {
    // 32 items divided into 2 chunks of 16.
    // Responses return zero-item error with fallbackConsumed: true and rawHead containing results trace
    env.setBatchResponseHandler((msg, cb) => {
      setTimeout(() => {
        cb({
          error: {
            code: 'INVALID_SCHEMA',
            message: 'Translated content missing results array',
            details: {
              zeroItem: true,
              fallbackConsumed: true,
              contentBytes: 15,
              rawHead: '{"results": []}'
            }
          },
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

    // Initial batch dispatch triggers 2 chunks of 16
    dom.flushReadyBlocks();

    // Wait enough time for watchdog reconciliation rounds to fire
    await new Promise((r) => setTimeout(r, 150));

    // Must NOT requeue because fallback is already consumed (terminal state)
    const translateSends = env.sentMessages.filter((m) => m?.action === 'TRANSLATE_BATCH');
    assert.equal(
      translateSends.length,
      2,
      `32 items with terminal fallbackConsumed must produce exactly 2 batch sends, got ${translateSends.length} (must not be 4)`
    );

    const status = dom.getStatus();
    assert.equal(status.stable, true, 'Status must be marked stable');
    assert.equal(status.totalFailed, 32, 'totalFailed must show all 32 items failed');
    assert.equal(sess.failedIds.size, 32, 'failedIds must record all 32 items permanently in this run');
    assert.equal(sess.fallbackConsumedIds.size, 32, 'fallbackConsumedIds must track all 32 items');

    // Starting a new user session clears fallbackConsumedIds and restarts from primary
    dom.startScrollFollowSession({ watchdogBackoffMs: 10 });
    assert.equal(sess.failedIds.size, 0, 'New user session must clear failedIds');
    assert.equal(sess.fallbackConsumedIds.size, 0, 'New user session must clear fallbackConsumedIds');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 2. F2 Repro: error-JSON-terminal
// ============================================================================
test('F2 repro: error-JSON hoàn chỉnh terminal ngay, không exhausted, không fallback', async () => {
  // 1. Adapter level: direct9router processes complete error JSON {"error":"Unauthorized"}
  const items = [];
  for (let i = 0; i < 16; i++) {
    items.push({ id: `item_${i}`, revision: 0, text: `Sentence ${i}` });
  }

  let callCount = 0;
  const enc = new TextEncoder();
  const fetchImpl = async (url, opts) => {
    callCount++;
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
    model: 'primary-model',
    fetchImpl,
    ...fastOptions
  });

  const res = await router.translateBatch({ items });
  assert.ok(res.error, 'Must return error on unauthorized JSON');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
  assert.equal(res.error.details.isErrorJson, true, 'Must identify isErrorJson: true');
  assert.equal(res.error.details.zeroItem, false, 'Must NOT be marked zeroItem');
  assert.notEqual(res.error.details.exhausted, true, 'Must NOT have exhausted: true');
  assert.equal(callCount, 1, 'Must execute exactly 1 call without bisecting');

  // 2. Fallback resolution level: error JSON must STOP immediately, never fallback
  const chain = ['primary-model', 'fallback-1', 'fallback-2'];
  const plan = resolveFallbackPlan(res.error, chain, 0);
  assert.equal(plan.shouldFallback, false, 'Error JSON must not trigger fallback');
  assert.equal(plan.reason, 'STOP_LIST', 'Must stop on STOP_LIST');

  // Also test with raw error envelope
  const rawErrJson = {
    error: {
      code: 'INVALID_SCHEMA',
      message: 'Provider returned error JSON response',
      details: {
        rawHead: '{"error":"Unauthorized"}',
        isErrorJson: true,
        exhausted: false
      }
    }
  };
  const plan2 = resolveFallbackPlan(rawErrJson, chain, 0);
  assert.equal(plan2.shouldFallback, false);
  assert.equal(plan2.reason, 'STOP_LIST');
});

// ============================================================================
// 3. F3 Repro: applied-không-reset
// ============================================================================
test('F3 repro: streamed fallback results cumulative accounting không bị reset về 0 (applied: 32)', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const collected = dom.collect();
    assert.equal(collected.length, 32, 'Must collect 32 nodes');

    // Simulate batch response handler:
    // First, when TRANSLATE_BATCH arrives, progressive streaming pushes all 32 items via TRANSLATE_PROGRESS
    // Then TRANSLATE_BATCH resolves with final results
    env.setBatchResponseHandler((msg, cb) => {
      const batchItems = msg.payload?.items || [];
      const currentEpoch = msg.epoch || 1;

      // Simulate progressive streamed delivery
      for (const item of batchItems) {
        env.dispatchRuntimeMessage({
          action: 'TRANSLATE_PROGRESS',
          epoch: currentEpoch,
          item: {
            id: item.id,
            revision: item.revision,
            text: `[DICH] ${item.text}`
          }
        });
      }

      // Check that progressive application applied the nodes to the DOM
      const curStatus = dom.getStatus();
      assert.ok(curStatus.progressApplied > 0, 'Progress applied must be > 0');

      // Then SW completes and sends final response containing all results
      setTimeout(() => {
        cb({
          ok: true,
          results: batchItems.map((it) => ({
            id: it.id,
            revision: it.revision,
            text: `[DICH] ${it.text}`
          })),
          actualModel: 'fallback-model',
          fallbackIndex: 1
        });
      }, 5);
    });

    // Run full-page translation
    const runRes = await dom.executeTranslation({ model: 'primary-model' });

    assert.equal(runRes.ok, true, 'Run must succeed');
    assert.equal(runRes.collected, 32, 'Must collect 32');
    assert.equal(runRes.applied, 32, 'Final applied must be 32, never overwritten to 0');
    assert.equal(runRes.failed, 0, 'Failed must be 0');

    const finalStatus = dom.getStatus();
    assert.equal(finalStatus.totalApplied, 32, 'lastTranslateStatus.totalApplied must be 32, not 0');
    assert.equal(finalStatus.totalCollected, 32, 'totalCollected must be 32');

    // Verify DOM nodes actually have translated values
    for (const node of env.nodes) {
      assert.match(node.nodeValue, /^\[DICH\]/, 'Node values must be translated');
    }
  } finally {
    env.restore();
  }
});

// ============================================================================
// 4. F4 Repro: log-đúng-model
// ============================================================================
test('F4 repro: log terminal fallback ghi đúng model fallback đã thử cuối cùng thay vì model primary', async () => {
  const savedChrome = globalThis.chrome;
  const mockChrome = makeChromeStub({
    local: {
      settings: {
        baseURL: 'http://127.0.0.1:9090/v1',
        model: 'model-primary-gemini',
        fallbacks: [
          { id: 'fb1', model: 'model-fallback-claude' }
        ],
        cacheEnabled: false
      },
      sites: { 'http://127.0.0.1:8091': { createdAt: Date.now() } },
      api_key: 'sk-test-key'
    },
    session: {}
  });

  globalThis.chrome = mockChrome;
  _setTestMode(true);
  _setTestPermission('http://127.0.0.1:8091', true);
  _registerTestTab(103, 'http://127.0.0.1:8091/page.html');
  await clearErrorLog();

  const attempts = [];
  _setTranslateBatchForTest(async (input) => {
    attempts.push(input.model);
    // Both primary and fallback return zero-item exhausted error
    return {
      error: {
        code: 'INVALID_SCHEMA',
        message: 'Translated content missing results array',
        retryable: false,
        details: { zeroItem: true, exhausted: true }
      }
    };
  });

  try {
    const items = [
      { id: 'item_1', revision: 0, text: 'First line to translate' },
      { id: 'item_2', revision: 0, text: 'Second line to translate' }
    ];

    const payload = { items, sourceLanguage: 'auto', targetLanguage: 'vi' };
    const res = await executeBatchTranslation({
      payload,
      misses: items.map((it, idx) => ({ index: idx, item: it, key: `k_${it.id}` })),
      hits: [],
      tabId: 103,
      epoch: 1,
      origin: 'http://127.0.0.1:8091'
    });

    assert.ok(res.error, 'Must return terminal error');
    assert.equal(res.error.code, 'INVALID_SCHEMA');
    assert.equal(res.error.details.fallbackConsumed, true);

    // Verify attempts made
    assert.deepEqual(attempts, ['model-primary-gemini', 'model-fallback-claude']);

    // Check error details: must record the last attempted model (fallback model)
    assert.equal(
      res.error.details.model,
      'model-fallback-claude',
      `Error details must record last attempted model 'model-fallback-claude', got '${res.error.details.model}'`
    );
    assert.equal(
      res.error.details.lastAttemptedModel,
      'model-fallback-claude',
      `Error details lastAttemptedModel must be 'model-fallback-claude'`
    );

    // Check recorded error log: terminal entry must be logged under 'model-fallback-claude'
    const logs = await getErrorLog();
    assert.ok(logs.length > 0, 'Must have recorded error logs');
    const terminalEntry = logs[0]; // unshifted to head
    assert.equal(
      terminalEntry.model,
      'model-fallback-claude',
      `Terminal log must record 'model-fallback-claude', got '${terminalEntry.model}' (must not be 'model-primary-gemini')`
    );
  } finally {
    _setTestMode(false);
    globalThis.chrome = savedChrome;
  }
});
