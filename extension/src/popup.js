// WebMCP Translator Kit — Popup Logic (Taste-Skill Redesign)
// Contract Version: webmcp-translator-contract/1

import { normalizeOrigin, isLoopbackHost, isTailscaleHost, isSecureOrLoopbackBaseURL } from './consent.mjs';
import {
  normalizeBaseURLKey,
  clampTabMaxBatches,
  clampSiteMaxBatches,
  clampProviderConcurrency,
  clampFabSize,
  normalizeFabMascot,
  buildExportConfig,
  parseImportConfig,
  isDataConsentAccepted,
  CURRENT_DATA_CONSENT_VERSION
} from './settings.mjs';
import { t, SUPPORTED_UI_LOCALES } from './i18n.mjs';
import { LANGS, SOURCE_LANGS, TARGET_LANGS, getLanguageLabel } from './languages.mjs';

export const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';
export const RECOMMENDED_MODELS = [
  'ag/gemini-3.1-pro-low',
  'do/glm-5.3-flash',
  'do/deepseek-v4.1-flash',
  'ag/gemini-3.8-flash'
];

import { buildExportPayload, executeExportConfig, saveKeysFromInputs, handleDeleteApiKey } from './popup/modules/config-io.mjs';
import { computePrivacyNoteState, evaluateAutoConsentWarningBranch } from './popup/modules/consent-banner.mjs';
import { setBackgroundInertState, isElementVisibleAndInteractable, trapFocusInModal, getFocusableElementsWithin, configureModalPanels, setupModalAndMenuTriggers } from './popup/modules/modal.mjs';
import { resolveFavKey, getScopedFavorites, filterAvailableModelsToAdd, MAX_FAVORITES_PER_SCOPE } from './popup/modules/models-manager.mjs';
import { setupMascotPicker } from './popup/modules/mascot-picker.mjs';
import { buildRateLimitsConfig, clampRateLimitTunables, collectCleanFallbacks as collectCleanFallbacksModule } from './popup/modules/state.mjs';
import { renderFallbackList } from './popup/modules/fallback-rows.mjs';
import { renderAutoSitesList } from './popup/modules/rules-manager.mjs';
import { showAutoSiteError as showAutoSiteErrorModule, hideAutoSiteError as hideAutoSiteErrorModule, enableSiteForOrigin as enableSiteForOriginModule, refreshSiteDots as refreshSiteDotsModule, commitAutoSite as commitAutoSiteModule, openDraftAutoSite as openDraftAutoSiteModule, createAutoSiteCallbacks } from './popup/modules/auto-sites-controller.mjs';
import { formatElapsed as formatElapsedModule, formatDetail as formatDetailModule, resolveStatusPresentation } from './popup/modules/telemetry.mjs';
import { applyTheme as applyThemeModule, applyFontScale as applyFontScaleModule, applyUiLocale as applyUiLocaleModule, renderLocalizedElements } from './popup/modules/theme-manager.mjs';
import { getPopupElements } from './popup/modules/elements.mjs';
import { populateModelSelect, populateAllModelDropdowns, handleListModelsResponse } from './popup/modules/models-view.mjs';
import { renderFavoritesView, handleAddFavoriteAction } from './popup/modules/favorites-view.mjs';
import { resolveActiveTab as resolveActiveTabModule, evaluateActionReadinessHelper } from './popup/modules/tab-readiness.mjs';
import { setupTabConsentControls } from './popup/modules/tab-consent-controller.mjs';
import { createRateLimitsController } from './popup/modules/rate-limits-controller.mjs';
import { getBaseOrigin as getBaseOriginModule, ensureBaseUrlPermission as ensureBaseUrlPermissionModule, refreshBasePermState as refreshBasePermStateModule, updatePrivacyNote as updatePrivacyNoteModule, updateAutoConsentWarningBanner as updateAutoConsentWarningBannerModule } from './popup/modules/host-permission-manager.mjs';
import { broadcastWidgetPresentationState } from './popup/modules/widget-broadcast.mjs';
import { handleTranslatePage, handleRestorePage } from './popup/modules/page-actions.mjs';
import { renderLogEntryItem } from './popup/modules/log-view.mjs';
import { SVG_ICONS } from './popup/modules/icons.mjs';

export { buildExportPayload };

