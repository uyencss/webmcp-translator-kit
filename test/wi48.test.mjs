// WebMCP Translator Kit — WI-48 Unit & Headless Tests
// Verification of Config Modal Full-Height Flex Chain & Sticky Subtabs
// Requirements:
// 1. html/body/container/modal full-height flex chain (~600px Chrome popup limit)
// 2. .modal-body takes remaining height with overflow-y: auto
// 3. Header + Subtab fixed during body scrolling
// 4. Width strictly 372px preserved across 2 themes (dark & light)

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
const popupCss = fs.readFileSync(popupCssPath, 'utf8');

// ============================================================================
// 1. Static CSS Contract Verification: Full-Height Flex Chain & Sticky Subtab
// ============================================================================

test('WI-48: popup.css defines full-height flex chain on html, body, and container', () => {
  // 1. html base has box-sizing and no global 600px height
  assert.ok(popupCss.includes('html {'), 'popup.css must define html rule');
  assert.ok(
    !popupCss.match(/html\s*\{[^}]*height:\s*600px/),
    'base html must not set 600px height globally (WI-49)'
  );

  // 2. body width 372px and 600px flex chain gated on body.modal-open
  assert.ok(popupCss.includes('body {'), 'popup.css must define body rule');
  assert.ok(popupCss.includes('width: 372px;'), 'body must preserve 372px width');
  assert.ok(
    !popupCss.match(/body\s*\{[^}]*height:\s*600px/),
    'base body must not set 600px height globally (WI-49)'
  );
  assert.ok(
    popupCss.includes('body.modal-open {') && popupCss.includes('height: 600px;') && popupCss.includes('min-height: 600px;'),
    'body.modal-open must define 600px height and min-height'
  );

  // 3. .container flex fill
  assert.ok(popupCss.includes('.container {'), 'popup.css must define .container');
  assert.ok(
    popupCss.includes('height: 100%;') && (popupCss.includes('flex: 1 1 0') || popupCss.includes('flex: 1')),
    '.container must have height: 100% and flex: 1'
  );

  // 4. .footer pinned to bottom
  assert.ok(popupCss.includes('margin-top: auto;'), '.footer must have margin-top: auto');
});

test('WI-48: popup.css defines full-height modal container, compact header, and expanded body', () => {
  // 1. .modal-overlay
  assert.ok(popupCss.includes('.modal-overlay {'), 'popup.css must define .modal-overlay');
  assert.ok(
    popupCss.includes('position: fixed;') && popupCss.includes('inset: 0;') && popupCss.includes('height: 100%;'),
    '.modal-overlay must be fixed full-screen/inset:0'
  );

  // 2. .modal-container tight insets and height
  assert.ok(popupCss.includes('.modal-container {'), 'popup.css must define .modal-container');
  assert.ok(
    popupCss.includes('inset: 6px 8px;') || popupCss.includes('inset: 6px;') || popupCss.includes('inset: 8px;'),
    '.modal-container must have compact insets (<= 8px)'
  );
  assert.ok(
    popupCss.includes('height: calc(100% - 12px);') || popupCss.includes('height: calc(100% - 16px);') || popupCss.includes('flex: 1'),
    '.modal-container must take full height minus insets'
  );

  // 3. .modal-header compact and non-shrinking
  assert.ok(popupCss.includes('.modal-header {'), 'popup.css must define .modal-header');
  assert.ok(popupCss.includes('flex-shrink: 0;'), '.modal-header must have flex-shrink: 0');

  // 4. .modal-body takes remaining height with internal scrolling
  assert.ok(popupCss.includes('.modal-body {'), 'popup.css must define .modal-body');
  assert.ok(
    popupCss.includes('flex: 1 1 0') || popupCss.includes('flex: 1;'),
    '.modal-body must have flex: 1 to occupy all remaining vertical space'
  );
  assert.ok(popupCss.includes('overflow-y: auto;'), '.modal-body must have overflow-y: auto');
  assert.ok(popupCss.includes('overflow-x: hidden;'), '.modal-body must have overflow-x: hidden');
});

test('WI-48: popup.css defines sticky subtab navigation for fixed header + subtab', () => {
  assert.ok(popupCss.includes('.subtab-nav {'), 'popup.css must define .subtab-nav');
  assert.ok(popupCss.includes('position: sticky;'), '.subtab-nav must be position: sticky');
  assert.ok(popupCss.includes('top: 0;'), '.subtab-nav must have top: 0');
  assert.ok(popupCss.includes('z-index: 20;'), '.subtab-nav must have elevated z-index');
  assert.ok(popupCss.includes('flex-shrink: 0;'), '.subtab-nav must have flex-shrink: 0');

  // Light theme overrides
  assert.ok(popupCss.includes('[data-theme="light"] .subtab-nav'), 'must have light theme override for .subtab-nav');
});

