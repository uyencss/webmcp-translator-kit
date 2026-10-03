import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';
import {
  SUPPORTED_UI_LOCALES,
  MESSAGES,
  t
} from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// WI-20: Partial Batch Handling
// ============================================================================

test('WI-20: content.js translateChunkWithRecovery counts missingIds into failed without fatal abort', () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  // Verify missingIds are counted into failed
  assert.ok(
    contentSrc.includes('const failedCount = Array.isArray(resp.missingIds) ? resp.missingIds.length : (resp.failed || 0);'),
    'content.js must count missingIds into failed'
  );
  assert.ok(
    contentSrc.includes('return { applied: patchResult.applied, failed: failedCount, missingIds };'),
    'content.js must return failedCount and missingIds from translateChunkWithRecovery'
  );
});

test('WI-20: sw.js records non-fatal PARTIAL_BATCH and returns missingIds/failed in batch result', () => {
  const swPath = path.join(__dirname, '..', 'extension', 'src', 'sw.js');
  const swSrc = fs.readFileSync(swPath, 'utf8');

  assert.ok(swSrc.includes("code: 'PARTIAL_BATCH'"), 'sw.js must log PARTIAL_BATCH error');
  assert.ok(swSrc.includes('isTerminal: false'), 'PARTIAL_BATCH must be non-terminal');
  assert.ok(swSrc.includes('failed: missingIds.length'), 'sw.js must report failed count equal to missingIds.length');
  assert.ok(swSrc.includes('partial: Boolean(finalProviderRes?.partial || missingIds.length > 0)'),
    'sw.js must flag partial: true when missingIds exist');
});

