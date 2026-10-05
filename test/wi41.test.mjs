// WebMCP Translator Kit — WI-41 Unit & Integration Tests
// Requirements:
// 1. Header settings menu replacing DIRECT badge:
//    - Button #btn-header-menu (⋯) with aria-label via catalog replaces badge.
//    - Settings dropdown #menu-overlay with backdrop click + Esc + close button.
//    - Config & Log tabs moved into menu/modal (tablist only has Dịch & Tự động).
//    - Footer error click and TRANSLATE_TERMINAL_ERROR open Log modal directly.
//    - sessionStorage tab-restore of tab-config / tab-log migrates to modal.
// 2. Export Configuration JSON:
//    - Anchor download blob for translator-config.json.
//    - Contains baseURL, model, fallbacks (with hasKey: boolean), settings, etc.
//    - Strict recursive secret scanner: ZERO secrets (api_key, fallback_api_keys, etc.).
// 3. Floating icon size slider (fabSize):
//    - fabSize in [0.75, 1.5], default 1.0.
//    - SETTINGS_VERSION = 9 migration + validator + clamp.
//    - Widget state scaling via --wmt-fab-scale and data-fabsize.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  FAB_SIZE_BOUNDS,
  clampFabSize,
  buildExportConfig,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';
import { MESSAGES, SUPPORTED_UI_LOCALES, t } from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');
const popupCssPath = path.resolve(__dirname, '../extension/src/popup.css');
const contentJsPath = path.resolve(__dirname, '../extension/src/content.js');
const swJsPath = path.resolve(__dirname, '../extension/src/sw.js');

const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');
const popupCss = fs.readFileSync(popupCssPath, 'utf8');
const contentJs = fs.readFileSync(contentJsPath, 'utf8');
const swJs = fs.readFileSync(swJsPath, 'utf8');

// ============================================================================
// 1. Header Settings Menu & Modal HTML Structure & Catalog
// ============================================================================

test('WI-41: HTML structure replaces DIRECT badge with #btn-header-menu', () => {
  // Direct badge (#slice-badge) must not be in the header
  assert.ok(!popupHtml.includes('id="slice-badge"'), 'Header must no longer contain #slice-badge');
  assert.ok(popupHtml.includes('id="btn-header-menu"'), 'Header must contain #btn-header-menu');
  assert.ok(popupHtml.includes('data-i18n-aria-label="menu_settings_aria"'), '#btn-header-menu must have localized aria-label');
  assert.ok(popupHtml.includes('data-i18n-title="menu_settings_title"'), '#btn-header-menu must have localized title');
});

test('WI-41: Main tablist contains only Translate and Auto tabs', () => {
  const tablistStart = popupHtml.indexOf('class="tab-list"');
  assert.ok(tablistStart !== -1, 'class="tab-list" must be found in popup.html');
  const tablistEnd = popupHtml.indexOf('</div>', tablistStart);
  const tablistContent = popupHtml.slice(tablistStart, tablistEnd);

  assert.ok(tablistContent.includes('id="tab-translate"'), 'tablist must have tab-translate');
  assert.ok(tablistContent.includes('id="tab-auto"'), 'tablist must have tab-auto');
  assert.ok(!tablistContent.includes('id="tab-config"'), 'tablist must NOT have tab-config');
  assert.ok(!tablistContent.includes('id="tab-log"'), 'tablist must NOT have tab-log');
});

test('WI-41: Settings dropdown #menu-overlay and #modal-overlay exist in popup.html', () => {
  assert.ok(popupHtml.includes('id="menu-overlay"'), '#menu-overlay must exist');
  assert.ok(popupHtml.includes('id="menu-backdrop"'), '#menu-backdrop must exist');
  assert.ok(popupHtml.includes('id="menu-item-config"'), '#menu-item-config must exist');
  assert.ok(popupHtml.includes('id="menu-item-log"'), '#menu-item-log must exist');
  assert.ok(popupHtml.includes('id="menu-item-export"'), '#menu-item-export must exist');

  assert.ok(popupHtml.includes('id="modal-overlay"'), '#modal-overlay must exist');
  assert.ok(popupHtml.includes('id="modal-backdrop"'), '#modal-backdrop must exist');
  assert.ok(popupHtml.includes('id="modal-title"'), '#modal-title must exist');
  assert.ok(popupHtml.includes('id="modal-close-btn"'), '#modal-close-btn must exist');
  assert.ok(popupHtml.includes('id="tabpanel-config"'), '#tabpanel-config must be inside modal');
  assert.ok(popupHtml.includes('id="tabpanel-log"'), '#tabpanel-log must be inside modal');
});

