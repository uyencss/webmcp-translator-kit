// WebMCP Translator Kit — WI-52 Unit & Integration Tests
// Requirements:
// 1. Floating Mascot Icons:
//    - VALID_FAB_MASCOTS = ['default', 'polyglot-owl', 'babel-cat', 'globe-fox', 'lingo-parrot', 'robo-babel'].
//    - normalizeFabMascot() falls back to 'default' safely.
//    - DEFAULT_SETTINGS.fabMascot = 'default'.
//    - migrateSettings() converts legacy settings to canonical with fabMascot: 'default'.
//    - validateSettings() enforces valid mascot enum.
// 2. Appearance Tab UI in popup.html / popup.js / popup.css:
//    - #mascot-selector-grid with 6 .mascot-chip buttons and thumbnail avatars.
//    - #select-fab-mascot fallback selector.
//    - #btn-reset-fab-size button resetting slider to 1.00x.
// 3. i18n localization parity:
//    - All 8 new keys exist across all 7 supported locales (vi, en, ja, ko, zh, es, ru).
// 4. Content Script Shadow DOM:
//    - #wmt-fab includes #wmt-mascot-img and #wmt-default-svg.
//    - Dynamic mascot url resolution with error fallback.
//    - Busy animation: wmtMascotPulse.
// 5. Assets & Manifest:
//    - 5 mascot PNG files exist in src and dist.
//    - manifest.json declares web_accessible_resources for mascot icons.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS,
  VALID_FAB_MASCOTS,
  normalizeFabMascot,
  migrateSettings,
  validateSettings,
  buildExportConfig,
  parseImportConfig
} from '../extension/src/settings.mjs';
import { MESSAGES, SUPPORTED_UI_LOCALES, t } from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');
const popupCssPath = path.resolve(__dirname, '../extension/src/popup.css');
const contentJsPath = path.resolve(__dirname, '../extension/src/content.js');
const swJsPath = path.resolve(__dirname, '../extension/src/sw.js');
const manifestPath = path.resolve(__dirname, '../extension/src/manifest.json');
const mascotsSrcDir = path.resolve(__dirname, '../extension/src/icons/mascots');
const mascotsDistDir = path.resolve(__dirname, '../extension/dist/icons/mascots');

const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');
const popupCss = fs.readFileSync(popupCssPath, 'utf8');
const contentJs = fs.readFileSync(contentJsPath, 'utf8');
const swJs = fs.readFileSync(swJsPath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// ============================================================================
// 1. Settings Schema, Normalization & Migration
// ============================================================================

test('WI-52: VALID_FAB_MASCOTS contains all 6 supported mascots', () => {
  assert.ok(Array.isArray(VALID_FAB_MASCOTS));
  const expected = ['default', 'polyglot-owl', 'babel-cat', 'globe-fox', 'lingo-parrot', 'robo-babel'];
  assert.deepEqual([...VALID_FAB_MASCOTS], expected);
  assert.equal(DEFAULT_SETTINGS.fabMascot, 'default');
});

test('WI-52: normalizeFabMascot handles valid mascots and invalid fallbacks', () => {
  assert.equal(normalizeFabMascot('default'), 'default');
  assert.equal(normalizeFabMascot('polyglot-owl'), 'polyglot-owl');
  assert.equal(normalizeFabMascot('babel-cat'), 'babel-cat');
  assert.equal(normalizeFabMascot('globe-fox'), 'globe-fox');
  assert.equal(normalizeFabMascot('lingo-parrot'), 'lingo-parrot');
  assert.equal(normalizeFabMascot('robo-babel'), 'robo-babel');

  // Fallbacks
  assert.equal(normalizeFabMascot('unknown-dragon'), 'default');
  assert.equal(normalizeFabMascot(''), 'default');
  assert.equal(normalizeFabMascot(null), 'default');
  assert.equal(normalizeFabMascot(undefined), 'default');
  assert.equal(normalizeFabMascot(123), 'default');
});

test('WI-52: migrateSettings sets fabMascot default and validates input', () => {
  const legacy = {
    version: 9,
    baseURL: 'https://example.com/v1',
    model: 'do/glm-5.3-flash',
    theme: 'dark'
  };

  const migratedDefault = migrateSettings(legacy);
  assert.equal(migratedDefault.fabMascot, 'default');

  const migratedOwl = migrateSettings({ ...legacy, fabMascot: 'polyglot-owl' });
  assert.equal(migratedOwl.fabMascot, 'polyglot-owl');

  const migratedInvalid = migrateSettings({ ...legacy, fabMascot: 'invalid-monster' });
  assert.equal(migratedInvalid.fabMascot, 'default');
});

test('WI-52: validateSettings validates fabMascot enum correctly', () => {
  const validBase = {
    version: 9,
    baseURL: 'https://example.com/v1',
    model: 'do/glm-5.3-flash',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fabSize: 1.0,
    fabMascot: 'babel-cat'
  };

  const validRes = validateSettings(validBase);
  assert.equal(validRes.valid, true);

  const invalidRes = validateSettings({ ...validBase, fabMascot: 'non-existent' });
  assert.equal(invalidRes.valid, false);
  assert.ok(invalidRes.errors.some((e) => e.includes('fabMascot')));

  const wrongTypeRes = validateSettings({ ...validBase, fabMascot: 42 });
  assert.equal(wrongTypeRes.valid, false);
  assert.ok(wrongTypeRes.errors.some((e) => e.includes('fabMascot')));
});

test('WI-52: Export and Import preserve fabMascot setting', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    baseURL: 'https://api.openai.com/v1',
    fabMascot: 'globe-fox',
    fabSize: 1.2
  };

  const exported = buildExportConfig({ settings });
  assert.equal(exported.fabMascot, 'globe-fox');

  const imported = parseImportConfig(JSON.stringify(exported));
  assert.equal(imported.settings.fabMascot, 'globe-fox');
});

