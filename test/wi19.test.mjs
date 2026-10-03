// WebMCP Translator Kit — WI-19 Unit Tests
// Fix 2 findings from Sol re-review round 4 (wi1115-sol-verdict4.md):
// 1. F-HIGH: clear vẫn raceable (4 điểm)
//    (a) set-bay-qua-clear (mock storage delay) → không còn stale;
//    (b) mọi điểm enqueue L2 phải qua enqueueL2Cache, config change không enqueue response cũ;
//    (c) reads đang await get() đổi memory-only / epoch giữa chừng → coi như miss;
//    (d) remove-fail ở modelListCache → SET_KEY vẫn ok.
// 2. F-MED: entry literal cũ còn được chấp nhận
//    migrate-on-read: entry nào có field 'key' literal thì drop (coi miss + bị loại khỏi flush).

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

function makeChromeStub(store, { onBeforeGet, onBeforeSet, onBeforeRemove, onRemove } = {}) {
  const local = {
    get: async (keys) => {
      if (typeof onBeforeGet === 'function') {
        await onBeforeGet(keys);
      }
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
      if (typeof onBeforeSet === 'function') {
        await onBeforeSet(obj);
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
      id: 'test-ext-id-wi19',
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
// 1. Acceptance (a): set-bay-qua-clear (mock storage delay) → không còn stale
// ============================================================================
test('WI-19 Acceptance (a): set-bay-qua-clear (mock storage delay) → không còn stale', async () => {
  const store = { local: {}, session: {} };
  let pauseSetPromise = null;
  let resumeSetResolve = null;

  const stub = makeChromeStub(store, {
    onBeforeSet: async (obj) => {
      if (obj && L2_CACHE_KEY in obj && pauseSetPromise) {
        await pauseSetPromise;
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
    _setL2MemoryOnlyForTest(false);

    // Scenario 1: clearL2Cache racing with in-flight storage.local.set
    enqueueL2Cache('key-racing-set-1', 'Stale write that must not resurrect');

    // Create pause gate on storage.local.set
    pauseSetPromise = new Promise((resolve) => {
      resumeSetResolve = resolve;
    });

    // Start flush: captures epoch, reads storage, enters storage.local.set and pauses
    const flushPromise = flushL2Cache();

    // While set is in-flight (paused), call clearL2Cache()
    const clearPromise = clearL2Cache();

    // Release storage.local.set pause gate
    resumeSetResolve();
    pauseSetPromise = null;

    await Promise.all([flushPromise, clearPromise]);

    // Storage MUST NOT contain trCache because clearL2Cache serialized after flush set
    assert.equal(
      store.local[L2_CACHE_KEY],
      undefined,
      'clearL2Cache must remove trCache even if flush storage.local.set was in flight'
    );

    // Scenario 2: SET_KEY racing with in-flight storage.local.set
    enqueueL2Cache('key-racing-set-2', 'Credential stale write that must not resurrect');

    pauseSetPromise = new Promise((resolve) => {
      resumeSetResolve = resolve;
    });

    const flushPromise2 = flushL2Cache();

    const privilegedSender = { url: `chrome-extension://${globalThis.chrome.runtime.id}/popup.html` };
    const setKeyPromise = sw.dispatchMessage({ action: 'SET_KEY', key: 'sk-new-fresh-key' }, privilegedSender);

    resumeSetResolve();
    pauseSetPromise = null;

    const [_, setKeyRes] = await Promise.all([flushPromise2, setKeyPromise]);
    assert.equal(setKeyRes.ok, true);
    assert.equal(
      store.local[L2_CACHE_KEY],
      undefined,
      'SET_KEY must cleanly wipe L2 without in-flight flush resurrecting stale cache'
    );

    // Scenario 3: Subsequent normal flush writes successfully with new epoch
    enqueueL2Cache('fresh-key-post-race', 'Valid fresh translation');
    await flushL2Cache();
    assert.ok(store.local[L2_CACHE_KEY], 'Normal flush after race must succeed');
    const storedKeys = Object.keys(store.local[L2_CACHE_KEY]);
    assert.equal(storedKeys.length, 1);
    assert.equal(store.local[L2_CACHE_KEY][storedKeys[0]].text, 'Valid fresh translation');

    // Clean up
    await clearL2Cache();
    assert.equal(store.local[L2_CACHE_KEY], undefined);
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    _setL2MemoryOnlyForTest(false);
  }
});

// ============================================================================
// 2. Acceptance (b): remove-fail ở modelListCache → SET_KEY vẫn ok
// ============================================================================
test('WI-19 Acceptance (b): remove-fail ở modelListCache → SET_KEY vẫn ok', async () => {
  const store = { local: {}, session: {} };

  const stub = makeChromeStub(store, {
    onBeforeRemove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.includes('modelListCache')) {
        throw new Error('Simulated QuotaExceeded or Disk I/O error on modelListCache removal');
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
    _setL2MemoryOnlyForTest(false);

    const privilegedSender = { url: `chrome-extension://${globalThis.chrome.runtime.id}/popup.html` };
    const res = await sw.dispatchMessage({ action: 'SET_KEY', key: 'sk-resilient-credential-123' }, privilegedSender);

    assert.equal(res.ok, true, 'SET_KEY must succeed even when modelListCache removal fails');
    assert.equal(store.local.api_key, 'sk-resilient-credential-123', 'API key must be updated');
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
  }
});

// ============================================================================
// 3. Acceptance (c): entry literal cũ → miss + bị loại khỏi flush
// ============================================================================
test('WI-19 Acceptance (c): entry literal cũ → miss + bị loại khỏi flush', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  const targetItem = { id: 'item_legacy_key', revision: 0, text: 'Hello Legacy Literal Key' };
  const cacheContext = {
    baseURL,
    model: 'ag/gemini-3.1-pro-low',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    promptVersion: PROMPT_VERSION
  };
  const requestedKey = cacheKey(targetItem, cacheContext);
  const l2Key = hashText(requestedKey);

  // Setup storage with legacy entries that have literal 'key' field or lack 'keyHash'
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
          key: requestedKey, // legacy literal 'key' field!
          keyHash: hashText(requestedKey),
          text: 'Bản dịch cũ có literal key',
          savedAt: Date.now()
        },
        'oldentry2': {
          key: 'https://other-ai.api/v1/models/gpt', // legacy entry without keyHash
          text: 'Bản dịch legacy không có keyHash',
          savedAt: Date.now()
        },
        'validentry': {
          keyHash: hashText('valid-key'),
          text: 'Bản dịch chuẩn format mới',
          savedAt: Date.now()
        }
      }
    },
    session: {}
  };

  const stub = makeChromeStub(store);
  const savedChrome = globalThis.chrome;
  const savedSelf = globalThis.self;
  globalThis.chrome = stub;
  globalThis.self = globalThis;

  try {
    const sw = globalThis.__translatorSw;
    assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW hook must exist');
    sw._setTestMode(true);
    sw._setTestPermission('http://127.0.0.1:8101', true);
    sw._registerTestTab(101, 'http://127.0.0.1:8101/article');
    sw._setTestRateLimits(null);
    await sw._resetRateStateForTest();
    _setL2MemoryOnlyForTest(false);

    // 1. Read path check: entry with literal 'key' must be treated as a MISS
    sw.translationCache.clear();
    const readSender = { frameId: 0, tab: { id: 101, url: 'http://127.0.0.1:8101/article' }, url: 'http://127.0.0.1:8101/article' };
    const providerCountBefore = fake.getLog().length;

    const translateRes = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, readSender);

    assert.ok(!translateRes.error, 'TRANSLATE_BATCH should succeed');
    assert.equal(translateRes.results?.length, 1);
    // Provider MUST be called because the legacy entry is dropped on read
    assert.ok(
      fake.getLog().length > providerCountBefore,
      'Provider must be queried because legacy literal-key entry is dropped as a cache miss'
    );

    // 2. Flush check: legacy entries must be dropped and NOT copied into flush
    enqueueL2Cache('fresh-test-key-wi19', 'Bản dịch mới');
    await flushL2Cache();

    const trCache = store.local[L2_CACHE_KEY];
    assert.ok(trCache, 'trCache must exist after flush');

    // oldentry2 must be completely dropped
    assert.equal(trCache['oldentry2'], undefined, 'Legacy entry without valid keyHash must be dropped');

    // Every single entry in trCache must NOT have a literal 'key' field
    for (const [k, entry] of Object.entries(trCache)) {
      assert.equal('key' in entry, false, `Entry ${k} must not have literal 'key' field`);
      assert.ok(typeof entry.keyHash === 'string', `Entry ${k} must have keyHash`);
      assert.ok(typeof entry.text === 'string', `Entry ${k} must have text`);
      assert.ok(typeof entry.savedAt === 'number', `Entry ${k} must have savedAt`);
    }
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    await fake.stop();
  }
});

// ============================================================================
// 4. F-HIGH (c): reads đang await get() đổi memory-only / epoch giữa chừng → coi như miss
// ============================================================================
test('WI-19 F-HIGH (c): reads đang await get() đổi memory-only / epoch giữa chừng → coi như miss', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  const targetItem = { id: 'item_read_race', revision: 0, text: 'Hello Read Race' };
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
          text: 'L2 cached value that must miss if state changes',
          savedAt: Date.now()
        }
      }
    },
    session: {}
  };

  let pauseGetPromise = null;
  let resumeGetResolve = null;

  const stub = makeChromeStub(store, {
    onBeforeGet: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.includes(L2_CACHE_KEY) && pauseGetPromise) {
        await pauseGetPromise;
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
    sw._setTestPermission('http://127.0.0.1:8101', true);
    sw._registerTestTab(102, 'http://127.0.0.1:8101/article');
    sw._setTestRateLimits(null);
    await sw._resetRateStateForTest();
    _setL2MemoryOnlyForTest(false);

    // Case 1: memory-only mode turns ON while read is awaiting storage.get
    sw.translationCache.clear();
    pauseGetPromise = new Promise((resolve) => {
      resumeGetResolve = resolve;
    });

    const readSender = { frameId: 0, tab: { id: 102, url: 'http://127.0.0.1:8101/article' }, url: 'http://127.0.0.1:8101/article' };
    const providerCountBefore1 = fake.getLog().length;

    const translatePromise1 = sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, readSender);

    // While read is awaiting storage.get, switch to memory-only
    _setL2MemoryOnlyForTest(true);

    // Release pause
    resumeGetResolve();
    pauseGetPromise = null;

    const res1 = await translatePromise1;
    assert.ok(!res1.error, 'Should not return error');
    assert.equal(res1.results?.length, 1);
    assert.ok(
      fake.getLog().length > providerCountBefore1,
      'Read must miss and call provider when memory-only mode was enabled while awaiting get'
    );

    // Case 2: clearL2Cache() called while read is awaiting storage.get
    _setL2MemoryOnlyForTest(false);
    sw.translationCache.clear();
    // Repopulate L2 for case 2
    store.local[L2_CACHE_KEY] = {
      [l2Key]: {
        keyHash: hashText(requestedKey),
        text: 'L2 cached value for case 2',
        savedAt: Date.now()
      }
    };

    pauseGetPromise = new Promise((resolve) => {
      resumeGetResolve = resolve;
    });

    const providerCountBefore2 = fake.getLog().length;
    const translatePromise2 = sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, readSender);

    // While read is awaiting storage.get, call clearL2Cache()
    await clearL2Cache();

    // Release pause
    resumeGetResolve();
    pauseGetPromise = null;

    const res2 = await translatePromise2;
    assert.ok(!res2.error, 'Should not return error');
    assert.equal(res2.results?.length, 1);
    assert.ok(
      fake.getLog().length > providerCountBefore2,
      'Read must miss and call provider when clearL2Cache bumped epoch while awaiting get'
    );
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    _setL2MemoryOnlyForTest(false);
    await fake.stop();
  }
});

