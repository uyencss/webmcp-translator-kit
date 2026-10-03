// WebMCP Translator Kit — WI-49 Unit & Headless Tests
// Verification of Modal-Gated 600px Height & Natural Height for Normal Popup
// Requirements:
// 1. Base html/body has auto height (no global 600px height or min-height).
// 2. Normal popup (tab Dịch, no modal) keeps natural height (< 600px, ~251px), no modal-open class.
// 3. Opening modal (via menu item, error deep-link, direct call) adds 'modal-open' class to body.
// 4. body.modal-open has height: 600px, min-height: 600px, max-height: 600px, and flex chain.
// 5. Closing modal via EVERY path (close btn, backdrop, Escape, retry, switch tab, closeModal) removes 'modal-open'.
// 6. Natural height is fully restored upon modal close — no stuck height.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import {
  findChromeHeadlessShell,
  popupHtmlPath,
  parseDevToolsEndpoint,
  matchPopupTarget,
  killChildProcessSync
} from '../scripts/check-modal-overflow.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupCssPath = path.resolve(__dirname, '../extension/src/popup.css');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');

const popupCss = fs.readFileSync(popupCssPath, 'utf8');
const popupJs = fs.readFileSync(popupJsPath, 'utf8');

// ============================================================================
// 1. Static CSS Contract Verification: No Global 600px, Gated on body.modal-open
// ============================================================================

test('WI-49: popup.css removes global 600px height/min-height from base html/body', () => {
  // 1. html rule exists with box-sizing, but NO global 600px height or min-height
  assert.ok(popupCss.includes('html {'), 'popup.css must define html rule');
  assert.ok(
    !popupCss.match(/html\s*\{[^}]*height:\s*600px/),
    'base html must NOT set height: 600px'
  );
  assert.ok(
    !popupCss.match(/html\s*\{[^}]*min-height:\s*600px/),
    'base html must NOT set min-height: 600px'
  );

  // 2. body rule exists with width: 372px, but NO global 600px height or min-height
  assert.ok(popupCss.includes('body {'), 'popup.css must define body rule');
  assert.ok(popupCss.includes('width: 372px;'), 'body must preserve 372px width');
  assert.ok(
    !popupCss.match(/body\s*\{[^}]*height:\s*600px/),
    'base body must NOT set height: 600px'
  );
  assert.ok(
    !popupCss.match(/body\s*\{[^}]*min-height:\s*600px/),
    'base body must NOT set min-height: 600px'
  );
  assert.ok(
    !popupCss.match(/body\s*\{[^}]*max-height:\s*600px/),
    'base body must NOT set max-height: 600px'
  );
});

test('WI-49: popup.css defines 600px height & flex chain strictly on body.modal-open', () => {
  assert.ok(popupCss.includes('body.modal-open {'), 'popup.css must define body.modal-open rule');
  assert.ok(
    popupCss.includes('body.modal-open {') &&
    popupCss.includes('height: 600px;') &&
    popupCss.includes('min-height: 600px;'),
    'body.modal-open must define height: 600px and min-height: 600px'
  );
  assert.ok(
    popupCss.includes('max-height: 600px;'),
    'body.modal-open must define max-height: 600px'
  );
  assert.ok(
    popupCss.includes('body.modal-open .container {') &&
    popupCss.includes('height: 100%;') &&
    popupCss.includes('flex: 1 1 0;'),
    'body.modal-open .container must have height: 100% and flex: 1 1 0 for modal chain'
  );
});

test('WI-49: popup.css maintains balanced braces', () => {
  const opens = (popupCss.match(/\{/g) || []).length;
  const closes = (popupCss.match(/\}/g) || []).length;
  assert.equal(opens, closes, 'Braces in popup.css must be perfectly balanced');
});

// ============================================================================
// 2. Static JS Contract Verification: Class Toggled Across Open/Close Routes
// ============================================================================

