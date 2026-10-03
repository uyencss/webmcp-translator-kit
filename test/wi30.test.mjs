import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createMockEnvironment() {
  const scrollListeners = [];
  const rafCallbacks = [];

  function fakeEl(tagName = 'DIV', initialRect = { left: 0, top: 0, right: 500, bottom: 50, height: 50 }) {
    let rect = { ...initialRect };
    const children = [];
    const el = {
      nodeType: 1,
      style: {},
      dataset: {},
      tagName,
      id: '',
      isConnected: true,
      children,
      appendChild(c) {
        children.push(c);
        c.parentElement = el;
        return c;
      },
      setAttribute() {},
      getAttribute: () => null,
      hasAttribute: () => false,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => fakeEl(),
      querySelectorAll: () => [],
      setPointerCapture() {},
      releasePointerCapture() {},
      attachShadow: () => fakeEl(),
      closest: () => null,
      getBoundingClientRect: () => rect,
      setRect(r) {
        rect = { ...r };
      },
      textContent: '',
      innerHTML: '',
      value: '',
      checked: false,
      disabled: false,
      title: '',
      focus() {},
      click() {},
      isContentEditable: false,
      parentElement: null
    };
    return el;
  }

  const win = {
    innerHeight: 800,
    innerWidth: 1200,
    top: null,
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

  const translationRequests = [];
  const requestedBatches = [];

  const runtime = {
    id: 'test-ext-id',
    lastError: null,
    onMessage: { addListener() {} },
    sendMessage: (msg, cb) => {
      if (msg?.action === 'WIDGET_GET_STATE') {
        cb({ effective: 'on', permission: true, hasKey: true, autoStart: false, widgetVisible: true });
      } else if (msg?.action === 'TRANSLATE_BATCH') {
        translationRequests.push(msg);
        requestedBatches.push(msg.payload.items);
        const items = msg.payload.items;
        const results = items.map((it) => ({
          id: it.id,
          text: '[vi] ' + it.text,
          revision: it.revision
        }));
        setTimeout(() => {
          cb({
            ok: true,
            results,
            missingIds: [],
            failed: 0,
            partial: false
          });
        }, 10);
      } else if (typeof cb === 'function') {
        cb({ ok: true });
      }
    }
  };

  class FakeObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  return {
    win,
    runtime,
    scrollListeners,
    rafCallbacks,
    fakeEl,
    translationRequests,
    requestedBatches,
    FakeObserver
  };
}

function setupGlobals(mock) {
  globalThis.chrome = { runtime: mock.runtime };
  globalThis.window = mock.win;
  globalThis.location = { protocol: 'https:' };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.requestAnimationFrame = (cb) => {
    mock.rafCallbacks.push(cb);
    return mock.rafCallbacks.length;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (id > 0 && id <= mock.rafCallbacks.length) mock.rafCallbacks[id - 1] = null;
  };
  globalThis.IntersectionObserver = mock.FakeObserver;
  globalThis.MutationObserver = mock.FakeObserver;
}

// ============================================================================
// WI-30 F1: Synchronous rescan / flush is bounded by budget (repro: 20,001 nodes)
// ============================================================================

test('WI-30 F1: flushReadyBlocks and scroll discovery walker calls are strictly bounded per slice (<=250 nodes)', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  let dom = null;
  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // 20,001 text nodes
    const TOTAL_NODES = 20001;
    const allNodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 0, right: 600, bottom: 800, height: 800 });

    for (let i = 0; i < TOTAL_NODES; i++) {
      const p = mock.fakeEl('P', { left: 0, top: 10, right: 500, bottom: 30, height: 20 });
      p.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `Paragraph node #${i + 1}`,
        parentElement: p,
        isConnected: true
      };
      allNodes.push(tn);
    }

    let walkerCalls = 0;
    let walkerIndex = 0;

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'),
      body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => ({
        nextNode: () => {
          walkerCalls++;
          if (walkerIndex < allNodes.length) {
            return allNodes[walkerIndex++];
          }
          return null;
        }
      }),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    dom = mock.win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');

    // Trigger initial session
    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // The first slice of sweep must NOT traverse all 20,001 nodes synchronously!
    // Slice node budget is 250 (SWEEP_SLICE_NODE_BUDGET)
    assert.ok(
      walkerCalls <= 250,
      `Synchronous walker calls in first slice must be <= 250, got ${walkerCalls} (repro Sol F1: 20,001)`
    );

    // Initial batch must be dispatched immediately
    assert.ok(mock.requestedBatches.length >= 1, 'Initial batch was dispatched');
    assert.equal(mock.requestedBatches[0].length, 16, 'Initial batch has 16 items');
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-30 F2: Overflow queue is capped at MAX_OVERFLOW_ITEMS (512) and drops FIFO
// ============================================================================

