// WebMCP Translator Kit — WI-36 Unit & Repro Tests
// Fix 1 finding Sol round 19 (wi1115-sol-verdict19.md):
// Bug: Recovery ignores terminal error.details.fallbackConsumed when fallback returns retryable NETWORK,
// then retries and bisects from primary (32 items -> 12 sends, 24 attempts).
// Fix: Batch has fallbackConsumed -> tied to fallback model for remainder of run; retryable error (NETWORK/TIMEOUT)
// is retried only on SAME fallback model within existing retry budget (no budget reset, no bisecting from primary,
// no secondary escalation, no return to primary). Budget exhausted -> terminal. Abort stops immediately.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  resolveFallbackPlan,
  resolveFallbackChain,
  executeBatchTranslation,
  _setTranslateBatchForTest,
  _setTestMode,
  _setTestPermission,
  _registerTestTab,
  getErrorLog,
  clearErrorLog
} from '../extension/src/sw.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    id: 'test-ext-wi36',
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
// 1. Sol Round 19 Exact Repro: fallback NETWORK -> retry in budget on same model -> terminal
// ============================================================================
test('WI-36 repro: fallback-NETWORK → retry cùng model trong budget → terminal, tổng sends bounded, không restart primary', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const items = Array.from({ length: 32 }, (_, i) => ({
      id: `item-${i}`,
      text: `Text item number ${i}`,
      revision: 0
    }));

    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';

    const recordedBatches = [];
    let providerAttempts = 0;

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      recordedBatches.push({
        action: msg.action,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        itemCount: payload.items?.length || 0
      });

      if (recordedBatches.length === 1) {
        // Send 1: SW simulates primary failing, then falling back to fallbackModel
        // Provider attempts: 1 (primary) + 1 (fallback) = 2 attempts
        providerAttempts += 2;
        cb({
          error: {
            code: 'NETWORK',
            message: 'Network connection reset by peer',
            retryable: true,
            details: {
              fallbackConsumed: true,
              model: fallbackModel,
              lastAttemptedModel: fallbackModel,
              fromModel: primaryModel,
              toModel: fallbackModel
            }
          }
        });
      } else if (recordedBatches.length === 2) {
        // Send 2: retry within budget. Must be on fallbackModel with fallbackConsumed: true
        // SW simulates single attempt on fallbackModel (no second fallback)
        providerAttempts += 1;
        cb({
          error: {
            code: 'NETWORK',
            message: 'Network connection reset by peer on retry',
            retryable: true,
            details: {
              fallbackConsumed: true,
              model: fallbackModel,
              lastAttemptedModel: fallbackModel
            }
          }
        });
      } else {
        // If the bug were present, sends 3..12 would happen
        providerAttempts += 2;
        cb({
          error: {
            code: 'NETWORK',
            message: 'Unexpected extra send',
            retryable: true,
            details: { fallbackConsumed: true, model: fallbackModel }
          }
        });
      }
    });

    const res = await dom.translateChunkWithRecovery(
      items,
      { model: primaryModel, sourceLanguage: 'auto', targetLanguage: 'vi' },
      0,
      dom.getEpoch()
    );

    // Assertions matching acceptance criteria:
    // 1. Total sends bounded to exactly 2 (Send 1 + Send 2 retry in budget), NOT 12 sends
    assert.equal(recordedBatches.length, 2, `Total sends must be bounded to 2, got ${recordedBatches.length}`);

    // 2. Send 1 was initiated with primaryModel
    assert.equal(recordedBatches[0].model, primaryModel, 'Send 1 must be on primary model');
    assert.equal(recordedBatches[0].fallbackConsumed, false, 'Send 1 must not have fallbackConsumed');
    assert.equal(recordedBatches[0].itemCount, 32, 'Send 1 must have all 32 items');

    // 3. Send 2 was retried on CÙNG model fallback, NOT restarting primary!
    assert.equal(recordedBatches[1].model, fallbackModel, 'Send 2 retry must be bound to fallback model, NOT primary');
    assert.equal(recordedBatches[1].fallbackConsumed, true, 'Send 2 must pass fallbackConsumed: true');
    assert.equal(recordedBatches[1].itemCount, 32, 'Send 2 must retry full 32 items (no bisecting)');

    // 4. Provider attempts bounded to 3 (2 on Send 1, 1 on Send 2), NOT 24 attempts
    assert.equal(providerAttempts, 3, `Provider attempts must be bounded to 3, got ${providerAttempts}`);

    // 5. Result is terminal: fatal: true, failed: 32, applied: 0
    assert.equal(res.fatal, true, 'Exhausted retry budget on fallbackConsumed must be terminal (fatal: true)');
    assert.equal(res.applied, 0, 'Applied count must be 0');
    assert.equal(res.failed, 32, 'Failed count must equal item count (32)');
    assert.equal(res.error?.code, 'NETWORK', 'Error must preserve last error code');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 2. Successful retry in budget on fallback model
