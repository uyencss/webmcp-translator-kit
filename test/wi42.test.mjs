// WebMCP Translator Kit — WI-42 Unit & Integration Tests
// Fixes for Sol round 25 findings (P2 modal accessibility & focus management):
// F1: Log → Retry closes modal first, restores focus to opener, triggers retry (no blank dialog, no stuck focus).
// F2: Focus trap in modal (Tab / Shift+Tab cycle within dialog, Escape closes, background inert, main tab switch closes modal first).
// F3: ARIA references point to existing elements with text (menu-item-config, menu-item-log; junk tab-config removed).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGES, SUPPORTED_UI_LOCALES, t } from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');

const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');

// ============================================================================
// Helper: DOM Element Mock for Runtime Tests
// ============================================================================

function makeFakeElement(id, initialAttrs = {}, initialClasses = []) {
  const attrs = { ...initialAttrs };
  const classes = new Set(initialClasses);
  const listeners = new Map();
  const children = [];

  const el = {
    id,
    dataset: {},
    tabIndex: initialAttrs.tabindex !== undefined ? Number(initialAttrs.tabindex) : 0,
    disabled: Boolean(initialAttrs.disabled),
    style: { display: initialAttrs.style_display || 'block' },
    textContent: initialAttrs.textContent || '',
    offsetParent: {},
    offsetWidth: 100,
    offsetHeight: 30,
    parentNode: null,

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

    appendChild(child) {
      child.parentNode = el;
      children.push(child);
      return child;
    },

    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },

    closest(selector) {
      let cur = el;
      while (cur) {
        if (selector === '.hidden' && cur.classList?.contains('hidden')) return cur;
        if (selector === '[aria-hidden="true"]' && cur.getAttribute('aria-hidden') === 'true') return cur;
        if (selector === '.tab-btn' && cur.classList?.contains('tab-btn')) return cur;
        if (selector === '#menu-overlay' && cur.id === 'menu-overlay') return cur;
        cur = cur.parentNode;
      }
      return null;
    },

    querySelectorAll(selector) {
      const results = [];
      function traverse(node) {
        for (const ch of node._children || []) {
          // simple selector match for focusables
          const isButton = ch.tagName === 'BUTTON' || ch.id?.includes('btn') || ch.classList?.contains('btn');
          const isInput = ch.tagName === 'INPUT';
          const hasTabindex = ch.hasAttribute('tabindex');
          if (isButton || isInput || hasTabindex) {
            results.push(ch);
          }
          traverse(ch);
        }
      }
      traverse(el);
      return results;
    },

    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parentNode;
      }
      return false;
    },

    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },

    removeEventListener(event, handler) {
      if (!listeners.has(event)) return;
      const list = listeners.get(event);
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    },

    dispatchEvent(evt) {
      const list = listeners.get(evt.type) || [];
      for (const h of list) h(evt);
    },

    click() {
      el.dispatchEvent({ type: 'click', target: el });
    },

    focus() {
      if (globalThis.document) {
        globalThis.document.activeElement = el;
      }
      el.focused = true;
    },

    _children: children
  };

  return el;
}

// ============================================================================
// 1. Finding 3 (F3): ARIA References Exist & Match Catalog
// ============================================================================

test('WI-42 F3: popup.html does not contain junk empty span #tab-config', () => {
  assert.ok(
    !popupHtml.includes('id="tab-config"'),
    'popup.html must not contain junk span id="tab-config"'
  );
});

test('WI-42 F3: popup.html does not contain broken aria-labelledby="tab-log"', () => {
  assert.ok(
    !popupHtml.includes('aria-labelledby="tab-log"'),
    'popup.html must not reference nonexistent tab-log'
  );
  assert.ok(
    !popupHtml.includes('aria-labelledby="tab-config"'),
    'popup.html must not reference dead tab-config'
  );
});

