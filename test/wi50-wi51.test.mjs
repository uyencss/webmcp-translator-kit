// WebMCP Translator Kit — WI-50 & WI-51 Acceptance Test Suite
// WI-50: Auto-start mismatch warning banner (site_off, tabOverride off, hidden when on/not listed)
// WI-51: Store compliance (versioned data consent, HTTPS enforcement, dynamic privacy note)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopbackHost,
  isSecureOrLoopbackBaseURL
} from '../extension/src/consent.mjs';
import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  CURRENT_DATA_CONSENT_VERSION,
  isDataConsentAccepted,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';
import {
  createDirect9Router
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
import { createFakeProvider } from './helpers/fake-provider.mjs';

// ============================================================================
// WI-51: Loopback Host & Secure Base URL Pure Helpers
// ============================================================================

test('WI-51: isLoopbackHost correctly identifies loopback addresses', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('127.255.255.254'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[0:0:0:0:0:0:0:1]'), true);
  assert.equal(isLoopbackHost('0:0:0:0:0:0:0:1'), true);

  // Non-loopback
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost('api.openai.com'), false);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isLoopbackHost('172.16.0.1'), false);
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost(null), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test('WI-51: isSecureOrLoopbackBaseURL enforces HTTPS for remote and allows loopback HTTP', () => {
  // Secure HTTPS
  assert.equal(isSecureOrLoopbackBaseURL('https://api.openai.com/v1'), true);
  assert.equal(isSecureOrLoopbackBaseURL('https://my-router.domain.com:8443/v1'), true);
  assert.equal(isSecureOrLoopbackBaseURL('https://localhost:8080/v1'), true);

  // Loopback HTTP
  assert.equal(isSecureOrLoopbackBaseURL('http://localhost:8080/v1'), true);
  assert.equal(isSecureOrLoopbackBaseURL('http://127.0.0.1:8080/v1'), true);
  assert.equal(isSecureOrLoopbackBaseURL('http://127.0.1.5:9000/v1'), true);
  assert.equal(isSecureOrLoopbackBaseURL('http://[::1]:8080/v1'), true);

  // Remote HTTP (BLOCKED)
  assert.equal(isSecureOrLoopbackBaseURL('http://api.openai.com/v1'), false);
  assert.equal(isSecureOrLoopbackBaseURL('http://example.com/v1'), false);
  assert.equal(isSecureOrLoopbackBaseURL('http://192.168.1.100:8080/v1'), false);
  assert.equal(isSecureOrLoopbackBaseURL('http://10.0.0.2:8080/v1'), false);

  // Invalid protocol or format
  assert.equal(isSecureOrLoopbackBaseURL('ftp://localhost:8080/v1'), false);
  assert.equal(isSecureOrLoopbackBaseURL('javascript:alert(1)'), false);
  assert.equal(isSecureOrLoopbackBaseURL('not-a-url'), false);
  assert.equal(isSecureOrLoopbackBaseURL(''), false);
  assert.equal(isSecureOrLoopbackBaseURL(null), false);
});

// ============================================================================
// WI-51: Settings Validation & Migration for Data Consent and HTTPS
// ============================================================================

test('WI-51: DEFAULT_SETTINGS contains versioned dataConsent default null', () => {
  assert.ok(DEFAULT_SETTINGS.dataConsent, 'DEFAULT_SETTINGS must have dataConsent');
  assert.equal(DEFAULT_SETTINGS.dataConsent.version, CURRENT_DATA_CONSENT_VERSION);
  assert.equal(DEFAULT_SETTINGS.dataConsent.acceptedAt, null);
  assert.equal(isDataConsentAccepted(DEFAULT_SETTINGS), false);
});

test('WI-51: isDataConsentAccepted validates version and ISO string', () => {
  assert.equal(isDataConsentAccepted(null), false);
  assert.equal(isDataConsentAccepted({}), false);
  assert.equal(isDataConsentAccepted({ dataConsent: null }), false);
  assert.equal(isDataConsentAccepted({ dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null } }), false);
  assert.equal(isDataConsentAccepted({ dataConsent: { version: 0, acceptedAt: '2026-10-04T10:00:00.000Z' } }), false);
  assert.equal(isDataConsentAccepted({ dataConsent: { version: CURRENT_DATA_CONSENT_VERSION + 1, acceptedAt: '2026-10-04T10:00:00.000Z' } }), false);
  assert.equal(isDataConsentAccepted({ dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: '' } }), false);
  assert.equal(isDataConsentAccepted({ dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: 'not-a-date' } }), false);

  // Current disclosure version
  assert.equal(isDataConsentAccepted({ dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: '2026-10-04T10:00:00.000Z' } }), true);
});

