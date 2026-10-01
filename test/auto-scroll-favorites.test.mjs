// WebMCP Translator Kit — auto-scroll + favorites regression tests.
// Covers: (1) stale content-script context guard, (2) scroll-follow auto-start
// gates, (3) popup live scroll progress, (4) per-Base-URL favorite models.
// Pure settings/SW-behavior tests plus extension source-text guards (content.js
// and popup.js run in the browser and cannot be imported under node:test).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  normalizeBaseURLKey,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'extension', 'src');
const contentSrc = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
const popupSrc = fs.readFileSync(path.join(SRC, 'popup.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');

// ============================================================================
// (4) settings: per-Base-URL favorites
// ============================================================================

test('favorites: normalizeBaseURLKey normalizes URL identity and keeps path/non-default port', () => {
  assert.equal(normalizeBaseURLKey('http://localhost:8080/v1/'), 'http://localhost:8080/v1');
  assert.equal(normalizeBaseURLKey('HTTP://Example.COM/v1'), 'http://example.com/v1');
  assert.equal(normalizeBaseURLKey('https://a.com///'), 'https://a.com');
  assert.equal(normalizeBaseURLKey('https://a.com/'), 'https://a.com');
  assert.equal(normalizeBaseURLKey('https://a.com:443/v1?tenant=one#section'), 'https://a.com/v1');
  assert.equal(normalizeBaseURLKey('https://a.com/v1?tenant=two'), 'https://a.com/v1');
  // Different paths / ports must NOT merge
  assert.notEqual(
    normalizeBaseURLKey('http://h.test:8080/v1'),
    normalizeBaseURLKey('http://h.test:8080/v2')
  );
  assert.notEqual(
    normalizeBaseURLKey('http://h.test:8080/v1'),
    normalizeBaseURLKey('http://h.test:8090/v1')
  );
  // Invalid + key material never form a scope key
  assert.equal(normalizeBaseURLKey(null), null);
  assert.equal(normalizeBaseURLKey(''), null);
  assert.equal(normalizeBaseURLKey('not a url'), null);
  assert.equal(normalizeBaseURLKey('ftp://h.test/v1'), null);
  assert.equal(normalizeBaseURLKey('sk-ant-secret-key-material'), null);
});

test('favorites: legacy global favoriteModels migrates once into current Base URL bucket', () => {
  const A = 'http://127.0.0.1:8089/v1';
  const migrated = migrateSettings({ baseURL: A, favoriteModels: ['m1', 'm2'] });
  const keyA = normalizeBaseURLKey(A);
  assert.deepEqual(migrated.favoriteModels, ['m1', 'm2']);
  assert.deepEqual(migrated.favoriteModelsByBaseURL[keyA], ['m1', 'm2']);
  // Idempotent: second pass is a fixed point
  assert.deepEqual(migrateSettings(migrated), migrated);
});

test('favorites: new Base URL starts empty (no leak), returning restores (coordinator repro)', () => {
  const A = 'https://a.example/v1';
  const B = 'https://b.example/v1';
  const keyA = normalizeBaseURLKey(A);
  const keyB = normalizeBaseURLKey(B);
  const a = migrateSettings({ baseURL: A, favoriteModels: ['a-model'] });
  assert.deepEqual(a.favoriteModels, ['a-model']);
  const b = migrateSettings({ ...a, baseURL: B });
  assert.deepEqual(b.favoriteModels, [], 'B has no bucket: must be empty, not A\'s list');
  assert.deepEqual(b.favoriteModelsByBaseURL[keyA], ['a-model']);
  assert.ok(!(keyB in b.favoriteModelsByBaseURL), 'no bucket may be created for B by the switch alone');
  const back = migrateSettings({ ...b, baseURL: A });
  assert.deepEqual(back.favoriteModels, ['a-model']);
});

test('favorites: scopes are isolated per Base URL and restore on switch', () => {
  const A = 'http://127.0.0.1:8089/v1';
  const B = 'http://127.0.0.1:8099/v1';
  const keyA = normalizeBaseURLKey(A);
  const keyB = normalizeBaseURLKey(B);
  const raw = {
    baseURL: A,
    model: 'primary-model',
    favoriteModels: [],
    favoriteModelsByBaseURL: { [keyA]: ['a1'], [keyB]: ['b1', 'b2'] }
  };
  const onA = migrateSettings(raw);
  assert.deepEqual(onA.favoriteModels, ['a1']);
  assert.deepEqual(onA.favoriteModelsByBaseURL[keyB], ['b1', 'b2']);
  // Switch to B: B list restores, A list preserved in map
  const onB = migrateSettings({ ...onA, baseURL: B });
  assert.deepEqual(onB.favoriteModels, ['b1', 'b2']);
  assert.deepEqual(onB.favoriteModelsByBaseURL[keyA], ['a1']);
});

test('favorites: migration preserves all other settings and strips keys', () => {
  const A = 'http://127.0.0.1:8089/v1';
  const raw = {
    baseURL: A,
    model: 'primary-model',
    fallbacks: [{ id: 'fb1', model: 'fb-model', baseURL: 'http://fb.test/v1' }],
    favoriteModels: ['fav-1'],
    autoTranslateSites: ['https://auto1.com'],
    translationMode: 'full',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    widgetVisible: false,
    api_key: 'sk-must-not-persist',
    fallback_api_keys: { fb1: 'sk-fb' }
  };
  const m = migrateSettings(raw);
  assert.equal(m.model, 'primary-model');
  assert.deepEqual(m.fallbacks, [{ id: 'fb1', model: 'fb-model', baseURL: 'http://fb.test/v1' }]);
  assert.equal(m.translationMode, 'full');
  assert.equal(m.sourceLanguage, 'en');
  assert.equal(m.targetLanguage, 'zh');
  assert.equal(m.widgetVisible, false);
  assert.equal(m.autoTranslateSites[0].origin, 'https://auto1.com');
  assert.ok(!('api_key' in m) && !('fallback_api_keys' in m));
  assert.deepEqual(m.favoriteModels, ['fav-1']);
  assert.deepEqual(m.favoriteModelsByBaseURL[normalizeBaseURLKey(A)], ['fav-1']);
});

test('favorites: trailing-slash key variants merge, invalid keys drop, lists cap at 50', () => {
  const m = migrateSettings({
    baseURL: 'http://h.test/v1',
    favoriteModels: [],
    favoriteModelsByBaseURL: {
      'http://h.test/v1/': ['a'],
      'http://h.test/v1': ['b', 'a'],
      'not a url': ['junk'],
      'ftp://h.test/v1': ['junk2']
    }
  });
  const keys = Object.keys(m.favoriteModelsByBaseURL);
  assert.equal(keys.length, 1);
  assert.deepEqual(m.favoriteModelsByBaseURL['http://h.test/v1'], ['a', 'b']);

  const many = Array.from({ length: 60 }, (_, i) => `model-${i}`);
  const capped = migrateSettings({ baseURL: 'http://h.test/v1', favoriteModels: many });
  assert.equal(capped.favoriteModels.length, 50);
  assert.equal(capped.favoriteModelsByBaseURL['http://h.test/v1'].length, 50);
});

test('favorites: validateSettings accepts scoped map and rejects bad shapes', () => {
  const good = {
    baseURL: 'http://localhost:8080/v1',
    model: 'm',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    favoriteModels: [],
    favoriteModelsByBaseURL: { 'http://localhost:8080/v1': ['a', 'b'] }
  };
  assert.equal(validateSettings(good).valid, true);
  assert.equal(validateSettings({ ...good, favoriteModelsByBaseURL: [] }).valid, false);
  assert.equal(validateSettings({ ...good, favoriteModelsByBaseURL: { k: 'nope' } }).valid, false);
  assert.equal(validateSettings({ ...good, favoriteModelsByBaseURL: { k: ['a', 'a'] } }).valid, false);
  assert.equal(
    validateSettings({ ...good, favoriteModelsByBaseURL: { k: Array.from({ length: 51 }, (_, i) => `m${i}`) } }).valid,
    false
  );
  const badScope = validateSettings({ ...good, favoriteModelsByBaseURL: { 'not a url': ['a'] } });
  assert.equal(badScope.valid, false);
  assert.ok(
    badScope.errors.some((e) => /favoriteModelsByBaseURL/i.test(e)),
    'must report invalid scope key: ' + JSON.stringify(badScope.errors)
  );
});

test('favorites: validateSettings rejects duplicate normalized scope keys before any save', () => {
  const base = {
    baseURL: 'http://localhost:8080/v1',
    model: 'm',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    favoriteModels: [],
    favoriteModelsByBaseURL: {
      'https://a.example/v1': ['a'],
      ' https://a.example/v1/ ': ['b']
    }
  };
  const res = validateSettings(base);
  assert.equal(res.valid, false);
  assert.ok(
    res.errors.some((e) => /favoriteModelsByBaseURL/i.test(e) && /duplicate/i.test(e)),
    'must report duplicate normalized scope: ' + JSON.stringify(res.errors)
  );
  assert.equal(
    validateSettings({
      ...base,
      favoriteModelsByBaseURL: {
        'https://a.example/v1': ['a'],
        'https://b.example/v1': ['b']
      }
    }).valid,
    true
  );
});

// ============================================================================
// (2) SW: WIDGET_GET_STATE auto-start gates (behavioral, stubbed chrome)
// ============================================================================

const SITE = 'http://127.0.0.1:8091';
const SITE_URL = `${SITE}/fixture.html`;
const PROVIDER_A = 'http://127.0.0.1:8089/v1';

function makeChromeStub(store, permState) {
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
    setAccessLevel: async () => {},
    getAccessLevel: async () => 'TRUSTED_CONTEXTS'
  });
  return {
    storage: { local: area(store.local), session: area(store.session), onChanged: { addListener() {} } },
    tabs: {
      sendMessage: async () => ({}),
      query: async () => [],
      get: async () => { throw new Error('No tab'); },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    runtime: { id: 'test-ext-id', onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    permissions: { contains: async () => permState.granted, request: async () => permState.granted, onRemoved: { addListener() {} } },
    scripting: { registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, getRegisteredContentScripts: async () => [], executeScript: async () => [{}] }
  };
}

function baseSettings(over = {}) {
  return {
    version: 5,
    baseURL: PROVIDER_A,
    model: 'ag/m',
    fallbacks: [],
    favoriteModels: [],
    favoriteModelsByBaseURL: {},
    autoTranslateSites: [{ origin: SITE, mode: 'scroll-follow', autoStart: true, sourceLanguage: null, targetLanguage: null, model: null }],
    translationMode: 'scroll-follow',
    widgetVisible: true,
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    rateLimits: { windowSeconds: 60, tab: { maxBatches: 100, maxSourceCodePoints: 1e7 }, site: { maxBatches: 100, maxSourceCodePoints: 1e7 } },
    ...over
  };
}

let sw = null;
let store = null;
let permState = null;

async function widgetState() {
  return sw.dispatchMessage(
    { action: 'WIDGET_GET_STATE' },
    { frameId: 0, tab: { id: 7, url: SITE_URL }, url: SITE_URL }
  );
}

test('autostart gate: configured scroll-follow site auto-starts when all gates pass', async () => {
  store = { local: { settings: baseSettings(), sites: { [SITE]: { createdAt: Date.now() } }, api_key: 'k' }, session: {} };
  permState = { granted: true };
  globalThis.chrome = makeChromeStub(store, permState);
  globalThis.self = globalThis;
  await import('../extension/src/sw.js?autostartfav=1');
  sw = globalThis.__translatorSw;
  assert.ok(sw && typeof sw.dispatchMessage === 'function', 'SW test hook must exist');
  sw._setTestMode(true);
  sw._setTestPermission(SITE, true);
  const st = await widgetState();
  assert.equal(st.effective, 'on');
  assert.equal(st.autoStart, true);
  assert.equal(st.mode, 'scroll-follow');
  assert.equal(st.hasKey, true);
});

test('autostart gate: no requests when key absent / permission revoked / tab override OFF / autoStart off / not listed / default OFF', async () => {
  // key absent
  delete store.local.api_key;
  let st = await widgetState();
  assert.equal(st.autoStart, false);
  assert.equal(st.reason, 'no_key');
  store.local.api_key = 'k';

  // permission revoked
  sw._setTestPermission(SITE, false);
  st = await widgetState();
  assert.equal(st.autoStart, false);
  assert.equal(st.reason, 'no_permission');
  sw._setTestPermission(SITE, true);

  // tab override OFF
  store.session.tab_overrides = { 7: 'off' };
  st = await widgetState();
  assert.equal(st.autoStart, false);
  assert.equal(st.reason, 'tab_off');
  delete store.session.tab_overrides;

  // per-site autoStart disabled
  store.local.settings = baseSettings({
    autoTranslateSites: [{ origin: SITE, mode: 'scroll-follow', autoStart: false, sourceLanguage: null, targetLanguage: null, model: null }]
  });
  st = await widgetState();
  assert.equal(st.autoStart, false);
  assert.equal(st.reason, 'auto_off');

  // default OFF: site in auto list but consent never enabled
  store.local.settings = baseSettings();
  store.local.sites = {};
  st = await widgetState();
  assert.equal(st.autoStart, false);
  assert.equal(st.reason, 'site_off');
  store.local.sites = { [SITE]: { createdAt: Date.now() } };

  // not in auto list at all
  store.local.settings = baseSettings({ autoTranslateSites: [] });
  st = await widgetState();
  assert.equal(st.autoStart, false);
  assert.equal(st.reason, 'not_in_list');
  store.local.settings = baseSettings();
});

test('favorites: A → new B → A persists across popup close/reopen (SW storage round-trip)', async () => {
  const A = 'http://127.0.0.1:8089/v1';
  const B = 'http://127.0.0.1:8099/v1';
  const keyA = normalizeBaseURLKey(A);
  store.local.settings = migrateSettings({ baseURL: A, model: 'ag/m', favoriteModels: ['a-model'] });
  store.local.sites = {};
  store.local.api_key = 'k';
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  // User switches provider in the popup (autosave persists baseURL change)
  const saveRes = await sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { baseURL: B } }, popupSender);
  assert.ok(saveRes && saveRes.ok, 'SAVE_SETTINGS must succeed: ' + JSON.stringify(saveRes));
  // Popup reopen: fresh GET_SETTINGS for B shows an empty list, A bucket kept
  const reopened = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
  assert.deepEqual(reopened.settings.favoriteModels, [], 'reopened popup on B must show empty favorites');
  assert.deepEqual(reopened.settings.favoriteModelsByBaseURL[keyA], ['a-model']);
  // Switch back to A: list restores
  await sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { baseURL: A } }, popupSender);
  const reopenedA = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
  assert.deepEqual(reopenedA.settings.favoriteModels, ['a-model']);
});

