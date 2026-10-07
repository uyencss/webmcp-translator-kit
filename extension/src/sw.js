// WebMCP Translator Kit — Background Service Worker (Direct Mode)
// Contract Version: webmcp-translator-contract/1

import { createDirect9Router } from './adapter/direct9router.mjs';
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

let storageAccessInitialized = false;
let storageAccessFailed = false;
let currentAccessLevel = 'TRUSTED_AND_UNTRUSTED_CONTEXTS';

// Expose reset hook strictly for tests (never bypasses security)
function _resetStorageAccessStateForTest() {
  storageAccessInitialized = false;
  storageAccessFailed = false;
}

// TEST-ONLY: force ensureStorageAccess() to fail closed (avoids monkeypatching
// native Chrome API objects, which cannot be safely restored with delete).
let _forceStorageAccessFailure = false;
function _setTestStorageAccessFailure(enabled) {
  if (!_testMode) return;
  _forceStorageAccessFailure = Boolean(enabled);
}

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



// 4.1 Storage Access Level: TRUSTED_CONTEXTS fail-closed gate
async function ensureStorageAccess() {
  if (storageAccessInitialized && !storageAccessFailed) return;

  if (_testMode && _forceStorageAccessFailure) {
    currentAccessLevel = 'UNAVAILABLE';
    storageAccessInitialized = false;
    storageAccessFailed = true;
    throw createTypedError(
      'KEY_ACCESS_UNAVAILABLE',
      'Test-injected storage access failure',
      false,
      { reason: 'test hook' }
    );
  }

  if (
    typeof chrome === 'undefined' ||
    !chrome.storage ||
    !chrome.storage.local ||
    typeof chrome.storage.local.setAccessLevel !== 'function'
  ) {
    currentAccessLevel = 'UNAVAILABLE';
    storageAccessInitialized = false;
    storageAccessFailed = true;
    throw createTypedError(
      'KEY_ACCESS_UNAVAILABLE',
      'chrome.storage.local.setAccessLevel is not available',
      false,
      { reason: 'setAccessLevel method missing' }
    );
  }

  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    currentAccessLevel = 'TRUSTED_CONTEXTS';
    storageAccessInitialized = true;
    storageAccessFailed = false;
  } catch (err) {
    if (err && typeof err.message === 'string' && /already/i.test(err.message)) {
      currentAccessLevel = 'TRUSTED_CONTEXTS';
      storageAccessInitialized = true;
      storageAccessFailed = false;
      return;
    }
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
async function getStoredSettings({ persistMigration = true } = {}) {
  await ensureStorageAccess();
  const res = await chrome.storage.local.get(['settings']);
  const raw = res.settings;
  const migrated = migrateSettings(raw);
  if (migrated.providerConcurrency) {
    updateProviderConcurrency(migrated.providerConcurrency);
  }
  if ((!raw || raw.version !== SETTINGS_VERSION) && persistMigration) {
    return serializeSettingsWrite(async () => {
      await ensureStorageAccess();
      const latestRaw = (await chrome.storage.local.get(['settings'])).settings;
      const latestMigrated = migrateSettings(latestRaw);
      if (latestMigrated.providerConcurrency) {
        updateProviderConcurrency(latestMigrated.providerConcurrency);
      }
      if (!latestRaw || latestRaw.version !== SETTINGS_VERSION) {
        await chrome.storage.local.set({ settings: latestMigrated });
      }
      return latestMigrated;
    });
  }
  return migrated;
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

async function getStoredRegistrations() {
  await ensureStorageAccess();
  const res = await chrome.storage.local.get(['registrations']);
  return res.registrations || {};
}

async function getStoredTabOverrides() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    throw createTypedError('CONSENT_STATE_UNAVAILABLE', 'chrome.storage.session unavailable', false);
  }
  const res = await chrome.storage.session.get(['tab_overrides']);
  return res.tab_overrides || {};
}

// Rate limit storage helpers (session storage)
async function getRateState(scope, targetId) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    throw createTypedError('RATE_STATE_UNAVAILABLE', 'chrome.storage.session unavailable', false, {
      scope,
      targetId: String(targetId),
      reason: 'chrome.storage.session is undefined'
    });
  }
  const key = `rate:${scope}:${targetId}`;
  try {
    const res = await chrome.storage.session.get([key]);
    return res[key] || createLimitState();
  } catch (err) {
    throw createTypedError('RATE_STATE_UNAVAILABLE', 'Failed to read rate state from storage', false, {
      scope,
      targetId: String(targetId),
      reason: err?.message || String(err)
    });
  }
}

async function setRateStates(tabId, tabState, siteOrigin, siteState) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    throw createTypedError('RATE_STATE_UNAVAILABLE', 'chrome.storage.session unavailable', false, {
      scope: 'tab',
      targetId: String(tabId),
      reason: 'chrome.storage.session is undefined'
    });
  }
  const tabKey = `rate:tab:${tabId}`;
  const siteKey = `rate:site:${siteOrigin}`;
  try {
    await chrome.storage.session.set({
      [tabKey]: tabState,
      [siteKey]: siteState
    });
  } catch (err) {
    throw createTypedError('RATE_STATE_UNAVAILABLE', 'Failed to write rate state to storage', false, {
      scope: 'tab',
      targetId: String(tabId),
      reason: err?.message || String(err)
    });
  }
}

// Admission Mutex & In-memory Bounded Queue
let admissionChain = Promise.resolve();

function runInAdmissionChain(fn) {
  const next = admissionChain.then(fn, fn);
  admissionChain = next.catch(() => {});
  return next;
}

const DEFAULT_MAX_QUEUE_PER_TAB = 8;
const tabQueues = new Map(); // tabId -> Array of QueueEntry
const tabEpochs = new Map(); // tabId -> current epoch number
// Controller per-request (Map by requestId instead of tabId to allow concurrent content batches)
const activeBatchControllers = new Map(); // requestId -> { controller, tabId, revision, epoch, origin }

function getMaxQueue() {
  return (_testMode && typeof _testMaxQueue === 'number') ? _testMaxQueue : DEFAULT_MAX_QUEUE_PER_TAB;
}

function removeEntryFromQueue(entry) {
  const queue = tabQueues.get(entry.tabId);
  if (!queue) return;
  const idx = queue.indexOf(entry);
  if (idx !== -1) {
    queue.splice(idx, 1);
  }
  if (queue.length === 0) {
    tabQueues.delete(entry.tabId);
  }
}

