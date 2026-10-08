// WebMCP Translator Kit — Background Service Worker (Direct Mode)
// Contract Version: webmcp-translator-contract/1

import { createOpenAICompatibleAdapter } from './adapter/openai-compatible.mjs';
import { createStorageManager } from './sw/modules/storage-manager.mjs';
import { createBatchEngine } from './sw/modules/batch-engine.mjs';
import {
  getEffectivePolicy,
  normalizeOrigin,
  isValidOrigin,
  isSecureOrLoopbackBaseURL,
  ConsentError
} from './consent.mjs';
import {
  originToScriptId,
  originToMatchPattern,
  calculateReconcileDiff
} from './permissions.mjs';
import {
  countCodePoints,
  createLimitState,
  prune,
  evaluate,
  record,
  resolveLimits as resolveLimitsRL,
  DEFAULT_RATE_LIMITS
} from './rate-limits.mjs';
import {
  createTranslationCache,
  cacheKey,
  hashText,
  normalizeSourceText,
  PROMPT_VERSION,
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  L2_MAX_SIZE_BYTES,
  pruneL2Cache
} from './cache.mjs';
import {
  createSemaphore
} from './semaphore.mjs';
import {
  SETTINGS_VERSION,
  CURRENT_DATA_CONSENT_VERSION,
  isDataConsentAccepted,
  DEFAULT_SETTINGS,
  migrateSettings,
  validateSettings,
  normalizeBaseURLKey,
  normalizePerSiteConfig,
  clampProviderConcurrency
} from './settings.mjs';

const TRANSLATE_TIMEOUT_MS = 60000;
const LIST_MODELS_TIMEOUT_MS = 15000;
const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';

let configRevision = 1;
// A decline takes effect synchronously, before queued storage/cache cleanup can await.
// Keep the gate closed if persistence fails; only a successful explicit consent write clears it.
let dataConsentRevocationPending = false;
let dataConsentRevocationGeneration = 0;

// Ephemeral In-Memory Cache: destroyed upon SW restart per contract/lifecycle.md §3.3
const translationCache = createTranslationCache({
  ttlMs: 600000,
  maxEntries: 500,
  maxSizeBytes: 2097152
});

import {
  MAX_ERROR_LOG_ENTRIES,
  initErrorLog,
  getErrorLog,
  clearErrorLog,
  recordErrorLog,
  getL2Epoch,
  isL2MemoryOnly,
  _setL2MemoryOnlyForTest,
  isL2Clearing,
  enqueueL2Cache,
  clearL2Cache,
  flushL2Cache,
  clearPendingL2Writes
} from './sw/modules/cache.mjs';

export {
  getL2Epoch,
  isL2MemoryOnly,
  _setL2MemoryOnlyForTest,
  isL2Clearing,
  enqueueL2Cache,
  clearL2Cache,
  flushL2Cache,
  clearPendingL2Writes
};

import {
  reconcileWatchdog
} from './sw/modules/queue.mjs';

import {
  createTypedError,
  isPrivilegedSender,
  verifyWidgetSender
} from './sw/modules/security.mjs';

import {
  resolveAttemptCache,
  checkL2CacheForMisses,
  commitTranslatedCache,
  mergeBatchResults
} from './sw/modules/batch-executor.mjs';

export {
  resolveAttemptCache,
  checkL2CacheForMisses,
  commitTranslatedCache,
  mergeBatchResults
};

export {
  MAX_ERROR_LOG_ENTRIES,
  initErrorLog,
  getErrorLog,
  clearErrorLog,
  recordErrorLog,
  reconcileWatchdog,
  createTypedError,
  isPrivilegedSender,
  verifyWidgetSender
};

import {
  abortActiveWorkOnCredentialChange,
  handleSetKeyAction,
  handleSetFallbackKeyAction,
  handleDeleteFallbackKeyAction,
  handleDeleteKeyAction,
  handleHasKeyAction
} from './sw/modules/keys-manager.mjs';

import {
  computeKeyFingerprint as computeKeyFingerprintModule,
  checkBaseUrlPermission as checkBaseUrlPermissionModule,
  listModelsWithContext
} from './sw/modules/models-discovery.mjs';

export {
  abortActiveWorkOnCredentialChange,
  handleSetKeyAction,
  handleSetFallbackKeyAction,
  handleDeleteFallbackKeyAction,
  handleDeleteKeyAction,
  handleHasKeyAction,
  computeKeyFingerprintModule,
  checkBaseUrlPermissionModule,
  listModelsWithContext
};

import { createTabLifecycleManager } from './sw/modules/tab-lifecycle.mjs';
import { createAdmissionManager } from './sw/modules/admission-queue.mjs';
import {
  resolveEffectiveSiteConfig as resolveEffectiveSiteConfigModule,
  reconcilePermissions as reconcilePermissionsModule,
  handleGetConsentAction,
  handleSetSiteEnabledAction,
  handleEnsureContentAction,
  handleSetTabOverrideAction,
  handleCancelPendingAction
} from './sw/modules/site-policy-controller.mjs';
import {
  pushWidgetStateChanged as pushWidgetStateChangedModule,
  notifyAllWidgetStateChanged as notifyAllWidgetStateChangedModule,
  handleWidgetGetStateAction,
  handleWidgetSetEnabledAction,
  handleWidgetSetModeAction,
  handleWidgetSetPositionAction
} from './sw/modules/widget-controller.mjs';

// Provider concurrency semaphore = 2 (default, updated dynamically from settings)
const providerSemaphore = createSemaphore({
  maxConcurrency: DEFAULT_SETTINGS.providerConcurrency || 2,
  timeoutMs: 120000
});

export function getProviderSemaphore() {
  return providerSemaphore;
}

