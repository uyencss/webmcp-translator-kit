// WebMCP Translator Kit — Background Service Worker (Direct Mode)
// Contract Version: webmcp-translator-contract/1

import { createDirect9Router } from './adapter/direct9router.mjs';
import {
  getEffectivePolicy,
  normalizeOrigin,
  isValidOrigin,
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

const MODEL_CACHE_FRESH_MS = 24 * 60 * 60 * 1000; // 24 hours
const MODEL_CACHE_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let configRevision = 1;
let _revalidateModelsPromise = null;

// Ephemeral In-Memory Cache: destroyed upon SW restart per contract/lifecycle.md §3.3
const translationCache = createTranslationCache({
  ttlMs: 600000,
  maxEntries: 500,
  maxSizeBytes: 2097152
});

// L2 Persistent Cache (chrome.storage.local key 'trCache')
let pendingL2Writes = new Map();
let l2WriteTimer = null;
let l2Epoch = 0;
let isClearingL2 = false;
let clearingL2Count = 0;
let l2MemoryOnly = false;

// L2 Storage Mutex: serializes clearL2Cache and flushL2Cache to prevent race conditions
let l2StorageChain = Promise.resolve();

function runInL2StorageChain(fn) {
  const next = l2StorageChain.then(fn, fn);
  l2StorageChain = next.catch(() => {});
  return next;
}

export function getL2Epoch() {
  return l2Epoch;
}

export function isL2MemoryOnly() {
  return l2MemoryOnly;
}

export function _setL2MemoryOnlyForTest(val) {
  l2MemoryOnly = Boolean(val);
}

export function isL2Clearing() {
  return isClearingL2;
}

export function enqueueL2Cache(key, text) {
  if (!key || typeof text !== 'string') return;
  if (isClearingL2 || l2MemoryOnly) return;
  const l2Key = /^[0-9a-f]{8}$/i.test(key) ? key : hashText(key);
  const entryEpoch = l2Epoch;
  pendingL2Writes.set(l2Key, { keyHash: hashText(key), text, savedAt: Date.now(), epoch: entryEpoch });
  if (l2WriteTimer) clearTimeout(l2WriteTimer);
  l2WriteTimer = setTimeout(() => {
    flushL2Cache().catch(() => {});
  }, 2000);
}

export async function clearL2Cache() {
  l2Epoch++;
  if (l2WriteTimer) {
    clearTimeout(l2WriteTimer);
    l2WriteTimer = null;
  }
  pendingL2Writes.clear();
  clearingL2Count++;
  isClearingL2 = true;

  return runInL2StorageChain(async () => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        l2MemoryOnly = false;
        return;
      }

      let removeSucceeded = false;
      // Attempt 1: remove
      try {
        await chrome.storage.local.remove([L2_CACHE_KEY]);
        removeSucceeded = true;
      } catch (e1) {
        // Retry 1 lần
        try {
          await chrome.storage.local.remove([L2_CACHE_KEY]);
          removeSucceeded = true;
        } catch (e2) {
          removeSucceeded = false;
        }
      }

      if (removeSucceeded) {
        l2MemoryOnly = false;
        return;
      }

      // Vẫn fail → set trCache = {} thay vì remove, đọc-verify lại
      try {
        await chrome.storage.local.set({ [L2_CACHE_KEY]: {} });
        const verify = await chrome.storage.local.get([L2_CACHE_KEY]);
        const cacheObj = verify?.[L2_CACHE_KEY];
        const isClean = !cacheObj || (typeof cacheObj === 'object' && Object.keys(cacheObj).length === 0);
        if (isClean) {
          l2MemoryOnly = false;
        } else {
          l2MemoryOnly = true;
        }
      } catch (setErr) {
        l2MemoryOnly = true;
      }
    } catch (outerErr) {
      l2MemoryOnly = true;
    } finally {
      clearingL2Count = Math.max(0, clearingL2Count - 1);
      if (clearingL2Count === 0) {
        isClearingL2 = false;
      }
      pendingL2Writes.clear();
      if (l2WriteTimer) {
        clearTimeout(l2WriteTimer);
        l2WriteTimer = null;
      }
    }
  });
}

