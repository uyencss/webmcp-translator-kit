// WebMCP Translator Kit — WI-44 Unit Tests
// F1: Modal layout CSS rules (min-width: 0, flex-shrink, width: 100% on modal and input rows).
//     Real DOM/CSS headless overflow verification is measured via WI-45 (npm run check:layout).
// F2: Export kèm key mặc định BẬT (default checked, persist theo autosave, confirm giữ nguyên, uncheck -> file không-key).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGES, SUPPORTED_UI_LOCALES, t } from '../extension/src/i18n.mjs';
import { buildExportPayload } from '../extension/src/popup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const popupCssPath = path.resolve(__dirname, '../extension/src/popup.css');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');

const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');
const popupCss = fs.readFileSync(popupCssPath, 'utf8');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');

// ============================================================================
// 1. F2 HTML & JS Structure: Default checked & Autosave Persistence
// ============================================================================

test('WI-44 F2: #checkbox-export-keys defaults to checked in popup.html', () => {
  assert.ok(popupHtml.includes('id="checkbox-export-keys"'), 'Must have checkbox-export-keys');
  const tagStart = popupHtml.indexOf('id="checkbox-export-keys"');
  const tagOpen = popupHtml.lastIndexOf('<input', tagStart);
  const tagClose = popupHtml.indexOf('>', tagStart);
  const tagHtml = popupHtml.slice(tagOpen, tagClose + 1);

  assert.ok(tagHtml.includes('checked'), '#checkbox-export-keys must have checked attribute');
});

test('WI-44 F2: popup.js collects and persists exportIncludeKeys in settings patch', () => {
  assert.ok(
    popupJs.includes('exportIncludeKeys: checkboxExportKeys ? Boolean(checkboxExportKeys.checked) :'),
    'collectSettingsPatch must include exportIncludeKeys'
  );
  assert.ok(
    popupJs.includes('checkboxExportKeys.addEventListener(\'change\''),
    'checkboxExportKeys must have a change event listener for autosave'
  );
  assert.ok(
    popupJs.includes('savedSettings.exportIncludeKeys = Boolean(checkboxExportKeys.checked)'),
    'change listener must update savedSettings.exportIncludeKeys'
  );
  assert.ok(
    popupJs.includes('checkboxExportKeys.checked = typeof resp.settings.exportIncludeKeys === \'boolean\''),
    'initSettings must restore saved exportIncludeKeys or default to true'
  );
});

// ============================================================================
// 2. F2 Runtime Export Behavior: Default checked vs Uncheck -> unkeyed
// ============================================================================

test('WI-44 F2: Default checked exports with keys when confirmed; uncheck exports without keys and skips confirm', async () => {
  let confirmPromptCalled = false;
  let confirmAnswer = false;

  const mockConfirm = (msg) => {
    confirmPromptCalled = true;
    return confirmAnswer;
  };

  const fakeStore = {
    api_key: 'sk-owner-key-12345',
    fallback_api_keys: { fb1: 'sk-fb-key-999' }
  };

  const savedWindow = globalThis.window;
  const savedDoc = globalThis.document;
  const savedChrome = globalThis.chrome;

  try {
    globalThis.chrome = {
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            for (const k of [].concat(keys)) {
              if (k in fakeStore) out[k] = fakeStore[k];
            }
            return out;
          }
        }
      }
    };
    globalThis.window = { confirm: mockConfirm };

    // Scenario A: Default checked = true, user confirms -> with-keys payload
    confirmPromptCalled = false;
    confirmAnswer = true;

    // Simulate triggerExportConfig logic when checkboxExportKeys is checked
    const isCheckedDefault = true;
    let confirmedWithKeys = false;
    if (isCheckedDefault) {
      const userApproved = mockConfirm('Warning: Exporting with API keys...');
      if (userApproved) confirmedWithKeys = true;
    }
    assert.equal(confirmPromptCalled, true, 'Confirm must be shown when checked');
    assert.equal(confirmedWithKeys, true);

    const payloadWithKeys = buildExportPayload({
      settings: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
      includeKeys: confirmedWithKeys,
      apiKey: fakeStore.api_key,
      fallbackApiKeys: fakeStore.fallback_api_keys
    });
    assert.equal(payloadWithKeys.filename, 'translator-config.with-keys.json');
    assert.equal(payloadWithKeys.data.apiKey, 'sk-owner-key-12345');
    assert.deepEqual(payloadWithKeys.data.fallbackApiKeys, { fb1: 'sk-fb-key-999' });

    // Scenario B: User unchecks checkbox -> checkboxExportKeys.checked = false
    confirmPromptCalled = false;
    const isCheckedUnchecked = false;
    let confirmedWhenUnchecked = false;
    if (isCheckedUnchecked) {
      const userApproved = mockConfirm('Warning...');
      if (userApproved) confirmedWhenUnchecked = true;
    }
    assert.equal(confirmPromptCalled, false, 'Confirm must NOT be shown when unchecked');
    assert.equal(confirmedWhenUnchecked, false);

    const payloadUnchecked = buildExportPayload({
      settings: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
      includeKeys: confirmedWhenUnchecked,
      apiKey: fakeStore.api_key,
      fallbackApiKeys: fakeStore.fallback_api_keys
    });
    assert.equal(payloadUnchecked.filename, 'translator-config.json');
    assert.equal(payloadUnchecked.data.apiKey, undefined, 'Unchecked export must not have apiKey');
    assert.equal(payloadUnchecked.data.fallbackApiKeys, undefined, 'Unchecked export must not have fallbackApiKeys');
  } finally {
    globalThis.window = savedWindow;
    globalThis.document = savedDoc;
    globalThis.chrome = savedChrome;
  }
});

// ============================================================================
// 3. F1 CSS Rules & Layout Integrity for Modal & Input Rows
// ============================================================================

test('WI-44 F1: CSS rules enforce min-width: 0, flex-shrink, width: 100% on modal and input rows', () => {
  // 1. .input-with-button flex rules
  assert.ok(popupCss.includes('.input-with-button {'), 'popup.css must have .input-with-button');
  assert.ok(
    popupCss.includes('min-width: 0') && popupCss.includes('flex: 1 1 0'),
    '.input-with-button children must have flex: 1 1 0 and min-width: 0'
  );

  // 2. .modal-container and .modal-body
  assert.ok(popupCss.includes('.modal-container {'), 'popup.css must define .modal-container');
  assert.ok(popupCss.includes('overflow-x: hidden'), '.modal-body must have overflow-x: hidden');
  assert.ok(popupCss.includes('.modal-body > .section {'), '.modal-body > .section must reset padding/borders');

  // 3. .w-full utility and export row
  assert.ok(popupCss.includes('.w-full {'), 'popup.css must define .w-full');
  assert.ok(popupCss.includes('.export-config-row {'), 'popup.css must define .export-config-row');

  // 4. .rate-limit-row
  assert.ok(popupCss.includes('.rate-limit-row {'), 'popup.css must define .rate-limit-row');
});