test('WI-48: popup.css maintains balanced braces', () => {
  const opens = (popupCss.match(/\{/g) || []).length;
  const closes = (popupCss.match(/\}/g) || []).length;
  assert.equal(opens, closes, 'Braces in popup.css must be perfectly balanced');
});

// ============================================================================
// 2. Real Headless Chrome Runtime Layout & Scroll Measurements
// ============================================================================

test('WI-48: Headless Chrome verifies full-height modal (>= 580px) and fixed header/subtab during scrolling', async () => {
  let binary;
  try {
    binary = findChromeHeadlessShell();
  } catch (err) {
    console.warn('[wi48 test] chrome-headless-shell not found, skipping runtime CDP assertion:', err.message);
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
    // 372x600 viewport
    await sendCdp('Emulation.setDeviceMetricsOverride', {
      width: 372,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false
    });
    await new Promise(r => setTimeout(r, 100));

    // Evaluate modal height & fixed header/subtab behavior
    const evalResult = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof window.openModal === 'function') {
          try { window.openModal('config'); } catch (_) {}
        }
        document.body.classList.add('modal-open');
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
          overlay.style.display = 'flex';
          overlay.removeAttribute('aria-hidden');
        }
        const cfg = document.getElementById('tabpanel-config');
        if (cfg) {
          cfg.classList.remove('hidden');
        }
        document.querySelectorAll('.config-subpanel').forEach(p => p.classList.remove('hidden'));

        const htmlEl = document.documentElement;
        const bodyEl = document.body;
        const containerEl = document.querySelector('.container');
        const modalContainer = document.querySelector('.modal-container');
        const modalHeader = document.querySelector('.modal-header');
        const modalBody = document.getElementById('modal-body');
        const subtabNav = document.querySelector('.subtab-nav');

        const initialHeaderTop = modalHeader.getBoundingClientRect().top;
        const initialSubtabTop = subtabNav.getBoundingClientRect().top;

        // Scroll modal body by 180px
        modalBody.scrollTop = 180;
        const scrolledHeaderTop = modalHeader.getBoundingClientRect().top;
        const scrolledSubtabTop = subtabNav.getBoundingClientRect().top;

        return {
          htmlHeight: htmlEl.clientHeight,
          bodyHeight: bodyEl.clientHeight,
          containerHeight: containerEl.clientHeight,
          modalContainerHeight: modalContainer.clientHeight,
          modalBodyHeight: modalBody.clientHeight,
          initialHeaderTop,
          scrolledHeaderTop,
          initialSubtabTop,
          scrolledSubtabTop,
          bodyScrollTop: modalBody.scrollTop
        };
      })()`,
      returnByValue: true
    });

    const metrics = evalResult?.result?.value;
    assert.ok(metrics, 'Evaluation must return metrics');

    // 1. Viewport / Chain full-height verification
    assert.equal(metrics.htmlHeight, 600, 'HTML clientHeight must be 600px');
    assert.equal(metrics.bodyHeight, 600, 'Body clientHeight must be 600px');
    assert.equal(metrics.containerHeight, 600, 'Container clientHeight must be 600px');

    // 2. Modal height expanded: >= 580px (maximally filling popup)
    assert.ok(
      metrics.modalContainerHeight >= 580,
      `Modal container height must be >= 580px, got ${metrics.modalContainerHeight}`
    );

    // 3. Modal body expanded: >= 530px
    assert.ok(
      metrics.modalBodyHeight >= 530,
      `Modal body height must be >= 530px, got ${metrics.modalBodyHeight}`
    );

    // 4. Header remains completely fixed during body scrolling
    assert.equal(
      metrics.initialHeaderTop,
      metrics.scrolledHeaderTop,
      'Modal header position must not change when modal-body is scrolled'
    );

    // 5. Subtab remains fixed at top during body scrolling
    assert.equal(
      metrics.initialSubtabTop,
      metrics.scrolledSubtabTop,
      'Subtab navigation position must stay fixed when modal-body is scrolled'
    );
    assert.ok(metrics.bodyScrollTop > 0, 'modal-body must have scrolled');
  } finally {
    try { ws.close(); } catch {}
    killChildProcessSync(proc);
  }
});