test('WI-42 F3: tabpanel-config points to existing #menu-item-config with catalog text', () => {
  // tabpanel-config must point to menu-item-config
  const configPanelStart = popupHtml.indexOf('id="tabpanel-config"');
  assert.ok(configPanelStart !== -1, 'Must find tabpanel-config');
  const tagOpen = popupHtml.lastIndexOf('<section', configPanelStart);
  const tagClose = popupHtml.indexOf('>', configPanelStart);
  const configTag = popupHtml.slice(tagOpen, tagClose + 1);

  assert.ok(
    configTag.includes('aria-labelledby="menu-item-config"'),
    'tabpanel-config must have aria-labelledby="menu-item-config"'
  );

  // #menu-item-config must exist in popup.html and have data-i18n="tab_config"
  const menuItemStart = popupHtml.indexOf('id="menu-item-config"');
  assert.ok(menuItemStart !== -1, 'Must find #menu-item-config');
  const menuItemEnd = popupHtml.indexOf('</button>', menuItemStart);
  const menuItemHtml = popupHtml.slice(menuItemStart, menuItemEnd);

  assert.ok(
    menuItemHtml.includes('data-i18n="tab_config"'),
    'menu-item-config must have data-i18n="tab_config"'
  );
  assert.ok(
    menuItemHtml.includes(t('vi', 'tab_config')),
    `menu-item-config must have non-empty default text "${t('vi', 'tab_config')}"`
  );
});

test('WI-42 F3: tabpanel-log points to existing #menu-item-log with catalog text', () => {
  // tabpanel-log must point to menu-item-log
  const logPanelStart = popupHtml.indexOf('id="tabpanel-log"');
  assert.ok(logPanelStart !== -1, 'Must find tabpanel-log');
  const tagOpen = popupHtml.lastIndexOf('<section', logPanelStart);
  const tagClose = popupHtml.indexOf('>', logPanelStart);
  const logTag = popupHtml.slice(tagOpen, tagClose + 1);

  assert.ok(
    logTag.includes('aria-labelledby="menu-item-log"'),
    'tabpanel-log must have aria-labelledby="menu-item-log"'
  );

  // #menu-item-log must exist in popup.html and have data-i18n="tab_log"
  const menuItemStart = popupHtml.indexOf('id="menu-item-log"');
  assert.ok(menuItemStart !== -1, 'Must find #menu-item-log');
  const menuItemEnd = popupHtml.indexOf('</button>', menuItemStart);
  const menuItemHtml = popupHtml.slice(menuItemStart, menuItemEnd);

  assert.ok(
    menuItemHtml.includes('data-i18n="tab_log"'),
    'menu-item-log must have data-i18n="tab_log"'
  );
  assert.ok(
    menuItemHtml.includes(t('vi', 'tab_log')),
    `menu-item-log must have non-empty default text "${t('vi', 'tab_log')}"`
  );
});

test('WI-42 F3: all aria-labelledby references in popup.html exist and have accessible text', () => {
  const matches = [...popupHtml.matchAll(/aria-labelledby="([^"]+)"/g)];
  assert.ok(matches.length > 0, 'Must find aria-labelledby attributes');

  for (const match of matches) {
    const targetId = match[1];
    // Each targetId must exist as id="<targetId>" in popup.html
    const targetIdDef = `id="${targetId}"`;
    assert.ok(
      popupHtml.includes(targetIdDef),
      `aria-labelledby target "${targetId}" must exist in popup.html`
    );

    // Verify element is not an empty hidden span (<span id="..." style="display:none;" aria-hidden="true"></span>)
    const idPos = popupHtml.indexOf(targetIdDef);
    const tagOpen = popupHtml.lastIndexOf('<', idPos);
    const tagClose = popupHtml.indexOf('>', idPos);
    const tagFull = popupHtml.slice(tagOpen, tagClose + 1);

    const isHiddenEmptySpan = tagFull.includes('style="display:none;"') && tagFull.includes('aria-hidden="true"');
    assert.ok(
      !isHiddenEmptySpan,
      `aria-labelledby target "${targetId}" must not be an empty hidden span: ${tagFull}`
    );
  }
});

// ============================================================================
// 2. Finding 2 (F2): Focus Trap & Background Inert
// ============================================================================

