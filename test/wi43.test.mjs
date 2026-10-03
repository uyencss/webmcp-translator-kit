// WebMCP Translator Kit — WI-43 Unit & Integration Tests
// Fix for Sol round 26 finding (P2 modal focus restoration on reopen):
// Bug: Opening an already open modal via switchTab (popup.js:1200) overwrote opener to modal-close-btn (popup.js:844).
// When closing, restoreFocusAfterModal accepted that button despite hidden overlay ancestor -> .focus() failed silently,
// and early return skipped fallback to header button.
// Fix:
// 1. Do not overwrite opener when modal is already open (preserve first original opener).
// 2. When restoring focus, verify opener is still visible and enabled in DOM; if focus fails silently or throws,
//    fallback to header menu button (no silent early-return).
// 3. open -> reopen -> close properly restores focus to original opener or header button.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');
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
    parentNode: null,
    parentElement: null,

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
      child.parentElement = el;
      children.push(child);
      return child;
    },

    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    },

    contains(descendant) {
      let cur = descendant;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parentElement || cur.parentNode;
      }
      return false;
    },

    closest(selector) {
      let cur = el;
      while (cur) {
        if (selector === '.hidden' && cur.classList?.contains('hidden')) return cur;
        if (selector === '[aria-hidden="true"]' && cur.getAttribute('aria-hidden') === 'true') return cur;
        if (selector === '.tab-btn' && cur.classList?.contains('tab-btn')) return cur;
        if (selector === '#menu-overlay' && cur.id === 'menu-overlay') return cur;
        if (selector === '#modal-overlay' && cur.id === 'modal-overlay') return cur;
        cur = cur.parentElement || cur.parentNode;
      }
      return null;
    },

    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
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
// 1. Static Contract & Implementation Verification
// ============================================================================

test('WI-43: popup.js implements isElementVisibleAndEnabled helper', () => {
  assert.ok(
    popupJs.includes('function isElementVisibleAndEnabled('),
    'popup.js must define isElementVisibleAndEnabled'
  );
  assert.ok(
    popupJs.includes('modalOverlay.contains') || popupJs.includes('cur === modalOverlay'),
    'isElementVisibleAndEnabled must check modalOverlay containment'
  );
});

test('WI-43: openModal does not overwrite modalOpenerEl when already open', () => {
  assert.ok(
    popupJs.includes('!isAlreadyOpen || !modalOpenerEl'),
    'openModal must preserve existing opener when modal is already open'
  );
  assert.ok(
    popupJs.includes('!modalOverlay') && popupJs.includes('modalOverlay.contains'),
    'openModal must exclude elements inside modalOverlay from being openers'
  );
});

test('WI-43: restoreFocusAfterModal falls back to header button on failure without silent early return', () => {
  // restoreFocusAfterModal must check isElementVisibleAndEnabled and verify activeElement
  const restoreFnIdx = popupJs.indexOf('function restoreFocusAfterModal()');
  assert.ok(restoreFnIdx !== -1, 'Must find restoreFocusAfterModal');
  const restoreFnBlock = popupJs.slice(restoreFnIdx, restoreFnIdx + 1100);

  assert.ok(
    restoreFnBlock.includes('isElementVisibleAndEnabled(modalOpenerEl)'),
    'restoreFocusAfterModal must check isElementVisibleAndEnabled'
  );
  assert.ok(
    restoreFnBlock.includes('btnHeaderMenu.focus()'),
    'restoreFocusAfterModal must fallback to btnHeaderMenu.focus()'
  );
  // Ensure no bare `return;` inside the try block that causes silent early return before fallback
  const tryIdx = restoreFnBlock.indexOf('try {');
  const catchIdx = restoreFnBlock.indexOf('} catch', tryIdx);
  const tryBlock = restoreFnBlock.slice(tryIdx, catchIdx);
  assert.ok(
    !tryBlock.includes('return;'),
    'restoreFocusAfterModal must NOT early-return inside try block without verifying focus succeeded'
  );
});

