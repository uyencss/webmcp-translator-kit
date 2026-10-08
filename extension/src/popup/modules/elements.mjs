// WebMCP Translator Kit — Popup Module: DOM Elements Selector
// Consolidates all DOM element queries for popup interface

export function getPopupElements(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc) return {};
  const byId = (id) => doc.getElementById(id);
  const qs = (sel) => doc.querySelector(sel);
  const qsa = (sel) => Array.from(doc.querySelectorAll(sel));

  const tabPanels = {
    'tab-translate': byId('tabpanel-translate'),
    'tab-auto': byId('tabpanel-auto'),
    'tab-config': byId('tabpanel-config'),
    'tab-log': byId('tabpanel-log'),
    'tab-consent': byId('tabpanel-consent')
  };

  const configSubpanels = {
    connect: byId('config-section-connect'),
    appearance: byId('config-section-appearance'),
    favorites: byId('config-section-favorites')
  };

  const inputImportConfigConnect = byId('input-import-config-connect');
  const inputImportConfig = byId('input-import-config') || inputImportConfigConnect;
  const selectAddFavorite = byId('select-add-favorite') || byId('input-add-favorite');

  return {
    statusStrip: byId('status-strip'),
    statusIcon: byId('status-icon'),
    statusText: byId('status-text'),
    statusDetail: byId('status-detail'),
    btnTranslate: byId('btn-translate'),
    btnRestore: byId('btn-restore'),
    keyAccessBanner: byId('key-access-banner'),
    footerStatusSummary: byId('footer-status-summary'),

    tabList: qs('.tab-list[role="tablist"]'),
    tabButtons: qsa('.tab-btn[role="tab"]'),
    tabPanels,
    logList: byId('log-list'),
    btnClearLog: byId('btn-clear-log'),

    bannerAutoConsentWarning: byId('banner-auto-consent-warning'),
    bannerAutoWarningText: byId('banner-auto-warning-text'),
    btnBannerEnableSite: byId('btn-banner-enable-site'),
    btnBannerEnableSiteText: byId('btn-banner-enable-site-text'),

    bannerConsentUnknown: byId('banner-consent-unknown'),
    bannerConsentUnknownText: byId('banner-consent-unknown-text'),
    btnConsentRetry: byId('btn-consent-retry'),
    btnConsentRetryText: byId('btn-consent-retry-text'),

    privacyNote: byId('privacy-note'),
    tabpanelConsent: byId('tabpanel-consent'),
    btnConsentAccept: byId('btn-consent-accept'),
    btnConsentDecline: byId('btn-consent-decline'),

    selectUiLocale: byId('select-ui-locale'),
    selectTheme: byId('select-theme'),
    selectUiFontScale: byId('select-ui-font-scale'),

    btnHeaderMenu: byId('btn-header-menu'),
    menuOverlay: byId('menu-overlay'),
    menuBackdrop: byId('menu-backdrop'),
    menuItemConfig: byId('menu-item-config'),
    menuItemLog: byId('menu-item-log'),
    menuItemExport: byId('menu-item-export'),
    menuItemImport: byId('menu-item-import'),

    modalOverlay: byId('modal-overlay'),
    modalBackdrop: byId('modal-backdrop'),
    modalTitle: byId('modal-title'),
    modalCloseBtn: byId('modal-close-btn'),

    btnExportConfigConnect: byId('btn-export-config-connect'),
    btnImportConfigConnect: byId('btn-import-config-connect'),
    inputImportConfigConnect,
    inputImportConfig,
    checkboxExportKeys: byId('checkbox-export-keys'),
    inputFabSize: byId('input-fab-size'),
    fabSizeValue: byId('fab-size-value'),
    btnResetFabSize: byId('btn-reset-fab-size'),
    mascotSelectorGrid: byId('mascot-selector-grid'),
    selectFabMascot: byId('select-fab-mascot'),

    selectSrcLang: byId('select-src-lang'),
    selectTgtLang: byId('select-tgt-lang'),
    siteOriginBadge: byId('site-origin-badge'),
    toggleSiteConsent: byId('toggle-site-consent'),
    btnOverrideInherit: byId('btn-override-inherit'),
    btnOverrideOn: byId('btn-override-on'),
    btnOverrideOff: byId('btn-override-off'),
    checkboxWidgetVisible: byId('checkbox-widget-visible'),
    checkboxWidgetVisibleAppearance: byId('checkbox-widget-visible-appearance'),

    saveStateEl: byId('save-state'),
    saveDotEl: byId('save-dot'),

    btnAddCurrentSite: byId('btn-add-current-site'),
    autoSiteError: byId('auto-site-error'),
    autoSitesList: byId('auto-sites-list'),

    inputBaseUrl: byId('input-base-url'),
    btnBasePerm: byId('btn-base-perm'),
    inputApiKey: byId('input-api-key'),
    btnToggleKey: byId('btn-toggle-key'),
    btnDeleteKey: byId('btn-delete-key'),
    keyStatusIndicator: byId('key-status-indicator'),
    selectModel: byId('select-model'),
    btnToggleFavorite: byId('btn-toggle-favorite'),
    btnRefreshModels: byId('btn-refresh-models'),
    btnAddFallback: byId('btn-add-fallback'),
    fallbackListEl: byId('fallback-list'),
    configMessageConnect: byId('config-message-connect'),

    inputRateTab: byId('input-rate-tab'),
    inputRateSite: byId('input-rate-site'),
    inputRateConcurrency: byId('input-rate-concurrency'),
    rateLimitsHint: byId('rate-limits-hint'),

    subtabNav: qs('.subtab-nav'),
    subtabButtons: qsa('.subtab-btn'),
    configSubpanels,
    checkboxFavoritesOnly: byId('checkbox-favorites-only'),
    favoritesSectionTitle: byId('favorites-section-title'),
    favoritesCountBadge: byId('favorites-count-badge'),
    selectAddFavorite,
    inputAddFavorite: selectAddFavorite,
    btnAddFavorite: byId('btn-add-favorite'),
    favoritesAddHint: byId('favorites-add-hint'),
    favoritesEmptyHint: byId('favorites-empty-hint'),
    favoritesList: byId('favorites-list'),
    configMessageFavorites: byId('config-message-favorites')
  };
}