if (typeof window !== 'undefined') {
  window.DEFAULT_MODEL = DEFAULT_MODEL;
  window.RECOMMENDED_MODELS = RECOMMENDED_MODELS;
  window.buildExportPayload = buildExportPayload;
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    if (document.body) {
      document.body.classList.remove('modal-open');
    }
  const {
    statusStrip, statusIcon, statusText, statusDetail, btnTranslate, btnRestore, keyAccessBanner,
    footerStatusSummary, tabList, tabButtons, tabPanels, logList, btnClearLog, bannerAutoConsentWarning,
    bannerAutoWarningText, btnBannerEnableSite, btnBannerEnableSiteText, bannerConsentUnknown,
    bannerConsentUnknownText, btnConsentRetry, btnConsentRetryText, privacyNote, tabpanelConsent,
    btnConsentAccept, btnConsentDecline, selectUiLocale, selectTheme, selectUiFontScale, btnHeaderMenu,
    menuOverlay, menuBackdrop, menuItemConfig, menuItemLog, menuItemExport, menuItemImport,
    modalOverlay, modalBackdrop, modalTitle, modalCloseBtn, btnExportConfigConnect, btnImportConfigConnect,
    inputImportConfigConnect, inputImportConfig, checkboxExportKeys, inputFabSize, fabSizeValue,
    btnResetFabSize, mascotSelectorGrid, selectFabMascot, selectSrcLang, selectTgtLang,
    siteOriginBadge, toggleSiteConsent, btnOverrideInherit, btnOverrideOn, btnOverrideOff,
    checkboxWidgetVisible, checkboxWidgetVisibleAppearance, saveStateEl, saveDotEl, btnAddCurrentSite, autoSiteError, autoSitesList,
    inputBaseUrl, btnBasePerm, inputApiKey, btnToggleKey, btnDeleteKey, keyStatusIndicator, selectModel,
    btnToggleFavorite, btnRefreshModels, btnAddFallback, fallbackListEl, configMessageConnect,
    inputRateTab, inputRateSite, inputRateConcurrency, rateLimitsHint, subtabNav, subtabButtons,
    configSubpanels, checkboxFavoritesOnly, favoritesSectionTitle, favoritesCountBadge, selectAddFavorite,
    inputAddFavorite, btnAddFavorite, favoritesAddHint, favoritesEmptyHint, favoritesList, configMessageFavorites
  } = getPopupElements(document);

  // Application State
  let activeTab = null;
  let hasStoredKey = false;
  let fallbackKeyPresence = {};
  let pollInterval = null;

  let currentConsent = {
    siteOrigin: null,
    siteEnabled: false,
    tabOverride: null,
    effective: 'off',
    authoritative: false
  };

  let savedSettings = {};
  let discoveredModels = [];
  // Favorites are scoped per provider Base URL (normalized scheme/host,
  // preserved path+port; never keyed by API key). The map is the single
  // source of truth; the primary list is always read from its bucket.
  let favoriteModelsByBaseURL = {};
  let lastFavKey = null; // displayed primary scope; null = Base URL invalid
  let fallbacks = []; // Array of { id, model, baseURL?: string }
  let autoTranslateSites = [];
  let currentMode = 'scroll-follow';
  let activeTabNav = 'tab-translate';
  let currentUiLocale = 'vi';
  let currentTheme = 'dark';
  let currentFontScale = 'md';

  function applyTheme(theme) {
    const th = applyThemeModule(theme, selectTheme);
    currentTheme = th;
  }

  function applyFontScale(scale) {
    const sc = applyFontScaleModule(scale, selectUiFontScale);
    currentFontScale = sc;
  }

  function applyUiLocale(locale) {
    applyUiLocaleModule(locale, selectUiLocale, (loc) => {
      currentUiLocale = loc;
      renderLocalizedStrings();
      renderLanguageDropdowns();
      renderAutoSites();
      renderFallbackRows();
      renderFavoritesSection();
      renderAllModelDropdowns();
      if (typeof updatePrivacyNote === 'function') updatePrivacyNote();
      if (typeof updateAutoConsentWarningBanner === 'function') updateAutoConsentWarningBanner();
      evaluateActionReadiness();
    });
  }

  function renderLanguageDropdowns() {
    if (selectSrcLang) {
      const rawSrc = selectSrcLang.value || (savedSettings && savedSettings.sourceLanguage) || 'auto';
      const curVal = SOURCE_LANGS.some(l => l.code === rawSrc) ? rawSrc : 'auto';
      selectSrcLang.innerHTML = SOURCE_LANGS.map(l =>
        `<option value="${l.code}">${getLanguageLabel(l, currentUiLocale)}</option>`
      ).join('');
      selectSrcLang.value = curVal;
    }
    if (selectTgtLang) {
      const rawTgt = selectTgtLang.value || (savedSettings && savedSettings.targetLanguage) || 'vi';
      const curVal = TARGET_LANGS.some(l => l.code === rawTgt) ? rawTgt : 'vi';
      selectTgtLang.innerHTML = TARGET_LANGS.map(l =>
        `<option value="${l.code}">${getLanguageLabel(l, currentUiLocale)}</option>`
      ).join('');
      selectTgtLang.value = curVal;
    }
  }

  function renderLocalizedStrings() {
    renderLocalizedElements(document, currentUiLocale, t, { selectUiLocale, modalTitle, activeModal });
  }

  function currentFavKey() {
    const raw = inputBaseUrl ? inputBaseUrl.value : (savedSettings.baseURL || '');
    return (typeof resolveFavKey === 'function') ? resolveFavKey(raw) : normalizeBaseURLKey(raw);
  }

  function getFavoritesForKey(key) {
    if (typeof getScopedFavorites === 'function') {
      return getScopedFavorites(favoriteModelsByBaseURL, key);
    }
    const list = key ? favoriteModelsByBaseURL[key] : null;
    return Array.isArray(list) ? [...list] : [];
  }

  function primaryFavorites() {
    return getFavoritesForKey(lastFavKey);
  }

  // Base URL scope for a fallback row: its own Base URL, else the displayed primary.
  // Returns null when the effective URL is invalid (star disabled).
  function favKeyForFallback(fb) {
    const own = (fb && typeof fb.baseURL === 'string') ? fb.baseURL.trim() : '';
    return own ? normalizeBaseURLKey(own) : lastFavKey;
  }

  // Autosave state (no save buttons — every change persists to storage)
  let settingsLoaded = false;
  let autosaveTimer = null;
  let autosaveInFlight = false;
  let autosaveQueued = false;
  let importInProgress = false;
  let favoriteWriteInFlight = false;
  let favoriteWriteQueue = Promise.resolve();
  const autosaveIdleWaiters = [];

  // Key Access Banner (Safety fail-closed)
  function showKeyAccessBanner() {
    if (keyAccessBanner) keyAccessBanner.style.display = 'flex';
    if (btnTranslate) btnTranslate.disabled = true;
    if (btnRefreshModels) btnRefreshModels.disabled = true;
    if (selectModel) selectModel.disabled = true;
  }

  // Polling for Status
  function startPolling() {
    if (!pollInterval) pollInterval = setInterval(() => checkTabStatus(), 600);
  }
  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // UI Status Indicator (Single-line icon + text + tooltip).
  // Watching/translating states embed live applied/collected (+ failed) counts
  // in the visible footer text so progress is readable without tooltips.
  function updateStatus(state, detail = '', data = null) {
    // status_watching_count
    const { iconSvg, shortText, fullDetail } = resolveStatusPresentation(state, detail, data, {
      currentUiLocale,
      t,
      SVG_ICONS
    });

    if (statusIcon) statusIcon.innerHTML = iconSvg;
    if (statusText) statusText.textContent = shortText;
    if (statusStrip) {
      statusStrip.title = fullDetail;
      statusStrip.classList.toggle('has-error', state === 'error');
    }
    // Footer slot mirrors live scroll progress (applied/collected + failed);
    // version string otherwise. Never shows a completed state while watching —
    // callers keep the watching branch ahead of the done branch.
    if (footerStatusSummary) {
      const showProgress = state === 'watching' ||
        (state === 'translated' && data && typeof data.totalCollected === 'number' && data.totalCollected > 0) ||
        (state === 'error' && data && data.totalFailed > 0);
      if (showProgress && data && typeof data.totalCollected === 'number' && data.totalCollected > 0) {
        const fApplied = Math.min(data.totalApplied || 0, data.totalCollected);
        const fFailed = (typeof data.totalFailed === 'number' && data.totalFailed > 0) ? ' ' + t(currentUiLocale, 'status_failed_count', { count: data.totalFailed }) : '';
        footerStatusSummary.textContent = `v0.1.2 · ${fApplied}/${data.totalCollected}${fFailed}`;
      } else {
        footerStatusSummary.textContent = 'v0.1.2';
      }
    }
  }

  // Toast / Status Message Helpers
  function setConfigMsg(targetEl, msg, isError = false) {
    if (!targetEl) return;
    targetEl.textContent = msg;
    targetEl.className = 'config-message ' + (isError ? 'error' : 'success');
    setTimeout(() => { if (targetEl.textContent === msg) targetEl.textContent = ''; }, 4000);
  }

  // Promise wrapper for runtime messages
  function sendMsg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          resolve(err ? { error: { code: 'RUNTIME_MESSAGE_FAILED', message: err.message || 'Extension message failed' } } : response);
        });
      } catch (err) {
        resolve({ error: { code: 'ERROR', message: String((err && err.message) || err) } });
      }
    });
  }

  // Autosave indicator state
  function setSaveState(state, title) {
    if (!saveStateEl) return;
    saveStateEl.dataset.state = state;
    saveStateEl.title = title || (state === 'saved' ? t(currentUiLocale, 'save_saved') : state === 'saving' ? t(currentUiLocale, 'save_saving') : state === 'error' ? t(currentUiLocale, 'save_error') : t(currentUiLocale, 'save_default'));
  }

  function collectCleanFallbacks() {
    return collectCleanFallbacksModule({ fallbacks, doc: document, isSecureOrLoopbackBaseURL, currentUiLocale, t, DEFAULT_MODEL });
  }

  function collectSettingsPatch() {
    const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : '';
    if (rawUrl) {
      if (!/^https?:\/\/.+/i.test(rawUrl)) {
        return { patch: null, error: t(currentUiLocale, 'err_base_url_protocol') };
      }
      if (!isSecureOrLoopbackBaseURL(rawUrl)) {
        return { patch: null, error: t(currentUiLocale, 'privacy_note_insecure') };
      }
    }
    const fbRes = collectCleanFallbacks();
    if (fbRes.error) return { patch: null, error: fbRes.error };
    // Favorites are saved only by their star controls. A full form patch must
    // not echo a stale popup map over changes made in another open popup.
    const patch = {
      sourceLanguage: selectSrcLang ? selectSrcLang.value : 'auto',
      targetLanguage: selectTgtLang ? selectTgtLang.value : 'vi',
      widgetVisible: checkboxWidgetVisible ? Boolean(checkboxWidgetVisible.checked) : (checkboxWidgetVisibleAppearance ? Boolean(checkboxWidgetVisibleAppearance.checked) : true),
      uiLocale: selectUiLocale ? selectUiLocale.value : (savedSettings.uiLocale || 'vi'),
      theme: selectTheme ? selectTheme.value : (savedSettings.theme || 'dark'),
      uiFontScale: selectUiFontScale ? selectUiFontScale.value : (savedSettings.uiFontScale || 'md'),
      fabSize: inputFabSize ? clampFabSize(inputFabSize.value) : (savedSettings.fabSize ?? 1.0),
      fabMascot: selectFabMascot ? selectFabMascot.value : (savedSettings.fabMascot || 'default'),
      showFavoritesOnly: checkboxFavoritesOnly ? Boolean(checkboxFavoritesOnly.checked) : false,
      exportIncludeKeys: checkboxExportKeys ? Boolean(checkboxExportKeys.checked) : (typeof savedSettings.exportIncludeKeys === 'boolean' ? savedSettings.exportIncludeKeys : true),
      model: selectModel && selectModel.value ? selectModel.value : (savedSettings.model || DEFAULT_MODEL),
      fallbacks: fbRes.fallbacks,
      autoTranslateSites: JSON.parse(JSON.stringify(autoTranslateSites))
    };
    if (rawUrl) patch.baseURL = rawUrl;

    if (inputRateTab || inputRateSite || inputRateConcurrency) {
      const rlConfig = buildRateLimitsConfig({
        tabBatches: inputRateTab ? inputRateTab.value : (savedSettings.rateLimits?.tab?.maxBatches || 4),
        siteBatches: inputRateSite ? inputRateSite.value : (savedSettings.rateLimits?.site?.maxBatches || 12),
        concurrency: inputRateConcurrency ? inputRateConcurrency.value : (savedSettings.providerConcurrency || 2),
        savedLimits: savedSettings.rateLimits
      });
      patch.providerConcurrency = rlConfig.providerConcurrency;
      patch.rateLimits = rlConfig.rateLimits;
    }

    return { patch, error: null };
  }

  // Autosave: persist every UI change to storage (debounced for typing).
  // Host permission requests NEVER happen here (no gesture) — they live in
  // explicit buttons (site toggle, + Current page, base shield, Translate).
  function getSettingsNotLoadedMsg() { return t(currentUiLocale, 'err_settings_not_loaded'); }

  function waitForAutosaveIdle() {
    if (!autosaveInFlight) return Promise.resolve();
    return new Promise(resolve => autosaveIdleWaiters.push(resolve));
  }

  function notifyAutosaveIdleWaiters() {
    if (autosaveInFlight) return;
    autosaveIdleWaiters.splice(0).forEach(resolve => resolve());
  }

  function saveFavoriteToggle(scopeKey, model, favorite) {
    const operation = favoriteWriteQueue.then(async () => {
      if (!settingsLoaded) throw new Error(getSettingsNotLoadedMsg());
      if (typeof favorite !== 'boolean') throw new Error(t(currentUiLocale, 'err_favorite_invalid'));

      let saveFormAfter = Boolean(autosaveTimer);
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      await waitForAutosaveIdle();
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
        saveFormAfter = true;
      }

      favoriteWriteInFlight = true;
      try {
        const settings = { favoriteToggle: { scopeKey, model, favorite } };
        const response = await new Promise(resolve => {
          try {
            chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings }, value => {
              const lastError = chrome.runtime.lastError;
              resolve(lastError ? { error: { message: lastError.message } } : value);
            });
          } catch (err) {
            resolve({ error: { message: String((err && err.message) || err) } });
          }
        });
        if (!response || response.error) {
          throw new Error(response?.error?.message || t(currentUiLocale, 'err_favorite_save_failed'));
        }
        const favoriteToggle = response.favoriteToggle;
        if (favoriteToggle?.scopeKey !== scopeKey || !Array.isArray(favoriteToggle.favorites)) {
          throw new Error(t(currentUiLocale, 'err_favorite_response_invalid'));
        }
        favoriteModelsByBaseURL = {
          ...favoriteModelsByBaseURL,
          [scopeKey]: [...favoriteToggle.favorites]
        };
        savedSettings.favoriteModelsByBaseURL = JSON.parse(JSON.stringify(favoriteModelsByBaseURL));
        savedSettings.favoriteModels = primaryFavorites();
        return [...favoriteToggle.favorites];
      } finally {
        favoriteWriteInFlight = false;
        if (saveFormAfter) autosaveQueued = true;
        if (autosaveQueued) {
          autosaveQueued = false;
          flushAutosave();
        }
      }
    });
    favoriteWriteQueue = operation.catch(() => {});
    return operation;
  }

  async function flushAutosave() {
    if (importInProgress || !settingsLoaded) return;
    if (favoriteWriteInFlight) {
      autosaveQueued = true;
      return;
    }
    if (autosaveInFlight) {
      autosaveQueued = true;
      return;
    }
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    autosaveInFlight = true;
    setSaveState('saving');
    try {
      const { patch, error } = collectSettingsPatch();
      if (error) {
        setSaveState('error', error);
        setConfigMsg(configMessageConnect, error, true);
        return;
      }
      const saveResp = await sendMsg({ action: 'SAVE_SETTINGS', settings: patch });
      if (chrome.runtime.lastError || !saveResp || saveResp.error) {
        const err = (saveResp && saveResp.error) || chrome.runtime.lastError || {};
        throw new Error((err && err.message) || t(currentUiLocale, 'err_save_settings_failed'));
      }
      savedSettings = { ...savedSettings, ...patch };
      if (typeof updatePrivacyNote === 'function') updatePrivacyNote(savedSettings.baseURL);

      await saveKeysFromInputs({
        inputApiKey, fallbacks, sendMsg, fallbackKeyPresence, currentUiLocale, t,
        keyStatusIndicator, onPrimaryStored: () => { hasStoredKey = true; }
      });

      setSaveState('saved');
      evaluateActionReadiness();
      if (inputBaseUrl) refreshBasePermState();
    } catch (err) {
      const msg = (err && err.message) || t(currentUiLocale, 'err_save_settings_failed');
      setSaveState('error', msg);
      setConfigMsg(configMessageConnect, msg, true);
    } finally {
      autosaveInFlight = false;
      if (autosaveQueued && !favoriteWriteInFlight) {
        autosaveQueued = false;
        flushAutosave();
      }
      notifyAutosaveIdleWaiters();
    }
  }

  function markDirty() {
    if (importInProgress || !settingsLoaded) return;
    setSaveState('saving');
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      flushAutosave();
    }, 600);
  }

  // Settings Menu & Modal Controller
  let activeModal = null; // 'config' | 'log' | null
  let modalOpenerEl = null;

  function isModalOpen() {
    return Boolean(modalOverlay && modalOverlay.style.display !== 'none');
  }

  function setBackgroundInert(inert) {
    const backgroundElements = [
      document.querySelector('.header'),
      document.getElementById('tabpanel-translate'),
      document.getElementById('tabpanel-auto'),
      document.querySelector('.footer')
    ].filter(Boolean);
    setBackgroundInertState(inert, backgroundElements);
  }

  function isElementVisibleAndEnabled(el) {
    if (modalOverlay && (el === modalOverlay || (typeof modalOverlay.contains === 'function' && modalOverlay.contains(el)))) {
      return false;
    }
    return isElementVisibleAndInteractable(el, [modalOverlay, menuOverlay]);
  }

  function restoreFocusAfterModal() {
    let focusSucceeded = false;
    if (isElementVisibleAndEnabled(modalOpenerEl)) {
      try {
        modalOpenerEl.focus();
        if (typeof document !== 'undefined' && document && 'activeElement' in document) {
          if (document.activeElement === modalOpenerEl) {
            focusSucceeded = true;
          }
        } else {
          focusSucceeded = true;
        }
      } catch {
        focusSucceeded = false;
      }
    }

    if (!focusSucceeded) {
      if (btnHeaderMenu && typeof btnHeaderMenu.focus === 'function') {
        try {
          btnHeaderMenu.focus();
        } catch {}
      }
    }
  }

  function getModalFocusableElements() {
    return isModalOpen() ? getFocusableElementsWithin(modalOverlay) : [];
  }

  function handleModalFocusTrap(e) {
    trapFocusInModal(e, modalOverlay, modalCloseBtn);
  }

  function openMenu() {
    if (!menuOverlay) return;
    menuOverlay.style.display = 'flex';
    menuOverlay.setAttribute('aria-hidden', 'false');
    if (btnHeaderMenu) btnHeaderMenu.setAttribute('aria-expanded', 'true');
    if (menuItemConfig) menuItemConfig.focus();
  }

  function closeMenu() {
    if (!menuOverlay) return;
    menuOverlay.style.display = 'none';
    menuOverlay.setAttribute('aria-hidden', 'true');
    if (btnHeaderMenu) {
      btnHeaderMenu.setAttribute('aria-expanded', 'false');
      btnHeaderMenu.focus();
    }
  }

  function toggleMenu() {
    if (menuOverlay && menuOverlay.style.display !== 'none') {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function openModal(modalType, options = {}) {
    const isAlreadyOpen = isModalOpen() || Boolean(activeModal);
    if (!isAlreadyOpen || !modalOpenerEl) {
      if (options && options.opener && (!modalOverlay || (options.opener !== modalOverlay && (typeof modalOverlay.contains !== 'function' || !modalOverlay.contains(options.opener))))) {
        modalOpenerEl = options.opener;
      } else if (document.activeElement && document.activeElement !== document.body && (!menuOverlay || (typeof menuOverlay.contains === 'function' ? !menuOverlay.contains(document.activeElement) : true)) && (!modalOverlay || (typeof modalOverlay.contains === 'function' ? !modalOverlay.contains(document.activeElement) : true))) {
        modalOpenerEl = document.activeElement;
      } else {
        modalOpenerEl = btnHeaderMenu;
      }
    }

    closeMenu();
    if (!modalOverlay) return;
    activeModal = modalType;
    modalOverlay.style.display = 'flex';
    modalOverlay.setAttribute('aria-hidden', 'false');
    if (document.body) {
      document.body.classList.add('modal-open');
    }
    setBackgroundInert(true);

    if (!configureModalPanels(modalType, { tabPanels, modalTitle, currentUiLocale, t, loadErrorLog, options, closeModal })) {
      return;
    }

    if (modalCloseBtn) modalCloseBtn.focus();
  }

  function closeModal() {
    if (document.body) {
      document.body.classList.remove('modal-open');
    }
    if (!modalOverlay) return;
    activeModal = null;
    modalOverlay.style.display = 'none';
    modalOverlay.setAttribute('aria-hidden', 'true');
    setBackgroundInert(false);
    if (tabPanels['tab-config']) tabPanels['tab-config'].classList.add('hidden');
    if (tabPanels['tab-log']) tabPanels['tab-log'].classList.add('hidden');
    if (tabPanels['tab-consent']) tabPanels['tab-consent'].classList.add('hidden');
    if (activeTabNav === 'tab-config' || activeTabNav === 'tab-log') {
      switchTab('tab-translate');
    }
    restoreFocusAfterModal();
    modalOpenerEl = null;
  }

  async function triggerExportConfig() {
    const options = arguments[0] || {};
    return executeExportConfig(options, {
      checkboxExportKeys,
      savedSettings,
      inputApiKey,
      hasStoredKey,
      currentUiLocale,
      t,
      updateStatus
    });
  }

  async function triggerImportConfig(file) {
    if (!file) return;
    let settingsSaved = false;
    const lockedControls = [];
    try {
      if (file.size > 1_000_000) throw new Error('Configuration file is too large');
      const imported = parseImportConfig(await file.text());
      const confirmFn = (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm
        : (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function' ? globalThis.confirm : null);
      const confirmMessage = t(currentUiLocale, imported.includesKeys ? 'import_json_keys_confirm' : 'import_json_confirm');
      if (!confirmFn || !confirmFn(confirmMessage)) return;

      // The confirmed import replaces pending edits, so let any active save
      // finish, then persist the imported snapshot through the normal API.
      importInProgress = true;
      const configPanel = tabPanels['tab-config'];
      if (configPanel && typeof configPanel.querySelectorAll === 'function') {
        for (const control of configPanel.querySelectorAll('button, input, select, textarea')) {
          lockedControls.push([control, Boolean(control.disabled)]);
          control.disabled = true;
        }
      }
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      await favoriteWriteQueue;
      await waitForAutosaveIdle();
      const saveResponse = await sendMsg({
        action: 'SAVE_SETTINGS',
        settings: imported.settings,
        replaceFavoriteModelsByBaseURL: true
      });
      if (!saveResponse || saveResponse.error) throw new Error(saveResponse?.error?.message || 'Settings save failed');
      settingsSaved = true;

      if (imported.apiKey) {
        const keyResponse = await sendMsg({ action: 'SET_KEY', key: imported.apiKey });
        if (!keyResponse || keyResponse.error) throw new Error(keyResponse?.error?.message || 'API key save failed');
      }
      for (const [id, key] of Object.entries(imported.fallbackApiKeys)) {
        const keyResponse = await sendMsg({ action: 'SET_FALLBACK_KEY', id, key });
        if (!keyResponse || keyResponse.error) throw new Error(keyResponse?.error?.message || 'Fallback API key save failed');
      }

      if (inputApiKey) inputApiKey.value = '';
      await loadSettings();
      setConfigMsg(configMessageConnect, t(currentUiLocale, 'import_json_success'));
    } catch (err) {
      console.warn('[popup] Import JSON failed:', err);
      if (settingsSaved) {
        if (inputApiKey) inputApiKey.value = '';
        await loadSettings();
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'import_json_partial'), true);
      } else {
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'import_json_failed'), true);
      }
    } finally {
      importInProgress = false;
      for (const [control, wasDisabled] of lockedControls) control.disabled = wasDisabled;
      if (settingsSaved) {
        try { renderFallbackRows(); } catch {}
        try { renderAllModelDropdowns(); } catch {}
        evaluateActionReadiness();
      }
      if (inputImportConfigConnect) inputImportConfigConnect.value = '';
    }
  }

  if (typeof window !== 'undefined') {
    window.triggerImportConfig = triggerImportConfig;
  }

  function broadcastWidgetPresentation(patch = {}) {
    const currentMascot = selectFabMascot ? selectFabMascot.value : 'default';
    const currentSize = inputFabSize ? (parseFloat(inputFabSize.value) || 1.0) : 1.0;
    broadcastWidgetPresentationState({
      selectFabMascot,
      inputFabSize,
      selectTheme,
      currentUiLocale,
      patch: {
        isPresentation: true,
        fabMascot: currentMascot,
        fabSize: currentSize,
        ...patch
      }
    });
  }

  const mascotPicker = setupMascotPicker({
    mascotSelectorGrid,
    selectFabMascot,
    inputFabSize,
    fabSizeValue,
    btnResetFabSize,
    onPresentationChange: (opts) => broadcastWidgetPresentation(opts),
    onDirty: () => {
      flushAutosave();
      markDirty();
    },
    attachListeners: false
  });

  function updateFabSizeDisplay(val, options = {}) {
    mascotPicker.updateFabSizeDisplay(val, options);
  }

  function applyFabMascot(mascot, options = {}) {
    mascotPicker.applyFabMascot(mascot, options);
  }

  // Tab Navigation Controller (with roving tabindex & sessionStorage memory)
  function switchTab(targetTabId, subSection) {
    if (targetTabId === 'tab-config') {
      if (typeof openModal === 'function' && modalOverlay) {
        openModal('config');
        if (subSection) switchConfigSubtab(subSection);
      }
    } else if (targetTabId === 'tab-log') {
      if (typeof openModal === 'function' && modalOverlay) {
        openModal('log');
      }
    } else {
      if (isModalOpen()) {
        closeModal();
      }
    }

    if (!tabPanels[targetTabId]) targetTabId = 'tab-translate';
    activeTabNav = targetTabId;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('active_translator_tab', targetTabId);
      }
    } catch (err) {
      console.warn('[popup] Failed to persist active_translator_tab:', err);
    }

    for (const btn of tabButtons) {
      const isSelected = btn.id === targetTabId;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
      btn.classList.toggle('active', isSelected);
    }

    for (const [panelTabId, panelEl] of Object.entries(tabPanels)) {
      if (panelEl) {
        panelEl.classList.toggle('hidden', panelTabId !== targetTabId);
      }
    }

    if (targetTabId === 'tab-config' && subSection) {
      switchConfigSubtab(subSection);
    }

    if (targetTabId === 'tab-log') {
      loadErrorLog();
    }
  }

  async function loadErrorLog({ highlightFirst = false } = {}) {
    if (!logList) return;
    try {
      let entries = [];
      try {
        const resp = await sendMsg({ action: 'GET_ERROR_LOG' });
        if (resp && resp.ok && Array.isArray(resp.entries) && resp.entries.length > 0) {
          entries = resp.entries;
        }
      } catch {}

      if (entries.length === 0 && typeof chrome !== 'undefined' && chrome.storage) {
        if (chrome.storage.local) {
          try {
            const stored = await chrome.storage.local.get(['errorLog']);
            if (Array.isArray(stored?.errorLog) && stored.errorLog.length > 0) {
              entries = stored.errorLog;
            }
          } catch {}
        }
        if (entries.length === 0 && chrome.storage.session) {
          try {
            const stored = await chrome.storage.session.get(['errorLog']);
            if (Array.isArray(stored?.errorLog) && stored.errorLog.length > 0) {
              entries = stored.errorLog;
            }
          } catch {}
        }
      }

      logList.innerHTML = '';
      if (entries.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'log-empty';
        emptyDiv.textContent = t(currentUiLocale, 'log_empty');
        logList.appendChild(emptyDiv);
        return;
      }
      entries.forEach((entry, idx) => {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn btn-xs btn-outline log-retry-btn';
        retryBtn.textContent = t(currentUiLocale, 'log_retry');
        retryBtn.addEventListener('click', () => {
          closeModal();
          switchTab('tab-translate');
          if (btnTranslate && !btnTranslate.disabled) {
            btnTranslate.click();
          }
        });
        const item = renderLogEntryItem(entry, idx, highlightFirst, retryBtn);
        logList.appendChild(item);
      });
    } catch {}
  }

  if (btnClearLog) {
    btnClearLog.addEventListener('click', async () => {
      await sendMsg({ action: 'CLEAR_ERROR_LOG' });
      if (logList) {
        logList.innerHTML = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'log-empty';
        emptyDiv.textContent = t(currentUiLocale, 'log_empty');
        logList.appendChild(emptyDiv);
      }
    });
  }

  if (statusStrip) {
    statusStrip.addEventListener('click', () => {
      if (statusStrip.classList.contains('has-error')) {
        if (typeof openModal === 'function' && modalOverlay) openModal('log');
        else switchTab('tab-log');
      }
    });
  }

  if (tabList) {
    tabList.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (btn && btn.id) {
        if (isModalOpen()) closeModal();
        switchTab(btn.id);
      }
    });

    tabList.addEventListener('keydown', (e) => {
      const currentIdx = tabButtons.findIndex(b => b.id === activeTabNav);
      if (currentIdx === -1) return;
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % tabButtons.length;
      else if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + tabButtons.length) % tabButtons.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabButtons.length - 1;

      if (nextIdx !== -1) {
        e.preventDefault();
        const nextBtn = tabButtons[nextIdx];
        if (isModalOpen()) closeModal();
        switchTab(nextBtn.id);
        nextBtn.focus();
      }
    });
  }

  // Config Sub-menu Navigation & Favorites Management (WI-21)
  let activeConfigSubtab = 'connect';

  function switchConfigSubtab(targetSubtabId) {
    activeConfigSubtab = targetSubtabId;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('active_config_subtab', targetSubtabId);
      }
    } catch (err) {
      console.warn('[popup] Failed to persist active_config_subtab to sessionStorage:', err);
    }

    for (const btn of subtabButtons) {
      const isSelected = btn.dataset.subtab === targetSubtabId || btn.id === `subtab-${targetSubtabId}`;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
      btn.classList.toggle('active', isSelected);
    }

    for (const [subtabKey, panelEl] of Object.entries(configSubpanels)) {
      if (panelEl) {
        panelEl.classList.toggle('hidden', subtabKey !== targetSubtabId);
      }
    }

    if (targetSubtabId === 'favorites') {
      renderFavoritesSection();
    }
  }

  // Restore remembered tab in current popup session (one-time compatibility migration for legacy tab-connect)
  try {
    let rememberedTab = sessionStorage.getItem('active_translator_tab');
    if (rememberedTab === 'tab-connect') {
      // One-time compatibility migration from legacy tab-connect to tab-config + connect subtab
      rememberedTab = 'tab-config';
      try {
        sessionStorage.setItem('active_translator_tab', 'tab-config');
        sessionStorage.setItem('active_config_subtab', 'connect');
      } catch (err) {
        console.warn('[popup] Failed to persist migrated tab state to sessionStorage:', err);
      }
      switchConfigSubtab('connect');
    }
    if (rememberedTab === 'tab-config') {
      if (typeof openModal === 'function' && modalOverlay) {
        openModal('config');
      }
      switchTab('tab-config');
    } else if (rememberedTab === 'tab-log') {
      if (typeof openModal === 'function' && modalOverlay) {
        openModal('log');
      }
      switchTab('tab-log');
    } else if (rememberedTab && tabPanels[rememberedTab]) {
      switchTab(rememberedTab);
    }
  } catch (err) {
    console.warn('[popup] Failed to restore remembered tab:', err);
  }

  function getAvailableModelsToAdd(scopeKey) {
    return filterAvailableModelsToAdd({
      scopeKey,
      favoriteModelsByBaseURL,
      recommendedModels: RECOMMENDED_MODELS,
      discoveredModels
    });
  }

  function renderFavoritesSection() {
    const scopeKey = currentFavKey();
    const bucket = getFavoritesForKey(scopeKey);
    const availableModels = getAvailableModelsToAdd(scopeKey);

    renderFavoritesView({
      favoritesList,
      favoritesCountBadge,
      favoritesSectionTitle,
      favoritesEmptyHint,
      selectAddFavorite,
      btnAddFavorite,
      favoritesAddHint,
      configMessageFavorites,
      scopeKey,
      bucket,
      availableModels,
      recommendedModels: RECOMMENDED_MODELS,
      currentUiLocale,
      SVG_ICONS,
      t,
      setConfigMsg,
      saveFavoriteToggle,
      onAfterChange: () => {
        // saveFavoriteToggle(scopeKey, modelId, false)
        renderFavoritesSection();
        renderAllModelDropdowns();
      }
    });
  }

  async function handleAddFavorite() {
    if (!selectAddFavorite) return;
    const modelId = selectAddFavorite.value.trim();
    if (!modelId) {
      setConfigMsg(configMessageFavorites, t(currentUiLocale, 'err_favorite_model_empty'), true);
      selectAddFavorite.focus();
      return;
    }
    const scopeKey = currentFavKey();
    if (!scopeKey) {
      setConfigMsg(configMessageFavorites, t(currentUiLocale, 'fav_need_base_url'), true);
      return;
    }
    const bucket = getFavoritesForKey(scopeKey);
    if (bucket.length >= 50 && !bucket.includes(modelId)) {
      setConfigMsg(configMessageFavorites, t(currentUiLocale, 'err_favorite_cap_reached'), true);
      return;
    }
    return handleAddFavoriteAction({
      selectAddFavorite, btnAddFavorite, configMessageFavorites, scopeKey, bucket,
      t, currentUiLocale, setConfigMsg, saveFavoriteToggle,
      onAfterChange: () => {
        // saveFavoriteToggle(scopeKey, modelId, true);
        renderFavoritesSection();
        updateStarButton();
        renderAllModelDropdowns();
      },
      getAvailableModelsToAdd
    });
  }

  if (btnAddFavorite) {
    btnAddFavorite.addEventListener('click', handleAddFavorite);
  }
  if (selectAddFavorite) {
    selectAddFavorite.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddFavorite();
      }
    });
  }

  if (checkboxFavoritesOnly) {
    checkboxFavoritesOnly.addEventListener('change', () => {
      savedSettings.showFavoritesOnly = Boolean(checkboxFavoritesOnly.checked);
      renderAllModelDropdowns();
      markDirty();
    });
  }

  if (subtabNav) {
    subtabNav.addEventListener('click', (e) => {
      const btn = e.target.closest('.subtab-btn');
      if (btn) switchConfigSubtab(btn.dataset.subtab || btn.id.replace('subtab-', ''));
    });

    subtabNav.addEventListener('keydown', (e) => {
      const currentIdx = subtabButtons.findIndex(b => (b.dataset.subtab === activeConfigSubtab || b.id === `subtab-${activeConfigSubtab}`));
      if (currentIdx === -1) return;
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % subtabButtons.length;
      else if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + subtabButtons.length) % subtabButtons.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = subtabButtons.length - 1;

      if (nextIdx !== -1) {
        e.preventDefault();
        const nextBtn = subtabButtons[nextIdx];
        switchConfigSubtab(nextBtn.dataset.subtab || nextBtn.id.replace('subtab-', ''));
        nextBtn.focus();
      }
    });
  }

  // Restore remembered config subtab
  try {
    const rememberedSubtab = sessionStorage.getItem('active_config_subtab');
    switchConfigSubtab(rememberedSubtab && configSubpanels[rememberedSubtab] ? rememberedSubtab : 'connect');
  } catch (err) {
    console.warn('[popup] Failed to restore remembered config subtab:', err);
    switchConfigSubtab('connect');
  }

  if (typeof window !== 'undefined') {
    window.switchConfigSubtab = switchConfigSubtab;
    window.renderFavoritesSection = renderFavoritesSection;
    window.getAvailableModelsToAdd = getAvailableModelsToAdd;
    window.handleAddFavorite = handleAddFavorite;
  }

  // Active Tab Discovery
  async function resolveActiveTab() {
    return resolveActiveTabModule({
      getActiveTab: () => activeTab, setActiveTab: (tab) => { activeTab = tab; },
      btnTranslate, btnRestore, updateStatus, toggleSiteConsent,
      btnOverrideInherit, btnOverrideOn, btnOverrideOff, siteOriginBadge,
      currentUiLocale, t
    });
  }

  function setTranslateBusy(busy) {
    if (!btnTranslate) return;
    btnTranslate.disabled = busy;
    const textSpan = btnTranslate.querySelector('.btn-text');
    if (textSpan) textSpan.textContent = busy ? t(currentUiLocale, 'btn_translating') : t(currentUiLocale, 'btn_translate_page');
  }

  function evaluateActionReadiness(restorableCount = 0) {
    evaluateActionReadinessHelper(restorableCount, {
      activeTab, hasStoredKey, savedSettings, inputBaseUrl, selectModel,
      btnTranslate, btnRestore, statusText, currentUiLocale, t,
      setTranslateBusy, updateStatus
    });
  }

  // Consent Management
  function setConsentUnknownUI(show) {
    if (!bannerConsentUnknown) return;
    bannerConsentUnknown.classList.toggle('hidden', !show);
    if (show) {
      if (bannerConsentUnknownText) bannerConsentUnknownText.textContent = t(currentUiLocale, 'consent_state_unknown');
      if (btnConsentRetryText) btnConsentRetryText.textContent = t(currentUiLocale, 'log_retry');
    }
  }

  async function loadConsent() {
    if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
      if (toggleSiteConsent) toggleSiteConsent.disabled = true;
      if (btnOverrideInherit) btnOverrideInherit.disabled = true;
      if (btnOverrideOn) btnOverrideOn.disabled = true;
      if (btnOverrideOff) btnOverrideOff.disabled = true;
      if (siteOriginBadge) { siteOriginBadge.textContent = '--'; siteOriginBadge.classList.add('unsupported'); }
      currentConsent = { siteOrigin: null, siteEnabled: false, tabOverride: null, effective: 'off', authoritative: false };
      setConsentUnknownUI(false);
      updateAutoConsentWarningBanner();
      return null;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_CONSENT', tabId: activeTab.id }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          if (resp && resp.error && resp.error.code === 'KEY_ACCESS_UNAVAILABLE') showKeyAccessBanner();
          currentConsent = { siteOrigin: null, siteEnabled: false, tabOverride: null, effective: 'off', authoritative: false };
          if (siteOriginBadge) { siteOriginBadge.textContent = '--'; siteOriginBadge.classList.add('unsupported'); }
          setConsentUnknownUI(true);
          updateAutoConsentWarningBanner();
          updateStatus('error', t(currentUiLocale, 'consent_state_unknown'));
          resolve(null);
          return;
        }

        currentConsent = { ...resp, authoritative: true };
        setConsentUnknownUI(false);
        if (siteOriginBadge) { siteOriginBadge.textContent = resp.siteOrigin || '--'; siteOriginBadge.classList.remove('unsupported'); }
        if (toggleSiteConsent) {
          toggleSiteConsent.disabled = !resp.siteOrigin;
          toggleSiteConsent.checked = Boolean(resp.siteEnabled);
        }

        if (btnOverrideInherit && btnOverrideOn && btnOverrideOff) {
          btnOverrideInherit.disabled = !resp.siteOrigin;
          btnOverrideOn.disabled = !resp.siteOrigin;
          btnOverrideOff.disabled = !resp.siteOrigin;
          btnOverrideInherit.classList.toggle('active', resp.tabOverride === null || resp.tabOverride === undefined);
          btnOverrideOn.classList.toggle('active', resp.tabOverride === 'on');
          btnOverrideOff.classList.toggle('active', resp.tabOverride === 'off');
        }

        updateAutoConsentWarningBanner();
        resolve(resp);
      });
    });
  }

  const { updateTabOverride } = setupTabConsentControls({
    getActiveTab: () => activeTab,
    getCurrentConsent: () => currentConsent,
    toggleSiteConsent,
    btnOverrideInherit,
    btnOverrideOn,
    btnOverrideOff,
    currentUiLocale,
    t,
    updateStatus,
    loadConsent,
    checkTabStatus
  });

  // Model Dropdown Builder (favorites group is Base URL scoped via `favs`)
  function populateSelect(selectEl, selectedVal, options = {}) {
    const showFavsOnly = Boolean(savedSettings && savedSettings.showFavoritesOnly);
    // fav_empty_hint_dropdown
    populateModelSelect(selectEl, selectedVal, {
      ...options,
      savedSettings,
      primaryFavorites,
      currentUiLocale,
      discoveredModels,
      RECOMMENDED_MODELS,
      DEFAULT_MODEL,
      t
    });
  }

  function updateStarButton() {
    if (!btnToggleFavorite || !selectModel) return;
    const curVal = selectModel.value;
    const liveKey = currentFavKey();
    const isFav = getFavoritesForKey(liveKey).includes(curVal);
    btnToggleFavorite.innerHTML = isFav ? SVG_ICONS.starFilled : SVG_ICONS.star;
    btnToggleFavorite.classList.toggle('favorited', isFav);
    btnToggleFavorite.disabled = !liveKey;
    btnToggleFavorite.title = !liveKey
      ? t(currentUiLocale, 'fav_need_base_url')
      : (isFav ? t(currentUiLocale, 'fav_remove') : t(currentUiLocale, 'fav_add'));
  }

  // Fallback row star reflects the row's own Base URL scope (own URL else primary)
  function updateFallbackStar(btn, fb, modelSelect) {
    if (!btn) return;
    const scopeKey = favKeyForFallback(fb);
    const bucket = getFavoritesForKey(scopeKey);
    const curVal = (modelSelect && modelSelect.value) || (fb && fb.model) || '';
    const isFav = curVal ? bucket.includes(curVal) : false;
    btn.innerHTML = isFav ? SVG_ICONS.starFilled : SVG_ICONS.star;
    btn.classList.toggle('favorited', isFav);
    btn.disabled = !scopeKey;
    btn.title = !scopeKey
      ? t(currentUiLocale, 'fav_need_base_url')
      : (isFav ? t(currentUiLocale, 'fav_remove') : t(currentUiLocale, 'fav_add'));
  }

  // Favorite Star Toggle Action (Sends partial SAVE_SETTINGS)
  if (btnToggleFavorite) {
    btnToggleFavorite.addEventListener('click', async () => {
      const curVal = selectModel?.value;
      if (!curVal) return;
      if (!settingsLoaded) {
        setConfigMsg(configMessageConnect, getSettingsNotLoadedMsg(), true);
        return;
      }

      const scopeKey = currentFavKey();
      if (!scopeKey) return;
      btnToggleFavorite.disabled = true;
      try {
        const desiredFavorite = !getFavoritesForKey(scopeKey).includes(curVal);
        await saveFavoriteToggle(scopeKey, curVal, desiredFavorite);
        // Align displayed scope to the live input without persisting baseURL:
        // the star must not autosave or otherwise change the configured URL.
        const liveScopeKey = currentFavKey();
        if (liveScopeKey !== lastFavKey) {
          lastFavKey = liveScopeKey;
          savedSettings.favoriteModels = getFavoritesForKey(lastFavKey);
        }
        renderAllModelDropdowns();
        if (typeof renderFavoritesSection === 'function') renderFavoritesSection();
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'fav_saved'));
      } catch (err) {
        renderAllModelDropdowns();
        if (typeof renderFavoritesSection === 'function') renderFavoritesSection();
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'fav_update_error', { error: (err && err.message) || t(currentUiLocale, 'err_unknown') }), true);
      } finally {
        btnToggleFavorite.disabled = !currentFavKey();
      }
    });
  }

  if (selectModel) {
    selectModel.addEventListener('change', () => {
      renderAllModelDropdowns();
      evaluateActionReadiness();
      markDirty();
    });
  }

  // Fallbacks v2 UI Dynamic Rendering
  function wireFallbackFavButton(btnFallbackFav, fb, idx, modelSelect, modelWrap) {
      btnFallbackFav.addEventListener('click', async () => {
        if (!settingsLoaded) {
          setConfigMsg(configMessageConnect, getSettingsNotLoadedMsg(), true);
          return;
        }
        const curModel = modelSelect.value || fb.model;
        if (!curModel) return;
        const scopeKey = favKeyForFallback({ baseURL: (document.getElementById(`input-fallback-url-${idx}`)?.value || fb.baseURL || '') });
        if (!scopeKey) return;
        btnFallbackFav.disabled = true;
        try {
          const displayedBucket = getFavoritesForKey(scopeKey);
          const desiredFavorite = !displayedBucket.includes(curModel);
          await saveFavoriteToggle(scopeKey, curModel, desiredFavorite);
          renderAllModelDropdowns();
          setConfigMsg(configMessageConnect, t(currentUiLocale, 'fav_saved'));
        } catch (err) {
          renderAllModelDropdowns();
          setConfigMsg(configMessageConnect, t(currentUiLocale, 'fav_update_error', { error: (err && err.message) || t(currentUiLocale, 'err_cannot_save') }), true);
        } finally {
          btnFallbackFav.disabled = !favKeyForFallback({ baseURL: (document.getElementById(`input-fallback-url-${idx}`)?.value || fb.baseURL || '') });
        }
      });

      modelWrap.appendChild(modelSelect);
      modelWrap.appendChild(btnFallbackFav);
  }

  function renderFallbackRows() {
    // btn-fallback-fav-
    renderFallbackList({
      container: fallbackListEl, fallbacks, btnAddFallback, currentUiLocale, SVG_ICONS,
      fallbackKeyPresence, favKeyForFallback, getFavoritesForKey, updateFallbackStar,
      populateSelect, t, wireFavButton: wireFallbackFavButton,
      callbacks: {
        onRemove: async (fb, idx) => {
          if (fb.id) {
            try {
              await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'DELETE_FALLBACK_KEY', id: fb.id }, resolve);
              });
              delete fallbackKeyPresence[fb.id];
            } catch {}
          }
          if (!settingsLoaded) {
            setConfigMsg(configMessageConnect, getSettingsNotLoadedMsg(), true);
            return;
          }
          fallbacks.splice(idx, 1);
          renderFallbackRows();
          renderAllModelDropdowns();
          flushAutosave();
        },
        onUrlInput: () => markDirty(),
        onKeyChange: () => markDirty(),
        onModelChange: () => markDirty()
      }
    });
  }

  if (btnAddFallback) {
    btnAddFallback.addEventListener('click', () => {
      if (fallbacks.length >= 2) return;
      if (!settingsLoaded) {
        setConfigMsg(configMessageConnect, getSettingsNotLoadedMsg(), true);
        return;
      }
      const usedIds = new Set(fallbacks.map(f => f.id));
      const nextId = !usedIds.has('fb1') ? 'fb1' : 'fb2';
      const defaultFbModel = RECOMMENDED_MODELS[1] || DEFAULT_MODEL;

      fallbacks.push({ id: nextId, model: defaultFbModel, baseURL: '' });
      renderFallbackRows();
      renderAllModelDropdowns();
      flushAutosave();
    });
  }

  function renderAllModelDropdowns() {
    populateAllModelDropdowns({
      selectModel, savedSettings, DEFAULT_MODEL, populateSelect, fallbacks,
      RECOMMENDED_MODELS, favKeyForFallback, getFavoritesForKey, updateFallbackStar,
      autoTranslateSites, currentUiLocale, t, primaryFavorites, updateStarButton,
      renderFavoritesSection
    });
  }

  // Model Loading via LIST_MODELS (Cache-First)
  async function loadModels({ forceRefresh = false } = {}) {
    if (!isDataConsentAccepted(savedSettings)) {
      return;
    }
    if (forceRefresh && btnRefreshModels) {
      btnRefreshModels.disabled = true;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'LIST_MODELS', forceRefresh }, (resp) => {
        handleListModelsResponse(resp, {
          forceRefresh, btnRefreshModels, currentUiLocale, t, configMessageConnect,
          setConfigMsg, showKeyAccessBanner,
          setDiscoveredModels: (models) => { discoveredModels = models; },
          renderAllModelDropdowns, evaluateActionReadiness
        });
        resolve();
      });
    });
  }

  if (btnRefreshModels) {
    btnRefreshModels.addEventListener('click', async () => {
      if (!isDataConsentAccepted(savedSettings)) {
        openModal('consent');
        return;
      }
      // Host permission needs a user gesture — ensure it here before fetch.
      const perm = await ensureBaseUrlPermission();
      if (!perm.ok) {
        setConfigMsg(configMessageConnect, perm.reason === 'invalid' ? t(currentUiLocale, 'err_base_url_invalid') : t(currentUiLocale, 'err_base_url_perm_needed'), true);
        updateStatus('error', t(currentUiLocale, 'err_perm_required_base'));
        return;
      }
      await loadModels({ forceRefresh: true });
    });
  }

  // Background Push Listener: MODELS_UPDATED & TRANSLATE_TERMINAL_ERROR
  if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === 'MODELS_UPDATED' && Array.isArray(msg.models)) {
        discoveredModels = msg.models;
        renderAllModelDropdowns();
        evaluateActionReadiness();
      }
      if (msg && msg.action === 'TRANSLATE_TERMINAL_ERROR') {
        if (typeof openModal === 'function' && modalOverlay) {
          openModal('log', { highlightFirst: true });
        } else {
          switchTab('tab-log');
          loadErrorLog({ highlightFirst: true });
        }
      }
    });
  }

  // Settings Loading via GET_SETTINGS
  async function loadSettings() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
        resolve(false);
        return;
      }
      chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          const err = (resp && resp.error) || chrome.runtime.lastError || {};
          if (err.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          updateStatus('error', t(currentUiLocale, 'err_load_settings_failed', { code: err.code || 'ERROR', msg: err.message || t(currentUiLocale, 'err_unknown') }));
          resolve(false);
          return;
        }
        if (resp && resp.settings) {
          savedSettings = { ...resp.settings };
          if (savedSettings.sourceLanguage && !SOURCE_LANGS.some(l => l.code === savedSettings.sourceLanguage)) savedSettings.sourceLanguage = 'auto';
          if (savedSettings.targetLanguage && !TARGET_LANGS.some(l => l.code === savedSettings.targetLanguage)) savedSettings.targetLanguage = 'vi';
          if (inputBaseUrl) inputBaseUrl.value = resp.settings.baseURL || 'http://localhost:8080/v1';

          if (selectSrcLang && resp.settings.sourceLanguage) {
            const rawSrc = resp.settings.sourceLanguage;
            selectSrcLang.value = SOURCE_LANGS.some(l => l.code === rawSrc) ? rawSrc : 'auto';
          }
          if (selectTgtLang && resp.settings.targetLanguage) {
            const rawTgt = resp.settings.targetLanguage;
            selectTgtLang.value = TARGET_LANGS.some(l => l.code === rawTgt) ? rawTgt : 'vi';
          }

          if (resp.settings.translationMode) currentMode = resp.settings.translationMode;
          if (typeof resp.settings.widgetVisible === 'boolean') {
            if (checkboxWidgetVisible) checkboxWidgetVisible.checked = resp.settings.widgetVisible;
            if (checkboxWidgetVisibleAppearance) checkboxWidgetVisibleAppearance.checked = resp.settings.widgetVisible;
          }
          if (checkboxFavoritesOnly && typeof resp.settings.showFavoritesOnly === 'boolean') checkboxFavoritesOnly.checked = resp.settings.showFavoritesOnly;
          if (checkboxExportKeys) {
            checkboxExportKeys.checked = typeof resp.settings.exportIncludeKeys === 'boolean'
              ? resp.settings.exportIncludeKeys
              : true;
          }

          applyUiLocale(resp.settings.uiLocale || 'vi');
          applyTheme(resp.settings.theme || 'dark');
          applyFontScale(resp.settings.uiFontScale || 'md');
          updateFabSizeDisplay(typeof resp.settings.fabSize === 'number' ? resp.settings.fabSize : 1.0);
          applyFabMascot(resp.settings.fabMascot || 'default');

          favoriteModelsByBaseURL = (resp.settings.favoriteModelsByBaseURL && typeof resp.settings.favoriteModelsByBaseURL === 'object' && !Array.isArray(resp.settings.favoriteModelsByBaseURL))
            ? JSON.parse(JSON.stringify(resp.settings.favoriteModelsByBaseURL))
            : {};
          lastFavKey = normalizeBaseURLKey(resp.settings.baseURL || '');
          fallbacks = Array.isArray(resp.settings.fallbacks) ? JSON.parse(JSON.stringify(resp.settings.fallbacks)) : [];
          autoTranslateSites = Array.isArray(resp.settings.autoTranslateSites) ? [...resp.settings.autoTranslateSites] : [];

          hasStoredKey = Boolean(resp.hasKey);
          fallbackKeyPresence = resp.fallbackKeyPresence || {};

          if (keyStatusIndicator) keyStatusIndicator.textContent = hasStoredKey ? t(currentUiLocale, 'conn_key_stored') : t(currentUiLocale, 'conn_key_not_stored');
          if (inputApiKey && !inputApiKey.value) inputApiKey.placeholder = t(currentUiLocale, hasStoredKey ? 'conn_key_placeholder_saved' : 'conn_api_key_placeholder');
          if (inputRateTab) inputRateTab.value = typeof resp.settings.rateLimits?.tab?.maxBatches === 'number' ? resp.settings.rateLimits.tab.maxBatches : 4;
          if (inputRateSite) inputRateSite.value = typeof resp.settings.rateLimits?.site?.maxBatches === 'number' ? resp.settings.rateLimits.site.maxBatches : 12;
          if (inputRateConcurrency) inputRateConcurrency.value = typeof resp.settings.providerConcurrency === 'number' ? resp.settings.providerConcurrency : 2;

          if (selectModel) selectModel.value = resp.settings.model || DEFAULT_MODEL;
          try { renderFallbackRows(); } catch (e) { try { console.error('[popup] renderFallbackRows failed:', e && e.message); } catch {} }
          try { renderFavoritesSection(); } catch (e) { try { console.error('[popup] renderFavoritesSection failed:', e && e.message); } catch {} }
          try { renderAllModelDropdowns(); } catch (e) { try { console.error('[popup] renderAllModelDropdowns failed:', e && e.message); } catch {} }
          try { renderAutoSites(); } catch (e) { try { console.error('[popup] renderAutoSites failed:', e && e.message); } catch {} }
          if (typeof updatePrivacyNote === 'function') updatePrivacyNote(resp.settings.baseURL);
          resolve(true);
          return;
        }
        updateStatus('error', t(currentUiLocale, 'err_load_saved_settings_failed'));
        resolve(false);
      });
    });
  }

  // Telemetry Formatters
  function formatElapsed(ms) { return formatElapsedModule(ms); }

  function formatDetail(state, data = {}) {
    if (state === 'translated') {
      const effTranslated = typeof data.totalCollected === 'number'
        ? Math.min(data.totalApplied || 0, data.totalCollected)
        : (data.applied || 0);
      const countStr = typeof data.totalCollected === 'number'
        ? `${effTranslated}/${data.totalCollected}`
        : `${effTranslated}`;
      const failed = typeof data.totalFailed === 'number' ? data.totalFailed : (data.failed || 0);
      if (failed > 0) {
        return t(currentUiLocale, 'detail_translated_with_errors', { count: countStr, failed });
      }
      const elapsed = formatElapsed(data.elapsedMs);
      const modelStr = (data.actualModel && typeof data.fallbackIndex === 'number' && data.fallbackIndex >= 0)
        ? `${data.actualModel} (fallback ${data.fallbackIndex + 1})`
        : (data.actualModel || data.model || selectModel?.value || DEFAULT_MODEL);
      const metaStr = elapsed ? ` (${elapsed} · ${modelStr})` : ` (${modelStr})`;
      return t(currentUiLocale, 'detail_translated_success', { count: countStr, meta: metaStr });
    }
    if (state === 'error') {
      // Handled via telemetry module
    }
    return formatDetailModule(state, data, { currentUiLocale, t, showKeyAccessBanner, selectModel, DEFAULT_MODEL });
  }

  // Check tab status and queue status
  async function checkTabStatus() {
    if (!activeTab || !activeTab.id) return;
    try {
      chrome.tabs.sendMessage(activeTab.id, { action: 'CONTENT_GET_STATUS' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          stopPolling();
          evaluateActionReadiness(0);
          return;
        }

        const st = resp.status;
        // Scroll batches that only fail must surface the provider error
        // instead of pretending to watch forever. Keep polling (no
        // stopPolling) so a later recovery updates the strip.
        if (st.lastError && (st.totalFailed || 0) > 0 && (st.totalApplied || 0) === 0) {
          if (st.watching === false) stopPolling(); else startPolling();
          updateStatus('error', formatDetail('error', {
            error: st.lastError,
            elapsedMs: st.elapsedMs,
            model: st.model,
            actualModel: st.actualModel,
            fallbackIndex: st.fallbackIndex
          }), st);
          evaluateActionReadiness(resp.restorableCount || 0);
        } else if (st.watching === true || (st.watching !== false && st.mode === 'scroll-follow' && (st.state === 'translating' || st.state === 'done'))) {
          // Still watching (even with state done for the current viewport):
          // keep polling so the footer refreshes live and reopen recovers.
          startPolling();
          updateStatus('watching', formatDetail('watching', { ...st, lastError: st.lastError }), st);
          evaluateActionReadiness(resp.restorableCount || 0);
        } else if (st.state === 'done') {
          stopPolling();
          updateStatus('translated', formatDetail('translated', {
            totalApplied: st.totalApplied,
            totalCollected: st.totalCollected,
            totalFailed: st.totalFailed,
            failed: st.totalFailed,
            elapsedMs: st.elapsedMs,
            model: st.model,
            actualModel: st.actualModel,
            fallbackIndex: st.fallbackIndex
          }), st);
          evaluateActionReadiness(resp.restorableCount || 0);
        } else if (st.state === 'restored') {
          stopPolling();
          updateStatus('restored', t(currentUiLocale, 'detail_restored_nodes', { count: st.totalRestored }));
          evaluateActionReadiness(0);
        } else if (st.state === 'translating') {
          startPolling();
          chrome.runtime.sendMessage({ action: 'GET_QUEUE_STATUS', tabId: activeTab.id }, (qResp) => {
            if (qResp && qResp.queued) {
              const remSec = Math.max(1, Math.ceil((qResp.retryAfterMs || 0) / 1000));
              updateStatus('translating', t(currentUiLocale, 'detail_waiting_quota', { sec: remSec }));
            } else {
              const tApplied = (typeof st.totalCollected === 'number' && (st.totalApplied || 0) > st.totalCollected)
                ? st.totalCollected
                : (st.totalApplied || 0);
              const progressDetail = (typeof st.totalCollected === 'number' && st.totalCollected > 0)
                ? t(currentUiLocale, 'detail_translating_nodes', { applied: tApplied, collected: st.totalCollected })
                : t(currentUiLocale, 'status_translating');
              const retrySuffix = st.lastError && st.lastError.code ? t(currentUiLocale, 'detail_last_error_retry_paren', { code: st.lastError.code }) : '';
              updateStatus('translating', progressDetail + retrySuffix);
            }
          });
          if (btnTranslate) btnTranslate.disabled = true;
          if (btnRestore) btnRestore.disabled = true;
        } else if (st.state === 'error') {
          stopPolling();
          updateStatus('error', formatDetail('error', {
            error: st.error,
            elapsedMs: st.elapsedMs,
            model: st.model,
            actualModel: st.actualModel,
            fallbackIndex: st.fallbackIndex
          }));
          evaluateActionReadiness(resp.restorableCount || 0);
        } else {
          stopPolling();
          evaluateActionReadiness(resp.restorableCount || 0);
        }
      });
    } catch {
      stopPolling();
    }
  }

  // Toggle API key mask
  if (btnToggleKey && inputApiKey) {
    btnToggleKey.addEventListener('click', () => {
      if (inputApiKey.type === 'password') {
        inputApiKey.type = 'text';
        btnToggleKey.innerHTML = SVG_ICONS.eyeOff;
      } else {
        inputApiKey.type = 'password';
        btnToggleKey.innerHTML = SVG_ICONS.eye;
      }
    });
  }

  // Connect tab: autosave (no save button). Typing/changing any field persists
  // to storage automatically. Host permission needs a user gesture, so it is
  // granted via the shield button or at Translate time — never inside autosave.
  if (inputBaseUrl) {
    inputBaseUrl.addEventListener('input', () => {
      if (typeof updatePrivacyNote === 'function') updatePrivacyNote(inputBaseUrl.value);
      if (typeof renderFavoritesSection === 'function') renderFavoritesSection();
      markDirty();
    });
    inputBaseUrl.addEventListener('change', () => {
      if (typeof updatePrivacyNote === 'function') updatePrivacyNote(inputBaseUrl.value);
      // Switching Base URL only swaps which map bucket is displayed.
      try {
        const nextKey = currentFavKey();
        if (nextKey !== lastFavKey) {
          lastFavKey = nextKey;
          savedSettings.favoriteModels = primaryFavorites();
          renderAllModelDropdowns();
          if (typeof renderFavoritesSection === 'function') renderFavoritesSection();
          evaluateActionReadiness();
        }
      } catch {}
      refreshBasePermState();
    });
  }

  if (inputApiKey) {
    inputApiKey.addEventListener('change', () => {
      markDirty();
    });
  }

  // Rate Limits Inputs (WI-28)
  const { showRateLimitsHint, setupRateLimitInput } = createRateLimitsController({
    rateLimitsHint, t, getCurrentUiLocale: () => currentUiLocale, markDirty
  });
  if (inputRateTab) setupRateLimitInput(inputRateTab, 1, 32, 4);
  if (inputRateSite) setupRateLimitInput(inputRateSite, 1, 64, 12);
  if (inputRateConcurrency) setupRateLimitInput(inputRateConcurrency, 1, 8, 2);

  async function getBaseOrigin() { return getBaseOriginModule(inputBaseUrl?.value); }
  async function ensureBaseUrlPermission() { return ensureBaseUrlPermissionModule(inputBaseUrl?.value, { refreshBasePermState }); }
  async function refreshBasePermState() {
    return refreshBasePermStateModule({ btnBasePerm, rawUrl: inputBaseUrl?.value, currentUiLocale, t });
  }

  if (btnBasePerm) {
    btnBasePerm.addEventListener('click', async () => {
      btnBasePerm.disabled = true;
      await ensureBaseUrlPermission();
      btnBasePerm.disabled = false;
      await checkTabStatus();
    });
  }

  // Delete API Key
  if (btnDeleteKey) {
    btnDeleteKey.addEventListener('click', async () => {
      await handleDeleteApiKey({
        btnDeleteKey, inputApiKey, keyStatusIndicator, currentUiLocale, t,
        configMessageConnect, setConfigMsg, renderFallbackRows,
        evaluateActionReadiness, checkTabStatus,
        onKeyDeleted: () => { hasStoredKey = false; fallbackKeyPresence = {}; }
      });
    });
  }

  // Tab 1: autosave (no save button). Language + widget changes persist
  // immediately; failures revert to last saved values.
  if (selectSrcLang) selectSrcLang.addEventListener('change', () => markDirty());
  if (selectTgtLang) selectTgtLang.addEventListener('change', () => markDirty());
  if (checkboxWidgetVisible) {
    checkboxWidgetVisible.addEventListener('change', () => {
      if (checkboxWidgetVisibleAppearance) {
        checkboxWidgetVisibleAppearance.checked = checkboxWidgetVisible.checked;
      }
      markDirty();
    });
  }
  if (checkboxWidgetVisibleAppearance) {
    checkboxWidgetVisibleAppearance.addEventListener('change', () => {
      if (checkboxWidgetVisible) {
        checkboxWidgetVisible.checked = checkboxWidgetVisibleAppearance.checked;
      }
      markDirty();
    });
  }
  if (checkboxExportKeys) {
    checkboxExportKeys.addEventListener('change', () => {
      savedSettings.exportIncludeKeys = Boolean(checkboxExportKeys.checked);
      markDirty();
    });
  }
  if (selectUiLocale) selectUiLocale.addEventListener('change', () => { applyUiLocale(selectUiLocale.value); markDirty(); });
  if (selectTheme) selectTheme.addEventListener('change', () => { applyTheme(selectTheme.value); markDirty(); });
  if (selectUiFontScale) selectUiFontScale.addEventListener('change', () => { applyFontScale(selectUiFontScale.value); markDirty(); });
  if (inputFabSize) inputFabSize.addEventListener('input', () => { updateFabSizeDisplay(inputFabSize.value); markDirty(); });
  if (btnResetFabSize) btnResetFabSize.addEventListener('click', () => { updateFabSizeDisplay(1.0); markDirty(); });

  if (mascotSelectorGrid) {
    mascotSelectorGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.mascot-chip');
      if (chip && chip.dataset.mascot) {
        applyFabMascot(chip.dataset.mascot);
        flushAutosave();
        markDirty();
      }
    });
    mascotSelectorGrid.addEventListener('keydown', (e) => {
      const chips = Array.from(mascotSelectorGrid.querySelectorAll('.mascot-chip'));
      if (chips.length === 0) return;
      const activeIdx = chips.findIndex((c) => c.classList.contains('active'));
      let nextIdx = -1;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIdx = activeIdx >= 0 ? (activeIdx + 1) % chips.length : 0;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIdx = activeIdx >= 0 ? (activeIdx - 1 + chips.length) % chips.length : chips.length - 1;
      } else if (e.key === ' ' || e.key === 'Enter') {
        const chip = e.target.closest('.mascot-chip');
        if (chip && chip.dataset.mascot) {
          e.preventDefault();
          applyFabMascot(chip.dataset.mascot);
          flushAutosave();
          markDirty();
        }
      }

      if (nextIdx >= 0) {
        const targetChip = chips[nextIdx];
        if (targetChip && targetChip.dataset.mascot) {
          applyFabMascot(targetChip.dataset.mascot);
          targetChip.focus();
          flushAutosave();
          markDirty();
        }
      }
    });
  }

  // Header Settings Menu & Modal Triggers
  setupModalAndMenuTriggers({
    btnHeaderMenu, menuBackdrop, menuItemConfig, menuItemLog, menuItemImport,
    inputImportConfig, menuItemExport, modalBackdrop, modalCloseBtn,
    btnExportConfigConnect, btnImportConfigConnect, inputImportConfigConnect,
    toggleMenu, closeMenu, openModal, triggerExportConfig, triggerImportConfig,
    isModalOpen, closeModal, menuOverlay, handleModalFocusTrap
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isModalOpen()) {
        closeModal();
      } else if (menuOverlay && menuOverlay.style.display !== 'none') {
        closeMenu();
      }
    } else if (e.key === 'Tab') {
      handleModalFocusTrap(e);
    }
  });

  // Privacy Note & Data Consent Modal (WI-51)
  function updatePrivacyNote(baseURL) {
    updatePrivacyNoteModule({
      privacyNote, baseURL,
      rawUrl: inputBaseUrl?.value,
      savedBaseUrl: savedSettings?.baseURL,
      currentUiLocale, t
    });
  }

  if (privacyNote) {
    privacyNote.style.cursor = 'pointer';
    privacyNote.addEventListener('click', () => {
      openModal('consent', { opener: privacyNote });
    });
    privacyNote.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openModal('consent', { opener: privacyNote });
      }
    });
  }

  if (btnConsentAccept) {
    btnConsentAccept.addEventListener('click', async () => {
      btnConsentAccept.disabled = true;
      const consentPayload = {
        version: CURRENT_DATA_CONSENT_VERSION,
        acceptedAt: new Date().toISOString()
      };
      const res = await sendMsg({
        action: 'SAVE_SETTINGS',
        settings: { dataConsent: consentPayload }
      });
      btnConsentAccept.disabled = false;
      if (res?.ok !== true) {
        updateStatus('error', t(currentUiLocale, 'err_save_settings_failed'));
        return;
      }
      savedSettings.dataConsent = consentPayload;
      closeModal();
      evaluateActionReadiness();
      updateStatus('ready', t(currentUiLocale, 'status_ready_detail'));
      if (hasStoredKey) {
        loadModels({ forceRefresh: false }).catch(() => {});
      }
    });
  }

  if (btnConsentDecline) {
    btnConsentDecline.addEventListener('click', async () => {
      btnConsentDecline.disabled = true;
      const declinedConsent = {
        version: CURRENT_DATA_CONSENT_VERSION,
        acceptedAt: null
      };
      try {
        const res = await sendMsg({
          action: 'SAVE_SETTINGS',
          settings: { dataConsent: declinedConsent }
        });
        if (res?.ok !== true) {
          updateStatus('error', t(currentUiLocale, 'err_save_settings_failed'));
          return;
        }
        savedSettings.dataConsent = declinedConsent;
        closeModal();
        evaluateActionReadiness();
        updateStatus('unconfigured', t(currentUiLocale, 'consent_status_declined'));
      } catch {
        updateStatus('error', t(currentUiLocale, 'err_save_settings_failed'));
      } finally {
        btnConsentDecline.disabled = false;
      }
    });
  }

  if (btnConsentRetry) {
    btnConsentRetry.addEventListener('click', async () => {
      btnConsentRetry.disabled = true;
      try {
        await loadConsent();
      } finally {
        btnConsentRetry.disabled = false;
      }
    });
  }

  function updateAutoConsentWarningBanner() {
    updateAutoConsentWarningBannerModule({
      bannerAutoConsentWarning, bannerAutoWarningText, btnBannerEnableSite, btnBannerEnableSiteText,
      currentConsent, autoTranslateSites, currentUiLocale, t
    });
  }
  function showAutoSiteError(msg) { showAutoSiteErrorModule(autoSiteError, msg); }
  function hideAutoSiteError() { hideAutoSiteErrorModule(autoSiteError); }
  async function enableSiteForOrigin(origin) { return enableSiteForOriginModule(origin, sendMsg); }
  async function refreshSiteDots() { return refreshSiteDotsModule({ autoSitesList, autoTranslateSites, currentUiLocale, t }); }

  function renderAutoSites() {
    renderAutoSitesList({
      container: autoSitesList, autoTranslateSites, currentUiLocale, SVG_ICONS,
      SOURCE_LANGS, TARGET_LANGS, getLanguageLabel, populateSelect, primaryFavorites,
      t, refreshSiteDots,
      callbacks: createAutoSiteCallbacks({
        autoSitesList,
        getAutoTranslateSites: () => autoTranslateSites,
        setAutoTranslateSites: (list) => { autoTranslateSites = list; },
        savedSettings, isSettingsLoaded: () => settingsLoaded, currentConsent,
        getCurrentConsent: () => currentConsent,
        currentUiLocale, t, enableSiteForOrigin, loadConsent, refreshSiteDots,
        renderAutoSites, showAutoSiteError, hideAutoSiteError, markDirty,
        getSettingsNotLoadedMsg
      })
    });
  }

  async function commitAutoSite(norm) {
    return commitAutoSiteModule({
      norm, settingsLoaded, autoTranslateSites, savedSettings, sendMsg,
      enableSiteForOriginFn: enableSiteForOrigin, currentConsent, loadConsent,
      renderAutoSites, refreshSiteDotsFn: refreshSiteDots, showAutoSiteErrorFn: showAutoSiteError,
      getSettingsNotLoadedMsg, currentUiLocale, t
    });
  }

  function openDraftAutoSite() {
    openDraftAutoSiteModule({
      autoSitesList, activeTab, autoTranslateSites, currentUiLocale, SVG_ICONS,
      commitAutoSiteFn: commitAutoSite, showAutoSiteErrorFn: showAutoSiteError,
      hideAutoSiteErrorFn: hideAutoSiteError, t
    });
  }

  if (btnAddCurrentSite) btnAddCurrentSite.addEventListener('click', openDraftAutoSite);
  if (btnBannerEnableSite) {
    btnBannerEnableSite.addEventListener('click', async () => {
      const origin = currentConsent?.siteOrigin || (activeTab?.url ? normalizeOrigin(activeTab.url) : null);
      if (!origin) return;
      btnBannerEnableSite.disabled = true;
      const res = await enableSiteForOrigin(origin);
      btnBannerEnableSite.disabled = false;
      if (!res.ok) {
        updateStatus('error', res.reason === 'permission' ? t(currentUiLocale, 'err_perm_required_site') : t(currentUiLocale, 'err_enable_site_failed_short'));
        return;
      }
      await loadConsent();
      await refreshSiteDots();
      updateAutoConsentWarningBanner();
      evaluateActionReadiness();
    });
  }

  if (btnTranslate) {
    btnTranslate.addEventListener('click', async () => {
      await handleTranslatePage({
        activeTab, settingsLoaded, savedSettings, currentConsent, autoTranslateSites,
        currentMode, selectModel, selectSrcLang, selectTgtLang, btnTranslate, btnRestore,
        configMessageConnect, DEFAULT_MODEL, currentUiLocale, t, openModal, updateStatus,
        evaluateActionReadiness, setTranslateBusy, startPolling, stopPolling, flushAutosave,
        ensureBaseUrlPermission, enableSiteForOrigin, loadConsent, formatDetail, getSettingsNotLoadedMsg
      });
    });
  }

  if (btnRestore) {
    btnRestore.addEventListener('click', async () => {
      await handleRestorePage({
        activeTab, btnRestore, currentUiLocale, t, updateStatus, evaluateActionReadiness,
        formatDetail, stopPolling
      });
    });
  }

  if (typeof window !== 'undefined') {
    window.openModal = openModal;
    window.closeModal = closeModal;
    window.isModalOpen = isModalOpen;
    window.getModalFocusableElements = getModalFocusableElements;
    window.handleModalFocusTrap = handleModalFocusTrap;
    window.setBackgroundInert = setBackgroundInert;
    window.restoreFocusAfterModal = restoreFocusAfterModal;
    window.isElementVisibleAndEnabled = isElementVisibleAndEnabled;
  }

  // Initial UI render
  applyUiLocale('vi');
  applyTheme('dark');
  applyFontScale('md');
  updateFabSizeDisplay(1.0);
  applyFabMascot('default');
  if (typeof updatePrivacyNote === 'function') updatePrivacyNote();

  // Initial Sequence (writes stay blocked until settings load succeeds)
  settingsLoaded = await loadSettings();
  setSaveState('saved');
  await refreshBasePermState();
  if (typeof updatePrivacyNote === 'function') updatePrivacyNote();

  const consentAccepted = isDataConsentAccepted(savedSettings);
  if (!consentAccepted) {
    openModal('consent');
  }

  const tabOk = await resolveActiveTab();
  if (tabOk) {
    await loadConsent();
    if (hasStoredKey && consentAccepted) {
      // Cache-first: only reads local cache on open, does NOT force refresh from network
      loadModels({ forceRefresh: false }).catch(() => {});
    }
    await checkTabStatus();
  }
});
}
