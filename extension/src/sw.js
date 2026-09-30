// WebMCP Translator Kit — Background Service Worker (Direct Mode)
// Contract Version: webmcp-translator-contract/1

import { createDirect9Router } from './adapter/direct9router.mjs';
import {
  getEffectivePolicy,
  normalizeOrigin,
  isValidOrigin,
  ConsentError
} from './consent.mjs';

const TRANSLATE_TIMEOUT_MS = 60000;
const LIST_MODELS_TIMEOUT_MS = 15000;
const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';

let storageAccessInitialized = false;
let storageAccessFailed = false;
let currentAccessLevel = 'TRUSTED_AND_UNTRUSTED_CONTEXTS';

// Expose reset hook strictly for tests (never bypasses security)
function _resetStorageAccessStateForTest() {
  storageAccessInitialized = false;
  storageAccessFailed = false;
}

// Helper to create typed errors strictly conforming to schemas/error.schema.json
function createTypedError(code, message, retryable, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.retryable = Boolean(retryable);
  err.details = details;
  return {
    error: {
      code,
      message,
      retryable: Boolean(retryable),
      details
    }
  };
}

// 4.1 Storage Access Level: TRUSTED_CONTEXTS fail-closed gate
async function ensureStorageAccess() {
  if (storageAccessInitialized && !storageAccessFailed) return;
  try {
    if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function') {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
    currentAccessLevel = 'TRUSTED_CONTEXTS';
    storageAccessInitialized = true;
    storageAccessFailed = false;
  } catch (err) {
    currentAccessLevel = 'UNAVAILABLE';
    storageAccessInitialized = false;
    storageAccessFailed = true;
    throw createTypedError(
      'KEY_ACCESS_UNAVAILABLE',
      'Could not establish TRUSTED_CONTEXTS access level on storage',
      false,
      { reason: err && err.message ? String(err.message) : 'setAccessLevel failed' }
    );
  }
}

// Provide getAccessLevel on chrome.storage.local if not native
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.getAccessLevel !== 'function') {
  chrome.storage.local.getAccessLevel = async () => currentAccessLevel;
}

// Storage helpers
async function getStoredSettings() {
  await ensureStorageAccess();
  const res = await chrome.storage.local.get(['settings']);
  return res.settings || {
    baseURL: 'http://localhost:8080/v1',
    model: DEFAULT_MODEL,
    sourceLanguage: 'auto',
    targetLanguage: 'vi'
  };
}

async function getStoredApiKey() {
  await ensureStorageAccess();
  const res = await chrome.storage.local.get(['api_key']);
  return res.api_key || '';
}

async function getStoredSites() {
  await ensureStorageAccess();
  const res = await chrome.storage.local.get(['sites']);
  return res.sites || {};
}

async function getStoredTabOverrides() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    throw createTypedError('CONSENT_STATE_UNAVAILABLE', 'chrome.storage.session unavailable', false);
  }
  const res = await chrome.storage.session.get(['tab_overrides']);
  return res.tab_overrides || {};
}

// Clean tab overrides when tab closes
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      const res = await chrome.storage.session.get(['tab_overrides']);
      const overrides = res.tab_overrides || {};
      const key = String(tabId);
      if (key in overrides) {
        delete overrides[key];
        await chrome.storage.session.set({ tab_overrides: overrides });
      }
    } catch {
      // Ignore cleanup error
    }
  });
}

// Sender verification helper
function isPrivilegedSender(sender) {
  if (!sender) return false;
  // Content scripts always have sender.tab
  if (sender.tab) return false;
  // Chrome extension page has sender.url starting with chrome-extension://
  if (typeof sender.url === 'string' && sender.url.startsWith('chrome-extension://')) {
    return true;
  }
  // Internal extension background / test dispatch
  if (sender.id && typeof chrome !== 'undefined' && chrome.runtime && sender.id === chrome.runtime.id && !sender.tab) {
    return true;
  }
  return false;
}

// Adapter router instance configuration
const routerConfig = {
  baseURL: '',
  apiKey: '',
  model: DEFAULT_MODEL,
  timeoutMs: TRANSLATE_TIMEOUT_MS,
  listModelsTimeoutMs: LIST_MODELS_TIMEOUT_MS
};

const router = createDirect9Router(routerConfig);

// Model Discovery (delegated to adapter)
async function listModels() {
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = await getStoredApiKey();
  routerConfig.baseURL = settings.baseURL;
  routerConfig.apiKey = apiKey;
  routerConfig.model = settings.model || DEFAULT_MODEL;
  return await router.listModels();
}