// ============================================================================
test('WI-36: fallback-NETWORK → retry cùng model fallback trong budget SUCCEEDS → applies results cleanly', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const collected = dom.collect();
    const items = collected.slice(0, 16);

    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';
    const recordedBatches = [];

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      recordedBatches.push({
        action: msg.action,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        itemCount: payload.items?.length || 0
      });

      if (recordedBatches.length === 1) {
        // Send 1 fails on fallback with NETWORK
        setTimeout(() => {
          cb({
            error: {
              code: 'NETWORK',
              message: 'Temporary connection glitch',
              retryable: true,
              details: {
                fallbackConsumed: true,
                model: fallbackModel,
                lastAttemptedModel: fallbackModel
              }
            }
          });
        }, 5);
      } else {
        // Send 2 retries on fallbackModel and succeeds
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH] ${it.text}`
            })),
            actualModel: fallbackModel,
            fallbackIndex: 1
          });
        }, 5);
      }
    });

    const res = await dom.translateChunkWithRecovery(
      items,
      { model: primaryModel, sourceLanguage: 'auto', targetLanguage: 'vi' },
      0,
      dom.getEpoch()
    );

    assert.equal(recordedBatches.length, 2, 'Must execute exactly 2 sends (1 initial + 1 retry)');
    assert.equal(recordedBatches[1].model, fallbackModel, 'Retry must be on fallback model');
    assert.equal(recordedBatches[1].fallbackConsumed, true, 'Retry must have fallbackConsumed: true');
    assert.equal(res.applied, 16, 'All 16 items must be applied');
    assert.equal(res.failed, 0, 'Zero failed items');
    assert.equal(dom.getStatus().actualModel, fallbackModel, 'actualModel must reflect fallback model');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 3. Fallback TIMEOUT retry in budget -> terminal
// ============================================================================
test('WI-36: fallback-TIMEOUT → retry cùng model trong budget → terminal, bounded 2 sends', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const items = Array.from({ length: 32 }, (_, i) => ({
      id: `timeout-item-${i}`,
      text: `Timeout text ${i}`,
      revision: 0
    }));

    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';
    const recordedBatches = [];

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      recordedBatches.push({
        action: msg.action,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed)
      });

      setTimeout(() => {
        cb({
          error: {
            code: 'TIMEOUT',
            message: 'Upstream gateway timed out',
            retryable: false, // TIMEOUT is retryable via isNonRetryable rule
            details: {
              fallbackConsumed: true,
              model: fallbackModel,
              lastAttemptedModel: fallbackModel
            }
          }
        });
      }, 5);
    });

    const res = await dom.translateChunkWithRecovery(
      items,
      { model: primaryModel, sourceLanguage: 'auto', targetLanguage: 'vi' },
      0,
      dom.getEpoch()
    );

    assert.equal(recordedBatches.length, 2, 'TIMEOUT on fallback must retry once then terminate, bounded to 2 sends');
    assert.equal(recordedBatches[1].model, fallbackModel, 'Retry must be on fallback model');
    assert.equal(recordedBatches[1].fallbackConsumed, true, 'Retry must have fallbackConsumed: true');
    assert.equal(res.fatal, true, 'Must terminate with fatal: true');
    assert.equal(res.failed, 32, 'All 32 items failed');
    assert.equal(res.error?.code, 'TIMEOUT');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 4. Multi-chunk run binds subsequent chunks to fallback model for remainder of run
// ============================================================================
test('WI-36: runConfig binds subsequent chunks to fallback model without restarting primary', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const collected = dom.collect();
    const chunk1 = collected.slice(0, 16);
    const chunk2 = collected.slice(16, 32);

    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';
    const recordedBatches = [];

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      recordedBatches.push({
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        firstId: payload.items?.[0]?.id
      });

      setTimeout(() => {
        if (payload.items?.[0]?.id === chunk1[0].id) {
          // Chunk 1 succeeds on fallback model
          cb({
            ok: true,
            results: payload.items.map((it) => ({ id: it.id, revision: it.revision, text: `[DICH] ${it.text}` })),
            actualModel: fallbackModel,
            fallbackIndex: 1,
            fallbackConsumed: true
          });
        } else {
          // Chunk 2: must receive fallbackModel directly
          cb({
            ok: true,
            results: payload.items.map((it) => ({ id: it.id, revision: it.revision, text: `[DICH] ${it.text}` })),
            actualModel: fallbackModel,
            fallbackIndex: 1
          });
        }
      }, 5);
    });

    const runConfig = { revision: null };

    // Chunk 1 execution
    const res1 = await dom.translateChunkWithRecovery(
      chunk1,
      { model: primaryModel, sourceLanguage: 'auto', targetLanguage: 'vi' },
      0,
      dom.getEpoch(),
      runConfig
    );
    assert.equal(res1.applied, 16);
    assert.equal(runConfig.fallbackConsumed, true, 'runConfig must track fallbackConsumed: true');
    assert.equal(runConfig.model, fallbackModel, 'runConfig must track fallback model');

    // Chunk 2 execution with shared runConfig
    const res2 = await dom.translateChunkWithRecovery(
      chunk2,
      {
        model: runConfig.model || primaryModel,
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        ...(runConfig.fallbackConsumed ? { fallbackConsumed: true } : {})
      },
      0,
      dom.getEpoch(),
      runConfig
    );
    assert.equal(res2.applied, 16);

    // Chunk 2 was sent with fallbackModel directly, never restarting primary
    const chunk2Send = recordedBatches.find((b) => b.firstId === chunk2[0].id);
    assert.ok(chunk2Send, 'Chunk 2 send must be recorded');
    assert.equal(chunk2Send.model, fallbackModel, 'Chunk 2 must start with fallbackModel, not primaryModel');
    assert.equal(chunk2Send.fallbackConsumed, true, 'Chunk 2 must have fallbackConsumed: true');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 5. Abort stops immediately at all times
// ============================================================================
test('WI-36: epoch change/abort halts immediately without retry or fallback loop', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const items = Array.from({ length: 32 }, (_, i) => ({
      id: `abort-item-${i}`,
      text: `Abort text ${i}`,
      revision: 0
    }));

    let sends = 0;
    const targetEpoch = dom.getEpoch();

    env.setBatchResponseHandler((msg, cb) => {
      sends++;
      // Simulate user abort / epoch cancellation while request is in flight
      dom.restore();
      cb({
        error: {
          code: 'NETWORK',
          message: 'Connection reset',
          retryable: true,
          details: { fallbackConsumed: true, model: 'ag/fallback' }
        }
      });
    });

    const res = await dom.translateChunkWithRecovery(
      items,
      { model: 'ag/primary', sourceLanguage: 'auto', targetLanguage: 'vi' },
      0,
      targetEpoch
    );

    assert.equal(res.cancelled, true, 'Must return cancelled: true');
    assert.equal(sends, 1, 'Must stop after exactly 1 send without retry');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 6. SW level: payload.fallbackConsumed enforces single attempt on fallback model
// ============================================================================
test('WI-36 (sw integration): payload.fallbackConsumed binds to fallback model and stops on error (1 attempt)', async () => {
  const savedChrome = globalThis.chrome;
  const mockStorage = {
    local: {
      settings: {
        baseURL: 'http://127.0.0.1:9090/v1',
        model: 'primary-model',
        fallbacks: [
          { id: 'fb1', model: 'fallback-claude', baseURL: 'http://127.0.0.1:9090/v1' }
        ],
        cacheEnabled: false
      },
      sites: { 'http://127.0.0.1:8091': { createdAt: Date.now() } },
      api_key: 'sk-test'
    },
    session: {}
  };

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

  globalThis.chrome = {
    storage: { local: area(mockStorage.local), session: area(mockStorage.session), onChanged: { addListener() {} } },
    tabs: { sendMessage: async () => ({}), query: async () => [], get: async () => ({ id: 101, url: 'http://127.0.0.1:8091/p.html' }) },
    runtime: { id: 'test-sw-wi36', lastError: null, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
    permissions: { contains: async () => true, request: async () => true, onRemoved: { addListener() {} } }
  };

  _setTestMode(true);
  _setTestPermission('http://127.0.0.1:8091', true);
  _registerTestTab(101, 'http://127.0.0.1:8091/p.html');
  await clearErrorLog();

  const swAttempts = [];
  _setTranslateBatchForTest(async (input) => {
    swAttempts.push(input.model);
    return {
      error: {
        code: 'NETWORK',
        message: 'Simulated network drop on retry',
        retryable: true
      }
    };
  });

  try {
    const res = await executeBatchTranslation(
      {
        action: 'TRANSLATE_BATCH',
        epoch: 1,
        payload: {
          items: [{ id: 'item-1', text: 'Hello', revision: 0 }],
          model: 'fallback-claude',
          fallbackConsumed: true,
          sourceLanguage: 'en',
          targetLanguage: 'vi'
        }
      },
      101,
      'http://127.0.0.1:8091',
      1
    );

    // SW must make EXACTLY 1 attempt on fallback-claude, never ping-pong to primary-model
    assert.equal(swAttempts.length, 1, `SW must make exactly 1 attempt, got ${swAttempts.length}: ${JSON.stringify(swAttempts)}`);
    assert.equal(swAttempts[0], 'fallback-claude', 'SW attempt must be on fallback-claude');
    assert.equal(res.error?.code, 'NETWORK', 'SW must return the network error');
    assert.equal(res.error?.details?.fallbackConsumed, true, 'SW must flag fallbackConsumed: true');
    assert.equal(res.error?.details?.model, 'fallback-claude', 'SW error details must show fallback-claude');
  } finally {
    _setTranslateBatchForTest(null);
    globalThis.chrome = savedChrome;
  }
});