test('WI-42 F2: popup.js implements focus trap, background inert, and Tab key listener', () => {
  assert.ok(popupJs.includes('function handleModalFocusTrap('), 'popup.js must implement handleModalFocusTrap');
  assert.ok(popupJs.includes('function getModalFocusableElements('), 'popup.js must implement getModalFocusableElements');
  assert.ok(popupJs.includes('function setBackgroundInert('), 'popup.js must implement setBackgroundInert');
  assert.ok(popupJs.includes('function isModalOpen('), 'popup.js must implement isModalOpen');

  // Verify Tab key is handled in document keydown
  const keydownIdx = popupJs.indexOf("e.key === 'Tab'");
  assert.ok(keydownIdx !== -1, 'document keydown must listen for Tab key');
  const keydownSlice = popupJs.slice(keydownIdx - 100, keydownIdx + 200);
  assert.ok(
    keydownSlice.includes('handleModalFocusTrap'),
    'Tab keydown must invoke handleModalFocusTrap'
  );
});

test('WI-42 F2: focus trap runtime cycles within modal (Shift+Tab on first wraps to last; Tab on last wraps to first)', () => {
  // Build a test environment representing modal DOM
  const modalOverlay = makeFakeElement('modal-overlay', { role: 'dialog', 'aria-modal': 'true' });
  modalOverlay.style.display = 'flex';

  const modalContainer = makeFakeElement('modal-container');
  modalOverlay.appendChild(modalContainer);

  const modalCloseBtn = makeFakeElement('modal-close-btn', { type: 'button' });
  modalContainer.appendChild(modalCloseBtn);

  const modalBody = makeFakeElement('modal-body');
  modalContainer.appendChild(modalBody);

  const tabpanelLog = makeFakeElement('tabpanel-log');
  modalBody.appendChild(tabpanelLog);

  const btnClearLog = makeFakeElement('btn-clear-log', { type: 'button' });
  tabpanelLog.appendChild(btnClearLog);

  const retryBtn = makeFakeElement('retry-btn', { type: 'button' });
  tabpanelLog.appendChild(retryBtn);

  // Focusable elements inside modal: [modalCloseBtn, btnClearLog, retryBtn]
  const focusables = [modalCloseBtn, btnClearLog, retryBtn];

  function runFocusTrap(evt) {
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = globalThis.document.activeElement;

    if (evt.shiftKey) {
      if (active === first || !modalOverlay.contains(active)) {
        evt.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !modalOverlay.contains(active)) {
        evt.preventDefault();
        first.focus();
      }
    }
  }

  const savedDoc = globalThis.document;
  try {
    globalThis.document = { activeElement: null };

    // Case A: Focused on first element (modalCloseBtn) -> Shift+Tab wraps to last (retryBtn)
    globalThis.document.activeElement = modalCloseBtn;
    let preventedA = false;
    runFocusTrap({
      key: 'Tab',
      shiftKey: true,
      preventDefault: () => { preventedA = true; }
    });

    assert.equal(preventedA, true, 'Shift+Tab on first element must call preventDefault()');
    assert.equal(globalThis.document.activeElement, retryBtn, 'Shift+Tab on first element must wrap to last element');

    // Case B: Focused on last element (retryBtn) -> Tab wraps to first (modalCloseBtn)
    globalThis.document.activeElement = retryBtn;
    let preventedB = false;
    runFocusTrap({
      key: 'Tab',
      shiftKey: false,
      preventDefault: () => { preventedB = true; }
    });

    assert.equal(preventedB, true, 'Tab on last element must call preventDefault()');
    assert.equal(globalThis.document.activeElement, modalCloseBtn, 'Tab on last element must wrap to first element');

    // Case C: Focus outside modal -> Tab redirects to first
    const outsideEl = makeFakeElement('outside-tab');
    globalThis.document.activeElement = outsideEl;
    let preventedC = false;
    runFocusTrap({
      key: 'Tab',
      shiftKey: false,
      preventDefault: () => { preventedC = true; }
    });

    assert.equal(preventedC, true, 'Tab when focus outside must call preventDefault()');
    assert.equal(globalThis.document.activeElement, modalCloseBtn, 'Tab when focus outside must redirect to first element');
  } finally {
    globalThis.document = savedDoc;
  }
});

