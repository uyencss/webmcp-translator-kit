// WebMCP Translator Kit — WI-18 Unit Tests
// Fix 2 findings from Sol re-review round 3 (wi1115-sol-verdict3.md):
// 1. F-HIGH: clear nuốt lỗi + enqueue chen ngang lúc clear đang await
//    (a) remove fail 2 lần → memory-only, reads miss;
//    (b) enqueue trong lúc clear-await → bị drop;
// 2. F-MED: entry.key còn literal baseURL/model
//    (c) stored entry không chứa http/model literal, hit đúng chỉ khi key khớp.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  L2_CACHE_KEY,
  cacheKey,
  hashText,
  PROMPT_VERSION
} from '../extension/src/cache.mjs';
import {
  enqueueL2Cache,
  flushL2Cache,
  clearL2Cache,
  getL2Epoch,
  isL2MemoryOnly,
  _setL2MemoryOnlyForTest
} from '../extension/src/sw.js';
import { createFakeProvider } from './helpers/fake-provider.mjs';

function makeChromeStub(store, { onBeforeRemove, onRemove, onSet } = {}) {
  const local = {
    get: async (keys) => {
      if (!keys) return { ...store.local };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) {
        if (typeof k === 'string' && k in store.local) {
          out[k] = store.local[k];
        }
      }
      return out;
    },
    set: async (obj) => {
      if (typeof onSet === 'function') {
        await onSet(obj);
      }
      Object.assign(store.local, obj);
    },
    remove: async (keys) => {
      if (typeof onBeforeRemove === 'function') {
        await onBeforeRemove(keys);
      }
      if (typeof onRemove === 'function') {
        await onRemove(keys);
      }
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        delete store.local[k];
      }
    },
    clear: async () => {
      for (const k of Object.keys(store.local)) {
        delete store.local[k];
      }
    },
    setAccessLevel: async () => {},
    getAccessLevel: async () => 'TRUSTED_CONTEXTS'
  };

  const session = {
    get: async (keys) => {
      if (!keys) return { ...store.session };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) {
        if (typeof k === 'string' && k in store.session) {
          out[k] = store.session[k];
        }
      }
      return out;
    },
    set: async (obj) => {
      Object.assign(store.session, obj);
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        delete store.session[k];
      }
    },
    clear: async () => {
      for (const k of Object.keys(store.session)) {
        delete store.session[k];
      }
    },
    setAccessLevel: async () => {},
    getAccessLevel: async () => 'TRUSTED_CONTEXTS'
  };

  return {
    storage: {
      local,
      session,
      onChanged: { addListener() {} }
    },
    runtime: {
      id: 'test-ext-id-wi18',
      lastError: null,
      sendMessage: async () => {},
      onMessage: { addListener() {} }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      get: async () => { throw new Error('No tab'); },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
      onRemoved: { addListener() {} }
    },
    scripting: {
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
      getRegisteredContentScripts: async () => [],
      executeScript: async () => [{}]
    }
  };
}