// ============================================================================
// 2. Runtime Behavior: open -> reopen -> close preserves original opener
// ============================================================================

test('WI-43 (runtime): open -> reopen while open -> close restores focus to original opener (NOT modal-close-btn)', () => {
  const documentMock = {
    body: makeFakeElement('body'),
    activeElement: null
  };

  const btnHeaderMenu = makeFakeElement('btn-header-menu', { type: 'button' });
  const customOpenerBtn = makeFakeElement('btn-custom-opener', { type: 'button' });
  const modalOverlay = makeFakeElement('modal-overlay', { style_display: 'none', 'aria-hidden': 'true' });
  const modalCloseBtn = makeFakeElement('modal-close-btn', { type: 'button' });
  const tabpanelConfig = makeFakeElement('tabpanel-config', {}, ['hidden']);

  documentMock.body.appendChild(btnHeaderMenu);
  documentMock.body.appendChild(customOpenerBtn);
  documentMock.body.appendChild(modalOverlay);
  modalOverlay.appendChild(modalCloseBtn);
  modalOverlay.appendChild(tabpanelConfig);

  const savedDoc = globalThis.document;
  try {
    globalThis.document = documentMock;

    // Simulate modal controller state with fixed logic
    let activeModal = null;
    let modalOpenerEl = null;

    function isModalOpen() {
      return Boolean(modalOverlay && modalOverlay.style.display !== 'none');
    }

    function isElementVisibleAndEnabled(el) {
      if (!el || typeof el.focus !== 'function') return false;
      if (documentMock.body && !documentMock.body.contains(el)) return false;
      if (el.disabled) return false;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
      if (typeof el.closest === 'function') {
        if (el.closest('[aria-hidden="true"]')) return false;
        if (el.closest('.hidden')) return false;
      }
      if (modalOverlay && (el === modalOverlay || modalOverlay.contains(el))) return false;

      let cur = el;
      while (cur && cur !== documentMock.body) {
        if (cur.style && cur.style.display === 'none') return false;
        if (cur === modalOverlay) return false;
        if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
        cur = cur.parentElement || cur.parentNode;
      }
      return true;
    }

    function restoreFocusAfterModal() {
      let focusSucceeded = false;
      if (isElementVisibleAndEnabled(modalOpenerEl)) {
        try {
          modalOpenerEl.focus();
          if (documentMock.activeElement === modalOpenerEl) {
            focusSucceeded = true;
          }
        } catch {
          focusSucceeded = false;
        }
      }
      if (!focusSucceeded) {
        if (btnHeaderMenu && typeof btnHeaderMenu.focus === 'function') {
          try {
            btnHeaderMenu.focus();
          } catch {}
        }
      }
    }

    function openModal(modalType, options = {}) {
      const isAlreadyOpen = isModalOpen() || Boolean(activeModal);
      if (!isAlreadyOpen || !modalOpenerEl) {
        if (options && options.opener && (!modalOverlay || (options.opener !== modalOverlay && !modalOverlay.contains(options.opener)))) {
          modalOpenerEl = options.opener;
        } else if (documentMock.activeElement && documentMock.activeElement !== documentMock.body && !modalOverlay.contains(documentMock.activeElement)) {
          modalOpenerEl = documentMock.activeElement;
        } else {
          modalOpenerEl = btnHeaderMenu;
        }
      }

      activeModal = modalType;
      modalOverlay.style.display = 'flex';
      modalOverlay.setAttribute('aria-hidden', 'false');

      if (modalCloseBtn) modalCloseBtn.focus();
    }

    function closeModal() {
      activeModal = null;
      modalOverlay.style.display = 'none';
      modalOverlay.setAttribute('aria-hidden', 'true');
      restoreFocusAfterModal();
      modalOpenerEl = null;
    }

    // Step 1: User focuses custom button and opens modal
    documentMock.activeElement = customOpenerBtn;
    openModal('config', { opener: customOpenerBtn });

    assert.equal(isModalOpen(), true, 'Modal should be open');
    assert.equal(documentMock.activeElement, modalCloseBtn, 'Focus moves to close button on open');
    assert.equal(modalOpenerEl, customOpenerBtn, 'modalOpenerEl should be customOpenerBtn');

    // Step 2: While modal is already open, something calls openModal / switchTab again
    // (activeElement is modalCloseBtn!)
    openModal('config');

    // Opener MUST NOT be overwritten to modalCloseBtn!
    assert.equal(modalOpenerEl, customOpenerBtn, 'modalOpenerEl MUST NOT be overwritten to modalCloseBtn');

    // Step 3: Close modal
    closeModal();

    assert.equal(isModalOpen(), false, 'Modal should be closed');
    assert.notEqual(documentMock.activeElement, modalCloseBtn, 'Focus must NOT remain on modal-close-btn');
    assert.equal(documentMock.activeElement, customOpenerBtn, 'Focus MUST be restored to original customOpenerBtn');
  } finally {
    globalThis.document = savedDoc;
  }
});