export async function flushL2Cache() {
  if (l2MemoryOnly || isClearingL2) return;
  const currentEpoch = l2Epoch;
  if (l2WriteTimer) {
    clearTimeout(l2WriteTimer);
    l2WriteTimer = null;
  }
  if (pendingL2Writes.size === 0) return;
  const toWrite = new Map(pendingL2Writes);
  pendingL2Writes.clear();

  return runInL2StorageChain(async () => {
    if (l2Epoch !== currentEpoch || l2MemoryOnly || isClearingL2) return;
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      const res = await chrome.storage.local.get([L2_CACHE_KEY]);
      if (l2Epoch !== currentEpoch || l2MemoryOnly || isClearingL2) return;
      const rawCache = (res && res[L2_CACHE_KEY] && typeof res[L2_CACHE_KEY] === 'object')
        ? res[L2_CACHE_KEY]
        : {};
      const trCache = {};
      for (const [k, v] of Object.entries(rawCache)) {
        if (v && typeof v === 'object' && typeof v.keyHash === 'string' && !('key' in v)) {
          trCache[k] = {
            keyHash: v.keyHash,
            text: v.text,
            savedAt: v.savedAt
          };
        }
      }
      for (const [k, v] of toWrite.entries()) {
        if (v && (v.epoch === undefined || v.epoch === currentEpoch)) {
          trCache[k] = {
            keyHash: v.keyHash,
            text: v.text,
            savedAt: v.savedAt
          };
        }
      }
      pruneL2Cache(trCache, 0, { ttlMs: L2_CACHE_TTL_MS, maxSizeBytes: L2_MAX_SIZE_BYTES });
      if (l2Epoch !== currentEpoch || l2MemoryOnly || isClearingL2) return;
      await chrome.storage.local.set({ [L2_CACHE_KEY]: trCache });
    } catch (e) {
      // Quota or storage write failures ignored silently per WI-15 spec
    }
  });
}

export const MAX_ERROR_LOG_ENTRIES = 50;
let errorLog = [];

export async function initErrorLog() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      const res = await chrome.storage.session.get(['errorLog']);
      if (Array.isArray(res?.errorLog)) {
        errorLog = res.errorLog.slice(0, MAX_ERROR_LOG_ENTRIES);
      }
    }
  } catch {}
}
initErrorLog().catch(() => {});

export async function getErrorLog() {
  return [...errorLog];
}

export async function clearErrorLog() {
  errorLog = [];
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      await chrome.storage.session.remove(['errorLog']);
    }
  } catch {}
  return { ok: true };
}

export async function recordErrorLog(err, { model = '', tabId = null, isTerminal = false } = {}) {
  if (!err) return null;
  const entry = {
    time: new Date().toISOString(),
    code: err.code || err.name || 'ERROR',
    message: err.message || (typeof err === 'string' ? err : 'Unknown error'),
    model: model || err.model || '',
    tabId: tabId ?? null
  };
  errorLog.unshift(entry);
  if (errorLog.length > MAX_ERROR_LOG_ENTRIES) {
    errorLog = errorLog.slice(0, MAX_ERROR_LOG_ENTRIES);
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      await chrome.storage.session.set({ errorLog });
    }
  } catch {}

  if (isTerminal) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'TRANSLATE_TERMINAL_ERROR',
          error: entry,
          tabId
        }).catch(() => {});
      }
    } catch {}
  }
  return entry;
}

export function reconcileWatchdog(state = {}) {
  const {
    queue = [],
    queueLength = Array.isArray(queue) ? queue.length : (typeof queue === 'number' ? queue : 0),
    inFlight = 0,
    watching = false,
    collected = 0,
    applied = 0,
    failed = 0,
    runToken = 0,
    rounds = 0,
    lastApplied = 0
  } = state;

  // khi queue rỗng + hết in-flight + watching mà còn items collected-chưa-applied (ngoài failed đã chốt)
  if (queueLength > 0 || inFlight > 0 || !watching) {
    return {
      action: 'none',
      shouldRequeue: false,
      stable: false,
      rounds,
      failed,
      applied,
      collected,
      runToken
    };
  }

  const unapplied = Math.max(0, collected - applied - failed);

  if (unapplied === 0) {
    return {
      action: 'stable',
      shouldRequeue: false,
      stable: true,
      rounds,
      failed,
      applied,
      collected,
      runToken,
      unappliedRemainder: 0
    };
  }

  // Không vòng lặp vô hạn: đếm vòng/run-token, dừng khi không tiến triển (applied không tăng giữa 2 vòng).
  // Tối đa 2 vòng/run:
  if (rounds >= 2 || (rounds > 0 && applied <= lastApplied)) {
    // Dừng: số dư cuối vào footer failed-count + Log entry + nút Thử lại hiện có
    const finalFailed = failed + unapplied;
    return {
      action: 'finalize',
      shouldRequeue: false,
      stable: true,
      rounds,
      failed: finalFailed,
      applied,
      collected,
      runToken,
      unappliedRemainder: unapplied,
      logEntry: {
        code: 'WATCHDOG_UNAPPLIED',
        message: `Watchdog reconciliation: ${unapplied} item(s) unapplied after retry`,
        details: { unappliedRemainder: unapplied, finalFailed }
      },
      stoppedReason: rounds >= 2 ? 'max_rounds' : 'no_progress'
    };
  }

  // Tự re-queue 1 vòng (tối đa 2 vòng/run, backoff)
  const nextRound = rounds + 1;
  const backoffMs = nextRound * 500;
  return {
    action: 'requeue',
    shouldRequeue: true,
    stable: false,
    rounds: nextRound,
    lastApplied: applied,
    backoffMs,
    unappliedCount: unapplied,
    failed,
    applied,
    collected,
    runToken
  };
}

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
export const STOP_ERROR_CODES = Object.freeze([
  'HTTP_401',
  'HTTP_403',
  'HTTP_404',
  'HTTP_429',
  'MISSING_CONFIG',
  'MODEL_NOT_ALLOWED',
  'PERMISSION_REQUIRED',
  'OPT_IN_REQUIRED',
  'SITE_NOT_ALLOWED',
  'RATE_LIMITED',
  'RATE_STATE_UNAVAILABLE',
  'CAP_EXCEEDED',
  'INVALID_SCHEMA',
  'ABORTED',
  'DROPPED_ON_RESTART'
]);