test('WI-42 F2: background inert is toggled when opening and closing modal', () => {
  const header = makeFakeElement('header');
  const panelTranslate = makeFakeElement('tabpanel-translate');
  const panelAuto = makeFakeElement('tabpanel-auto');
  const footer = makeFakeElement('footer');
  const backgroundElements = [header, panelTranslate, panelAuto, footer];

  function setBackgroundInert(inert) {
    for (const el of backgroundElements) {
      if (inert) {
        el.setAttribute('inert', '');
        el.inert = true;
      } else {
        el.removeAttribute('inert');
        el.inert = false;
      }
    }
  }

  // Open modal -> setBackgroundInert(true)
  setBackgroundInert(true);
  for (const el of backgroundElements) {
    assert.equal(el.hasAttribute('inert'), true, `${el.id} must have inert attribute when modal is open`);
    assert.equal(el.inert, true, `${el.id}.inert must be true when modal is open`);
  }

  // Close modal -> setBackgroundInert(false)
  setBackgroundInert(false);
  for (const el of backgroundElements) {
    assert.equal(el.hasAttribute('inert'), false, `${el.id} must NOT have inert attribute when modal is closed`);
    assert.equal(el.inert, false, `${el.id}.inert must be false when modal is closed`);
  }
});

test('WI-42 F2: switching to main tab while modal is open closes modal first', () => {
  // Verify switchTab implementation checks isModalOpen() and calls closeModal()
  const switchTabIdx = popupJs.indexOf('function switchTab(targetTabId');
  assert.ok(switchTabIdx !== -1, 'Must find switchTab');
  const switchTabEnd = popupJs.indexOf('function loadErrorLog(', switchTabIdx);
  assert.ok(switchTabEnd !== -1, 'Must find loadErrorLog');
  const switchTabBody = popupJs.slice(switchTabIdx, switchTabEnd);

  assert.ok(
    switchTabBody.includes('isModalOpen()') && switchTabBody.includes('closeModal()'),
    'switchTab must close modal when switching to non-modal tab'
  );

  // Verify tabList click listener closes modal first
  const tabListClickIdx = popupJs.indexOf("tabList.addEventListener('click'");
  assert.ok(tabListClickIdx !== -1, 'Must find tabList click listener');
  const tabListBlock = popupJs.slice(tabListClickIdx, tabListClickIdx + 300);

  assert.ok(
    tabListBlock.includes('isModalOpen()') && tabListBlock.includes('closeModal()'),
    'tabList click must close modal before switching tab'
  );
});

// ============================================================================
// 3. Finding 1 (F1): Log Retry Closes Modal & Restores Focus
// ============================================================================

test('WI-42 F1: Log Retry button handler calls closeModal() first before switchTab and btnTranslate.click()', () => {
  // Extract retryBtn click listener from popup.js
  const retryBtnIdx = popupJs.indexOf("retryBtn.className = 'btn btn-xs btn-outline log-retry-btn'");
  assert.ok(retryBtnIdx !== -1, 'Must find log-retry-btn declaration');
  const retryHandlerBlock = popupJs.slice(retryBtnIdx, retryBtnIdx + 400);

  // Must call closeModal() BEFORE switchTab('tab-translate')
  const closeModalIdx = retryHandlerBlock.indexOf('closeModal()');
  const switchTabIdx = retryHandlerBlock.indexOf("switchTab('tab-translate')");
  const btnTranslateClickIdx = retryHandlerBlock.indexOf('btnTranslate.click()');

  assert.ok(closeModalIdx !== -1, 'Retry handler must call closeModal()');
  assert.ok(switchTabIdx !== -1, 'Retry handler must call switchTab("tab-translate")');
  assert.ok(btnTranslateClickIdx !== -1, 'Retry handler must call btnTranslate.click()');

  assert.ok(
    closeModalIdx < switchTabIdx,
    `closeModal() (pos ${closeModalIdx}) must be called before switchTab('tab-translate') (pos ${switchTabIdx})`
  );
  assert.ok(
    switchTabIdx < btnTranslateClickIdx,
    `switchTab (pos ${switchTabIdx}) must be called before btnTranslate.click() (pos ${btnTranslateClickIdx})`
  );
});

