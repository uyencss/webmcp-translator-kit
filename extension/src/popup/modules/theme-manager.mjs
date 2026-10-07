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
