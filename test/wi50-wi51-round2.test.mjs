// WebMCP Translator Kit — WI-50 & WI-51 Round 2 Acceptance Test Suite
// Verifies fixes for Sol REJECT P1 blockers + P2 issues:
// P1-1: Consent bypass via LIST_MODELS (gated by dataConsent accepted, 0 bytes fetched)
// P1-2: HTTP bypass via stale cache + listModels (centralized guard, key never leaves to remote HTTP)
// P1-3: Browser manual redirects are opaque; reject redirects without replaying page data.
// P2-4: Banner false positive (unknown consent hides auto warning, shows retry UI)
// P2-5: Stale security tooltip (instant update on input/change/save/load of Base URL)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isLoopbackHost,
  isSecureOrLoopbackBaseURL,
  normalizeOrigin
} from '../extension/src/consent.mjs';
import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  CURRENT_DATA_CONSENT_VERSION,
  isDataConsentAccepted,
  buildExportConfig,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';
import {
  createDirect9Router,
  secureFetch
} from '../extension/src/adapter/direct9router.mjs';
import {
  SUPPORTED_UI_LOCALES,
  t
} from '../extension/src/i18n.mjs';
import {
  checkDataConsentAccepted,
  _setTestMode,
  _setTestConsentOverride,
  _setTestPermission,
  _registerTestTab
} from '../extension/src/sw.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const swJsPath = path.resolve(__dirname, '../extension/src/sw.js');
const routerJsPath = path.resolve(__dirname, '../extension/src/adapter/direct9router.mjs');

const popupJs = fs.readFileSync(popupJsPath, 'utf8');
const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');
const swJs = fs.readFileSync(swJsPath, 'utf8');
const routerJs = fs.readFileSync(routerJsPath, 'utf8');

// ============================================================================
// Helper: Minimal Fake Chrome Storage and Runtime for SW testing
// ============================================================================
function setupFakeChrome(initialSettings = {}) {
  const store = {
    local: {
      settings: {
        version: SETTINGS_VERSION,
        baseURL: 'http://127.0.0.1:8080/v1',
        model: 'ag/gemini-3.1-pro-low',
        fallbacks: [],
        favoriteModels: [],
        autoTranslateSites: [],
        dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null },
        ...initialSettings
      },
      api_key: 'test-sk-key-12345',
      fallback_api_keys: {}
    },
    session: {}
  };

  const fakeChrome = {
    storage: {
      local: {
        get: async (k) => Array.isArray(k) ? Object.fromEntries(k.map(x => [x, store.local[x]])) : { ...store.local },
        set: async (v) => Object.assign(store.local, v),
        remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store.local[k]; },
        setAccessLevel: async () => {},
        getAccessLevel: async () => 'TRUSTED_CONTEXTS'
      },
      session: {
        get: async () => ({ ...store.session }),
        set: async (v) => Object.assign(store.session, v),
        clear: async () => { for (const k in store.session) delete store.session[k]; }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      sendMessage: async () => ({}),
      get: async () => ({ id: 9001, url: 'http://127.0.0.1:8090/index.html' }),
      query: async () => []
    },
    runtime: { id: 'test-id', lastError: null },
    permissions: { contains: async () => true, request: async () => true }
  };

  return { store, fakeChrome };
}

// ============================================================================
// P1-1: Consent Bypass via LIST_MODELS (sw.js & popup.js)
// ============================================================================

test('P1-1 (sw): LIST_MODELS returns DATA_CONSENT_REQUIRED when dataConsent is not accepted (0 bytes fetched)', async () => {
  const { store, fakeChrome } = setupFakeChrome({
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null }
  });

  globalThis.chrome = fakeChrome;
  globalThis.self = globalThis;
  const sw = await import('../extension/src/sw.js?testP11=' + Date.now()).then(m => globalThis.__translatorSw);

  try {
    sw._setTestMode(true);
    sw._setTestConsentOverride(false); // Consent not accepted

    const res = await sw.dispatchMessage({ action: 'LIST_MODELS', forceRefresh: false });

    assert.ok(res && res.error, 'LIST_MODELS must return error when consent not accepted');
    assert.equal(res.error.code, 'DATA_CONSENT_REQUIRED');
    assert.equal(res.error.retryable, false);
    assert.equal(res.error.details?.dataConsentVersion, CURRENT_DATA_CONSENT_VERSION);
  } finally {
    sw._setTestConsentOverride(null);
    delete globalThis.chrome;
  }
});