async function checkAdmission(tabId, origin, cost) {
  return runInAdmissionChain(async () => {
    const tabState = await getRateState('tab', tabId);
    const siteState = await getRateState('site', origin);

    const settings = await getStoredSettings();
    let limits = resolveLimits(settings.rateLimits);
    if (_testMode && _testRateLimits) {
      limits = resolveLimits(_testRateLimits);
    }
    if (_testMode && typeof _testRateWindowSeconds === 'number' && _testRateWindowSeconds > 0) {
      limits.windowSeconds = _testRateWindowSeconds;
    }
    limits.tab.windowSeconds = limits.windowSeconds;
    limits.site.windowSeconds = limits.windowSeconds;

    const now = Date.now();
    prune(tabState, now, limits.windowSeconds);
    prune(siteState, now, limits.windowSeconds);

    const tabEval = evaluate(tabState, cost, limits.tab, now, limits.windowSeconds);
    const siteEval = evaluate(siteState, cost, limits.site, now, limits.windowSeconds);

    if (tabEval.allowed && siteEval.allowed) {
      record(tabState, cost, now);
      record(siteState, cost, now);
      await setRateStates(tabId, tabState, origin, siteState);
      return { allowed: true };
    }

    let scope, limit, used, metric, retryAfterMs;
    if (!tabEval.allowed && (!siteEval.allowed ? tabEval.retryAfterMs >= siteEval.retryAfterMs : true)) {
      scope = 'tab';
      metric = tabEval.exceeded === 'codePoints' ? 'code_points' : 'batches';
      limit = metric === 'batches' ? limits.tab.maxBatches : limits.tab.maxSourceCodePoints;
      used = metric === 'batches' ? tabEval.used.batches : tabEval.used.codePoints;
      retryAfterMs = tabEval.retryAfterMs;
    } else {
      scope = 'site';
      metric = siteEval.exceeded === 'codePoints' ? 'code_points' : 'batches';
      limit = metric === 'batches' ? limits.site.maxBatches : limits.site.maxSourceCodePoints;
      used = metric === 'batches' ? siteEval.used.batches : siteEval.used.codePoints;
      retryAfterMs = siteEval.retryAfterMs;
    }

    const targetId = scope === 'tab' ? String(tabId) : origin;
    const rateLimitedError = createTypedError(
      'RATE_LIMITED',
      `Local 60s sliding window quota exceeded for ${scope}`,
      false,
      { scope, targetId, limit, used, retryAfterMs, metric }
    );

    return {
      allowed: false,
      rateLimitedError,
      retryAfterMs,
      scope
    };
  });
}

/**
 * Resolve tab existence + current URL for policy checks. Production reads
 * chrome.tabs. In test mode a TEST-ONLY registry covers simulated tab ids
 * (harness); ids unknown to both sources are treated as closed.
 */
async function resolveTabPolicy(tabId) {
  const idNum = Number(tabId);
  if (_testMode && testTabRegistry.has(idNum)) {
    const testUrl = testTabRegistry.get(idNum);
    return { exists: true, url: (typeof testUrl === 'string' && testUrl) ? testUrl : null };
  }
  let real = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.get === 'function') {
      real = await chrome.tabs.get(tabId);
    }
  } catch {
    real = null;
  }
  if (!real) return null;
  const url = (typeof real.url === 'string' && real.url) || null;
  return { exists: true, url };
}

function scheduleQueueEntry(entry, delayMs) {
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.retryAt = Date.now() + Math.max(10, delayMs);
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    const queue = tabQueues.get(entry.tabId);
    if (!queue || !queue.includes(entry)) {
      return;
    }

    try {
      await ensureStorageAccess();

      // Navigation & tab existence check before consent & admission
      const tabInfo = await resolveTabPolicy(entry.tabId);

      if (!tabInfo) {
        removeEntryFromQueue(entry);
        entry.resolve(createTypedError(
          'ABORTED',
          'Tab was closed while translation was queued',
          false,
          { reason: 'tab_closed' }
        ));
        return;
      }

      const curOrigin = tabInfo.url ? normalizeOrigin(tabInfo.url) : null;
      if (!curOrigin) {
        removeEntryFromQueue(entry);
        entry.resolve(createTypedError(
          'ABORTED',
          'Tab URL could not be verified before dispatch',
          false,
          { reason: 'tab_url_unverifiable', tabId: entry.tabId }
        ));
        return;
      }

      if (curOrigin !== entry.origin) {
        removeEntryFromQueue(entry);
        entry.resolve(createTypedError(
          'ABORTED',
          'Tab navigated while translation was queued',
          false,
          { reason: 'navigation', originalOrigin: entry.origin, currentOrigin: curOrigin }
        ));
        return;
      }

      const sites = await getStoredSites();
      const tabOverrides = await getStoredTabOverrides();
      const siteEnabled = Boolean(sites[entry.origin]);
      const tabOverride = tabOverrides[String(entry.tabId)] || null;
      const effective = getEffectivePolicy({ tabOverride, siteEnabled });

      if (effective !== 'on') {
        removeEntryFromQueue(entry);
        entry.resolve(createTypedError(
          'OPT_IN_REQUIRED',
          'Translation is disabled (tab explicit OFF, site OFF, or default OFF)',
          false,
          {
            tabId: entry.tabId,
            origin: entry.origin,
            scope: tabOverride ? 'tab' : 'site',
            effectiveConsent: 'off'
          }
        ));
        return;
      }

      const hasPerm = await permissionContains(entry.origin);
      if (!hasPerm) {
        removeEntryFromQueue(entry);
        entry.resolve(createTypedError(
          'PERMISSION_REQUIRED',
          'Host permission not granted for site origin',
          false,
          {
            origin: entry.origin,
            permissionType: 'host'
          }
        ));
        return;
      }

      // Re-check epoch: if tab epoch changed during queue wait, abort if older
      if (entry.epoch !== undefined && tabEpochs.has(entry.tabId) && entry.epoch < tabEpochs.get(entry.tabId)) {
        removeEntryFromQueue(entry);
        entry.resolve(createTypedError(
          'ABORTED',
          'Pending translation cancelled by new epoch',
          false,
          { reason: 'Epoch changed during queue wait' }
        ));
        return;
      }

      entry.attempts++;
      const admission = await checkAdmission(entry.tabId, entry.origin, entry.cost);
      if (admission.allowed) {
        removeEntryFromQueue(entry);
        const result = entry.misses
          ? await executeBatchTranslation({
              payload: entry.payload,
              misses: entry.misses,
              hits: entry.hits,
              batchConfigRevision: entry.configRevision,
              tabId: entry.tabId,
              epoch: entry.epoch,
              origin: entry.origin
            })
          : await translateBatch({
            ...(entry.payload || {}),
            onProgress: (item) => pushTranslateProgress(entry.tabId, entry.epoch, item)
          });
        entry.resolve(result);
        return;
      }

      if (entry.attempts >= 3) {
        removeEntryFromQueue(entry);
        entry.resolve(admission.rateLimitedError);
        return;
      }

      scheduleQueueEntry(entry, admission.retryAfterMs);
    } catch (err) {
      removeEntryFromQueue(entry);
      if (err && err.error) {
        entry.resolve(err);
      } else {
        entry.resolve(createTypedError(
          'RATE_STATE_UNAVAILABLE',
          err?.message || 'Error evaluating queue admission',
          false,
          { scope: 'tab', targetId: String(entry.tabId), reason: err?.message || 'Storage error' }
        ));
      }
    }
  }, Math.max(10, delayMs));
}