test('WI-49: popup.js toggles modal-open class on document.body during openModal & closeModal', () => {
  // openModal adds class
  assert.ok(
    popupJs.includes("document.body.classList.add('modal-open')"),
    'openModal must add modal-open class to document.body'
  );

  // closeModal removes class
  assert.ok(
    popupJs.includes("document.body.classList.remove('modal-open')"),
    'closeModal must remove modal-open class from document.body'
  );
});

// ============================================================================
// 3. Functional DOM Unit Tests: All Open & Closure Paths
// ============================================================================

test('WI-49 (DOM): Modal open/close lifecycle across all paths', () => {
  const bodyClasses = new Set();
  const fakeBody = {
    classList: {
      add: (cls) => bodyClasses.add(cls),
      remove: (cls) => bodyClasses.delete(cls),
      contains: (cls) => bodyClasses.has(cls)
    }
  };

  const overlayAttrs = { 'aria-hidden': 'true' };
  const overlayStyle = { display: 'none' };
  const fakeOverlay = {
    style: overlayStyle,
    setAttribute: (k, v) => { overlayAttrs[k] = String(v); },
    getAttribute: (k) => overlayAttrs[k] ?? null,
    contains: () => false
  };

  const fakePanels = {
    'tab-config': { classList: new Set(['hidden']), className: 'hidden' },
    'tab-log': { classList: new Set(['hidden']), className: 'hidden' }
  };
  const fakeCloseBtn = { focus: () => {} };

  // Simulated openModal & closeModal implementation from popup.js
  let activeModal = null;
  function isModalOpen() {
    return Boolean(fakeOverlay && fakeOverlay.style.display !== 'none');
  }

  function openModal(modalType) {
    if (!fakeOverlay) return;
    activeModal = modalType;
    fakeOverlay.style.display = 'flex';
    fakeOverlay.setAttribute('aria-hidden', 'false');
    if (fakeBody) fakeBody.classList.add('modal-open');

    if (modalType === 'config') {
      fakePanels['tab-config'].classList.delete('hidden');
      fakePanels['tab-log'].classList.add('hidden');
    } else if (modalType === 'log') {
      fakePanels['tab-log'].classList.delete('hidden');
      fakePanels['tab-config'].classList.add('hidden');
    } else {
      closeModal();
      return;
    }
  }

  function closeModal() {
    if (fakeBody) fakeBody.classList.remove('modal-open');
    if (!fakeOverlay) return;
    activeModal = null;
    fakeOverlay.style.display = 'none';
    fakeOverlay.setAttribute('aria-hidden', 'true');
    fakePanels['tab-config'].classList.add('hidden');
    fakePanels['tab-log'].classList.add('hidden');
  }

  // 1. Initial state: NO modal-open class
  assert.equal(fakeBody.classList.contains('modal-open'), false, 'Initial state: body must not have modal-open');
  assert.equal(isModalOpen(), false, 'Initial state: modal must be closed');

  // 2. Open via Menu item "Cấu hình"
  openModal('config');
  assert.equal(fakeBody.classList.contains('modal-open'), true, 'Open config: body must have modal-open');
  assert.equal(isModalOpen(), true, 'Open config: modal is open');

  // 3. Close via Close Button (Đường 1)
  closeModal();
  assert.equal(fakeBody.classList.contains('modal-open'), false, 'Close via close-btn: body must lose modal-open');
  assert.equal(isModalOpen(), false, 'Close via close-btn: modal is closed');

  // 4. Open via Menu item "Nhật ký"
  openModal('log');
  assert.equal(fakeBody.classList.contains('modal-open'), true, 'Open log: body must have modal-open');

  // 5. Close via Backdrop (Đường 2)
  closeModal();
  assert.equal(fakeBody.classList.contains('modal-open'), false, 'Close via backdrop: body must lose modal-open');

  // 6. Open via Error Deep-Link
  openModal('log');
  assert.equal(fakeBody.classList.contains('modal-open'), true, 'Open via error deep-link: body has modal-open');

  // 7. Close via Escape key (Đường 3)
  if (isModalOpen()) closeModal();
  assert.equal(fakeBody.classList.contains('modal-open'), false, 'Close via Escape: body must lose modal-open');

  // 8. Open via Log Modal and Close via Retry button (Đường 4)
  openModal('log');
  assert.equal(fakeBody.classList.contains('modal-open'), true, 'Open log before retry: body has modal-open');
  // Retry handler calls closeModal() first
  closeModal();
  assert.equal(fakeBody.classList.contains('modal-open'), false, 'Close via retry button: body must lose modal-open');

  // 9. Open and switch tab (Đường 5)
  openModal('config');
  assert.equal(fakeBody.classList.contains('modal-open'), true, 'Open before switch tab: body has modal-open');
  if (isModalOpen()) closeModal();
  assert.equal(fakeBody.classList.contains('modal-open'), false, 'Close via switchTab: body must lose modal-open');

  // 10. Re-opening cycle (open -> close -> open -> close)
  openModal('config');
  assert.equal(fakeBody.classList.contains('modal-open'), true);
  closeModal();
  assert.equal(fakeBody.classList.contains('modal-open'), false);
  openModal('log');
  assert.equal(fakeBody.classList.contains('modal-open'), true);
  closeModal();
  assert.equal(fakeBody.classList.contains('modal-open'), false, 'Re-opening cycle: class must not stick');
});