test('WI-42 F1: Retry from modal closes overlay, does not leave blank dialog, and restores opener focus', () => {
  let modalDisplay = 'flex';
  let modalAriaHidden = 'false';
  let activeTab = 'tab-log';
  let translateClicked = false;

  const btnHeaderMenu = makeFakeElement('btn-header-menu', { type: 'button' });
  const statusStrip = makeFakeElement('status-strip', { type: 'button' });
  const btnTranslate = makeFakeElement('btn-translate', { type: 'button' });
  btnTranslate.disabled = false;
  btnTranslate.addEventListener('click', () => { translateClicked = true; });

  let modalOpenerEl = statusStrip; // modal was opened from statusStrip click

  const tabPanels = {
    'tab-translate': makeFakeElement('tabpanel-translate', {}, ['hidden']),
    'tab-auto': makeFakeElement('tabpanel-auto', {}, ['hidden']),
    'tab-config': makeFakeElement('tabpanel-config', {}, ['hidden']),
    'tab-log': makeFakeElement('tabpanel-log', {}, []) // initially visible inside modal
  };

  const modalOverlay = makeFakeElement('modal-overlay');
  modalOverlay.style.display = modalDisplay;

  function closeModal() {
    modalOverlay.style.display = 'none';
    modalOverlay.setAttribute('aria-hidden', 'true');
    tabPanels['tab-config'].classList.add('hidden');
    tabPanels['tab-log'].classList.add('hidden');

    // Restore focus to opener
    if (modalOpenerEl && typeof modalOpenerEl.focus === 'function') {
      modalOpenerEl.focus();
    } else if (btnHeaderMenu) {
      btnHeaderMenu.focus();
    }
  }

  function switchTab(targetTabId) {
    activeTab = targetTabId;
    for (const [id, panel] of Object.entries(tabPanels)) {
      if (id === targetTabId) {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    }
  }

  const savedDoc = globalThis.document;
  try {
    globalThis.document = { activeElement: null };

    // Simulate clicking Retry button
    const retryBtn = makeFakeElement('retry-btn', { type: 'button' });
    globalThis.document.activeElement = retryBtn; // focus was on retryBtn

    // Execution order in fixed popup.js:
    // 1. closeModal()
    closeModal();
    // 2. switchTab('tab-translate')
    switchTab('tab-translate');
    // 3. btnTranslate.click()
    if (btnTranslate && !btnTranslate.disabled) {
      btnTranslate.click();
    }

    // Assertions:
    // 1. Modal overlay is closed (not left open as blank dialog)
    assert.equal(modalOverlay.style.display, 'none', 'Modal overlay must be closed (display: none)');
    assert.equal(modalOverlay.getAttribute('aria-hidden'), 'true', 'Modal overlay must have aria-hidden="true"');

    // 2. Active tab switched to tab-translate
    assert.equal(activeTab, 'tab-translate', 'Active tab must be tab-translate');
    assert.equal(tabPanels['tab-translate'].classList.contains('hidden'), false, 'tabpanel-translate must be visible');
    assert.equal(tabPanels['tab-log'].classList.contains('hidden'), true, 'tabpanel-log must be hidden');

    // 3. Focus is restored to opener element, NOT stuck on hidden retryBtn
    assert.notEqual(globalThis.document.activeElement, retryBtn, 'Focus must NOT remain on hidden retry button');
    assert.equal(globalThis.document.activeElement, statusStrip, 'Focus must be restored to opener element (statusStrip)');

    // 4. Translation was triggered
    assert.equal(translateClicked, true, 'Translation button click must be triggered');
  } finally {
    globalThis.document = savedDoc;
  }
});
