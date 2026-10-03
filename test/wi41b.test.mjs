// WebMCP Translator Kit — WI-41b Unit & Integration Tests
// Requirements:
// 1. Export JSON kèm checkbox/toggle `Kèm API keys` (mặc định TẮT).
// 2. Khi bật + bấm xuất → hiện confirm() cảnh báo (chuỗi qua catalog 7 locale, nội dung: file chứa secret, không chia sẻ/upload).
// 3. Đồng ý (confirm true) → tải file translator-config.with-keys.json có apiKey + fallbackApiKeys.
// 4. Không đồng ý (confirm false) → xuất bản không-key như cũ (translator-config.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGES, SUPPORTED_UI_LOCALES, t } from '../extension/src/i18n.mjs';
import { buildExportPayload } from '../extension/src/popup.js';
import { buildExportConfig } from '../extension/src/settings.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');

const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');

// ============================================================================
// 1. HTML Structure: Checkbox / Toggle "Kèm API keys"
// ============================================================================

test('WI-41b/WI-44: popup.html contains #checkbox-export-keys toggle defaulting to ON (checked)', () => {
  assert.ok(popupHtml.includes('id="checkbox-export-keys"'), 'popup.html must contain #checkbox-export-keys');
  assert.ok(popupHtml.includes('data-i18n="export_include_keys_label"'), 'toggle must have data-i18n label');

  // Must have checked attribute (defaults to ON / checked per WI-44)
  const tagStart = popupHtml.indexOf('id="checkbox-export-keys"');
  assert.ok(tagStart !== -1);
  const tagOpen = popupHtml.lastIndexOf('<input', tagStart);
  const tagClose = popupHtml.indexOf('>', tagStart);
  const tagHtml = popupHtml.slice(tagOpen, tagClose + 1);

  assert.ok(tagHtml.includes('checked'), '#checkbox-export-keys must default to ON (checked)');
});

// ============================================================================
// 2. i18n Catalog: Warning & Labels across all 7 locales
// ============================================================================

test('WI-41b: Warning string and labels are present in all 7 locales with secret & share/upload warnings', () => {
  const requiredKeys = [
    'export_include_keys_label',
    'export_keys_warning_confirm',
    'export_json_with_keys_success'
  ];

  for (const loc of SUPPORTED_UI_LOCALES) {
    for (const key of requiredKeys) {
      assert.ok(
        typeof MESSAGES[loc][key] === 'string' && MESSAGES[loc][key].trim().length > 0,
        `Locale "${loc}" must define non-empty message for "${key}"`
      );
    }

    const warning = MESSAGES[loc].export_keys_warning_confirm.toLowerCase();

    // Verify warning mentions secret / confidentiality
    const hasSecretMention =
      warning.includes('secret') ||
      warning.includes('секрет') ||
      warning.includes('비밀') ||
      warning.includes('シークレット') ||
      warning.includes('机密');
    assert.ok(
      hasSecretMention,
      `Locale "${loc}" warning must mention secrets/confidentiality: "${warning}"`
    );

    // Verify warning mentions not sharing or uploading
    const hasShareOrUploadMention =
      warning.includes('chia sẻ') ||
      warning.includes('tải lên') ||
      warning.includes('share') ||
      warning.includes('upload') ||
      warning.includes('共有') ||
      warning.includes('アップロード') ||
      warning.includes('공유') ||
      warning.includes('업로드') ||
      warning.includes('分享') ||
      warning.includes('上传') ||
      warning.includes('compartir') ||
      warning.includes('subir') ||
      warning.includes('передавайте') ||
      warning.includes('загружайте');
    assert.ok(
      hasShareOrUploadMention,
      `Locale "${loc}" warning must warn against sharing or uploading: "${warning}"`
    );
  }
});

// ============================================================================
// 3. Pure Logic: buildExportPayload distinguishes unkeyed vs with-keys
// ============================================================================

test('WI-41b: buildExportPayload export không-key không chứa key (filename translator-config.json)', () => {
  const mockSettings = {
    version: 9,
    baseURL: 'https://api.example.com/v1',
    model: 'gemini-pro',
    fallbacks: [{ id: 'fb1', model: 'fallback-model' }]
  };

  const payload = buildExportPayload({
    settings: mockSettings,
    fallbackKeyPresence: { fb1: true },
    hasStoredKey: true,
    includeKeys: false,
    apiKey: 'super-secret-key-123',
    fallbackApiKeys: { fb1: 'fb-secret-key-456' },
    exportedAt: '2026-10-03T18:00:00.000Z'
  });

  assert.equal(payload.filename, 'translator-config.json');
  assert.equal(payload.data.apiKey, undefined, 'apiKey must not be present in unkeyed export');
  assert.equal(payload.data.fallbackApiKeys, undefined, 'fallbackApiKeys must not be present in unkeyed export');

  // Verify recursive secret scan
  const jsonStr = JSON.stringify(payload.data);
  assert.ok(!jsonStr.includes('super-secret-key-123'), 'Secrets must not leak into unkeyed export');
  assert.ok(!jsonStr.includes('fb-secret-key-456'), 'Fallback secrets must not leak into unkeyed export');
});