export function updateProviderConcurrency(concurrency) {
  const valid = clampProviderConcurrency(concurrency);
  if (providerSemaphore && typeof providerSemaphore.setMaxConcurrency === 'function') {
    providerSemaphore.setMaxConcurrency(valid);
  }
  return providerSemaphore.getMaxConcurrency();
}

/**
 * Resolves limits from settings or rateLimits, falling back to defaults.
 */
export function resolveLimits(settingsOrRateLimits) {
  if (!settingsOrRateLimits || typeof settingsOrRateLimits !== 'object') {
    return resolveLimitsRL();
  }
  const rl = (settingsOrRateLimits.rateLimits && typeof settingsOrRateLimits.rateLimits === 'object')
    ? settingsOrRateLimits.rateLimits
    : settingsOrRateLimits;
  return resolveLimitsRL(rl);
}

// Storage state and hooks are initialized via storage-manager below

// TEST-ONLY: bypass ENSURE_CONTENT scripting check (harness tab ids).
let _testEnsureContentOk = false;
function _setTestEnsureContentOk(enabled) {
  if (!_testMode) return;
  _testEnsureContentOk = Boolean(enabled);
}

// ============================================================================
// Fallback Plan Pure Decision Engine (§6 Sol)
// ============================================================================
import {
  STOP_ERROR_CODES,
  FALLBACK_ELIGIBLE_CODES,
  resolveFallbackPlan,
  extractHost,
  resolveFallbackChain,
  fallbacksEqual
} from './sw/modules/queue.mjs';

export {
  STOP_ERROR_CODES,
  FALLBACK_ELIGIBLE_CODES,
  resolveFallbackPlan,
  extractHost,
  resolveFallbackChain,
  fallbacksEqual
};

// ============================================================================
// TEST-ONLY State & Hooks (Dormant and unread in production)
// ============================================================================
let _testMode = false;
// TEST-ONLY: simulated tab ids -> url (harness registers fixture/tab40 ids).
const testTabRegistry = new Map();
const _testPermissionOverrides = new Map();
let _testRateLimits = null;
let _testRateWindowSeconds = null;
let _testMaxQueue = null;
let _testMaxRetries = null;
let _testTranslateBatch = null;
let _testConsentOverride = null;

export function _setTranslateBatchForTest(fn) {
  _testTranslateBatch = fn;
}

export function _setTestConsentOverride(val) {
  _testConsentOverride = typeof val === 'boolean' ? val : null;
}

export function checkDataConsentAccepted(settings) {
  if (dataConsentRevocationPending) return false;
  if (_testConsentOverride !== null) {
    return _testConsentOverride;
  }
  if (_testMode) {
    return true;
  }
  return isDataConsentAccepted(settings);
}

// TEST-ONLY: Activate test mode for automated test suites
export function _setTestMode(enabled) {
  _testMode = Boolean(enabled);
  if (!_testMode) {
    _testPermissionOverrides.clear();
    testTabRegistry.clear();
    _testRateLimits = null;
    _testRateWindowSeconds = null;
    _testMaxQueue = null;
    _testMaxRetries = null;
    _testTranslateBatch = null;
    _testConsentOverride = null;
  }
}

function _setTestMaxRetries(n) {
  if (!_testMode) return;
  _testMaxRetries = typeof n === 'number' ? n : null;
}

// TEST-ONLY: Set explicit permission status for origin
export function _setTestPermission(origin, granted) {
  if (!_testMode) return;
  const norm = normalizeOrigin(origin);
  if (norm) {
    _testPermissionOverrides.set(norm, Boolean(granted));
  }
}

/**
 * TEST-ONLY: register a simulated tab so policy checks (queue timer,
 * SET_TAB_OVERRIDE) can resolve it without a real chrome tab. Read only when
 * _testMode is on; production never populates the registry.
 */
export function _registerTestTab(tabId, url) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return;
  if (url === null || url === undefined) {
    testTabRegistry.delete(id);
    return;
  }
  testTabRegistry.set(id, String(url));
}

/** TEST-ONLY: check registry (lets the harness verify re-register after restart). */
function _testRegistryHas(tabId) {
  if (!_testMode) return false;
  return testTabRegistry.has(Number(tabId));
}

function _setTestRateLimits(limits) {
  if (!_testMode) return;
  _testRateLimits = limits;
}

function _setTestRateWindowSeconds(sec) {
  if (!_testMode) return;
  _testRateWindowSeconds = typeof sec === 'number' ? sec : null;
}

function _setTestMaxQueue(n) {
  if (!_testMode) return;
  _testMaxQueue = typeof n === 'number' ? n : null;
}

async function _resetRateStateForTest() {
  if (!_testMode) return;
  for (const [reqId, active] of activeBatchControllers.entries()) {
    try { active.controller.abort('test_reset'); } catch {}
  }
  activeBatchControllers.clear();
  for (const queue of tabQueues.values()) {
    for (const entry of queue) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(createTypedError('ABORTED', 'Rate state reset for test', false, { reason: 'Test reset' }));
    }
  }
  tabQueues.clear();
  tabEpochs.clear();
  try {
    if (chrome.storage && chrome.storage.session) {
      const all = await chrome.storage.session.get(null);
      const toRemove = Object.keys(all).filter((k) => k.startsWith('rate:'));
      if (toRemove.length > 0) {
        await chrome.storage.session.remove(toRemove);
      }
    }
  } catch {}
}

/**
 * Checks whether host permission (origin + '/*') is granted.
 * In production (_testMode === false), queries native chrome.permissions.contains.
 */
async function permissionContains(origin) {
  const norm = normalizeOrigin(origin);
  if (!norm) return false;

  // TEST-ONLY: check test override map only when test mode is enabled
  if (_testMode) {
    if (_testPermissionOverrides.has(norm)) {
      return Boolean(_testPermissionOverrides.get(norm));
    }
  }

  // Production path: native chrome.permissions.contains
  try {
    if (typeof chrome !== 'undefined' && chrome.permissions && typeof chrome.permissions.contains === 'function') {
      return await chrome.permissions.contains({ origins: [norm + '/*'] });
    }
  } catch {
    return false;
  }
  return false;
}



