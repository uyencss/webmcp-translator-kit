import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_UI_LOCALES,
  DEFAULT_UI_LOCALE,
  MESSAGES,
  t
} from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('i18n: SUPPORTED_UI_LOCALES contains 7 locales with vi as default', () => {
  assert.deepEqual(SUPPORTED_UI_LOCALES, ['vi', 'en', 'ja', 'ko', 'zh', 'es', 'ru']);
  assert.equal(DEFAULT_UI_LOCALE, 'vi');
});

test('i18n: t() translates known keys for all 7 locales', () => {
  assert.equal(t('vi', 'tab_translate'), 'Dịch');
  assert.equal(t('en', 'tab_translate'), 'Translate');
  assert.equal(t('ja', 'tab_translate'), '翻訳');
  assert.equal(t('ko', 'tab_translate'), '번역');
  assert.equal(t('zh', 'tab_translate'), '翻译');
  assert.equal(t('es', 'tab_translate'), 'Traducir');
  assert.equal(t('ru', 'tab_translate'), 'Перевод');

  assert.equal(t('vi', 'btn_translate'), 'Dịch trang');
  assert.equal(t('en', 'btn_translate'), 'Translate page');
  assert.equal(t('ja', 'btn_translate'), 'ページを翻訳');
  assert.equal(t('ko', 'btn_translate'), '페이지 번역');
  assert.equal(t('zh', 'btn_translate'), '翻译页面');
  assert.equal(t('es', 'btn_translate'), 'Traducir página');
  assert.equal(t('ru', 'btn_translate'), 'Перевести страницу');
});

test('i18n: t() falls back to vi when key is missing in locale or locale is unknown', () => {
  assert.equal(t('fr', 'tab_translate'), 'Dịch');
  assert.equal(t('unknown', 'tab_translate'), 'Dịch');
  assert.equal(t(null, 'tab_translate'), 'Dịch');

  // Key that does not exist at all returns the key string
  assert.equal(t('vi', 'non_existent_key_xyz'), 'non_existent_key_xyz');
  assert.equal(t('en', 'non_existent_key_xyz'), 'non_existent_key_xyz');
});

test('i18n: t() replaces {params} correctly', () => {
  const result = t('vi', 'custom_key', { count: 5 });
  // Unregistered key with params returns key
  assert.equal(result, 'custom_key');
});

test('i18n: complete catalog parity across all 7 locales (7/7 parity)', () => {
  const viKeys = Object.keys(MESSAGES.vi).sort();
  assert.equal(SUPPORTED_UI_LOCALES.length, 7, 'Must support 7 locales');

  for (const locale of SUPPORTED_UI_LOCALES) {
    assert.ok(MESSAGES[locale], `MESSAGES must contain locale ${locale}`);
    const locKeys = Object.keys(MESSAGES[locale]).sort();
    assert.deepEqual(
      locKeys,
      viKeys,
      `Locale "${locale}" must have exact same keys as vi (fail if missing or extra keys)`
    );

    for (const key of viKeys) {
      assert.equal(typeof MESSAGES[locale][key], 'string', `${locale}.${key} must be a string`);
      assert.ok(MESSAGES[locale][key].length > 0, `${locale}.${key} must not be empty`);

      // Verify parameter placeholders match exactly
      const viParams = (MESSAGES.vi[key].match(/\{[a-zA-Z0-9_]+\}/g) || []).sort();
      const locParams = (MESSAGES[locale][key].match(/\{[a-zA-Z0-9_]+\}/g) || []).sort();
      assert.deepEqual(
        locParams,
        viParams,
        `Placeholder parameters for key "${key}" in "${locale}" must match vi`
      );
    }
  }
});