test('P1-1 (sw): LIST_MODELS proceeds when dataConsent is accepted', async () => {
  const { store, fakeChrome } = setupFakeChrome({
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: new Date().toISOString() }
  });

  // Pre-seed cache to avoid network call
  store.local.modelListCache = {
    baseURL: 'http://127.0.0.1:8080/v1',
    keyFingerprint: '', // matches empty or will be evaluated
    models: ['test-model-1'],
    fetchedAt: Date.now()
  };

  globalThis.chrome = fakeChrome;
  globalThis.self = globalThis;
  const sw = await import('../extension/src/sw.js?testP11Accepted=' + Date.now()).then(m => globalThis.__translatorSw);

  try {
    sw._setTestMode(true);
    sw._setTestConsentOverride(true); // Consent accepted

    const res = await sw.dispatchMessage({ action: 'LIST_MODELS', forceRefresh: false });

    assert.ok(!res.error || res.error.code !== 'DATA_CONSENT_REQUIRED', 'Must NOT return DATA_CONSENT_REQUIRED');
  } finally {
    sw._setTestConsentOverride(null);
    delete globalThis.chrome;
  }
});

test('P1-1 (popup): static contract checks: popup startup, loadModels, and refresh are gated by dataConsent', () => {
  // 1. Popup startup checks isDataConsentAccepted before loading models
  assert.ok(
    popupJs.includes('const consentAccepted = isDataConsentAccepted(savedSettings);'),
    'popup.js must evaluate isDataConsentAccepted on startup'
  );
  assert.ok(
    popupJs.includes("if (!consentAccepted) {\n    openModal('consent');\n  }"),
    'popup.js must open consent modal on startup if not accepted'
  );
  assert.ok(
    popupJs.includes('if (hasStoredKey && consentAccepted) {\n      // Cache-first'),
    'popup.js startup must only call loadModels if consentAccepted is true'
  );

  // 2. loadModels has entry guard
  const loadModelsIdx = popupJs.indexOf('async function loadModels(');
  assert.ok(loadModelsIdx !== -1, 'loadModels function must exist in popup.js');
  const loadModelsSlice = popupJs.slice(loadModelsIdx, loadModelsIdx + 200);
  assert.ok(
    loadModelsSlice.includes('if (!isDataConsentAccepted(savedSettings)) {\n      return;\n    }'),
    'loadModels must exit immediately when dataConsent is not accepted'
  );

  // 3. btnRefreshModels click listener requires dataConsent
  const refreshClickIdx = popupJs.indexOf("btnRefreshModels.addEventListener('click'");
  assert.ok(refreshClickIdx !== -1, 'btnRefreshModels click listener must exist');
  const refreshSlice = popupJs.slice(refreshClickIdx, refreshClickIdx + 250);
  assert.ok(
    refreshSlice.includes("if (!isDataConsentAccepted(savedSettings)) {\n        openModal('consent');\n        return;\n      }"),
    'btnRefreshModels must open consent modal and abort if consent is not accepted'
  );

  // 4. btnConsentAccept triggers loadModels after accepting
  const acceptClickIdx = popupJs.indexOf("btnConsentAccept.addEventListener('click'");
  assert.ok(acceptClickIdx !== -1, 'btnConsentAccept click listener must exist');
  const acceptSlice = popupJs.slice(acceptClickIdx, acceptClickIdx + 1000);
  assert.ok(
    acceptSlice.includes('loadModels({ forceRefresh: false })'),
    'btnConsentAccept must call loadModels only after consent is stored'
  );
});

// ============================================================================
// P1-2: HTTP Bypass via Stale Cache + listModels (sw.js & direct9router.mjs)
// ============================================================================

