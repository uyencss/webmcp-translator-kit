// WebMCP Translator Kit — Pure ESM i18n Catalog & Translation Engine
// Supported UI Locales: vi (default), en, ja, ko, zh, es, ru

import vi from './locales/vi.mjs';
import en from './locales/en.mjs';
import ja from './locales/ja.mjs';
import ko from './locales/ko.mjs';
import zh from './locales/zh.mjs';
import es from './locales/es.mjs';
import ru from './locales/ru.mjs';

export const SUPPORTED_UI_LOCALES = Object.freeze(['vi', 'en', 'ja', 'ko', 'zh', 'es', 'ru']);
export const DEFAULT_UI_LOCALE = 'vi';

export const MESSAGES = Object.freeze({
  vi,
  en,
  ja,
  ko,
  zh,
  es,
  ru
});

/**
 * Translates a key with fallback to Vietnamese.
 *
 * @param {string} locale
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(locale, key, params) {
  const loc = (locale && SUPPORTED_UI_LOCALES.includes(locale)) ? locale : DEFAULT_UI_LOCALE;
  const msg = MESSAGES[loc]?.[key] ?? MESSAGES[DEFAULT_UI_LOCALE]?.[key] ?? key;
  if (typeof msg !== 'string') return key;
  if (!params || typeof params !== 'object') return msg;
  return msg.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

/**
 * Checks whether a translation key exists for a given locale (or default fallback).
 *
 * @param {string} locale
 * @param {string} key
 * @returns {boolean}
 */
export function hasTranslationKey(locale, key) {
  const loc = (locale && SUPPORTED_UI_LOCALES.includes(locale)) ? locale : DEFAULT_UI_LOCALE;
  return typeof (MESSAGES[loc]?.[key] ?? MESSAGES[DEFAULT_UI_LOCALE]?.[key]) === 'string';
}