test('favorites: legacy partial save updates active bucket (T43); new URL stays empty', async () => {
  const A = 'http://127.0.0.1:8089/v1';
  const B = 'http://127.0.0.1:8099/v1';
  const keyA = normalizeBaseURLKey(A);
  const keyB = normalizeBaseURLKey(B);
  store.local.settings = migrateSettings({ baseURL: A, model: 'ag/m', favoriteModels: ['fav-test-model'] });
  store.local.sites = {};
  store.local.api_key = 'k';
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  // T43: legacy partial save without a scoped map must update the active bucket.
  const favRes = await sw.dispatchMessage(
    { action: 'SAVE_SETTINGS', settings: { favoriteModels: ['fav-test-model', 'fav-model-2'] } },
    popupSender
  );
  assert.ok(favRes && favRes.ok, 'legacy SAVE_SETTINGS must succeed: ' + JSON.stringify(favRes));
  const afterFav = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
  assert.deepEqual(afterFav.settings.favoriteModels, ['fav-test-model', 'fav-model-2']);
  assert.deepEqual(afterFav.settings.favoriteModelsByBaseURL[keyA], ['fav-test-model', 'fav-model-2']);
  // Isolation: switching to a new URL stays empty, no merge from A.
  await sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { baseURL: B } }, popupSender);
  const onB = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
  assert.deepEqual(onB.settings.favoriteModels, [], 'new Base URL must start empty');
  assert.ok(!(keyB in (onB.settings.favoriteModelsByBaseURL || {})), 'no bucket may be created for B by the switch alone');
  assert.deepEqual(onB.settings.favoriteModelsByBaseURL[keyA], ['fav-test-model', 'fav-model-2']);
});