// ============================================================================
// 1. WI-18 F-HIGH (a): remove fail 2 lần → memory-only, reads miss
// ============================================================================
test('WI-18 F-HIGH (a): remove fail 2 lần → memory-only, reads miss', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  const targetItem = { id: 'item_wi18_a', revision: 0, text: 'Hello Memory Only Mode' };
  const cacheContext = {
    baseURL,
    model: 'ag/gemini-3.1-pro-low',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    promptVersion: PROMPT_VERSION
  };
  const requestedKey = cacheKey(targetItem, cacheContext);
  const l2Key = hashText(requestedKey);

  const store = {
    local: {
      settings: {
        version: 7,
        baseURL,
        model: 'ag/gemini-3.1-pro-low',
        fallbacks: [],
        favoriteModels: [],
        autoTranslateSites: [],
        translationMode: 'scroll-follow',
        widgetVisible: true,
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        cacheEnabled: true
      },
      sites: { 'http://127.0.0.1:8101': { createdAt: Date.now() } },
      api_key: 'test-api-key',
      [L2_CACHE_KEY]: {
        [l2Key]: {
          keyHash: hashText(requestedKey),
          text: 'Stale cached translation that should be cleared',
          savedAt: Date.now()
        }
      }
    },
    session: {}
  };

  let removeAttempts = 0;
  const stub = makeChromeStub(store, {
    onRemove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.includes(L2_CACHE_KEY)) {
        removeAttempts++;
        throw new Error(`Simulated remove failure #${removeAttempts}`);
      }
    },
    onSet: async (obj) => {
      // If attempting fallback set trCache = {}, fail it so storage is not clean
      if (obj && L2_CACHE_KEY in obj && Object.keys(obj[L2_CACHE_KEY]).length === 0) {
        throw new Error('Simulated set failure for empty trCache fallback');
      }
    }
  });

  const savedChrome = globalThis.chrome;
  const savedSelf = globalThis.self;
  globalThis.chrome = stub;
  globalThis.self = globalThis;

  const sender = {
    frameId: 0,
    tab: { id: 8101, url: 'http://127.0.0.1:8101/index.html' },
    url: 'http://127.0.0.1:8101/index.html'
  };

  try {
    const sw = globalThis.__translatorSw;
    assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW hook must exist');
    sw._setTestMode(true);
    sw._setTestPermission('http://127.0.0.1:8101', true);
    sw._registerTestTab(8101, 'http://127.0.0.1:8101/index.html');
    sw._setTestRateLimits(null);
    await sw._resetRateStateForTest();
    sw._setL2MemoryOnlyForTest(false);

    // Initial state: not memory only
    assert.equal(sw.isL2MemoryOnly(), false);

    // 1. Trigger clearL2Cache via SET_KEY message (or directly)
    // Remove fails twice, fallback set fails -> turns on memory-only flag
    // Request must NOT throw/fail ("không fail request đổi key")
    const privilegedSender = { url: `chrome-extension://${globalThis.chrome.runtime.id}/popup.html` };
    const setKeyRes = await sw.dispatchMessage({ action: 'SET_KEY', key: 'sk-new-key' }, privilegedSender);
    assert.equal(setKeyRes.ok, true, 'SET_KEY must not fail even when storage remove fails');

    // Verify remove was attempted twice (initial + 1 retry)
    assert.equal(removeAttempts, 2, 'clearL2Cache must retry remove exactly once on failure');
    // Memory-only mode MUST be turned on
    assert.equal(sw.isL2MemoryOnly(), true, 'Memory-only mode must be enabled when clear fails and storage is unclean');

    // 2. In memory-only mode: L2 reads MUST miss (treated as miss)
    // Clear L1 in-memory cache to force read from L2
    sw.translationCache.clear();

    const providerReqCountBefore = fake.getLog().length;
    const transRes = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(!transRes.error);
    assert.equal(transRes.results.length, 1);
    // Must NOT hit the stale L2 entry from storage
    assert.notEqual(
      transRes.results[0].text,
      'Stale cached translation that should be cleared',
      'L2 read must be bypassed when in memory-only mode'
    );
    assert.equal(
      transRes.results[0].text,
      '[translated] Hello Memory Only Mode',
      'Must query provider because L2 reads miss in memory-only mode'
    );
    assert.equal(
      fake.getLog().length,
      providerReqCountBefore + 1,
      'Provider must have been called due to L2 read miss'
    );

    // 3. In memory-only mode: writes to L2 MUST be disabled
    enqueueL2Cache('some_key_mem_only', 'Some text');
    await flushL2Cache();
    // Verify storage was not written with new key
    assert.equal(
      store.local[L2_CACHE_KEY]['some_key_mem_only'],
      undefined,
      'Writes must be disabled in memory-only mode'
    );

    // 4. On next SUCCESSFUL clear: memory-only mode is cleared!
    // Restore normal remove behavior without throwing
    stub.storage.local.remove = async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        delete store.local[k];
      }
    };
    stub.storage.local.set = async (obj) => {
      Object.assign(store.local, obj);
    };

    await clearL2Cache();
    assert.equal(
      sw.isL2MemoryOnly(),
      false,
      'Memory-only mode must reset to false upon successful clear'
    );
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'Storage must be cleanly removed');
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    _setL2MemoryOnlyForTest(false);
    try { fake.stop(); } catch {}
  }
});