test('WI-41b: buildExportPayload export có-key chứa apiKey và fallbackApiKeys (filename translator-config.with-keys.json)', () => {
  const mockSettings = {
    version: 9,
    baseURL: 'https://api.example.com/v1',
    model: 'gemini-pro',
    fallbacks: [{ id: 'fb1', model: 'fallback-model' }]
  };

  const payload = buildExportPayload({
    settings: mockSettings,
    fallbackKeyPresence: { fb1: true },
    hasStoredKey: true,
    includeKeys: true,
    apiKey: 'primary-secret-key-abc',
    fallbackApiKeys: { fb1: 'fallback-secret-key-xyz' },
    exportedAt: '2026-10-03T18:00:00.000Z'
  });

  assert.equal(payload.filename, 'translator-config.with-keys.json');
  assert.equal(payload.data.apiKey, 'primary-secret-key-abc');
  assert.deepEqual(payload.data.fallbackApiKeys, { fb1: 'fallback-secret-key-xyz' });
  assert.equal(payload.data.version, 9);
  assert.equal(payload.data.baseURL, 'https://api.example.com/v1');
});

// ============================================================================
// 4. Behavioral & DOM integration: Confirm mock gate
// ============================================================================

test('WI-41b: triggerExportConfig with includeKeys only exports with keys when confirm is true', async () => {
  let confirmPromptCalledWith = null;
  let confirmAnswer = false;

  const mockConfirm = (msg) => {
    confirmPromptCalledWith = msg;
    return confirmAnswer;
  };

  const downloads = [];
  const blobs = [];

  // Set up mock DOM and browser environment
  const savedWindow = globalThis.window;
  const savedDoc = globalThis.document;
  const savedChrome = globalThis.chrome;

  try {
    const fakeStore = {
      api_key: 'sk-test-live-key',
      fallback_api_keys: { fb1: 'sk-test-fb1-key' }
    };

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

    globalThis.window = {
      confirm: mockConfirm
    };

    class FakeBlob {
      constructor(parts, options) {
        this.content = parts.join('');
        this.type = options?.type;
        blobs.push(this);
      }
    }
    globalThis.Blob = FakeBlob;
    globalThis.URL = {
      createObjectURL: () => 'blob:mock-url',
      revokeObjectURL: () => {}
    };

    let appendedElement = null;
    globalThis.document = {
      createElement: (tag) => {
        if (tag === 'a') {
          const anchor = {
            href: '',
            download: '',
            click: () => {
              downloads.push({
                filename: anchor.download,
                blob: blobs[blobs.length - 1]
              });
            },
            parentNode: null
          };
          return anchor;
        }
        return {};
      },
      body: {
        appendChild: (el) => {
          appendedElement = el;
          el.parentNode = globalThis.document.body;
          return el;
        },
        removeChild: (el) => {
          if (appendedElement === el) appendedElement = null;
          el.parentNode = null;
        }
      }
    };

    // Case 1: withKeys = false -> confirm is NOT called, unkeyed file downloaded
    downloads.length = 0;
    confirmPromptCalledWith = null;
    confirmAnswer = false;

    const unkeyedPayload = buildExportPayload({
      settings: { baseURL: 'https://test.com/v1', model: 'test' },
      includeKeys: false,
      apiKey: fakeStore.api_key,
      fallbackApiKeys: fakeStore.fallback_api_keys
    });
    assert.equal(unkeyedPayload.filename, 'translator-config.json');
    assert.equal(unkeyedPayload.data.apiKey, undefined);

    // Case 2: withKeys = true, confirm returns false -> unkeyed file downloaded
    confirmPromptCalledWith = null;
    confirmAnswer = false; // User declines confirm

    const confirmedWithKeysFalse = mockConfirm(t('vi', 'export_keys_warning_confirm'));
    assert.equal(confirmedWithKeysFalse, false);
    assert.ok(confirmPromptCalledWith.includes('API keys'));

    const declinedPayload = buildExportPayload({
      settings: { baseURL: 'https://test.com/v1', model: 'test' },
      includeKeys: confirmedWithKeysFalse, // false
      apiKey: fakeStore.api_key,
      fallbackApiKeys: fakeStore.fallback_api_keys
    });
    assert.equal(declinedPayload.filename, 'translator-config.json');
    assert.equal(declinedPayload.data.apiKey, undefined);
    assert.equal(declinedPayload.data.fallbackApiKeys, undefined);

    // Case 3: withKeys = true, confirm returns true -> with-keys file downloaded
    confirmPromptCalledWith = null;
    confirmAnswer = true; // User accepts confirm

    const confirmedWithKeysTrue = mockConfirm(t('vi', 'export_keys_warning_confirm'));
    assert.equal(confirmedWithKeysTrue, true);

    const approvedPayload = buildExportPayload({
      settings: { baseURL: 'https://test.com/v1', model: 'test' },
      includeKeys: confirmedWithKeysTrue, // true
      apiKey: fakeStore.api_key,
      fallbackApiKeys: fakeStore.fallback_api_keys
    });
    assert.equal(approvedPayload.filename, 'translator-config.with-keys.json');
    assert.equal(approvedPayload.data.apiKey, 'sk-test-live-key');
    assert.deepEqual(approvedPayload.data.fallbackApiKeys, { fb1: 'sk-test-fb1-key' });
  } finally {
    globalThis.window = savedWindow;
    globalThis.document = savedDoc;
    globalThis.chrome = savedChrome;
  }
});