// ============================================================================
// 5. F-HIGH (b): config change while batch is in-flight does not enqueue provider response into L2
// ============================================================================
test('WI-19 F-HIGH (b): config change while batch is in-flight does not enqueue provider response into L2', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();
  fake.setMode('delay', { delayMs: 150 });

  const targetItem = { id: 'item_inflight_config', revision: 0, text: 'Hello in-flight config change' };
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
      api_key: 'test-api-key'
    },
    session: {}
  };

  const stub = makeChromeStub(store);
  const savedChrome = globalThis.chrome;
  const savedSelf = globalThis.self;
  globalThis.chrome = stub;
  globalThis.self = globalThis;

  try {
    const sw = globalThis.__translatorSw;
    assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW hook must exist');
    sw._setTestMode(true);
    sw._setTestPermission('http://127.0.0.1:8101', true);
    sw._registerTestTab(103, 'http://127.0.0.1:8101/article');
    sw._setTestRateLimits(null);
    await sw._resetRateStateForTest();
    _setL2MemoryOnlyForTest(false);

    const readSender = { frameId: 0, tab: { id: 103, url: 'http://127.0.0.1:8101/article' }, url: 'http://127.0.0.1:8101/article' };

    // Start translation batch while provider has delay
    const translatePromise = sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, readSender);

    // Wait a brief tick so batch enters in-flight state with provider
    await new Promise((r) => setTimeout(r, 30));

    // Change configuration to bump configRevision
    const privilegedSender = { url: `chrome-extension://${globalThis.chrome.runtime.id}/popup.html` };
    const updateRes = await sw.dispatchMessage({
      action: 'SAVE_SETTINGS',
      settings: { targetLanguage: 'ja' }
    }, privilegedSender);
    assert.equal(updateRes.ok, true);

    // Await translation result: must be aborted due to configuration change
    const res = await translatePromise;
    assert.ok(res.error, 'In-flight batch must be aborted when config changes');
    assert.equal(res.error.code, 'ABORTED');

    // Flush any pending writes
    await flushL2Cache();

    // Verify neither L1 translationCache nor L2 store has the item from aborted batch
    const l1Cached = sw.translationCache.get(requestedKey, 'Hello in-flight config change');
    assert.equal(l1Cached, undefined, 'L1 cache must not have entry from aborted batch');

    const l2Store = store.local[L2_CACHE_KEY];
    assert.ok(!l2Store || !l2Store[l2Key], 'L2 storage must not have entry from aborted batch');
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    _setL2MemoryOnlyForTest(false);
    await fake.stop();
  }
});