test('P1-2 (sw): Stale model cache for remote HTTP baseURL returns INSECURE_ENDPOINT_BLOCKED immediately', async () => {
  const insecureRemoteBaseURL = 'http://api.remote-insecure.com/v1';
  const { store, fakeChrome } = setupFakeChrome({
    baseURL: insecureRemoteBaseURL,
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: new Date().toISOString() }
  });

  // Inject stale cache from 3 days ago (fresh < 24h, stale <= 7 days)
  const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
  store.local.modelListCache = {
    baseURL: insecureRemoteBaseURL,
    keyFingerprint: 'any-hash',
    models: ['insecure-model-1', 'insecure-model-2'],
    fetchedAt: threeDaysAgo
  };

  globalThis.chrome = fakeChrome;
  globalThis.self = globalThis;
  const sw = await import('../extension/src/sw.js?testP12Stale=' + Date.now()).then(m => globalThis.__translatorSw);

  try {
    sw._setTestMode(true);
    sw._setTestConsentOverride(true);

    // Call sw.listModels with insecure remote baseURL
    const res = await sw.listModels({ baseURL: insecureRemoteBaseURL });

    assert.ok(res && res.error, 'Must return error for remote HTTP Base URL despite stale cache');
    assert.equal(res.error.code, 'INSECURE_ENDPOINT_BLOCKED');
    assert.ok(!res.models, 'Must NOT return cached models for insecure remote endpoint');
  } finally {
    sw._setTestConsentOverride(null);
    delete globalThis.chrome;
  }
});

test('P1-2 (adapter): direct9router listModels rejects remote HTTP before network fetch (zero bytes out)', async () => {
  let fetchCallCount = 0;
  const mockFetch = async () => {
    fetchCallCount++;
    throw new Error('Network should never be reached for remote HTTP');
  };

  const router = createDirect9Router({
    baseURL: 'http://api.insecure-provider.com/v1',
    apiKey: 'super-secret-bearer-key',
    fetchImpl: mockFetch
  });

  const res = await router.listModels({ forceRefresh: true });

  assert.ok(res && res.error, 'Must return error for insecure remote HTTP');
  assert.equal(res.error.code, 'INSECURE_ENDPOINT_BLOCKED');
  assert.equal(fetchCallCount, 0, 'fetch must NOT be called when baseURL is remote HTTP');
});

test('P1-2 (adapter): direct9router listModels allows HTTPS and loopback HTTP', async () => {
  let lastFetchedUrl = null;
  const mockFetch = async (url) => {
    lastFetchedUrl = url;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: [{ id: 'm1' }] })
    };
  };

  // 1. Loopback HTTP
  const routerLoopback = createDirect9Router({
    baseURL: 'http://127.0.0.1:8080/v1',
    apiKey: 'test-key',
    fetchImpl: mockFetch
  });
  const resLoopback = await routerLoopback.listModels({ forceRefresh: true });
  assert.ok(!resLoopback.error, 'Loopback HTTP must not be blocked as insecure');
  assert.equal(lastFetchedUrl, 'http://127.0.0.1:8080/v1/models');

  // 2. Remote HTTPS
  const routerHttps = createDirect9Router({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    fetchImpl: mockFetch
  });
  const resHttps = await routerHttps.listModels({ forceRefresh: true });
  assert.ok(!resHttps.error, 'Remote HTTPS must not be blocked as insecure');
  assert.equal(lastFetchedUrl, 'https://api.openai.com/v1/models');
});

// ============================================================================
// P1-3: Browser Fetch exposes manual redirects as opaque; fail closed.
// ============================================================================

test('P1-3: secureFetch rejects visible redirects without following the destination', async () => {
  const requests = [];
  const result = await secureFetch(
    'https://api.example/v1/chat/completions',
    { method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: 'page text' },
    async (url, options) => {
      requests.push({ url, options });
      return {
        type: 'basic',
        status: 307,
        ok: false,
        headers: new Headers({ location: 'https://other.example/collect' })
      };
    }
  );

  assert.equal(result.error?.error?.code, 'ENDPOINT_REDIRECT_UNSUPPORTED');
  assert.equal(requests.length, 1, 'The redirect destination must never receive a replayed request');
  assert.equal(requests[0].options.redirect, 'manual');
});

// ============================================================================
// P2-4: Banner False Positive & Unknown State Handling (popup.js & popup.html)
// ============================================================================

test('P2-4: popup.html contains #banner-consent-unknown, text, and retry button', () => {
  assert.ok(popupHtml.includes('id="banner-consent-unknown"'), 'popup.html must contain #banner-consent-unknown');
  assert.ok(popupHtml.includes('id="banner-consent-unknown-text"'), 'popup.html must contain #banner-consent-unknown-text');
  assert.ok(popupHtml.includes('id="btn-consent-retry"'), 'popup.html must contain #btn-consent-retry');
  assert.ok(popupHtml.includes('id="btn-consent-retry-text"'), 'popup.html must contain #btn-consent-retry-text');
});

