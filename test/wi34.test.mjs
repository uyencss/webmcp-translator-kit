// WebMCP Translator Kit — WI-34 Unit Tests
// Delta: zero-item dai dẳng được leo fallback chain (exhausted bisect + watchdog)
// Acceptance:
// 1. exhausted-zero-item → fallback 1 lần → merge applied
// 2. fallback-zero-item → terminal không loop
// 3. INVALID_SCHEMA thường (no exhausted flag) → vẫn STOP không fallback
// 4. chain rỗng → terminal
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDirect9Router } from '../extension/src/adapter/direct9router.mjs';
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
  STOP_ERROR_CODES,
  FALLBACK_ELIGIBLE_CODES
} from '../extension/src/sw.js';

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
      local: area(store.local),
      session: area(store.session),
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
      id: 'test-ext-wi34',
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

// ============================================================================
// 1. Unit Tests: resolveFallbackPlan
// ============================================================================
test('WI-34 (unit): exhausted-zero-item on primary advances to fallback model exactly once', () => {
  const chain = ['model-primary', 'model-fb1', 'model-fb2'];
  const exhaustedErr = {
    error: {
      code: 'INVALID_SCHEMA',
      message: 'Translated content missing results array',
      details: { zeroItem: true, exhausted: true }
    }
  };

  // Attempt 0: Primary exhausted zero-item -> advances to fb1 (index 1)
  const plan = resolveFallbackPlan(exhaustedErr, chain, 0);
  assert.equal(plan.shouldFallback, true);
  assert.equal(plan.nextIndex, 1);
  assert.equal(plan.nextModel, 'model-fb1');
});

test('WI-34 (unit): fallback-zero-item is terminal and does NOT loop (no ping-pong, no second fallback)', () => {
  const chain = ['model-primary', 'model-fb1', 'model-fb2'];
  const fbZeroErr = {
    error: {
      code: 'INVALID_SCHEMA',
      message: 'Translated content missing results array',
      details: { zeroItem: true, exhausted: true }
    }
  };

  // Attempt 1: Already at fallback model fb1 -> must not fall back to fb2 or ping-pong to primary
  const plan1 = resolveFallbackPlan(fbZeroErr, chain, 1);
  assert.equal(plan1.shouldFallback, false);
  assert.equal(plan1.reason, 'FALLBACK_CONSUMED');
  assert.deepEqual(plan1.terminalError, fbZeroErr);

  // If fallbackConsumed is flagged explicitly
  const planConsumed = resolveFallbackPlan(fbZeroErr, chain, 0, { fallbackConsumed: true });
  assert.equal(planConsumed.shouldFallback, false);
  assert.equal(planConsumed.reason, 'FALLBACK_CONSUMED');
  assert.deepEqual(planConsumed.terminalError, fbZeroErr);
});

test('WI-34 (unit): INVALID_SCHEMA thường (no exhausted flag) still STOPs immediately without fallback', () => {
  const chain = ['model-primary', 'model-fb1'];

  // Regular schema error: no details.exhausted
  const regularSchemaErr1 = {
    error: {
      code: 'INVALID_SCHEMA',
      message: 'Provider returned HTTP 400',
      details: { status: 400 }
    }
  };
  const plan1 = resolveFallbackPlan(regularSchemaErr1, chain, 0);
  assert.equal(plan1.shouldFallback, false);
  assert.equal(plan1.reason, 'STOP_LIST');
  assert.deepEqual(plan1.terminalError, regularSchemaErr1);

  // Malformed JSON error
  const regularSchemaErr2 = {
    error: {
      code: 'INVALID_SCHEMA',
      message: 'Provider response is not valid JSON',
      details: { schemaErrors: ['Malformed outer response JSON'] }
    }
  };
  const plan2 = resolveFallbackPlan(regularSchemaErr2, chain, 0);
  assert.equal(plan2.shouldFallback, false);
  assert.equal(plan2.reason, 'STOP_LIST');

  // Schema validation failure (missing id/text/revision)
  const regularSchemaErr3 = {
    error: {
      code: 'INVALID_SCHEMA',
      message: 'Result item schema validation failed',
      details: { schemaErrors: ['Result item missing id, revision, or text string'] }
    }
  };
  const plan3 = resolveFallbackPlan(regularSchemaErr3, chain, 0);
  assert.equal(plan3.shouldFallback, false);
  assert.equal(plan3.reason, 'STOP_LIST');
});

test('WI-34 (unit): chain rỗng terminates immediately on exhausted zero-item', () => {
  const exhaustedErr = {
    error: {
      code: 'INVALID_SCHEMA',
      message: 'Translated content missing results array',
      details: { zeroItem: true, exhausted: true }
    }
  };

  // Single primary model, no fallbacks configured
  const chainSingle = ['model-primary'];
  const planSingle = resolveFallbackPlan(exhaustedErr, chainSingle, 0);
  assert.equal(planSingle.shouldFallback, false);
  assert.equal(planSingle.reason, 'NO_FALLBACK_MODELS');
  assert.deepEqual(planSingle.terminalError, exhaustedErr);

  // Empty chain
  const planEmpty = resolveFallbackPlan(exhaustedErr, [], 0);
  assert.equal(planEmpty.shouldFallback, false);
  assert.equal(planEmpty.reason, 'NO_FALLBACK_MODELS');
});