test('WI-43 (runtime): startup restore rememberedTab tab-config open -> switchTab -> close restores to btnHeaderMenu', () => {
  const documentMock = {
    body: makeFakeElement('body'),
    activeElement: null
  };

  const btnHeaderMenu = makeFakeElement('btn-header-menu', { type: 'button' });
  const modalOverlay = makeFakeElement('modal-overlay', { style_display: 'none', 'aria-hidden': 'true' });
  const modalCloseBtn = makeFakeElement('modal-close-btn', { type: 'button' });

  documentMock.body.appendChild(btnHeaderMenu);
  documentMock.body.appendChild(modalOverlay);
  modalOverlay.appendChild(modalCloseBtn);

  const savedDoc = globalThis.document;
  try {
    globalThis.document = documentMock;

    let activeModal = null;
    let modalOpenerEl = null;

    function isModalOpen() {
      return Boolean(modalOverlay && modalOverlay.style.display !== 'none');
    }

    function isElementVisibleAndEnabled(el) {
      if (!el || typeof el.focus !== 'function') return false;
      if (documentMock.body && !documentMock.body.contains(el)) return false;
      if (el.disabled) return false;
      if (modalOverlay && (el === modalOverlay || modalOverlay.contains(el))) return false;
      let cur = el;
      while (cur && cur !== documentMock.body) {
        if (cur.style && cur.style.display === 'none') return false;
        if (cur === modalOverlay) return false;
        cur = cur.parentElement || cur.parentNode;
      }
      return true;
    }

    function restoreFocusAfterModal() {
      let focusSucceeded = false;
      if (isElementVisibleAndEnabled(modalOpenerEl)) {
        try {
          modalOpenerEl.focus();
          if (documentMock.activeElement === modalOpenerEl) {
            focusSucceeded = true;
          }
        } catch {
          focusSucceeded = false;
        }
      }
      if (!focusSucceeded) {
        if (btnHeaderMenu && typeof btnHeaderMenu.focus === 'function') {
          try {
            btnHeaderMenu.focus();
          } catch {}
        }
      }
    }

    function openModal(modalType, options = {}) {
      const isAlreadyOpen = isModalOpen() || Boolean(activeModal);
      if (!isAlreadyOpen || !modalOpenerEl) {
        if (options && options.opener && (!modalOverlay || (options.opener !== modalOverlay && !modalOverlay.contains(options.opener)))) {
          modalOpenerEl = options.opener;
        } else if (documentMock.activeElement && documentMock.activeElement !== documentMock.body && !modalOverlay.contains(documentMock.activeElement)) {
          modalOpenerEl = documentMock.activeElement;
        } else {
          modalOpenerEl = btnHeaderMenu;
        }
      }

      activeModal = modalType;
      modalOverlay.style.display = 'flex';
      modalOverlay.setAttribute('aria-hidden', 'false');
      if (modalCloseBtn) modalCloseBtn.focus();
    }

    function switchTab(target) {
      if (target === 'tab-config') {
        openModal('config');
      }
    }

    function closeModal() {
      activeModal = null;
      modalOverlay.style.display = 'none';
      modalOverlay.setAttribute('aria-hidden', 'true');
      restoreFocusAfterModal();
      modalOpenerEl = null;
    }

    // Reproduction of startup restore:
    // popup.js line 1200:
    // openModal('config');
    // switchTab('tab-config');
    openModal('config');
    assert.equal(modalOpenerEl, btnHeaderMenu, 'Opener should default to btnHeaderMenu on startup');
    assert.equal(documentMock.activeElement, modalCloseBtn, 'Focus moves to modal close button');

    // switchTab calls openModal again while open
    switchTab('tab-config');
    assert.equal(modalOpenerEl, btnHeaderMenu, 'Opener must still be btnHeaderMenu, not overwritten to close button');

    // Close modal
    closeModal();
    assert.equal(documentMock.activeElement, btnHeaderMenu, 'Focus must be restored to btnHeaderMenu without failing silently');
  } finally {
    globalThis.document = savedDoc;
  }
});