export const FALLBACK_ELIGIBLE_CODES = Object.freeze([
  'NETWORK',
  'TIMEOUT',
  'HTTP_5xx'
]);

/**
 * Pure helper function to determine if a failed attempt should fall back to next model.
 *
 * @param {any} err - The error envelope { error: { code } } or Error with code property
 * @param {string[]} chain - Array of models to try [primary, ...fallbacks] (max 3)
 * @param {number} attemptIndex - 0-based index of current attempt
 * @returns {{ shouldFallback: boolean, nextIndex?: number, nextModel?: string, reason?: string, terminalError?: any }}
 */
export function resolveFallbackPlan(err, chain, attemptIndex = 0, options = {}) {
  if (!err) {
    return { shouldFallback: false, reason: 'NO_ERROR' };
  }

  const code = (typeof err === 'object' && err !== null)
    ? (err.error?.code || err.code || '')
    : '';

  const details = (typeof err === 'object' && err !== null)
    ? (err.error?.details || err.details || {})
    : {};

  const rawHead = details?.rawHead || '';
  const isErrJson = Boolean(details?.isErrorJson) || (
    typeof rawHead === 'string' &&
    /["']?error["']?\s*:/i.test(rawHead) &&
    !(/["']?results["']?\s*:/i.test(rawHead) || /["']results["']/i.test(rawHead) || /\{\s*["']?id["']?/i.test(rawHead))
  );

  const isExhaustedZeroItem = code === 'INVALID_SCHEMA' &&
    !isErrJson &&
    Boolean(details?.exhausted || err?.exhausted || err?.error?.exhausted);

  // INVALID_SCHEMA giữ nguyên là STOP cho mọi case khác.
  // Ngoại lệ DUY NHẤT: zero-item/truncated-zero đã cạn bisect + watchdog
  // (adapter đánh dấu exhausted: true trong error details, KHÔNG đánh cho các INVALID_SCHEMA khác)
  // → được leo fallback đúng 1 lần sang model kế tiếp trong chain [primary, ...fallbacks].
  if (STOP_ERROR_CODES.includes(code)) {
    if (!isExhaustedZeroItem) {
      return {
        shouldFallback: false,
        reason: 'STOP_LIST',
        terminalError: err,
        attemptIndex
      };
    }
  }

  if (!FALLBACK_ELIGIBLE_CODES.includes(code) && !isExhaustedZeroItem) {
    return {
      shouldFallback: false,
      reason: 'NOT_ELIGIBLE',
      terminalError: err,
      attemptIndex
    };
  }

  // Fallback chain rỗng → behavior cũ (terminal ngay)
  if (!Array.isArray(chain) || chain.length <= 1) {
    return {
      shouldFallback: false,
      reason: 'NO_FALLBACK_MODELS',
      terminalError: err,
      attemptIndex
    };
  }

  // Chống loop: batch origin đã leo fallback thì gắn fallbackConsumed: true;
  // model fallback mà vẫn zero-item → terminal error (không ping-pong về primary, không leo tiếp vòng 2).
  if (options?.fallbackConsumed || details.fallbackConsumed || (isExhaustedZeroItem && attemptIndex > 0)) {
    return {
      shouldFallback: false,
      reason: 'FALLBACK_CONSUMED',
      terminalError: err,
      attemptIndex
    };
  }

  const nextIndex = attemptIndex + 1;
  if (nextIndex >= chain.length || nextIndex >= 3) {
    return {
      shouldFallback: false,
      reason: 'CHAIN_EXHAUSTED',
      terminalError: err,
      attemptIndex
    };
  }

  const nextItem = chain[nextIndex];
  const nextModel = typeof nextItem === 'string'
    ? nextItem.trim()
    : (nextItem && typeof nextItem.model === 'string' ? nextItem.model.trim() : '');

  if (!nextModel) {
    return {
      shouldFallback: false,
      reason: 'INVALID_NEXT_MODEL',
      terminalError: err,
      attemptIndex
    };
  }

  return {
    shouldFallback: true,
    nextIndex,
    nextModel,
    nextConfig: typeof nextItem === 'object' ? nextItem : undefined
  };
}

// Extract hostname/host (no protocol, no key, no path)
export function extractHost(urlStr) {
  try {
    return new URL(urlStr).host;
  } catch {
    return '';
  }
}

// Pure helper to resolve the full provider chain with inheritance rules
export function resolveFallbackChain(settings = {}, fallbackApiKeys = {}, primaryKey = '') {
  const primaryModel = settings.model || DEFAULT_MODEL;
  const configuredFallbacks = Array.isArray(settings.fallbacks) ? settings.fallbacks : [];
  const match = settings.fallbackConsumed && configuredFallbacks.find((fb) => fb && fb.model && fb.model.trim() === primaryModel);
  let primaryBaseURL = settings.baseURL || '';
  let primaryApiKey = primaryKey || '';
  if (match) {
    const fbId = typeof match.id === 'string' && match.id.trim() ? match.id.trim() : 'fb1';
    if (match.baseURL && typeof match.baseURL === 'string') primaryBaseURL = match.baseURL.trim();
    if (fbId && fallbackApiKeys && fallbackApiKeys[fbId]) {
      primaryApiKey = fallbackApiKeys[fbId];
    }
  }
  const primaryConfig = {
    id: 'primary',
    baseURL: primaryBaseURL,
    apiKey: primaryApiKey,
    model: primaryModel
  };

  const primaryOrigin = primaryConfig.baseURL ? normalizeOrigin(primaryConfig.baseURL) : null;
  const fallbackConfigs = [];
  const skippedFallbacks = [];

  for (const fb of configuredFallbacks) {
    if (fb && typeof fb === 'object' && fb.model) {
      const fbId = typeof fb.id === 'string' && fb.id.trim() ? fb.id.trim() : 'fb1';
      const fbBaseURL = (typeof fb.baseURL === 'string' && fb.baseURL.trim()) ? fb.baseURL.trim() : primaryConfig.baseURL;
      const fbOrigin = fbBaseURL ? normalizeOrigin(fbBaseURL) : primaryOrigin;
      const hasDedicatedKey = Boolean(fbId && fallbackApiKeys && fallbackApiKeys[fbId]);

      if (hasDedicatedKey) {
        fallbackConfigs.push({
          id: fbId,
          baseURL: fbBaseURL,
          apiKey: fallbackApiKeys[fbId],
          model: fb.model.trim()
        });
      } else if (fbOrigin && primaryOrigin && fbOrigin === primaryOrigin) {
        fallbackConfigs.push({
          id: fbId,
          baseURL: fbBaseURL,
          apiKey: primaryKey || '',
          model: fb.model.trim()
        });
      } else {
        skippedFallbacks.push({
          id: fbId,
          reason: 'missing_key_for_origin'
        });
      }
    }
  }

  const chain = [primaryConfig, ...fallbackConfigs].slice(0, 3);
  chain.skippedFallbacks = skippedFallbacks;
  return chain;
}

// Utility to compare arrays of strings
function arraysEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Deep comparison for fallbacks array to detect config changes
export function fallbacksEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i] || {};
    const itemB = b[i] || {};
    if (itemA.id !== itemB.id) return false;
    if ((itemA.baseURL || '') !== (itemB.baseURL || '')) return false;
    if (itemA.model !== itemB.model) return false;
  }
  return true;
}

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