// ============================================================================
// 2. WI-18 F-HIGH (b): enqueue trong lúc clear-await → bị drop
// ============================================================================
test('WI-18 F-HIGH (b): enqueue trong lúc clear-await → bị drop', async () => {
  const store = { local: {}, session: {} };
  let pauseRemovePromise = null;
  let resumeRemoveResolve = null;

  const stub = makeChromeStub(store, {
    onBeforeRemove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.includes(L2_CACHE_KEY) && pauseRemovePromise) {
        await pauseRemovePromise;
      }
    }
  });

  const savedChrome = globalThis.chrome;
  const savedSelf = globalThis.self;
  globalThis.chrome = stub;
  globalThis.self = globalThis;

  try {
    const sw = globalThis.__translatorSw;
    assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW hook must exist');
    sw._setTestMode(true);
    sw._setL2MemoryOnlyForTest(false);

    // Create pause gate for storage.remove
    pauseRemovePromise = new Promise((resolve) => {
      resumeRemoveResolve = resolve;
    });

    // Start clearL2Cache: it synchronously bumps epoch and clears pending,
    // then enters `await chrome.storage.local.remove([L2_CACHE_KEY])` where it pauses.
    const clearPromise = clearL2Cache();

    // WHILE clearL2Cache is awaiting inside remove:
    // An in-flight translation finishes and attempts to enqueue old translation
    enqueueL2Cache('in-flight-stale-key', 'Old in-flight translation that must be dropped');

    // Resume remove gate so clearL2Cache completes
    resumeRemoveResolve();
    pauseRemovePromise = null;

    await clearPromise;

    // Flush any pending L2 cache
    await flushL2Cache();

    // Stale write MUST have been dropped; storage must remain empty
    assert.equal(
      store.local[L2_CACHE_KEY],
      undefined,
      'Enqueue during clear-await must be dropped without writing to storage'
    );

    // Normal enqueue AFTER clear has settled should succeed
    enqueueL2Cache('fresh-post-clear-key', 'Valid fresh translation');
    await flushL2Cache();
    assert.ok(store.local[L2_CACHE_KEY], 'Normal enqueue after clear must succeed');
    const storedKeys = Object.keys(store.local[L2_CACHE_KEY]);
    assert.equal(storedKeys.length, 1);
    assert.equal(store.local[L2_CACHE_KEY][storedKeys[0]].text, 'Valid fresh translation');
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    _setL2MemoryOnlyForTest(false);
  }
});