test('WI-20: scroll mode missing item is marked failed once and not rescheduled in the same run (scroll session)', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    function fakeEl(tagName = 'DIV') {
      return {
        style: {}, dataset: {}, tagName, id: '', isConnected: true,
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {},
        querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
        closest: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 100, height: 100 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isContentEditable: false, parentElement: null
      };
    }

    const paragraph = fakeEl('P');
    const nodeA = { nodeType: 3, nodeValue: 'First text node to translate successfully.', parentElement: paragraph, isConnected: true };
    const nodeB = { nodeType: 3, nodeValue: 'Second text node that will return missing.', parentElement: paragraph, isConnected: true };
    const textNodes = [nodeA, nodeB];

    const win = {
      innerHeight: 800, innerWidth: 1200, top: null,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;

    let translationRequests = 0;
    let requestedBatches = [];

    const runtime = {
      id: 'test-ext-id', lastError: null, onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        if (msg?.action === 'WIDGET_GET_STATE') {
          cb({ effective: 'on', permission: true, hasKey: true, autoStart: false, widgetVisible: true });
        } else if (msg?.action === 'TRANSLATE_BATCH') {
          translationRequests++;
          requestedBatches.push(msg.payload.items);
          const items = msg.payload.items;
          const results = [];
          const missingIds = [];
          if (items.length > 0) {
            results.push({ id: items[0].id, text: '[vi] ' + items[0].text, revision: items[0].revision });
          }
          for (let i = 1; i < items.length; i++) {
            missingIds.push(items[i].id);
          }
          cb({
            ok: true,
            results,
            missingIds,
            failed: missingIds.length,
            partial: missingIds.length > 0
          });
        } else if (typeof cb === 'function') cb({ ok: true });
      }
    };

    globalThis.chrome = { runtime };
    globalThis.window = win;
    globalThis.document = {
      documentElement: fakeEl('HTML'), body: fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return { nextNode: () => textNodes[cursor++] || null };
      },
      querySelectorAll: (selector) => selector === 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote' ? [paragraph] : [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'https:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');

    // Start scroll session
    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // First batch was dispatched with both nodes
    assert.equal(translationRequests, 1, 'Initial batch sent');
    assert.equal(requestedBatches[0].length, 2, 'Initial batch contained both items');

    const status1 = dom.getStatus();
    assert.equal(status1.totalApplied, 1, 'Partial-applied item 1');
    assert.equal(status1.totalFailed, 1, 'Missing item 2 counted as failed once');

    // Wait for any rescheduled debounce/flush timer to fire
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Missing item must NOT be rescheduled in the same run!
    assert.equal(translationRequests, 1, 'Missing item must NOT trigger an additional batch in the same scroll run');
    const status2 = dom.getStatus();
    assert.equal(status2.totalFailed, 1, 'totalFailed must remain 1 without duplicate counting');
    assert.equal(status2.totalApplied, 1, 'totalApplied must remain 1');

    // When user explicitly starts a new run, blockedIds is cleared and previously missing items can be retried
    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(translationRequests, 2, 'New session initiates a new translation request');
    dom.stopScrollFollowSession();
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

// ============================================================================
// WI-21 (a): Config Submenu (Kết nối | Giao diện | Yêu thích)
// ============================================================================

test('WI-21 (a): popup.html contains segmented subtab navigation and 3 subpanels', () => {
  const htmlPath = path.join(__dirname, '..', 'extension', 'src', 'popup.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  // Verify subtab navigation
  assert.ok(htmlSrc.includes('class="subtab-nav"'), 'popup.html must contain subtab-nav');
  assert.ok(htmlSrc.includes('id="subtab-connect"'), 'popup.html must contain subtab-connect button');
  assert.ok(htmlSrc.includes('id="subtab-appearance"'), 'popup.html must contain subtab-appearance button');
  assert.ok(htmlSrc.includes('id="subtab-favorites"'), 'popup.html must contain subtab-favorites button');

  // Verify 3 subpanels
  assert.ok(htmlSrc.includes('id="config-section-connect"'), 'popup.html must contain config-section-connect panel');
  assert.ok(htmlSrc.includes('id="config-section-appearance"'), 'popup.html must contain config-section-appearance panel');
  assert.ok(htmlSrc.includes('id="config-section-favorites"'), 'popup.html must contain config-section-favorites panel');

  // Verify i18n hooks on subtab buttons
  assert.ok(htmlSrc.includes('data-i18n="config_subtab_connect"'));
  assert.ok(htmlSrc.includes('data-i18n="config_subtab_appearance"'));
  assert.ok(htmlSrc.includes('data-i18n="config_subtab_favorites"'));
  assert.ok(htmlSrc.includes('data-i18n-aria-label="config_subnav_aria"'));
});

test('WI-21 (a): popup.css defines styling for subtab-nav, subtab-btn, and subpanels', () => {
  const cssPath = path.join(__dirname, '..', 'extension', 'src', 'popup.css');
  const cssSrc = fs.readFileSync(cssPath, 'utf8');

  assert.ok(cssSrc.includes('.subtab-nav'), 'popup.css must style .subtab-nav');
  assert.ok(cssSrc.includes('.subtab-btn'), 'popup.css must style .subtab-btn');
  assert.ok(cssSrc.includes('.subtab-btn.active'), 'popup.css must style active subtab button');
  assert.ok(cssSrc.includes('.config-subpanel'), 'popup.css must style .config-subpanel');
  assert.ok(cssSrc.includes('.favorites-list-wrap'), 'popup.css must style .favorites-list-wrap');
  assert.ok(cssSrc.includes('.favorite-item-row'), 'popup.css must style .favorite-item-row');
});

test('WI-21 (a): popup.js manages subtab switching with roving tabindex and keyboard navigation', () => {
  const popupPath = path.join(__dirname, '..', 'extension', 'src', 'popup.js');
  const popupSrc = fs.readFileSync(popupPath, 'utf8');

  assert.ok(popupSrc.includes('function switchConfigSubtab'), 'popup.js must define switchConfigSubtab');
  assert.ok(popupSrc.includes('sessionStorage.setItem(\'active_config_subtab\''), 'popup.js must remember active subtab');
  assert.ok(popupSrc.includes('sessionStorage.getItem(\'active_config_subtab\')'), 'popup.js must restore remembered subtab');
  assert.ok(popupSrc.includes('subtabNav.addEventListener(\'keydown\''), 'popup.js must support arrow keys on subtabs');
});

// ============================================================================
// WI-21 (b): Section Yêu thích (Favorites Management)
// ============================================================================

test('WI-21 (b): popup.html contains favorites management controls and list', () => {
  const htmlPath = path.join(__dirname, '..', 'extension', 'src', 'popup.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(htmlSrc.includes('id="checkbox-favorites-only"'), 'Must have checkbox-favorites-only');
  assert.ok(htmlSrc.includes('id="favorites-count-badge"'), 'Must have favorites-count-badge');
  assert.ok(htmlSrc.includes('id="select-add-favorite"') || htmlSrc.includes('id="input-add-favorite"'), 'Must have select-add-favorite');
  assert.ok(htmlSrc.includes('data-i18n-aria-label="fav_add_model_aria"'), 'Must have data-i18n-aria-label hook on favorite control');
  assert.ok(htmlSrc.includes('id="btn-add-favorite"'), 'Must have btn-add-favorite');
  assert.ok(htmlSrc.includes('id="favorites-empty-hint"'), 'Must have favorites-empty-hint');
  assert.ok(htmlSrc.includes('id="favorites-list"'), 'Must have favorites-list');
});

test('WI-21 (b): popup.js implements renderFavoritesSection and add/delete handlers with validation and 50-cap', () => {
  const popupPath = path.join(__dirname, '..', 'extension', 'src', 'popup.js');
  const popupSrc = fs.readFileSync(popupPath, 'utf8');

  assert.ok(popupSrc.includes('function renderFavoritesSection'), 'Must have renderFavoritesSection');
  assert.ok(popupSrc.includes('function handleAddFavorite'), 'Must have handleAddFavorite');
  assert.ok(popupSrc.includes('err_favorite_model_empty'), 'Must validate non-empty model');
  assert.ok(popupSrc.includes('err_favorite_cap_reached'), 'Must validate 50-model cap');
  assert.ok(popupSrc.includes('saveFavoriteToggle(scopeKey, modelId, false)'), 'Delete must call saveFavoriteToggle with false');
  assert.ok(popupSrc.includes('saveFavoriteToggle(scopeKey, modelId, true)'), 'Add must call saveFavoriteToggle with true');
});

// ============================================================================
// WI-21 (c): showFavoritesOnly Toggle & Scoped Model Lists
// ============================================================================

test('WI-21 (c): settings.mjs defines showFavoritesOnly in version 8 defaults, schema, and migration', () => {
  assert.equal(SETTINGS_VERSION, 9);
  assert.equal(DEFAULT_SETTINGS.showFavoritesOnly, false);

  const migrated = migrateSettings({ version: 7 });
  assert.equal(migrated.version, 9);
  assert.equal(migrated.showFavoritesOnly, false);

  const valid = validateSettings({ ...DEFAULT_SETTINGS, showFavoritesOnly: true });
  assert.equal(valid.valid, true);

  const invalid = validateSettings({ ...DEFAULT_SETTINGS, showFavoritesOnly: 'not_a_bool' });
  assert.equal(invalid.valid, false);
});

test('WI-21 (c): sw.js WIDGET_GET_STATE returns showFavoritesOnly and scopes availableModels when enabled', () => {
  const swPath = path.join(__dirname, '..', 'extension', 'src', 'sw.js');
  const swSrc = fs.readFileSync(swPath, 'utf8');

  assert.ok(swSrc.includes('showFavoritesOnly: Boolean(settings.showFavoritesOnly)'));
  assert.ok(swSrc.includes('favoritesHint'));
  assert.ok(swSrc.includes("favoritesHint = 'no_favorites_show_all'"));
});

test('WI-21 (c): popup.js populateSelect restricts to favorites when showFavoritesOnly is true', () => {
  const popupPath = path.join(__dirname, '..', 'extension', 'src', 'popup.js');
  const popupSrc = fs.readFileSync(popupPath, 'utf8');

  assert.ok(popupSrc.includes('const showFavsOnly = Boolean(savedSettings && savedSettings.showFavoritesOnly);'));
  assert.ok(popupSrc.includes('fav_empty_hint_dropdown'));
});

// ============================================================================
// i18n: All 14 new keys exist across all 7 locales with identical parameter placeholders
// ============================================================================

test('WI-21: i18n catalog contains all 15 keys in all 7 locales', () => {
  const expectedKeys = [
    'config_subtab_connect',
    'config_subtab_appearance',
    'config_subtab_favorites',
    'config_subnav_aria',
    'config_favorites_only_label',
    'fav_empty_hint',
    'fav_empty_hint_dropdown',
    'fav_add_model_placeholder',
    'fav_add_model_aria',
    'fav_btn_add',
    'fav_btn_delete_title',
    'err_favorite_model_empty',
    'err_favorite_cap_reached',
    'fav_added_success',
    'fav_manage_title'
  ];

  for (const locale of SUPPORTED_UI_LOCALES) {
    for (const key of expectedKeys) {
      assert.ok(
        MESSAGES[locale] && typeof MESSAGES[locale][key] === 'string' && MESSAGES[locale][key].length > 0,
        `MESSAGES[${locale}][${key}] must be a non-empty string`
      );
    }
  }

  // Placeholder check for fav_manage_title
  for (const locale of SUPPORTED_UI_LOCALES) {
    const text = t(locale, 'fav_manage_title', { count: 3 });
    assert.ok(text.includes('3'), `t(${locale}, fav_manage_title) must interpolate {count}`);
  }
});