test('sw: concurrent SAVE_SETTINGS patches preserve both updates', async () => {
  const A = 'http://127.0.0.1:8089/v1';
  const keyA = normalizeBaseURLKey(A);
  store.local.settings = migrateSettings({ baseURL: A, model: 'ag/old', favoriteModels: ['old'] });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  const originalGet = chrome.storage.local.get;
  const originalSet = chrome.storage.local.set;
  let settingsSetCount = 0;

  chrome.storage.local.get = async (keys) => {
    const result = await originalGet(keys);
    const requested = keys === null || keys === undefined ? [] : (Array.isArray(keys) ? keys : [keys]);
    if (requested.includes('settings')) await new Promise(resolve => setTimeout(resolve, 10));
    return result;
  };
  chrome.storage.local.set = async (values) => {
    if (values.settings && ++settingsSetCount === 1) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return originalSet(values);
  };

  try {
    const [favoriteSave, modeSave] = await Promise.all([
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteModels: ['race-favorite'] } }, popupSender),
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { translationMode: 'full' } }, popupSender)
    ]);
    assert.ok(favoriteSave?.ok && modeSave?.ok, 'both concurrent settings writes must succeed');
  } finally {
    chrome.storage.local.get = originalGet;
    chrome.storage.local.set = originalSet;
  }

  const final = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
  assert.deepEqual(final.settings.favoriteModels, ['race-favorite']);
  assert.deepEqual(final.settings.favoriteModelsByBaseURL[keyA], ['race-favorite']);
  assert.equal(final.settings.translationMode, 'full');
});

test('sw: WIDGET_SET_MODE serializes with favorite SAVE_SETTINGS', async () => {
  const A = 'http://127.0.0.1:8089/v1';
  const keyA = normalizeBaseURLKey(A);
  const previousSettings = store.local.settings;
  store.local.settings = migrateSettings({ baseURL: A, model: 'ag/old', favoriteModels: ['old'] });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  const widgetSender = { frameId: 0, tab: { id: 7, url: SITE_URL }, url: SITE_URL };
  const originalGet = chrome.storage.local.get;
  const originalSet = chrome.storage.local.set;
  let settingsSetCount = 0;

  chrome.storage.local.get = async (keys) => {
    const result = await originalGet(keys);
    const requested = keys === null || keys === undefined ? [] : (Array.isArray(keys) ? keys : [keys]);
    if (requested.includes('settings')) await new Promise(resolve => setTimeout(resolve, 10));
    return result;
  };
  chrome.storage.local.set = async (values) => {
    if (values.settings && ++settingsSetCount === 1) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return originalSet(values);
  };

  let final;
  try {
    const [favoriteSave, modeSave] = await Promise.all([
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteModels: ['widget-race-favorite'] } }, popupSender),
      sw.dispatchMessage({ action: 'WIDGET_SET_MODE', mode: 'full' }, widgetSender)
    ]);
    assert.ok(favoriteSave?.ok && modeSave?.ok, 'both settings actions must succeed');
    final = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
  } finally {
    chrome.storage.local.get = originalGet;
    chrome.storage.local.set = originalSet;
    store.local.settings = previousSettings;
  }

  assert.deepEqual(final.settings.favoriteModels, ['widget-race-favorite']);
  assert.deepEqual(final.settings.favoriteModelsByBaseURL[keyA], ['widget-race-favorite']);
  assert.equal(final.settings.translationMode, 'full');
});

test('sw: concurrent per-Base-URL favorite patches preserve other providers', async () => {
  const A = 'https://provider-a.example/v1';
  const B = 'https://provider-b.example/v1';
  const keyA = normalizeBaseURLKey(A);
  const keyB = normalizeBaseURLKey(B);
  const previousSettings = store.local.settings;
  store.local.settings = migrateSettings({
    baseURL: A,
    model: 'ag/old',
    favoriteModels: [],
    favoriteModelsByBaseURL: { [keyA]: ['a-old'], [keyB]: ['b-old'] }
  });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };

  try {
    const [saveA, saveB] = await Promise.all([
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteModelsByBaseURL: { [keyA]: ['a-new'] } } }, popupSender),
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteModelsByBaseURL: { [keyB]: ['b-new'] } } }, popupSender)
    ]);
    assert.ok(saveA?.ok && saveB?.ok, 'both provider bucket saves must succeed');
    const final = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
    assert.deepEqual(final.settings.favoriteModelsByBaseURL[keyA], ['a-new']);
    assert.deepEqual(final.settings.favoriteModelsByBaseURL[keyB], ['b-new']);
  } finally {
    store.local.settings = previousSettings;
  }
});

test('sw: concurrent favorite toggles apply to latest provider bucket', async () => {
  const A = 'https://provider-a.example/v1';
  const B = 'https://provider-b.example/v1';
  const keyA = normalizeBaseURLKey(A);
  const keyB = normalizeBaseURLKey(B);
  const previousSettings = store.local.settings;
  store.local.settings = migrateSettings({
    baseURL: A,
    model: 'ag/old',
    favoriteModels: ['a-old'],
    favoriteModelsByBaseURL: { [keyA]: ['a-old'], [keyB]: ['b-old'] }
  });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };

  try {
    const [toggleA, toggleB] = await Promise.all([
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'a-new', favorite: true } } }, popupSender),
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'a-second', favorite: true } } }, popupSender)
    ]);
    assert.ok(toggleA?.ok && toggleB?.ok, 'both favorite toggles must succeed');
    assert.deepEqual(toggleA.favoriteToggle.favorites, ['a-old', 'a-new']);
    assert.deepEqual(toggleB.favoriteToggle.favorites, ['a-old', 'a-new', 'a-second']);
    const final = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
    assert.deepEqual(final.settings.favoriteModelsByBaseURL[keyA], ['a-old', 'a-new', 'a-second']);
    assert.deepEqual(final.settings.favoriteModelsByBaseURL[keyB], ['b-old']);
  } finally {
    store.local.settings = previousSettings;
  }
});

