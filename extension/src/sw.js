// WebMCP Translator Kit — Background Service Worker (Direct Mode)
// Contract Version: webmcp-translator-contract/1

import { createDirect9Router } from './adapter/direct9router.mjs';

const TRANSLATE_TIMEOUT_MS = 60000;
const LIST_MODELS_TIMEOUT_MS = 15000;
const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';

let storageAccessInitialized = false;

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

// 4.1 Storage Access Level: TRUSTED_CONTEXTS
async function ensureStorageAccess() {
  if (storageAccessInitialized) return;
  try {
    if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function') {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
    storageAccessInitialized = true;
  } catch (err) {
    storageAccessInitialized = false;
    throw createTypedError(
      'KEY_ACCESS_UNAVAILABLE',
      'Could not establish TRUSTED_CONTEXTS access level on storage',
      false,
      { reason: err && err.message ? String(err.message) : 'setAccessLevel failed' }
    );
  }
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

// Startup hook
chrome.runtime.onInstalled.addListener(() => {
  ensureStorageAccess().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureStorageAccess().catch(() => {});
});

// Runtime Message Handler
async function handleRuntimeMessage(message, sender = { frameId: 0 }) {
  switch (message.action) {
    case 'PING':
      return { ok: true, version: '0.1.0' };

    case 'GET_SETTINGS': {
      const settings = await getStoredSettings();
      const hasKey = Boolean(await getStoredApiKey());
      return { settings, hasKey };
    }

    case 'SAVE_SETTINGS': {
      await ensureStorageAccess();
      if (message.settings) {
        await chrome.storage.local.set({ settings: message.settings });
        if (message.settings.baseURL) routerConfig.baseURL = message.settings.baseURL;
        if (message.settings.model) routerConfig.model = message.settings.model;
      }
      return { ok: true };
    }

    case 'SET_KEY': {
      await ensureStorageAccess();
      if (typeof message.key === 'string') {
        await chrome.storage.local.set({ api_key: message.key });
        routerConfig.apiKey = message.key;
      }
      return { ok: true };
    }

    case 'DELETE_KEY': {
      await ensureStorageAccess();
      await chrome.storage.local.remove(['api_key']);
      routerConfig.apiKey = '';
      return { ok: true };
    }

    case 'HAS_KEY': {
      const key = await getStoredApiKey();
      return { hasKey: Boolean(key) };
    }

    case 'LIST_MODELS': {
      return await listModels();
    }

    case 'TRANSLATE_BATCH': {
      // Verify sender metadata: must be top frame
      if (sender && typeof sender.frameId === 'number' && sender.frameId !== 0) {
        return createTypedError('PERMISSION_REQUIRED', 'Only top frame translation is permitted', false, {
          permissionType: 'host'
        });
      }
      return await translateBatch(message.payload || {});
    }

    default:
      return { error: { code: 'UNKNOWN_ACTION', message: `Unknown action ${message.action}` } };
  }
}

// Runtime Message Dispatcher
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

// Expose dispatcher for CDP inspection & smoke tests
self.__translatorSw = {
  dispatchMessage: (message, sender = { frameId: 0 }) => handleRuntimeMessage(message, sender),
  translateBatch,
  listModels,
  ensureStorageAccess,
  getStoredSettings,
  getStoredApiKey,
  DEFAULT_MODEL,
  TRANSLATE_TIMEOUT_MS,
  LIST_MODELS_TIMEOUT_MS
};
