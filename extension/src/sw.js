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

let configRevision = 1;

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
// TEST-ONLY State & Hooks (Dormant and unread in production)
// ============================================================================
let _testMode = false;
// TEST-ONLY: simulated tab ids -> url (harness registers fixture/tab40 ids).
const testTabRegistry = new Map();
const _testPermissionOverrides = new Map();
let _testRateLimits = null;
let _testRateWindowSeconds = null;
let _testMaxQueue = null;

// TEST-ONLY: Activate test mode for automated test suites
function _setTestMode(enabled) {
  _testMode = Boolean(enabled);
  if (!_testMode) {
    _testPermissionOverrides.clear();
    _testRateLimits = null;
    _testRateWindowSeconds = null;
    _testMaxQueue = null;
  }
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
  for (const [tId, active] of activeBatchControllers.entries()) {
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
const activeBatchControllers = new Map(); // tabId -> { controller, revision, epoch, origin }

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
    const active = activeBatchControllers.get(tabId);
    if (active) {
      try { active.controller.abort('tab_closed'); } catch {}
      activeBatchControllers.delete(tabId);
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
      for (const [tId, active] of activeBatchControllers.entries()) {
        if (active.origin && !grantedOrigins.has(active.origin)) {
          try { active.controller.abort('permission_revoked'); } catch {}
          activeBatchControllers.delete(tId);
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

// Semaphore-guarded batch translation with cache population & original-order merging
async function executeBatchTranslation({
  payload = {},
  misses = [],
  hits = [],
  batchConfigRevision = configRevision,
  tabId = null,
  epoch = undefined,
  origin = null
}) {
  let controller = null;
  if (typeof tabId === 'number') {
    const prev = activeBatchControllers.get(tabId);
    if (prev) {
      try { prev.controller.abort('superseded'); } catch {}
    }
    controller = new AbortController();
    activeBatchControllers.set(tabId, {
      controller,
      revision: batchConfigRevision,
      epoch,
      origin
    });
  }

  const signal = controller ? controller.signal : payload.signal;

  try {
    await providerSemaphore.acquire();
  } catch (err) {
    if (controller && typeof tabId === 'number') {
      if (activeBatchControllers.get(tabId)?.controller === controller) {
        activeBatchControllers.delete(tabId);
      }
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
    if (controller && typeof tabId === 'number') {
      if (activeBatchControllers.get(tabId)?.controller === controller) {
        activeBatchControllers.delete(tabId);
      }
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
    if (controller && typeof tabId === 'number') {
      if (activeBatchControllers.get(tabId)?.controller === controller) {
        activeBatchControllers.delete(tabId);
      }
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

  let providerRes;
  try {
    providerRes = await translateBatch({
      ...payload,
      items: misses.map((m) => m.item),
      signal
    });
  } finally {
    providerSemaphore.release();
    if (controller && typeof tabId === 'number') {
      if (activeBatchControllers.get(tabId)?.controller === controller) {
        activeBatchControllers.delete(tabId);
      }
    }
  }

  if (providerRes && providerRes.error) {
    return providerRes;
  }

  if (!providerRes || !Array.isArray(providerRes.results)) {
    return providerRes;
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

  // Populate cache for newly translated items
  for (let i = 0; i < misses.length; i++) {
    const miss = misses[i];
    const res = providerRes.results.find((r) => r && r.id === miss.item.id) || providerRes.results[i];
    if (res && typeof res.text === 'string') {
      translationCache.set(miss.key, res.text, normalizeSourceText(miss.item?.text));
    }
  }

  // Merge hits and misses preserving the exact original order
  const totalCount = hits.length + misses.length;
  const merged = new Array(totalCount);

  for (const h of hits) {
    merged[h.index] = h.result;
  }

  for (let i = 0; i < misses.length; i++) {
    const miss = misses[i];
    const res = providerRes.results.find((r) => r && r.id === miss.item.id) || providerRes.results[i];
    merged[miss.index] = {
      id: miss.item.id,
      revision: miss.item.revision,
      text: res ? res.text : miss.item.text
    };
  }

  return {
    ...providerRes,
    results: merged,
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
        return { settings, hasKey, configRevision };
      }

      case 'SAVE_SETTINGS': {
        if (!isPrivilegedSender(sender)) {
          return createTypedError('PERMISSION_REQUIRED', 'SAVE_SETTINGS is only permitted from extension UI', false, {
            permissionType: 'host'
          });
        }
        await ensureStorageAccess();

        if (message.settings) {
          const validation = validateSettings(message.settings);
          if (!validation.valid) {
            return createTypedError('INVALID_SCHEMA', 'Invalid settings: ' + (validation.errors || []).join('; '), false, {
              schemaErrors: validation.errors
            });
          }
        }

        const oldSettings = await getStoredSettings();
        const migrated = migrateSettings(message.settings);

        const configChanged = (
          oldSettings.baseURL !== migrated.baseURL ||
          oldSettings.model !== migrated.model ||
          oldSettings.sourceLanguage !== migrated.sourceLanguage ||
          oldSettings.targetLanguage !== migrated.targetLanguage
        );

        if (configChanged) {
          configRevision++;
          translationCache.clear();
          // Abort active in-flight requests across all tabs
          for (const [tabId, active] of activeBatchControllers.entries()) {
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

        await chrome.storage.local.set({ settings: migrated });
        if (migrated.baseURL) routerConfig.baseURL = migrated.baseURL;
        if (migrated.model) routerConfig.model = migrated.model;

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
        for (const [tabId, active] of activeBatchControllers.entries()) {
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
        if (typeof message.key === 'string') {
          await chrome.storage.local.set({ api_key: message.key });
          routerConfig.apiKey = message.key;
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
        for (const [tabId, active] of activeBatchControllers.entries()) {
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
        await chrome.storage.local.remove(['api_key']);
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
          for (const [tId, active] of activeBatchControllers.entries()) {
            if (active.origin === normOrigin) {
              try { active.controller.abort('site_disabled'); } catch {}
              activeBatchControllers.delete(tId);
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
          const active = activeBatchControllers.get(tabId);
          if (active) {
            try { active.controller.abort('tab_disabled'); } catch {}
            activeBatchControllers.delete(tabId);
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

        const active = activeBatchControllers.get(tabId);
        if (active) {
          if (typeof message.epoch !== 'number' || active.epoch === undefined || active.epoch < nextEpoch) {
            try { active.controller.abort('cancel_pending'); } catch {}
            activeBatchControllers.delete(tabId);
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

        // 5. Cache lookup (after consent & permission, BEFORE rate admission)
        const storedSettings = await getStoredSettings();
        const cacheContext = {
          baseURL: storedSettings.baseURL || '',
          model: message.payload?.model || storedSettings.model || DEFAULT_MODEL,
          sourceLanguage: message.payload?.sourceLanguage || 'auto',
          targetLanguage: message.payload?.targetLanguage || 'vi',
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
  _setTestMode,
  _setTestPermission,
  _registerTestTab,
  _setTestRateLimits,
  _setTestRateWindowSeconds,
  _setTestMaxQueue,
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
  validateSettings
};