// Clean tab overrides and rate queues/state when tab closes
async function handleTabRemoved(tabId) {
  try {
    const idNum = Number(tabId);
    for (const [reqId, active] of activeBatchControllers.entries()) {
      if (active.tabId === tabId || active.tabId === idNum) {
        try { active.controller.abort('tab_closed'); } catch {}
        activeBatchControllers.delete(reqId);
      }
    }
    tabEpochs.delete(tabId);
    tabEpochs.delete(idNum);
    const queue = tabQueues.get(tabId) || tabQueues.get(idNum);
    if (queue && queue.length > 0) {
      for (const entry of queue) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve(createTypedError('ABORTED', 'Tab was closed', false, { reason: 'tab_closed' }));
      }
      tabQueues.delete(tabId);
      tabQueues.delete(idNum);
    }
    if (!chrome.storage || !chrome.storage.session) return;
    const res = await chrome.storage.session.get(['tab_overrides']);
    const overrides = res.tab_overrides || {};
    const key = String(tabId);
    if (key in overrides) {
      delete overrides[key];
      await chrome.storage.session.set({ tab_overrides: overrides });
    }
    await chrome.storage.session.remove([`rate:tab:${tabId}`, `rate:tab:${idNum}`]);
  } catch {
    // Ignore cleanup error
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
}

// Clean active batch controllers and rate queues when tab navigates (status === 'loading')
async function handleTabUpdated(tabId, changeInfo, tab) {
  try {
    if (changeInfo && changeInfo.status === 'loading') {
      const idNum = Number(tabId);
      const info = await resolveTabPolicy(idNum);

      if (!info) {
        // Tab closed / gone -> delegate to full removal cleanup
        await handleTabRemoved(idNum);
        return;
      }

      if (info.url === null) {
        // Fail-closed: URL cannot be verified during navigation
        for (const [reqId, active] of activeBatchControllers.entries()) {
          if (active.tabId === idNum || active.tabId === tabId) {
            try { active.controller.abort('navigation'); } catch {}
            activeBatchControllers.delete(reqId);
          }
        }
        const queue = tabQueues.get(idNum) || tabQueues.get(tabId);
        if (queue && queue.length > 0) {
          for (const entry of queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'ABORTED',
              'Tab navigated while translation was queued',
              false,
              { reason: 'navigation', tabId: idNum }
            ));
          }
          tabQueues.delete(idNum);
          tabQueues.delete(tabId);
        }
        return;
      }

      const curOrigin = normalizeOrigin(info.url);
      if (!curOrigin) {
        for (const [reqId, active] of activeBatchControllers.entries()) {
          if (active.tabId === idNum || active.tabId === tabId) {
            try { active.controller.abort('navigation'); } catch {}
            activeBatchControllers.delete(reqId);
          }
        }
        const queue = tabQueues.get(idNum) || tabQueues.get(tabId);
        if (queue && queue.length > 0) {
          for (const entry of queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'ABORTED',
              'Tab navigated while translation was queued',
              false,
              { reason: 'navigation', tabId: idNum }
            ));
          }
          tabQueues.delete(idNum);
          tabQueues.delete(tabId);
        }
        return;
      }

      // Origin check: abort only controllers and queue entries whose origin does NOT match curOrigin
      for (const [reqId, active] of activeBatchControllers.entries()) {
        if (active.tabId === idNum || active.tabId === tabId) {
          if (!active.origin || active.origin !== curOrigin) {
            try { active.controller.abort('navigation'); } catch {}
            activeBatchControllers.delete(reqId);
          }
        }
      }

      const queue = tabQueues.get(idNum) || tabQueues.get(tabId);
      if (queue && queue.length > 0) {
        const remaining = [];
        for (const entry of queue) {
          if (entry.origin !== curOrigin) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'ABORTED',
              'Tab navigated while translation was queued',
              false,
              { reason: 'navigation', originalOrigin: entry.origin, currentOrigin: curOrigin, tabId: idNum }
            ));
          } else {
            remaining.push(entry);
          }
        }
        if (remaining.length > 0) {
          tabQueues.set(idNum, remaining);
          if (tabId !== idNum) tabQueues.delete(tabId);
        } else {
          tabQueues.delete(idNum);
          tabQueues.delete(tabId);
        }
      }
    }
  } catch {
    // Ignore navigation cleanup error
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated && typeof chrome.tabs.onUpdated.addListener === 'function') {
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
}

/**
 * Unified pre-dispatch / post-semaphore verification.
 * Re-validates config revision, tab epoch, tab existence, origin match,
 * current consent (tab override & site enabled, covering N4 race), and host permission.
 */
async function verifyTabDispatchPolicy({ tabId, origin, epoch, expectedConfigRevision }) {
  if (expectedConfigRevision !== undefined && expectedConfigRevision !== configRevision) {
    return {
      ...createTypedError(
        'ABORTED',
        'Translation batch discarded due to configuration change',
        false,
        { batchConfigRevision: expectedConfigRevision, currentConfigRevision: configRevision }
      ),
      configRevision: expectedConfigRevision,
      currentConfigRevision: configRevision
    };
  }

  if (typeof tabId === 'number') {
    if (epoch !== undefined && tabEpochs.has(tabId)) {
      const curTabEpoch = tabEpochs.get(tabId);
      if (epoch < curTabEpoch) {
        return createTypedError(
          'ABORTED',
          'Pending translation cancelled by new epoch',
          false,
          { reason: 'epoch_changed', tabId, epoch, currentEpoch: curTabEpoch }
        );
      }
      if (epoch > curTabEpoch) {
        tabEpochs.set(tabId, epoch);
      }
    }

    const tabInfo = await resolveTabPolicy(tabId);
    if (!tabInfo) {
      return createTypedError(
        'ABORTED',
        'Tab was closed before dispatch',
        false,
        { reason: 'tab_closed' }
      );
    }

    const curOrigin = tabInfo.url ? normalizeOrigin(tabInfo.url) : null;
    if (!curOrigin) {
      return createTypedError(
        'ABORTED',
        'Tab URL could not be verified before dispatch',
        false,
        { reason: 'tab_url_unverifiable', tabId }
      );
    }

    if (origin && curOrigin !== origin) {
      return createTypedError(
        'ABORTED',
        'Tab navigated before dispatch',
        false,
        { reason: 'navigation', originalOrigin: origin, currentOrigin: curOrigin }
      );
    }

    // Consent check: tab override > site enabled > default OFF (covers N4 race)
    let sites, tabOverrides, settings;
    try {
      sites = await getStoredSites();
      tabOverrides = await getStoredTabOverrides();
      settings = await getStoredSettings();
    } catch (err) {
      return createTypedError('CONSENT_STATE_UNAVAILABLE', 'Consent state unavailable', false, {
        tabId,
        reason: err?.message || 'Storage read error'
      });
    }

    if (!checkDataConsentAccepted(settings)) {
      return createTypedError(
        'DATA_CONSENT_REQUIRED',
        'Data consent is not accepted',
        false,
        { dataConsentVersion: CURRENT_DATA_CONSENT_VERSION }
      );
    }

    const siteEnabled = Boolean(sites[origin || curOrigin]);
    const tabOverride = tabOverrides[String(tabId)] || null;
    const effective = getEffectivePolicy({ tabOverride, siteEnabled });

    if (effective !== 'on') {
      return createTypedError(
        'OPT_IN_REQUIRED',
        'Translation is disabled (tab explicit OFF, site OFF, or default OFF)',
        false,
        {
          tabId,
          origin: origin || curOrigin,
          scope: tabOverride ? 'tab' : 'site',
          effectiveConsent: 'off'
        }
      );
    }

    // Permission check
    const hasPerm = await permissionContains(origin || curOrigin);
    if (!hasPerm) {
      return createTypedError(
        'PERMISSION_REQUIRED',
        'Host permission not granted for site origin',
        false,
        {
          origin: origin || curOrigin,
          permissionType: 'host'
        }
      );
    }
  }

  return { valid: true };
}

