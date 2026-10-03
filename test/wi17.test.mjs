// WebMCP Translator Kit — WI-17 Unit Tests
// Fix 2 findings from Sol re-review round 2 (wi1115-sol-verdict2.md):
// 1. F-HIGH: race flush/clear — L2 cũ sống sót sau đổi key (epoch/generation counter)
// 2. F-MED: FNV-32 collision trả nhầm bản dịch (entry.key full key verification)

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
  getL2Epoch
} from '../extension/src/sw.js';
import { createFakeProvider } from './helpers/fake-provider.mjs';

function makeChromeStub(store, { onBeforeStorageGet } = {}) {
  const local = {
    get: async (keys) => {
      if (typeof onBeforeStorageGet === 'function') {
        await onBeforeStorageGet(keys);
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
      Object.assign(store.local, obj);
    },
    remove: async (keys) => {
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
      id: 'test-ext-id',
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
// 1. WI-17 F-HIGH: clear trong lúc flush đang bay → không còn entry cũ
// ============================================================================
test('WI-17 F-HIGH (a): clearL2Cache while flushL2Cache is in-flight drops stale write without resurrecting old entry', async () => {
  const store = { local: {}, session: {} };
  let pauseGetPromise = null;
  let resumeGetResolve = null;

  const stub = makeChromeStub(store, {
    onBeforeStorageGet: async (keys) => {
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
    sw._resetStorageAccessStateForTest();

    // --- Scenario 1: Direct clearL2Cache() racing with in-flight flushL2Cache() ---
    const initialEpoch = getL2Epoch();
    enqueueL2Cache('key-victim-1', 'Stale translation to drop');

    // Create pause gate for storage.get
    pauseGetPromise = new Promise((resolve) => {
      resumeGetResolve = resolve;
    });

    // Start flush: captures epoch = initialEpoch, reads storage (pauses at gate)
    const flushPromise1 = flushL2Cache();

    // Call clearL2Cache while flush is in flight: increments epoch, clears pending, wipes storage
    const clearPromise1 = clearL2Cache();
    assert.equal(getL2Epoch(), initialEpoch + 1, 'clearL2Cache must increment epoch immediately');

    // Release pause gate: flushL2Cache resumes, sees l2Epoch !== currentEpoch -> drops silently
    resumeGetResolve();
    pauseGetPromise = null;

    await Promise.all([flushPromise1, clearPromise1]);

    // Storage MUST NOT contain trCache or resurrected entry
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'L2 storage must remain empty after clearL2Cache race');

    // --- Scenario 2: SET_KEY racing with in-flight flushL2Cache() ---
    const epochBeforeSetKey = getL2Epoch();
    enqueueL2Cache('key-victim-2', 'Credential-stale translation 2');

    pauseGetPromise = new Promise((resolve) => {
      resumeGetResolve = resolve;
    });

    const flushPromise2 = flushL2Cache();

    // Dispatch SET_KEY while flush is in flight
    const privilegedSender = { url: `chrome-extension://${globalThis.chrome.runtime.id}/popup.html` };
    const setKeyPromise = sw.dispatchMessage({ action: 'SET_KEY', key: 'sk-fresh-credential' }, privilegedSender);

    // Release pause gate
    resumeGetResolve();
    pauseGetPromise = null;

    const [_, setKeyRes] = await Promise.all([flushPromise2, setKeyPromise]);
    assert.equal(setKeyRes.ok, true);

    // Stale entry must not have been committed to storage
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'SET_KEY must prevent in-flight flush from committing stale L2 cache');
    assert.ok(getL2Epoch() > epochBeforeSetKey, 'SET_KEY must increment L2 epoch');

    // --- Scenario 3: DELETE_KEY racing with in-flight flushL2Cache() ---
    enqueueL2Cache('key-victim-3', 'Credential-stale translation 3');

    pauseGetPromise = new Promise((resolve) => {
      resumeGetResolve = resolve;
    });

    const flushPromise3 = flushL2Cache();

    const delKeyPromise = sw.dispatchMessage({ action: 'DELETE_KEY' }, privilegedSender);

    resumeGetResolve();
    pauseGetPromise = null;

    const [__, delKeyRes] = await Promise.all([flushPromise3, delKeyPromise]);
    assert.equal(delKeyRes.ok, true);

    assert.equal(store.local[L2_CACHE_KEY], undefined, 'DELETE_KEY must prevent in-flight flush from committing stale L2 cache');

    // --- Scenario 4: Subsequent normal flush writes successfully with new epoch ---
    enqueueL2Cache('fresh-key-after-clears', 'Valid fresh translation');
    await flushL2Cache();
    assert.ok(store.local[L2_CACHE_KEY], 'Normal flush after race must succeed under current epoch');
    const storedKeys = Object.keys(store.local[L2_CACHE_KEY]);
    assert.equal(storedKeys.length, 1);
    assert.equal(store.local[L2_CACHE_KEY][storedKeys[0]].text, 'Valid fresh translation');
    assert.equal(store.local[L2_CACHE_KEY][storedKeys[0]].keyHash, hashText('fresh-key-after-clears'));

    // Clean up
    await clearL2Cache();
    assert.equal(store.local[L2_CACHE_KEY], undefined);
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
  }
});

// ============================================================================
// 2. WI-17 F-MED: FNV-32 collision — entry key lệch → miss
// ============================================================================
test('WI-17 F-MED (b): entry key mismatch on read-hit is treated as miss and overwritten with correct translation', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

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
      sites: { 'http://127.0.0.1:8099': { createdAt: Date.now() } },
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
    tab: { id: 8099, url: 'http://127.0.0.1:8099/article.html' },
    url: 'http://127.0.0.1:8099/article.html'
  };

  try {
    const sw = globalThis.__translatorSw;
    assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW hook must exist');
    sw._setTestMode(true);
    sw._setTestPermission('http://127.0.0.1:8099', true);
    sw._registerTestTab(8099, 'http://127.0.0.1:8099/article.html');
    sw._setTestRateLimits(null);
    await sw._resetRateStateForTest();

    const targetItem = { id: 'item_target', revision: 0, text: 'Hello unique world' };
    const cacheContext = {
      baseURL,
      model: 'ag/gemini-3.1-pro-low',
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      promptVersion: PROMPT_VERSION
    };
    const requestedKey = cacheKey(targetItem, cacheContext);
    const l2Key = hashText(requestedKey);

    // 1. Simulate an FNV-32 hash collision in storage:
    // Store an entry that maps to the exact same l2Key (8-hex hash),
    // but whose full `key` belongs to a DIFFERENT text/context.
    const collidedOtherKey = `collided_full_key::${requestedKey}::other`;
    store.local[L2_CACHE_KEY] = {
      [l2Key]: {
        keyHash: hashText(collidedOtherKey),
        text: 'Bản dịch SAI từ FNV collision',
        savedAt: Date.now()
      }
    };

    // Ensure in-memory cache does not have requestedKey
    sw.translationCache.clear();

    // 2. Dispatch TRANSLATE_BATCH for targetItem
    const res1 = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(!res1.error, `Expected translation success, got error: ${JSON.stringify(res1.error)}`);
    assert.equal(res1.results.length, 1);

    // Because entry.keyHash !== hashText(requestedKey), L2 read-hit MUST be rejected as a miss!
    // Result MUST NOT be the collided text
    assert.notEqual(
      res1.results[0].text,
      'Bản dịch SAI từ FNV collision',
      'Read-hit with mismatched entry.key must NOT return the collided translation'
    );
    assert.equal(
      res1.results[0].text,
      '[translated] Hello unique world',
      'Should fall back to provider and return real translation on key mismatch'
    );

    // 3. Flush L2 cache to persist the overwritten correct entry
    await flushL2Cache();

    // Verify storage entry has been overwritten with requestedKey and correct text
    const updatedEntry = store.local[L2_CACHE_KEY][l2Key];
    assert.ok(updatedEntry, 'L2 cache entry must exist');
    assert.equal(updatedEntry.keyHash, hashText(requestedKey), 'Stored entry must now have requestedKey hash');
    assert.equal(updatedEntry.text, '[translated] Hello unique world', 'Stored text must be the correct translation');

    // 4. Now clear in-memory cache: next request with requestedKey MUST hit L2!
    sw.translationCache.clear();

    const providerReqCountBefore = fake.getLog().length;
    const res2 = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(!res2.error);
    assert.equal(res2.results[0].text, '[translated] Hello unique world');
    // Provider must NOT have been called because requestedKey matched entry.key (L2 cache hit!)
    assert.equal(fake.getLog().length, providerReqCountBefore, 'Should be an L2 cache hit when entry.key matches requestedKey');

    // 5. Test legacy entry without .key property (backward compatibility: treated as miss)
    store.local[L2_CACHE_KEY][l2Key] = {
      text: 'Legacy entry without key property',
      savedAt: Date.now()
    };
    sw.translationCache.clear();

    const res3 = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [targetItem],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(!res3.error, `res3 failed with error: ${JSON.stringify(res3.error)}`);
    assert.notEqual(res3.results[0].text, 'Legacy entry without key property', 'Entry without .key must be treated as miss');
    assert.equal(res3.results[0].text, '[translated] Hello unique world');
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
    try { fake.stop(); } catch {}
  }
});