test('favorites limit: add at the 50-model limit rejects without changing storage', async () => {
  const A = 'https://provider-limit.example/v1';
  const keyA = normalizeBaseURLKey(A);
  const full = Array.from({ length: 50 }, (_, i) => `m-${i}`);
  const previousSettings = store.local.settings;
  store.local.settings = migrateSettings({
    baseURL: A,
    model: 'ag/m',
    favoriteModels: [],
    favoriteModelsByBaseURL: { [keyA]: [...full] }
  });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  try {
    const res = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'm-new', favorite: true } } },
      popupSender
    );
    assert.ok(res && res.error, 'add at the limit must reject: ' + JSON.stringify(res));
    assert.equal(res.error.code, 'CAP_EXCEEDED');
    assert.equal(res.error.retryable, false);
    assert.match(res.error.message, /tối đa 50/);
    assert.equal(res.error.details?.capType, 'items');
    assert.equal(res.error.details?.limit, 50);
    assert.equal(res.error.details?.actual, 51);
    const after = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
    assert.deepEqual(after.settings.favoriteModelsByBaseURL[keyA], full);
    assert.deepEqual(after.settings.favoriteModels, full);
  } finally {
    store.local.settings = previousSettings;
  }
});

test('favorites limit: remove at the 50-model limit succeeds', async () => {
  const A = 'https://provider-limit.example/v1';
  const keyA = normalizeBaseURLKey(A);
  const full = Array.from({ length: 50 }, (_, i) => `m-${i}`);
  const previousSettings = store.local.settings;
  store.local.settings = migrateSettings({
    baseURL: A,
    model: 'ag/m',
    favoriteModels: [],
    favoriteModelsByBaseURL: { [keyA]: [...full] }
  });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  try {
    const res = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'm-0', favorite: false } } },
      popupSender
    );
    assert.ok(res && res.ok, 'remove at the limit must succeed: ' + JSON.stringify(res));
    assert.deepEqual(res.favoriteToggle.favorites, full.filter((m) => m !== 'm-0'));
    const after = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
    assert.equal(after.settings.favoriteModelsByBaseURL[keyA].length, 49);
    assert.ok(!after.settings.favoriteModelsByBaseURL[keyA].includes('m-0'));
  } finally {
    store.local.settings = previousSettings;
  }
});

test('favorites stale intent: two concurrent stale favorite:true preserve the model once', async () => {
  const A = 'https://provider-stale.example/v1';
  const keyA = normalizeBaseURLKey(A);
  const previousSettings = store.local.settings;
  store.local.settings = migrateSettings({
    baseURL: A,
    model: 'ag/m',
    favoriteModels: [],
    favoriteModelsByBaseURL: { [keyA]: [] }
  });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  try {
    const [first, second] = await Promise.all([
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'stale-model', favorite: true } } }, popupSender),
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'stale-model', favorite: true } } }, popupSender)
    ]);
    assert.ok(first?.ok && second?.ok, 'both stale adds must succeed idempotently');
    const final = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
    assert.deepEqual(final.settings.favoriteModelsByBaseURL[keyA], ['stale-model']);
  } finally {
    store.local.settings = previousSettings;
  }
});

test('favorites stale intent: explicit false removes and validates desired state', async () => {
  const A = 'https://provider-stale.example/v1';
  const keyA = normalizeBaseURLKey(A);
  const previousSettings = store.local.settings;
  store.local.settings = migrateSettings({
    baseURL: A,
    model: 'ag/m',
    favoriteModels: [],
    favoriteModelsByBaseURL: { [keyA]: ['keep', 'drop'] }
  });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  try {
    const remove = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'drop', favorite: false } } },
      popupSender
    );
    assert.ok(remove?.ok, 'explicit false must remove: ' + JSON.stringify(remove));
    assert.deepEqual(remove.favoriteToggle.favorites, ['keep']);
    const noop = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'missing', favorite: false } } },
      popupSender
    );
    assert.ok(noop?.ok, 'false for an absent model must succeed as a no-op');
    assert.deepEqual(noop.favoriteToggle.favorites, ['keep']);
    const invalid = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'keep' } } },
      popupSender
    );
    assert.ok(invalid && invalid.error, 'missing desired state must be rejected');
    assert.equal(invalid.error.code, 'INVALID_SCHEMA');
    assert.equal(invalid.error.retryable, false);
  } finally {
    store.local.settings = previousSettings;
  }
});

test('popup: stars send the displayed desired state (favorite true|false)', () => {
  const primaryIdx = popupSrc.indexOf('btnToggleFavorite.addEventListener');
  assert.ok(primaryIdx > 0, 'missing primary star control');
  const primaryEnd = popupSrc.indexOf('\n  if (selectModel)', primaryIdx);
  const primaryBlock = popupSrc.slice(primaryIdx, primaryEnd > primaryIdx ? primaryEnd : undefined);
  assert.ok(primaryBlock.includes('!primaryFavorites().includes(curVal)'),
    'primary star must compute desired state from the displayed bucket');
  assert.ok(primaryBlock.includes('saveFavoriteToggle(scopeKey, curVal, desiredFavorite)'),
    'primary star must send the displayed desired state');
  assert.ok(primaryBlock.includes('Lỗi cập nhật yêu thích:'), 'primary star must surface the limit error message');
  const fbIdx = popupSrc.indexOf('btnFallbackFav.addEventListener');
  assert.ok(fbIdx > 0, 'missing fallback star control');
  assert.ok(swSrc.includes("return createTypedError('CAP_EXCEEDED', 'Danh sách yêu thích đã đạt tối đa 50 model cho provider này'"),
    'limit rejection must use a typed non-retryable error with a Vietnamese message');
  assert.ok(swSrc.includes('if (wantFavorite)') && swSrc.includes('bucket.includes(model)'),
    'worker must apply add/remove idempotently against the latest stored bucket');
});

test('sw: v4 favorites migration is serialized with a concurrent settings save', async () => {
  const previousSettings = store.local.settings;
  store.local.settings = {
    version: 4,
    baseURL: PROVIDER_A,
    model: 'ag/m',
    favoriteModels: ['legacy-favorite'],
    fallbacks: [],
    autoTranslateSites: [],
    translationMode: 'scroll-follow',
    widgetVisible: true,
    sourceLanguage: 'auto',
    targetLanguage: 'vi'
  };
  const originalSet = chrome.storage.local.set;
  let settingsWriteCount = 0;
  chrome.storage.local.set = async (values) => {
    if (values.settings) settingsWriteCount++;
    return originalSet(values);
  };

  try {
    const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
    const [first, save] = await Promise.all([
      sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender),
      sw.dispatchMessage({ action: 'SAVE_SETTINGS', settings: { widgetVisible: false } }, popupSender)
    ]);
    assert.equal(first.settings.version, 5);
    assert.ok(save?.ok, 'concurrent settings save must succeed');
    const current = await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
    assert.equal(current.settings.version, 5);
    assert.deepEqual(current.settings.favoriteModelsByBaseURL[PROVIDER_A], ['legacy-favorite']);
    assert.equal(current.settings.widgetVisible, false, 'concurrent partial settings change must survive migration write');
    const writesAfterConcurrentRead = settingsWriteCount;
    await sw.dispatchMessage({ action: 'GET_SETTINGS' }, popupSender);
    assert.equal(settingsWriteCount, writesAfterConcurrentRead, 'subsequent reads must not rewrite the migrated record');
  } finally {
    chrome.storage.local.set = originalSet;
    store.local.settings = previousSettings;
  }
});

