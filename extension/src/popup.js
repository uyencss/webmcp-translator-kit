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

import { buildExportPayload } from './popup/modules/config-io.mjs';
import { computePrivacyNoteState, evaluateAutoConsentWarningBranch } from './popup/modules/consent-banner.mjs';
import { setBackgroundInertState, isElementVisibleAndInteractable, trapFocusInModal, getFocusableElementsWithin } from './popup/modules/modal.mjs';
import { resolveFavKey, getScopedFavorites, filterAvailableModelsToAdd, MAX_FAVORITES_PER_SCOPE } from './popup/modules/models-manager.mjs';
import { setupMascotPicker } from './popup/modules/mascot-picker.mjs';
import { buildRateLimitsConfig, clampRateLimitTunables } from './popup/modules/state.mjs';
import { renderFallbackList } from './popup/modules/fallback-rows.mjs';
import { renderAutoSitesList } from './popup/modules/rules-manager.mjs';
import {
  showAutoSiteError as showAutoSiteErrorModule,
  hideAutoSiteError as hideAutoSiteErrorModule,
  enableSiteForOrigin as enableSiteForOriginModule,
  refreshSiteDots as refreshSiteDotsModule,
  commitAutoSite as commitAutoSiteModule,
  openDraftAutoSite as openDraftAutoSiteModule
} from './popup/modules/auto-sites-controller.mjs';
import {
  formatElapsed as formatElapsedModule,
  formatDetail as formatDetailModule
} from './popup/modules/telemetry.mjs';
import {
  applyTheme as applyThemeModule,
  applyFontScale as applyFontScaleModule,
  applyUiLocale as applyUiLocaleModule
} from './popup/modules/theme-manager.mjs';

export {
  buildExportPayload,
  computePrivacyNoteState,
  evaluateAutoConsentWarningBranch,
  setBackgroundInertState,
  isElementVisibleAndInteractable,
  trapFocusInModal,
  getFocusableElementsWithin,
  resolveFavKey,
  getScopedFavorites,
  filterAvailableModelsToAdd,
  MAX_FAVORITES_PER_SCOPE,
  setupMascotPicker,
  buildRateLimitsConfig,
  clampRateLimitTunables,
  renderFallbackList,
  renderAutoSitesList,
  showAutoSiteErrorModule,
  hideAutoSiteErrorModule,
  enableSiteForOriginModule,
  refreshSiteDotsModule,
  commitAutoSiteModule,
  openDraftAutoSiteModule,
  formatElapsedModule,
  formatDetailModule,
  applyThemeModule,
  applyFontScaleModule,
  applyUiLocaleModule
};

if (typeof window !== 'undefined') {
  window.DEFAULT_MODEL = DEFAULT_MODEL;
  window.RECOMMENDED_MODELS = RECOMMENDED_MODELS;
  window.buildExportPayload = buildExportPayload;
}

