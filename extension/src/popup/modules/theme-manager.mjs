// WebMCP Translator Kit — Theme, Font Scale, and Locale Presentation Module
// Manages applying appearance dataset attributes and syncing form controls.

import { SUPPORTED_UI_LOCALES, DEFAULT_UI_LOCALE } from '../../i18n.mjs';

export function applyTheme(theme, selectTheme) {
  const th = (theme === 'light' || theme === 'dark') ? theme : 'dark';
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', th);
    document.documentElement.dataset.theme = th;
  }
  if (selectTheme) selectTheme.value = th;
  return th;
}

export function applyFontScale(scale, selectFontScale) {
  const sc = (scale === 'sm' || scale === 'md' || scale === 'lg') ? scale : 'md';
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.fontscale = sc;
  }
  if (selectFontScale) selectFontScale.value = sc;
  return sc;
}

export function applyUiLocale(locale, selectUiLocale, onLocaleChange) {
  const loc = (locale && SUPPORTED_UI_LOCALES.includes(locale)) ? locale : DEFAULT_UI_LOCALE;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = loc;
  }
  if (selectUiLocale) selectUiLocale.value = loc;
  if (typeof onLocaleChange === 'function') {
    onLocaleChange(loc);
  }
  return loc;
}

export function renderLocalizedElements(doc, loc, t, { selectUiLocale, modalTitle, activeModal } = {}) {
  if (!doc) return;
  doc.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (k) el.textContent = t(loc, k);
  });
  doc.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const k = el.getAttribute('data-i18n-title');
    if (k) el.title = t(loc, k);
  });
  doc.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    const k = el.getAttribute('data-i18n-aria-label');
    if (k) el.setAttribute('aria-label', t(loc, k));
  });
  doc.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (k) {
      el.placeholder = t(loc, k);
      el.setAttribute('placeholder', t(loc, k));
    }
  });
  doc.querySelectorAll('[data-i18n-label]').forEach((el) => {
    const k = el.getAttribute('data-i18n-label');
    if (k) el.label = t(loc, k);
  });
  if (selectUiLocale) {
    for (const opt of selectUiLocale.options) {
      opt.textContent = t(loc, `config_ui_locale_${opt.value}`);
    }
  }
  if (modalTitle) {
    if (activeModal === 'config') modalTitle.textContent = t(loc, 'tab_config');
    else if (activeModal === 'log') modalTitle.textContent = t(loc, 'tab_log');
  }
}
