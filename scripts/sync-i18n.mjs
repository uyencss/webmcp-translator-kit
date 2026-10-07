// WebMCP Translator Kit — Automated i18n Globals Synchronizer
// Generates extension/src/i18n-globals.js from extension/src/locales/*.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const { MESSAGES, SUPPORTED_UI_LOCALES, DEFAULT_UI_LOCALE } = await import('../extension/src/i18n.mjs');

const banner = `// WebMCP Translator Kit — Classic Content-Script Global i18n Bundle
// AUTO-GENERATED from extension/src/locales/*.mjs via scripts/sync-i18n.mjs. DO NOT EDIT DIRECTLY.
(function () {
  'use strict';
  const target = (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : self));
  if (target.__wmtI18n) return;

  const SUPPORTED_UI_LOCALES = Object.freeze(${JSON.stringify(SUPPORTED_UI_LOCALES)});
  const DEFAULT_UI_LOCALE = ${JSON.stringify(DEFAULT_UI_LOCALE)};

  const MESSAGES = Object.freeze(${JSON.stringify(MESSAGES, null, 2)});

  function t(locale, key, params) {
    const loc = (locale && SUPPORTED_UI_LOCALES.includes(locale)) ? locale : DEFAULT_UI_LOCALE;
    const msg = MESSAGES[loc]?.[key] ?? MESSAGES[DEFAULT_UI_LOCALE]?.[key] ?? key;
    if (typeof msg !== 'string') return key;
    if (!params || typeof params !== 'object') return msg;
    return msg.replace(/\\{(\\w+)\\}/g, function (_, k) {
      return params[k] !== undefined ? String(params[k]) : '{' + k + '}';
    });
  }

  target.__wmtI18n = Object.freeze({
    SUPPORTED_UI_LOCALES,
    DEFAULT_UI_LOCALE,
    MESSAGES,
    t
  });
})();
`;

const targetPath = path.join(rootDir, 'extension', 'src', 'i18n-globals.js');
fs.writeFileSync(targetPath, banner);
console.log('Synchronized', targetPath, 'from locales/*.mjs');