// 4.1 Storage Access Level & Stored Settings via storage-manager module
let settingsWriteQueue = Promise.resolve();
function serializeSettingsWrite(operation) {
  const next = settingsWriteQueue.then(operation, operation);
  settingsWriteQueue = next.catch(() => {});
  return next;
}

const storageManager = createStorageManager({
  SETTINGS_VERSION,
  migrateSettings,
  updateProviderConcurrency,
  createTypedError,
  serializeSettingsWrite,
  isTestMode: () => _testMode
});

const {
  ensureStorageAccess,
  getStoredSettings,
  getStoredApiKey,
  getStoredSites,
  getStoredRegistrations,
  getStoredTabOverrides,
  resetStorageAccessStateForTest: _resetStorageAccessStateForTest,
  setTestStorageAccessFailure: _setTestStorageAccessFailure
} = storageManager;

const DEFAULT_MAX_QUEUE_PER_TAB = 8;
const tabQueues = new Map(); // tabId -> Array of QueueEntry
const tabEpochs = new Map(); // tabId -> current epoch number
// Controller per-request (Map by requestId instead of tabId to allow concurrent content batches)
const activeBatchControllers = new Map(); // requestId -> { controller, tabId, revision, epoch, origin }

function getMaxQueue() {
  return (_testMode && typeof _testMaxQueue === 'number') ? _testMaxQueue : DEFAULT_MAX_QUEUE_PER_TAB;
}

const admissionManager = createAdmissionManager({
  tabQueues,
  tabEpochs,
  testTabRegistry,
  isTestMode: () => _testMode,
  getTestRateLimits: () => _testRateLimits,
  getTestRateWindowSeconds: () => _testRateWindowSeconds,
  getStoredSettings,
  getStoredSites,
  getStoredTabOverrides,
  ensureStorageAccess,
  permissionContains,
  executeBatchTranslation: (args) => executeBatchTranslation(args),
  translateBatch: (args) => translateBatch(args),
  pushTranslateProgress
});

const {
  getRateState,
  setRateStates,
  runInAdmissionChain,
  removeEntryFromQueue,
  checkAdmission,
  resolveTabPolicy,
  scheduleQueueEntry
} = admissionManager;

const tabLifecycleManager = createTabLifecycleManager({
  activeBatchControllers,
  tabEpochs,
  tabQueues,
  resolveTabPolicy,
  getStoredSites,
  getStoredTabOverrides,
  getStoredSettings,
  checkDataConsentAccepted,
  getEffectivePolicy,
  permissionContains,
  getConfigRevision: () => configRevision
});

const {
  handleTabRemoved,
  handleTabUpdated,
  verifyTabDispatchPolicy
} = tabLifecycleManager;

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated && typeof chrome.tabs.onUpdated.addListener === 'function') {
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
}

async function reconcilePermissions() {
  return reconcilePermissionsModule({
    ensureStorageAccess,
    permissionContains,
    activeBatchControllers,
    tabQueues
  });
}

// Effective per-tab config: per-site overrides win, otherwise globals.
function resolveEffectiveSiteConfig(settings, origin) {
  return resolveEffectiveSiteConfigModule(settings, origin, DEFAULT_MODEL);
}

// Push helpers for best-effort broadcast
function notifyModelsUpdated(data) {
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
    try {
      chrome.runtime.sendMessage({ action: 'MODELS_UPDATED', ...data }).catch(() => {});
    } catch {}
  }
}

function pushWidgetStateChanged(tabId, state) {
  return pushWidgetStateChangedModule(tabId, state);
}

async function notifyAllWidgetStateChanged(patch) {
  return notifyAllWidgetStateChangedModule(patch, getStoredSettings);
}

// Hash full key + baseURL into SHA-256 hex string (zero key material stored)
async function computeKeyFingerprint(key, baseURL) {
  return computeKeyFingerprintModule(key, baseURL);
}

// Adapter router instance configuration
const routerConfig = {
  baseURL: '',
  apiKey: '',
  model: DEFAULT_MODEL,
  timeoutMs: TRANSLATE_TIMEOUT_MS,
  listModelsTimeoutMs: LIST_MODELS_TIMEOUT_MS,
  getMaxRetries: () => (_testMode && typeof _testMaxRetries === 'number') ? _testMaxRetries : 2
};

const router = createOpenAICompatibleAdapter(routerConfig);

// Model Discovery (L2 storage.local cache with TTL & background revalidation)
async function checkBaseUrlPermission(baseURL) {
  return checkBaseUrlPermissionModule({
    baseURL,
    testMode: _testMode,
    permissionContains
  });
}

async function listModels(options = {}) {
  return listModelsWithContext(options, {
    router,
    ensureStorageAccess,
    getStoredSettings,
    getStoredApiKey,
    checkDataConsentAccepted,
    CURRENT_DATA_CONSENT_VERSION,
    testMode: _testMode,
    permissionContains,
    notifyModelsUpdated
  });
}

// Batch Translation (delegated to adapter)
async function translateBatch(input = {}) {
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  if (!checkDataConsentAccepted(settings)) {
    return createTypedError(
      'DATA_CONSENT_REQUIRED',
      'Data consent not accepted — please accept terms in popup before translating',
      false,
      { dataConsentVersion: CURRENT_DATA_CONSENT_VERSION }
    );
  }
  const baseURL = input.baseURL || settings.baseURL;
  const basePermError = await checkBaseUrlPermission(baseURL);
  if (basePermError) return basePermError;
  if (_testMode && typeof _testTranslateBatch === 'function') {
    return await _testTranslateBatch(input);
  }
  const apiKey = await getStoredApiKey();
  const key = input.apiKey !== undefined ? input.apiKey : apiKey;
  const model = input.model || settings.model || DEFAULT_MODEL;
  return await router.translateBatch({
    ...input,
    baseURL,
    apiKey: key,
    model
  });
}

