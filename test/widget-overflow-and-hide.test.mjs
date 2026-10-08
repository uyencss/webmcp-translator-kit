import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const contentJsPath = path.join(rootDir, 'extension', 'src', 'content.js');
const contentJs = fs.readFileSync(contentJsPath, 'utf8');

const swJsPath = path.join(rootDir, 'extension', 'src', 'sw.js');
const swJs = fs.readFileSync(swJsPath, 'utf8');

const widgetControllerPath = path.join(rootDir, 'extension', 'src', 'sw', 'modules', 'widget-controller.mjs');
const widgetControllerJs = fs.readFileSync(widgetControllerPath, 'utf8');

const { MESSAGES, SUPPORTED_UI_LOCALES } = await import('../extension/src/i18n.mjs');
const { handleWidgetSetVisibleAction } = await import('../extension/src/sw/modules/widget-controller.mjs');

// ============================================================================
// 1. i18n Localization Parity for widget_hide_label
// ============================================================================

test('Widget hide button: widget_hide_label exists in all 7 locales', () => {
  for (const locale of SUPPORTED_UI_LOCALES) {
    const dict = MESSAGES[locale];
    assert.ok(dict, `Locale dictionary for ${locale} must exist`);
    assert.ok(
      typeof dict.widget_hide_label === 'string' && dict.widget_hide_label.length > 0,
      `widget_hide_label must be a non-empty string in locale ${locale}`
    );
  }
});

// ============================================================================
// 2. DOM & CSS Structure for Hide Button and Responsive Dropdown
// ============================================================================

test('Widget DOM: contains #wmt-fab-anchor and #wmt-fab-hide', () => {
  assert.ok(contentJs.includes('id="wmt-fab-anchor"'), 'content.js must contain #wmt-fab-anchor wrapper');
  assert.ok(contentJs.includes('id="wmt-fab-hide"'), 'content.js must contain #wmt-fab-hide button');
  assert.ok(contentJs.includes('.wmt-fab-anchor'), 'content.js must style .wmt-fab-anchor');
  assert.ok(contentJs.includes('.wmt-fab-hide'), 'content.js must style .wmt-fab-hide');
  assert.ok(contentJs.includes('.wmt-fab-anchor:hover .wmt-fab-hide'), 'content.js must only reveal .wmt-fab-hide when hovering over the anchor');
  assert.ok(contentJs.includes('.wmt-fab-hide:hover'), 'content.js must style hover state of .wmt-fab-hide');
});

test('Widget CSS: defines responsive placement classes and overflow prevention', () => {
  assert.ok(contentJs.includes('.wmt-panel.placement-below'), 'content.js must define .placement-below for dropping down');
  assert.ok(contentJs.includes('.wmt-panel.placement-align-left'), 'content.js must define .placement-align-left for left alignment');
  assert.ok(contentJs.includes('max-height: calc(100vh - 80px)'), 'content.js must cap panel height to prevent viewport overflow');
  assert.ok(contentJs.includes('max-width: calc(100vw - 20px)'), 'content.js must cap panel width to prevent screen spill');
  assert.ok(contentJs.includes('overflow-y: auto'), 'content.js must enable vertical scrolling on panel overflow');
});

test('Widget JS: implements updatePanelPosition and wires to drag, resize, and state changes', () => {
  assert.ok(contentJs.includes('function updatePanelPosition()'), 'content.js must define updatePanelPosition');
  assert.ok(contentJs.includes('panel.classList.toggle(\'placement-below\''), 'updatePanelPosition must toggle placement-below');
  assert.ok(contentJs.includes('panel.classList.toggle(\'placement-align-left\''), 'updatePanelPosition must toggle placement-align-left');
  assert.ok(contentJs.includes('updatePanelPosition();'), 'content.js must invoke updatePanelPosition on visibility, drag, and resize');
  assert.ok(contentJs.includes('window.addEventListener(\'resize\''), 'content.js must listen for window resize to update panel position');
});

// ============================================================================
// 3. Service Worker: WIDGET_SET_VISIBLE Handling
// ============================================================================

test('Service Worker: declares and handles WIDGET_SET_VISIBLE', () => {
  assert.ok(swJs.includes("case 'WIDGET_SET_VISIBLE':"), 'sw.js must handle WIDGET_SET_VISIBLE action');
  assert.ok(swJs.includes('handleWidgetSetVisibleAction'), 'sw.js must delegate to handleWidgetSetVisibleAction');
  assert.ok(widgetControllerJs.includes('export async function handleWidgetSetVisibleAction'), 'widget-controller.mjs must export handleWidgetSetVisibleAction');
});

test('handleWidgetSetVisibleAction: updates widgetVisible setting and broadcasts change', async () => {
  let savedSettings = null;
  let broadcastedPayload = null;

  globalThis.chrome = {
    storage: {
      local: {
        set: async (obj) => { savedSettings = obj; }
      }
    }
  };

  const fakeSender = {
    url: 'https://example.com/page',
    tab: { id: 123, url: 'https://example.com/page' },
    frameId: 0
  };

  const storedSettings = {
    widgetVisible: true,
    translationMode: 'scroll-follow',
    model: 'ag/test'
  };

  const res = await handleWidgetSetVisibleAction({
    sender: fakeSender,
    message: { visible: false },
    serializeSettingsWrite: async (fn) => fn(),
    ensureStorageAccess: async () => {},
    getStoredSettings: async () => storedSettings,
    migrateSettings: (s) => s,
    notifyAllWidgetStateChanged: (patch) => {
      broadcastedPayload = patch;
    }
  });

  assert.equal(res.ok, true);
  assert.equal(res.widgetVisible, false);
  assert.deepEqual(broadcastedPayload, { widgetVisible: false });
  assert.deepEqual(savedSettings, { settings: { ...storedSettings, widgetVisible: false } });
});

test('handleWidgetSetVisibleAction: rejects invalid sender (extension isolation check)', async () => {
  const invalidSender = {
    url: '',
    tab: null
  };

  const res = await handleWidgetSetVisibleAction({
    sender: invalidSender,
    message: { visible: false },
    serializeSettingsWrite: async (fn) => fn(),
    ensureStorageAccess: async () => {},
    getStoredSettings: async () => ({}),
    migrateSettings: (s) => s,
    notifyAllWidgetStateChanged: () => {}
  });

  assert.equal(res.error?.code, 'PERMISSION_REQUIRED');
});