// ============================================================================
// 3. WI-18 F-MED (c): stored entry không chứa http/model literal, hit đúng chỉ khi key khớp
// ============================================================================
test('WI-18 F-MED (c): stored entry không chứa http/model literal, hit đúng chỉ khi key khớp', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  const secretBaseURL = 'https://api.internal-ai-service.test:9443/v1';
  const secretModel = 'proprietary-deep-thought-v4-turbo';

  const store = {
    local: {
      settings: {
        version: 7,
        baseURL: secretBaseURL,
        model: secretModel,
        fallbacks: [],
        favoriteModels: [],
        autoTranslateSites: [],
        translationMode: 'scroll-follow',
        widgetVisible: true,
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        cacheEnabled: true
      },
      sites: { 'http://127.0.0.1:8102': { createdAt: Date.now() } },
      api_key: 'test-api-key'
    },
    session: {}
  };

  const stub = makeChromeStub(store);
  const savedChrome = globalThis.chrome;
  const savedSelf = globalThis.self;
  globalThis.chrome = stub;
  globalThis.self = globalThis;

  const sender = {
    frameId: 0,
    tab: { id: 8102, url: 'http://127.0.0.1:8102/article.html' },
    url: 'http://127.0.0.1:8102/article.html'
  };

  try {
    const sw = globalThis.__translatorSw;
    assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW hook must exist');
    sw._setTestMode(true);
    sw._setTestPermission('http://127.0.0.1:8102', true);
    sw._registerTestTab(8102, 'http://127.0.0.1:8102/article.html');
    sw._setTestRateLimits(null);
    await sw._resetRateStateForTest();
    sw._setL2MemoryOnlyForTest(false);

    const targetItem = { id: 'item_secret', revision: 0, text: 'Top secret proprietary text' };
    const cacheContext = {
      baseURL: secretBaseURL,
      model: secretModel,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      promptVersion: PROMPT_VERSION
    };
    const fullKey = cacheKey(targetItem, cacheContext);
    const expectedKeyHash = hashText(fullKey);
    const l2Key = hashText(fullKey);

    // 1. Enqueue and flush to storage
    enqueueL2Cache(fullKey, 'Bản dịch tuyệt mật');
    await flushL2Cache();

    // 2. Verify stored representation in storage.local
    const trCache = store.local[L2_CACHE_KEY];
    assert.ok(trCache && typeof trCache === 'object', 'trCache must exist in storage');
    const storedEntry = trCache[l2Key];
    assert.ok(storedEntry, `Stored entry under hex key ${l2Key} must exist`);

    // Verify keyHash is saved instead of key
    assert.equal(storedEntry.keyHash, expectedKeyHash, 'Entry must store keyHash matching hashText(fullKey)');
    assert.equal(storedEntry.key, undefined, 'Entry must NOT store raw key property');
    assert.equal(storedEntry.text, 'Bản dịch tuyệt mật');

    // Strict scan of entire serialized L2 cache for literals:
    // MUST NOT contain http, https, ://, domain, or model literal at rest!
    const serializedL2 = JSON.stringify(trCache);
    assert.ok(!serializedL2.includes('http'), 'Serialized L2 storage must not contain "http"');
    assert.ok(!serializedL2.includes('https'), 'Serialized L2 storage must not contain "https"');
    assert.ok(!serializedL2.includes('://'), 'Serialized L2 storage must not contain "://"');
    assert.ok(!serializedL2.includes('internal-ai-service'), 'Serialized L2 storage must not contain baseURL literal');
    assert.ok(!serializedL2.includes('proprietary-deep-thought'), 'Serialized L2 storage must not contain model literal');

    // 3. Read-hit behavior:
    // (a) Exact matching key -> L2 cache hit!
    sw.translationCache.clear();
    const providerCountBefore = fake.getLog().length;

    // Use fake provider baseURL for actual batch dispatch so network call can succeed if missed
    store.local.settings.baseURL = baseURL;
    store.local.settings.model = 'ag/gemini-3.1-pro-low';

    // Dispatch batch matching secretBaseURL/secretModel
    // First, let's test directly with matching settings
    store.local.settings.baseURL = secretBaseURL;
    store.local.settings.model = secretModel;

    const hitRes = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        model: secretModel
      }
    }, sender);

    assert.ok(!hitRes.error, `Unexpected error: ${JSON.stringify(hitRes.error)}`);
    assert.equal(hitRes.results.length, 1);
    assert.equal(
      hitRes.results[0].text,
      'Bản dịch tuyệt mật',
      'Should hit L2 cache and return stored translation when keyHash matches'
    );
    assert.equal(fake.getLog().length, providerCountBefore, 'Provider must NOT be called on L2 cache hit');

    // (b) Mismatched key (e.g. different model or text) -> miss
    sw.translationCache.clear();
    store.local.settings.baseURL = baseURL;
    store.local.settings.model = 'ag/gemini-3.1-pro-low';

    const missRes = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(!missRes.error);
    assert.notEqual(missRes.results[0].text, 'Bản dịch tuyệt mật', 'Different model must NOT hit secret entry');
    assert.equal(missRes.results[0].text, '[translated] Top secret proprietary text');

    // (c) Simulated hash collision: same outer hex key, different keyHash -> miss
    const collisionL2Key = hashText('requested-collide-key');
    store.local[L2_CACHE_KEY][collisionL2Key] = {
      keyHash: 'mismatched_deadbeef',
      text: 'Wrong Collided Translation',
      savedAt: Date.now()
    };
    sw.translationCache.clear();

    const collideItem = { id: 'item_collide', revision: 0, text: 'Collided text' };
    const collideRes = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [collideItem],
        sourceLanguage: 'en',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(!collideRes.error);
    assert.notEqual(
      collideRes.results[0].text,
      'Wrong Collided Translation',
      'Collision on l2Key with mismatched keyHash must be rejected as miss'
    );
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    _setL2MemoryOnlyForTest(false);
    try { fake.stop(); } catch {}
  }
});