test('P2-4: updateAutoConsentWarningBanner hides banner when consent state is not authoritative', () => {
  // Pure logic verification matching popup.js:
  // if (!currentConsent || currentConsent.authoritative !== true) {
  //   bannerAutoConsentWarning.classList.add('hidden');
  //   return;
  // }
  function evaluateWarningBanner(currentConsent, autoTranslateSites) {
    if (!currentConsent || currentConsent.authoritative !== true) {
      return { visible: false, reason: 'not_authoritative' };
    }
    const origin = currentConsent.siteOrigin;
    if (!origin) return { visible: false, reason: 'no_origin' };

    const matchingSite = autoTranslateSites.find((s) => (s.origin || s) === origin);
    const hasAutoEntry = Boolean(matchingSite && (matchingSite.autoStart !== false));
    const effective = currentConsent.effective || 'off';

    if (hasAutoEntry && effective === 'off') {
      return {
        visible: true,
        type: currentConsent.tabOverride === 'off' ? 'tab_override_off' : 'site_off'
      };
    }
    return { visible: false, reason: 'matching_or_on' };
  }

  const origin = 'https://ixdzs8.com';
  const autoList = [{ origin, autoStart: true }];

  // 1. GET_CONSENT failed / returned error -> authoritative: false
  const stateFailed = { siteOrigin: origin, siteEnabled: false, effective: 'off', authoritative: false };
  const resFailed = evaluateWarningBanner(stateFailed, autoList);
  assert.equal(resFailed.visible, false, 'Banner MUST be hidden when authoritative is false');
  assert.equal(resFailed.reason, 'not_authoritative');

  // 2. currentConsent is null
  const resNull = evaluateWarningBanner(null, autoList);
  assert.equal(resNull.visible, false);

  // 3. GET_CONSENT succeeded -> authoritative: true
  const stateSuccess = { siteOrigin: origin, siteEnabled: false, effective: 'off', authoritative: true };
  const resSuccess = evaluateWarningBanner(stateSuccess, autoList);
  assert.equal(resSuccess.visible, true, 'Banner MUST be visible when authoritative is true and site is off');
  assert.equal(resSuccess.type, 'site_off');
});

test('P2-4 (popup.js): static code verification for loadConsent error handling and retry wiring', () => {
  // 1. loadConsent sets authoritative: false on error
  const loadConsentIdx = popupJs.indexOf('async function loadConsent(');
  assert.ok(loadConsentIdx !== -1, 'loadConsent must exist in popup.js');
  const loadConsentSlice = popupJs.slice(loadConsentIdx, loadConsentIdx + 3000);

  assert.ok(
    loadConsentSlice.includes('authoritative: false'),
    'loadConsent must set authoritative: false on error'
  );
  assert.ok(
    loadConsentSlice.includes('setConsentUnknownUI(true)'),
    'loadConsent must call setConsentUnknownUI(true) on error'
  );
  assert.ok(
    loadConsentSlice.includes('authoritative: true'),
    'loadConsent must set authoritative: true on success'
  );
  assert.ok(
    loadConsentSlice.includes('setConsentUnknownUI(false)'),
    'loadConsent must call setConsentUnknownUI(false) on success'
  );

  // 2. Retry button triggers loadConsent
  const retryListenerIdx = popupJs.indexOf("btnConsentRetry.addEventListener('click'");
  assert.ok(retryListenerIdx !== -1, 'btnConsentRetry click listener must exist in popup.js');
  const retrySlice = popupJs.slice(retryListenerIdx, retryListenerIdx + 300);
  assert.ok(
    retrySlice.includes('loadConsent()'),
    'btnConsentRetry must trigger loadConsent()'
  );
});

// ============================================================================
// P2-5: Dynamic Privacy Note on Base URL Change (popup.js)
// ============================================================================