export function _setTranslateBatchForTest(fn) {
  _testTranslateBatch = fn;
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

      // Re-check epoch: if tab epoch changed during queue wait, abort with ABORTED
      if (entry.epoch !== undefined && tabEpochs.has(entry.tabId) && entry.epoch !== tabEpochs.get(entry.tabId)) {
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
    if (epoch !== undefined && tabEpochs.has(tabId) && epoch !== tabEpochs.get(tabId)) {
      return createTypedError(
        'ABORTED',
        'Pending translation cancelled by new epoch',
        false,
        { reason: 'epoch_changed', tabId }
      );
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
    let sites, tabOverrides;
    try {
      sites = await getStoredSites();
      tabOverrides = await getStoredTabOverrides();
    } catch (err) {
      return createTypedError('CONSENT_STATE_UNAVAILABLE', 'Consent state unavailable', false, {
        tabId,
        reason: err?.message || 'Storage read error'
      });
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

// Sender verification helpers
function isPrivilegedSender(sender) {
  if (!sender) return false;
  // Our own extension pages (popup window, or the same page opened as a tab
  // in tests/automation) are trusted: pages cannot spoof this URL.
  const extPrefix = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
    ? `chrome-extension://${chrome.runtime.id}`
    : 'chrome-extension://';
  if (typeof sender.url === 'string' && sender.url.startsWith(extPrefix)) {
    return true;
  }
  // Content scripts always have sender.tab
  if (sender.tab) return false;
  // Internal extension background / test dispatch
  if (sender.id && typeof chrome !== 'undefined' && chrome.runtime && sender.id === chrome.runtime.id && !sender.tab) {
    return true;
  }
  return false;
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

function verifyWidgetSender(sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== 'number' || sender.frameId !== 0) {
    return {
      ok: false,
      error: createTypedError('PERMISSION_REQUIRED', 'Widget actions require top frame tab sender', false, {
        permissionType: 'host'
      })
    };
  }
  const senderRawUrl = sender.url || (sender.tab && sender.tab.url) || sender.origin;
  const origin = normalizeOrigin(senderRawUrl);
  if (!origin) {
    return {
      ok: false,
      error: createTypedError('SITE_NOT_ALLOWED', 'Invalid HTTP(S) origin for widget', false, {
        origin: senderRawUrl || ''
      })
    };
  }
  return { ok: true, tabId: sender.tab.id, origin, url: senderRawUrl };
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

function notifyAllWidgetStateChanged() {
  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.query === 'function') {
    chrome.tabs.query({}).then((tabs) => {
      if (Array.isArray(tabs)) {
        for (const tab of tabs) {
          if (tab && typeof tab.id === 'number') {
            chrome.tabs.sendMessage(tab.id, { action: 'WIDGET_STATE_CHANGED' }).catch(() => {});
          }
        }
      }
    }).catch(() => {});
  }
}

// Hash full key + baseURL into SHA-256 hex string (zero key material stored)
async function computeKeyFingerprint(key, baseURL) {
  if (!key) return '';
  const normBaseURL = String(baseURL || '').trim();
  const data = new TextEncoder().encode(`${key}::${normBaseURL}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
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
// Fail-fast diagnostic: SW fetch to the provider needs its host permission.
// Without it the request dies as opaque "Failed to fetch" — surface the real
// cause instead. Skipped in test mode (harness bypasses the permission system).
async function checkBaseUrlPermission(baseURL) {
  if (_testMode) return null;
  const baseOrigin = baseURL ? normalizeOrigin(baseURL) : null;
  if (!baseOrigin) return null;
  let granted = false;
  try {
    granted = await permissionContains(baseOrigin);
  } catch {
    granted = false;
  }
  if (!granted) {
    return createTypedError(
      'PERMISSION_REQUIRED',
      'Chưa cấp quyền kết nối Base URL — bấm nút khiên cạnh ô Base URL để cấp quyền rồi thử lại',
      false,
      { origin: baseOrigin, permissionType: 'host' }
    );
  }
  return null;
}

async function listModels(options = {}) {
  const forceRefresh = Boolean(options && options.forceRefresh);
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = (options && options.apiKey) || (await getStoredApiKey());
  const baseURL = (options && options.baseURL) || settings.baseURL || '';

  if (!baseURL || !apiKey) {
    return await router.listModels({ forceRefresh, baseURL, apiKey });
  }

  const fingerprint = await computeKeyFingerprint(apiKey, baseURL);

  // Read L2 cache from storage.local
  let cached = null;
  try {
    const res = await chrome.storage.local.get(['modelListCache']);
    cached = res.modelListCache;
  } catch {}

  const isCacheValid = Boolean(
    cached &&
    cached.baseURL === baseURL &&
    cached.keyFingerprint === fingerprint &&
    Array.isArray(cached.models) &&
    typeof cached.fetchedAt === 'number'
  );

  const now = Date.now();
  const age = isCacheValid ? (now - cached.fetchedAt) : Infinity;

  // 1. Force refresh: bypass L1 and L2
  if (forceRefresh) {
    const basePermError = await checkBaseUrlPermission(baseURL);
    if (basePermError) return basePermError;
    const fetchRes = await router.listModels({ forceRefresh: true, baseURL, apiKey });
    if (fetchRes && Array.isArray(fetchRes.models)) {
      const fetchedAt = Date.now();
      await chrome.storage.local.set({
        modelListCache: {
          baseURL,
          keyFingerprint: fingerprint,
          models: fetchRes.models,
          fetchedAt
        }
      });
      return { models: fetchRes.models, stale: false, fetchedAt };
    }
    // Fetch failed: if stale cache exists within 7 days, return stale + error
    if (isCacheValid && age <= MODEL_CACHE_STALE_MAX_MS) {
      return {
        models: cached.models,
        stale: true,
        fetchedAt: cached.fetchedAt,
        error: fetchRes?.error || fetchRes
      };
    }
    return fetchRes;
  }

  // 2. Fresh (<24h): return immediately
  if (isCacheValid && age < MODEL_CACHE_FRESH_MS) {
    return {
      models: cached.models,
      stale: false,
      fetchedAt: cached.fetchedAt
    };
  }

  // 3. Stale (<= 7 days): return immediately, revalidate in background (shared promise)
  if (isCacheValid && age <= MODEL_CACHE_STALE_MAX_MS) {
    if (!_revalidateModelsPromise) {
      _revalidateModelsPromise = (async () => {
        try {
          const fetchRes = await router.listModels({ forceRefresh: true, baseURL, apiKey });
          if (fetchRes && Array.isArray(fetchRes.models)) {
            const fetchedAt = Date.now();
            await chrome.storage.local.set({
              modelListCache: {
                baseURL,
                keyFingerprint: fingerprint,
                models: fetchRes.models,
                fetchedAt
              }
            });
            notifyModelsUpdated({ models: fetchRes.models, fetchedAt });
          }
        } catch {
        } finally {
          _revalidateModelsPromise = null;
        }
      })();
    }
    return {
      models: cached.models,
      stale: true,
      fetchedAt: cached.fetchedAt,
      refreshing: true
    };
  }

  // 4. Missing, fingerprint changed, or > 7 days: blocking fetch
  const basePermError = await checkBaseUrlPermission(baseURL);
  if (basePermError) return basePermError;
  const fetchRes = await router.listModels({ forceRefresh: true, baseURL, apiKey });
  if (fetchRes && Array.isArray(fetchRes.models)) {
    const fetchedAt = Date.now();
    await chrome.storage.local.set({
      modelListCache: {
        baseURL,
        keyFingerprint: fingerprint,
        models: fetchRes.models,
        fetchedAt
      }
    });
    return { models: fetchRes.models, stale: false, fetchedAt };
  }
  return fetchRes;
}

// Batch Translation (delegated to adapter)
async function translateBatch(input = {}) {
  if (_testMode && typeof _testTranslateBatch === 'function') {
    return await _testTranslateBatch(input);
  }
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = await getStoredApiKey();
  const baseURL = input.baseURL || settings.baseURL;
  const basePermError = await checkBaseUrlPermission(baseURL);
  if (basePermError) return basePermError;
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
        const attemptCacheContext = {
          baseURL: currentBaseURL || '',
          model: currentModel,
          sourceLanguage: payload.sourceLanguage || storedSettings.sourceLanguage || 'auto',
          targetLanguage: payload.targetLanguage || storedSettings.targetLanguage || 'vi',
          promptVersion: PROMPT_VERSION
        };
        const remainingMisses = [];
        for (const m of currentMisses) {
          const normText = normalizeSourceText(m.item?.text);
          const k = cacheKey(m.item, attemptCacheContext);
          const cachedText = translationCache.get(k, normText);
          if (cachedText !== undefined) {
            currentHits.push({
              index: m.index,
              result: {
                id: m.item.id,
                revision: m.item.revision,
                text: cachedText
              }
            });
          } else {
            remainingMisses.push({
              ...m,
              key: k
            });
          }
        }
        currentMisses = remainingMisses;

        if (storedSettings.cacheEnabled !== false && !l2MemoryOnly && !isClearingL2 && remainingMisses.length > 0) {
          try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
              const readEpoch = l2Epoch;
              const l2Res = await chrome.storage.local.get([L2_CACHE_KEY]);
              if (!l2MemoryOnly && !isClearingL2 && l2Epoch === readEpoch) {
                const trCache = l2Res?.[L2_CACHE_KEY];
                if (trCache && typeof trCache === 'object') {
                  const now = Date.now();
                  const afterL2Misses = [];
                  for (const m of remainingMisses) {
                    const l2Key = /^[0-9a-f]{8}$/i.test(m.key) ? m.key : hashText(m.key);
                    const entry = trCache[l2Key];
                    const reqHash = hashText(m.key);
                    const isValidShape = entry && typeof entry === 'object' && typeof entry.text === 'string' && typeof entry.keyHash === 'string' && !('key' in entry);
                    const isMatch = isValidShape && entry.keyHash === reqHash;
                    if (isMatch && (now - (entry.savedAt || 0) < L2_CACHE_TTL_MS)) {
                      const normText = normalizeSourceText(m.item?.text);
                      translationCache.set(m.key, entry.text, normText);
                      currentHits.push({
                        index: m.index,
                        result: {
                          id: m.item.id,
                          revision: m.item.revision,
                          text: entry.text
                        }
                      });
                    } else {
                      afterL2Misses.push(m);
                    }
                  }
                  remainingMisses.length = 0;
                  remainingMisses.push(...afterL2Misses);
                }
              }
            }
          } catch {}
        }

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

  // If tab epoch changed while batch was in-flight, do NOT cache and abort
  if (epoch !== undefined && tabEpochs.has(tabId) && epoch !== tabEpochs.get(tabId)) {
    return createTypedError(
      'ABORTED',
      'Translation batch discarded due to epoch change',
      false,
      { reason: 'epoch_changed' }
    );
  }

  // Populate cache strictly under actualModel and actualBaseURL only after config & epoch checks pass
  if (newlyTranslatedItems.length > 0) {
    const actualCacheContext = {
      baseURL: actualBaseURL || '',
      model: actualModel,
      sourceLanguage: payload.sourceLanguage || storedSettings.sourceLanguage || 'auto',
      targetLanguage: payload.targetLanguage || storedSettings.targetLanguage || 'vi',
      promptVersion: PROMPT_VERSION
    };

    for (const { item, text } of newlyTranslatedItems) {
      const k = cacheKey(item, actualCacheContext);
      translationCache.set(k, text, normalizeSourceText(item?.text));
      if (storedSettings.cacheEnabled !== false && !l2MemoryOnly) {
        enqueueL2Cache(k, text);
      }
    }
  }

  // Merge hits and misses preserving the exact original order
  const totalCount = hits.length + misses.length;
  const merged = new Array(totalCount);

  for (const h of currentHits) {
    if (h && typeof h.index === 'number') {
      merged[h.index] = h.result;
    }
  }

  const cleanResults = merged.filter(Boolean);
  const actualBaseURLHost = extractHost(actualBaseURL);
  const missingIds = Array.isArray(finalProviderRes?.missingIds) ? finalProviderRes.missingIds : [];

  if (missingIds.length > 0) {
    try {
      await recordErrorLog({
        code: 'PARTIAL_BATCH',
        message: `Batch partially completed: ${missingIds.length} item(s) missing`,
        details: { missingIds }
      }, {
        model: actualModel || currentModel,
        tabId,
        isTerminal: false
      });
    } catch {}
  }

  return {
    ...finalProviderRes,
    results: cleanResults,
    partial: Boolean(finalProviderRes?.partial || missingIds.length > 0),
    missingIds,
    failed: missingIds.length,
    requestedModel,
    actualModel: actualModel || requestedModel,
    fallbackIndex,
    fallbackConsumed: Boolean(payload?.fallbackConsumed || (typeof fallbackIndex === 'number' && fallbackIndex > 0)),
    actualBaseURLHost,
    configRevision: batchConfigRevision,
    currentConfigRevision: configRevision
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
        return { ok: true, version: '0.1.0' };

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
        return await serializeSettingsWrite(async () => {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SAVE_SETTINGS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
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
          mergedRaw.favoriteModelsByBaseURL = {
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

        if (configChanged) {
          configRevision++;
          translationCache.clear();
          pendingL2Writes.clear();
          if (l2WriteTimer) {
            clearTimeout(l2WriteTimer);
            l2WriteTimer = null;
          }
          // Abort active in-flight requests across all tabs
          for (const [reqId, active] of activeBatchControllers.entries()) {
            try { active.controller.abort('config_changed'); } catch {}
          }
          activeBatchControllers.clear();
          // Abort all queued batches across all tabs
          for (const [tabId, queue] of tabQueues.entries()) {
            for (const entry of queue) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'ABORTED',
                'Translation request aborted due to configuration change',
                false,
                { reason: 'Configuration changed' }
              ));
            }
          }
          tabQueues.clear();
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

        // Push WIDGET_STATE_CHANGED if mode, widgetVisible, uiLocale, theme, uiFontScale, fabSize or autoTranslateSites changed
        if (
          oldSettings.translationMode !== migrated.translationMode ||
          oldSettings.widgetVisible !== migrated.widgetVisible ||
          oldSettings.uiLocale !== migrated.uiLocale ||
          oldSettings.theme !== migrated.theme ||
          oldSettings.uiFontScale !== migrated.uiFontScale ||
          oldSettings.fabSize !== migrated.fabSize ||
          JSON.stringify(oldSettings.autoTranslateSites) !== JSON.stringify(migrated.autoTranslateSites)
        ) {
          notifyAllWidgetStateChanged();
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
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SET_KEY is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await ensureStorageAccess();
        configRevision++;
        translationCache.clear();
        for (const [reqId, active] of activeBatchControllers.entries()) {
          try { active.controller.abort('credential_changed'); } catch {}
        }
        activeBatchControllers.clear();
        for (const [tabId, queue] of tabQueues.entries()) {
          for (const entry of queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'ABORTED',
              'Translation request aborted due to credential change',
              false,
              { reason: 'Credential changed' }
            ));
          }
        }
        tabQueues.clear();
        await clearL2Cache();
        // Invalidate model list cache on key change (best-effort)
        try {
          await chrome.storage.local.remove(['modelListCache']);
        } catch {}
        if (typeof message.key === 'string') {
          await chrome.storage.local.set({ api_key: message.key });
        }
        notifyAllWidgetStateChanged();
        return { ok: true, configRevision };
      }

      case 'SET_FALLBACK_KEY': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SET_FALLBACK_KEY is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const fbId = typeof message.id === 'string' ? message.id.trim() : '';
        if (!fbId) {
          return createTypedError('INVALID_SCHEMA', 'Fallback id is required', false, { id: message.id });
        }
        const key = typeof message.key === 'string' ? message.key.trim() : '';
        if (!key) {
          return createTypedError('INVALID_SCHEMA', 'Fallback key must be a non-empty string', false);
        }

        await ensureStorageAccess();
        const settings = await getStoredSettings();
        const exists = Array.isArray(settings.fallbacks) && settings.fallbacks.some((fb) => fb && fb.id === fbId);
        if (!exists) {
          return createTypedError('INVALID_SCHEMA', `Fallback id "${fbId}" does not exist in settings`, false, { id: fbId });
        }

        configRevision++;
        translationCache.clear();
        for (const [reqId, active] of activeBatchControllers.entries()) {
          try { active.controller.abort('credential_changed'); } catch {}
        }
        activeBatchControllers.clear();
        for (const [tabId, queue] of tabQueues.entries()) {
          for (const entry of queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'ABORTED',
              'Translation request aborted due to credential change',
              false,
              { reason: 'Credential changed' }
            ));
          }
        }
        tabQueues.clear();
        await clearL2Cache();

        const res = await chrome.storage.local.get(['fallback_api_keys']);
        const fbKeys = res.fallback_api_keys || {};
        fbKeys[fbId] = key;
        await chrome.storage.local.set({ fallback_api_keys: fbKeys });

        notifyAllWidgetStateChanged();
        return { ok: true, configRevision };
      }

      case 'DELETE_FALLBACK_KEY': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'DELETE_FALLBACK_KEY is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        const fbId = typeof message.id === 'string' ? message.id.trim() : '';
        if (!fbId) {
          return createTypedError('INVALID_SCHEMA', 'Fallback id is required', false, { id: message.id });
        }

        await ensureStorageAccess();
        configRevision++;
        translationCache.clear();
        for (const [reqId, active] of activeBatchControllers.entries()) {
          try { active.controller.abort('credential_changed'); } catch {}
        }
        activeBatchControllers.clear();
        for (const [tabId, queue] of tabQueues.entries()) {
          for (const entry of queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'ABORTED',
              'Translation request aborted due to credential removal',
              false,
              { reason: 'Credential removed' }
            ));
          }
        }
        tabQueues.clear();
        await clearL2Cache();

        const res = await chrome.storage.local.get(['fallback_api_keys']);
        const fbKeys = res.fallback_api_keys || {};
        if (fbId in fbKeys) {
          delete fbKeys[fbId];
          await chrome.storage.local.set({ fallback_api_keys: fbKeys });
        }

        notifyAllWidgetStateChanged();
        return { ok: true, configRevision };
      }

      case 'DELETE_KEY': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'DELETE_KEY is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await ensureStorageAccess();
        configRevision++;
        translationCache.clear();
        for (const [reqId, active] of activeBatchControllers.entries()) {
          try { active.controller.abort('credential_changed'); } catch {}
        }
        activeBatchControllers.clear();
        for (const [tabId, queue] of tabQueues.entries()) {
          for (const entry of queue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'ABORTED',
              'Translation request aborted due to credential removal',
              false,
              { reason: 'Credential removed' }
            ));
          }
        }
        tabQueues.clear();
        await clearL2Cache();
        // Invalidate model list cache on key removal, and remove all fallback keys
        await chrome.storage.local.remove(['modelListCache', 'api_key', 'fallback_api_keys']);
        notifyAllWidgetStateChanged();
        return { ok: true, configRevision };
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

        const nextEpoch = typeof message.epoch === 'number' ? message.epoch : ((tabEpochs.get(tabId) || 0) + 1);
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
        const storedSettings = await getStoredSettings();
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
        const misses = [];

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

        if (storedSettings.cacheEnabled !== false && !l2MemoryOnly && !isClearingL2 && misses.length > 0) {
          try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
              const readEpoch = l2Epoch;
              const l2Res = await chrome.storage.local.get([L2_CACHE_KEY]);
              if (!l2MemoryOnly && !isClearingL2 && l2Epoch === readEpoch) {
                const trCache = l2Res?.[L2_CACHE_KEY];
                if (trCache && typeof trCache === 'object') {
                  const now = Date.now();
                  const afterL2Misses = [];
                  for (const m of misses) {
                    const l2Key = /^[0-9a-f]{8}$/i.test(m.key) ? m.key : hashText(m.key);
                    const entry = trCache[l2Key];
                    const reqHash = hashText(m.key);
                    const isValidShape = entry && typeof entry === 'object' && typeof entry.text === 'string' && typeof entry.keyHash === 'string' && !('key' in entry);
                    const isMatch = isValidShape && entry.keyHash === reqHash;
                    if (isMatch && (now - (entry.savedAt || 0) < L2_CACHE_TTL_MS)) {
                      const normText = normalizeSourceText(m.item?.text);
                      translationCache.set(m.key, entry.text, normText);
                      hits.push({
                        index: m.index,
                        result: {
                          id: m.item.id,
                          revision: m.item.revision,
                          text: entry.text
                        }
                      });
                    } else {
                      afterL2Misses.push(m);
                    }
                  }
                  misses.length = 0;
                  misses.push(...afterL2Misses);
                }
              }
            }
          } catch {}
        }

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
        if (!tabEpochs.has(sender.tab.id)) {
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

        const urlMatchesSender = !sender.url || !sender.tab?.url || (normalizeOrigin(sender.url) === normalizeOrigin(sender.tab.url));

        let autoStart = false;
        let reason;

        if (!siteConfig) {
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
          widgetVisible: settings.widgetVisible ?? true,
          uiLocale: settings.uiLocale || 'vi',
          theme: settings.theme || 'dark',
          uiFontScale: settings.uiFontScale || 'md',
          fabSize: typeof settings.fabSize === 'number' ? settings.fabSize : 1,
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
          fabSize: typeof settings.fabSize === 'number' ? settings.fabSize : 1
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
            pendingL2Writes.clear();
            if (l2WriteTimer) {
              clearTimeout(l2WriteTimer);
              l2WriteTimer = null;
            }
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
  getL2Epoch: () => l2Epoch,
  isL2MemoryOnly: () => l2MemoryOnly,
  _setL2MemoryOnlyForTest: (v) => { l2MemoryOnly = Boolean(v); },
  isClearingL2: () => isClearingL2,
  isL2Clearing: () => isClearingL2,
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  L2_MAX_SIZE_BYTES,
  reconcileWatchdog,
  executeBatchTranslation,
  _setTranslateBatchForTest
};
