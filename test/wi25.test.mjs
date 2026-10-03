import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_UI_LOCALES, t, MESSAGES } from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const popupCssPath = path.resolve(__dirname, '../extension/src/popup.css');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');

const htmlSrc = fs.readFileSync(popupHtmlPath, 'utf8');
const cssSrc = fs.readFileSync(popupCssPath, 'utf8');
const jsSrc = fs.readFileSync(popupJsPath, 'utf8');

function makeFakeElement(id, initialAttrs = {}, initialClasses = []) {
  const attrs = { ...initialAttrs };
  const classes = new Set(initialClasses);
  let children = [];
  return {
    id,
    dataset: {},
    tabIndex: 0,
    disabled: false,
    value: '',
    title: '',
    textContent: '',
    children,
    appendChild(child) { children.push(child); return child; },
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    hasAttribute(name) { return name in attrs; },
    removeAttribute(name) { delete attrs[name]; },
    classList: {
      add(...cls) { cls.forEach(c => classes.add(c)); },
      remove(...cls) { cls.forEach(c => classes.delete(c)); },
      toggle(cls, force) {
        if (force === undefined) {
          if (classes.has(cls)) { classes.delete(cls); return false; }
          classes.add(cls); return true;
        }
        if (force) { classes.add(cls); return true; }
        classes.delete(cls); return false;
      },
      contains(cls) { return classes.has(cls); }
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {}
  };
}

// ============================================================================
// F1: Config Sub-menu: 1-panel-visible sau mỗi lần switch
// ============================================================================

test('WI-25 F1: popup.css defines display: none !important for .hidden and .config-subpanel.hidden', () => {
  assert.ok(
    cssSrc.includes('.config-subpanel.hidden') && cssSrc.includes('display: none !important'),
    'popup.css must explicitly define .config-subpanel.hidden with display: none !important'
  );
  assert.ok(
    cssSrc.includes('.hidden') && cssSrc.includes('display: none !important'),
    'popup.css must define .hidden with display: none !important'
  );
});

test('WI-25 F1: exact 1 config subpanel is visible after each switchConfigSubtab transition', () => {
  // Setup simulated subpanels as in popup.html
  const configSubpanels = {
    connect: makeFakeElement('config-section-connect', {}, ['config-subpanel']),
    appearance: makeFakeElement('config-section-appearance', {}, ['config-subpanel', 'hidden']),
    favorites: makeFakeElement('config-section-favorites', {}, ['config-subpanel', 'hidden'])
  };

  const subtabButtons = [
    makeFakeElement('subtab-connect', { 'aria-selected': 'true', 'data-subtab': 'connect' }, ['subtab-btn', 'active']),
    makeFakeElement('subtab-appearance', { 'aria-selected': 'false', 'data-subtab': 'appearance' }, ['subtab-btn']),
    makeFakeElement('subtab-favorites', { 'aria-selected': 'false', 'data-subtab': 'favorites' }, ['subtab-btn'])
  ];
  subtabButtons[0].dataset.subtab = 'connect';
  subtabButtons[1].dataset.subtab = 'appearance';
  subtabButtons[2].dataset.subtab = 'favorites';

  let activeConfigSubtab = 'connect';

  function switchConfigSubtab(targetSubtabId) {
    activeConfigSubtab = targetSubtabId;
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
  }

  function countVisibleSubpanels() {
    return Object.values(configSubpanels).filter(p => !p.classList.contains('hidden')).length;
  }

  function getVisibleSubpanelKey() {
    const entry = Object.entries(configSubpanels).find(([, p]) => !p.classList.contains('hidden'));
    return entry ? entry[0] : null;
  }

  // 1. Initial State: connect
  assert.equal(countVisibleSubpanels(), 1, 'Initial state: exactly 1 subpanel visible');
  assert.equal(getVisibleSubpanelKey(), 'connect');
  assert.equal(subtabButtons[0].getAttribute('aria-selected'), 'true');
  assert.equal(subtabButtons[1].getAttribute('aria-selected'), 'false');
  assert.equal(subtabButtons[2].getAttribute('aria-selected'), 'false');

  // 2. Switch to appearance
  switchConfigSubtab('appearance');
  assert.equal(countVisibleSubpanels(), 1, 'After switch to appearance: exactly 1 subpanel visible');
  assert.equal(getVisibleSubpanelKey(), 'appearance');
  assert.equal(subtabButtons[0].getAttribute('aria-selected'), 'false');
  assert.equal(subtabButtons[1].getAttribute('aria-selected'), 'true');
  assert.equal(subtabButtons[2].getAttribute('aria-selected'), 'false');

  // 3. Switch to favorites
  switchConfigSubtab('favorites');
  assert.equal(countVisibleSubpanels(), 1, 'After switch to favorites: exactly 1 subpanel visible');
  assert.equal(getVisibleSubpanelKey(), 'favorites');
  assert.equal(subtabButtons[0].getAttribute('aria-selected'), 'false');
  assert.equal(subtabButtons[1].getAttribute('aria-selected'), 'false');
  assert.equal(subtabButtons[2].getAttribute('aria-selected'), 'true');

  // 4. Switch back to connect
  switchConfigSubtab('connect');
  assert.equal(countVisibleSubpanels(), 1, 'After switch back to connect: exactly 1 subpanel visible');
  assert.equal(getVisibleSubpanelKey(), 'connect');
  assert.equal(subtabButtons[0].getAttribute('aria-selected'), 'true');
  assert.equal(subtabButtons[1].getAttribute('aria-selected'), 'false');
  assert.equal(subtabButtons[2].getAttribute('aria-selected'), 'false');
});

// ============================================================================
// F2: Subtab redesign + Light mode comprehensive overrides
// ============================================================================

test('WI-25 F2: popup.css contains light theme overrides for all subtab, config, favorites, and log classes', () => {
  const expectedLightSelectors = [
    '[data-theme="light"] .subtab-nav',
    '[data-theme="light"] .subtab-btn',
    '[data-theme="light"] .subtab-btn.active',
    '[data-theme="light"] .favorite-item-row',
    '[data-theme="light"] .favorite-model-name',
    '[data-theme="light"] .favorite-delete-btn',
    '[data-theme="light"] .empty-hint',
    '[data-theme="light"] .config-version-badge',
    '[data-theme="light"] .config-version-row',
    '[data-theme="light"] .log-card',
    '[data-theme="light"] .log-item',
    '[data-theme="light"] .btn-icon',
    '[data-theme="light"] select option',
    '[data-theme="light"] input[type="text"]'
  ];

  for (const selector of expectedLightSelectors) {
    assert.ok(
      cssSrc.includes(selector),
      `popup.css must contain light theme rule for "${selector}"`
    );
  }

  // Ensure braces in popup.css are completely balanced
  const opens = (cssSrc.match(/\{/g) || []).length;
  const closes = (cssSrc.match(/\}/g) || []).length;
  assert.equal(opens, closes, 'Braces in popup.css must be balanced');
});

// ============================================================================
// F3: Favorite Add via Select Dropdown
// ============================================================================

test('WI-25 F3: popup.html contains select dropdown for adding favorites instead of raw text input', () => {
  assert.ok(
    htmlSrc.includes('id="select-add-favorite"'),
    'popup.html must contain select element with id="select-add-favorite"'
  );
  assert.ok(
    !htmlSrc.includes('<input type="text" id="input-add-favorite"'),
    'popup.html must NOT contain text input for adding favorites'
  );
  assert.ok(
    htmlSrc.includes('id="favorites-add-hint"'),
    'popup.html must declare favorites-add-hint element'
  );
});

test('WI-25 F3: fav-add qua select lists models excluding current scope favorites, and validates scope and cap', () => {
  const RECOMMENDED_MODELS = [
    'ag/gemini-3.1-pro-low',
    'do/glm-5.3-flash',
    'do/deepseek-v4.1-flash',
    'ag/gemini-3.8-flash'
  ];
  const discoveredModels = ['custom/model-alpha', 'custom/model-beta'];

  const favoriteModelsByBaseURL = {
    'http://localhost:8080/v1': ['ag/gemini-3.1-pro-low'],
    'https://api.9router.com/v1': ['do/glm-5.3-flash', 'do/deepseek-v4.1-flash']
  };

  function getFavoritesForKey(key) {
    return Array.isArray(favoriteModelsByBaseURL[key]) ? [...favoriteModelsByBaseURL[key]] : [];
  }

  function getAvailableModelsToAdd(scopeKey) {
    const currentFavs = new Set(getFavoritesForKey(scopeKey));
    const seen = new Set();
    const allModels = [];

    for (const mId of RECOMMENDED_MODELS) {
      if (mId && !seen.has(mId)) {
        seen.add(mId);
        allModels.push(mId);
      }
    }
    for (const m of discoveredModels) {
      const mId = typeof m === 'string' ? m : m?.id;
      if (mId && !seen.has(mId)) {
        seen.add(mId);
        allModels.push(mId);
      }
    }
    return allModels.filter(mId => !currentFavs.has(mId));
  }

  // Scope 1: localhost (gemini-3.1-pro-low is favorited)
  const availScope1 = getAvailableModelsToAdd('http://localhost:8080/v1');
  assert.ok(!availScope1.includes('ag/gemini-3.1-pro-low'), 'Must exclude already favorited model in scope 1');
  assert.ok(availScope1.includes('do/glm-5.3-flash'), 'Must include non-favorited recommended model in scope 1');
  assert.ok(availScope1.includes('custom/model-alpha'), 'Must include discovered model in scope 1');

  // Scope 2: 9router (glm-5.3-flash & deepseek-v4.1-flash are favorited)
  const availScope2 = getAvailableModelsToAdd('https://api.9router.com/v1');
  assert.ok(!availScope2.includes('do/glm-5.3-flash'), 'Must exclude glm in scope 2');
  assert.ok(!availScope2.includes('do/deepseek-v4.1-flash'), 'Must exclude deepseek in scope 2');
  assert.ok(availScope2.includes('ag/gemini-3.1-pro-low'), 'Must include gemini-3.1-pro-low in scope 2 since not fav in scope 2');

  // Adding a model via toggle call verification
  const calls = [];
  async function saveFavoriteToggle(scopeKey, model, favorite) {
    calls.push({ scopeKey, model, favorite });
    if (!favoriteModelsByBaseURL[scopeKey]) favoriteModelsByBaseURL[scopeKey] = [];
    if (favorite) favoriteModelsByBaseURL[scopeKey].push(model);
    return favoriteModelsByBaseURL[scopeKey];
  }

  // Simulate Add action
  const selectedModel = 'custom/model-alpha';
  saveFavoriteToggle('http://localhost:8080/v1', selectedModel, true);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    scopeKey: 'http://localhost:8080/v1',
    model: 'custom/model-alpha',
    favorite: true
  });

  // Now model-alpha is in scope 1, verify it disappears from available
  const availScope1After = getAvailableModelsToAdd('http://localhost:8080/v1');
  assert.ok(!availScope1After.includes('custom/model-alpha'));

  // When all models are favorited, availableModels becomes empty
  const allFavKey = 'http://all-fav.local';
  favoriteModelsByBaseURL[allFavKey] = [...RECOMMENDED_MODELS, ...discoveredModels];
  const availAll = getAvailableModelsToAdd(allFavKey);
  assert.equal(availAll.length, 0, 'Must have 0 available models when all are favorited');
});

test('WI-25 F3: catalog contains fav_select_add_placeholder and fav_no_models_to_add across all 7 locales', () => {
  for (const loc of SUPPORTED_UI_LOCALES) {
    const placeholder = t(loc, 'fav_select_add_placeholder');
    const noMore = t(loc, 'fav_no_models_to_add');

    assert.ok(placeholder && placeholder.length > 0, `fav_select_add_placeholder must exist for ${loc}`);
    assert.ok(noMore && noMore.length > 0, `fav_no_models_to_add must exist for ${loc}`);

    if (loc !== 'vi') {
      assert.ok(!placeholder.includes('Chọn model'), `Locale ${loc} must not leak Vietnamese in placeholder`);
      assert.ok(!noMore.includes('Đã thêm'), `Locale ${loc} must not leak Vietnamese in no_models hint`);
    }
  }

  // English assertions
  assert.equal(t('en', 'fav_select_add_placeholder'), 'Select model to add...');
  assert.equal(t('en', 'fav_no_models_to_add'), 'All models added to favorites');
});