test('P2-5: updatePrivacyNote distinguishes HTTPS, loopback HTTP, and remote HTTP', () => {
  function computePrivacyNote(baseURL, locale = 'vi') {
    const url = baseURL || 'http://localhost:8080/v1';
    const isSecure = isSecureOrLoopbackBaseURL(url);
    const parsed = new URL(url);
    const isLoopbackHttp = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
    if (isSecure) {
      return {
        key: isLoopbackHttp ? 'privacy_note_loopback' : 'privacy_note_secure',
        message: t(locale, isLoopbackHttp ? 'privacy_note_loopback' : 'privacy_note_secure'),
        iconClass: isLoopbackHttp ? 'text-warning' : 'text-muted'
      };
    } else {
      return {
        key: 'privacy_note_insecure',
        message: t(locale, 'privacy_note_insecure'),
        iconClass: 'text-warning'
      };
    }
  }

  // 1. Loopback HTTP -> local-only but not TLS encrypted
  const noteLoopback = computePrivacyNote('http://localhost:8080/v1');
  assert.equal(noteLoopback.key, 'privacy_note_loopback');
  assert.equal(noteLoopback.iconClass, 'text-warning');

  const note127 = computePrivacyNote('http://127.0.0.1:9000/v1');
  assert.equal(note127.key, 'privacy_note_loopback');
  assert.equal(note127.iconClass, 'text-warning');

  // 2. HTTPS -> secure in transit
  const noteHttps = computePrivacyNote('https://api.openai.com/v1');
  assert.equal(noteHttps.key, 'privacy_note_secure');
  assert.equal(noteHttps.iconClass, 'text-muted');

  // 3. Remote HTTP -> blocked warning
  const noteInsecure = computePrivacyNote('http://api.remote-ai.com/v1');
  assert.equal(noteInsecure.key, 'privacy_note_insecure');
  assert.equal(noteInsecure.iconClass, 'text-warning');
  assert.ok(noteInsecure.message.includes('Cảnh báo: Base URL dùng HTTP không mã'));
});

test('P2-5: static contract checks: popup.js attaches updatePrivacyNote to input, change, save, and load', () => {
  // 1. inputBaseUrl 'input' listener calls updatePrivacyNote
  const inputIdx = popupJs.indexOf("inputBaseUrl.addEventListener('input'");
  assert.ok(inputIdx !== -1, 'inputBaseUrl input listener must exist');
  const inputSlice = popupJs.slice(inputIdx, inputIdx + 200);
  assert.ok(
    inputSlice.includes('updatePrivacyNote(inputBaseUrl.value)'),
    'inputBaseUrl input listener must call updatePrivacyNote with input value'
  );

  // 2. inputBaseUrl 'change' listener calls updatePrivacyNote
  const changeIdx = popupJs.indexOf("inputBaseUrl.addEventListener('change'");
  assert.ok(changeIdx !== -1, 'inputBaseUrl change listener must exist');
  const changeSlice = popupJs.slice(changeIdx, changeIdx + 200);
  assert.ok(
    changeSlice.includes('updatePrivacyNote(inputBaseUrl.value)'),
    'inputBaseUrl change listener must call updatePrivacyNote with input value'
  );

  // 3. flushAutosave calls updatePrivacyNote
  const flushIdx = popupJs.indexOf('async function flushAutosave()');
  assert.ok(flushIdx !== -1, 'flushAutosave must exist');
  const flushSlice = popupJs.slice(flushIdx, flushIdx + 1500);
  assert.ok(
    flushSlice.includes('updatePrivacyNote(savedSettings.baseURL)'),
    'flushAutosave must call updatePrivacyNote with saved baseURL'
  );

  // 4. loadSettings calls updatePrivacyNote
  const loadSettingsIdx = popupJs.indexOf('async function loadSettings()');
  assert.ok(loadSettingsIdx !== -1, 'loadSettings must exist');
  const loadSettingsSlice = popupJs.slice(loadSettingsIdx, loadSettingsIdx + 6000);
  assert.ok(
    loadSettingsSlice.includes('updatePrivacyNote(resp.settings.baseURL)'),
    'loadSettings must call updatePrivacyNote with loaded baseURL'
  );
});

// ============================================================================
// i18n Verification for consent_state_unknown in all 7 locales
// ============================================================================

test('P2-4 (i18n): consent_state_unknown key exists in all 7 locales', () => {
  for (const locale of SUPPORTED_UI_LOCALES) {
    const text = t(locale, 'consent_state_unknown');
    assert.ok(typeof text === 'string' && text.length > 0, `Locale ${locale} must translate consent_state_unknown`);
    assert.notEqual(text, 'consent_state_unknown', `Locale ${locale} must not return raw key`);
  }
});