test('WI-51: migrateSettings normalizes dataConsent', () => {
  // Legacy settings without dataConsent
  const migratedNoConsent = migrateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'm1'
  });
  assert.deepEqual(migratedNoConsent.dataConsent, {
    version: CURRENT_DATA_CONSENT_VERSION,
    acceptedAt: null
  });

  // Settings with accepted dataConsent
  const ts = new Date().toISOString();
  const migratedAccepted = migrateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'm1',
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: ts }
  });
  assert.deepEqual(migratedAccepted.dataConsent, {
    version: CURRENT_DATA_CONSENT_VERSION,
    acceptedAt: ts
  });

  // Settings with outdated version resets acceptedAt
  const migratedOld = migrateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'm1',
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION - 1, acceptedAt: ts }
  });
  assert.deepEqual(migratedOld.dataConsent, {
    version: CURRENT_DATA_CONSENT_VERSION,
    acceptedAt: null
  });

  const malformed = migrateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'm1',
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: 'not-a-date' }
  });
  assert.deepEqual(malformed.dataConsent, {
    version: CURRENT_DATA_CONSENT_VERSION,
    acceptedAt: null
  });
});

test('WI-51: validateSettings enforces HTTPS/loopback for baseURL and fallbacks', () => {
  // Valid settings: loopback HTTP and HTTPS
  const validLoopback = {
    baseURL: 'http://localhost:8080/v1',
    model: 'test-model',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null }
  };
  assert.equal(validateSettings(validLoopback).valid, true);

  const validHttps = {
    baseURL: 'https://api.openai.com/v1',
    model: 'test-model',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbacks: [
      { id: 'fb1', model: 'm2', baseURL: 'https://api.anthropic.com/v1' }
    ]
  };
  assert.equal(validateSettings(validHttps).valid, true);

  // Invalid: Remote HTTP Base URL
  const invalidRemoteHttp = {
    baseURL: 'http://api.remote-ai.com/v1',
    model: 'test-model',
    sourceLanguage: 'auto',
    targetLanguage: 'vi'
  };
  const resRemote = validateSettings(invalidRemoteHttp);
  assert.equal(resRemote.valid, false);
  assert.ok(resRemote.errors.some(e => e.includes('HTTPS or loopback HTTP')));

  // Invalid: Remote HTTP Fallback Base URL
  const invalidFallbackHttp = {
    baseURL: 'https://api.openai.com/v1',
    model: 'test-model',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbacks: [
      { id: 'fb1', model: 'm2', baseURL: 'http://insecure-fallback.com/v1' }
    ]
  };
  const resFallback = validateSettings(invalidFallbackHttp);
  assert.equal(resFallback.valid, false);
  assert.ok(resFallback.errors.some(e => e.includes('fallbacks[0].baseURL must use HTTPS or loopback HTTP')));
});

test('WI-51: validateSettings rejects malformed data consent timestamps', () => {
  const result = validateSettings({
    ...DEFAULT_SETTINGS,
    dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: 'not-a-date' }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('dataConsent.acceptedAt must be a canonical ISO timestamp')));
});

// ============================================================================
// WI-51: Direct 9router Adapter HTTPS Enforcement
// ============================================================================

test('WI-51: direct9router adapter rejects remote HTTP before network fetch', async () => {
  const routerInsecure = createDirect9Router({
    baseURL: 'http://api.insecure-remote.com/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.1-pro-low'
  });

  const res = await routerInsecure.translateBatch({
    items: [{ id: '1', revision: 0, text: 'Hello' }],
    sourceLanguage: 'auto',
    targetLanguage: 'vi'
  });

  assert.ok(res && res.error, 'Must return error for insecure endpoint');
  assert.equal(res.error.code, 'INSECURE_ENDPOINT_BLOCKED');
  assert.ok(res.error.message.includes('HTTPS or loopback HTTP'));
});

test('WI-51: direct9router adapter permits loopback HTTP and HTTPS', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL, // http://127.0.0.1:<port>/v1
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      timeoutMs: 500
    });

    const res = await router.translateBatch({
      items: [{ id: '1', revision: 0, text: 'Hello' }],
      sourceLanguage: 'auto',
      targetLanguage: 'vi'
    });

    assert.ok(res && Array.isArray(res.results), 'Must return results array on success');
    assert.equal(res.results.length, 1);
  } finally {
    await fake.stop();
  }
});