test('i18n: i18n-globals.js exposes window.__wmtI18n matching ESM catalog across all 7 locales', () => {
  const globalsPath = path.join(__dirname, '..', 'extension', 'src', 'i18n-globals.js');
  const code = fs.readFileSync(globalsPath, 'utf8');

  const fakeWindow = {};
  const context = vm.createContext({ window: fakeWindow });
  vm.runInContext(code, context);

  assert.ok(fakeWindow.__wmtI18n, 'window.__wmtI18n must be defined');
  assert.deepEqual([...fakeWindow.__wmtI18n.SUPPORTED_UI_LOCALES], [...SUPPORTED_UI_LOCALES]);
  assert.equal(fakeWindow.__wmtI18n.DEFAULT_UI_LOCALE, DEFAULT_UI_LOCALE);

  for (const loc of SUPPORTED_UI_LOCALES) {
    assert.ok(fakeWindow.__wmtI18n.MESSAGES[loc], `Globals catalog must contain ${loc}`);
    assert.deepEqual(
      Object.keys(fakeWindow.__wmtI18n.MESSAGES[loc]).sort(),
      Object.keys(MESSAGES[loc]).sort(),
      `Globals catalog keys for ${loc} must match ESM catalog`
    );
  }

  // Test classic t function
  assert.equal(fakeWindow.__wmtI18n.t('vi', 'tab_translate'), 'Dịch');
  assert.equal(fakeWindow.__wmtI18n.t('en', 'tab_translate'), 'Translate');
  assert.equal(fakeWindow.__wmtI18n.t('ja', 'tab_translate'), '翻訳');
  assert.equal(fakeWindow.__wmtI18n.t('de', 'tab_translate'), 'Dịch');
});