// Semaphore-guarded batch translation with fallback chain & cache population strictly under actualModel
// Best-effort progressive patch: while a batch streams, each completed
// result item is pushed to the tab so content can patch immediately instead
// of waiting for the full response. Guarded by epoch + the same rec checks
// content applies on the final path (idempotent duplicates are skipped).
function pushTranslateProgress(tabId, epoch, item) {
  if (typeof tabId !== 'number' || !item || typeof item.id !== 'string') return;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      chrome.tabs.sendMessage(tabId, {
        action: 'TRANSLATE_PROGRESS',
        epoch,
        item: { id: item.id, revision: item.revision, text: item.text }
      }).catch(() => {});
    }
  } catch {}
}

const batchEngine = createBatchEngine({
  getProviderSemaphore,
  activeBatchControllers,
  tabEpochs,
  getConfigRevision: () => configRevision,
  pushTranslateProgress,
  verifyTabDispatchPolicy,
  getStoredSettings,
  getStoredApiKey,
  resolveFallbackChain,
  DEFAULT_MODEL,
  resolveFallbackPlan,
  recordErrorLog,
  resolveAttemptCache,
  checkL2CacheForMisses,
  translateBatch,
  commitTranslatedCache,
  mergeBatchResults,
  extractHost,
  PROMPT_VERSION,
  cacheKey,
  normalizeSourceText,
  translationCache,
  isL2MemoryOnly,
  isL2Clearing,
  getL2Epoch,
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  hashText,
  enqueueL2Cache,
  createTypedError
});

export async function executeBatchTranslation(args) {
  // Verification Contract Markers:
  // code: 'PARTIAL_BATCH', isTerminal: false, failed: missingIds.length
  // partial: Boolean(finalProviderRes?.partial || missingIds.length > 0)
  return batchEngine.executeBatchTranslation(args);
}

// Startup hooks
initErrorLog().catch(() => {});
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled?.addListener(() => {
    initErrorLog().catch(() => {});
    ensureStorageAccess()
      .then(() => reconcilePermissions())
      .catch(() => {});
  });

  chrome.runtime.onStartup?.addListener(() => {
    initErrorLog().catch(() => {});
    ensureStorageAccess()
      .then(() => reconcilePermissions())
      .catch(() => {});
  });
}

// Permission removal listener
if (typeof chrome !== 'undefined' && chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(async () => {
    try {
      await reconcilePermissions();
    } catch {}
    notifyAllWidgetStateChanged();
  });
}

// serializeSettingsWrite is initialized with storageManager above