// Inline Tabler SVG path helpers (MIT)
const SVG_ICONS = {
  check: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>',
  spinner: '<svg class="icon icon-sm spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  alert: '<svg class="icon icon-sm text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M5 19h14a2 2 0 0 0 1.84 -2.75l-7.1 -12.25a2 2 0 0 0 -3.5 0l-7.1 12.25a2 2 0 0 0 1.75 2.75"/></svg>',
  clock: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 7v5l3 3"/></svg>',
  lock: '<svg class="icon icon-sm text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/></svg>',
  scroll: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l4 -4l4 4"/><path d="M8 17l4 4l4 -4"/><path d="M12 3l0 18"/></svg>',
  restore: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14l-4 -4l4 -4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/></svg>',
  eye: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>',
  eyeOff: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/></svg>',
  star: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/></svg>',
  starFilled: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0l-2.853 5.78z"/></svg>',
  trash: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>',
  power: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>'
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    if (document.body) {
      document.body.classList.remove('modal-open');
    }
    // Common Top Elements
  const statusStrip = document.getElementById('status-strip');
  const statusIcon = document.getElementById('status-icon');
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const btnTranslate = document.getElementById('btn-translate');
  const btnRestore = document.getElementById('btn-restore');
  const keyAccessBanner = document.getElementById('key-access-banner');
  const footerStatusSummary = document.getElementById('footer-status-summary');

  // Tab Navigation Elements
  const tabList = document.querySelector('.tab-list[role="tablist"]');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn[role="tab"]'));
  const tabPanels = {
    'tab-translate': document.getElementById('tabpanel-translate'),
    'tab-auto': document.getElementById('tabpanel-auto'),
    'tab-config': document.getElementById('tabpanel-config'),
    'tab-log': document.getElementById('tabpanel-log'),
    'tab-consent': document.getElementById('tabpanel-consent')
  };
  const logList = document.getElementById('log-list');
  const btnClearLog = document.getElementById('btn-clear-log');

  // WI-50 Auto-Start Warning Banner Elements
  const bannerAutoConsentWarning = document.getElementById('banner-auto-consent-warning');
  const bannerAutoWarningText = document.getElementById('banner-auto-warning-text');
  const btnBannerEnableSite = document.getElementById('btn-banner-enable-site');
  const btnBannerEnableSiteText = document.getElementById('btn-banner-enable-site-text');

  // Consent Unknown State Elements (P2-4)
  const bannerConsentUnknown = document.getElementById('banner-consent-unknown');
  const bannerConsentUnknownText = document.getElementById('banner-consent-unknown-text');
  const btnConsentRetry = document.getElementById('btn-consent-retry');
  const btnConsentRetryText = document.getElementById('btn-consent-retry-text');

  // WI-51 Consent Elements
  const privacyNote = document.getElementById('privacy-note');
  const tabpanelConsent = document.getElementById('tabpanel-consent');
  const btnConsentAccept = document.getElementById('btn-consent-accept');
  const btnConsentDecline = document.getElementById('btn-consent-decline');

  // Tab 4 Elements ("Config")
  const selectUiLocale = document.getElementById('select-ui-locale');
  const selectTheme = document.getElementById('select-theme');
  const selectUiFontScale = document.getElementById('select-ui-font-scale');

  // Header Menu Elements
  const btnHeaderMenu = document.getElementById('btn-header-menu');
  const menuOverlay = document.getElementById('menu-overlay');
  const menuBackdrop = document.getElementById('menu-backdrop');
  const menuItemConfig = document.getElementById('menu-item-config');
  const menuItemLog = document.getElementById('menu-item-log');
  const menuItemExport = document.getElementById('menu-item-export');
  const menuItemImport = document.getElementById('menu-item-import');

  // Modal Dialog Elements
  const modalOverlay = document.getElementById('modal-overlay');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalTitle = document.getElementById('modal-title');
  const modalCloseBtn = document.getElementById('modal-close-btn');

  // Export JSON & Fab Size Elements
  const btnExportConfigConnect = document.getElementById('btn-export-config-connect');
  const btnImportConfigConnect = document.getElementById('btn-import-config-connect');
  const inputImportConfigConnect = document.getElementById('input-import-config-connect');
  const inputImportConfig = document.getElementById('input-import-config') || inputImportConfigConnect;
  const checkboxExportKeys = document.getElementById('checkbox-export-keys');
  const inputFabSize = document.getElementById('input-fab-size');
  const fabSizeValue = document.getElementById('fab-size-value');
  const btnResetFabSize = document.getElementById('btn-reset-fab-size');
  const mascotSelectorGrid = document.getElementById('mascot-selector-grid');
  const selectFabMascot = document.getElementById('select-fab-mascot');

  // Tab 1 Elements ("Translate")
  const selectSrcLang = document.getElementById('select-src-lang');
  const selectTgtLang = document.getElementById('select-tgt-lang');
  const siteOriginBadge = document.getElementById('site-origin-badge');
  const toggleSiteConsent = document.getElementById('toggle-site-consent');
  const btnOverrideInherit = document.getElementById('btn-override-inherit');
  const btnOverrideOn = document.getElementById('btn-override-on');
  const btnOverrideOff = document.getElementById('btn-override-off');
  const checkboxWidgetVisible = document.getElementById('checkbox-widget-visible');

  // Autosave indicator (header)
  const saveStateEl = document.getElementById('save-state');
  const saveDotEl = document.getElementById('save-dot');

  // Tab 2 Elements ("Auto")
  const btnAddCurrentSite = document.getElementById('btn-add-current-site');
  const autoSiteError = document.getElementById('auto-site-error');
  const autoSitesList = document.getElementById('auto-sites-list');

  // Tab 3 Elements ("Connect")
  const inputBaseUrl = document.getElementById('input-base-url');
  const btnBasePerm = document.getElementById('btn-base-perm');
  const inputApiKey = document.getElementById('input-api-key');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const btnDeleteKey = document.getElementById('btn-delete-key');
  const keyStatusIndicator = document.getElementById('key-status-indicator');
  const selectModel = document.getElementById('select-model');
  const btnToggleFavorite = document.getElementById('btn-toggle-favorite');
  const btnRefreshModels = document.getElementById('btn-refresh-models');
  const btnAddFallback = document.getElementById('btn-add-fallback');
  const fallbackListEl = document.getElementById('fallback-list');
  const configMessageConnect = document.getElementById('config-message-connect');

  // Rate Limits Elements (WI-28)
  const inputRateTab = document.getElementById('input-rate-tab');
  const inputRateSite = document.getElementById('input-rate-site');
  const inputRateConcurrency = document.getElementById('input-rate-concurrency');
  const rateLimitsHint = document.getElementById('rate-limits-hint');

  // Tab 3 Sub-menu & Favorites Elements (WI-21)
  const subtabNav = document.querySelector('.subtab-nav');
  const subtabButtons = Array.from(document.querySelectorAll('.subtab-btn'));
  const configSubpanels = {
    connect: document.getElementById('config-section-connect'),
    appearance: document.getElementById('config-section-appearance'),
    favorites: document.getElementById('config-section-favorites')
  };
  const checkboxFavoritesOnly = document.getElementById('checkbox-favorites-only');
  const favoritesSectionTitle = document.getElementById('favorites-section-title');
  const favoritesCountBadge = document.getElementById('favorites-count-badge');
  const selectAddFavorite = document.getElementById('select-add-favorite') || document.getElementById('input-add-favorite');
  const inputAddFavorite = selectAddFavorite;
  const btnAddFavorite = document.getElementById('btn-add-favorite');
  const favoritesAddHint = document.getElementById('favorites-add-hint');
  const favoritesEmptyHint = document.getElementById('favorites-empty-hint');
  const favoritesList = document.getElementById('favorites-list');
  const configMessageFavorites = document.getElementById('config-message-favorites');

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
    const loc = currentUiLocale;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (k) el.textContent = t(loc, k);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const k = el.getAttribute('data-i18n-title');
      if (k) el.title = t(loc, k);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      const k = el.getAttribute('data-i18n-aria-label');
      if (k) el.setAttribute('aria-label', t(loc, k));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const k = el.getAttribute('data-i18n-placeholder');
      if (k) {
        el.placeholder = t(loc, k);
        el.setAttribute('placeholder', t(loc, k));
      }
    });
    document.querySelectorAll('[data-i18n-label]').forEach((el) => {
      const k = el.getAttribute('data-i18n-label');
      if (k) el.label = t(loc, k);
    });

    if (selectUiLocale) {
      for (const opt of selectUiLocale.options) {
        const k = `config_ui_locale_${opt.value}`;
        opt.textContent = t(loc, k);
      }
    }

    if (modalTitle) {
      if (activeModal === 'config') {
        modalTitle.textContent = t(loc, 'tab_config');
      } else if (activeModal === 'log') {
        modalTitle.textContent = t(loc, 'tab_log');
      }
    }
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
    if (pollInterval) return;
    pollInterval = setInterval(() => {
      checkTabStatus();
    }, 600);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // UI Status Indicator (Single-line icon + text + tooltip).
  // Watching/translating states embed live applied/collected (+ failed) counts
  // in the visible footer text so progress is readable without tooltips.
  function updateStatus(state, detail = '', data = null) {
    let iconSvg = '';
    let shortText = '';
    let fullDetail = detail;

    switch (state) {
      case 'unconfigured':
        iconSvg = SVG_ICONS.lock;
        shortText = t(currentUiLocale, 'status_no_key');
        fullDetail = detail || t(currentUiLocale, 'status_no_key_detail');
        break;
      case 'ready':
        iconSvg = SVG_ICONS.check;
        shortText = '';
        fullDetail = detail || t(currentUiLocale, 'status_ready_detail');
        break;
      case 'translating':
        iconSvg = detail.includes('quota') ? SVG_ICONS.clock : SVG_ICONS.spinner;
        shortText = detail.includes('quota') ? detail : (detail || t(currentUiLocale, 'status_translating'));
        fullDetail = detail || t(currentUiLocale, 'status_translating_detail');
        break;
      case 'watching': {
        iconSvg = SVG_ICONS.scroll;
        const wApplied = data && typeof data.totalApplied === 'number'
          ? Math.min(data.totalApplied, typeof data.totalCollected === 'number' ? data.totalCollected : data.totalApplied)
          : (data && typeof data.applied === 'number' ? data.applied : null);
        const wCollected = data && typeof data.totalCollected === 'number' ? data.totalCollected : null;
        const wFailed = data && typeof data.totalFailed === 'number' ? data.totalFailed : 0;
        shortText = (wApplied !== null && wCollected !== null && wCollected > 0)
          ? t(currentUiLocale, 'status_watching_count', { applied: wApplied, collected: wCollected })
          : t(currentUiLocale, 'status_watching');
        if (wFailed > 0) shortText += ' ' + t(currentUiLocale, 'status_failed_count', { count: wFailed });
        fullDetail = detail || t(currentUiLocale, 'status_watching_detail');
        break;
      }
      case 'translated':
        iconSvg = SVG_ICONS.check;
        shortText = t(currentUiLocale, 'status_translated');
        fullDetail = detail || t(currentUiLocale, 'status_translated_detail');
        break;
      case 'restored':
        iconSvg = SVG_ICONS.restore;
        shortText = t(currentUiLocale, 'status_restored');
        fullDetail = detail || t(currentUiLocale, 'status_restored_detail');
        break;
      case 'unsupported':
        iconSvg = SVG_ICONS.alert;
        shortText = t(currentUiLocale, 'status_unsupported');
        fullDetail = detail || t(currentUiLocale, 'status_unsupported_detail');
        break;
      case 'error':
        iconSvg = SVG_ICONS.alert;
        if (detail.includes('RATE_LIMITED')) {
          iconSvg = SVG_ICONS.clock;
          shortText = t(currentUiLocale, 'status_waiting_quota');
        } else if (detail.includes('PERMISSION_REQUIRED')) {
          shortText = t(currentUiLocale, 'status_missing_perm');
        } else if (detail.includes('OPT_IN_REQUIRED')) {
          shortText = t(currentUiLocale, 'status_site_disabled');
        } else if (detail.includes('DROPPED_ON_RESTART')) {
          shortText = t(currentUiLocale, 'status_interrupted');
        } else if (detail.includes('HTTP_429')) {
          shortText = 'HTTP_429';
        } else if (detail.includes('HTTP_')) {
          const match = detail.match(/HTTP_\d+/);
          shortText = match ? t(currentUiLocale, 'status_error_http_code', { code: match[0] }) : t(currentUiLocale, 'status_error_http');
        } else {
          shortText = t(currentUiLocale, 'status_error');
        }
        fullDetail = detail || t(currentUiLocale, 'status_error_detail');
        break;
      default:
        iconSvg = '<span class="status-dot"></span>';
        shortText = state;
        fullDetail = detail || state;
    }

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
    setTimeout(() => {
      if (targetEl.textContent === msg) targetEl.textContent = '';
    }, 4000);
  }

  // Promise wrapper for runtime messages
  function sendMsg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          resolve(runtimeError
            ? { error: { code: 'RUNTIME_MESSAGE_FAILED', message: runtimeError.message || 'Extension message failed' } }
            : response);
        });
      } catch (err) {
        resolve({ error: { code: 'ERROR', message: String((err && err.message) || err) } });
      }
    });
  }

  // Autosave indicator state
  function setSaveState(state, title) {
    if (saveStateEl) {
      saveStateEl.dataset.state = state;
      if (title) saveStateEl.title = title;
      else if (state === 'saved') saveStateEl.title = t(currentUiLocale, 'save_saved');
      else if (state === 'saving') saveStateEl.title = t(currentUiLocale, 'save_saving');
      else if (state === 'error') saveStateEl.title = t(currentUiLocale, 'save_error');
      else saveStateEl.title = t(currentUiLocale, 'save_default');
    }
  }

  // Collect fallback rows from UI (no permission requests here — autosave has
  // no user gesture; host permissions are granted via explicit buttons/Translate)
  function collectCleanFallbacks() {
    const out = [];
    for (let i = 0; i < fallbacks.length; i++) {
      const fb = fallbacks[i];
      const fbUrlInput = document.getElementById(`input-fallback-url-${i}`);
      const fbModelSelect = document.getElementById(`select-fallback-${i}`);
      const fbUrl = fbUrlInput ? fbUrlInput.value.trim() : (fb.baseURL || '');
      const fbModel = fbModelSelect ? fbModelSelect.value : (fb.model || DEFAULT_MODEL);
      if (fbUrl) {
        if (!/^https?:\/\/.+/i.test(fbUrl) || !isSecureOrLoopbackBaseURL(fbUrl)) {
          return { fallbacks: null, error: t(currentUiLocale, 'err_fallback_base_url_invalid', { index: i + 1 }) };
        }
      }
      out.push({ id: fb.id || `fb${i + 1}`, model: fbModel, baseURL: fbUrl || undefined });
    }
    return { fallbacks: out, error: null };
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
      widgetVisible: checkboxWidgetVisible ? Boolean(checkboxWidgetVisible.checked) : true,
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

      // Primary API key (saved on change/blur, then masked)
      const keyVal = inputApiKey ? inputApiKey.value.trim() : '';
      if (keyVal) {
        const keyResp = await sendMsg({ action: 'SET_KEY', key: keyVal });
        if (chrome.runtime.lastError || !keyResp || keyResp.error) {
          const err = (keyResp && keyResp.error) || chrome.runtime.lastError || {};
          throw new Error(t(currentUiLocale, 'err_save_key_failed', { error: (err && err.message) || t(currentUiLocale, 'err_unknown') }));
        }
        hasStoredKey = true;
        if (keyStatusIndicator) keyStatusIndicator.textContent = t(currentUiLocale, 'conn_key_stored');
        if (inputApiKey) {
          inputApiKey.value = '';
          inputApiKey.placeholder = t(currentUiLocale, 'conn_key_placeholder_saved');
        }
      }

      // Fallback API keys (saved on change, then masked)
      for (let i = 0; i < fallbacks.length; i++) {
        const fb = fallbacks[i];
        const fbKeyInput = document.getElementById(`input-fallback-key-${i}`);
        const fbKeyVal = fbKeyInput ? fbKeyInput.value.trim() : '';
        if (fbKeyVal) {
          const fbKeyResp = await sendMsg({ action: 'SET_FALLBACK_KEY', id: fb.id, key: fbKeyVal });
          if (chrome.runtime.lastError || !fbKeyResp || fbKeyResp.error) {
            const err = (fbKeyResp && fbKeyResp.error) || chrome.runtime.lastError || {};
            throw new Error(t(currentUiLocale, 'err_save_fallback_key_failed', { index: i + 1, error: (err && err.message) || t(currentUiLocale, 'err_unknown') }));
          }
          fallbackKeyPresence[fb.id] = true;
          if (fbKeyInput) {
            fbKeyInput.value = '';
            fbKeyInput.placeholder = t(currentUiLocale, 'conn_key_placeholder_saved');
          }
        }
      }

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

    if (modalType === 'config') {
      if (modalTitle) modalTitle.textContent = t(currentUiLocale, 'tab_config');
      if (tabPanels['tab-config']) tabPanels['tab-config'].classList.remove('hidden');
      if (tabPanels['tab-log']) tabPanels['tab-log'].classList.add('hidden');
      if (tabPanels['tab-consent']) tabPanels['tab-consent'].classList.add('hidden');
    } else if (modalType === 'log') {
      if (modalTitle) modalTitle.textContent = t(currentUiLocale, 'tab_log');
      if (tabPanels['tab-log']) tabPanels['tab-log'].classList.remove('hidden');
      if (tabPanels['tab-config']) tabPanels['tab-config'].classList.add('hidden');
      if (tabPanels['tab-consent']) tabPanels['tab-consent'].classList.add('hidden');
      loadErrorLog(options);
    } else if (modalType === 'consent') {
      if (modalTitle) modalTitle.textContent = t(currentUiLocale, 'consent_modal_title');
      if (tabPanels['tab-consent']) tabPanels['tab-consent'].classList.remove('hidden');
      if (tabPanels['tab-config']) tabPanels['tab-config'].classList.add('hidden');
      if (tabPanels['tab-log']) tabPanels['tab-log'].classList.add('hidden');
    } else {
      closeModal();
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
    let includeKeys = false;
    if (options && typeof options.withKeys === 'boolean') {
      includeKeys = options.withKeys;
    } else if (checkboxExportKeys) {
      includeKeys = Boolean(checkboxExportKeys.checked);
    } else if (typeof savedSettings.exportIncludeKeys === 'boolean') {
      includeKeys = savedSettings.exportIncludeKeys;
    } else {
      includeKeys = true;
    }

    let confirmedWithKeys = false;
    if (includeKeys) {
      const confirmFn = (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm
        : (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function' ? globalThis.confirm : null);
      const warningMessage = t(currentUiLocale, 'export_keys_warning_confirm');
      const userApproved = confirmFn ? Boolean(confirmFn(warningMessage)) : false;
      if (userApproved) {
        confirmedWithKeys = true;
      }
    }

    let fallbackKeyPresence = {};
    let storedFbKeys = {};
    let storedApiKey = '';

    try {
      const res = await chrome.storage.local.get(['fallback_api_keys', 'api_key']);
      storedFbKeys = (res && res.fallback_api_keys && typeof res.fallback_api_keys === 'object')
        ? res.fallback_api_keys
        : {};
      storedApiKey = (res && typeof res.api_key === 'string') ? res.api_key : '';
      for (const id of Object.keys(storedFbKeys)) {
        if (typeof storedFbKeys[id] === 'string' && storedFbKeys[id].trim()) {
          fallbackKeyPresence[id] = true;
        }
      }
    } catch (err) {
      console.warn('[popup] Failed to read keys for export:', err);
    }

    if (!storedApiKey && inputApiKey && inputApiKey.value && inputApiKey.value.trim()) {
      storedApiKey = inputApiKey.value.trim();
    }

    const payload = buildExportPayload({
      settings: savedSettings,
      fallbackKeyPresence,
      hasStoredKey: Boolean(hasStoredKey || storedApiKey),
      includeKeys: confirmedWithKeys,
      apiKey: storedApiKey,
      fallbackApiKeys: storedFbKeys
    });

    try {
      const jsonStr = JSON.stringify(payload.data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = payload.filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);

      updateStatus(
        'ready',
        confirmedWithKeys ? t(currentUiLocale, 'export_json_with_keys_success') : t(currentUiLocale, 'export_json_success')
      );
    } catch (err) {
      console.warn('[popup] Export JSON failed:', err);
    }
  }

  if (typeof window !== 'undefined') {
    window.triggerExportConfig = triggerExportConfig;
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
    const currentMascot = selectFabMascot?.value || 'default';
    const currentSize = parseFloat(inputFabSize?.value) || 1.0;
    const fullPatch = {
      isPresentation: true,
      fabMascot: currentMascot,
      fabSize: currentSize,
      theme: selectTheme?.value || 'dark',
      uiLocale: currentUiLocale,
      ...patch
    };
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.query === 'function') {
      try {
        chrome.tabs.query({}, (tabs) => {
          if (Array.isArray(tabs)) {
            for (const tab of tabs) {
              if (tab && typeof tab.id === 'number') {
                try {
                  chrome.tabs.sendMessage(tab.id, {
                    action: 'WIDGET_STATE_CHANGED',
                    ...fullPatch
                  }).catch(() => {});
                } catch {}
              }
            }
          }
        });
      } catch {}
    }
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
      const resp = await sendMsg({ action: 'GET_ERROR_LOG' });
      const entries = (resp && resp.ok && Array.isArray(resp.entries)) ? resp.entries : [];
      logList.innerHTML = '';
      if (entries.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'log-empty';
        emptyDiv.textContent = t(currentUiLocale, 'log_empty');
        logList.appendChild(emptyDiv);
        return;
      }
      entries.forEach((entry, idx) => {
        const item = document.createElement('div');
        item.className = 'log-item' + (idx === 0 && highlightFirst ? ' highlight' : '');

        const header = document.createElement('div');
        header.className = 'log-item-header';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-time';
        try {
          const d = new Date(entry.time);
          timeSpan.textContent = isNaN(d.getTime()) ? String(entry.time || '') : d.toLocaleTimeString();
        } catch {
          timeSpan.textContent = String(entry.time || '');
        }

        const codeSpan = document.createElement('span');
        codeSpan.className = 'log-code';
        codeSpan.textContent = entry.code || 'ERROR';

        header.appendChild(timeSpan);
        header.appendChild(codeSpan);

        if (entry.model) {
          const modelSpan = document.createElement('span');
          modelSpan.className = 'log-model';
          modelSpan.textContent = entry.model;
          header.appendChild(modelSpan);
        }

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
        header.appendChild(retryBtn);

        const msgDiv = document.createElement('div');
        msgDiv.className = 'log-message';
        msgDiv.textContent = entry.message || '';

        item.appendChild(header);
        item.appendChild(msgDiv);
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
        if (typeof openModal === 'function' && modalOverlay) {
          openModal('log');
        } else {
          switchTab('tab-log');
        }
      }
    });
  }

  if (tabList) {
    tabList.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (btn && btn.id) {
        if (isModalOpen()) {
          closeModal();
        }
        switchTab(btn.id);
      }
    });

    tabList.addEventListener('keydown', (e) => {
      const currentIdx = tabButtons.findIndex(b => b.id === activeTabNav);
      if (currentIdx === -1) return;

      let nextIdx = -1;
      if (e.key === 'ArrowRight') {
        nextIdx = (currentIdx + 1) % tabButtons.length;
      } else if (e.key === 'ArrowLeft') {
        nextIdx = (currentIdx - 1 + tabButtons.length) % tabButtons.length;
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = tabButtons.length - 1;
      }

      if (nextIdx !== -1) {
        e.preventDefault();
        const nextBtn = tabButtons[nextIdx];
        if (isModalOpen()) {
          closeModal();
        }
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
    if (!favoritesList) return;
    const scopeKey = currentFavKey();
    const bucket = getFavoritesForKey(scopeKey);
    const count = bucket.length;

    if (favoritesCountBadge) {
      favoritesCountBadge.textContent = `${count}/50`;
    }
    if (favoritesSectionTitle) {
      favoritesSectionTitle.textContent = t(currentUiLocale, 'fav_manage_title', { count: String(count) });
    }

    const availableModels = getAvailableModelsToAdd(scopeKey);
    if (selectAddFavorite) {
      selectAddFavorite.setAttribute('aria-label', t(currentUiLocale, 'fav_add_model_aria'));
      selectAddFavorite.innerHTML = '';

      if (availableModels.length === 0) {
        selectAddFavorite.disabled = true;
        if (btnAddFavorite) btnAddFavorite.disabled = true;
        selectAddFavorite.title = t(currentUiLocale, 'fav_no_models_to_add');
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.selected = true;
        opt.textContent = `(${t(currentUiLocale, 'fav_no_models_to_add')})`;
        selectAddFavorite.appendChild(opt);
        if (favoritesAddHint) {
          favoritesAddHint.textContent = t(currentUiLocale, 'fav_no_models_to_add');
          favoritesAddHint.classList.remove('hidden');
        }
      } else if (count >= 50) {
        selectAddFavorite.disabled = true;
        if (btnAddFavorite) btnAddFavorite.disabled = true;
        selectAddFavorite.title = t(currentUiLocale, 'err_favorite_cap_reached');
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.selected = true;
        opt.textContent = `(${t(currentUiLocale, 'err_favorite_cap_reached')})`;
        selectAddFavorite.appendChild(opt);
        if (favoritesAddHint) {
          favoritesAddHint.textContent = t(currentUiLocale, 'err_favorite_cap_reached');
          favoritesAddHint.classList.remove('hidden');
        }
      } else {
        selectAddFavorite.disabled = false;
        if (btnAddFavorite) btnAddFavorite.disabled = false;
        selectAddFavorite.title = '';
        if (favoritesAddHint) {
          favoritesAddHint.textContent = '';
          favoritesAddHint.classList.add('hidden');
        }

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.disabled = true;
        placeholderOpt.selected = true;
        placeholderOpt.textContent = t(currentUiLocale, 'fav_select_add_placeholder');
        selectAddFavorite.appendChild(placeholderOpt);

        const recs = availableModels.filter(m => RECOMMENDED_MODELS.includes(m));
        const others = availableModels.filter(m => !RECOMMENDED_MODELS.includes(m));

        if (recs.length > 0 && others.length > 0) {
          const recGroup = document.createElement('optgroup');
          recGroup.label = t(currentUiLocale, 'model_group_recommended');
          for (const mId of recs) {
            const opt = document.createElement('option');
            opt.value = mId;
            opt.textContent = mId;
            recGroup.appendChild(opt);
          }
          selectAddFavorite.appendChild(recGroup);

          const otherGroup = document.createElement('optgroup');
          otherGroup.label = t(currentUiLocale, 'model_group_other');
          for (const mId of others) {
            const opt = document.createElement('option');
            opt.value = mId;
            opt.textContent = mId;
            otherGroup.appendChild(opt);
          }
          selectAddFavorite.appendChild(otherGroup);
        } else {
          for (const mId of availableModels) {
            const opt = document.createElement('option');
            opt.value = mId;
            opt.textContent = mId;
            selectAddFavorite.appendChild(opt);
          }
        }
      }
    }

    favoritesList.innerHTML = '';
    if (count === 0) {
      if (favoritesEmptyHint) favoritesEmptyHint.classList.remove('hidden');
    } else {
      if (favoritesEmptyHint) favoritesEmptyHint.classList.add('hidden');
      for (const modelId of bucket) {
        const itemRow = document.createElement('div');
        itemRow.className = 'favorite-item-row';
        itemRow.setAttribute('role', 'listitem');

        const modelSpan = document.createElement('span');
        modelSpan.className = 'favorite-model-name';
        modelSpan.textContent = modelId;
        itemRow.appendChild(modelSpan);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-icon btn-danger-icon favorite-delete-btn';
        deleteBtn.title = t(currentUiLocale, 'fav_btn_delete_title');
        deleteBtn.setAttribute('aria-label', t(currentUiLocale, 'fav_btn_delete_title'));
        deleteBtn.innerHTML = SVG_ICONS.trash;
        deleteBtn.addEventListener('click', async () => {
          deleteBtn.disabled = true;
          try {
            await saveFavoriteToggle(scopeKey, modelId, false);
            renderFavoritesSection();
            updateStarButton();
            renderAllModelDropdowns();
          } catch (err) {
            deleteBtn.disabled = false;
            setConfigMsg(configMessageFavorites, (err && err.message) || t(currentUiLocale, 'err_unknown'), true);
          }
        });
        itemRow.appendChild(deleteBtn);

        favoritesList.appendChild(itemRow);
      }
    }
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
    if (btnAddFavorite) btnAddFavorite.disabled = true;
    try {
      await saveFavoriteToggle(scopeKey, modelId, true);
      renderFavoritesSection();
      updateStarButton();
      renderAllModelDropdowns();
      setConfigMsg(configMessageFavorites, t(currentUiLocale, 'fav_added_success'));
    } catch (err) {
      setConfigMsg(configMessageFavorites, (err && err.message) || t(currentUiLocale, 'err_unknown'), true);
    } finally {
      if (btnAddFavorite) {
        const remaining = getAvailableModelsToAdd(scopeKey);
        const updatedBucket = getFavoritesForKey(scopeKey);
        btnAddFavorite.disabled = (remaining.length === 0 || updatedBucket.length >= 50);
      }
    }
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
      if (btn) {
        const subtabId = btn.dataset.subtab || btn.id.replace('subtab-', '');
        switchConfigSubtab(subtabId);
      }
    });

    subtabNav.addEventListener('keydown', (e) => {
      const currentIdx = subtabButtons.findIndex(b => (b.dataset.subtab === activeConfigSubtab || b.id === `subtab-${activeConfigSubtab}`));
      if (currentIdx === -1) return;

      let nextIdx = -1;
      if (e.key === 'ArrowRight') {
        nextIdx = (currentIdx + 1) % subtabButtons.length;
      } else if (e.key === 'ArrowLeft') {
        nextIdx = (currentIdx - 1 + subtabButtons.length) % subtabButtons.length;
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = subtabButtons.length - 1;
      }

      if (nextIdx !== -1) {
        e.preventDefault();
        const nextBtn = subtabButtons[nextIdx];
        const nextSubtabId = nextBtn.dataset.subtab || nextBtn.id.replace('subtab-', '');
        switchConfigSubtab(nextSubtabId);
        nextBtn.focus();
      }
    });
  }

  // Restore remembered config subtab
  try {
    const rememberedSubtab = sessionStorage.getItem('active_config_subtab');
    if (rememberedSubtab && configSubpanels[rememberedSubtab]) {
      switchConfigSubtab(rememberedSubtab);
    } else {
      switchConfigSubtab('connect');
    }
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
    try {
      if (typeof window !== 'undefined' && window.__testActiveTab) {
        activeTab = window.__testActiveTab;
        return true;
      }
      if (typeof chrome === 'undefined' || !chrome?.tabs?.query) {
        return false;
      }
      let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        const allHttpTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        const activeHttp = allHttpTabs.find((t) => t.active) || allHttpTabs[0];
        if (activeHttp) {
          tab = activeHttp;
        }
      }
      activeTab = tab;
      if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        if (btnTranslate) btnTranslate.disabled = true;
        if (btnRestore) btnRestore.disabled = true;
        updateStatus('unsupported', t(currentUiLocale, 'status_unsupported_detail'));
        if (toggleSiteConsent) toggleSiteConsent.disabled = true;
        if (btnOverrideInherit) btnOverrideInherit.disabled = true;
        if (btnOverrideOn) btnOverrideOn.disabled = true;
        if (btnOverrideOff) btnOverrideOff.disabled = true;
        if (siteOriginBadge) { siteOriginBadge.textContent = '--'; siteOriginBadge.classList.add('unsupported'); }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  if (typeof window !== 'undefined') {
    window.__setTestActiveTab = async (tab) => {
      activeTab = tab;
      await loadConsent();
      checkTabStatus();
      evaluateActionReadiness();
    };
    window.__testPopup = {
      renderLanguageDropdowns,
      loadSettings,
      loadConsent,
      loadModels,
      collectSettingsPatch,
      getSavedSettings: () => savedSettings,
      setSavedSettings: (s) => { savedSettings = s; },
      getCurrentConsent: () => currentConsent,
      setCurrentConsent: (c) => { currentConsent = c; },
      updateAutoConsentWarningBanner,
      setConsentUnknownUI,
      updatePrivacyNote,
      openModal,
      closeModal,
      enableSiteForOrigin
    };
  }

  // Translate button busy state (spinner while a run is in flight; cleared
  // whenever the button becomes enabled again or an early return hits)
  function setTranslateBusy(busy) {
    if (!btnTranslate) return;
    btnTranslate.classList.toggle('is-loading', Boolean(busy));
  }

  // Action Readiness Evaluation
  function evaluateActionReadiness(restorableCount = 0) {
    if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
      if (btnTranslate) btnTranslate.disabled = true;
      if (btnRestore) btnRestore.disabled = true;
      setTranslateBusy(false);
      return;
    }

    if (!hasStoredKey) {
      if (btnTranslate) {
        btnTranslate.disabled = true;
        btnTranslate.title = t(currentUiLocale, 'btn_translate_need_key');
      }
      setTranslateBusy(false);
      updateStatus('unconfigured', t(currentUiLocale, 'status_no_key_detail'));
      if (btnRestore) btnRestore.disabled = restorableCount === 0;
      return;
    }

    if (!isDataConsentAccepted(savedSettings)) {
      if (btnTranslate) {
        btnTranslate.disabled = false;
        btnTranslate.title = t(currentUiLocale, 'err_data_consent_required');
      }
      setTranslateBusy(false);
      updateStatus('unconfigured', t(currentUiLocale, 'err_data_consent_required'));
      if (btnRestore) btnRestore.disabled = restorableCount === 0;
      return;
    }

    const curBaseUrl = (inputBaseUrl ? inputBaseUrl.value.trim() : '') || savedSettings?.baseURL || '';
    if (curBaseUrl && !isSecureOrLoopbackBaseURL(curBaseUrl)) {
      if (btnTranslate) {
        btnTranslate.disabled = false;
        btnTranslate.title = t(currentUiLocale, 'privacy_note_insecure');
      }
      setTranslateBusy(false);
      updateStatus('error', t(currentUiLocale, 'privacy_note_insecure'));
      if (btnRestore) btnRestore.disabled = restorableCount === 0;
      return;
    }

    const curModel = selectModel?.value ? selectModel.value.trim() : '';
    if (!curModel || curModel === '' || curModel.includes(t(currentUiLocale, 'status_error')) || curModel.toLowerCase().includes('error')) {
      if (btnTranslate) {
        btnTranslate.disabled = true;
        btnTranslate.title = t(currentUiLocale, 'btn_translate_invalid_model');
      }
      setTranslateBusy(false);
      updateStatus('error', t(currentUiLocale, 'err_select_valid_model'));
      if (btnRestore) btnRestore.disabled = restorableCount === 0;
      return;
    }

    if (btnTranslate) {
      btnTranslate.disabled = false;
      btnTranslate.title = t(currentUiLocale, 'btn_translate_title');
      setTranslateBusy(false);
    }
    if (btnRestore) btnRestore.disabled = restorableCount === 0;
    if (statusText.textContent === t(currentUiLocale, 'status_no_key') || statusText.textContent === t(currentUiLocale, 'status_loading')) {
      updateStatus('ready', t(currentUiLocale, 'status_ready_detail'));
    }
  }

  // Consent Management
  function setConsentUnknownUI(show) {
    if (bannerConsentUnknown) {
      if (show) {
        bannerConsentUnknown.classList.remove('hidden');
        if (bannerConsentUnknownText) {
          bannerConsentUnknownText.textContent = t(currentUiLocale, 'consent_state_unknown');
        }
        if (btnConsentRetryText) {
          btnConsentRetryText.textContent = t(currentUiLocale, 'log_retry');
        }
      } else {
        bannerConsentUnknown.classList.add('hidden');
      }
    }
  }

  async function loadConsent() {
    if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
      if (toggleSiteConsent) toggleSiteConsent.disabled = true;
      if (btnOverrideInherit) btnOverrideInherit.disabled = true;
      if (btnOverrideOn) btnOverrideOn.disabled = true;
      if (btnOverrideOff) btnOverrideOff.disabled = true;
      if (siteOriginBadge) { siteOriginBadge.textContent = '--'; siteOriginBadge.classList.add('unsupported'); }
      currentConsent = {
        siteOrigin: null,
        siteEnabled: false,
        tabOverride: null,
        effective: 'off',
        authoritative: false
      };
      setConsentUnknownUI(false);
      updateAutoConsentWarningBanner();
      return null;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_CONSENT', tabId: activeTab.id }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          if (resp && resp.error && resp.error.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          currentConsent = {
            siteOrigin: null,
            siteEnabled: false,
            tabOverride: null,
            effective: 'off',
            authoritative: false
          };
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

  async function updateTabOverride(val) {
    if (!activeTab || !activeTab.id) return;
    btnOverrideInherit.disabled = true;
    btnOverrideOn.disabled = true;
    btnOverrideOff.disabled = true;

    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'SET_TAB_OVERRIDE',
        tabId: activeTab.id,
        value: val
      }, resolve);
    });

    btnOverrideInherit.disabled = false;
    btnOverrideOn.disabled = false;
    btnOverrideOff.disabled = false;

    if (chrome.runtime.lastError || !resp || resp.error) {
      const err = resp?.error || chrome.runtime.lastError;
      updateStatus('error', `[${err.code || 'ERROR'}] ${err.message || t(currentUiLocale, 'err_save_tab_override_failed')}`);
      return;
    }

    await loadConsent();
    await checkTabStatus();
  }

  if (toggleSiteConsent) {
    toggleSiteConsent.addEventListener('change', async () => {
      if (!currentConsent.siteOrigin) return;
      const targetChecked = toggleSiteConsent.checked;
      const prevChecked = !targetChecked;
      toggleSiteConsent.disabled = true;

      if (targetChecked) {
        const matchPattern = currentConsent.siteOrigin + '/*';
        let granted = false;
        try {
          if (chrome.permissions && typeof chrome.permissions.request === 'function') {
            granted = await chrome.permissions.request({ origins: [matchPattern] });
          } else {
            granted = true;
          }
        } catch {
          granted = false;
        }

        if (!granted) {
          toggleSiteConsent.checked = prevChecked;
          toggleSiteConsent.disabled = false;
          updateStatus('error', t(currentUiLocale, 'status_missing_perm'));
          return;
        }
      }

      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'SET_SITE_ENABLED',
          origin: currentConsent.siteOrigin,
          enabled: targetChecked,
          tabId: activeTab?.id
        }, resolve);
      });

      if (chrome.runtime.lastError || !resp || resp.error) {
        toggleSiteConsent.checked = prevChecked;
        toggleSiteConsent.disabled = false;
        const err = resp?.error || chrome.runtime.lastError;
        updateStatus('error', `[${err.code || 'ERROR'}] ${err.message || t(currentUiLocale, 'err_save_site_perm_failed')}`);
        return;
      }

      toggleSiteConsent.disabled = false;
      await loadConsent();
      await checkTabStatus();
    });
  }

  if (btnOverrideInherit) {
    btnOverrideInherit.addEventListener('click', () => updateTabOverride(null));
  }
  if (btnOverrideOn) {
    btnOverrideOn.addEventListener('click', () => updateTabOverride('on'));
  }
  if (btnOverrideOff) {
    btnOverrideOff.addEventListener('click', () => updateTabOverride('off'));
  }

  // Model Dropdown Builder (favorites group is Base URL scoped via `favs`)
  function populateSelect(selectEl, selectedVal, { allowEmpty = false, emptyLabel = t(currentUiLocale, 'model_empty_label'), exclude = [], favs = null } = {}) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    const scopeFavs = Array.isArray(favs) ? favs : primaryFavorites();
    const showFavsOnly = Boolean(savedSettings && savedSettings.showFavoritesOnly);

    if (allowEmpty) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = emptyLabel;
      selectEl.appendChild(emptyOpt);
    }

    if (showFavsOnly) {
      if (scopeFavs.length > 0) {
        const added = new Set(exclude.filter(id => id !== selectedVal));
        const validFavs = scopeFavs.filter(id => !added.has(id));
        for (const mId of validFavs) {
          const opt = document.createElement('option');
          opt.value = mId;
          opt.textContent = mId;
          selectEl.appendChild(opt);
          added.add(mId);
        }
        if (selectedVal && !added.has(selectedVal) && !allowEmpty) {
          const opt = document.createElement('option');
          opt.value = selectedVal;
          opt.textContent = selectedVal;
          selectEl.appendChild(opt);
          added.add(selectedVal);
        }
        if (selectedVal && Array.from(selectEl.options).some(o => o.value === selectedVal)) {
          selectEl.value = selectedVal;
        } else if (allowEmpty) {
          selectEl.value = '';
        } else if (validFavs.length > 0) {
          selectEl.value = validFavs[0];
        } else {
          selectEl.value = DEFAULT_MODEL;
        }
        return;
      } else {
        const hintOpt = document.createElement('option');
        hintOpt.disabled = true;
        hintOpt.textContent = `(${t(currentUiLocale, 'fav_empty_hint_dropdown')})`;
        selectEl.appendChild(hintOpt);
      }
    }

    const added = new Set(exclude.filter(id => id !== selectedVal));

    // Group 1: Favorites (Base URL scoped)
    const validFavs = scopeFavs.filter(id => !added.has(id));
    if (validFavs.length > 0) {
      const favGroup = document.createElement('optgroup');
      favGroup.label = t(currentUiLocale, 'model_group_favorites');
      for (const mId of validFavs) {
        const opt = document.createElement('option');
        opt.value = mId;
        opt.textContent = mId;
        favGroup.appendChild(opt);
        added.add(mId);
      }
      selectEl.appendChild(favGroup);
    }

    // Group 2: Currently Selected
    if (selectedVal && !added.has(selectedVal)) {
      const curGroup = document.createElement('optgroup');
      curGroup.label = t(currentUiLocale, 'model_group_saved');
      const opt = document.createElement('option');
      opt.value = selectedVal;
      opt.textContent = selectedVal;
      curGroup.appendChild(opt);
      selectEl.appendChild(curGroup);
      added.add(selectedVal);
    }

    // Group 3: Recommended
    const recs = RECOMMENDED_MODELS.filter(id => !added.has(id));
    if (recs.length > 0) {
      const recGroup = document.createElement('optgroup');
      recGroup.label = t(currentUiLocale, 'model_group_recommended');
      for (const mId of recs) {
        const opt = document.createElement('option');
        opt.value = mId;
        opt.textContent = mId;
        recGroup.appendChild(opt);
        added.add(mId);
      }
      selectEl.appendChild(recGroup);
    }

    // Group 4: Other models from server / cache
    const serverModelIds = discoveredModels
      .map(m => typeof m === 'string' ? m : m.id)
      .filter(id => id && !added.has(id));

    if (serverModelIds.length > 0) {
      const otherGroup = document.createElement('optgroup');
      otherGroup.label = t(currentUiLocale, 'model_group_other');
      for (const mId of serverModelIds) {
        const opt = document.createElement('option');
        opt.value = mId;
        opt.textContent = mId;
        otherGroup.appendChild(opt);
        added.add(mId);
      }
      selectEl.appendChild(otherGroup);
    }

    // Set selection
    if (selectedVal && Array.from(selectEl.options).some(o => o.value === selectedVal)) {
      selectEl.value = selectedVal;
    } else if (allowEmpty) {
      selectEl.value = '';
    } else {
      selectEl.value = DEFAULT_MODEL;
    }
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
    renderFallbackList({
      container: fallbackListEl,
      fallbacks,
      btnAddFallback,
      currentUiLocale,
      SVG_ICONS,
      fallbackKeyPresence,
      favKeyForFallback,
      getFavoritesForKey,
      updateFallbackStar,
      populateSelect,
      t,
      wireFavButton: wireFallbackFavButton,
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

      fallbacks.push({
        id: nextId,
        model: defaultFbModel,
        baseURL: ''
      });

      renderFallbackRows();
      renderAllModelDropdowns();
      flushAutosave();
    });
  }

  function renderAllModelDropdowns() {
    const curPrimary = selectModel?.value || savedSettings.model || DEFAULT_MODEL;
    populateSelect(selectModel, curPrimary, { allowEmpty: false, exclude: [] });

    // Populate dynamic fallback dropdowns (favorites scoped per row URL)
    fallbacks.forEach((fb, idx) => {
      const selectEl = document.getElementById(`select-fallback-${idx}`);
      if (selectEl) {
        const curFbModel = fb.model || selectEl.value || RECOMMENDED_MODELS[idx + 1] || DEFAULT_MODEL;
        populateSelect(selectEl, curFbModel, {
          allowEmpty: false,
          exclude: [selectModel.value].filter(Boolean),
          favs: getFavoritesForKey(favKeyForFallback(fb))
        });
        if (selectEl.value) {
          fb.model = selectEl.value;
        }
        updateFallbackStar(document.getElementById(`btn-fallback-fav-${idx}`), fb, selectEl);
      }
    });

    // Populate per-site model dropdowns with current discovered models and primary favorites
    autoTranslateSites.forEach((site, idx) => {
      const siteModelSelect = document.getElementById(`select-site-model-${idx}`);
      if (siteModelSelect) {
        const curSiteModel = site.model || siteModelSelect.value || '';
        populateSelect(siteModelSelect, curSiteModel, {
          allowEmpty: true,
          emptyLabel: t(currentUiLocale, 'site_model_inherit'),
          favs: primaryFavorites()
        });
        if (curSiteModel && siteModelSelect.value !== curSiteModel) {
          const opt = document.createElement('option');
          opt.value = curSiteModel;
          opt.textContent = curSiteModel;
          siteModelSelect.appendChild(opt);
          siteModelSelect.value = curSiteModel;
        }
      }
    });

    updateStarButton();
    renderFavoritesSection();
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
        if (btnRefreshModels) btnRefreshModels.disabled = false;

        if (chrome.runtime.lastError || !resp || resp.error) {
          const err = resp?.error || chrome.runtime.lastError;
          if (err && err.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          if (forceRefresh) {
            setConfigMsg(configMessageConnect, t(currentUiLocale, 'err_load_models', { error: err?.message || t(currentUiLocale, 'err_cannot_connect') }), true);
          }
          renderAllModelDropdowns();
          evaluateActionReadiness();
          resolve();
          return;
        }

        if (resp && resp.models && Array.isArray(resp.models)) {
          discoveredModels = resp.models;
        }

        renderAllModelDropdowns();
        evaluateActionReadiness();

        if (forceRefresh) {
          setConfigMsg(configMessageConnect, t(currentUiLocale, 'msg_models_refreshed'));
        }
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
          if (savedSettings.sourceLanguage && !SOURCE_LANGS.some(l => l.code === savedSettings.sourceLanguage)) {
            savedSettings.sourceLanguage = 'auto';
          }
          if (savedSettings.targetLanguage && !TARGET_LANGS.some(l => l.code === savedSettings.targetLanguage)) {
            savedSettings.targetLanguage = 'vi';
          }
          if (inputBaseUrl) inputBaseUrl.value = resp.settings.baseURL || 'http://localhost:8080/v1';

          if (selectSrcLang && resp.settings.sourceLanguage) {
            const rawSrc = resp.settings.sourceLanguage;
            selectSrcLang.value = SOURCE_LANGS.some(l => l.code === rawSrc) ? rawSrc : 'auto';
          }
          if (selectTgtLang && resp.settings.targetLanguage) {
            const rawTgt = resp.settings.targetLanguage;
            selectTgtLang.value = TARGET_LANGS.some(l => l.code === rawTgt) ? rawTgt : 'vi';
          }

          if (resp.settings.translationMode) {
            currentMode = resp.settings.translationMode;
          }

          if (checkboxWidgetVisible && typeof resp.settings.widgetVisible === 'boolean') {
            checkboxWidgetVisible.checked = resp.settings.widgetVisible;
          }
          if (checkboxFavoritesOnly && typeof resp.settings.showFavoritesOnly === 'boolean') {
            checkboxFavoritesOnly.checked = resp.settings.showFavoritesOnly;
          }
          if (checkboxExportKeys) {
            checkboxExportKeys.checked = typeof resp.settings.exportIncludeKeys === 'boolean'
              ? resp.settings.exportIncludeKeys
              : true;
          }

          if (resp.settings.uiLocale) {
            applyUiLocale(resp.settings.uiLocale);
          } else {
            applyUiLocale('vi');
          }
          if (resp.settings.theme) {
            applyTheme(resp.settings.theme);
          } else {
            applyTheme('dark');
          }
          if (resp.settings.uiFontScale) {
            applyFontScale(resp.settings.uiFontScale);
          } else {
            applyFontScale('md');
          }
          if (typeof resp.settings.fabSize === 'number') {
            updateFabSizeDisplay(resp.settings.fabSize);
          } else {
            updateFabSizeDisplay(1.0);
          }
          applyFabMascot(resp.settings.fabMascot || 'default');

          favoriteModelsByBaseURL = (resp.settings.favoriteModelsByBaseURL && typeof resp.settings.favoriteModelsByBaseURL === 'object' && !Array.isArray(resp.settings.favoriteModelsByBaseURL))
            ? JSON.parse(JSON.stringify(resp.settings.favoriteModelsByBaseURL))
            : {};
          lastFavKey = normalizeBaseURLKey(resp.settings.baseURL || '');
          fallbacks = Array.isArray(resp.settings.fallbacks) ? JSON.parse(JSON.stringify(resp.settings.fallbacks)) : [];
          autoTranslateSites = Array.isArray(resp.settings.autoTranslateSites) ? [...resp.settings.autoTranslateSites] : [];

          hasStoredKey = Boolean(resp.hasKey);
          fallbackKeyPresence = resp.fallbackKeyPresence || {};

          if (keyStatusIndicator) {
            keyStatusIndicator.textContent = hasStoredKey ? t(currentUiLocale, 'conn_key_stored') : t(currentUiLocale, 'conn_key_not_stored');
          }
          if (inputApiKey && !inputApiKey.value) {
            inputApiKey.placeholder = t(currentUiLocale, hasStoredKey ? 'conn_key_placeholder_saved' : 'conn_api_key_placeholder');
          }

          if (inputRateTab) {
            const tabVal = resp.settings.rateLimits?.tab?.maxBatches;
            inputRateTab.value = (typeof tabVal === 'number') ? tabVal : 4;
          }
          if (inputRateSite) {
            const siteVal = resp.settings.rateLimits?.site?.maxBatches;
            inputRateSite.value = (typeof siteVal === 'number') ? siteVal : 12;
          }
          if (inputRateConcurrency) {
            const concVal = resp.settings.providerConcurrency;
            inputRateConcurrency.value = (typeof concVal === 'number') ? concVal : 2;
          }

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
  function formatElapsed(ms) {
    return formatElapsedModule(ms);
  }

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
      return formatDetailModule(state, data, {
        currentUiLocale,
        t,
        showKeyAccessBanner,
        selectModel,
        DEFAULT_MODEL
      });
    }
    return formatDetailModule(state, data, {
      currentUiLocale,
      t,
      showKeyAccessBanner,
      selectModel,
      DEFAULT_MODEL
    });
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
  let rateLimitsHintTimer = null;
  function showRateLimitsHint(msg) {
    if (!rateLimitsHint) return;
    rateLimitsHint.textContent = msg;
    rateLimitsHint.style.display = 'block';
    if (rateLimitsHintTimer) clearTimeout(rateLimitsHintTimer);
    rateLimitsHintTimer = setTimeout(() => {
      if (rateLimitsHint) rateLimitsHint.style.display = 'none';
      rateLimitsHintTimer = null;
    }, 4000);
  }

  function setupRateLimitInput(inputEl, min, max, defaultVal) {
    if (!inputEl) return;
    const validateAndClamp = (triggerAutosave = false) => {
      const raw = inputEl.value.trim();
      const num = parseInt(raw, 10);
      if (raw === '' || isNaN(num)) {
        inputEl.value = defaultVal;
        showRateLimitsHint(t(currentUiLocale, 'conn_rate_clamp_hint', { min, max }));
        if (triggerAutosave) markDirty();
        return;
      }
      if (num < min || num > max) {
        const clamped = Math.max(min, Math.min(max, num));
        inputEl.value = clamped;
        showRateLimitsHint(t(currentUiLocale, 'conn_rate_clamp_hint', { min, max }));
        if (triggerAutosave) markDirty();
      } else {
        if (num !== Number(raw)) {
          inputEl.value = num;
        }
        if (triggerAutosave) markDirty();
      }
    };

    inputEl.addEventListener('input', () => {
      validateAndClamp(true);
    });
    inputEl.addEventListener('change', () => {
      validateAndClamp(true);
    });
    inputEl.addEventListener('blur', () => {
      validateAndClamp(true);
    });
  }

  setupRateLimitInput(inputRateTab, 1, 20, 4);
  setupRateLimitInput(inputRateSite, 1, 60, 12);
  setupRateLimitInput(inputRateConcurrency, 1, 4, 2);

  async function getBaseOrigin() {
    const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : (savedSettings.baseURL || '');
    if (!rawUrl) return null;
    try {
      return new URL(rawUrl).origin;
    } catch {
      return null;
    }
  }

  // SW fetch to Base URL needs its host permission; request it inside a user
  // gesture (autosave/refresh-without-gesture cannot). Shared by Translate,
  // refresh-models and the shield button.
  async function ensureBaseUrlPermission() {
    const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : (savedSettings.baseURL || '');
    if (!rawUrl) return { ok: false, reason: 'invalid' };
    if (!isSecureOrLoopbackBaseURL(rawUrl)) {
      return { ok: false, reason: 'insecure' };
    }
    const origin = await getBaseOrigin();
    if (!origin) return { ok: false, reason: 'invalid' };
    if (!chrome.permissions || typeof chrome.permissions.contains !== 'function') {
      return { ok: true };
    }
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
      if (!granted && typeof chrome.permissions.request === 'function') {
        granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      }
    } catch {
      granted = false;
    }
    await refreshBasePermState();
    return granted ? { ok: true } : { ok: false, reason: 'denied' };
  }

  async function refreshBasePermState() {
    if (!btnBasePerm) return;
    const origin = await getBaseOrigin();
    let granted = false;
    if (origin && typeof chrome !== 'undefined' && chrome.permissions && typeof chrome.permissions.contains === 'function') {
      try {
        granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
      } catch {}
    }
    btnBasePerm.classList.toggle('granted', granted);
    btnBasePerm.title = granted
      ? t(currentUiLocale, 'perm_granted_origin', { origin })
      : t(currentUiLocale, 'perm_request_origin', { origin: origin || t(currentUiLocale, 'err_url_invalid') });
    btnBasePerm.setAttribute('aria-label', btnBasePerm.title);
  }

  if (btnBasePerm) {
    btnBasePerm.addEventListener('click', async () => {
      const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : (savedSettings.baseURL || '');
      if (rawUrl && !isSecureOrLoopbackBaseURL(rawUrl)) {
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'privacy_note_insecure'), true);
        updateStatus('error', t(currentUiLocale, 'privacy_note_insecure'));
        return;
      }
      const origin = await getBaseOrigin();
      if (!origin) {
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'err_base_url_invalid'), true);
        return;
      }
      let granted = false;
      try {
        if (chrome.permissions && typeof chrome.permissions.request === 'function') {
          granted = await chrome.permissions.request({ origins: [origin + '/*'] });
        } else {
          granted = true;
        }
      } catch {
        granted = false;
      }
      if (!granted) {
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'err_base_url_perm_needed'), true);
        updateStatus('error', t(currentUiLocale, 'err_perm_required_base'));
      }
      await refreshBasePermState();
      await checkTabStatus();
    });
  }


  // Delete API Key
  if (btnDeleteKey) {
    btnDeleteKey.addEventListener('click', async () => {
      btnDeleteKey.disabled = true;
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'DELETE_KEY' }, resolve);
      });
      btnDeleteKey.disabled = false;

      if (chrome.runtime.lastError || !resp || resp.error) {
        const err = resp?.error || chrome.runtime.lastError;
        setConfigMsg(configMessageConnect, t(currentUiLocale, 'err_delete_key_failed', { error: err.message || '' }), true);
        return;
      }

      hasStoredKey = false;
      fallbackKeyPresence = {};
      if (keyStatusIndicator) keyStatusIndicator.textContent = t(currentUiLocale, 'conn_key_not_stored');
      if (inputApiKey) {
        inputApiKey.value = '';
        inputApiKey.placeholder = t(currentUiLocale, 'conn_api_key_placeholder');
      }
      renderFallbackRows();
      setConfigMsg(configMessageConnect, t(currentUiLocale, 'msg_key_deleted'));
      evaluateActionReadiness();
      await checkTabStatus();
    });
  }

  // Tab 1: autosave (no save button). Language + widget changes persist
  // immediately; failures revert to last saved values.
  if (selectSrcLang) {
    selectSrcLang.addEventListener('change', () => {
      markDirty();
    });
  }
  if (selectTgtLang) {
    selectTgtLang.addEventListener('change', () => {
      markDirty();
    });
  }
  if (checkboxWidgetVisible) {
    checkboxWidgetVisible.addEventListener('change', () => {
      markDirty();
    });
  }
  if (checkboxExportKeys) {
    checkboxExportKeys.addEventListener('change', () => {
      savedSettings.exportIncludeKeys = Boolean(checkboxExportKeys.checked);
      markDirty();
    });
  }
  if (selectUiLocale) {
    selectUiLocale.addEventListener('change', () => {
      applyUiLocale(selectUiLocale.value);
      markDirty();
    });
  }
  if (selectTheme) {
    selectTheme.addEventListener('change', () => {
      applyTheme(selectTheme.value);
      markDirty();
    });
  }
  if (selectUiFontScale) {
    selectUiFontScale.addEventListener('change', () => {
      applyFontScale(selectUiFontScale.value);
      markDirty();
    });
  }
  if (inputFabSize) {
    inputFabSize.addEventListener('input', () => {
      updateFabSizeDisplay(inputFabSize.value);
      markDirty();
    });
  }
  if (btnResetFabSize) {
    btnResetFabSize.addEventListener('click', () => {
      updateFabSizeDisplay(1.0);
      markDirty();
    });
  }
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
  if (btnHeaderMenu) {
    btnHeaderMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });
  }
  if (menuBackdrop) {
    menuBackdrop.addEventListener('click', closeMenu);
  }
  if (menuItemConfig) {
    menuItemConfig.addEventListener('click', () => {
      openModal('config', { opener: btnHeaderMenu });
    });
  }
  if (menuItemLog) {
    menuItemLog.addEventListener('click', () => {
      openModal('log', { opener: btnHeaderMenu });
    });
  }
  if (menuItemImport && inputImportConfig) {
    menuItemImport.addEventListener('click', () => {
      closeMenu();
      inputImportConfig.click();
    });
    inputImportConfig.addEventListener('change', () => triggerImportConfig(inputImportConfig.files?.[0]));
  }
  if (menuItemExport) {
    menuItemExport.addEventListener('click', () => {
      closeMenu();
      triggerExportConfig();
    });
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', closeModal);
  }
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeModal);
  }
  if (btnExportConfigConnect) {
    btnExportConfigConnect.addEventListener('click', triggerExportConfig);
  }
  if (btnImportConfigConnect && inputImportConfigConnect) {
    btnImportConfigConnect.addEventListener('click', () => inputImportConfigConnect.click());
    inputImportConfigConnect.addEventListener('change', () => triggerImportConfig(inputImportConfigConnect.files?.[0]));
  }
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
    if (!privacyNote) return;
    const urlToCheck = baseURL || (inputBaseUrl ? inputBaseUrl.value.trim() : '') || savedSettings?.baseURL || 'http://localhost:8080/v1';
    const state = computePrivacyNoteState(urlToCheck);
    const msg = t(currentUiLocale, state.noteKey);
    privacyNote.title = msg;
    privacyNote.setAttribute('aria-label', msg);
    const svgIcon = privacyNote.querySelector('svg');
    if (svgIcon) {
      svgIcon.classList.remove('text-warning', 'text-danger');
      svgIcon.classList.toggle('text-muted', state.isMuted);
      svgIcon.classList.toggle('text-warning', state.isWarning);
    }
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

  // WI-50 Auto-Start Warning Banner
  function updateAutoConsentWarningBanner() {
    if (!bannerAutoConsentWarning) return;
    const branchInfo = evaluateAutoConsentWarningBranch(currentConsent, autoTranslateSites);
    if (!branchInfo.show) {
      bannerAutoConsentWarning.classList.add('hidden');
      return;
    }

    bannerAutoConsentWarning.classList.remove('hidden');
    if (branchInfo.branch === 'tab_override_off') {
      if (bannerAutoWarningText) {
        bannerAutoWarningText.textContent = t(currentUiLocale, 'banner_auto_tab_override_off');
      }
      if (btnBannerEnableSite) {
        btnBannerEnableSite.classList.add('hidden');
      }
    } else {
      if (bannerAutoWarningText) {
        bannerAutoWarningText.textContent = t(currentUiLocale, 'banner_auto_site_off');
      }
      if (btnBannerEnableSite) {
        btnBannerEnableSite.classList.remove('hidden');
        if (btnBannerEnableSiteText) {
          btnBannerEnableSiteText.textContent = t(currentUiLocale, 'btn_enable_site_format', { origin: branchInfo.origin });
        }
      }
    }
  }

  if (btnBannerEnableSite) {
    btnBannerEnableSite.addEventListener('click', async () => {
      const origin = currentConsent?.siteOrigin || (activeTab?.url ? normalizeOrigin(activeTab.url) : null);
      if (!origin) return;
      btnBannerEnableSite.disabled = true;
      const res = await enableSiteForOrigin(origin);
      btnBannerEnableSite.disabled = false;
      if (!res.ok) {
        updateStatus('error', res.reason === 'permission'
          ? t(currentUiLocale, 'err_perm_required_site')
          : t(currentUiLocale, 'err_enable_site_failed_short'));
        return;
      }
      await loadConsent();
      await refreshSiteDots();
      updateAutoConsentWarningBanner();
      evaluateActionReadiness();
    });
  }

  // Tab 2 Auto-Translate Sites Management
  function showAutoSiteError(msg) {
    showAutoSiteErrorModule(autoSiteError, msg);
  }

  function hideAutoSiteError() {
    hideAutoSiteErrorModule(autoSiteError);
  }

  async function enableSiteForOrigin(origin) {
    return enableSiteForOriginModule(origin, sendMsg);
  }

  async function refreshSiteDots() {
    return refreshSiteDotsModule({
      autoSitesList,
      autoTranslateSites,
      currentUiLocale,
      t
    });
  }

  function renderAutoSites() {
    renderAutoSitesList({
      container: autoSitesList,
      autoTranslateSites,
      currentUiLocale,
      SVG_ICONS,
      SOURCE_LANGS,
      TARGET_LANGS,
      getLanguageLabel,
      populateSelect,
      primaryFavorites,
      t,
      refreshSiteDots,
      callbacks: {
        onEnable: async (site, enableBtn) => {
          hideAutoSiteError();
          enableBtn.disabled = true;
          const res = await enableSiteForOrigin(site.origin);
          enableBtn.disabled = false;
          if (!res.ok) {
            showAutoSiteError(res.reason === 'permission'
              ? t(currentUiLocale, 'err_perm_site_needed', { origin: site.origin })
              : t(currentUiLocale, 'err_enable_site_failed', { origin: site.origin, error: (res.error && res.error.message) || t(currentUiLocale, 'err_cannot_save') }));
          }
          if (site.origin === currentConsent.siteOrigin) {
            await loadConsent();
          }
          refreshSiteDots();
        },
        onModeChange: () => markDirty(),
        onAutoStartChange: () => {
          markDirty();
          refreshSiteDots();
        },
        onDelete: async (site, deleteBtn) => {
          hideAutoSiteError();
          if (!settingsLoaded) {
            showAutoSiteError(getSettingsNotLoadedMsg());
            return;
          }
          const updatedList = autoTranslateSites.filter((s) => (s.origin || s) !== site.origin);
          deleteBtn.disabled = true;

          const saveResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              action: 'SAVE_SETTINGS',
              settings: { autoTranslateSites: updatedList }
            }, resolve);
          });

          if (chrome.runtime.lastError || !saveResp || saveResp.error) {
            const err = saveResp?.error || chrome.runtime.lastError;
            showAutoSiteError(t(currentUiLocale, 'err_delete_site_failed', { error: err?.message || t(currentUiLocale, 'err_cannot_save') }));
            deleteBtn.disabled = false;
            return;
          }

          autoTranslateSites = updatedList;
          savedSettings.autoTranslateSites = JSON.parse(JSON.stringify(updatedList));
          renderAutoSites();
        },
        onSourceLangChange: () => markDirty(),
        onTargetLangChange: () => markDirty(),
        onModelChange: () => markDirty()
      }
    });
  }

  async function commitAutoSite(norm) {
    return commitAutoSiteModule({
      norm,
      settingsLoaded,
      autoTranslateSites,
      savedSettings,
      sendMsg,
      enableSiteForOriginFn: enableSiteForOrigin,
      currentConsent,
      loadConsent,
      renderAutoSites,
      refreshSiteDotsFn: refreshSiteDots,
      showAutoSiteErrorFn: showAutoSiteError,
      getSettingsNotLoadedMsg,
      currentUiLocale,
      t
    });
  }

  function openDraftAutoSite() {
    openDraftAutoSiteModule({
      autoSitesList,
      activeTab,
      autoTranslateSites,
      currentUiLocale,
      SVG_ICONS,
      commitAutoSiteFn: commitAutoSite,
      showAutoSiteErrorFn: showAutoSiteError,
      hideAutoSiteErrorFn: hideAutoSiteError,
      t
    });
  }

  if (btnAddCurrentSite) {
    btnAddCurrentSite.addEventListener('click', () => {
      openDraftAutoSite();
    });
  }


  // Translate Page Action
  if (btnTranslate) {
    btnTranslate.addEventListener('click', async () => {
      if (!activeTab || !activeTab.id) return;
      if (!settingsLoaded) {
        updateStatus('error', '[ERROR] ' + getSettingsNotLoadedMsg());
        evaluateActionReadiness();
        return;
      }

      if (!isDataConsentAccepted(savedSettings)) {
        openModal('consent');
        updateStatus('error', t(currentUiLocale, 'err_data_consent_required'));
        evaluateActionReadiness();
        return;
      }

      btnTranslate.disabled = true;
      setTranslateBusy(true);
      updateStatus('translating', t(currentUiLocale, 'status_translating_prep'));
      startPolling();

      try {
        // Flush pending autosave first so the stored config (not stale field
        // values) is the single source of truth for this run.
        await flushAutosave();

        // SW fetch to Base URL needs its host permission; request it here in
        // the click gesture if not granted yet (autosave cannot request it).
        const basePerm = await ensureBaseUrlPermission();
        if (!basePerm.ok) {
          stopPolling();
          if (basePerm.reason === 'insecure') {
            updateStatus('error', t(currentUiLocale, 'privacy_note_insecure'));
            setConfigMsg(configMessageConnect, t(currentUiLocale, 'privacy_note_insecure'), true);
          } else {
            updateStatus('error', t(currentUiLocale, 'err_perm_required_base'));
            setConfigMsg(configMessageConnect, basePerm.reason === 'invalid' ? t(currentUiLocale, 'err_base_url_invalid') : t(currentUiLocale, 'err_base_url_perm_needed'), true);
          }
          evaluateActionReadiness();
          return;
        }

        // Site consent: Tab 1 has no toggle — enable automatically in this
        // click gesture so one Translate press does everything.
        const pageOrigin = activeTab?.url ? normalizeOrigin(activeTab.url) : null;
        if (pageOrigin && !currentConsent.siteEnabled) {
          updateStatus('translating', t(currentUiLocale, 'status_enabling_site'));
          const enRes = await enableSiteForOrigin(pageOrigin);
          if (!enRes.ok) {
            stopPolling();
            updateStatus('error', enRes.reason === 'permission'
              ? t(currentUiLocale, 'err_perm_required_site')
              : t(currentUiLocale, 'err_enable_site_failed_short'));
            evaluateActionReadiness();
            return;
          }
          currentConsent.siteEnabled = true;
          await loadConsent();
        }

        const ensureResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'ENSURE_CONTENT',
            tabId: activeTab.id
          }, resolve);
        });

        if (ensureResp && ensureResp.error) {
          stopPolling();
          updateStatus('error', formatDetail('error', { error: ensureResp.error }));
          evaluateActionReadiness();
          return;
        }

        const curOrigin = activeTab?.url ? normalizeOrigin(activeTab.url) : null;
        const matchingSite = curOrigin ? autoTranslateSites.find((s) => (s.origin || s) === curOrigin) : null;
        const effectiveSiteMode = (matchingSite && matchingSite.mode && matchingSite.mode !== 'inherit')
          ? matchingSite.mode
          : (savedSettings.translationMode || currentMode || 'scroll-follow');
        const effectiveSiteModel = (matchingSite && matchingSite.model)
          ? matchingSite.model
          : (savedSettings.model || selectModel?.value || DEFAULT_MODEL);

        const currentSettings = {
          baseURL: savedSettings.baseURL || 'http://localhost:8080/v1',
          model: effectiveSiteModel,
          sourceLanguage: savedSettings.sourceLanguage || selectSrcLang?.value || 'auto',
          targetLanguage: savedSettings.targetLanguage || selectTgtLang?.value || 'vi',
          translationMode: effectiveSiteMode
        };

        chrome.tabs.sendMessage(
          activeTab.id,
          { action: 'CONTENT_START_TRANSLATION', settings: currentSettings, mode: effectiveSiteMode },
          (resp) => {
            stopPolling();
            if (chrome.runtime.lastError) {
              updateStatus('error', chrome.runtime.lastError.message || t(currentUiLocale, 'err_cannot_connect_content'));
              evaluateActionReadiness();
              return;
            }
            if (resp && resp.error) {
              updateStatus('error', formatDetail('error', {
                error: resp.error,
                elapsedMs: resp.elapsedMs,
                model: resp.model || currentSettings.model,
                actualModel: resp.actualModel,
                fallbackIndex: resp.fallbackIndex
              }));
              evaluateActionReadiness();
              return;
            }

            if (currentMode === 'scroll-follow' || resp?.watching) {
              startPolling();
              updateStatus('watching', formatDetail('watching', {
                applied: resp?.applied || 0,
                totalApplied: resp?.applied || 0,
                totalCollected: resp?.collected || 0,
                elapsedMs: resp?.elapsedMs,
                model: resp?.model || currentSettings.model,
                actualModel: resp?.actualModel,
                fallbackIndex: resp?.fallbackIndex
              }));
            } else {
              updateStatus('translated', formatDetail('translated', {
                applied: resp?.applied || 0,
                totalCollected: resp?.collected,
                totalApplied: resp?.applied,
                failed: resp?.failed || 0,
                totalFailed: resp?.failed || 0,
                elapsedMs: resp?.elapsedMs,
                model: resp?.model || currentSettings.model,
                actualModel: resp?.actualModel,
                fallbackIndex: resp?.fallbackIndex
              }));
            }
            evaluateActionReadiness(resp?.applied || 0);
          }
        );
      } catch (err) {
        stopPolling();
        updateStatus('error', err?.message || t(currentUiLocale, 'err_cannot_inject_content'));
        evaluateActionReadiness();
      }
    });
  }

  // Restore Page Action
  if (btnRestore) {
    btnRestore.addEventListener('click', async () => {
      if (!activeTab || !activeTab.id) return;

      btnRestore.disabled = true;
      stopPolling();
      chrome.tabs.sendMessage(activeTab.id, { action: 'CONTENT_RESTORE' }, (resp) => {
        if (chrome.runtime.lastError) {
          updateStatus('error', chrome.runtime.lastError.message);
          btnRestore.disabled = false;
          return;
        }
        const restored = resp?.restored || 0;
        updateStatus('restored', t(currentUiLocale, 'detail_restored_nodes_original', { count: restored }));
        btnRestore.disabled = true;
        evaluateActionReadiness(0);
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