// Reconcile dynamic content scripts with active permissions and storage
let _reconcilePromise = null;

async function reconcilePermissions() {
  if (_reconcilePromise) return _reconcilePromise;
  _reconcilePromise = (async () => {
    try {
      await ensureStorageAccess();
      const stored = await chrome.storage.local.get(['sites', 'registrations']);
      const sites = stored.sites || {};
      const registrations = stored.registrations || {};

      let existingScripts = [];
      if (typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.getRegisteredContentScripts === 'function') {
        try {
          existingScripts = await chrome.scripting.getRegisteredContentScripts();
        } catch {
          existingScripts = [];
        }
      }
      const existingScriptIds = existingScripts.map((s) => s.id);

      // Check permissions for all stored sites
      const grantedOrigins = new Set();
      for (const orig of Object.keys(sites)) {
        const norm = normalizeOrigin(orig);
        if (norm && (await permissionContains(norm))) {
          grantedOrigins.add(norm);
        }
      }

      const diff = calculateReconcileDiff({
        sites,
        registrations,
        existingRegisteredScriptIds: existingScriptIds,
        grantedOrigins
      });

      // 1. Unregister stale scripts
      if (diff.toUnregister.length > 0 && typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.unregisterContentScripts === 'function') {
        try {
          await chrome.scripting.unregisterContentScripts({ ids: diff.toUnregister });
        } catch {}
      }

      // 2. Register missing scripts
      if (diff.toRegister.length > 0 && typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.registerContentScripts === 'function') {
        try {
          await chrome.scripting.registerContentScripts(
            diff.toRegister.map((item) => ({
              id: item.scriptId,
              matches: item.matches,
              js: ['i18n-globals.js', 'content.js'],
              runAt: 'document_start',
              allFrames: false,
              persistAcrossSessions: true
            }))
          );
        } catch (err) {
          console.error('Failed to register content scripts during reconcile:', err);
        }
      }

      // 3. Persist updated sites & registrations
      await chrome.storage.local.set({
        sites: diff.updatedSites,
        registrations: diff.updatedRegistrations
      });

      // 4. Abort active translation batches and queue entries for revoked origins
      for (const [reqId, active] of activeBatchControllers.entries()) {
        if (active.origin && !grantedOrigins.has(active.origin)) {
          try { active.controller.abort('permission_revoked'); } catch {}
          activeBatchControllers.delete(reqId);
        }
      }
      for (const [tId, queue] of tabQueues.entries()) {
        const remaining = [];
        for (const entry of queue) {
          if (entry.origin && !grantedOrigins.has(entry.origin)) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'PERMISSION_REQUIRED',
              'Host permission not granted for site origin',
              false,
              { origin: entry.origin, permissionType: 'host' }
            ));
          } else {
            remaining.push(entry);
          }
        }
        if (remaining.length > 0) {
          tabQueues.set(tId, remaining);
        } else {
          tabQueues.delete(tId);
        }
      }

      return { ok: true, diff };
    } finally {
      _reconcilePromise = null;
    }
  })();
  return _reconcilePromise;
}

// Effective per-tab config: per-site overrides win, otherwise globals.
// `model: null` / langs null on the site entry mean "follow global".
function resolveEffectiveSiteConfig(settings, origin) {
  const autoSites = Array.isArray(settings.autoTranslateSites) ? settings.autoTranslateSites : [];
  const raw = autoSites.find((e) => (typeof e === 'string' ? e : e?.origin) === origin);
  const siteConfig = raw ? (normalizePerSiteConfig(raw) || {
    origin,
    mode: 'inherit',
    autoStart: true,
    sourceLanguage: null,
    targetLanguage: null,
    model: null
  }) : null;
  return {
    siteConfig,
    mode: (siteConfig && siteConfig.mode && siteConfig.mode !== 'inherit')
      ? siteConfig.mode
      : (settings.translationMode || 'scroll-follow'),
    sourceLanguage: (siteConfig && siteConfig.sourceLanguage)
      ? siteConfig.sourceLanguage
      : (settings.sourceLanguage || 'auto'),
    targetLanguage: (siteConfig && siteConfig.targetLanguage)
      ? siteConfig.targetLanguage
      : (settings.targetLanguage || 'vi'),
    model: (siteConfig && siteConfig.model)
      ? siteConfig.model
      : (settings.model || DEFAULT_MODEL)
  };
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
  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'WIDGET_STATE_CHANGED', ...state }).catch(() => {});
    } catch {}
  }
}

