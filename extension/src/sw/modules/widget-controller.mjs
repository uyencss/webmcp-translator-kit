// WebMCP Translator Kit — Background Module: Widget State Controller
// Manages in-page FAB widget state dispatch, position saving, mode and enable toggles.

import { normalizeOrigin, getEffectivePolicy } from '../../consent.mjs';
import { createTypedError, verifyWidgetSender } from './security.mjs';

export function pushWidgetStateChanged(tabId, state) {
  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'WIDGET_STATE_CHANGED', ...state }).catch(() => {});
    } catch {}
  }
}

export async function notifyAllWidgetStateChanged(patch, getStoredSettings) {
  if (typeof chrome === 'undefined' || !chrome || !chrome.tabs || typeof chrome.tabs.query !== 'function') return;
  let payload = { action: 'WIDGET_STATE_CHANGED' };
  if (patch && typeof patch === 'object') {
    payload = { ...payload, ...patch };
  } else if (typeof getStoredSettings === 'function') {
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

export async function handleWidgetGetStateAction({
  sender,
  ensureStorageAccess,
  getStoredSites,
  getStoredTabOverrides,
  getStoredSettings,
  getStoredApiKey,
  permissionContains,
  resolveEffectiveSiteConfig,
  checkDataConsentAccepted,
  DEFAULT_MODEL,
  normalizeBaseURLKey
}) {
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

export async function handleWidgetSetEnabledAction({
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
  resolveEffectiveSiteConfig
}) {
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

export async function handleWidgetSetModeAction({
  sender,
  message,
  serializeSettingsWrite,
  ensureStorageAccess,
  getStoredSettings,
  bumpConfigRevision,
  translationCache,
  clearPendingL2Writes,
  activeBatchControllers,
  tabQueues,
  migrateSettings,
  notifyAllWidgetStateChanged
}) {
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
      bumpConfigRevision();
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

export async function handleWidgetSetPositionAction({
  sender,
  message,
  ensureStorageAccess
}) {
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
