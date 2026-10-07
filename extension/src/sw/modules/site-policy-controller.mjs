// WebMCP Translator Kit — Background Module: Site Policy & Permissions Controller
// Manages per-site enable/disable, tab overrides, dynamic content script registration & permissions reconcile.

import { normalizeOrigin, getEffectivePolicy } from '../../consent.mjs';
import {
  createTypedError,
  isPrivilegedSender
} from './security.mjs';
import {
  originToScriptId,
  originToMatchPattern,
  calculateReconcileDiff
} from '../../permissions.mjs';
import { normalizePerSiteConfig } from '../../settings.mjs';

export function resolveEffectiveSiteConfig(settings, origin, defaultModel = 'ag/gemini-3.1-pro-low') {
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
      : (settings.model || defaultModel)
  };
}

let _reconcilePromise = null;

export async function reconcilePermissions({
  ensureStorageAccess,
  permissionContains,
  activeBatchControllers,
  tabQueues
}) {
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
      for (const [tabId, queue] of tabQueues.entries()) {
        const remaining = [];
        for (const entry of queue) {
          if (entry.origin && !grantedOrigins.has(entry.origin)) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve(createTypedError(
              'PERMISSION_REQUIRED',
              'Host permission revoked for site origin',
              false,
              { origin: entry.origin, permissionType: 'host' }
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

      return {
        ok: true,
        diff: {
          toRegister: diff.toRegister.length,
          toUnregister: diff.toUnregister.length
        }
      };
    } finally {
      _reconcilePromise = null;
    }
  })();
  return _reconcilePromise;
}

export async function handleGetConsentAction({
  sender,
  message,
  getStoredSites,
  getStoredTabOverrides
}) {
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

export async function handleSetSiteEnabledAction({
  sender,
  message,
  ensureStorageAccess,
  permissionContains,
  reconcilePermissions,
  activeBatchControllers,
  tabQueues,
  notifyAllWidgetStateChanged
}) {
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

export async function handleEnsureContentAction({
  sender,
  message,
  testMode,
  testEnsureContentOk,
  isTestMode,
  isTestEnsureContentOk,
  ensureStorageAccess,
  getStoredSites,
  getStoredTabOverrides,
  permissionContains
}) {
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

  const inTest = typeof isTestMode === 'function' ? isTestMode() : Boolean(testMode);
  const bypassOk = typeof isTestEnsureContentOk === 'function' ? isTestEnsureContentOk() : (testEnsureContentOk === true);
  // TEST-ONLY bypass
  if (inTest && bypassOk === true) {
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

export async function handleSetTabOverrideAction({
  sender,
  message,
  resolveTabPolicy,
  activeBatchControllers,
  tabQueues,
  notifyAllWidgetStateChanged
}) {
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

export async function handleCancelPendingAction({
  sender,
  message,
  tabEpochs,
  activeBatchControllers,
  tabQueues
}) {
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
  if (message && message.reason === 'pagehide') {
    tabEpochs.delete(tabId);
  }
  return { ok: true, cancelled: cancelledCount };
}