async function notifyAllWidgetStateChanged(patch) {
  if (typeof chrome === 'undefined' || !chrome || !chrome.tabs || typeof chrome.tabs.query !== 'function') return;
  let payload = { action: 'WIDGET_STATE_CHANGED' };
  if (patch && typeof patch === 'object') {
    payload = { ...payload, ...patch };
  } else {
    try {
      const s = await getStoredSettings({ persistMigration: false });
      payload.fabMascot = s.fabMascot || 'default';
      payload.fabSize = typeof s.fabSize === 'number' ? s.fabSize : 1.0;
      payload.theme = s.theme || 'dark';
      payload.uiLocale = s.uiLocale || 'vi';
      payload.uiFontScale = s.uiFontScale || 'md';
      payload.widgetVisible = s.widgetVisible ?? true;
    } catch {}
  }
  if (typeof chrome === 'undefined' || !chrome || !chrome.tabs || typeof chrome.tabs.query !== 'function') return;
  try {
    const queryResult = chrome.tabs.query({});
    if (queryResult && typeof queryResult.then === 'function') {
      queryResult.then((tabs) => {
        if (typeof chrome === 'undefined' || !chrome?.tabs) return;
        if (Array.isArray(tabs)) {
          for (const tab of tabs) {
            if (tab && typeof tab.id === 'number') {
              try { chrome.tabs.sendMessage(tab.id, payload)?.catch?.(() => {}); } catch {}
            }
          }
        }
      }).catch(() => {});
    } else {
      chrome.tabs.query({}, (tabs) => {
        if (typeof chrome === 'undefined' || !chrome?.tabs) return;
        if (Array.isArray(tabs)) {
          for (const tab of tabs) {
            if (tab && typeof tab.id === 'number') {
              try { chrome.tabs.sendMessage(tab.id, payload)?.catch?.(() => {}); } catch {}
            }
          }
        }
      });
    }
  } catch {}
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

const router = createDirect9Router(routerConfig);

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

export async function executeBatchTranslation({
  payload = {},
  misses = [],
  hits = [],
  batchConfigRevision = configRevision,
  tabId = null,
  epoch = undefined,
  origin = null
}) {
  const forwardProgress = (item) => pushTranslateProgress(tabId, epoch, item);
  const requestId = payload.requestId || ('req_' + Math.random().toString(36).slice(2));
  let controller = null;
  if (typeof tabId === 'number') {
    controller = new AbortController();
    activeBatchControllers.set(requestId, {
      controller,
      tabId,
      revision: batchConfigRevision,
      epoch,
      origin
    });
  }

  const currentSemaphore = providerSemaphore;
  const signal = controller ? controller.signal : payload.signal;

  try {
    await currentSemaphore.acquire(undefined, signal);
  } catch (err) {
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
    if (err?.code === 'TIMEOUT') {
      return createTypedError('TIMEOUT', 'Provider concurrency queue timed out waiting for available slot', false, {
        maxConcurrentRequests: currentSemaphore.getMaxConcurrency()
      });
    }
    if (err?.code === 'ABORTED' || err?.name === 'AbortError') {
      return createTypedError('ABORTED', 'Operation aborted before acquiring provider slot', false, {
        reason: signal?.reason ? String(signal.reason) : 'aborted'
      });
    }
    throw err;
  }

  // After acquiring semaphore: check if already aborted while waiting for permit
  if (signal?.aborted) {
    currentSemaphore.release();
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
    return createTypedError('ABORTED', 'Operation aborted before acquiring provider slot', false, {
      reason: signal.reason ? String(signal.reason) : 'aborted'
    });
  }

  // Pre-dispatch guard: verify configuration revision, tab existence, origin match, consent, and tab epoch
  const guardCheck = await verifyTabDispatchPolicy({
    tabId,
    origin,
    epoch,
    expectedConfigRevision: batchConfigRevision
  });
  if (guardCheck && guardCheck.error) {
    currentSemaphore.release();
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
    return guardCheck;
  }

  const storedSettings = await getStoredSettings();
  const primaryKey = await getStoredApiKey();
  let storedFbKeys = {};
  try {
    const fbKeysRes = await chrome.storage.local.get(['fallback_api_keys']);
    storedFbKeys = fbKeysRes.fallback_api_keys || {};
  } catch {}

  const chain = resolveFallbackChain(
    (payload && typeof payload.model === 'string' && payload.model.trim())
      ? { ...storedSettings, model: payload.model.trim(), fallbackConsumed: Boolean(payload?.fallbackConsumed) }
      : { ...storedSettings, fallbackConsumed: Boolean(payload?.fallbackConsumed) },
    storedFbKeys,
    primaryKey
  );
  const requestedModel = chain[0]?.model || DEFAULT_MODEL;

  let currentMisses = [...misses];
  let currentHits = [...hits];
  let finalProviderRes = null;
  let actualModel = null;
  let actualBaseURL = chain[0]?.baseURL || storedSettings.baseURL || '';
  let fallbackIndex = 0;
  let fallbackConsumed = Boolean(payload?.fallbackConsumed);
  let lastAttemptedModel = requestedModel;
  const newlyTranslatedItems = [];

  try {
    for (let attemptIndex = 0; attemptIndex < chain.length && attemptIndex < 3; attemptIndex++) {
      const currentConfig = chain[attemptIndex];
      const currentModel = currentConfig.model;
      const currentBaseURL = currentConfig.baseURL;
      const currentApiKey = currentConfig.apiKey;
      lastAttemptedModel = currentModel;

      // Re-verify signal and policy guard before each attempt
      if (signal?.aborted) {
        return createTypedError('ABORTED', 'Operation aborted during attempt', false, {
          reason: signal.reason ? String(signal.reason) : 'aborted'
        });
      }
      const guardCheckAttempt = await verifyTabDispatchPolicy({
        tabId,
        origin,
        epoch,
        expectedConfigRevision: batchConfigRevision
      });
      if (guardCheckAttempt && guardCheckAttempt.error) {
        return guardCheckAttempt;
      }

      // Check cache for this specific attempt
      if (attemptIndex > 0) {
        const attemptCache = resolveAttemptCache({
          misses: currentMisses,
          currentHits,
          currentBaseURL,
          currentModel,
          payload,
          storedSettings,
          translationCache,
          PROMPT_VERSION,
          cacheKey,
          normalizeSourceText
        });
        currentMisses = attemptCache.remainingMisses;

        currentMisses = await checkL2CacheForMisses({
          remainingMisses: currentMisses,
          currentHits,
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

        // If all misses hit cache for this fallback model, complete without provider call
        if (currentMisses.length === 0) {
          actualModel = currentModel;
          actualBaseURL = currentBaseURL;
          fallbackIndex = attemptIndex;
          finalProviderRes = { ok: true, results: [] };
          break;
        }
      }

      let attemptRes;
      try {
        attemptRes = await translateBatch({
          ...payload,
          baseURL: currentBaseURL,
          apiKey: currentApiKey,
          model: currentModel,
          items: currentMisses.map((m) => m.item),
          signal,
          onProgress: forwardProgress
        });
      } catch (err) {
        attemptRes = (err && err.error) ? err : createTypedError('NETWORK', err?.message || 'Network error', true);
      }

      if (attemptRes && !attemptRes.error && Array.isArray(attemptRes.results)) {
        actualModel = currentModel;
        actualBaseURL = currentBaseURL;
        fallbackIndex = attemptIndex;
        finalProviderRes = attemptRes;

        // Collect newly translated items; caching is deferred until configRevision & tabEpoch checks pass
        for (let i = 0; i < currentMisses.length; i++) {
          const miss = currentMisses[i];
          const resItem = attemptRes.results.find((r) => r && r.id === miss.item.id);
          if (resItem && typeof resItem.text === 'string') {
            newlyTranslatedItems.push({
              item: miss.item,
              text: resItem.text
            });
          }
        }

        // Add translated items to currentHits
        for (let i = 0; i < currentMisses.length; i++) {
          const miss = currentMisses[i];
          const resItem = attemptRes.results.find((r) => r && r.id === miss.item.id);
          if (resItem && typeof resItem.text === 'string') {
            currentHits.push({
              index: miss.index,
              result: {
                id: miss.item.id,
                revision: miss.item.revision,
                text: resItem.text
              }
            });
          }
        }
        break;
      }

      // Handle attempt failure
      finalProviderRes = attemptRes;
      const plan = resolveFallbackPlan(attemptRes, chain, attemptIndex, { fallbackConsumed });
      if (!plan.shouldFallback) {
        break;
      }

      fallbackConsumed = true;
      if (payload) {
        payload.fallbackConsumed = true;
      }

      // Log entry ghi rõ model đã đổi (dùng message/provider-message hiện có)
      const providerMsg = attemptRes?.error?.details?.providerMessage ||
        attemptRes?.error?.message ||
        'Model fallback';
      const logMessage = `${providerMsg} (model changed: ${currentModel} -> ${plan.nextModel})`;
      await recordErrorLog({
        code: attemptRes?.error?.code || 'MODEL_FALLBACK',
        message: logMessage,
        details: {
          ...(attemptRes?.error?.details || {}),
          fromModel: currentModel,
          toModel: plan.nextModel,
          providerMessage: attemptRes?.error?.details?.providerMessage || undefined,
          fallbackConsumed: true
        }
      }, {
        model: `${currentModel} -> ${plan.nextModel}`,
        tabId,
        isTerminal: false
      });
    }
  } finally {
    currentSemaphore.release();
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
  }

  if (finalProviderRes && finalProviderRes.error) {
    if (fallbackConsumed) {
      finalProviderRes.error.details = {
        ...(finalProviderRes.error.details || {}),
        fallbackConsumed: true
      };
    }
    if (chain.skippedFallbacks && chain.skippedFallbacks.length > 0) {
      finalProviderRes.error.details = {
        ...(finalProviderRes.error.details || {}),
        skippedFallbacks: chain.skippedFallbacks
      };
    }
    const finalModel = lastAttemptedModel || actualModel || requestedModel;
    if (finalProviderRes.error.details) {
      finalProviderRes.error.details.model = finalModel;
      finalProviderRes.error.details.lastAttemptedModel = finalModel;
    }
    await recordErrorLog(finalProviderRes.error, {
      model: finalModel,
      tabId,
      isTerminal: true
    });
    return finalProviderRes;
  }

  // If configuration revision changed while batch was in-flight, do NOT cache and abort
  if (batchConfigRevision !== configRevision) {
    return {
      ...createTypedError(
        'ABORTED',
        'Translation batch discarded due to configuration change',
        false,
        {
          batchConfigRevision,
          currentConfigRevision: configRevision
        }
      ),
      configRevision: batchConfigRevision,
      currentConfigRevision: configRevision
    };
  }

  // If tab epoch changed while batch was in-flight, do NOT cache and abort if older
  if (epoch !== undefined && tabEpochs.has(tabId) && epoch < tabEpochs.get(tabId)) {
    return createTypedError(
      'ABORTED',
      'Translation batch discarded due to epoch change',
      false,
      { reason: 'epoch_changed' }
    );
  }

  // Populate cache strictly under actualModel and actualBaseURL only after config & epoch checks pass
  commitTranslatedCache({
    newlyTranslatedItems,
    actualBaseURL,
    actualModel,
    payload,
    storedSettings,
    PROMPT_VERSION,
    cacheKey,
    normalizeSourceText,
    translationCache,
    enqueueL2Cache,
    isL2MemoryOnly
  });

  const missingIds = Array.isArray(finalProviderRes?.missingIds) ? finalProviderRes.missingIds : [];

  if (missingIds.length > 0) {
    try {
      await recordErrorLog({
        code: 'PARTIAL_BATCH',
        message: `Batch partially completed: ${missingIds.length} item(s) missing`,
        details: { missingIds }
      }, {
        model: actualModel || lastAttemptedModel,
        tabId,
        isTerminal: false
      });
    } catch {}
  }

  const batchOutcome = await mergeBatchResults({
    hits,
    misses,
    currentHits,
    finalProviderRes,
    payload,
    requestedModel,
    actualModel,
    currentModel: lastAttemptedModel,
    fallbackIndex,
    actualBaseURL,
    batchConfigRevision,
    currentConfigRevision: configRevision,
    tabId,
    extractHost
  });

  return {
    ...batchOutcome,
    partial: Boolean(finalProviderRes?.partial || missingIds.length > 0),
    missingIds,
    failed: missingIds.length
  };
}

// Startup hooks
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled?.addListener(() => {
    ensureStorageAccess()
      .then(() => reconcilePermissions())
      .catch(() => {});
  });

  chrome.runtime.onStartup?.addListener(() => {
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

// Serialize read-modify-write settings patches so concurrent popup actions
// cannot overwrite fields they did not change.
let settingsWriteQueue = Promise.resolve();

function serializeSettingsWrite(operation) {
  const result = settingsWriteQueue.then(operation, operation);
  settingsWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

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
        const scriptId = originToScriptId(normOrigin);

        if (message.enabled) {
          // Verify host permission
          const hasPerm = await permissionContains(normOrigin);
          if (!hasPerm) {
            return createTypedError('PERMISSION_REQUIRED', 'Host permission not granted for origin', false, {
              origin: normOrigin,
              permissionType: 'host'
            });
          }

          // Register content script dynamically
          if (typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.registerContentScripts === 'function') {
            try {
              await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
            } catch {}
            try {
              await chrome.scripting.registerContentScripts([{
                id: scriptId,
                matches: [originToMatchPattern(normOrigin)],
                js: ['i18n-globals.js', 'content.js'],
                runAt: 'document_start',
                allFrames: false,
                persistAcrossSessions: true
              }]);
            } catch (err) {
              console.error('Failed to register content script:', err);
              await reconcilePermissions();
              return createTypedError('PERMISSION_REQUIRED', 'Failed to register dynamic content script: ' + (err?.message || String(err)), false, {
                origin: normOrigin,
                permissionType: 'host',
                reason: err?.message || String(err)
              });
            }
          }

          // Inject into active tab once if tabId is provided
          if (typeof message.tabId === 'number' && typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: message.tabId, frameIds: [0] },
                files: ['i18n-globals.js', 'content.js']
              });
            } catch {}
          }

          const res = await chrome.storage.local.get(['sites', 'registrations']);
          const sites = res.sites || {};
          const registrations = res.registrations || {};
          sites[normOrigin] = { createdAt: Date.now() };
          registrations[normOrigin] = scriptId;
          await chrome.storage.local.set({ sites, registrations });
        } else {
          // Unregister content script dynamically
          if (typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.unregisterContentScripts === 'function') {
            try {
              await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
            } catch {}
          }
          const res = await chrome.storage.local.get(['sites', 'registrations']);
          const sites = res.sites || {};
          const registrations = res.registrations || {};
          delete sites[normOrigin];
          delete registrations[normOrigin];
          await chrome.storage.local.set({ sites, registrations });

          // Abort active translation batches and purge queue entries for this origin
          for (const [reqId, active] of activeBatchControllers.entries()) {
            if (active.origin === normOrigin) {
              try { active.controller.abort('site_disabled'); } catch {}
              activeBatchControllers.delete(reqId);
            }
          }
          for (const [tId, queue] of tabQueues.entries()) {
            const remaining = [];
            for (const entry of queue) {
              if (entry.origin === normOrigin) {
                if (entry.timer) clearTimeout(entry.timer);
                entry.resolve(createTypedError(
                  'OPT_IN_REQUIRED',
                  'Translation is disabled for site',
                  false,
                  { origin: normOrigin, effectiveConsent: 'off' }
                ));
              } else {
                remaining.push(entry);
              }
            }
            if (remaining.length > 0) {
              tabQueues.set(tId, remaining);
            } else {
              tabQueues.delete(tId);
            }
          }
        }
        notifyAllWidgetStateChanged();
        return { ok: true };
      }

      case 'ENSURE_CONTENT': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'ENSURE_CONTENT is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const tabId = message.tabId;
        if (typeof tabId !== 'number') {
          return createTypedError('PERMISSION_REQUIRED', 'Valid tabId required for ENSURE_CONTENT', false, {
            permissionType: 'host'
          });
        }

        // TEST-ONLY: harness tabs use simulated ids that chrome.tabs cannot
        // resolve; bypass the scripting check while keeping sender + tabId validation.
        if (_testMode && _testEnsureContentOk === true) {
          return { ok: true, testBypass: true };
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
          return createTypedError('SITE_NOT_ALLOWED', 'Current site origin is not valid HTTP(S)', false, {
            origin: tab?.url || '',
            tabId
          });
        }

        await ensureStorageAccess();
        let sites, tabOverrides;
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

        let effective;
        try {
          effective = getEffectivePolicy({ tabOverride, siteEnabled });
        } catch (err) {
          return createTypedError('CONSENT_STATE_UNAVAILABLE', 'Consent state unavailable', false, {
            tabId,
            reason: err && err.message ? String(err.message) : 'Policy evaluation error'
          });
        }

        if (effective !== 'on') {
          return createTypedError('OPT_IN_REQUIRED', 'Translation is disabled (tab explicit OFF, site OFF, or default OFF)', false, {
            tabId,
            origin: siteOrigin,
            scope: tabOverride ? 'tab' : 'site',
            effectiveConsent: 'off'
          });
        }

        // Permission check
        const hasPerm = await permissionContains(siteOrigin);
        if (!hasPerm) {
          return createTypedError('PERMISSION_REQUIRED', 'Host permission not granted for site origin', false, {
            origin: siteOrigin,
            permissionType: 'host'
          });
        }

        // Inject content scripts once (content self-guards window.__webMcpTranslatorInjected)
        if (typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
          try {
            await chrome.scripting.executeScript({
              target: { tabId, frameIds: [0] },
              files: ['i18n-globals.js', 'content.js']
            });
          } catch (err) {
            return createTypedError('PERMISSION_REQUIRED', 'Failed to execute content script on tab', false, {
              origin: siteOrigin,
              tabId,
              reason: err && err.message ? String(err.message) : 'executeScript error'
            });
          }
        }

        return { ok: true };
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
        const tabInfo = await resolveTabPolicy(tabId);
        if (!tabInfo) {
          return createTypedError('INVALID_SCHEMA', `Tab ${tabId} does not exist`, false, {
            tabId,
            reason: 'Tab not found'
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

        if (val === 'off') {
          for (const [reqId, active] of activeBatchControllers.entries()) {
            if (active.tabId === tabId) {
              try { active.controller.abort('tab_disabled'); } catch {}
              activeBatchControllers.delete(reqId);
            }
          }
          const queue = tabQueues.get(tabId);
          if (queue && queue.length > 0) {
            for (const entry of queue) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'OPT_IN_REQUIRED',
                'Translation disabled by tab override',
                false,
                { tabId, effectiveConsent: 'off' }
              ));
            }
            tabQueues.delete(tabId);
          }
        }

        notifyAllWidgetStateChanged();
        return { ok: true };
      }

      case 'CANCEL_PENDING': {
        const tabId = (sender && sender.tab && typeof sender.tab.id === 'number')
          ? sender.tab.id
          : (typeof message.tabId === 'number' ? message.tabId : null);

        if (!tabId) {
          return { ok: true, cancelled: 0 };
        }

        const curEpoch = tabEpochs.get(tabId) || 0;
        const nextEpoch = typeof message.epoch === 'number' ? Math.max(curEpoch, message.epoch) : (curEpoch + 1);
        tabEpochs.set(tabId, nextEpoch);

        for (const [reqId, active] of activeBatchControllers.entries()) {
          if (active.tabId === tabId) {
            if (typeof message.epoch !== 'number' || active.epoch === undefined || active.epoch < nextEpoch) {
              try { active.controller.abort('cancel_pending'); } catch {}
              activeBatchControllers.delete(reqId);
            }
          }
        }

        const queue = tabQueues.get(tabId);
        let cancelledCount = 0;
        if (queue && queue.length > 0) {
          const remaining = [];
          for (const entry of queue) {
            if (typeof message.epoch !== 'number' || entry.epoch === undefined || entry.epoch < nextEpoch) {
              cancelledCount++;
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'ABORTED',
                'Pending translation cancelled by new epoch',
                false,
                { reason: 'Pending translation cancelled by new epoch' }
              ));
            } else {
              remaining.push(entry);
            }
          }
          if (remaining.length > 0) {
            tabQueues.set(tabId, remaining);
          } else {
            tabQueues.delete(tabId);
          }
        }
        // Navigation unload (pagehide): the document is gone, so its epoch is
        // meaningless — drop it so the next document seeds fresh (G2-H1).
        if (message && message.reason === 'pagehide') {
          tabEpochs.delete(tabId);
        }
        return { ok: true, cancelled: cancelledCount };
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
        const gate = verifyWidgetSender(sender);
        if (!gate.ok) return gate.error;

        await ensureStorageAccess();
        const sites = await getStoredSites();
        const tabOverrides = await getStoredTabOverrides();
        const settings = await getStoredSettings();
        const hasKey = Boolean(await getStoredApiKey());
        const hasPerm = await permissionContains(gate.origin);

        const posRes = await chrome.storage.local.get(['widgetPositions']);
        const widgetPositions = posRes.widgetPositions || {};
        const position = widgetPositions[gate.origin] || null;

        const siteEnabled = Boolean(sites[gate.origin]);
        const tabOverride = tabOverrides[String(gate.tabId)] || null;
        const effective = getEffectivePolicy({ tabOverride, siteEnabled });

        const { siteConfig } = resolveEffectiveSiteConfig(settings, gate.origin);

        const consentAccepted = checkDataConsentAccepted(settings);

        const urlMatchesSender = !sender.url || !sender.tab?.url || (normalizeOrigin(sender.url) === normalizeOrigin(sender.tab.url));

        let autoStart = false;
        let reason;

        if (!consentAccepted) {
          reason = 'consent_required';
        } else if (!siteConfig) {
          reason = 'not_in_list';
        } else if (siteConfig.autoStart === false) {
          reason = 'auto_off';
        } else if (tabOverride === 'off') {
          reason = 'tab_off';
        } else if (effective !== 'on') {
          reason = 'site_off';
        } else if (!hasPerm) {
          reason = 'no_permission';
        } else if (!hasKey) {
          reason = 'no_key';
        } else if (urlMatchesSender) {
          autoStart = true;
        } else {
          reason = 'not_in_list';
        }

        const eff = resolveEffectiveSiteConfig(settings, gate.origin);

        const primaryModel = settings.model || DEFAULT_MODEL;
        const fallbackList = Array.isArray(settings.fallbacks) ? settings.fallbacks : [];
        let widgetModels = [primaryModel];
        for (const fb of fallbackList) {
          const m = (fb && typeof fb.model === 'string') ? fb.model.trim() : '';
          if (m && !widgetModels.includes(m) && widgetModels.length < 3) {
            widgetModels.push(m);
          }
        }

        let favoritesHint = null;
        if (settings.showFavoritesOnly) {
          const scopeKey = normalizeBaseURLKey(settings.baseURL || 'http://localhost:8080/v1');
          const favMap = (settings.favoriteModelsByBaseURL && typeof settings.favoriteModelsByBaseURL === 'object') ? settings.favoriteModelsByBaseURL : {};
          const scopedFavs = Array.isArray(favMap[scopeKey]) ? favMap[scopeKey].filter(Boolean) : [];
          if (scopedFavs.length > 0) {
            widgetModels = scopedFavs;
          } else {
            favoritesHint = 'no_favorites_show_all';
          }
        }

        return {
          effective,
          siteEnabled,
          tabOverride,
          permission: hasPerm,
          mode: eff.mode,
          sourceLanguage: eff.sourceLanguage,
          targetLanguage: eff.targetLanguage,
          model: eff.model,
          availableModels: widgetModels,
          showFavoritesOnly: Boolean(settings.showFavoritesOnly),
          favoritesHint,
          dataConsentAccepted: consentAccepted,
          widgetVisible: settings.widgetVisible ?? true,
          uiLocale: settings.uiLocale || 'vi',
          theme: settings.theme || 'dark',
          uiFontScale: settings.uiFontScale || 'md',
          fabSize: typeof settings.fabSize === 'number' ? settings.fabSize : 1,
          fabMascot: settings.fabMascot || 'default',
          position,
          hasKey,
          autoStart,
          siteConfig: siteConfig ? { ...siteConfig } : null,
          ...(reason ? { reason } : {})
        };
      }

      case 'WIDGET_SET_ENABLED': {
        const gate = verifyWidgetSender(sender);
        if (!gate.ok) return gate.error;

        await ensureStorageAccess();
        const sites = await getStoredSites();
        const tabOverrides = await getStoredTabOverrides();
        const siteEnabled = Boolean(sites[gate.origin]);

        if (message.enabled) {
          const hasPerm = await permissionContains(gate.origin);
          if (!hasPerm) {
            return createTypedError(
              'PERMISSION_REQUIRED',
              'Host permission required to enable translation. Please open popup to grant permission.',
              false,
              { origin: gate.origin, permissionType: 'host' }
            );
          }
          tabOverrides[String(gate.tabId)] = 'on';
        } else {
          tabOverrides[String(gate.tabId)] = 'off';
          // Abort active batches and purge queue for this tab
          for (const [reqId, active] of activeBatchControllers.entries()) {
            if (active.tabId === gate.tabId) {
              try { active.controller.abort('tab_disabled'); } catch {}
              activeBatchControllers.delete(reqId);
            }
          }
          const queue = tabQueues.get(gate.tabId);
          if (queue && queue.length > 0) {
            for (const entry of queue) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'OPT_IN_REQUIRED',
                'Translation disabled by tab override',
                false,
                { tabId: gate.tabId, effectiveConsent: 'off' }
              ));
            }
            tabQueues.delete(gate.tabId);
          }
        }

        await chrome.storage.session.set({ tab_overrides: tabOverrides });

        const tabOverride = tabOverrides[String(gate.tabId)] || null;
        const effective = getEffectivePolicy({ tabOverride, siteEnabled });
        const settings = await getStoredSettings();
        const hasKey = Boolean(await getStoredApiKey());
        const hasPerm = await permissionContains(gate.origin);
        const posRes = await chrome.storage.local.get(['widgetPositions']);
        const widgetPositions = posRes.widgetPositions || {};

        const eff = resolveEffectiveSiteConfig(settings, gate.origin);
        const state = {
          effective,
          siteEnabled,
          tabOverride,
          permission: hasPerm,
          mode: eff.mode,
          sourceLanguage: eff.sourceLanguage,
          targetLanguage: eff.targetLanguage,
          model: eff.model,
          widgetVisible: settings.widgetVisible ?? true,
          position: widgetPositions[gate.origin] || null,
          hasKey,
          uiLocale: settings.uiLocale || 'vi',
          theme: settings.theme || 'dark',
          uiFontScale: settings.uiFontScale || 'md',
          fabSize: typeof settings.fabSize === 'number' ? settings.fabSize : 1,
          fabMascot: settings.fabMascot || 'default'
        };

        pushWidgetStateChanged(gate.tabId, state);
        return state;
      }

      case 'WIDGET_SET_MODE': {
        const gate = verifyWidgetSender(sender);
        if (!gate.ok) return gate.error;

        const mode = message.mode;
        if (mode !== 'scroll-follow' && mode !== 'full') {
          return createTypedError('INVALID_SCHEMA', 'Invalid mode. Must be scroll-follow or full', false);
        }
        const newModel = (typeof message.model === 'string' && message.model.trim())
          ? message.model.trim()
          : null;

        return await serializeSettingsWrite(async () => {
          await ensureStorageAccess();
          const oldSettings = await getStoredSettings({ persistMigration: false });
          const modeChanged = oldSettings.translationMode !== mode;
          const modelChanged = Boolean(newModel && oldSettings.model !== newModel);

          if (modeChanged || modelChanged) {
            configRevision++;
            translationCache.clear();
            clearPendingL2Writes();
            for (const [reqId, active] of activeBatchControllers.entries()) {
              try { active.controller.abort('config_changed'); } catch {}
            }
            activeBatchControllers.clear();
            for (const [tabId, queue] of tabQueues.entries()) {
              for (const entry of queue) {
                if (entry.timer) clearTimeout(entry.timer);
                entry.resolve(createTypedError(
                  'ABORTED',
                  'Translation request aborted due to configuration change',
                  false,
                  { reason: 'Config changed' }
                ));
              }
            }
            tabQueues.clear();

            const nextSettings = { ...oldSettings, translationMode: mode };
            if (modelChanged) {
              nextSettings.model = newModel;
            }
            const merged = migrateSettings(nextSettings);
            await chrome.storage.local.set({ settings: merged });
            notifyAllWidgetStateChanged();
          }

          return { ok: true, mode, ...(newModel ? { model: newModel } : {}) };
        });
      }

      case 'WIDGET_SET_POSITION': {
        const gate = verifyWidgetSender(sender);
        if (!gate.ok) return gate.error;

        const x = typeof message.x === 'number' ? Math.max(0, Math.round(message.x)) : 0;
        const y = typeof message.y === 'number' ? Math.max(0, Math.round(message.y)) : 0;

        await ensureStorageAccess();
        const posRes = await chrome.storage.local.get(['widgetPositions']);
        const widgetPositions = posRes.widgetPositions || {};
        widgetPositions[gate.origin] = { x, y };
        await chrome.storage.local.set({ widgetPositions });

        return { ok: true, position: { x, y } };
      }

      case 'GET_ERROR_LOG': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'GET_ERROR_LOG is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        return { ok: true, entries: [...errorLog] };
      }

      case 'CLEAR_ERROR_LOG': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'CLEAR_ERROR_LOG is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        errorLog = [];
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            await chrome.storage.session.remove(['errorLog']);
          }
        } catch {}
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
  getErrorLog: () => [...errorLog],
  clearErrorLog: async () => {
    errorLog = [];
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        await chrome.storage.session.remove(['errorLog']);
      }
    } catch {}
  },
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
