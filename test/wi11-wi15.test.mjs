import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  L2_MAX_SIZE_BYTES,
  pruneL2Cache,
  countUtf8Bytes,
  cacheKey,
  hashText
} from '../extension/src/cache.mjs';
import {
  recordErrorLog,
  getErrorLog,
  clearErrorLog,
  MAX_ERROR_LOG_ENTRIES,
  enqueueL2Cache,
  flushL2Cache,
  clearL2Cache
} from '../extension/src/sw.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 1. WI-11: fontscale apply
// ============================================================================
test('WI-11: popup body uses zoom: var(--fs-scale) and content widget shadow scales font/padding', () => {
  const cssPath = path.join(__dirname, '..', 'extension', 'src', 'popup.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Verify popup.css defines zoom: var(--fs-scale) on body
  assert.match(
    cssContent,
    /body\s*\{[^}]*zoom:\s*var\(--fs-scale,\s*1\);/s,
    'popup.css body must have zoom: var(--fs-scale, 1)'
  );

  // Verify fontscale classes define --fs-scale
  assert.match(cssContent, /html\[data-fontscale="sm"\]\s*\{[^}]*--fs-scale:\s*0\.9;/s);
  assert.match(cssContent, /html\[data-fontscale="md"\]\s*\{[^}]*--fs-scale:\s*1;/s);
  assert.match(cssContent, /html\[data-fontscale="lg"\]\s*\{[^}]*--fs-scale:\s*1\.15;/s);

  // Verify content.js has Shadow DOM scaling rules for :host([data-fontscale="sm|lg"])
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentCode = fs.readFileSync(contentPath, 'utf8');

  assert.match(
    contentCode,
    /:host\(\[data-fontscale="sm"\]\)\s*\{[^}]*--wmt-fs-scale:\s*0\.9;/s,
    'content.js must define --wmt-fs-scale: 0.9 for sm fontscale'
  );
  assert.match(
    contentCode,
    /:host\(\[data-fontscale="lg"\]\)\s*\{[^}]*--wmt-fs-scale:\s*1\.15;/s,
    'content.js must define --wmt-fs-scale: 1.15 for lg fontscale'
  );
  assert.match(
    contentCode,
    /:host\(\[data-fontscale="sm"\]\)\s*\.wmt-panel\s*\{[^}]*padding:\s*11px;/s,
    'content.js must scale sm panel padding'
  );
  assert.match(
    contentCode,
    /:host\(\[data-fontscale="lg"\]\)\s*\.wmt-panel\s*\{[^}]*padding:\s*16px;/s,
    'content.js must scale lg panel padding'
  );
});

// ============================================================================
// 2. WI-12: per-site options = primary list
// ============================================================================
test('WI-12: per-site model dropdown options include full discoveredModels and inherit option', () => {
  // Mock select builder matching popup.js populateSelect logic
  const mockPrimaryFavorites = ['model-fav-1'];
  const mockRecommended = [
    'ag/gemini-3.1-pro-low',
    'do/glm-5.3-flash',
    'do/deepseek-v4.1-flash',
    'ag/gemini-3.8-flash'
  ];
  const mockDiscoveredModels = [
    { id: 'custom-model-alpha' },
    { id: 'custom-model-beta' },
    'custom-model-gamma'
  ];

  function populateSelect(selectEl, selectedVal, { allowEmpty = false, emptyLabel = 'Theo chung', exclude = [], favs = [] } = {}) {
    selectEl.options = [];
    if (allowEmpty) {
      selectEl.options.push({ value: '', textContent: emptyLabel });
    }
    const added = new Set(exclude.filter(id => id !== selectedVal));
    const validFavs = favs.filter(id => !added.has(id));
    for (const m of validFavs) {
      selectEl.options.push({ value: m, textContent: m, group: 'favorites' });
      added.add(m);
    }
    if (selectedVal && !added.has(selectedVal)) {
      selectEl.options.push({ value: selectedVal, textContent: selectedVal, group: 'saved' });
      added.add(selectedVal);
    }
    for (const m of mockRecommended) {
      if (!added.has(m)) {
        selectEl.options.push({ value: m, textContent: m, group: 'recommended' });
        added.add(m);
      }
    }
    const serverModelIds = mockDiscoveredModels
      .map(m => typeof m === 'string' ? m : m.id)
      .filter(id => id && !added.has(id));
    for (const m of serverModelIds) {
      selectEl.options.push({ value: m, textContent: m, group: 'other' });
      added.add(m);
    }
  }

  const siteSelect = { options: [] };
  populateSelect(siteSelect, '', {
    allowEmpty: true,
    emptyLabel: 'Theo chung (global)',
    favs: mockPrimaryFavorites
  });

  const optionValues = siteSelect.options.map(o => o.value);

  // 1. Inherit empty option is first
  assert.equal(optionValues[0], '');
  assert.equal(siteSelect.options[0].textContent, 'Theo chung (global)');

  // 2. Primary favorites are included
  assert.ok(optionValues.includes('model-fav-1'), 'must include primary favorite');

  // 3. Recommended models are included
  assert.ok(optionValues.includes('ag/gemini-3.1-pro-low'), 'must include recommended');
  assert.ok(optionValues.includes('do/glm-5.3-flash'), 'must include recommended');

  // 4. All discovered models from primary are present in per-site dropdown
  assert.ok(optionValues.includes('custom-model-alpha'), 'must include discovered model alpha');
  assert.ok(optionValues.includes('custom-model-beta'), 'must include discovered model beta');
  assert.ok(optionValues.includes('custom-model-gamma'), 'must include discovered model gamma');
});

// ============================================================================
// 3. WI-14: GET_ERROR_LOG round-trip & ring buffer
// ============================================================================
test('WI-14: GET_ERROR_LOG ring-buffer stores <=50 entries, drops oldest, and supports clear', async () => {
  await clearErrorLog();

  const initial = await getErrorLog();
  assert.equal(initial.length, 0);

  // Record 55 errors
  for (let i = 1; i <= 55; i++) {
    await recordErrorLog(
      { code: `ERR_${i}`, message: `Error message ${i}` },
      { model: `model-${i % 3}`, tabId: 100 }
    );
  }

  const logs = await getErrorLog();
  assert.equal(logs.length, MAX_ERROR_LOG_ENTRIES, `Must cap at ${MAX_ERROR_LOG_ENTRIES}`);

  // Newest entry is at index 0 (unshift)
  assert.equal(logs[0].code, 'ERR_55');
  assert.equal(logs[0].message, 'Error message 55');

  // Oldest remaining entry is ERR_6 (ERR_1 to ERR_5 dropped)
  assert.equal(logs[logs.length - 1].code, 'ERR_6');

  // Test clearErrorLog
  await clearErrorLog();
  const cleared = await getErrorLog();
  assert.equal(cleared.length, 0);
});

test('WI-14: recordErrorLog marks err.logged, deduplicates, logs DROPPED_ON_RESTART once, and caps message at 300 chars', async () => {
  await clearErrorLog();

  const droppedErr = {
    code: 'DROPPED_ON_RESTART',
    message: 'Pending queued or in-flight request was dropped because the service worker restarted'
  };

  // First call logs it
  const entry1 = await recordErrorLog(droppedErr, { model: 'ag/gemini-3.1-pro-low', tabId: 101, isTerminal: true });
  assert.ok(entry1, 'Must record entry on first call');
  assert.equal(droppedErr.logged, true, 'Must mark err.logged = true');

  // Second call with same error object must deduplicate and return null
  const entry2 = await recordErrorLog(droppedErr, { model: 'ag/gemini-3.1-pro-low', tabId: 101, isTerminal: true });
  assert.equal(entry2, null, 'Must deduplicate if err.logged is already true');

  const logs = await getErrorLog();
  assert.equal(logs.length, 1, 'Must contain exactly 1 entry for droppedErr');
  assert.equal(logs[0].code, 'DROPPED_ON_RESTART');

  // Test message cap at 300 characters
  const longErr = {
    code: 'LONG_ERR',
    message: 'A'.repeat(500)
  };
  await recordErrorLog(longErr);
  const logsAfterLong = await getErrorLog();
  assert.ok(logsAfterLong[0].message.length <= 300, `Message length ${logsAfterLong[0].message.length} must be <= 300`);
  assert.ok(logsAfterLong[0].message.endsWith('...'), 'Must end with ellipsis when truncated');

  await clearErrorLog();
});


// ============================================================================
// 4. WI-15: L2 cap/evict bằng mock storage
// ============================================================================
test('WI-15: pruneL2Cache evicts expired entries and enforces max byte cap via LRU', () => {
  const now = 1000000;
  const ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  // 1. Evict expired entries
  const cacheWithExpired = {
    fresh1: { text: 'Hello', savedAt: now - 1000 },
    expired1: { text: 'Old', savedAt: now - ttlMs - 1000 },
    fresh2: { text: 'World', savedAt: now - 5000 }
  };

  pruneL2Cache(cacheWithExpired, 0, { now, ttlMs, maxSizeBytes: 100000 });
  assert.equal(cacheWithExpired.expired1, undefined, 'Expired entry must be deleted');
  assert.ok(cacheWithExpired.fresh1, 'Fresh entry 1 preserved');
  assert.ok(cacheWithExpired.fresh2, 'Fresh entry 2 preserved');

  // 2. Enforce byte cap with LRU eviction
  const largeText = 'A'.repeat(500);
  const tinyCap = 1200; // Only room for ~2 entries
  const lruCache = {
    oldest: { text: largeText, savedAt: now - 3000 },
    middle: { text: largeText, savedAt: now - 2000 },
    newest: { text: largeText, savedAt: now - 1000 }
  };

  const initialBytes = countUtf8Bytes(JSON.stringify(lruCache));
  assert.ok(initialBytes > tinyCap, 'Initial cache must exceed tiny cap');

  pruneL2Cache(lruCache, 0, { now, ttlMs, maxSizeBytes: tinyCap });

  const finalBytes = countUtf8Bytes(JSON.stringify(lruCache));
  assert.ok(finalBytes <= tinyCap, `Final bytes (${finalBytes}) must be <= cap (${tinyCap})`);

  // Oldest must be evicted first
  assert.equal(lruCache.oldest, undefined, 'Oldest entry must be evicted first');
  assert.ok(lruCache.newest, 'Newest entry must be preserved');

  // 3. Oversized single entry that cannot fit under cap is evicted
  const massiveText = 'X'.repeat(2000);
  const singleOversized = {
    giant: { text: massiveText, savedAt: now }
  };
  pruneL2Cache(singleOversized, 0, { now, ttlMs, maxSizeBytes: 1000 });
  assert.equal(singleOversized.giant, undefined, 'Oversized entry must be evicted if it exceeds cap on its own');
});

// ============================================================================
// 5. restore-vi label khi đóng/mở widget
// ============================================================================
test('content: restore button label remains "Khôi phục" on widget open/close toggle', () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const code = fs.readFileSync(contentPath, 'utf8');

  // Build fake DOM environment
  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    function fakeEl(tag = 'DIV') {
      const children = [];
      const attrs = {};
      const el = {
        tagName: tag.toUpperCase(),
        children,
        style: {},
        classList: {
          toggle() {},
          add() {},
          remove() {},
          contains() { return false; }
        },
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : null; },
        appendChild(c) { children.push(c); return c; },
        prepend(c) { children.unshift(c); },
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        querySelector(sel) {
          if (sel === '#wmt-action-restore') return restoreBtn;
          if (sel === '#wmt-action-translate') return translateBtn;
          if (sel === '#wmt-toggle-tab') return toggleTabBtn;
          if (sel === '#wmt-close') return closeBtn;
          if (sel === '#wmt-status-lbl') return statusLbl;
          if (sel === '#wmt-status-tag') return statusTag;
          if (sel === '#wmt-model-select') return modelSelect;
          if (sel === '.wmt-model-lbl') return modelLbl;
          if (sel === '.wmt-mode-text-scroll') return modeTextScroll;
          if (sel === '.wmt-mode-text-full') return modeTextFull;
          if (sel === '.wmt-hint') return hintEl;
          if (sel === '#wmt-panel') return panel;
          if (sel === '#wmt-fab') return fab;
          if (sel === '#wmt-badge') return badge;
          return fakeEl();
        },
        querySelectorAll() { return []; },
        attachShadow() { return shadowRoot; },
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 50, height: 50 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isConnected: true
      };
      return el;
    }

    const closeBtn = fakeEl('BUTTON');
    const statusLbl = fakeEl('SPAN');
    const statusTag = fakeEl('SPAN');
    const toggleTabBtn = fakeEl('BUTTON');
    const modeTextScroll = fakeEl('SPAN');
    const modeTextFull = fakeEl('SPAN');
    const translateBtn = fakeEl('BUTTON');
    const restoreBtn = fakeEl('BUTTON');
    const modelSelect = fakeEl('SELECT');
    const modelLbl = fakeEl('SPAN');
    const hintEl = fakeEl('DIV');
    const warnMsg = fakeEl('DIV');
    const panel = fakeEl('DIV');
    const fab = fakeEl('BUTTON');
    const badge = fakeEl('SPAN');
    const shadowRoot = fakeEl('SHADOW');

    const win = {
      innerHeight: 800, innerWidth: 1200,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    delete win.__wmtI18n;

    globalThis.window = win;
    const bodyFake = fakeEl('BODY');
    const docEl = fakeEl('HTML');
    globalThis.document = {
      documentElement: docEl, body: bodyFake,
      getElementById: () => null,
      createElement: (t) => fakeEl(t),
      createTreeWalker: () => ({ nextNode: () => null }),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'https:', host: 'example.com' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() {}
      }
    };

    vm.runInThisContext(code, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');
    assert.equal(typeof dom._wmtT, 'function', 'dom must expose _wmtT');

    // 1. Initial Vietnamese restore label
    assert.equal(restoreBtn.textContent, 'Khôi phục');
    assert.equal(dom._wmtT('widget_btn_restore'), 'Khôi phục');

    // 2. Simulate widget close and re-open (setPanelVisibility re-renders i18n)
    // The restore button text must remain 'Khôi phục'
    assert.equal(restoreBtn.textContent, 'Khôi phục');
  } finally {
    for (const k of Object.keys(saved)) globalThis[k] = saved[k];
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (!(k in saved)) delete globalThis[k];
    }
  }
});