// ============================================================================
// 2. Integration Tests: executeBatchTranslation
// ============================================================================
test('WI-34 (integration): exhausted-zero-item → fallback 1 lần → merge applied and log model change', async () => {
  const savedChrome = globalThis.chrome;
  const mockChrome = makeChromeStub({
    local: {
      settings: {
        baseURL: 'http://127.0.0.1:9090/v1',
        model: 'primary-flash-low',
        fallbacks: [
          { id: 'fb1', model: 'fallback-gemini-pro' }
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
  _registerTestTab(101, 'http://127.0.0.1:8091/page.html');
  await clearErrorLog();

  const calls = [];
  _setTranslateBatchForTest(async (input) => {
    calls.push({ model: input.model, count: input.items?.length });
    if (input.model === 'primary-flash-low') {
      // Primary model fails with exhausted zero-item
      return {
        error: {
          code: 'INVALID_SCHEMA',
          message: 'Translated content missing results array',
          retryable: false,
          details: { zeroItem: true, exhausted: true, rawHead: '', contentBytes: 50 }
        }
      };
    }
    if (input.model === 'fallback-gemini-pro') {
      // Fallback model succeeds
      return {
        ok: true,
        results: input.items.map((it) => ({
          id: it.id,
          revision: it.revision,
          text: `[vi] ${it.text}`
        })),
        model: 'fallback-gemini-pro'
      };
    }
    throw new Error(`Unexpected model: ${input.model}`);
  });

  try {
    const items = [
      { id: 'item_1', revision: 0, text: 'First line to translate' },
      { id: 'item_2', revision: 0, text: 'Second line to translate' },
      { id: 'item_3', revision: 0, text: 'Third line to translate' }
    ];

    const res = await executeBatchTranslation({
      payload: { items, sourceLanguage: 'auto', targetLanguage: 'vi' },
      misses: items.map((it, idx) => ({ index: idx, item: it, key: `k_${it.id}` })),
      hits: [],
      tabId: 101,
      epoch: 1,
      origin: 'http://127.0.0.1:8091'
    });

    assert.ok(!res.error, `Must succeed via fallback, got: ${JSON.stringify(res.error)}`);
    assert.equal(res.results.length, 3, 'All 3 items must be translated');
    assert.equal(res.actualModel, 'fallback-gemini-pro', 'actualModel must reflect fallback model');
    assert.equal(res.fallbackIndex, 1, 'fallbackIndex must be 1');
    assert.equal(res.failed, 0, 'Zero failed items');

    // Verify calls: primary tried first, then fallback tried
    assert.equal(calls.length, 2, 'Must make exactly 2 calls: primary then fallback');
    assert.equal(calls[0].model, 'primary-flash-low');
    assert.equal(calls[1].model, 'fallback-gemini-pro');

    // Verify errorLog recorded the model change entry
    const logs = await getErrorLog();
    const fallbackLog = logs.find((l) => l.code === 'INVALID_SCHEMA' || l.code === 'MODEL_FALLBACK');
    assert.ok(fallbackLog, 'Error log must contain fallback transition entry');
    assert.ok(
      fallbackLog.message.includes('fallback-gemini-pro'),
      `Log message must specify new model, got: ${fallbackLog.message}`
    );
  } finally {
    _setTestMode(false);
    globalThis.chrome = savedChrome;
  }
});

test('WI-34 (integration): fallback-zero-item → terminal error without loop', async () => {
  const savedChrome = globalThis.chrome;
  const mockChrome = makeChromeStub({
    local: {
      settings: {
        baseURL: 'http://127.0.0.1:9090/v1',
        model: 'primary-flash-low',
        fallbacks: [
          { id: 'fb1', model: 'fallback-gemini-pro' }
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
  _registerTestTab(102, 'http://127.0.0.1:8091/page.html');
  await clearErrorLog();

  const calls = [];
  _setTranslateBatchForTest(async (input) => {
    calls.push({ model: input.model });
    // Both primary and fallback return zero-item error
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
      { id: 'item_1', revision: 0, text: 'Sample text 1' },
      { id: 'item_2', revision: 0, text: 'Sample text 2' }
    ];

    const payload = { items, sourceLanguage: 'auto', targetLanguage: 'vi' };
    const res = await executeBatchTranslation({
      payload,
      misses: items.map((it, idx) => ({ index: idx, item: it, key: `k_${it.id}` })),
      hits: [],
      tabId: 102,
      epoch: 1,
      origin: 'http://127.0.0.1:8091'
    });

    assert.ok(res.error, 'Must return terminal error');
    assert.equal(res.error.code, 'INVALID_SCHEMA');
    assert.equal(res.error.details.fallbackConsumed, true, 'Must have fallbackConsumed: true');
    assert.equal(payload.fallbackConsumed, true, 'Payload must be marked fallbackConsumed');

    // Verify calls: exactly 2 calls (primary once, fallback once, never looping back)
    assert.equal(calls.length, 2, `Must make exactly 2 calls without loop, got ${calls.length}`);
    assert.equal(calls[0].model, 'primary-flash-low');
    assert.equal(calls[1].model, 'fallback-gemini-pro');
  } finally {
    _setTestMode(false);
    globalThis.chrome = savedChrome;
  }
});

test('WI-34 (integration): INVALID_SCHEMA thường (no exhausted flag) → STOP ngay không fallback', async () => {
  const savedChrome = globalThis.chrome;
  const mockChrome = makeChromeStub({
    local: {
      settings: {
        baseURL: 'http://127.0.0.1:9090/v1',
        model: 'primary-flash-low',
        fallbacks: [
          { id: 'fb1', model: 'fallback-gemini-pro' }
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

  const calls = [];
  _setTranslateBatchForTest(async (input) => {
    calls.push({ model: input.model });
    return {
      error: {
        code: 'INVALID_SCHEMA',
        message: 'Provider returned HTTP 400',
        retryable: false,
        details: { status: 400, schemaErrors: ['HTTP_400'] } // No exhausted flag
      }
    };
  });

  try {
    const items = [{ id: 'item_1', revision: 0, text: 'Sample text' }];
    const res = await executeBatchTranslation({
      payload: { items },
      misses: [{ index: 0, item: items[0], key: 'k1' }],
      hits: [],
      tabId: 103,
      epoch: 1,
      origin: 'http://127.0.0.1:8091'
    });

    assert.ok(res.error, 'Must return error');
    assert.equal(res.error.code, 'INVALID_SCHEMA');
    assert.equal(calls.length, 1, 'Must ONLY call primary model, never fall back on standard INVALID_SCHEMA');
    assert.equal(calls[0].model, 'primary-flash-low');
  } finally {
    _setTestMode(false);
    globalThis.chrome = savedChrome;
  }
});

test('WI-34 (integration): chain rỗng → terminal immediately on exhausted zero-item', async () => {
  const savedChrome = globalThis.chrome;
  const mockChrome = makeChromeStub({
    local: {
      settings: {
        baseURL: 'http://127.0.0.1:9090/v1',
        model: 'primary-flash-low',
        fallbacks: [], // Empty fallbacks
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
  _registerTestTab(104, 'http://127.0.0.1:8091/page.html');
  await clearErrorLog();

  const calls = [];
  _setTranslateBatchForTest(async (input) => {
    calls.push({ model: input.model });
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
    const items = [{ id: 'item_1', revision: 0, text: 'Sample text' }];
    const res = await executeBatchTranslation({
      payload: { items },
      misses: [{ index: 0, item: items[0], key: 'k1' }],
      hits: [],
      tabId: 104,
      epoch: 1,
      origin: 'http://127.0.0.1:8091'
    });

    assert.ok(res.error, 'Must return error');
    assert.equal(res.error.code, 'INVALID_SCHEMA');
    assert.equal(calls.length, 1, 'Must only call primary model once when chain has no fallbacks');
  } finally {
    _setTestMode(false);
    globalThis.chrome = savedChrome;
  }
});

// ============================================================================
// 3. Adapter Tests: direct9router marks exhausted: true on zero-item ONLY
// ============================================================================
test('WI-34 (adapter): direct9router marks exhausted: true on zero-item SSE stream', async () => {
  const enc = new TextEncoder();
  const fetchImpl = async () => {
    // SSE stream with 0 items
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"other": 123}' } }] })}\n\n`,
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

  const res = await router.translateBatch({
    items: [{ id: 'it1', revision: 0, text: 'Hello world' }]
  });

  assert.ok(res.error, 'Must return error');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
  assert.equal(res.error.details.exhausted, true, 'Adapter must mark exhausted: true on zero-item error');
  assert.equal(res.error.details.zeroItem, true, 'Adapter must mark zeroItem: true');
});

test('WI-34 (adapter): direct9router does NOT mark exhausted on standard HTTP 400 error', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => JSON.stringify({ error: { message: 'Invalid prompt parameter' } })
  });

  const router = createDirect9Router({
    baseURL: 'http://127.0.0.1:9090/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.8-flash',
    fetchImpl,
    ...fastOptions
  });

  const res = await router.translateBatch({
    items: [{ id: 'it1', revision: 0, text: 'Hello world' }]
  });

  assert.ok(res.error, 'Must return error');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
  assert.equal(res.error.details.exhausted, undefined, 'Must NOT mark exhausted on standard HTTP 400 error');
});