// ============================================================================
// WI-51: Fail-Closed Service Worker Consent Check
// ============================================================================

test('WI-51: checkDataConsentAccepted in production mode requires valid acceptedAt', () => {
  // Test production check with _testMode = false
  _setTestMode(false);
  _setTestConsentOverride(null);

  try {
    // Unaccepted consent
    assert.equal(checkDataConsentAccepted({
      dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null }
    }), false);

    assert.equal(checkDataConsentAccepted({
      dataConsent: { version: CURRENT_DATA_CONSENT_VERSION - 1, acceptedAt: '2026-10-04T12:00:00.000Z' }
    }), false);

    // Accepted consent
    assert.equal(checkDataConsentAccepted({
      dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: '2026-10-04T12:00:00.000Z' }
    }), true);
  } finally {
    _setTestMode(true);
  }
});

test('WI-51: TRANSLATE_BATCH fail-closes with DATA_CONSENT_REQUIRED when consent is false', async () => {
  const store = {
    local: {
      settings: {
        version: SETTINGS_VERSION,
        baseURL: 'http://127.0.0.1:8080/v1',
        model: 'ag/gemini-3.1-pro-low',
        fallbacks: [],
        favoriteModels: [],
        autoTranslateSites: [],
        dataConsent: { version: CURRENT_DATA_CONSENT_VERSION, acceptedAt: null }
      },
      sites: { 'http://127.0.0.1:8090': { createdAt: Date.now() } },
      api_key: 'test-key'
    },
    session: {}
  };

  const fakeChrome = {
    storage: {
      local: {
        get: async (k) => Array.isArray(k) ? Object.fromEntries(k.map(x => [x, store.local[x]])) : { ...store.local },
        set: async (v) => Object.assign(store.local, v),
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
      get: async () => ({ id: 8001, url: 'http://127.0.0.1:8090/test.html' })
    },
    runtime: { id: 'test-id', lastError: null },
    permissions: { contains: async () => true, request: async () => true }
  };

  globalThis.chrome = fakeChrome;
  globalThis.self = globalThis;
  const sw = await import('../extension/src/sw.js?testConsent=' + Date.now()).then(m => globalThis.__translatorSw);

  try {
    sw._setTestMode(true);
    sw._setTestConsentOverride(false); // Simulate unaccepted consent
    sw._setTestPermission('http://127.0.0.1:8090', true);
    sw._registerTestTab(8001, 'http://127.0.0.1:8090/test.html');

    const sender = { frameId: 0, tab: { id: 8001, url: 'http://127.0.0.1:8090/test.html' }, url: 'http://127.0.0.1:8090/test.html' };
    const resp = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [{ id: '1', revision: 0, text: 'Hello' }],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(resp && resp.error, 'Must return error when consent is false');
    assert.equal(resp.error.code, 'DATA_CONSENT_REQUIRED');
    assert.equal(resp.error.retryable, false);

    // Now test when consent is true
    sw._setTestConsentOverride(true);
    sw._setTranslateBatchForTest(async (payload) => ({
      results: [{ id: '1', revision: 0, text: 'Xin chào' }],
      model: payload.model,
      requestedModel: payload.model
    }));

    const respAccepted = await sw.dispatchMessage({
      action: 'TRANSLATE_BATCH',
      payload: {
        items: [{ id: '1', revision: 0, text: 'Hello' }],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: 'ag/gemini-3.1-pro-low'
      }
    }, sender);

    assert.ok(!respAccepted.error, 'Must not return error when consent is true');
    assert.ok(Array.isArray(respAccepted.results), 'Must return results array');
    assert.equal(respAccepted.results[0].text, 'Xin chào');
  } finally {
    sw._setTestConsentOverride(null);
    delete globalThis.chrome;
  }
});

// ============================================================================
// WI-50: Auto-start Mismatch Warning Banner Unit Tests
// ============================================================================

test('WI-50: Warning banner 3 branches logic verification', () => {
  // Pure logic replica matching popup.js updateAutoConsentWarningBanner implementation
  function computeBannerState({ origin, autoTranslateSites, currentConsent }) {
    if (!origin) return { visible: false };

    const matchingSite = autoTranslateSites.find((s) => (s.origin || s) === origin);
    const hasAutoEntry = Boolean(matchingSite && (matchingSite.autoStart !== false));
    const effective = currentConsent?.effective || 'off';

    if (hasAutoEntry && effective === 'off') {
      if (currentConsent?.tabOverride === 'off') {
        return {
          visible: true,
          type: 'tab_override_off',
          textKey: 'banner_auto_tab_override_off',
          showButton: false
        };
      } else {
        return {
          visible: true,
          type: 'site_off',
          textKey: 'banner_auto_site_off',
          showButton: true,
          buttonTextKey: 'btn_enable_site_format',
          buttonParam: { origin }
        };
      }
    }
    return { visible: false };
  }

  const origin = 'https://ixdzs8.com';

  // Branch 1: In auto list (autoStart !== false) + site_off -> banner visible with enable button
  const branch1 = computeBannerState({
    origin,
    autoTranslateSites: [{ origin, autoStart: true }],
    currentConsent: { siteOrigin: origin, siteEnabled: false, tabOverride: null, effective: 'off' }
  });
  assert.equal(branch1.visible, true);
  assert.equal(branch1.type, 'site_off');
  assert.equal(branch1.textKey, 'banner_auto_site_off');
  assert.equal(branch1.showButton, true);
  assert.equal(branch1.buttonTextKey, 'btn_enable_site_format');
  assert.equal(t('vi', branch1.buttonTextKey, branch1.buttonParam), 'Bật dịch cho https://ixdzs8.com');

  // Branch 2: In auto list + tabOverride === 'off' -> banner visible with override text, button hidden
  const branch2 = computeBannerState({
    origin,
    autoTranslateSites: [{ origin, autoStart: true }],
    currentConsent: { siteOrigin: origin, siteEnabled: true, tabOverride: 'off', effective: 'off' }
  });
  assert.equal(branch2.visible, true);
  assert.equal(branch2.type, 'tab_override_off');
  assert.equal(branch2.textKey, 'banner_auto_tab_override_off');
  assert.equal(branch2.showButton, false);

  // Branch 3: Not in auto list -> banner hidden
  const branch3a = computeBannerState({
    origin,
    autoTranslateSites: [],
    currentConsent: { siteOrigin: origin, siteEnabled: false, tabOverride: null, effective: 'off' }
  });
  assert.equal(branch3a.visible, false);

  // Branch 3b: In auto list but autoStart is explicitly false -> banner hidden
  const branch3b = computeBannerState({
    origin,
    autoTranslateSites: [{ origin, autoStart: false }],
    currentConsent: { siteOrigin: origin, siteEnabled: false, tabOverride: null, effective: 'off' }
  });
  assert.equal(branch3b.visible, false);

  // Branch 3c: In auto list and effective is 'on' -> banner hidden
  const branch3c = computeBannerState({
    origin,
    autoTranslateSites: [{ origin, autoStart: true }],
    currentConsent: { siteOrigin: origin, siteEnabled: true, tabOverride: null, effective: 'on' }
  });
  assert.equal(branch3c.visible, false);
});

// ============================================================================
// WI-50 & WI-51: Complete 7-Locale i18n Catalog Coverage for New Keys
// ============================================================================

test('WI-50 & WI-51: All 20 new keys exist and translate in all 7 supported locales', () => {
  const newKeys = [
    'banner_auto_site_off',
    'banner_auto_tab_override_off',
    'btn_enable_site_format',
    'privacy_note_secure',
    'privacy_note_insecure',
    'privacy_note_loopback',
    'consent_modal_title',
    'consent_modal_intro',
    'consent_point_data',
    'consent_point_purpose',
    'consent_point_storage',
    'consent_point_auto',
    'consent_point_permissions',
    'consent_point_cache',
    'consent_point_transport',
    'consent_policy_link',
    'consent_btn_accept',
    'consent_btn_decline',
    'consent_status_declined',
    'err_data_consent_required'
  ];

  for (const locale of SUPPORTED_UI_LOCALES) {
    for (const k of newKeys) {
      const translated = t(locale, k, { origin: 'https://example.com' });
      assert.ok(typeof translated === 'string', `${locale}.${k} must be string`);
      assert.ok(translated.length > 0, `${locale}.${k} must not be empty`);
      assert.notEqual(translated, k, `${locale}.${k} must not fall back to raw key`);
    }
  }
});