// ============================================================================
// (1) content.js: stale-context guard (source-text regression pins)
// ============================================================================

test('content: stale extension context halts silently instead of throwing', () => {
  assert.ok(contentSrc.includes('__wmtValidContext'), 'missing validity check');
  assert.ok(contentSrc.includes('typeof chrome.runtime.sendMessage'), 'guard must test sendMessage capability');
  assert.ok(!contentSrc.includes('runtime.id'), 'guard must not require runtime.id (smoke bridge has sendMessage but no id)');
  assert.ok(contentSrc.includes('__wmtHaltStale'), 'missing stale-halt routine');
  assert.ok(contentSrc.includes('autoStartTimer') && contentSrc.includes('stopScrollFollowSession(false)'),
    'halt must clear auto-start timer and stop scroll session');
  assert.ok(contentSrc.includes('__wmtFire({ action: \'CANCEL_PENDING\''), 'fire-and-forget sends must use stale-safe helper');
  // sendChunk resolves ABORTED on invalidation (non-retryable: no retry spam)
  assert.ok(contentSrc.includes('Extension context invalidated') && contentSrc.includes('ABORTED'),
    'invalidation must resolve ABORTED, never throw/spam');
  // No unguarded chrome.runtime.lastError reads may remain: every read must be
  // null-safe (chrome.runtime && ...) and every callback must test for
  // invalidation (old bare `if (chrome.runtime.lastError)` style is gone).
  assert.ok(!contentSrc.includes('if (chrome.runtime.lastError)'), 'bare lastError read must be gone');
  assert.ok(!contentSrc.includes('if (!chrome.runtime.lastError'), 'negated bare lastError read must be gone');
  assert.ok(!contentSrc.includes('chrome.runtime?.lastError'), 'optional-chain lastError read must be gone');
  const invalidatedChecks = (contentSrc.match(/context invalidated/gi) || []).length;
  assert.ok(invalidatedChecks >= 7, `every async boundary must test invalidation (found ${invalidatedChecks})`);
});