// ============================================================================
// 2. i18n Localization Parity Across All 7 Locales
// ============================================================================

test('WI-52: All 9 new mascot and reset size keys exist in all 7 locales', () => {
  const requiredKeys = [
    'config_fab_mascot_label',
    'config_fab_size_reset_btn',
    'config_fab_size_reset_title',
    'mascot_default',
    'mascot_polyglot_owl',
    'mascot_babel_cat',
    'mascot_globe_fox',
    'mascot_lingo_parrot',
    'mascot_robo_babel'
  ];

  for (const locale of SUPPORTED_UI_LOCALES) {
    const dict = MESSAGES[locale];
    assert.ok(dict, `Messages dictionary must exist for locale ${locale}`);
    for (const key of requiredKeys) {
      assert.ok(
        typeof dict[key] === 'string' && dict[key].trim().length > 0,
        `Key ${key} must exist and be non-empty string in locale ${locale}`
      );
      assert.ok(t(locale, key).length > 0, `t("${locale}", "${key}") must resolve`);
    }
  }
});

// ============================================================================
// 3. Popup HTML & DOM Structure
// ============================================================================

test('WI-52: popup.html contains mascot selector grid, localized title, and reset button', () => {
  assert.ok(popupHtml.includes('id="label-fab-mascot"'), '#label-fab-mascot must exist in popup.html');
  assert.ok(popupHtml.includes('id="mascot-selector-grid"'), '#mascot-selector-grid must exist in popup.html');
  assert.ok(popupHtml.includes('id="select-fab-mascot"'), '#select-fab-mascot must exist in popup.html');
  assert.ok(popupHtml.includes('id="btn-reset-fab-size"'), '#btn-reset-fab-size must exist in popup.html');
  assert.ok(popupHtml.includes('data-i18n-title="config_fab_size_reset_title"'), '#btn-reset-fab-size must have localized title');

  // Verify all 6 chips exist
  for (const mascot of VALID_FAB_MASCOTS) {
    assert.ok(
      popupHtml.includes(`data-mascot="${mascot}"`),
      `popup.html must contain .mascot-chip with data-mascot="${mascot}"`
    );
  }
});