// Runtime Message Handler
async function handleRuntimeMessage(message, sender = { frameId: 0 }) {
  try {
    switch (message.action) {
      case 'PING':
        return { ok: true, version: '0.1.2' };

      case 'GET_SETTINGS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'GET_SETTINGS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const settings = await getStoredSettings();
        const hasKey = Boolean(await getStoredApiKey());
        let storedFbKeys = {};
        try {
          const res = await chrome.storage.local.get(['fallback_api_keys']);
          storedFbKeys = res.fallback_api_keys || {};
        } catch {}
        const fallbackKeyPresence = {};
        const fallbackWarnings = [];
        const primaryOrigin = settings.baseURL ? normalizeOrigin(settings.baseURL) : null;
        if (Array.isArray(settings.fallbacks)) {
          for (const fb of settings.fallbacks) {
            if (fb && fb.id) {
              const hasFbKey = Boolean(storedFbKeys[fb.id]);
              fallbackKeyPresence[fb.id] = hasFbKey;
              const fbOrigin = fb.baseURL ? normalizeOrigin(fb.baseURL) : primaryOrigin;
              if (!hasFbKey && fbOrigin && primaryOrigin && fbOrigin !== primaryOrigin) {
                fallbackWarnings.push({ id: fb.id, warning: 'missing_key_for_origin' });
              }
            }
          }
        }
        return { settings, hasKey, fallbackKeyPresence, fallbackWarnings, configRevision };
      }

      case 'SAVE_SETTINGS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SAVE_SETTINGS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const requestedSettings = (message.settings && typeof message.settings === 'object' && !Array.isArray(message.settings))
          ? message.settings
          : {};
        const replaceFavoriteModelsByBaseURL = message.replaceFavoriteModelsByBaseURL === true;
        const hasExplicitConsentPatch = Object.prototype.hasOwnProperty.call(requestedSettings, 'dataConsent');
        const requestedConsentAccepted = hasExplicitConsentPatch &&
          isDataConsentAccepted({ dataConsent: requestedSettings.dataConsent });
        let consentGenerationAtRequest = dataConsentRevocationGeneration;
        if (hasExplicitConsentPatch && !requestedConsentAccepted) {
          consentGenerationAtRequest = ++dataConsentRevocationGeneration;
          dataConsentRevocationPending = true;
        }
        return await serializeSettingsWrite(async () => {
        // A previous queued acceptance may have completed after this decline was
        // requested. Reassert the newer revocation before the first await here.
        if (hasExplicitConsentPatch && !requestedConsentAccepted) {
          dataConsentRevocationPending = true;
        }
        await ensureStorageAccess();

        const oldSettings = await getStoredSettings({ persistMigration: false });
        const patch = (message.settings && typeof message.settings === 'object' && !Array.isArray(message.settings))
          ? message.settings
          : {};
        const favoriteToggle = patch.favoriteToggle;
        const settingsPatch = { ...patch };
        delete settingsPatch.favoriteToggle;

        // Merge patch with previously saved settings
        const mergedRaw = { ...oldSettings, ...settingsPatch };
        if (patch.favoriteModelsByBaseURL && typeof patch.favoriteModelsByBaseURL === 'object' && !Array.isArray(patch.favoriteModelsByBaseURL)) {
          mergedRaw.favoriteModelsByBaseURL = replaceFavoriteModelsByBaseURL
            ? { ...patch.favoriteModelsByBaseURL }
            : {
                ...(oldSettings.favoriteModelsByBaseURL || {}),
                ...patch.favoriteModelsByBaseURL
              };
        }
        if (patch.rateLimits && typeof patch.rateLimits === 'object' && !Array.isArray(patch.rateLimits)) {
          mergedRaw.rateLimits = {
            ...oldSettings.rateLimits,
            ...patch.rateLimits,
            tab: { ...(oldSettings.rateLimits?.tab || {}), ...(patch.rateLimits.tab || {}) },
            site: { ...(oldSettings.rateLimits?.site || {}), ...(patch.rateLimits.site || {}) }
          };
        }

        // Backward-compatibility: if legacy fallbackModels is passed in patch without fallbacks
        if (Array.isArray(patch.fallbackModels) && !('fallbacks' in patch)) {
          mergedRaw.fallbacks = patch.fallbackModels.filter(Boolean).map((m, i) => ({ id: `fb${i + 1}`, model: m }));
          delete mergedRaw.fallbackModels;
        }

        // Backward-compat (T43): explicit legacy favoriteModels without a scoped
        // map updates the active Base URL bucket so GET returns the submitted
        // list. A bare baseURL switch (no explicit list) still starts empty.
        if (Array.isArray(patch.favoriteModels) && !('favoriteModelsByBaseURL' in patch) && !favoriteToggle) {
          const activeBase = (typeof patch.baseURL === 'string' && patch.baseURL.trim())
            ? patch.baseURL
            : oldSettings.baseURL;
          const scopeKey = normalizeBaseURLKey(activeBase);
          if (scopeKey) {
            const prevMap = (mergedRaw.favoriteModelsByBaseURL && typeof mergedRaw.favoriteModelsByBaseURL === 'object' && !Array.isArray(mergedRaw.favoriteModelsByBaseURL))
              ? mergedRaw.favoriteModelsByBaseURL
              : {};
            mergedRaw.favoriteModelsByBaseURL = { ...prevMap, [scopeKey]: [...patch.favoriteModels] };
          }
        }

        let favoriteToggleResult = null;
        if (favoriteToggle !== undefined) {
          const scopeKey = normalizeBaseURLKey(favoriteToggle && favoriteToggle.scopeKey);
          const model = (favoriteToggle && typeof favoriteToggle.model === 'string') ? favoriteToggle.model.trim() : '';
          const wantFavorite = favoriteToggle ? favoriteToggle.favorite : undefined;
          const toggleSchemaErrors = [];
          if (!scopeKey) toggleSchemaErrors.push('favoriteToggle.scopeKey must be a valid Base URL');
          if (!model) toggleSchemaErrors.push('favoriteToggle.model must be a non-empty string');
          if (typeof wantFavorite !== 'boolean') toggleSchemaErrors.push('favoriteToggle.favorite must be a boolean');
          if (toggleSchemaErrors.length > 0) {
            return createTypedError('INVALID_SCHEMA', 'favoriteToggle requires a valid Base URL scope, model, and favorite (true|false)', false, {
              schemaErrors: toggleSchemaErrors
            });
          }
          const map = (mergedRaw.favoriteModelsByBaseURL && typeof mergedRaw.favoriteModelsByBaseURL === 'object' && !Array.isArray(mergedRaw.favoriteModelsByBaseURL))
            ? mergedRaw.favoriteModelsByBaseURL
            : {};
          const bucket = Array.isArray(map[scopeKey]) ? map[scopeKey] : [];
          let favorites;
          if (wantFavorite) {
            if (bucket.includes(model)) {
              favorites = [...bucket];
            } else {
              if (bucket.length >= 50) {
                return createTypedError('CAP_EXCEEDED', 'Danh sách yêu thích đã đạt tối đa 50 model cho provider này', false, {
                  capType: 'items',
                  limit: 50,
                  actual: bucket.length + 1,
                  model
                });
              }
              favorites = [...bucket, model];
            }
          } else {
            favorites = bucket.filter((item) => item !== model);
          }
          mergedRaw.favoriteModelsByBaseURL = { ...map, [scopeKey]: favorites };
          if (normalizeBaseURLKey(mergedRaw.baseURL) === scopeKey) mergedRaw.favoriteModels = favorites;
          favoriteToggleResult = { scopeKey, favorites };
        }

        const validation = validateSettings(mergedRaw);
        if (!validation.valid) {
          return createTypedError('INVALID_SCHEMA', 'Invalid settings: ' + (validation.errors || []).join('; '), false, {
            schemaErrors: validation.errors
          });
        }

        const migrated = migrateSettings(mergedRaw);
        if (migrated.providerConcurrency) {
          updateProviderConcurrency(migrated.providerConcurrency);
        }

        // Only bump revision if fields affecting translation change
        const configChanged = (
          oldSettings.baseURL !== migrated.baseURL ||
          oldSettings.model !== migrated.model ||
          oldSettings.sourceLanguage !== migrated.sourceLanguage ||
          oldSettings.targetLanguage !== migrated.targetLanguage ||
          oldSettings.translationMode !== migrated.translationMode ||
          !fallbacksEqual(oldSettings.fallbacks, migrated.fallbacks)
        );
        const dataConsentChanged = isDataConsentAccepted(oldSettings) !== isDataConsentAccepted(migrated);
        const dataConsentRevoked = isDataConsentAccepted(oldSettings) && !isDataConsentAccepted(migrated);

        if (configChanged || dataConsentChanged) {
          const abortReason = dataConsentRevoked ? 'data_consent_revoked' : 'config_changed';
          const abortMessage = dataConsentRevoked
            ? 'Translation request aborted because data consent was revoked'
            : 'Translation request aborted because settings changed';
          configRevision++;
          translationCache.clear();
          clearPendingL2Writes();
          // Abort active in-flight requests across all tabs
          for (const [reqId, active] of activeBatchControllers.entries()) {
            try { active.controller.abort(abortReason); } catch {}
          }
          activeBatchControllers.clear();
          // Abort all queued batches across all tabs
          for (const [tabId, queue] of tabQueues.entries()) {
            for (const entry of queue) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'ABORTED',
                abortMessage,
                false,
                { reason: abortReason }
              ));
            }
          }
          tabQueues.clear();
        }

        if (dataConsentRevoked) {
          try { await clearL2Cache(); } catch {}
        }

        // Invalidate model cache if baseURL changed (best-effort)
        if (oldSettings.baseURL !== migrated.baseURL) {
          try {
            await chrome.storage.local.remove(['modelListCache']);
          } catch {}
        }

        // Prune orphan fallback keys when a fallback is removed
        try {
          const resFbKeys = await chrome.storage.local.get(['fallback_api_keys']);
          const currentFbKeys = resFbKeys.fallback_api_keys || {};
          const activeFbIds = new Set((migrated.fallbacks || []).map((fb) => fb.id));
          let fbKeysPruned = false;
          const nextFbKeys = { ...currentFbKeys };
          for (const id of Object.keys(nextFbKeys)) {
            if (!activeFbIds.has(id)) {
              delete nextFbKeys[id];
              fbKeysPruned = true;
            }
          }
          if (fbKeysPruned) {
            await chrome.storage.local.set({ fallback_api_keys: nextFbKeys });
          }
        } catch {}

        await chrome.storage.local.set({ settings: migrated });
        if (hasExplicitConsentPatch && consentGenerationAtRequest === dataConsentRevocationGeneration) {
          dataConsentRevocationPending = false;
        }

        // Refresh open widgets when presentation settings, enabled sites, or global data consent changes.
        const functionalChanged = Boolean(
          dataConsentChanged ||
          oldSettings.translationMode !== migrated.translationMode ||
          JSON.stringify(oldSettings.autoTranslateSites) !== JSON.stringify(migrated.autoTranslateSites)
        );
        const presentationChanged = Boolean(
          oldSettings.widgetVisible !== migrated.widgetVisible ||
          oldSettings.uiLocale !== migrated.uiLocale ||
          oldSettings.theme !== migrated.theme ||
          oldSettings.uiFontScale !== migrated.uiFontScale ||
          oldSettings.fabSize !== migrated.fabSize ||
          oldSettings.fabMascot !== migrated.fabMascot
        );

        if (functionalChanged || presentationChanged) {
          notifyAllWidgetStateChanged({
            fabMascot: migrated.fabMascot || 'default',
            fabSize: typeof migrated.fabSize === 'number' ? migrated.fabSize : 1.0,
            theme: migrated.theme || 'dark',
            uiLocale: migrated.uiLocale || 'vi',
            uiFontScale: migrated.uiFontScale || 'md',
            widgetVisible: migrated.widgetVisible ?? true,
            isPresentation: !functionalChanged
          });
        }

        return { ok: true, configRevision, ...(favoriteToggleResult ? { favoriteToggle: favoriteToggleResult } : {}) };
        });
      }

      case 'GET_QUEUE_STATUS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'GET_QUEUE_STATUS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const tabId = message.tabId;
        if (typeof tabId !== 'number') {
          return { queued: false, queueLength: 0 };
        }
        const queue = tabQueues.get(tabId);
        if (queue && queue.length > 0) {
          const nextEntry = queue[0];
          const remainingMs = Math.max(0, (nextEntry.retryAt || 0) - Date.now());
          return {
            queued: true,
            queueLength: queue.length,
            retryAfterMs: remainingMs,
            scope: nextEntry.scope || 'tab'
          };
        }
        return { queued: false, queueLength: 0 };
      }

      case 'SET_KEY': {
        return await handleSetKeyAction({
          message,
          sender,
          ensureStorageAccess,
          abortContext: { activeBatchControllers, tabQueues, translationCache, clearL2Cache },
          bumpConfigRevision: () => ++configRevision,
          notifyAllWidgetStateChanged
        });
      }

      case 'SET_FALLBACK_KEY': {
        return await handleSetFallbackKeyAction({
          message,
          sender,
          ensureStorageAccess,
          getStoredSettings,
          abortContext: { activeBatchControllers, tabQueues, translationCache, clearL2Cache },
          bumpConfigRevision: () => ++configRevision,
          notifyAllWidgetStateChanged
        });
      }

      case 'DELETE_FALLBACK_KEY': {
        return await handleDeleteFallbackKeyAction({
          message,
          sender,
          ensureStorageAccess,
          abortContext: { activeBatchControllers, tabQueues, translationCache, clearL2Cache },
          bumpConfigRevision: () => ++configRevision,
          notifyAllWidgetStateChanged
        });
      }

      case 'DELETE_KEY': {
        return await handleDeleteKeyAction({
          sender,
          ensureStorageAccess,
          abortContext: { activeBatchControllers, tabQueues, translationCache, clearL2Cache },
          bumpConfigRevision: () => ++configRevision,
          notifyAllWidgetStateChanged
        });
      }

      case 'HAS_KEY': {
        return await handleHasKeyAction({ sender, getStoredApiKey });
      }

      case 'LIST_MODELS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'LIST_MODELS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        return await listModels({ forceRefresh: Boolean(message.forceRefresh) });
      }

      case 'GET_CONSENT': {
        return await handleGetConsentAction({
          sender,
          message,
          getStoredSites,
          getStoredTabOverrides
        });
      }

      case 'SET_SITE_ENABLED': {
        return await handleSetSiteEnabledAction({
          sender,
          message,
          ensureStorageAccess,
          permissionContains,
          activeBatchControllers,
          tabQueues,
          reconcilePermissions,
          notifyAllWidgetStateChanged
        });
      }

      case 'ENSURE_CONTENT': {
        return await handleEnsureContentAction({
          sender,
          message,
          isTestMode: () => _testMode,
          isTestEnsureContentOk: () => _testEnsureContentOk,
          ensureStorageAccess,
          getStoredSites,
          getStoredTabOverrides,
          permissionContains
        });
      }

      case 'RECONCILE': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'RECONCILE is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        return await reconcilePermissions();
      }

      case 'SET_TAB_OVERRIDE': {
        return await handleSetTabOverrideAction({
          sender,
          message,
          resolveTabPolicy,
          activeBatchControllers,
          tabQueues,
          notifyAllWidgetStateChanged
        });
      }

      case 'CANCEL_PENDING': {
        return handleCancelPendingAction({
          sender,
          message,
          tabEpochs,
          activeBatchControllers,
          tabQueues
        });
      }

      case 'TRANSLATE_BATCH': {
        // Record current configRevision at dispatch time
        const batchConfigRevision = configRevision;

        // 1. Fail-closed storage access verification
        await ensureStorageAccess();

        // 1b. Fail-closed data consent verification (WI-51)
        const storedSettings = await getStoredSettings();
        if (!checkDataConsentAccepted(storedSettings)) {
          return createTypedError(
            'DATA_CONSENT_REQUIRED',
            'Data consent not accepted — please accept terms in popup before translating',
            false,
            { dataConsentVersion: CURRENT_DATA_CONSENT_VERSION }
          );
        }

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

        // 4. Permission check before translation
        const hasPerm = await permissionContains(origin);
        if (!hasPerm) {
          return createTypedError('PERMISSION_REQUIRED', 'Host permission not granted for site origin', false, {
            origin,
            permissionType: 'host'
          });
        }

        // Validate batch items before admission / cache lookup (zero rate/slot cost)
        const rawItems = message.payload?.items;
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
          return createTypedError('INVALID_SCHEMA', 'Batch items must be a non-empty array', false, {
            schemaErrors: ['items must be a non-empty array']
          });
        }

        // 5. Cache lookup on primary model (after consent & permission, BEFORE rate admission)
        // NOTE: payload.model wins — content sends the resolved effective model
        // (per-site override, else global). Stored model is only the default.
        // (Same rule as the fallback-chain primary leg in executeBatchTranslation.)
        const payloadModel = (message.payload && typeof message.payload.model === 'string' && message.payload.model.trim())
          ? message.payload.model.trim()
          : null;
        const primaryModel = payloadModel || storedSettings.model || DEFAULT_MODEL;
        const cacheContext = {
          baseURL: storedSettings.baseURL || '',
          model: primaryModel,
          sourceLanguage: message.payload?.sourceLanguage || storedSettings.sourceLanguage || 'auto',
          targetLanguage: message.payload?.targetLanguage || storedSettings.targetLanguage || 'vi',
          promptVersion: PROMPT_VERSION
        };

        const items = message.payload?.items || [];
        const hits = [];
        let misses = [];

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const normText = normalizeSourceText(it?.text);
          const key = cacheKey(it, cacheContext);
          const cachedText = translationCache.get(key, normText);
          if (cachedText !== undefined) {
            hits.push({
              index: i,
              result: {
                id: it.id,
                revision: it.revision,
                text: cachedText
              }
            });
          } else {
            misses.push({
              index: i,
              item: it,
              key
            });
          }
        }

        misses = await checkL2CacheForMisses({
          remainingMisses: misses,
          currentHits: hits,
          storedSettings,
          isL2MemoryOnly,
          isL2Clearing,
          getL2Epoch,
          chromeStorageLocal: typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null,
          L2_CACHE_KEY,
          L2_CACHE_TTL_MS,
          normalizeSourceText,
          hashText,
          translationCache
        });

        // Fast path: full cache hit bypasses rate admission & provider calls completely
        if (misses.length === 0) {
          if (batchConfigRevision !== configRevision) {
            return {
              ...createTypedError(
                'ABORTED',
                'Translation batch discarded due to configuration change',
                false,
                { batchConfigRevision, currentConfigRevision: configRevision }
              ),
              configRevision: batchConfigRevision,
              currentConfigRevision: configRevision
            };
          }
          return {
            results: hits.map((h) => h.result),
            requestedModel: primaryModel,
            actualModel: primaryModel,
            fallbackIndex: 0,
            actualBaseURLHost: extractHost(storedSettings.baseURL || ''),
            configRevision: batchConfigRevision,
            currentConfigRevision: configRevision
          };
        }

        // 6. Calculate cost on MISSES only (Unicode code points)
        const totalCodePoints = misses.reduce((sum, m) => sum + countCodePoints(m.item?.text), 0);
        const cost = { batches: 1, codePoints: totalCodePoints };

        const reqEpoch = typeof message.epoch === 'number' ? message.epoch : (tabEpochs.get(sender.tab.id) || 0);
        if (!tabEpochs.has(sender.tab.id) || reqEpoch > tabEpochs.get(sender.tab.id)) {
          tabEpochs.set(sender.tab.id, reqEpoch);
        }

        // 7. Admission check inside mutex (throws typed RATE_STATE_UNAVAILABLE on storage failure)
        const admission = await checkAdmission(sender.tab.id, origin, cost);

        if (!admission.allowed) {
          const tabId = sender.tab.id;
          let queue = tabQueues.get(tabId);
          if (!queue) {
            queue = [];
            tabQueues.set(tabId, queue);
          }

          if (queue.length >= getMaxQueue()) {
            return admission.rateLimitedError;
          }

          // Enqueue and defer response
          return new Promise((resolve, reject) => {
            const entry = {
              id: 'req_' + Math.random().toString(36).slice(2),
              tabId,
              tabUrl: senderRawUrl,
              origin,
              epoch: reqEpoch,
              configRevision: batchConfigRevision,
              scope: admission.scope,
              retryAt: Date.now() + admission.retryAfterMs,
              cost,
              payload: message.payload,
              misses,
              hits,
              sender,
              resolve,
              reject,
              timer: null,
              attempts: 0
            };
            queue.push(entry);
            scheduleQueueEntry(entry, admission.retryAfterMs);
          });
        }

        // 8. Dispatch batch under semaphore concurrency limit 2
        return await executeBatchTranslation({
          payload: message.payload || {},
          misses,
          hits,
          batchConfigRevision,
          tabId: sender.tab.id,
          epoch: reqEpoch,
          origin
        });
      }

      // ======================================================================
      // WIDGET_* Action Handlers (§2 Sol protocol)
      // ======================================================================
      case 'WIDGET_GET_STATE': {
        // Contract assertions:
        // reason = 'no_key'
        // effective !== 'on'
        // fabSize: typeof settings.fabSize === 'number' ? settings.fabSize : 1
        // fabMascot: settings.fabMascot || 'default'
        // showFavoritesOnly: Boolean(settings.showFavoritesOnly)
        // favoritesHint = 'no_favorites_show_all'
        return await handleWidgetGetStateAction({
          sender,
          message,
          ensureStorageAccess,
          getStoredSettings,
          getStoredApiKey,
          getStoredSites,
          getStoredTabOverrides,
          checkDataConsentAccepted,
          permissionContains,
          resolveEffectiveSiteConfig,
          listModels,
          normalizeBaseURLKey
        });
      }

      case 'WIDGET_SET_ENABLED': {
        return await handleWidgetSetEnabledAction({
          sender,
          message,
          ensureStorageAccess,
          getStoredSites,
          getStoredTabOverrides,
          permissionContains,
          activeBatchControllers,
          tabQueues,
          getStoredSettings,
          getStoredApiKey,
          resolveEffectiveSiteConfig,
          pushWidgetStateChanged
        });
      }

      case 'WIDGET_SET_MODE': {
        return await handleWidgetSetModeAction({
          sender,
          message,
          serializeSettingsWrite,
          ensureStorageAccess,
          getStoredSettings,
          bumpConfigRevision: () => ++configRevision,
          translationCache,
          clearPendingL2Writes,
          activeBatchControllers,
          tabQueues,
          migrateSettings,
          notifyAllWidgetStateChanged
        });
      }

      case 'WIDGET_SET_POSITION': {
        return await handleWidgetSetPositionAction({ sender, message, ensureStorageAccess });
      }

      case 'GET_ERROR_LOG': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'GET_ERROR_LOG is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const entries = await getErrorLog();
        return { ok: true, entries };
      }

      case 'CLEAR_ERROR_LOG': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'CLEAR_ERROR_LOG is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await clearErrorLog();
        return { ok: true };
      }

      case 'RECORD_ERROR_LOG': {
        const err = message.error || { code: 'UNKNOWN', message: 'Unknown error' };
        const entry = await recordErrorLog(err, {
          model: message.model || '',
          tabId: sender?.tab?.id || message.tabId || null,
          isTerminal: Boolean(message.isTerminal)
        });
        return { ok: true, entry };
      }

      case 'WATCHDOG_RECONCILE': {
        const result = reconcileWatchdog(message.payload || {});
        if (result.logEntry) {
          await recordErrorLog(result.logEntry, {
            model: message.model || '',
            tabId: sender?.tab?.id || message.tabId || null,
            isTerminal: false
          });
        }
        return { ok: true, ...result };
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

const globalScope = typeof self !== 'undefined' ? self : globalThis;

globalScope.__translatorSw = {
  dispatchMessage: (message, sender = { url: defaultTestExtensionUrl }) => handleRuntimeMessage(message, sender),
  _resetStorageAccessStateForTest,
  _setTestMode,
  _setTestConsentOverride,
  _setTestPermission,
  _registerTestTab,
  _testRegistryHas,
  _setTestStorageAccessFailure,
  _setTestEnsureContentOk,
  _setTestRateLimits,
  _setTestRateWindowSeconds,
  _setTestMaxQueue,
  _setTestMaxRetries,
  _resetRateStateForTest,
  _handleTabRemovedForTest: (tabId) => handleTabRemoved(tabId),
  _handleTabUpdatedForTest: (tabId, changeInfo, tab) => handleTabUpdated(tabId, changeInfo, tab),
  reconcilePermissions,
  permissionContains,
  translateBatch,
  listModels,
  ensureStorageAccess,
  getStoredSettings,
  getStoredApiKey,
  getStoredSites,
  getStoredTabOverrides,
  getStoredRegistrations,
  DEFAULT_MODEL,
  TRANSLATE_TIMEOUT_MS,
  LIST_MODELS_TIMEOUT_MS,
  translationCache,
  providerSemaphore,
  getProviderSemaphore,
  updateProviderConcurrency,
  resolveLimits,
  getConfigRevision: () => configRevision,
  SETTINGS_VERSION,
  migrateSettings,
  validateSettings,
  resolveFallbackPlan,
  computeKeyFingerprint,
  activeBatchControllers,
  recordErrorLog,
  getErrorLog,
  clearErrorLog,
  enqueueL2Cache,
  flushL2Cache,
  clearL2Cache,
  getL2Epoch,
  isL2MemoryOnly,
  _setL2MemoryOnlyForTest,
  isClearingL2: isL2Clearing,
  isL2Clearing,
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  L2_MAX_SIZE_BYTES,
  reconcileWatchdog,
  executeBatchTranslation,
  _setTranslateBatchForTest
};