// Batch Translation (delegated to adapter)
async function translateBatch(input = {}) {
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = await getStoredApiKey();
  routerConfig.baseURL = settings.baseURL;
  routerConfig.apiKey = apiKey;
  routerConfig.model = settings.model || DEFAULT_MODEL;
  return await router.translateBatch(input);
}

// Startup hooks
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled?.addListener(() => {
    ensureStorageAccess().catch(() => {});
  });

  chrome.runtime.onStartup?.addListener(() => {
    ensureStorageAccess().catch(() => {});
  });
}

// Runtime Message Handler
async function handleRuntimeMessage(message, sender = { frameId: 0 }) {
  try {
    switch (message.action) {
      case 'PING':
        return { ok: true, version: '0.1.0' };

      case 'GET_SETTINGS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'GET_SETTINGS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const settings = await getStoredSettings();
        const hasKey = Boolean(await getStoredApiKey());
        return { settings, hasKey };
      }

      case 'SAVE_SETTINGS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SAVE_SETTINGS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await ensureStorageAccess();
        if (message.settings) {
          await chrome.storage.local.set({ settings: message.settings });
          if (message.settings.baseURL) routerConfig.baseURL = message.settings.baseURL;
          if (message.settings.model) routerConfig.model = message.settings.model;
        }
        return { ok: true };
      }

      case 'SET_KEY': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SET_KEY is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await ensureStorageAccess();
        if (typeof message.key === 'string') {
          await chrome.storage.local.set({ api_key: message.key });
          routerConfig.apiKey = message.key;
        }
        return { ok: true };
      }

      case 'DELETE_KEY': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'DELETE_KEY is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await ensureStorageAccess();
        await chrome.storage.local.remove(['api_key']);
        routerConfig.apiKey = '';
        return { ok: true };
      }

      case 'HAS_KEY': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'HAS_KEY is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const key = await getStoredApiKey();
        return { hasKey: Boolean(key) };
      }

      case 'LIST_MODELS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'LIST_MODELS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        return await listModels();
      }

      case 'GET_CONSENT': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'GET_CONSENT is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const tabId = message.tabId;
        if (typeof tabId !== 'number') {
          return createTypedError('PERMISSION_REQUIRED', 'Valid tabId required for GET_CONSENT', false, {
            permissionType: 'host'
          });
        }

        let tab = null;
        try {
          if (chrome.tabs && typeof chrome.tabs.get === 'function') {
            tab = await chrome.tabs.get(tabId);
          }
        } catch {
          tab = null;
        }

        const siteOrigin = tab?.url ? normalizeOrigin(tab.url) : null;
        if (!siteOrigin) {
          return { siteOrigin: null, siteEnabled: false, tabOverride: null, effective: 'off' };
        }

        let sites = {};
        let tabOverrides = {};
        try {
          sites = await getStoredSites();
          tabOverrides = await getStoredTabOverrides();
        } catch (err) {
          return createTypedError('CONSENT_STATE_UNAVAILABLE', 'Consent state unavailable', false, {
            tabId,
            reason: err && err.message ? String(err.message) : 'Storage read error'
          });
        }

        const siteEnabled = Boolean(sites[siteOrigin]);
        const tabOverride = tabOverrides[String(tabId)] || null;
        const effective = getEffectivePolicy({ tabOverride, siteEnabled });

        return { siteOrigin, siteEnabled, tabOverride, effective };
      }

      case 'SET_SITE_ENABLED': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SET_SITE_ENABLED is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const normOrigin = normalizeOrigin(message.origin);
        if (!normOrigin) {
          return createTypedError('SITE_NOT_ALLOWED', 'Invalid HTTP(S) origin provided', false, {
            origin: String(message.origin || '')
          });
        }
        await ensureStorageAccess();
        const res = await chrome.storage.local.get(['sites']);
        const sites = res.sites || {};
        if (message.enabled) {
          sites[normOrigin] = { createdAt: Date.now() };
        } else {
          delete sites[normOrigin];
        }
        await chrome.storage.local.set({ sites });
        return { ok: true };
      }

      case 'SET_TAB_OVERRIDE': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SET_TAB_OVERRIDE is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const tabId = message.tabId;
        if (typeof tabId !== 'number') {
          return createTypedError('PERMISSION_REQUIRED', 'Valid tabId required for SET_TAB_OVERRIDE', false, {
            permissionType: 'host'
          });
        }
        const val = message.value;
        if (val !== 'on' && val !== 'off' && val !== null && val !== undefined) {
          return createTypedError('CONSENT_STATE_UNAVAILABLE', `Invalid tab override value: ${String(val)}`, false, {
            tabId
          });
        }
        if (!chrome.storage || !chrome.storage.session) {
          return createTypedError('CONSENT_STATE_UNAVAILABLE', 'chrome.storage.session unavailable', false, { tabId });
        }
        const res = await chrome.storage.session.get(['tab_overrides']);
        const tabOverrides = res.tab_overrides || {};
        const key = String(tabId);
        if (val === 'on' || val === 'off') {
          tabOverrides[key] = val;
        } else {
          delete tabOverrides[key];
        }
        await chrome.storage.session.set({ tab_overrides: tabOverrides });
        return { ok: true };
      }

      case 'TRANSLATE_BATCH': {
        // 1. Fail-closed storage access verification
        await ensureStorageAccess();

        // 2. Sender metadata enforcement: only top frame of tab sender
        if (!sender || typeof sender.frameId !== 'number' || sender.frameId !== 0) {
          return createTypedError('PERMISSION_REQUIRED', 'Only top frame translation is permitted', false, {
            permissionType: 'host'
          });
        }

        if (!sender.tab || typeof sender.tab.id !== 'number') {
          return createTypedError('PERMISSION_REQUIRED', 'Translation requires a valid tab sender', false, {
            permissionType: 'host'
          });
        }

        const senderRawUrl = sender.url || (sender.tab && sender.tab.url) || sender.origin;
        const origin = normalizeOrigin(senderRawUrl);
        if (!origin) {
          return createTypedError('SITE_NOT_ALLOWED', 'Current site origin is not opted in or protocol is not HTTP(S)', false, {
            origin: senderRawUrl || ''
          });
        }

        // 3. Consent check: tab override > site enabled > default OFF
        let sites, tabOverrides;
        try {
          sites = await getStoredSites();
          tabOverrides = await getStoredTabOverrides();
        } catch (err) {
          return createTypedError('CONSENT_STATE_UNAVAILABLE', 'Consent state unavailable', false, {
            tabId: sender.tab.id,
            reason: err && err.message ? String(err.message) : 'Storage read error'
          });
        }

        const siteEnabled = Boolean(sites[origin]);
        const tabOverride = tabOverrides[String(sender.tab.id)] || null;

        let effective;
        try {
          effective = getEffectivePolicy({ tabOverride, siteEnabled });
        } catch (err) {
          return createTypedError('CONSENT_STATE_UNAVAILABLE', 'Consent state unavailable', false, {
            tabId: sender.tab.id,
            reason: err && err.message ? String(err.message) : 'Policy evaluation error'
          });
        }

        if (effective !== 'on') {
          return createTypedError('OPT_IN_REQUIRED', 'Translation is disabled (tab explicit OFF, site OFF, or default OFF)', false, {
            tabId: sender.tab.id,
            origin,
            scope: tabOverride ? 'tab' : 'site',
            effectiveConsent: 'off'
          });
        }

        // 4. Dispatch batch (payload items only; metadata completely ignored)
        return await translateBatch(message.payload || {});
      }

      default:
        return { error: { code: 'UNKNOWN_ACTION', message: `Unknown action ${message.action}` } };
    }
  } catch (err) {
    if (err && err.error) return err;
    return createTypedError(
      'KEY_ACCESS_UNAVAILABLE',
      err && err.message ? String(err.message) : 'Internal error',
      false,
      { reason: err && err.message ? String(err.message) : 'Unknown error' }
    );
  }
}

// Runtime Message Dispatcher
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    handleRuntimeMessage(message, sender)
      .then(sendResponse)
      .catch((e) => {
        if (e && e.error) {
          sendResponse(e);
        } else {
          sendResponse(createTypedError('KEY_ACCESS_UNAVAILABLE', e && e.message ? String(e.message) : 'Internal error', false));
        }
      });

    return true; // Keep channel open for async response
  });
}

// Expose dispatcher for CDP inspection & smoke tests
const defaultTestExtensionUrl = (typeof chrome !== 'undefined' && chrome.runtime?.id)
  ? `chrome-extension://${chrome.runtime.id}/popup.html`
  : 'chrome-extension://feicbphhimmhddfdlahlfmhkhodkdffl/popup.html';

self.__translatorSw = {
  dispatchMessage: (message, sender = { url: defaultTestExtensionUrl }) => handleRuntimeMessage(message, sender),
  _resetStorageAccessStateForTest,
  translateBatch,
  listModels,
  ensureStorageAccess,
  getStoredSettings,
  getStoredApiKey,
  getStoredSites,
  getStoredTabOverrides,
  DEFAULT_MODEL,
  TRANSLATE_TIMEOUT_MS,
  LIST_MODELS_TIMEOUT_MS
};