test('content: sendMessage without runtime.id can start translation (smoke bridge)', async () => {
  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }
  try {
    function fakeEl(tag = 'DIV') {
      const el = {
        style: {}, dataset: {}, tagName: tag, id: '',
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {},
        attachShadow: () => fakeEl(),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isContentEditable: false, parentElement: null, isConnected: true
      };
      return el;
    }
    const bodyFake = fakeEl('BODY');
    const parent = fakeEl('P');
    parent.parentElement = bodyFake;
    const tn = { nodeType: 3, nodeValue: 'hello world smoke bridge', parentElement: parent, isConnected: true };
    let yielded = false;
    let callbackInvalidated = false;
    let translationRequests = 0;
    // Smoke bridge: sendMessage exists, runtime.id absent.
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: (msg, cb) => {
          if (msg && msg.action === 'TRANSLATE_BATCH') {
            translationRequests++;
            if (callbackInvalidated) {
              globalThis.chrome.runtime.lastError = { message: 'Extension context invalidated' };
              if (typeof cb === 'function') cb(undefined);
              globalThis.chrome.runtime.lastError = null;
              return;
            }
            const results = (msg.payload.items || []).map((it) => ({ id: it.id, text: '[vi] ' + it.text, revision: it.revision }));
            if (typeof cb === 'function') cb({ results });
          } else if (typeof cb === 'function') { cb({ ok: true }); }
        }
      }
    };
    const win = {
      innerHeight: 800, innerWidth: 1200,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    globalThis.window = win;
    const docEl = fakeEl('HTML');
    docEl.appendChild = () => {};
    globalThis.document = {
      documentElement: docEl, body: bodyFake,
      getElementById: () => null,
      createElement: (t) => fakeEl(t),
      createTreeWalker: () => ({ nextNode: () => (yielded ? null : (yielded = true, tn)) }),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'http:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 0;
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;
    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');
    const res = await dom.executeTranslation({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    assert.notEqual(res && res.cancelled, true, 'no-id bridge must not cancel: ' + JSON.stringify(res));
    assert.equal(res && res.ok, true, 'no-id bridge must start translation: ' + JSON.stringify(res));
    assert.ok((res.applied || 0) >= 1, 'expected applied>=1: ' + JSON.stringify(res));
    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    assert.equal(dom.getStatus().watching, true, 'scroll-follow must be active before callback invalidation');
    callbackInvalidated = true;
    const stale = await dom.sendChunk([{ id: 'stale-callback', text: 'stale callback', revision: 0 }], {}, dom.getEpoch());
    assert.equal(stale.error?.code, 'ABORTED', 'lastError invalidation callback must resolve ABORTED');
    assert.equal(stale.error?.retryable, false, 'invalidation must not retry');
    assert.equal(dom.getStatus().watching, false, 'lastError invalidation must stop active scroll-follow');
    const countAfterHalt = translationRequests;
    const followup = await dom.sendChunk([{ id: 'stale-followup', text: 'must not resend', revision: 0 }], {}, dom.getEpoch());
    assert.equal(followup.error?.code, 'ABORTED');
    assert.equal(translationRequests, countAfterHalt, 'halted script must not resend after invalidation');
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

test('content: stale send throw halts silently (no throw, cancelled)', async () => {
  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }
  try {
    function fakeEl(tag = 'DIV') {
      const el = {
        style: {}, dataset: {}, tagName: tag, id: '',
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {},
        attachShadow: () => fakeEl(),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isContentEditable: false, parentElement: null, isConnected: true
      };
      return el;
    }
    const bodyFake = fakeEl('BODY');
    const parent = fakeEl('P');
    parent.parentElement = bodyFake;
    const tn = { nodeType: 3, nodeValue: 'stale context text', parentElement: parent, isConnected: true };
    let yielded = false;
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: () => { throw new Error('Extension context invalidated'); }
      }
    };
    const win = {
      innerHeight: 800, innerWidth: 1200,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    globalThis.window = win;
    const docEl = fakeEl('HTML');
    docEl.appendChild = () => {};
    globalThis.document = {
      documentElement: docEl, body: bodyFake,
      getElementById: () => null,
      createElement: (t) => fakeEl(t),
      createTreeWalker: () => ({ nextNode: () => (yielded ? null : (yielded = true, tn)) }),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'http:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 0;
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;
    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');
    const chunkRes = await dom.sendChunk([{ id: 'T1', text: 'hi', revision: 0 }], {}, dom.getEpoch());
    assert.equal(chunkRes && chunkRes.error && chunkRes.error.code, 'ABORTED', 'stale send must resolve ABORTED: ' + JSON.stringify(chunkRes));
    yielded = false;
    tn.nodeValue = 'stale context text';
    let execRes = null;
    let threw = null;
    try { execRes = await dom.executeTranslation({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m', force: true }); }
    catch (e) { threw = e; }
    assert.equal(threw, null, 'stale executeTranslation must not throw');
    assert.equal(execRes && execRes.cancelled, true, 'stale executeTranslation must halt silently: ' + JSON.stringify(execRes));
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

test('content: auto-start is gated and retried without manual interaction', () => {
  assert.ok(contentSrc.includes('st.hasKey !== true'), 'auto-start must fail closed when hasKey is not true');
  assert.ok(contentSrc.includes('st.permission !== true'), 'auto-start must fail closed when permission is not true');
  const stateIdx = contentSrc.indexOf('let widgetState = {');
  const stateEnd = contentSrc.indexOf('\n    };', stateIdx);
  const stateDefaults = contentSrc.slice(stateIdx, stateEnd);
  assert.ok(stateDefaults.includes('permission: false') && stateDefaults.includes('hasKey: false'),
    'initial merged widget-state defaults must fail closed');
  assert.ok(contentSrc.includes("st.effective !== 'on'"), 'auto-start must require effective consent');
  assert.ok(!contentSrc.includes("st.effective && st.effective !== 'on'"), 'missing effective field must not pass the gate');
  assert.ok(contentSrc.includes('AUTO_QUERY_MAX_RETRIES') && contentSrc.includes('autoStartQueryRetries'),
    'transient WIDGET_GET_STATE failure must retry so fresh loads start promptly');
  assert.ok(contentSrc.includes('WIDGET_STATE_CHANGED') && contentSrc.includes('queryState()'),
    'late-arriving consent/permission must re-evaluate auto-start');
  // The one-shot attempt must be consumed only after gates pass, otherwise a
  // first disabled response blocks the later enabled push forever.
  const gateIdx = contentSrc.indexOf("st.effective !== 'on'");
  const consumeIdx = contentSrc.indexOf('autoStartAttempted = true');
  assert.ok(gateIdx > 0 && consumeIdx > gateIdx, 'attempt must be consumed after the gates, not before');
});

test('content: disabled first state does not consume auto-start; later enabled push starts scroll session', async () => {
  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }
  try {
    function fakeEl() {
      const el = {
        style: {}, dataset: {},
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {},
        attachShadow: () => fakeEl(),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}
      };
      return el;
    }
    const docEl = fakeEl();
    docEl.appendChild = () => {};
    const runtimeHandlers = [];
    const widgetState = { kind: 'disabled' };
    const disabledResp = {
      effective: 'off', siteEnabled: false, tabOverride: null, permission: false,
      mode: 'scroll-follow', sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m',
      widgetVisible: true, position: null, hasKey: false, autoStart: false, siteConfig: null, reason: 'site_off'
    };
    const enabledResp = {
      effective: 'on', siteEnabled: true, tabOverride: null, permission: true,
      mode: 'scroll-follow', sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m',
      widgetVisible: true, position: null, hasKey: true, autoStart: true,
      siteConfig: { origin: 'http://127.0.0.1:8091', mode: 'scroll-follow', autoStart: true, sourceLanguage: null, targetLanguage: null, model: null }
    };
    globalThis.chrome = {
      runtime: {
        id: 'test-ext-id', lastError: null,
        sendMessage: (msg, cb) => {
          if (msg && msg.action === 'WIDGET_GET_STATE') {
            if (typeof cb === 'function') cb({ ...(widgetState.kind === 'enabled' ? enabledResp : disabledResp) });
          } else if (typeof cb === 'function') { cb({ ok: true }); }
        },
        onMessage: { addListener: (h) => { runtimeHandlers.push(h); } }
      }
    };
    const win = {
      innerHeight: 800, innerWidth: 1200,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    globalThis.window = win;
    globalThis.document = {
      documentElement: docEl, body: null,
      getElementById: () => null,
      createElement: () => fakeEl(),
      createTreeWalker: () => ({ nextNode: () => null }),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'http:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 0;
    class FakeObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');
    // Init auto-queried with the disabled state: nothing may start …
    await new Promise((r) => setTimeout(r, 650));
    assert.equal(dom.getStatus().watching, false, 'disabled first state must not start watching');
    // … but a later enabled push (key/permission granted after load) starts it.
    widgetState.kind = 'enabled';
    for (const h of runtimeHandlers) {
      try { h({ ...enabledResp, action: 'WIDGET_STATE_CHANGED' }, {}, () => {}); } catch {}
    }
    await new Promise((r) => setTimeout(r, 900));
    const st = dom.getStatus();
    assert.equal(st.watching, true, 'enabled push must start the scroll-follow session');
    assert.equal(st.mode, 'scroll-follow');
    // Consent turning off stops the session and must not leave a 'translating' status behind …
    for (const h of runtimeHandlers) {
      try { h({ ...disabledResp, action: 'WIDGET_STATE_CHANGED' }, {}, () => {}); } catch {}
    }
    const off = dom.getStatus();
    assert.equal(off.watching, false, 'consent off must stop watching');
    assert.notEqual(off.state, 'translating', 'consent off must not keep reporting translating');
    // … and an explicit re-enable starts a fresh session.
    dom.startScrollFollowSession({});
    const again = dom.getStatus();
    assert.equal(again.watching, true, 'explicit re-enable must start a new session');
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

test('content: auto-start fails closed for missing key/permission and still starts when complete', async () => {
  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }
  try {
    function fakeEl() {
      return {
        style: {}, dataset: {},
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {},
        querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}
      };
    }
    const runtimeHandlers = [];
    const baseState = {
      effective: 'on', siteEnabled: true, tabOverride: null, mode: 'scroll-follow',
      sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m', widgetVisible: true,
      position: null, autoStart: true,
      siteConfig: { origin: 'http://127.0.0.1:8091', mode: 'scroll-follow', autoStart: true, sourceLanguage: null, targetLanguage: null, model: null }
    };
    const states = {
      missingKey: { ...baseState, permission: true },
      missingPermission: { ...baseState, hasKey: true },
      enabled: { ...baseState, hasKey: true, permission: true }
    };
    assert.ok(!('hasKey' in states.missingKey));
    assert.ok(!('permission' in states.missingPermission));
    let stateName = 'missingKey';
    globalThis.chrome = {
      runtime: {
        id: 'test-ext-id', lastError: null,
        sendMessage: (msg, cb) => {
          if (msg?.action === 'WIDGET_GET_STATE') {
            if (typeof cb === 'function') cb({ ...states[stateName] });
          } else if (typeof cb === 'function') cb({ ok: true });
        },
        onMessage: { addListener: (handler) => runtimeHandlers.push(handler) }
      }
    };
    const win = {
      innerHeight: 800, innerWidth: 1200, top: null,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    globalThis.window = win;
    globalThis.document = {
      documentElement: fakeEl(), body: null,
      getElementById: () => null, createElement: () => fakeEl(),
      createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'http:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 0;
    class FakeObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(dom.getStatus().watching, false, 'missing hasKey must not begin translating');

    stateName = 'missingPermission';
    for (const handler of runtimeHandlers) {
      try { handler({ action: 'WIDGET_STATE_CHANGED', ...states.missingPermission }, {}, () => {}); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(dom.getStatus().watching, false, 'missing permission must not begin translating');

    stateName = 'enabled';
    for (const handler of runtimeHandlers) {
      try { handler({ action: 'WIDGET_STATE_CHANGED', ...states.enabled }, {}, () => {}); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(dom.getStatus().watching, true, 'complete positive response must still begin translating');
    assert.equal(dom.getStatus().mode, 'scroll-follow');
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

// ============================================================================
// (3) popup: live scroll progress in footer + polling while open
// ============================================================================

test('popup: footer shows live applied/collected (+failed), keeps polling, never false-completes', () => {
  assert.ok(popupSrc.includes('Đang theo scroll ${'), 'watching text must embed live applied/collected counts');
  assert.ok(popupSrc.includes('(lỗi)') || popupSrc.includes('lỗi)'), 'watching text must surface failed count');
  assert.ok(popupSrc.includes("state === 'translated' && data && typeof data.totalCollected === 'number' && data.totalCollected > 0"),
    'completed scroll batches must retain final progress counts');
  assert.ok(popupSrc.includes("state === 'error' && data && data.totalFailed > 0"),
    'failed scroll batches must retain failure counts');
  const failedScrollBranch = popupSrc.slice(popupSrc.indexOf('if (st.lastError && (st.totalFailed'), popupSrc.indexOf("} else if (st.watching === true"));
  assert.ok(failedScrollBranch.includes('}), st);'), 'failed scroll status must pass counters into footer rendering');
  const completedScrollBranch = popupSrc.slice(popupSrc.indexOf("} else if (st.state === 'done')"), popupSrc.indexOf("} else if (st.state === 'restored')"));
  assert.ok(completedScrollBranch.includes('}), st);'), 'completed scroll status must pass counters into footer rendering');
  assert.ok(popupSrc.includes('v0.1.0 · ${'), 'footer slot must mirror live progress');
  // Watching branch must keep polling (refresh while open + recover on reopen)
  const watchingIdx = popupSrc.indexOf("updateStatus('watching'");
  assert.ok(watchingIdx > 0, 'missing watching status update');
  assert.ok(popupSrc.slice(Math.max(0, watchingIdx - 400), watchingIdx).includes('startPolling()'),
    'watching branch must startPolling() to refresh while open');
  // Watching (even state done for current viewport) is evaluated before done
  const watchingBranch = popupSrc.indexOf('st.watching === true');
  const doneBranch = popupSrc.indexOf("st.state === 'done'", watchingBranch);
  assert.ok(watchingBranch > 0 && doneBranch > watchingBranch, 'watching must take precedence over done');
});

// ============================================================================
// (4) popup: per-Base-URL favorites incl. fallback controls (source pins)
// ============================================================================

test('popup: favorites are scoped per Base URL with fallback star controls', () => {
  assert.ok(popupSrc.includes('normalizeBaseURLKey'), 'popup must reuse normalized Base URL scope keys');
  assert.ok(popupSrc.includes('favoriteModelsByBaseURL'), 'popup must persist scoped favorites map');
  assert.ok(popupSrc.includes('btn-fallback-fav-'), 'fallback rows must have their own star controls');
  assert.ok(popupSrc.includes('favKeyForFallback'), 'fallback stars must scope to row URL else primary');
  assert.ok(popupSrc.includes("return own ? normalizeBaseURLKey(own) : lastFavKey;"),
    'fallback rows without a custom URL must use the displayed primary scope');
  assert.ok(!popupSrc.includes('scoped.length === 0 && favoriteModels.length'),
    'popup load/switch must never seed an empty bucket from another scope\'s working list');
  assert.ok(!/apiKey|api_key/.test(popupSrc.match(/favoriteModelsByBaseURL[\s\S]{0,300}/)?.[0] || ''),
    'favorites scope must never be keyed by API key');
});

test('popup: full autosave omits favorites and primary save failure re-renders', () => {
  const patchStart = popupSrc.indexOf('function collectSettingsPatch');
  const patchEnd = popupSrc.indexOf('// Autosave: persist every UI change', patchStart);
  const patchBlock = popupSrc.slice(patchStart, patchEnd > patchStart ? patchEnd : undefined);
  assert.ok(patchStart > 0, 'missing autosave patch builder');
  assert.ok(!patchBlock.includes('favoriteModelsByBaseURL'), 'full autosave must not overwrite a newer favorite map');
  assert.ok(!patchBlock.includes('favoriteModels:'), 'full autosave must not update legacy favorites from stale UI');

  const primaryIdx = popupSrc.indexOf('btnToggleFavorite.addEventListener');
  const primaryEnd = popupSrc.indexOf('\n  if (selectModel)', primaryIdx);
  const primaryBlock = popupSrc.slice(primaryIdx, primaryEnd > primaryIdx ? primaryEnd : undefined);
  const catchIdx = primaryBlock.indexOf('} catch (err) {');
  assert.ok(catchIdx >= 0, 'primary star must handle save failures');
  assert.ok(primaryBlock.slice(catchIdx).includes('renderAllModelDropdowns()'),
    'failed primary favorite save must redraw model/favorite dropdowns after rollback');
});

test('popup: fallback star sends an atomic toggle and reports failures', () => {
  const handlerIdx = popupSrc.indexOf('btnFallbackFav.addEventListener');
  assert.ok(handlerIdx > 0, 'missing fallback star control');
  const handlerEnd = popupSrc.indexOf('\n      });\n\n      modelWrap.appendChild', handlerIdx);
  const handlerBlock = popupSrc.slice(handlerIdx, handlerEnd > handlerIdx ? handlerEnd : undefined);
  assert.ok(handlerBlock.includes('saveFavoriteToggle(scopeKey, curModel, desiredFavorite)'), 'fallback star must use the shared serialized favorite path with displayed desired state');
  assert.ok(handlerBlock.includes('!displayedBucket.includes(curModel)') || handlerBlock.includes('!getFavoritesForKey(scopeKey).includes'),
    'fallback star must compute desired state from the displayed bucket');
  assert.ok(handlerBlock.includes('Lỗi cập nhật yêu thích:'), 'fallback star must report save failures');

  const toggleIdx = popupSrc.indexOf('function saveFavoriteToggle');
  const toggleEnd = popupSrc.indexOf('\n  async function flushAutosave', toggleIdx);
  const toggleBlock = popupSrc.slice(toggleIdx, toggleEnd > toggleIdx ? toggleEnd : undefined);
  assert.ok(toggleBlock.includes('favoriteToggle: { scopeKey, model, favorite }'), 'favorite writes must send scope+model+desired favorite, not a stale bucket snapshot');
  const sendToggle = toggleBlock.indexOf('chrome.runtime.sendMessage');
  const acceptToggle = toggleBlock.indexOf('const favoriteToggle = response.favoriteToggle');
  assert.ok(sendToggle >= 0 && acceptToggle > sendToggle, 'popup must apply the service worker\'s serialized canonical favorite result');
  assert.ok(swSrc.includes('favoriteToggle.favorite') && swSrc.includes('favoriteToggle.scopeKey') && swSrc.includes('favoriteToggle.model'),
    'service worker must apply the desired state against the latest saved provider bucket');
  assert.ok(toggleBlock.includes('favoriteWriteInFlight = false'), 'favorite writes must release the autosave gate');
  assert.ok(popupSrc.includes('if (favoriteWriteInFlight) {\n      autosaveQueued = true;'),
    'full autosaves must queue while a favorite partial write is active');
  assert.ok(swSrc.includes('serializeSettingsWrite'), 'service worker must serialize merge-patch settings writes');
});

test('sw: WIDGET_GET_STATE enforces key gate alongside consent/permission', () => {
  assert.ok(swSrc.includes("reason = 'no_key'"), 'SW gate must distinguish missing-key from other denials');
  assert.ok(swSrc.includes('effective !== \'on\''), 'SW gate must honor effective (site + tab-override + default OFF) policy');
});

test('content: auto-start revalidates permission, key and consent during settle', async () => {
  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }
  try {
    function fakeEl() {
      return {
        style: {}, dataset: {},
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {},
        querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}
      };
    }
    const runtimeHandlers = [];
    let getStateCalls = 0;
    const onState = {
      effective: 'on', siteEnabled: true, tabOverride: null, mode: 'scroll-follow',
      sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m', widgetVisible: true,
      position: null, autoStart: true, permission: true, hasKey: true,
      siteConfig: { origin: SITE, mode: 'scroll-follow', autoStart: true, sourceLanguage: null, targetLanguage: null, model: null }
    };
    const offState = { ...onState, effective: 'off', siteEnabled: false, autoStart: false, reason: 'site_off' };
    let current = { ...onState };
    let delayQuery = false;
    globalThis.chrome = {
      runtime: {
        id: 'test-ext-id', lastError: null,
        sendMessage: (msg, cb) => {
          if (msg?.action === 'WIDGET_GET_STATE') {
            getStateCalls++;
            const snap = { ...current };
            if (delayQuery) setTimeout(() => { try { cb({ ...snap }); } catch {} }, 650);
            else if (typeof cb === 'function') cb({ ...snap });
          } else if (typeof cb === 'function') cb({ ok: true });
        },
        onMessage: { addListener: (handler) => runtimeHandlers.push(handler) }
      }
    };
    const win = {
      innerHeight: 800, innerWidth: 1200, top: null,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    globalThis.window = win;
    globalThis.document = {
      documentElement: fakeEl(), body: null,
      getElementById: () => null, createElement: () => fakeEl(),
      createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'http:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 0;
    class FakeObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');
    const pushState = (state) => {
      current = { ...state };
      for (const handler of [...runtimeHandlers]) {
        try { handler({ action: 'WIDGET_STATE_CHANGED', ...state }, {}, () => {}); } catch {}
      }
    };
    const pushEmptyState = (state) => {
      current = { ...state };
      for (const handler of [...runtimeHandlers]) {
        try { handler({ action: 'WIDGET_STATE_CHANGED' }, {}, () => {}); } catch {}
      }
    };

    // Empty broadcast while the 500 ms timer is pending must cancel the stale
    // timer; the delayed authoritative reply (permission revoked) must not start.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dom.getStatus().watching, false);
    current = { ...onState, permission: false };
    delayQuery = true;
    const readsBefore = getStateCalls;
    pushEmptyState(current);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(getStateCalls > readsBefore, 'pending timer broadcast must query current gate state');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(dom.getStatus().watching, false, 'stale timer must not start before delayed reply');
    delayQuery = false;

    // A fresh pending timer must also reject a delayed missing-key state.
    pushState(onState);
    await new Promise((resolve) => setTimeout(resolve, 100));
    delayQuery = true;
    pushEmptyState({ ...onState, hasKey: false });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(dom.getStatus().watching, false, 'delayed missing-key state must not start');
    delayQuery = false;

    // Consent off cancels a pending timer and leaves the later on state retryable.
    pushState(onState);
    await new Promise((resolve) => setTimeout(resolve, 100));
    pushState(offState);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(dom.getStatus().watching, false, 'consent off must cancel the pending timer');
    // Stale query replies must not clobber newer state: hold two queries from
    // successive empty broadcasts, resolve newer off first then older on; the
    // stale on must not schedule/start. Recovery below proves retryable.
    {
      const held = [];
      const origSend = globalThis.chrome.runtime.sendMessage;
      globalThis.chrome.runtime.sendMessage = (msg, cb) => {
        if (msg?.action === 'WIDGET_GET_STATE') { held.push({ cb, snap: { ...current } }); return; }
        return origSend(msg, cb);
      };
      try {
        pushEmptyState({ ...onState });
        pushEmptyState({ ...offState });
        assert.equal(held.length, 2, 'two overlapping queries must be held');
        held[1].cb({ ...held[1].snap });
        held[0].cb({ ...held[0].snap });
        await new Promise((resolve) => setTimeout(resolve, 800));
        assert.equal(dom.getStatus().watching, false, 'stale on reply must not start translation');
      } finally {
        globalThis.chrome.runtime.sendMessage = origSend;
      }
    }
    pushState(onState);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(dom.getStatus().watching, true, 'complete positive state must recover auto-start');
    assert.equal(dom.getStatus().mode, 'scroll-follow');
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

test('sw: malformed favoriteToggle identifies each bad field in schemaErrors', async () => {
  const previousSettings = store.local.settings;
  const A = 'http://127.0.0.1:8089/v1';
  const keyA = normalizeBaseURLKey(A);
  store.local.settings = migrateSettings({
    baseURL: A, model: 'ag/m', favoriteModels: [], favoriteModelsByBaseURL: { [keyA]: [] }
  });
  const popupSender = { url: 'chrome-extension://test-ext-id/popup.html' };
  try {
    const badScope = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: 'not a url', model: 'm1', favorite: true } } },
      popupSender
    );
    assert.ok(badScope?.error && badScope.error.code === 'INVALID_SCHEMA', 'bad scope must reject: ' + JSON.stringify(badScope));
    assert.ok(badScope.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.scopeKey')), 'must identify scopeKey: ' + JSON.stringify(badScope));
    assert.ok(!badScope.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.favorite')), 'valid favorite must not be blamed: ' + JSON.stringify(badScope));
    const badModel = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: '   ', favorite: true } } },
      popupSender
    );
    assert.ok(badModel?.error && badModel.error.code === 'INVALID_SCHEMA', 'bad model must reject: ' + JSON.stringify(badModel));
    assert.ok(badModel.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.model')), 'must identify model: ' + JSON.stringify(badModel));
    assert.ok(!badModel.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.favorite')), 'valid favorite must not be blamed: ' + JSON.stringify(badModel));
    const badFav = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: keyA, model: 'm1' } } },
      popupSender
    );
    assert.ok(badFav?.error && badFav.error.code === 'INVALID_SCHEMA', 'bad favorite must reject: ' + JSON.stringify(badFav));
    assert.ok(badFav.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.favorite')), 'must identify favorite: ' + JSON.stringify(badFav));
    const allBad = await sw.dispatchMessage(
      { action: 'SAVE_SETTINGS', settings: { favoriteToggle: { scopeKey: 'ftp://h.test/v1', model: '', favorite: 'yes' } } },
      popupSender
    );
    assert.ok(allBad?.error && allBad.error.code === 'INVALID_SCHEMA', 'all-bad must reject: ' + JSON.stringify(allBad));
    assert.ok(allBad.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.scopeKey')), 'all-bad must identify scopeKey');
    assert.ok(allBad.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.model')), 'all-bad must identify model');
    assert.ok(allBad.error.details.schemaErrors.some((e) => e.includes('favoriteToggle.favorite')), 'all-bad must identify favorite');
    assert.equal(allBad.error.details.schemaErrors.length, 3);
  } finally {
    store.local.settings = previousSettings;
  }
});