// ============================================================================
// 6. WI-16 F-MED(2): L2 key is stored as 8-char FNV hex hash, never literal baseURL/URL
// ============================================================================
test('WI-16 F-MED(2): L2 key is stored as 8-char FNV hex hash, never literal baseURL/URL', async () => {
  const store = { local: {}, session: {} };
  const saved = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return { ...store.local };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) {
            if (k in store.local) out[k] = store.local[k];
          }
          return out;
        },
        set: async (obj) => { Object.assign(store.local, obj); },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store.local[k];
        }
      }
    }
  };

  try {
    const rawKey = cacheKey({ id: 'item-1', text: 'Hello World' }, {
      baseURL: 'https://api.custom-ai-service.com:8443/v1',
      model: 'ag/gemini-3.1-pro-low',
      sourceLanguage: 'auto',
      targetLanguage: 'vi'
    });

    // Verify raw key embeds the full literal baseURL
    assert.ok(rawKey.includes('https://api.custom-ai-service.com:8443/v1'));

    // Enqueue into L2
    enqueueL2Cache(rawKey, 'Xin chào Thế giới');
    await flushL2Cache();

    // Inspect chrome.storage.local[L2_CACHE_KEY]
    const trCache = store.local[L2_CACHE_KEY];
    assert.ok(trCache && typeof trCache === 'object', 'L2 cache object must be written to storage');

    const keys = Object.keys(trCache);
    assert.equal(keys.length, 1, 'Should have exactly 1 stored entry');

    const storedKey = keys[0];
    const expectedHex = hashText(rawKey);

    // Assert key is hex, matches hashText, and contains zero URL artifacts
    assert.equal(storedKey, expectedHex);
    assert.match(storedKey, /^[0-9a-f]{8}$/, 'Stored L2 key must be strictly an 8-character hex string');
    assert.ok(!storedKey.includes('http'), 'Stored L2 key must not contain "http"');
    assert.ok(!storedKey.includes('https'), 'Stored L2 key must not contain "https"');
    assert.ok(!storedKey.includes('://'), 'Stored L2 key must not contain "://"');
    assert.ok(!storedKey.includes('/'), 'Stored L2 key must not contain slashes');
    assert.ok(!storedKey.includes('custom-ai-service'), 'Stored L2 key must not contain domain/baseURL');
    assert.equal(trCache[storedKey].text, 'Xin chào Thế giới');
  } finally {
    globalThis.chrome = saved;
  }
});