test('WI-30 F2: overflow queue hard cap at 512 items, drops oldest FIFO and counts into totalFailed', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  let dom = null;
  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // 1,000 SPAN nodes in viewport (exceeds 512 cap)
    const TOTAL_NODES = 1000;
    const spanNodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 0, right: 600, bottom: 800, height: 800 });

    for (let i = 0; i < TOTAL_NODES; i++) {
      const span = mock.fakeEl('SPAN', { left: 0, top: 10, right: 500, bottom: 30, height: 20 });
      span.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `Item content #${i + 1}`,
        parentElement: span,
        isConnected: true
      };
      spanNodes.push(tn);
    }

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'),
      body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return { nextNode: () => spanNodes[cursor++] || null };
      },
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    };

    // Hold batches in-flight so overflow queue is not drained before we inspect it
    mock.runtime.sendMessage = (msg, cb) => {
      if (msg?.action === 'WIDGET_GET_STATE') {
        cb({ effective: 'on', permission: true, hasKey: true, autoStart: false, widgetVisible: true });
      } else if (msg?.action === 'TRANSLATE_BATCH') {
        mock.requestedBatches.push(msg.payload.items);
        // Keep in flight
      } else if (typeof cb === 'function') {
        cb({ ok: true });
      }
    };

    // Intercept console.warn to verify warning is logged once without spamming
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
      vm.runInThisContext(contentSrc, { filename: 'content.js' });
      dom = mock.win.__translatorDom;

      dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

      // Allow all sweep slices to finish scanning
      await new Promise((resolve) => setTimeout(resolve, 100));

      const overflow = dom.getOverflowQueue();
      const totalQueuedItems = overflow.reduce((sum, chunk) => sum + chunk.length, 0);

      // Overflow queue must be strictly <= 512 items
      assert.equal(
        totalQueuedItems,
        512,
        `overflowQueue items must be capped at exactly 512, got ${totalQueuedItems} (repro Sol F2: 19,968)`
      );

      // Total collected: all 1,000 nodes were seen
      const status = dom.getStatus();
      assert.ok(status.totalCollected >= 512, 'totalCollected reflects collected nodes');

      // The dropped items must be counted into totalFailed
      assert.ok(
        status.totalFailed > 0,
        `Dropped items must be counted into totalFailed, got ${status.totalFailed}`
      );
      assert.equal(
        status.totalFailed + totalQueuedItems + (mock.requestedBatches.length * 16),
        TOTAL_NODES,
        'Sum of failed (dropped) + queued + in-flight must equal total collected items'
      );

      // Warning logged once
      const capWarnings = warnings.filter((w) => w.includes('Overflow queue exceeded cap (512)'));
      assert.equal(capWarnings.length, 1, 'Warning must be logged exactly once without spam');
    } finally {
      console.warn = origWarn;
    }
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-30 F3: Sweep/flush overlap revalidates and dedupes (repro: 0 duplicate requests)
// ============================================================================