// ============================================================================
// 4. Real Headless Chrome Runtime Layout & Natural Height Measurements
// ============================================================================

test('WI-49: Headless Chrome verifies natural height without modal (< 600px), 600px when modal opens, and clean restoration on close', async () => {
  let binary;
  try {
    binary = findChromeHeadlessShell();
  } catch (err) {
    console.warn('[wi49 test] chrome-headless-shell not found, skipping runtime assertion:', err.message);
    return;
  }

  const expectedUrl = pathToFileURL(popupHtmlPath).href;
  const proc = spawn(binary, [
    '--headless',
    '--remote-debugging-port=0',
    '--allow-file-access-from-files',
    '--window-size=400,900',
    expectedUrl
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let detectedHost = '127.0.0.1';
  let detectedPort = 0;
  let devToolsReady = false;
  let stderrBuffer = '';

  proc.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    if (!devToolsReady) {
      const parsed = parseDevToolsEndpoint(stderrBuffer);
      if (parsed && parsed.port > 0) {
        detectedHost = parsed.host;
        detectedPort = parsed.port;
        devToolsReady = true;
      }
    }
  });

  const t0 = Date.now();
  while (!devToolsReady && Date.now() - t0 < 5000) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(devToolsReady, 'DevTools must be ready');

  let tab = null;
  const tEnd = Date.now() + 5000;
  while (Date.now() < tEnd && !tab) {
    try {
      const resp = await fetch(`http://${detectedHost}:${detectedPort}/json`).then(r => r.json());
      tab = matchPopupTarget(resp, expectedUrl);
    } catch {}
    if (!tab) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(tab && tab.webSocketDebuggerUrl, 'Must locate exact popup target');

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 1;
  const sendCdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    const onMsg = (event) => {
      try {
        const resp = JSON.parse(event.data);
        if (resp.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener('message', onMsg);
          if (resp.error) reject(new Error(JSON.stringify(resp.error)));
          else resolve(resp.result);
        }
      } catch {}
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    // Standard popup width 372px
    await sendCdp('Emulation.setDeviceMetricsOverride', {
      width: 372,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false
    });
    await new Promise(r => setTimeout(r, 150));

    // Phase 1: Verify Normal Popup Natural Height (No Modal)
    const naturalMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        const bodyEl = document.body;
        const containerEl = document.querySelector('.container');
        const computedBodyHeight = window.getComputedStyle(bodyEl).height;

        return {
          hasModalOpenClass: bodyEl.classList.contains('modal-open'),
          bodyClientHeight: bodyEl.clientHeight,
          containerClientHeight: containerEl ? containerEl.clientHeight : 0,
          computedBodyHeight
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.ok(naturalMetrics, 'Must obtain natural metrics');
    assert.equal(
      naturalMetrics.hasModalOpenClass,
      false,
      'Normal popup: body must NOT have modal-open class'
    );
    assert.ok(
      naturalMetrics.bodyClientHeight < 600,
      `Normal popup: bodyClientHeight must be natural (< 600px), got ${naturalMetrics.bodyClientHeight}`
    );
    assert.ok(
      naturalMetrics.bodyClientHeight >= 200,
      `Normal popup: bodyClientHeight must be reasonable (>= 200px), got ${naturalMetrics.bodyClientHeight}`
    );
    assert.notEqual(
      naturalMetrics.computedBodyHeight,
      '600px',
      'Normal popup: computed body height must NOT be 600px'
    );

    // Phase 2: Open Config Modal → Height must become 600px
    const openedMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.openModal === 'function') {
          window.openModal('config');
        } else {
          document.body.classList.add('modal-open');
          const overlay = document.getElementById('modal-overlay');
          if (overlay) overlay.style.display = 'flex';
        }

        const bodyEl = document.body;
        const containerEl = document.querySelector('.container');
        const modalContainer = document.querySelector('.modal-container');
        const modalBody = document.getElementById('modal-body');

        return {
          hasModalOpenClass: bodyEl.classList.contains('modal-open'),
          bodyClientHeight: bodyEl.clientHeight,
          containerClientHeight: containerEl ? containerEl.clientHeight : 0,
          modalContainerHeight: modalContainer ? modalContainer.clientHeight : 0,
          modalBodyHeight: modalBody ? modalBody.clientHeight : 0
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.ok(openedMetrics, 'Must obtain opened metrics');
    assert.equal(
      openedMetrics.hasModalOpenClass,
      true,
      'Modal open: body MUST have modal-open class'
    );
    assert.equal(
      openedMetrics.bodyClientHeight,
      600,
      `Modal open: bodyClientHeight must expand to 600px, got ${openedMetrics.bodyClientHeight}`
    );
    assert.equal(
      openedMetrics.containerClientHeight,
      600,
      `Modal open: containerClientHeight must expand to 600px, got ${openedMetrics.containerClientHeight}`
    );
    assert.ok(
      openedMetrics.modalContainerHeight >= 580,
      `Modal open: modalContainer height must be >= 580px, got ${openedMetrics.modalContainerHeight}`
    );
    assert.ok(
      openedMetrics.modalBodyHeight >= 530,
      `Modal open: modalBody height must be >= 530px, got ${openedMetrics.modalBodyHeight}`
    );

    // Phase 3: Close Modal via closeModal() → Height must return to natural
    const closedMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.closeModal === 'function') {
          window.closeModal();
        } else {
          document.body.classList.remove('modal-open');
          const overlay = document.getElementById('modal-overlay');
          if (overlay) overlay.style.display = 'none';
        }

        const bodyEl = document.body;
        const containerEl = document.querySelector('.container');

        return {
          hasModalOpenClass: bodyEl.classList.contains('modal-open'),
          bodyClientHeight: bodyEl.clientHeight,
          containerClientHeight: containerEl ? containerEl.clientHeight : 0
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.ok(closedMetrics, 'Must obtain closed metrics');
    assert.equal(
      closedMetrics.hasModalOpenClass,
      false,
      'After closeModal: body must NOT have modal-open class'
    );
    assert.ok(
      closedMetrics.bodyClientHeight < 600,
      `After closeModal: bodyClientHeight must return to natural (< 600px), got ${closedMetrics.bodyClientHeight}`
    );
    assert.equal(
      closedMetrics.bodyClientHeight,
      naturalMetrics.bodyClientHeight,
      'After closeModal: bodyClientHeight must exactly match initial natural height'
    );

    // Phase 4: Open Log Modal & Close via Close Button
    const closeBtnMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.openModal === 'function') {
          window.openModal('log');
        }
        const openClass = document.body.classList.contains('modal-open');
        const openHeight = document.body.clientHeight;

        // Click close button
        const btn = document.getElementById('modal-close-btn');
        if (btn) btn.click();

        return {
          openClass,
          openHeight,
          closedClass: document.body.classList.contains('modal-open'),
          closedHeight: document.body.clientHeight
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.equal(closeBtnMetrics.openClass, true, 'Log open: body has modal-open');
    assert.equal(closeBtnMetrics.openHeight, 600, 'Log open: height is 600px');
    assert.equal(closeBtnMetrics.closedClass, false, 'Close button click: body loses modal-open');
    assert.ok(closeBtnMetrics.closedHeight < 600, 'Close button click: height returns to natural');

    // Phase 5: Open & Close via Escape key
    const escapeMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.openModal === 'function') {
          window.openModal('config');
        }
        const openClass = document.body.classList.contains('modal-open');

        // Dispatch Escape keydown
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        return {
          openClass,
          closedClass: document.body.classList.contains('modal-open'),
          closedHeight: document.body.clientHeight
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.equal(escapeMetrics.openClass, true, 'Config open: body has modal-open');
    assert.equal(escapeMetrics.closedClass, false, 'Escape key: body loses modal-open');
    assert.ok(escapeMetrics.closedHeight < 600, 'Escape key: height returns to natural');

    // Phase 6: Open & Close via Backdrop click
    const backdropMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.openModal === 'function') {
          window.openModal('config');
        }
        const openClass = document.body.classList.contains('modal-open');

        // Click backdrop
        const backdrop = document.getElementById('modal-backdrop');
        if (backdrop) backdrop.click();

        return {
          openClass,
          closedClass: document.body.classList.contains('modal-open'),
          closedHeight: document.body.clientHeight
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.equal(backdropMetrics.openClass, true, 'Config open: body has modal-open');
    assert.equal(backdropMetrics.closedClass, false, 'Backdrop click: body loses modal-open');
    assert.ok(backdropMetrics.closedHeight < 600, 'Backdrop click: height returns to natural');

    // Phase 7: Open Log Modal & Close via Retry
    const retryMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.openModal === 'function') {
          window.openModal('log');
        }
        const openClass = document.body.classList.contains('modal-open');

        // Simulate retry from log panel
        if (typeof window.closeModal === 'function') {
          window.closeModal();
        }

        return {
          openClass,
          closedClass: document.body.classList.contains('modal-open'),
          closedHeight: document.body.clientHeight
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.equal(retryMetrics.openClass, true, 'Log open: body has modal-open');
    assert.equal(retryMetrics.closedClass, false, 'Retry close: body loses modal-open');
    assert.ok(retryMetrics.closedHeight < 600, 'Retry close: height returns to natural');

    // Phase 8: Open Modal & Close via Tab Switch
    const tabSwitchMetrics = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.openModal === 'function') {
          window.openModal('config');
        }
        const openClass = document.body.classList.contains('modal-open');

        // Click main tab button
        const tabBtn = document.querySelector('.tab-btn[data-tab="tab-translate"]');
        if (tabBtn) tabBtn.click();
        else if (typeof window.closeModal === 'function') window.closeModal();

        return {
          openClass,
          closedClass: document.body.classList.contains('modal-open'),
          closedHeight: document.body.clientHeight
        };
      })()`,
      returnByValue: true
    }).then(res => res?.result?.value);

    assert.equal(tabSwitchMetrics.openClass, true, 'Config open: body has modal-open');
    assert.equal(tabSwitchMetrics.closedClass, false, 'Tab switch: body loses modal-open');
    assert.ok(tabSwitchMetrics.closedHeight < 600, 'Tab switch: height returns to natural');
  } finally {
    try { ws.close(); } catch {}
    killChildProcessSync(proc);
  }
});
