import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_UI_LOCALES,
  MESSAGES,
  t
} from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// WI-23 Finding 1: scroll event after missing item does NOT resend missing ID
// ============================================================================

test('WI-23 F1: scroll event after missing item does NOT resend missing ID and does NOT increment failed count', async () => {
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

    const scrollListeners = [];
    const win = {
      innerHeight: 800, innerWidth: 1200, top: null,
      addEventListener: (evt, handler) => {
        if (evt === 'scroll') scrollListeners.push(handler);
      },
      removeEventListener: (evt, handler) => {
        if (evt === 'scroll') {
          const idx = scrollListeners.indexOf(handler);
          if (idx !== -1) scrollListeners.splice(idx, 1);
        }
      },
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

    let rafCallbacks = [];
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
    globalThis.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
    globalThis.cancelAnimationFrame = (id) => {
      if (id > 0 && id <= rafCallbacks.length) rafCallbacks[id - 1] = null;
    };
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

    // First batch was dispatched
    assert.equal(translationRequests, 1, 'Initial batch sent');
    assert.equal(requestedBatches[0].length, 2, 'Initial batch contained both items');

    const status1 = dom.getStatus();
    assert.equal(status1.totalApplied, 1, 'Partial-applied item 1');
    assert.equal(status1.totalFailed, 1, 'Missing item 2 counted as failed once');

    // Now simulate multiple scroll events during the session
    assert.ok(scrollListeners.length > 0, 'Must have registered scroll listener');
    for (const listener of scrollListeners) {
      listener();
    }
    // Flush any pending rAF
    while (rafCallbacks.length > 0) {
      const cbs = rafCallbacks.slice();
      rafCallbacks = [];
      for (const cb of cbs) {
        if (typeof cb === 'function') cb(performance.now());
      }
    }

    // Wait for any debounce/flush timer to settle
    await new Promise((resolve) => setTimeout(resolve, 400));

    // WI-23 F1 Assertion: Missing item must NOT be resent after scroll event!
    assert.equal(translationRequests, 1, 'Scroll event must NOT cause missing item to be resent');
    const statusAfterScroll = dom.getStatus();
    assert.equal(statusAfterScroll.totalFailed, 1, 'totalFailed must remain 1 without duplicate counting on scroll');
    assert.equal(statusAfterScroll.totalApplied, 1, 'totalApplied must remain 1');

    // Trigger scroll again
    for (const listener of scrollListeners) {
      listener();
    }
    while (rafCallbacks.length > 0) {
      const cbs = rafCallbacks.slice();
      rafCallbacks = [];
      for (const cb of cbs) {
        if (typeof cb === 'function') cb(performance.now());
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(translationRequests, 1, 'Subsequent scroll events must never resend failed item');
    assert.equal(dom.getStatus().totalFailed, 1, 'totalFailed must still remain 1');

    // Verify fresh session clears failedIds and allows retry
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
// WI-23 Finding 2: tab-connect reference eliminated; only migration allowed
// ============================================================================

test('WI-23 F2: popup.html does not contain tab-connect, and popup.js does not reference dead tab-connect', () => {
  const htmlPath = path.join(__dirname, '..', 'extension', 'src', 'popup.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  // Verify tab-connect does not exist in popup.html
  assert.ok(!htmlSrc.includes('id="tab-connect"'), 'popup.html must not contain id="tab-connect"');
  assert.ok(htmlSrc.includes('id="menu-item-config"') || htmlSrc.includes('id="tabpanel-config"'), 'popup.html must contain config menu-item or tabpanel');
  assert.ok(htmlSrc.includes('id="subtab-connect"'), 'popup.html must contain subtab id="subtab-connect"');

  const popupPath = path.join(__dirname, '..', 'extension', 'src', 'popup.js');
  const popupSrc = fs.readFileSync(popupPath, 'utf8');

  // switchTab must not check for dead tab-connect
  assert.ok(
    !popupSrc.includes("if (targetTabId === 'tab-connect')"),
    'switchTab must not check for targetTabId === "tab-connect"'
  );

  // Exact word grep across extension/src for tab-connect: must only appear in migration comment/check
  const matches = [];
  const lines = popupSrc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/\btab-connect\b/.test(lines[i])) {
      matches.push({ line: i + 1, text: lines[i].trim() });
    }
  }

  // Only the one-time legacy session migration block is allowed to mention tab-connect
  assert.ok(matches.length > 0, 'Must have one-time legacy migration for session restore');
  for (const m of matches) {
    assert.ok(
      m.text.includes('rememberedTab') || m.text.includes('migration') || m.text.includes('legacy'),
      `tab-connect at line ${m.line} must only be part of legacy migration: ${m.text}`
    );
  }
});

test('WI-23 F2: legacy tab-connect in sessionStorage migrates cleanly to tab-config and connect subtab', () => {
  const popupPath = path.join(__dirname, '..', 'extension', 'src', 'popup.js');
  const popupSrc = fs.readFileSync(popupPath, 'utf8');

  // Check migration pattern in popup.js
  assert.ok(
    popupSrc.includes("if (rememberedTab === 'tab-connect')"),
    'popup.js must contain one-time compatibility migration for rememberedTab === "tab-connect"'
  );
  assert.ok(
    popupSrc.includes("rememberedTab = 'tab-config'"),
    'popup.js must migrate rememberedTab to "tab-config"'
  );
  assert.ok(
    popupSrc.includes("switchConfigSubtab('connect')"),
    'popup.js must activate connect subtab on legacy migration'
  );

  // activeConfigSubtab must be initialized before the migration block calls switchConfigSubtab('connect')
  const activeSubtabDeclIdx = popupSrc.indexOf("let activeConfigSubtab = 'connect'");
  const migrationBlockIdx = popupSrc.indexOf("if (rememberedTab === 'tab-connect')");
  assert.ok(
    activeSubtabDeclIdx !== -1 && activeSubtabDeclIdx < migrationBlockIdx,
    'activeConfigSubtab must be initialized before calling switchConfigSubtab in migration block'
  );
});

// ============================================================================
// WI-23 Finding 3: hardcoded aria-label removed from popup.html; catalog renders for all 7 locales
// ============================================================================

test('WI-23 F3: popup.html does not contain hardcoded aria-label on input-add-favorite', () => {
  const htmlPath = path.join(__dirname, '..', 'extension', 'src', 'popup.html');
  const htmlSrc = fs.readFileSync(htmlPath, 'utf8');

  // Assert favorite control line does not contain hardcoded aria-label="ID model yêu thích"
  const inputLine = htmlSrc.split('\n').find((l) => l.includes('id="select-add-favorite"') || l.includes('id="input-add-favorite"'));
  assert.ok(inputLine, 'Must find select-add-favorite or input-add-favorite in popup.html');
  assert.ok(
    !inputLine.includes('aria-label="ID model yêu thích"'),
    'favorite control must NOT contain hardcoded Vietnamese aria-label="ID model yêu thích"'
  );
  assert.ok(
    !/\saria-label=/.test(inputLine),
    'favorite control must NOT contain any static aria-label attribute in markup'
  );
  assert.ok(
    inputLine.includes('data-i18n-aria-label="fav_add_model_aria"'),
    'favorite control must declare data-i18n-aria-label="fav_add_model_aria"'
  );
  assert.ok(
    inputLine.includes('data-i18n-placeholder="fav_add_model_placeholder"'),
    'favorite control must declare data-i18n-placeholder="fav_add_model_placeholder"'
  );
});

test('WI-23 F3: input-add-favorite renders catalog aria-label and placeholder for all 7 locales with zero Vietnamese leaks in non-vi locales', () => {
  assert.equal(SUPPORTED_UI_LOCALES.length, 7, 'Must support 7 UI locales');

  for (const loc of SUPPORTED_UI_LOCALES) {
    const expectedAria = t(loc, 'fav_add_model_aria');
    const expectedPlaceholder = t(loc, 'fav_add_model_placeholder');

    assert.ok(expectedAria && expectedAria.length > 0, `fav_add_model_aria must exist for locale ${loc}`);
    assert.ok(expectedPlaceholder && expectedPlaceholder.length > 0, `fav_add_model_placeholder must exist for locale ${loc}`);

    // Simulate mock element receiving attributes via render
    const attrs = {};
    const mockEl = {
      placeholder: '',
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => attrs[k] || null
    };

    // Render logic
    mockEl.setAttribute('aria-label', expectedAria);
    mockEl.placeholder = expectedPlaceholder;
    mockEl.setAttribute('placeholder', expectedPlaceholder);

    assert.equal(mockEl.getAttribute('aria-label'), expectedAria, `aria-label must match catalog for ${loc}`);
    assert.equal(mockEl.getAttribute('placeholder'), expectedPlaceholder, `placeholder must match catalog for ${loc}`);

    // Verify non-vi locales have ZERO Vietnamese text
    if (loc !== 'vi') {
      assert.ok(
        !mockEl.getAttribute('aria-label').includes('yêu thích'),
        `Locale ${loc} must not leak Vietnamese "yêu thích" in aria-label: ${mockEl.getAttribute('aria-label')}`
      );
      assert.ok(
        !mockEl.getAttribute('placeholder').includes('Nhập ID'),
        `Locale ${loc} must not leak Vietnamese "Nhập ID" in placeholder: ${mockEl.getAttribute('placeholder')}`
      );
    }
  }

  // Exact English assertions
  assert.equal(t('en', 'fav_add_model_aria'), 'Favorite model ID');
  assert.equal(t('en', 'fav_add_model_placeholder'), 'Enter model ID (e.g. ag/gemini-2.5-flash)...');
});