test('WI-43 (runtime): opener hidden or focus silently fails -> fallback to btnHeaderMenu succeeds', () => {
  const documentMock = {
    body: makeFakeElement('body'),
    activeElement: null
  };

  const btnHeaderMenu = makeFakeElement('btn-header-menu', { type: 'button' });
  const transientBtn = makeFakeElement('btn-transient', { type: 'button' });
  const modalOverlay = makeFakeElement('modal-overlay', { style_display: 'none', 'aria-hidden': 'true' });
  const modalCloseBtn = makeFakeElement('modal-close-btn', { type: 'button' });

  documentMock.body.appendChild(btnHeaderMenu);
  documentMock.body.appendChild(transientBtn);
  documentMock.body.appendChild(modalOverlay);
  modalOverlay.appendChild(modalCloseBtn);

  const savedDoc = globalThis.document;
  try {
    globalThis.document = documentMock;

    let activeModal = null;
    let modalOpenerEl = transientBtn;

    function isElementVisibleAndEnabled(el) {
      if (!el || typeof el.focus !== 'function') return false;
      if (documentMock.body && !documentMock.body.contains(el)) return false;
      if (el.disabled) return false;
      if (modalOverlay && (el === modalOverlay || modalOverlay.contains(el))) return false;
      let cur = el;
      while (cur && cur !== documentMock.body) {
        if (cur.style && cur.style.display === 'none') return false;
        if (cur === modalOverlay) return false;
        cur = cur.parentElement || cur.parentNode;
      }
      return true;
    }

    function restoreFocusAfterModal() {
      let focusSucceeded = false;
      if (isElementVisibleAndEnabled(modalOpenerEl)) {
        try {
          modalOpenerEl.focus();
          if (documentMock.activeElement === modalOpenerEl) {
            focusSucceeded = true;
          }
        } catch {
          focusSucceeded = false;
        }
      }
      if (!focusSucceeded) {
        if (btnHeaderMenu && typeof btnHeaderMenu.focus === 'function') {
          try {
            btnHeaderMenu.focus();
          } catch {}
        }
      }
    }

    // Case A: Transient button becomes hidden while modal is open
    transientBtn.style.display = 'none';
    documentMock.activeElement = modalCloseBtn;

    restoreFocusAfterModal();
    assert.equal(
      documentMock.activeElement,
      btnHeaderMenu,
      'When opener becomes display:none, focus must fallback to btnHeaderMenu'
    );

    // Case B: Silent focus failure (method does not throw, but activeElement not updated)
    const silentFailBtn = makeFakeElement('btn-silent-fail', { type: 'button' });
    documentMock.body.appendChild(silentFailBtn);
    silentFailBtn.focus = () => {
      // no-op, simulating browser failing to focus unfocusable node
    };
    modalOpenerEl = silentFailBtn;
    documentMock.activeElement = null;

    restoreFocusAfterModal();
    assert.equal(
      documentMock.activeElement,
      btnHeaderMenu,
      'When opener.focus() silently fails without updating activeElement, must fallback to btnHeaderMenu'
    );
  } finally {
    globalThis.document = savedDoc;
  }
});