test('WI-30 F3: sweep and flush overlap revalidates candidates and dispatches zero duplicate requests', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  let dom = null;
  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // 80 nodes across multiple batches
    const TOTAL_NODES = 80;
    const nodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 0, right: 600, bottom: 800, height: 800 });

    for (let i = 0; i < TOTAL_NODES; i++) {
      const p = mock.fakeEl('P', { left: 0, top: 10, right: 500, bottom: 30, height: 20 });
      p.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `Overlap Item #${i + 1}`,
        parentElement: p,
        isConnected: true
      };
      nodes.push(tn);
    }

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'),
      body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return { nextNode: () => nodes[cursor++] || null };
      },
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    dom = mock.win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // Wait for all 5 batches (80 items) to drain and complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify all requested items
    const allDispatchedIds = [];
    for (const batch of mock.requestedBatches) {
      for (const it of batch) {
        allDispatchedIds.push(it.id);
      }
    }

    assert.equal(allDispatchedIds.length, TOTAL_NODES, `Total dispatched items must be exactly ${TOTAL_NODES}`);

    // Deduplication check: zero duplicate IDs across all batches!
    const uniqueIds = new Set(allDispatchedIds);
    assert.equal(
      uniqueIds.size,
      allDispatchedIds.length,
      `Zero duplicate requests across batches: ${uniqueIds.size} unique IDs out of ${allDispatchedIds.length} dispatched (repro Sol F3: 16 duplicates)`
    );
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-30 F4: Follow-up scroll discovery finds standalone DIV/SPAN outside BLOCK_SELECTOR
// ============================================================================

test('WI-30 F4: standalone DIV and SPAN outside BLOCK_SELECTOR initially offscreen are discovered when scrolled into view', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  let dom = null;
  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // In-viewport initial item
    const initialDiv = mock.fakeEl('DIV', { left: 0, top: 100, right: 500, bottom: 150, height: 50 });
    const initialTextNode = {
      nodeType: 3,
      nodeValue: 'Initial Visible Item',
      parentElement: initialDiv,
      isConnected: true
    };

    // Offscreen standalone SPAN (tag SPAN is deliberately NOT in BLOCK_SELECTOR)
    // Initially offscreen at top: 3500 (> SCROLL_AHEAD_H * 800 = 1600)
    const offscreenSpan = mock.fakeEl('SPAN', { left: 0, top: 3500, right: 500, bottom: 3550, height: 50 });
    const offscreenTextNode = {
      nodeType: 3,
      nodeValue: 'Standalone SPAN revealed by scroll',
      parentElement: offscreenSpan,
      isConnected: true
    };

    const docElements = [initialTextNode, offscreenTextNode];

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'),
      body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return {
          nextNode: () => docElements[cursor++] || null
        };
      },
      // BLOCK_SELECTOR matches nothing
      querySelectorAll: (sel) => {
        if (sel === 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote') return [];
        return [];
      },
      addEventListener() {},
      removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    dom = mock.win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // Initial sweep dispatches batch containing initialTextNode
    assert.equal(mock.requestedBatches.length, 1, 'Initial batch dispatched');
    assert.equal(mock.requestedBatches[0][0].text, 'Initial Visible Item');

    // Wait for initial batch to resolve
    await new Promise((resolve) => setTimeout(resolve, 25));

    // At this point, offscreenTextNode was NOT requested (0 requests, as expected)
    const initialDispatchedTexts = mock.requestedBatches.flatMap((b) => b.map((x) => x.text));
    assert.ok(
      !initialDispatchedTexts.includes('Standalone SPAN revealed by scroll'),
      'Offscreen SPAN must not be requested before scroll'
    );

    // Now user scrolls: reveal offscreenSpan into viewport
    offscreenSpan.setRect({ left: 0, top: 200, right: 500, bottom: 250, height: 50 });

    // Fire scroll event
    for (const listener of mock.scrollListeners) {
      listener();
    }

    // Trigger rAF callbacks scheduled by scroll listener
    while (mock.rafCallbacks.length > 0) {
      const cb = mock.rafCallbacks.shift();
      if (typeof cb === 'function') cb();
    }

    // Allow follow-up sweep / flush to run
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify that the standalone SPAN revealed by scroll was discovered and dispatched!
    const allDispatchedTexts = mock.requestedBatches.flatMap((b) => b.map((x) => x.text));
    assert.ok(
      allDispatchedTexts.includes('Standalone SPAN revealed by scroll'),
      'Standalone SPAN revealed by scroll MUST be discovered by follow-up scan (repro Sol F4: 0 requests)'
    );
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});