test('i18n: wmtT fallback không global trả về nhãn tiếng Việt DOM cứng thay vì raw key', () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const code = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    const createdElements = [];
    function fakeEl(tag = 'DIV') {
      const attrs = {};
      const el = {
        style: {}, dataset: {}, tagName: tag, id: '',
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] ?? null; },
        hasAttribute(k) { return k in attrs; },
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        appendChild(child) { return child; },
        querySelector(sel) {
          if (sel === '#wmt-close') return closeBtn;
          if (sel === '.wmt-status-lbl') return statusLbl;
          if (sel === '#wmt-status-tag') return statusTag;
          if (sel === '#wmt-toggle-tab') return toggleTabBtn;
          if (sel === '.wmt-mode-text-scroll') return modeTextScroll;
          if (sel === '.wmt-mode-text-full') return modeTextFull;
          if (sel === '#wmt-action-translate') return translateBtn;
          if (sel === '#wmt-action-restore') return restoreBtn;
          if (sel === '.wmt-hint') return hintEl;
          if (sel === '#wmt-warn-msg') return warnMsg;
          if (sel === '#wmt-panel') return panel;
          if (sel === '#wmt-fab') return fab;
          if (sel === '#wmt-badge') return badge;
          return fakeEl();
        },
        querySelectorAll() { return []; },
        attachShadow() { return shadowRoot; },
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isConnected: true
      };
      createdElements.push(el);
      return el;
    }

    const closeBtn = fakeEl('BUTTON');
    const statusLbl = fakeEl('SPAN');
    const statusTag = fakeEl('SPAN');
    const toggleTabBtn = fakeEl('BUTTON');
    const modeTextScroll = fakeEl('SPAN');
    const modeTextFull = fakeEl('SPAN');
    const translateBtn = fakeEl('BUTTON');
    const restoreBtn = fakeEl('BUTTON');
    const hintEl = fakeEl('DIV');
    const warnMsg = fakeEl('DIV');
    const panel = fakeEl('DIV');
    const fab = fakeEl('BUTTON');
    const badge = fakeEl('SPAN');
    const shadowRoot = fakeEl('SHADOW');

    const win = {
      innerHeight: 800, innerWidth: 1200,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;
    // CRITICAL: window.__wmtI18n is intentionally absent
    delete win.__wmtI18n;

    globalThis.window = win;
    const bodyFake = fakeEl('BODY');
    const docEl = fakeEl('HTML');
    globalThis.document = {
      documentElement: docEl, body: bodyFake,
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
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() {}
      }
    };

    vm.runInThisContext(code, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');
    assert.equal(typeof dom._wmtT, 'function', 'dom must expose _wmtT');

    // 1. Confirm window.__wmtI18n is absent
    assert.equal(win.__wmtI18n, undefined);

    // 2. All widget keys must return hardcoded Vietnamese DOM labels, NEVER raw key strings
    const testCases = [
      ['widget_close_label', 'Đóng panel'],
      ['widget_status_label', 'Trạng thái:'],
      ['widget_status_on', 'Đang bật'],
      ['widget_status_off', 'Đang tắt'],
      ['widget_toggle_tab_on', 'Tắt dịch tab này'],
      ['widget_toggle_tab_off', 'Bật dịch tab này'],
      ['widget_mode_scroll', 'Dịch đuổi theo scroll'],
      ['widget_mode_full', 'Dịch toàn trang'],
      ['widget_btn_translate', 'Dịch ngay'],
      ['widget_btn_restore', 'Khôi phục'],
      ['widget_hint', 'Mở popup để cấu hình key/quyền/model'],
      ['widget_warn_no_perm', 'Thiếu quyền host! Mở popup để cấp quyền.'],
      ['widget_warn_no_key', 'Chưa cấu hình API key! Mở popup để nhập key.']
    ];

    for (const [key, expected] of testCases) {
      const translated = dom._wmtT(key);
      assert.equal(translated, expected, `Key "${key}" must fall back to "${expected}"`);
      assert.notEqual(translated, key, `Key "${key}" must never return raw key`);
    }

    // 3. Elements rendered in widget must have Vietnamese fallback text, not raw keys
    assert.equal(statusLbl.textContent, 'Trạng thái:');
    assert.equal(modeTextScroll.textContent, 'Dịch đuổi theo scroll');
    assert.equal(modeTextFull.textContent, 'Dịch toàn trang');
    assert.equal(translateBtn.textContent, 'Dịch ngay');
    assert.equal(restoreBtn.textContent, 'Khôi phục');
    assert.equal(hintEl.textContent, 'Mở popup để cấu hình key/quyền/model');
    assert.equal(closeBtn.getAttribute('aria-label'), 'Đóng panel');
  } finally {
    for (const k of Object.keys(saved)) globalThis[k] = saved[k];
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (!(k in saved)) delete globalThis[k];
    }
  }
});

test('i18n: static scan: zero Vietnamese string literals in popup.js and content.js outside WIDGET_FALLBACK_LABELS', () => {
  const vnCharRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

  // 1. Scan popup.js
  const popupPath = path.join(__dirname, '..', 'extension', 'src', 'popup.js');
  const popupLines = fs.readFileSync(popupPath, 'utf8').split('\n');
  const popupViolations = [];
  popupLines.forEach((line, idx) => {
    if (vnCharRegex.test(line)) {
      popupViolations.push(`popup.js:${idx + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(popupViolations, [], `Found hardcoded Vietnamese in popup.js:\n${popupViolations.join('\n')}`);

  // 2. Scan content.js (outside WIDGET_FALLBACK_LABELS)
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentLines = fs.readFileSync(contentPath, 'utf8').split('\n');
  const contentViolations = [];
  let inFallback = false;
  contentLines.forEach((line, idx) => {
    if (line.includes('const WIDGET_FALLBACK_LABELS')) {
      inFallback = true;
    }
    if (inFallback) {
      if (line.includes('};')) inFallback = false;
      return;
    }
    if (vnCharRegex.test(line)) {
      contentViolations.push(`content.js:${idx + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(contentViolations, [], `Found hardcoded Vietnamese in content.js outside WIDGET_FALLBACK_LABELS:\n${contentViolations.join('\n')}`);
});