test('WI-41: Export config button exists in Connect subpanel and menu dropdown', () => {
  assert.ok(popupHtml.includes('id="btn-export-config-connect"'), '#btn-export-config-connect must exist in Connect subpanel');
  assert.ok(popupHtml.includes('id="menu-item-export"'), '#menu-item-export must exist in settings menu');
});

test('Settings: JSON import control is available beside export and uses the existing settings/key APIs', () => {
  assert.ok(popupHtml.includes('id="btn-import-config-connect"'), 'Connect settings must include an import button');
  assert.ok(popupHtml.includes('id="input-import-config-connect" accept="application/json,.json"'), 'Import control must select JSON files');
  assert.ok(popupJs.includes('parseImportConfig(await file.text())'), 'Import must parse and validate the selected JSON file');
  assert.ok(popupJs.includes("action: 'SAVE_SETTINGS',") && popupJs.includes('settings: imported.settings'), 'Settings must use SAVE_SETTINGS');
  assert.ok(popupJs.includes("action: 'SET_KEY', key: imported.apiKey"), 'Primary credentials must use SET_KEY');
  assert.ok(popupJs.includes("action: 'SET_FALLBACK_KEY', id, key"), 'Fallback credentials must use SET_FALLBACK_KEY');

  const importStart = popupJs.indexOf('async function triggerImportConfig(file)');
  const importEnd = popupJs.indexOf("if (typeof window !== 'undefined')", importStart);
  const importHandler = popupJs.slice(importStart, importEnd);
  assert.ok(importHandler.includes('importInProgress = true'), 'Import must pause config writes');
  assert.ok(importHandler.includes("configPanel.querySelectorAll('button, input, select, textarea')"), 'Import must lock settings controls while applying');
  assert.ok(importHandler.includes('await favoriteWriteQueue;'), 'Import must wait for queued favorite writes');
  assert.ok(importHandler.includes('replaceFavoriteModelsByBaseURL: true'), 'Import must replace the complete favorites map');
  assert.match(importHandler, /if \(inputApiKey\) inputApiKey\.value = ''\s*;\s*await loadSettings\(\)/, 'Import must clear pending primary key input before reloading');
  const restoredControlsAt = importHandler.indexOf('for (const [control, wasDisabled] of lockedControls)');
  const fallbackStateRefreshAt = importHandler.indexOf('try { renderFallbackRows(); }', restoredControlsAt);
  assert.ok(fallbackStateRefreshAt > restoredControlsAt, 'Fallback controls must recalculate their disabled state after unlocking');
  const favoritesStateRefreshAt = importHandler.indexOf('try { renderAllModelDropdowns(); }', restoredControlsAt);
  assert.ok(favoritesStateRefreshAt > restoredControlsAt, 'Favorite controls must recalculate their disabled state after unlocking');
  assert.ok(importHandler.indexOf('evaluateActionReadiness();', restoredControlsAt) > favoritesStateRefreshAt, 'Action readiness must be recalculated after unlocking');
  const loadStart = popupJs.indexOf('async function loadSettings()');
  const loadEnd = popupJs.indexOf('// Telemetry Formatters', loadStart);
  const loadHandler = popupJs.slice(loadStart, loadEnd);
  const importedModelAt = loadHandler.indexOf('selectModel.value = resp.settings.model || DEFAULT_MODEL');
  const modelRefreshAt = loadHandler.lastIndexOf('try { renderAllModelDropdowns(); }');
  assert.ok(importedModelAt >= 0 && modelRefreshAt > importedModelAt, 'Settings reload must select the stored primary model before rendering choices');
  assert.match(popupJs, /async function flushAutosave\(\) \{\s*if \(importInProgress \|\| !settingsLoaded\) return;/, 'Autosave must pause during import');
  assert.match(popupJs, /function markDirty\(\) \{\s*if \(importInProgress \|\| !settingsLoaded\) return;/, 'New edits must not queue autosaves during import');
});

test('WI-41: fabSize slider exists in Appearance subpanel', () => {
  assert.ok(popupHtml.includes('id="input-fab-size"'), '#input-fab-size slider must exist');
  assert.ok(popupHtml.includes('id="fab-size-value"'), '#fab-size-value badge must exist');
  assert.ok(popupHtml.includes('min="0.75"'), 'fab-size slider min must be 0.75');
  assert.ok(popupHtml.includes('max="1.5"'), 'fab-size slider max must be 1.5');
});

test('WI-41: All WI-41 i18n keys are present in all 7 locales with identical parameter signatures', () => {
  const wi41Keys = [
    'menu_settings_aria',
    'menu_settings_title',
    'menu_title',
    'menu_export_json',
    'btn_close_menu',
    'btn_close_modal',
    'config_fab_size_label',
    'export_json_success',
    'settings_import_json',
    'import_json_confirm',
    'import_json_keys_confirm',
    'import_json_success',
    'import_json_failed',
    'import_json_partial'
  ];

  for (const loc of SUPPORTED_UI_LOCALES) {
    for (const k of wi41Keys) {
      assert.ok(
        typeof MESSAGES[loc][k] === 'string' && MESSAGES[loc][k].trim().length > 0,
        `Locale "${loc}" must define non-empty key "${k}"`
      );
    }
  }
});

// ============================================================================
// 2. Settings Menu & Modal Logic & Deep-link Verification
// ============================================================================

test('WI-41: popup.js implements openMenu, closeMenu, openModal, closeModal, triggerExportConfig', () => {
  assert.ok(popupJs.includes('function openMenu()'), 'popup.js must implement openMenu');
  assert.ok(popupJs.includes('function closeMenu()'), 'popup.js must implement closeMenu');
  assert.ok(popupJs.includes('function toggleMenu()'), 'popup.js must implement toggleMenu');
  assert.ok(popupJs.includes('function openModal('), 'popup.js must implement openModal');
  assert.ok(popupJs.includes('function closeModal()'), 'popup.js must implement closeModal');
  assert.ok(popupJs.includes('function triggerExportConfig()'), 'popup.js must implement triggerExportConfig');
  assert.ok(popupJs.includes('function updateFabSizeDisplay('), 'popup.js must implement updateFabSizeDisplay');
});

test('WI-41: Footer error click and TRANSLATE_TERMINAL_ERROR open Log modal directly', () => {
  // Check statusStrip click handler
  const statusStripHandlerIdx = popupJs.indexOf("statusStrip.classList.contains('has-error')");
  assert.ok(statusStripHandlerIdx !== -1, 'statusStrip error handler must check has-error');
  const statusStripBlock = popupJs.slice(statusStripHandlerIdx, statusStripHandlerIdx + 200);
  assert.ok(
    statusStripBlock.includes("openModal('log')"),
    'statusStrip error click must open Log modal'
  );

  // Check TRANSLATE_TERMINAL_ERROR handler
  const terminalErrIdx = popupJs.indexOf("action === 'TRANSLATE_TERMINAL_ERROR'");
  assert.ok(terminalErrIdx !== -1, 'TRANSLATE_TERMINAL_ERROR listener must exist');
  const terminalErrBlock = popupJs.slice(terminalErrIdx, terminalErrIdx + 250);
  assert.ok(
    terminalErrBlock.includes("openModal('log'"),
    'TRANSLATE_TERMINAL_ERROR must trigger openModal for log'
  );
});

test('WI-41: sessionStorage tab-restore migrates tab-config and tab-log to modal', () => {
  const restoreIdx = popupJs.indexOf('// Restore remembered tab in current popup session');
  assert.ok(restoreIdx !== -1, 'Restore tab session comment must be found');
  const restoreBlock = popupJs.slice(restoreIdx, restoreIdx + 2000);

  assert.ok(
    restoreBlock.includes("rememberedTab === 'tab-config'") && restoreBlock.includes("openModal('config')"),
    'tab-config session restore must open config modal'
  );
  assert.ok(
    restoreBlock.includes("rememberedTab === 'tab-log'") && restoreBlock.includes("openModal('log')"),
    'tab-log session restore must open log modal'
  );
});

test('WI-41: Escape key closes modal or menu dropdown', () => {
  const escIdx = popupJs.indexOf("e.key === 'Escape'");
  assert.ok(escIdx !== -1, 'Escape key listener must exist in popup.js');
  const escBlock = popupJs.slice(escIdx, escIdx + 250);
  assert.ok(escBlock.includes('closeModal()'), 'Escape must close modal');
  assert.ok(escBlock.includes('closeMenu()'), 'Escape must close menu');
});

// ============================================================================
// 3. Export JSON Specification & Strict Secret Exclusion Test
// ============================================================================

test('WI-41: buildExportConfig produces complete configuration snapshot without any secrets', () => {
  const mockSettings = {
    version: 9,
    baseURL: 'https://ai-proxy.corp.internal/v1',
    model: 'gpt-4o-mini',
    fallbacks: [
      { id: 'fb-deepseek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' },
      { id: 'fb-claude', model: 'claude-3-haiku' }
    ],
    autoTranslateSites: [
      { origin: 'https://news.ycombinator.com', autoStart: true, mode: 'inherit', sourceLanguage: null, targetLanguage: null, model: null },
      { origin: 'https://github.com', autoStart: false, mode: 'scroll-follow', sourceLanguage: null, targetLanguage: null, model: null }
    ],
    translationMode: 'scroll-follow',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    uiLocale: 'ja',
    theme: 'light',
    uiFontScale: 'sm',
    fabSize: 1.15,
    widgetVisible: true,
    showFavoritesOnly: true,
    rateLimits: {
      windowSeconds: 60,
      tab: { maxBatches: 6, maxSourceCodePoints: 12000 },
      site: { maxBatches: 12, maxSourceCodePoints: 36000 }
    },
    favoriteModelsByBaseURL: {
      'https://ai-proxy.corp.internal/v1': ['gpt-4o-mini', 'gpt-4o']
    },
    // Injected secrets that must NEVER leak:
    api_key: 'top-secret-primary-key',
    apiKey: 'another-secret-token',
    fallback_api_keys: {
      'fb-deepseek': 'secret-deepseek-key-xyz',
      'fb-claude': 'secret-anthropic-key-abc'
    },
    secretToken: 'super-secret-12345',
    password: 'super-secret-password'
  };

  const exported = buildExportConfig({
    settings: mockSettings,
    fallbackKeyPresence: { 'fb-deepseek': true, 'fb-claude': false },
    hasStoredKey: true,
    exportedAt: '2026-10-03T18:00:00.000Z'
  });

  // 1. Verify required metadata & settings presence
  assert.equal(exported.version, 9);
  assert.equal(exported.exportedAt, '2026-10-03T18:00:00.000Z');
  assert.equal(exported.baseURL, 'https://ai-proxy.corp.internal/v1');
  assert.equal(exported.model, 'gpt-4o-mini');
  assert.equal(exported.hasKey, true);
  assert.equal(exported.translationMode, 'scroll-follow');
  assert.equal(exported.sourceLanguage, 'auto');
  assert.equal(exported.targetLanguage, 'vi');
  assert.equal(exported.uiLocale, 'ja');
  assert.equal(exported.theme, 'light');
  assert.equal(exported.uiFontScale, 'sm');
  assert.equal(exported.fabSize, 1.15);
  assert.equal(exported.widgetVisible, true);
  assert.equal(exported.showFavoritesOnly, true);
  assert.deepEqual(exported.autoTranslateSites, mockSettings.autoTranslateSites);
  assert.deepEqual(exported.rateLimits, mockSettings.rateLimits);
  assert.deepEqual(exported.favoriteModelsByBaseURL, mockSettings.favoriteModelsByBaseURL);

  // 2. Verify fallbacks structure with hasKey boolean and no raw keys
  assert.deepEqual(exported.fallbacks, [
    { id: 'fb-deepseek', model: 'deepseek-chat', hasKey: true, baseURL: 'https://api.deepseek.com/v1' },
    { id: 'fb-claude', model: 'claude-3-haiku', hasKey: false }
  ]);

  // 3. Strict recursive secret scan
  function assertNoSecrets(node, path = 'root') {
    if (!node || typeof node !== 'object') return;
    for (const [key, val] of Object.entries(node)) {
      const lowerKey = key.toLowerCase();
      // Only permitted field with "key" substring is "hasKey"
      if (lowerKey.includes('key') && key !== 'hasKey') {
        assert.fail(`Key violation: "${key}" at path ${path} must not be exported`);
      }
      if (lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('password')) {
        assert.fail(`Secret field violation: "${key}" at path ${path}`);
      }
      if (typeof val === 'string') {
        const forbiddenSubstrings = [
          'top-secret',
          'secret-token',
          'secret-deepseek',
          'secret-anthropic',
          'super-secret'
        ];
        for (const sub of forbiddenSubstrings) {
          assert.ok(
            !val.includes(sub),
            `Secret string leakage detected in "${key}" at path ${path}: ${val}`
          );
        }
      } else if (typeof val === 'object' && val !== null) {
        assertNoSecrets(val, `${path}.${key}`);
      }
    }
  }

  assertNoSecrets(exported);
});

// ============================================================================
// 4. Floating Icon Size Slider (fabSize) Specifications
// ============================================================================

test('WI-41: fabSize bounds [0.75, 1.5] and clampFabSize function', () => {
  assert.equal(FAB_SIZE_BOUNDS.min, 0.75);
  assert.equal(FAB_SIZE_BOUNDS.max, 1.5);
  assert.equal(FAB_SIZE_BOUNDS.default, 1.0);

  // Exact bounds
  assert.equal(clampFabSize(0.75), 0.75);
  assert.equal(clampFabSize(1.5), 1.5);
  assert.equal(clampFabSize(1.0), 1.0);
  assert.equal(clampFabSize(1.25), 1.25);

  // Clamping below and above
  assert.equal(clampFabSize(0.5), 0.75);
  assert.equal(clampFabSize(0), 0.75);
  assert.equal(clampFabSize(-1), 0.75);
  assert.equal(clampFabSize(2.0), 1.5);
  assert.equal(clampFabSize(10), 1.5);

  // Numeric string parsing
  assert.equal(clampFabSize('1.35'), 1.35);
  assert.equal(clampFabSize('0.2'), 0.75);
  assert.equal(clampFabSize('3.5'), 1.5);

  // Invalid types fallback to default 1.0
  assert.equal(clampFabSize(NaN), 1.0);
  assert.equal(clampFabSize('abc'), 1.0);
  assert.equal(clampFabSize(null), 1.0);
  assert.equal(clampFabSize(undefined), 1.0);
  assert.equal(clampFabSize({}), 1.0);
});

test('WI-41: Settings schema migration from v8 to v9 assigns fabSize: 1.0', () => {
  const v8Settings = {
    version: 8,
    baseURL: 'http://localhost:8080/v1',
    model: 'test-model',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    translationMode: 'scroll-follow',
    widgetVisible: true,
    uiLocale: 'vi',
    theme: 'dark',
    uiFontScale: 'md',
    showFavoritesOnly: false
  };

  const migrated = migrateSettings(v8Settings);
  assert.equal(migrated.version, 9);
  assert.equal(migrated.fabSize, 1.0);
});

test('WI-41: content.js widget applies --wmt-fab-scale and data-fabsize', () => {
  assert.ok(
    contentJs.includes('--wmt-fab-scale'),
    'content.js must define or apply --wmt-fab-scale CSS custom property'
  );
  assert.ok(
    contentJs.includes('data-fabsize'),
    'content.js must set data-fabsize attribute on widget host'
  );
  assert.ok(
    contentJs.includes("config_fab_size_label: 'Cỡ icon nổi'"),
    'content.js WIDGET_FALLBACK_LABELS must include config_fab_size_label'
  );
});

test('WI-41: sw.js includes fabSize in WIDGET_GET_STATE and detects fabSize changes in SAVE_SETTINGS', () => {
  assert.ok(
    swJs.includes('fabSize: typeof settings.fabSize === \'number\' ? settings.fabSize : 1'),
    'sw.js WIDGET_GET_STATE must return fabSize'
  );
  assert.ok(
    swJs.includes('oldSettings.fabSize !== migrated.fabSize'),
    'sw.js SAVE_SETTINGS must notify widget when fabSize changes'
  );
});