test('WI-52: popup.js implements applyFabMascot, full 4-way Arrow key navigation, and reset size', () => {
  assert.ok(popupJs.includes('function applyFabMascot('), 'popup.js must implement applyFabMascot');
  assert.ok(popupJs.includes('btnResetFabSize'), 'popup.js must reference btnResetFabSize');
  assert.ok(popupJs.includes('mascotSelectorGrid'), 'popup.js must reference mascotSelectorGrid');
  assert.ok(popupJs.includes('selectFabMascot'), 'popup.js must reference selectFabMascot');
  assert.ok(popupJs.includes('fabMascot:'), 'popup.js must collect fabMascot in settings patch');
  assert.ok(popupJs.includes("e.key === 'ArrowRight'"), 'popup.js must handle ArrowRight');
  assert.ok(popupJs.includes("e.key === 'ArrowDown'"), 'popup.js must handle ArrowDown');
  assert.ok(popupJs.includes("e.key === 'ArrowLeft'"), 'popup.js must handle ArrowLeft');
  assert.ok(popupJs.includes("e.key === 'ArrowUp'"), 'popup.js must handle ArrowUp');
  assert.ok(popupJs.includes('chips.length'), 'popup.js must wrap around chips.length');
  assert.ok(popupJs.includes('targetChip.focus()'), 'popup.js must move focus to next chip');
  assert.ok(popupJs.includes('markDirty()'), 'popup.js must mark dirty on arrow navigation');
});

test('WI-52: popup.css defines mascot grid, chips, thumbnails, and balanced braces', () => {
  assert.ok(popupCss.includes('.mascot-selector-grid'), 'popup.css must style .mascot-selector-grid');
  assert.ok(popupCss.includes('.mascot-chip'), 'popup.css must style .mascot-chip');
  assert.ok(popupCss.includes('.mascot-thumb'), 'popup.css must style .mascot-thumb');
  assert.ok(popupCss.includes('.btn-reset-size'), 'popup.css must style .btn-reset-size');

  // Verify balanced braces in popup.css
  let openBraces = 0;
  for (const ch of popupCss) {
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    assert.ok(openBraces >= 0, 'popup.css has premature closing brace');
  }
  assert.equal(openBraces, 0, 'popup.css braces must be perfectly balanced');
});

// ============================================================================
// 4. Content Script Shadow DOM & Mascot Rendering
// ============================================================================

test('WI-52: content.js contains mascot image tag, default SVG, and mascot animations', () => {
  assert.ok(contentJs.includes('id="wmt-mascot-img"'), 'content.js must contain #wmt-mascot-img in button');
  assert.ok(contentJs.includes('id="wmt-default-svg"'), 'content.js must contain #wmt-default-svg in button');
  assert.ok(contentJs.includes('id="wmt-halo"'), 'content.js must contain #wmt-halo in button');
  assert.ok(contentJs.includes('id="wmt-mascot-zzz"'), 'content.js must contain #wmt-mascot-zzz for idle sleep');
  assert.ok(contentJs.includes('.wmt-mascot-img'), 'content.js style must include .wmt-mascot-img');
  assert.ok(contentJs.includes('wmtHaloOrbit'), 'content.js must define wmtHaloOrbit animation for orbiting dot');
  assert.ok(contentJs.includes('wmtFloatZzz'), 'content.js must define wmtFloatZzz animation for sleeping Zzz');
  assert.ok(contentJs.includes('wmtMascotPulse'), 'content.js must define wmtMascotPulse animation');
  assert.ok(contentJs.includes('wmtMascotIdle'), 'content.js must define wmtMascotIdle animation');
  assert.ok(contentJs.includes('wmtMascotThinking'), 'content.js must define wmtMascotThinking animation');
  assert.ok(contentJs.includes('wmtMascotDone'), 'content.js must define wmtMascotDone animation');
  assert.ok(contentJs.includes('updateMascotVisual'), 'content.js must define updateMascotVisual helper');
  assert.ok(contentJs.includes('storage.onChanged'), 'content.js must listen to chrome.storage.onChanged');
  assert.ok(contentJs.includes('polyglot-owl'), 'content.js MASCOT_MAP must include polyglot-owl');
  assert.ok(contentJs.includes('babel-cat'), 'content.js MASCOT_MAP must include babel-cat');
  assert.ok(contentJs.includes('globe-fox'), 'content.js MASCOT_MAP must include globe-fox');
  assert.ok(contentJs.includes('lingo-parrot'), 'content.js MASCOT_MAP must include lingo-parrot');
  assert.ok(contentJs.includes('robo-babel'), 'content.js MASCOT_MAP must include robo-babel');
});

test('WI-52: popup.html and popup.js provide Import JSON in settings dropdown menu', () => {
  assert.ok(popupHtml.includes('id="menu-item-import"'), 'popup.html must contain #menu-item-import in settings menu');
  assert.ok(popupHtml.includes('id="input-import-config"'), 'popup.html must contain #input-import-config');
  assert.ok(popupJs.includes('menuItemImport'), 'popup.js must reference menuItemImport');
  assert.ok(popupJs.includes('broadcastWidgetPresentation'), 'popup.js must implement broadcastWidgetPresentation');
});