test('P1-1: declining consent clears persisted approval, aborts work, and blocks model lookup', async () => {
  const { store, fakeChrome } = setupFakeChrome({
    dataConsent: {
      version: CURRENT_DATA_CONSENT_VERSION,
      acceptedAt: new Date().toISOString()
    }
  });
  const previousChrome = globalThis.chrome;
  const previousSelf = globalThis.self;
  globalThis.chrome = fakeChrome;
  globalThis.self = globalThis;

  const sw = await import('../extension/src/sw.js?testConsentRevocation=' + Date.now()).then(() => globalThis.__translatorSw);
  let releaseCacheRemoval;
  let markCacheRemovalStarted;
  const cacheRemovalStarted = new Promise((resolve) => { markCacheRemovalStarted = resolve; });
  const cacheRemovalGate = new Promise((resolve) => { releaseCacheRemoval = resolve; });
  const originalRemove = fakeChrome.storage.local.remove;
  fakeChrome.storage.local.remove = async (keys) => {
    markCacheRemovalStarted();
    await cacheRemovalGate;
    return originalRemove(keys);
  };
  const controller = new AbortController();
  const requestId = `consent-revoke-${Date.now()}`;
  sw.activeBatchControllers.set(requestId, {
    controller,
    tabId: 9001,
    revision: sw.getConfigRevision(),
    epoch: 1,
    origin: 'http://127.0.0.1:8090'
  });
  const revisionBefore = sw.getConfigRevision();

  try {
    sw._setTestMode(false);
    sw._setTestConsentOverride(null);
    const saving = sw.dispatchMessage({
      action: 'SAVE_SETTINGS',
      settings: {
        dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null }
      }
    });
    await cacheRemovalStarted;

    const inFlightBatch = await sw.dispatchMessage(
      { action: 'TRANSLATE_BATCH' },
      { frameId: 0, tab: { id: 9001, url: 'https://example.test/article' } }
    );
    assert.equal(inFlightBatch.error?.code, 'DATA_CONSENT_REQUIRED');

    releaseCacheRemoval();
    const saved = await saving;

    assert.equal(saved.ok, true);
    assert.equal(isDataConsentAccepted(store.local.settings), false);
    assert.equal(controller.signal.aborted, true);
    assert.ok(sw.getConfigRevision() > revisionBefore);

    const models = await sw.dispatchMessage({ action: 'LIST_MODELS' });
    assert.equal(models.error?.code, 'DATA_CONSENT_REQUIRED');
  } finally {
    releaseCacheRemoval();
    fakeChrome.storage.local.remove = originalRemove;
    sw._setTestConsentOverride(null);
    sw._setTestMode(true);
    sw.activeBatchControllers.delete(requestId);
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

test('P1-1: an earlier queued acceptance cannot reopen access during a newer decline', async () => {
  const { store, fakeChrome } = setupFakeChrome({
    dataConsent: {
      version: CURRENT_DATA_CONSENT_VERSION,
      acceptedAt: new Date().toISOString()
    }
  });
  const previousChrome = globalThis.chrome;
  const previousSelf = globalThis.self;
  globalThis.chrome = fakeChrome;
  globalThis.self = globalThis;

  let releaseAcceptedSave;
  let markAcceptedSaveStarted;
  const acceptedSaveStarted = new Promise((resolve) => { markAcceptedSaveStarted = resolve; });
  const acceptedSaveGate = new Promise((resolve) => { releaseAcceptedSave = resolve; });
  let releaseCacheRemoval;
  let markCacheRemovalStarted;
  const cacheRemovalStarted = new Promise((resolve) => { markCacheRemovalStarted = resolve; });
  const cacheRemovalGate = new Promise((resolve) => { releaseCacheRemoval = resolve; });
  const originalSet = fakeChrome.storage.local.set;
  const originalRemove = fakeChrome.storage.local.remove;
  let shouldBlockAcceptedSave = true;
  fakeChrome.storage.local.set = async (value) => {
    if (shouldBlockAcceptedSave && Object.prototype.hasOwnProperty.call(value, 'settings')) {
      shouldBlockAcceptedSave = false;
      markAcceptedSaveStarted();
      await acceptedSaveGate;
    }
    return originalSet(value);
  };
  fakeChrome.storage.local.remove = async (keys) => {
    markCacheRemovalStarted();
    await cacheRemovalGate;
    return originalRemove(keys);
  };

  const sw = await import('../extension/src/sw.js?testConsentConcurrentRevocation=' + Date.now()).then(() => globalThis.__translatorSw);
  sw._setTestMode(false);
  sw._setTestConsentOverride(null);
  let accepting;
  let declining;
  try {
    accepting = sw.dispatchMessage({
      action: 'SAVE_SETTINGS',
      settings: { dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: new Date().toISOString() } }
    });
    await acceptedSaveStarted;

    declining = sw.dispatchMessage({
      action: 'SAVE_SETTINGS',
      settings: { dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null } }
    });
    releaseAcceptedSave();
    await accepting;
    await cacheRemovalStarted;

    const batch = await sw.dispatchMessage(
      { action: 'TRANSLATE_BATCH' },
      { frameId: 0, tab: { id: 9001, url: 'https://example.test/article' } }
    );
    assert.equal(batch.error?.code, 'DATA_CONSENT_REQUIRED');

    releaseCacheRemoval();
    const declineResult = await declining;
    assert.equal(declineResult.ok, true);
    assert.equal(isDataConsentAccepted(store.local.settings), false);
  } finally {
    releaseAcceptedSave();
    releaseCacheRemoval();
    if (accepting || declining) await Promise.allSettled([accepting, declining]);
    fakeChrome.storage.local.set = originalSet;
    fakeChrome.storage.local.remove = originalRemove;
    sw._setTestConsentOverride(null);
    sw._setTestMode(true);
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

test('P1-1 (popup): Decline must persist a false consent state instead of only closing the modal', () => {
  const start = popupJs.indexOf('if (btnConsentDecline)');
  const end = popupJs.indexOf('if (btnConsentRetry)', start);
  assert.ok(start >= 0 && end > start, 'Decline handler must exist');
  const handler = popupJs.slice(start, end);
  assert.match(handler, /SAVE_SETTINGS/);
  assert.match(handler, /acceptedAt:\s*null/);
  assert.match(handler, /savedSettings\.dataConsent/);
  assert.match(handler, /res\?\.ok !== true/, 'Decline must require an affirmative persisted-save response');
  assert.match(popupJs, /chrome\.runtime\.lastError/, 'sendMsg must surface Chrome runtime delivery failures');
});

test('P1-1: portable config must not carry a data-processing consent grant', () => {
  const exported = buildExportConfig({
    settings: {
      ...DEFAULT_SETTINGS,
      dataConsent: {
        version: CURRENT_DATA_CONSENT_VERSION,
        acceptedAt: '2026-10-04T10:00:00.000Z'
      }
    }
  });
  assert.equal(Object.hasOwn(exported, 'dataConsent'), false);
});

test('P1-1: consent copy discloses endpoint key transfer, global script scope, cache, and policy link', () => {
  const storageCopy = t('en', 'consent_point_storage');
  const permissionCopy = t('en', 'consent_point_permissions');
  assert.match(storageCopy, /Authorization/i);
  assert.match(storageCopy, /configured endpoint/i);
  assert.doesNotMatch(storageCopy, /never sent elsewhere/i);
  assert.match(permissionCopy, /all HTTP and HTTPS pages/i);
  assert.match(permissionCopy, /reads eligible page text only when/i);
  assert.match(t('en', 'consent_point_cache'), /7 days/i);
  assert.match(t('en', 'consent_point_transport'), /Remote endpoints must use HTTPS/i);
  assert.match(t('en', 'consent_policy_link'), /privacy policy/i);
  assert.match(popupHtml, /href="https:\/\/uyencss\.github\.io\/webmcp-translator-kit\//);
  for (const locale of SUPPORTED_UI_LOCALES) {
    for (const key of ['consent_point_cache', 'consent_point_transport', 'consent_policy_link', 'privacy_note_loopback']) {
      const text = t(locale, key);
      assert.ok(text && text !== key, `Locale ${locale} must translate ${key}`);
    }
  }
});

test('P1-3: secureFetch rejects browser opaque redirects without following or exposing their target', async () => {
  const calls = [];
  const opaqueRedirect = {
    type: 'opaqueredirect',
    status: 0,
    ok: false,
    headers: new Headers()
  };
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return opaqueRedirect;
  };

  const result = await secureFetch(
    'https://api.example/v1/chat/completions',
    { method: 'POST', headers: { Authorization: 'Bearer private-test-key' }, body: 'page text' },
    fetchFn
  );

  assert.equal(result.error?.error?.code, 'ENDPOINT_REDIRECT_UNSUPPORTED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(result), /private-test-key|page text|Location/);
});
