// WebMCP Translator Kit — Background Module: Admission & Queue Scheduling
// Manages sliding-window rate limit admission, queue retry timers, and tab policy resolution.

import { normalizeOrigin, getEffectivePolicy } from '../../consent.mjs';
import { createTypedError } from './security.mjs';
import { createLimitState, prune, evaluate, record, resolveLimits } from '../../rate-limits.mjs';

export function createAdmissionManager({
  tabQueues,
  tabEpochs,
  testTabRegistry,
  isTestMode,
  getTestRateLimits,
  getTestRateWindowSeconds,
  getStoredSettings,
  getStoredSites,
  getStoredTabOverrides,
  ensureStorageAccess,
  permissionContains,
  executeBatchTranslation,
  translateBatch,
  pushTranslateProgress
}) {
  let admissionChain = Promise.resolve();

  function runInAdmissionChain(fn) {
    const next = admissionChain.then(fn, fn);
    admissionChain = next.catch(() => {});
    return next;
  }

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
      const testLimits = getTestRateLimits();
      if (isTestMode() && testLimits) {
        limits = resolveLimits(testLimits);
      }
      const testWindowSec = getTestRateWindowSeconds();
      if (isTestMode() && typeof testWindowSec === 'number' && testWindowSec > 0) {
        limits.windowSeconds = testWindowSec;
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

  async function resolveTabPolicy(tabId) {
    const idNum = Number(tabId);
    if (isTestMode() && testTabRegistry.has(idNum)) {
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

  return {
    getRateState,
    setRateStates,
    runInAdmissionChain,
    removeEntryFromQueue,
    checkAdmission,
    resolveTabPolicy,
    scheduleQueueEntry
  };
}