test('WI-52: sw.js broadcasts fabMascot to content script widgets safely', () => {
  assert.ok(swJs.includes('oldSettings.fabMascot !== migrated.fabMascot'), 'sw.js must detect fabMascot changes');
  assert.ok(swJs.includes("fabMascot: settings.fabMascot || 'default'"), 'sw.js must include fabMascot in widget state');
  assert.ok(swJs.includes('notifyAllWidgetStateChanged'), 'sw.js must define notifyAllWidgetStateChanged');
});

// ============================================================================
// 5. Assets & Manifest Declarations
// ============================================================================

test('WI-52: All 15 mascot PNG files exist in extension/src/icons/mascots and in categorized subfolders', () => {
  const mascots = ['polyglot-owl', 'babel-cat', 'globe-fox', 'lingo-parrot', 'robo-babel'];
  const variants = ['', '-thinking', '-done'];
  const subfolderStates = ['idle.png', 'thinking.png', 'done.png'];

  for (const m of mascots) {
    // 1. Flat files for backward compatibility
    for (const v of variants) {
      const filename = `${m}${v}.png`;
      const pSrc = path.join(mascotsSrcDir, filename);
      assert.ok(fs.existsSync(pSrc), `Mascot asset must exist in src: ${filename}`);
      const stat = fs.statSync(pSrc);
      assert.ok(stat.size > 1000, `Mascot asset ${filename} must be non-empty image (got ${stat.size} bytes)`);

      const pDist = path.join(mascotsDistDir, filename);
      assert.ok(fs.existsSync(pDist), `Mascot asset must exist in dist: ${filename}`);
    }

    // 2. Categorized subfolders: {mascot}/idle.png, thinking.png, done.png
    for (const s of subfolderStates) {
      const pSubSrc = path.join(mascotsSrcDir, m, s);
      assert.ok(fs.existsSync(pSubSrc), `Subfolder asset must exist in src: ${m}/${s}`);
      const pSubDist = path.join(mascotsDistDir, m, s);
      assert.ok(fs.existsSync(pSubDist), `Subfolder asset must exist in dist: ${m}/${s}`);
    }
  }
});

test('WI-52: manifest.json declares web_accessible_resources for mascot icons including subfolders', () => {
  assert.ok(Array.isArray(manifest.web_accessible_resources), 'manifest.json must have web_accessible_resources array');
  const hasMascotRule = manifest.web_accessible_resources.some((rule) => {
    return Array.isArray(rule.resources) && rule.resources.some((r) => r.includes('icons/mascots/'));
  });
  assert.ok(hasMascotRule, 'manifest.json must declare web_accessible_resources for icons/mascots/');
});

// ============================================================================
// 6. Live Presentation Timing & Production Message Handler Tests
// ============================================================================

test('WI-52: sw.js distinguishes presentation-only saves and passes isPresentation: !functionalChanged', () => {
  assert.ok(swJs.includes('const functionalChanged = Boolean('), 'sw.js must compute functionalChanged');
  assert.ok(swJs.includes('const presentationChanged = Boolean('), 'sw.js must compute presentationChanged');
  assert.ok(swJs.includes('isPresentation: !functionalChanged'), 'sw.js must pass isPresentation: !functionalChanged');
});

