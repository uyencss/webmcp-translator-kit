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
  resolveLimits,
  DEFAULT_RATE_LIMITS
} from './rate-limits.mjs';
import {
  createTranslationCache,
  cacheKey,
  normalizeSourceText,
  PROMPT_VERSION
} from './cache.mjs';
import {
  createSemaphore
} from './semaphore.mjs';
import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  migrateSettings,
  validateSettings
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

// Provider concurrency semaphore = 2
const providerSemaphore = createSemaphore({
  maxConcurrency: 2,
  timeoutMs: 120000
});

let storageAccessInitialized = false;
let storageAccessFailed = false;
let currentAccessLevel = 'TRUSTED_AND_UNTRUSTED_CONTEXTS';

// Expose reset hook strictly for tests (never bypasses security)
function _resetStorageAccessStateForTest() {
  storageAccessInitialized = false;
  storageAccessFailed = false;
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
export function resolveFallbackPlan(err, chain, attemptIndex = 0) {
  if (!err) {
    return { shouldFallback: false, reason: 'NO_ERROR' };
  }

  const code = (typeof err === 'object' && err !== null)
    ? (err.error?.code || err.code || '')
    : '';

  if (STOP_ERROR_CODES.includes(code)) {
    return {
      shouldFallback: false,
      reason: 'STOP_LIST',
      terminalError: err,
      attemptIndex
    };
  }

  if (!FALLBACK_ELIGIBLE_CODES.includes(code)) {
    return {
      shouldFallback: false,
      reason: 'NOT_ELIGIBLE',
      terminalError: err,
      attemptIndex
    };
  }

  if (!Array.isArray(chain) || chain.length <= 1) {
    return {
      shouldFallback: false,
      reason: 'NO_FALLBACK_MODELS',
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
  const primaryConfig = {
    id: 'primary',
    baseURL: settings.baseURL || '',
    apiKey: primaryKey || '',
    model: primaryModel
  };

  const configuredFallbacks = Array.isArray(settings.fallbacks) ? settings.fallbacks : [];
  const fallbackConfigs = [];
  for (const fb of configuredFallbacks) {
    if (fb && typeof fb === 'object' && fb.model) {
      const fbId = typeof fb.id === 'string' && fb.id.trim() ? fb.id.trim() : 'fb1';
      const fbBaseURL = (typeof fb.baseURL === 'string' && fb.baseURL.trim()) ? fb.baseURL.trim() : primaryConfig.baseURL;
      const fbApiKey = (fbId && fallbackApiKeys && fallbackApiKeys[fbId]) ? fallbackApiKeys[fbId] : primaryKey;
      fallbackConfigs.push({
        id: fbId,
        baseURL: fbBaseURL,
        apiKey: fbApiKey,
        model: fb.model.trim()
      });
    }
  }

  return [primaryConfig, ...fallbackConfigs].slice(0, 3);
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

// TEST-ONLY: Activate test mode for automated test suites
function _setTestMode(enabled) {
  _testMode = Boolean(enabled);
  if (!_testMode) {
    _testPermissionOverrides.clear();
    _testRateLimits = null;
    _testRateWindowSeconds = null;
    _testMaxQueue = null;
    _testMaxRetries = null;
  }
}

function _setTestMaxRetries(n) {
  if (!_testMode) return;
  _testMaxRetries = typeof n === 'number' ? n : null;
}

// TEST-ONLY: Set explicit permission status for origin
function _setTestPermission(origin, granted) {
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
function _registerTestTab(tabId, url) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return;
  testTabRegistry.set(id, String(url));
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
  const raw = res.settings;
  const migrated = migrateSettings(raw);
  if (!raw || raw.version !== SETTINGS_VERSION) {
    await chrome.storage.local.set({ settings: migrated });
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
  let real = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.get === 'function') {
      real = await chrome.tabs.get(tabId);
    }
  } catch {
    real = null;
  }
  const testUrl = _testMode && testTabRegistry.has(Number(tabId)) ? testTabRegistry.get(Number(tabId)) : null;
  if (!real && testUrl === null) return null;
  const url = (real && typeof real.url === 'string' && real.url) || testUrl || null;
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

      if (entry.tabUrl && tabInfo.url && tabInfo.url !== entry.tabUrl) {
        removeEntryFromQueue(entry);
        entry.resolve(createTypedError(
          'ABORTED',
          'Tab navigated while translation was queued',
          false,
          { reason: 'navigation', originalUrl: entry.tabUrl, currentUrl: tabInfo.url }
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
          : await translateBatch(entry.payload || {});
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
    for (const [reqId, active] of activeBatchControllers.entries()) {
      if (active.tabId === tabId) {
        try { active.controller.abort('tab_closed'); } catch {}
        activeBatchControllers.delete(reqId);
      }
    }
    tabEpochs.delete(tabId);
    const queue = tabQueues.get(tabId);
    if (queue && queue.length > 0) {
      for (const entry of queue) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve(createTypedError('ABORTED', 'Tab was closed', false, { reason: 'tab_closed' }));
      }
      tabQueues.delete(tabId);
    }
    if (!chrome.storage || !chrome.storage.session) return;
    const res = await chrome.storage.session.get(['tab_overrides']);
    const overrides = res.tab_overrides || {};
    const key = String(tabId);
    if (key in overrides) {
      delete overrides[key];
      await chrome.storage.session.set({ tab_overrides: overrides });
    }
    await chrome.storage.session.remove([`rate:tab:${tabId}`]);
  } catch {
    // Ignore cleanup error
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === 'function') {
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
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
              js: ['content.js'],
              runAt: 'document_idle',
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
async function listModels(options = {}) {
  const forceRefresh = Boolean(options && options.forceRefresh);
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = await getStoredApiKey();

  const baseURL = settings.baseURL || '';
  routerConfig.baseURL = baseURL;
  routerConfig.apiKey = apiKey;
  routerConfig.model = settings.model || DEFAULT_MODEL;

  if (!baseURL || !apiKey) {
    return await router.listModels({ forceRefresh });
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
    const fetchRes = await router.listModels({ forceRefresh: true });
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
          const fetchRes = await router.listModels({ forceRefresh: true });
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
  const fetchRes = await router.listModels({ forceRefresh: true });
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
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = await getStoredApiKey();
  const baseURL = input.baseURL || settings.baseURL;
  const key = input.apiKey !== undefined ? input.apiKey : apiKey;
  const model = input.model || settings.model || DEFAULT_MODEL;
  routerConfig.baseURL = baseURL;
  routerConfig.apiKey = key;
  routerConfig.model = model;
  return await router.translateBatch({
    ...input,
    baseURL,
    apiKey: key,
    model
  });
}

// Semaphore-guarded batch translation with fallback chain & cache population strictly under actualModel
async function executeBatchTranslation({
  payload = {},
  misses = [],
  hits = [],
  batchConfigRevision = configRevision,
  tabId = null,
  epoch = undefined,
  origin = null
}) {
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

  const signal = controller ? controller.signal : payload.signal;

  try {
    await providerSemaphore.acquire();
  } catch (err) {
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
    if (err?.code === 'TIMEOUT') {
      return createTypedError('TIMEOUT', 'Provider concurrency queue timed out waiting for available slot', false, {
        maxConcurrentRequests: providerSemaphore.getMaxConcurrency()
      });
    }
    throw err;
  }

  // After acquiring semaphore: check if already aborted while waiting for permit
  if (signal?.aborted) {
    providerSemaphore.release();
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
    return createTypedError('ABORTED', 'Operation aborted before acquiring provider slot', false, {
      reason: signal.reason ? String(signal.reason) : 'aborted'
    });
  }

  // Pre-dispatch guard: verify configuration revision and tab epoch
  if (
    batchConfigRevision !== configRevision ||
    (epoch !== undefined && tabEpochs.has(tabId) && epoch !== tabEpochs.get(tabId))
  ) {
    providerSemaphore.release();
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
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

  const storedSettings = await getStoredSettings();
  const primaryKey = await getStoredApiKey();
  let storedFbKeys = {};
  try {
    const fbKeysRes = await chrome.storage.local.get(['fallback_api_keys']);
    storedFbKeys = fbKeysRes.fallback_api_keys || {};
  } catch {}

  const chain = resolveFallbackChain(storedSettings, storedFbKeys, primaryKey);
  const requestedModel = chain[0]?.model || DEFAULT_MODEL;

  let currentMisses = [...misses];
  let currentHits = [...hits];
  let finalProviderRes = null;
  let actualModel = requestedModel;
  let actualBaseURL = chain[0]?.baseURL || storedSettings.baseURL || '';
  let fallbackIndex = 0;

  try {
    for (let attemptIndex = 0; attemptIndex < chain.length && attemptIndex < 3; attemptIndex++) {
      const currentConfig = chain[attemptIndex];
      const currentModel = currentConfig.model;
      const currentBaseURL = currentConfig.baseURL;
      const currentApiKey = currentConfig.apiKey;

      // Re-verify signal and config revision before each attempt
      if (signal?.aborted) {
        return createTypedError('ABORTED', 'Operation aborted during attempt', false, {
          reason: signal.reason ? String(signal.reason) : 'aborted'
        });
      }
      if (
        batchConfigRevision !== configRevision ||
        (epoch !== undefined && tabEpochs.has(tabId) && epoch !== tabEpochs.get(tabId))
      ) {
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
          signal
        });
      } catch (err) {
        attemptRes = (err && err.error) ? err : createTypedError('NETWORK', err?.message || 'Network error', true);
      }

      if (attemptRes && !attemptRes.error && Array.isArray(attemptRes.results)) {
        actualModel = currentModel;
        actualBaseURL = currentBaseURL;
        fallbackIndex = attemptIndex;
        finalProviderRes = attemptRes;

        // Populate cache strictly under actualModel and actualBaseURL
        const actualCacheContext = {
          baseURL: actualBaseURL || '',
          model: actualModel,
          sourceLanguage: payload.sourceLanguage || storedSettings.sourceLanguage || 'auto',
          targetLanguage: payload.targetLanguage || storedSettings.targetLanguage || 'vi',
          promptVersion: PROMPT_VERSION
        };

        for (let i = 0; i < currentMisses.length; i++) {
          const miss = currentMisses[i];
          const resItem = attemptRes.results.find((r) => r && r.id === miss.item.id) || attemptRes.results[i];
          if (resItem && typeof resItem.text === 'string') {
            const k = cacheKey(miss.item, actualCacheContext);
            translationCache.set(k, resItem.text, normalizeSourceText(miss.item?.text));
          }
        }

        // Add translated items to currentHits
        for (let i = 0; i < currentMisses.length; i++) {
          const miss = currentMisses[i];
          const resItem = attemptRes.results.find((r) => r && r.id === miss.item.id) || attemptRes.results[i];
          currentHits.push({
            index: miss.index,
            result: {
              id: miss.item.id,
              revision: miss.item.revision,
              text: resItem ? resItem.text : miss.item.text
            }
          });
        }
        break;
      }

      // Handle attempt failure
      finalProviderRes = attemptRes;
      const plan = resolveFallbackPlan(attemptRes, chain, attemptIndex);
      if (!plan.shouldFallback) {
        break;
      }
    }
  } finally {
    providerSemaphore.release();
    if (controller) {
      activeBatchControllers.delete(requestId);
    }
  }

  if (finalProviderRes && finalProviderRes.error) {
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

  // Merge hits and misses preserving the exact original order
  const totalCount = hits.length + misses.length;
  const merged = new Array(totalCount);

  for (const h of currentHits) {
    merged[h.index] = h.result;
  }

  const actualBaseURLHost = extractHost(actualBaseURL);

  return {
    ...finalProviderRes,
    results: merged,
    requestedModel,
    actualModel,
    fallbackIndex,
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
        let storedFbKeys = {};
        try {
          const res = await chrome.storage.local.get(['fallback_api_keys']);
          storedFbKeys = res.fallback_api_keys || {};
        } catch {}
        const fallbackKeyPresence = {};
        if (Array.isArray(settings.fallbacks)) {
          for (const fb of settings.fallbacks) {
            if (fb && fb.id) {
              fallbackKeyPresence[fb.id] = Boolean(storedFbKeys[fb.id]);
            }
          }
        }
        return { settings, hasKey, fallbackKeyPresence, configRevision };
      }

      case 'SAVE_SETTINGS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SAVE_SETTINGS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await ensureStorageAccess();

        const oldSettings = await getStoredSettings();
        const patch = (message.settings && typeof message.settings === 'object' && !Array.isArray(message.settings))
          ? message.settings
          : {};

        // Merge patch with previously saved settings
        const mergedRaw = { ...oldSettings, ...patch };
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

        const validation = validateSettings(mergedRaw);
        if (!validation.valid) {
          return createTypedError('INVALID_SCHEMA', 'Invalid settings: ' + (validation.errors || []).join('; '), false, {
            schemaErrors: validation.errors
          });
        }

        const migrated = migrateSettings(mergedRaw);

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

        // Invalidate model cache if baseURL changed
        if (oldSettings.baseURL !== migrated.baseURL) {
          await chrome.storage.local.remove(['modelListCache']);
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
        if (migrated.baseURL) routerConfig.baseURL = migrated.baseURL;
        if (migrated.model) routerConfig.model = migrated.model;

        // Push WIDGET_STATE_CHANGED if mode or widgetVisible changed
        if (oldSettings.translationMode !== migrated.translationMode || oldSettings.widgetVisible !== migrated.widgetVisible) {
          notifyAllWidgetStateChanged();
        }

        return { ok: true, configRevision };
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
        // Invalidate model list cache on key change
        await chrome.storage.local.remove(['modelListCache']);
        if (typeof message.key === 'string') {
          await chrome.storage.local.set({ api_key: message.key });
          routerConfig.apiKey = message.key;
        }
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

        const res = await chrome.storage.local.get(['fallback_api_keys']);
        const fbKeys = res.fallback_api_keys || {};
        fbKeys[fbId] = key;
        await chrome.storage.local.set({ fallback_api_keys: fbKeys });

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

        const res = await chrome.storage.local.get(['fallback_api_keys']);
        const fbKeys = res.fallback_api_keys || {};
        if (fbId in fbKeys) {
          delete fbKeys[fbId];
          await chrome.storage.local.set({ fallback_api_keys: fbKeys });
        }

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
        // Invalidate model list cache on key removal, and remove all fallback keys
        await chrome.storage.local.remove(['modelListCache', 'api_key', 'fallback_api_keys']);
        routerConfig.apiKey = '';
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
                js: ['content.js'],
                runAt: 'document_idle',
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
                files: ['content.js']
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

        // Inject content.js once (content self-guards window.__webMcpTranslatorInjected)
        if (typeof chrome !== 'undefined' && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
          try {
            await chrome.scripting.executeScript({
              target: { tabId, frameIds: [0] },
              files: ['content.js']
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
        const primaryModel = storedSettings.model || message.payload?.model || DEFAULT_MODEL;
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

        const autoSites = Array.isArray(settings.autoTranslateSites) ? settings.autoTranslateSites : [];
        const inAutoList = autoSites.includes(gate.origin);
        const urlMatchesSender = !sender.url || !sender.tab?.url || (normalizeOrigin(sender.url) === normalizeOrigin(sender.tab.url));

        let autoStart = false;
        let reason;

        if (!inAutoList) {
          reason = 'not_in_list';
        } else if (tabOverride === 'off') {
          reason = 'tab_off';
        } else if (!siteEnabled) {
          reason = 'site_off';
        } else if (!hasPerm) {
          reason = 'no_permission';
        } else if (urlMatchesSender) {
          autoStart = true;
        } else {
          reason = 'not_in_list';
        }

        return {
          effective,
          siteEnabled,
          tabOverride,
          permission: hasPerm,
          mode: settings.translationMode || 'scroll-follow',
          widgetVisible: settings.widgetVisible ?? true,
          position,
          hasKey,
          autoStart,
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

        const state = {
          effective,
          siteEnabled,
          tabOverride,
          permission: hasPerm,
          mode: settings.translationMode || 'scroll-follow',
          widgetVisible: settings.widgetVisible ?? true,
          position: widgetPositions[gate.origin] || null,
          hasKey
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

        await ensureStorageAccess();
        const oldSettings = await getStoredSettings();
        if (oldSettings.translationMode !== mode) {
          configRevision++;
          translationCache.clear();
          for (const [reqId, active] of activeBatchControllers.entries()) {
            try { active.controller.abort('config_changed'); } catch {}
          }
          activeBatchControllers.clear();
          for (const [tabId, queue] of tabQueues.entries()) {
            for (const entry of queue) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'ABORTED',
                'Translation request aborted due to mode change',
                false,
                { reason: 'Mode changed' }
              ));
            }
          }
          tabQueues.clear();

          const merged = migrateSettings({ ...oldSettings, translationMode: mode });
          await chrome.storage.local.set({ settings: merged });
          notifyAllWidgetStateChanged();
        }

        return { ok: true, mode };
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
  _setTestRateLimits,
  _setTestRateWindowSeconds,
  _setTestMaxQueue,
  _setTestMaxRetries,
  _resetRateStateForTest,
  _handleTabRemovedForTest: (tabId) => handleTabRemoved(tabId),
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
  getConfigRevision: () => configRevision,
  SETTINGS_VERSION,
  migrateSettings,
  validateSettings,
  resolveFallbackPlan,
  computeKeyFingerprint,
  activeBatchControllers
};