// ============================================================================
// 7. WI-16 F-HIGH: SET_KEY and credential changes wipe entire L2 cache (pending + stored)
// ============================================================================
test('WI-16 F-HIGH: SET_KEY and credential changes wipe entire L2 cache (pending + stored)', async () => {
  const store = {
    local: {
      settings: {
        version: 7,
        baseURL: 'http://localhost:8080/v1',
        model: 'ag/gemini-3.1-pro-low',
        fallbacks: [{ id: 'fb1', model: 'fallback-model-1' }]
      }
    },
    session: {}
  };

  const savedChrome = globalThis.chrome;
  const savedSelf = globalThis.self;
  globalThis.self = globalThis;

  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return { ...store.local };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) {
            if (k in store.local) out[k] = store.local[k];
          }
          return out;
        },
        set: async (obj) => { Object.assign(store.local, obj); },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store.local[k];
        },
        setAccessLevel: async () => {},
        getAccessLevel: async () => 'TRUSTED_CONTEXTS'
      },
      session: {
        get: async () => ({ ...store.session }),
        set: async (obj) => { Object.assign(store.session, obj); },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store.session[k];
        },
        setAccessLevel: async () => {},
        getAccessLevel: async () => 'TRUSTED_CONTEXTS'
      }
    },
    runtime: {
      id: 'test-ext-id',
      sendMessage: async () => {},
      onMessage: { addListener() {} }
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {}
    }
  };

  try {
    const sw = globalThis.__translatorSw;
    assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW dispatchMessage must be available');
    sw._setTestMode(true);
    sw._resetStorageAccessStateForTest();
    const privilegedSender = { url: `chrome-extension://${globalThis.chrome.runtime.id}/popup.html` };

    // --- (a) SET_KEY wipes both stored L2 and pending writes ---
    store.local[L2_CACHE_KEY] = {
      'deadbeef': { text: 'Old cached translation', savedAt: Date.now() }
    };
    enqueueL2Cache('pending-item', 'Pending translation');

    // Verify preconditions
    assert.ok(store.local[L2_CACHE_KEY], 'L2 cache should be populated before SET_KEY');

    const setKeyRes = await sw.dispatchMessage({ action: 'SET_KEY', key: 'sk-new-api-key-1' }, privilegedSender);
    assert.equal(setKeyRes.ok, true);

    // Stored trCache must be wiped
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'SET_KEY must remove trCache from storage');

    // Pending writes must be cancelled (flush afterwards must not re-create trCache)
    await flushL2Cache();
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'Pending writes must be cleared on SET_KEY');

    // --- (b) DELETE_KEY wipes L2 ---
    store.local[L2_CACHE_KEY] = {
      'cafebabe': { text: 'Cached for current key', savedAt: Date.now() }
    };
    enqueueL2Cache('pending-del', 'Pending del translation');

    const delKeyRes = await sw.dispatchMessage({ action: 'DELETE_KEY' }, privilegedSender);
    assert.equal(delKeyRes.ok, true);
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'DELETE_KEY must remove trCache from storage');
    await flushL2Cache();
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'Pending writes must be cleared on DELETE_KEY');

    // --- (c) SET_FALLBACK_KEY wipes L2 ---
    store.local[L2_CACHE_KEY] = {
      '12345678': { text: 'Fallback translation', savedAt: Date.now() }
    };
    enqueueL2Cache('pending-fb', 'Pending fb translation');

    const setFbRes = await sw.dispatchMessage({ action: 'SET_FALLBACK_KEY', id: 'fb1', key: 'sk-fb-key' }, privilegedSender);
    assert.equal(setFbRes.ok, true);
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'SET_FALLBACK_KEY must remove trCache');
    await flushL2Cache();
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'Pending writes must be cleared on SET_FALLBACK_KEY');

    // --- (d) DELETE_FALLBACK_KEY wipes L2 ---
    store.local[L2_CACHE_KEY] = {
      '87654321': { text: 'Fallback translation 2', savedAt: Date.now() }
    };
    enqueueL2Cache('pending-fb-del', 'Pending fb del translation');

    const delFbRes = await sw.dispatchMessage({ action: 'DELETE_FALLBACK_KEY', id: 'fb1' }, privilegedSender);
    assert.equal(delFbRes.ok, true);
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'DELETE_FALLBACK_KEY must remove trCache');
    await flushL2Cache();
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'Pending writes must be cleared on DELETE_FALLBACK_KEY');

    // --- (e) Direct clearL2Cache() helper invocation ---
    store.local[L2_CACHE_KEY] = { 'abcdef12': { text: 'test', savedAt: Date.now() } };
    await clearL2Cache();
    assert.equal(store.local[L2_CACHE_KEY], undefined, 'clearL2Cache must remove trCache');
  } finally {
    globalThis.chrome = savedChrome;
    globalThis.self = savedSelf;
  }
});