test('WI-52: Production content.js onMessage handler preserves pending auto-start on presentation pushes and cancels on functional pushes', async () => {
  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    function fakeEl(tag = 'DIV') {
      const el = {
        style: {
          setProperty(k, v) { this[k] = v; },
          removeProperty(k) { delete this[k]; }
        },
        dataset: {}, tagName: tag, id: '',
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        appendChild(child) { return child; },
        querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {},
        attachShadow: () => fakeEl(),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isContentEditable: false, parentElement: null, isConnected: true
      };
      return el;
    }

    const bodyFake = fakeEl('BODY');
    const docEl = fakeEl('HTML');
    const registeredListeners = [];

    globalThis.chrome = {
      runtime: {
        getURL: (rel) => `chrome-extension://fake/${rel}`,
        onMessage: {
          addListener(fn) { registeredListeners.push(fn); }
        },
        sendMessage(msg, cb) {
          if (typeof cb === 'function') cb({ ok: true, settings: {} });
        }
      },
      storage: {
        local: {
          get: () => Promise.resolve({ settings: {} }),
          set: () => Promise.resolve({})
        },
        onChanged: { addListener() {} }
      }
    };

    const win = {
      innerHeight: 800, innerWidth: 1200,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    globalThis.window = win;

    globalThis.document = {
      documentElement: docEl,
      body: bodyFake,
      getElementById: () => null,
      createElement: (t) => fakeEl(t),
      createTreeWalker: () => ({ nextNode: () => null }),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'http:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    // Execute real production content.js
    vm.runInThisContext(contentJs, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content.js must expose __translatorDom');
    assert.ok(registeredListeners.length > 0, 'content.js must register runtime.onMessage listener');
    const prodListener = registeredListeners[registeredListeners.length - 1];

    // 1. Establish pending auto-start state
    dom.setAutoStartTimerForTest(88888);
    assert.equal(dom.hasAutoStartTimer(), true, 'autoStartTimer must be active');
    assert.equal(dom.isAutoStarting(), true, 'autoStarting must be true');

    // 2. Dispatch REAL presentation-only push from production sw.js or popup.js
    prodListener({
      action: 'WIDGET_STATE_CHANGED',
      isPresentation: true,
      fabMascot: 'polyglot-owl',
      fabSize: 1.25
    });

    // 3. Verify: pending auto-start timer survives in production content.js!
    assert.equal(dom.hasAutoStartTimer(), true, 'Pending autoStartTimer must survive presentation-only push');
    assert.equal(dom.isAutoStarting(), true, 'autoStarting flag must remain true during presentation push');

    // 4. Dispatch functional push (e.g. site toggle or consent change: isPresentation: false)
    prodListener({
      action: 'WIDGET_STATE_CHANGED',
      isPresentation: false,
      translationMode: 'full'
    });

    // 5. Verify: functional push cancels pending autoStartTimer to allow clean re-evaluation
    assert.equal(dom.hasAutoStartTimer(), false, 'Functional push must cancel autoStartTimer');
    assert.equal(dom.isAutoStarting(), false, 'Functional push must clear autoStarting flag');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      globalThis[k] = v;
    }
  }
});

test('WI-52: Live update retains selected presentation through autosave debounce without reverting', () => {
  assert.ok(popupJs.includes('isPresentation: true'), 'popup.js must send isPresentation: true');
  assert.ok(popupJs.includes('fabMascot: currentMascot'), 'popup.js updateFabSizeDisplay must preserve current mascot');
  assert.ok(popupJs.includes('fabSize: currentSize'), 'popup.js applyFabMascot must preserve current size');
  assert.ok(contentJs.includes('lastPresentationTime'), 'content.js must track lastPresentationTime');
  assert.ok(contentJs.includes('if (msg.isPresentation)'), 'content.js must check msg.isPresentation before clearing auto-start state');

  let widgetState = { fabMascot: 'default', fabSize: 1.0, theme: 'dark' };
  let lastPresentationTime = 0;

  function simulateApplyState(st) {
    if (!st) return;
    if (st.isPresentation) {
      lastPresentationTime = Date.now();
    }
    const isStaleQuery = (Date.now() - lastPresentationTime < 3000) && !st.isPresentation && (st.fabMascot !== undefined || st.fabSize !== undefined);
    const effectiveSt = isStaleQuery
      ? { ...st, fabMascot: widgetState.fabMascot, fabSize: widgetState.fabSize }
      : st;
    widgetState = { ...widgetState, ...effectiveSt };
  }

  // Live presentation set by user
  simulateApplyState({ isPresentation: true, fabMascot: 'polyglot-owl', fabSize: 1.25 });
  assert.equal(widgetState.fabMascot, 'polyglot-owl');
  assert.equal(widgetState.fabSize, 1.25);

  // Stale debounced storage query arrives 100ms later
  simulateApplyState({ fabMascot: 'default', fabSize: 1.0, model: 'do/glm-5.3-flash' });
  assert.equal(widgetState.fabMascot, 'polyglot-owl', 'Mascot must NOT revert to default on stale query');
  assert.equal(widgetState.fabSize, 1.25, 'Fab size must NOT revert to 1.0 on stale query');
  assert.equal(widgetState.model, 'do/glm-5.3-flash', 'Non-presentation fields from query still apply');
});


