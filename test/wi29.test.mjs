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
  let rafCallbacks = [];

  function fakeEl(tagName = 'DIV', initialRect = { left: 0, top: 0, right: 500, bottom: 50, height: 50 }) {
    let rect = { ...initialRect };
    const children = [];
    const el = {
      nodeType: 1,
      style: {}, dataset: {}, tagName, id: '', isConnected: true,
      children,
      appendChild(c) { children.push(c); return c; },
      setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener() {}, removeEventListener() {},
      querySelector: () => fakeEl(), querySelectorAll: () => [],
      setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
      closest: () => null,
      getBoundingClientRect: () => rect,
      setRect(r) { rect = { ...r }; },
      textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
      focus() {}, click() {}, isContentEditable: false, parentElement: null
    };
    return el;
  }

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

  const translationRequests = [];
  const requestedBatches = [];

  const runtime = {
    id: 'test-ext-id', lastError: null, onMessage: { addListener() {} },
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
        // Async callback to simulate IPC round-trip
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

  class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }

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
// WI-29 F1: fixture 100k offscreen nodes (sweep có budget/yield, dispatch batch đầu nhanh)
// ============================================================================

test('WI-29 F1: fixture 100k offscreen nodes - initial sweep dispatches first batch quickly without freezing main thread', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // 16 in-viewport visible text nodes in SPANs (viewport is [0, 800], ahead is [0, 1600])
    const inViewportNodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 50, right: 600, bottom: 400, height: 350 });
    for (let i = 0; i < 16; i++) {
      const span = mock.fakeEl('SPAN', { left: 0, top: 60 + i * 20, right: 500, bottom: 75 + i * 20, height: 15 });
      span.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `Visible In-Viewport Item ${i + 1}`,
        parentElement: span,
        isConnected: true
      };
      inViewportNodes.push(tn);
    }

    // Lazy generator for 100,000 offscreen nodes far down below viewport (top: 3500 > bottomBound: 1600)
    const OFFSCREEN_COUNT = 100000;
    const offscreenParent = mock.fakeEl('DIV', { left: 0, top: 3500, right: 600, bottom: 50000, height: 46500 });
    let offscreenIndex = 0;
    let totalNodesIterated = 0;

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'), body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => {
        let inViewCursor = 0;
        return {
          nextNode: () => {
            totalNodesIterated++;
            if (inViewCursor < inViewportNodes.length) {
              return inViewportNodes[inViewCursor++];
            }
            if (offscreenIndex < OFFSCREEN_COUNT) {
              offscreenIndex++;
              return {
                nodeType: 3,
                nodeValue: `Offscreen Text Node #${offscreenIndex}`,
                parentElement: offscreenParent,
                isConnected: true
              };
            }
            return null;
          }
        };
      },
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = mock.win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');

    const startTime = performance.now();
    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    const synchronousDuration = performance.now() - startTime;

    // 1. Dispatch batch đầu nhanh: Batch 1 must be dispatched immediately during startScrollFollowSession
    assert.ok(mock.requestedBatches.length >= 1, 'First batch must be dispatched immediately without waiting for whole sweep');
    assert.ok(synchronousDuration < 150, `Synchronous dispatch took ${synchronousDuration}ms, must be <150ms`);

    const firstBatch = mock.requestedBatches[0];
    assert.equal(firstBatch.length, 16, 'First batch must contain the 16 in-viewport items');
    assert.ok(
      firstBatch.some((it) => it.text.includes('Visible In-Viewport Item 1')),
      'Batch contains visible item 1'
    );
    assert.ok(
      firstBatch.some((it) => it.text.includes('Visible In-Viewport Item 16')),
      'Batch contains visible item 16'
    );

    // 2. Early stop outside bounds: TreeWalker must NOT traverse all 100k nodes synchronously
    assert.ok(
      totalNodesIterated < 500,
      `TreeWalker stopped early outside bounds! Iterated only ${totalNodesIterated} nodes out of 100,016`
    );

    // Wait for batch response to be applied
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(
      inViewportNodes[0].nodeValue.startsWith('[vi] Visible In-Viewport Item 1'),
      'In-viewport item 1 must be translated'
    );
    assert.ok(
      inViewportNodes[15].nodeValue.startsWith('[vi] Visible In-Viewport Item 16'),
      'In-viewport item 16 must be translated'
    );
  } finally {
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-29 F2: fixture 80 SPAN (dịch đủ 80 sau flush/scroll, không mất)
// ============================================================================

test('WI-29 F2: fixture 80 SPAN - all 80 SPANs translated across batches via overflow queue, zero nodes lost', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // 80 SPAN elements, all in viewport (tag SPAN is deliberately outside BLOCK_SELECTOR)
    const TOTAL_SPANS = 80;
    const spanNodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 50, right: 600, bottom: 1500, height: 1450 });

    for (let i = 0; i < TOTAL_SPANS; i++) {
      const span = mock.fakeEl('SPAN', { left: 10, top: 60 + i * 15, right: 400, bottom: 72 + i * 15, height: 12 });
      span.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `Douyin Comment SPAN #${i + 1}`,
        parentElement: span,
        isConnected: true
      };
      spanNodes.push(tn);
    }

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'), body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return {
          nextNode: () => spanNodes[cursor++] || null
        };
      },
      // BLOCK_SELECTOR matches nothing (all nodes are in SPANs)
      querySelectorAll: (sel) => {
        if (sel === 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote') return [];
        return [];
      },
      addEventListener() {}, removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = mock.win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');

    // Start scroll-follow session
    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // Initial sweep dispatches batch 1 (16) and batch 2 (16), respecting MAX_IN_FLIGHT_BATCHES = 2
    assert.equal(mock.requestedBatches.length, 2, 'Initial sweep must dispatch exactly 2 batches (max in-flight)');
    assert.equal(mock.requestedBatches[0].length, 16, 'Batch 1 has 16 items');
    assert.equal(mock.requestedBatches[1].length, 16, 'Batch 2 has 16 items');

    // The remaining 48 items MUST be held in overflowQueue (3 chunks of 16)
    const overflowQueue = dom.getOverflowQueue();
    assert.ok(Array.isArray(overflowQueue), 'overflowQueue must be an array');
    assert.equal(overflowQueue.length, 3, '48 remaining items must be queued as 3 overflow chunks');

    // Allow in-flight batches to resolve and drain overflow queue
    // (mock.runtime resolves each batch after 10ms, which triggers drainOverflowQueue)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify all 5 batches (80 items total) have been dispatched
    assert.equal(mock.requestedBatches.length, 5, 'All 5 batches (80 items) must be dispatched through overflow queue');
    const totalDispatched = mock.requestedBatches.reduce((acc, b) => acc + b.length, 0);
    assert.equal(totalDispatched, TOTAL_SPANS, 'Total dispatched items must be exactly 80');

    // Verify all 80 DOM nodes have been updated
    for (let i = 0; i < TOTAL_SPANS; i++) {
      assert.ok(
        spanNodes[i].nodeValue.startsWith(`[vi] Douyin Comment SPAN #${i + 1}`),
        `Node ${i + 1} must be translated, got: "${spanNodes[i].nodeValue}"`
      );
    }

    // Verify status
    const status = dom.getStatus();
    assert.equal(status.totalCollected, TOTAL_SPANS, 'status.totalCollected must be 80');
    assert.equal(status.totalApplied, TOTAL_SPANS, 'status.totalApplied must be 80');
    assert.equal(status.totalFailed, 0, 'status.totalFailed must be 0');
    assert.equal(status.state, 'done', 'status.state must be done');
    assert.equal(dom.getOverflowQueue().length, 0, 'overflowQueue must be completely empty');
  } finally {
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-29 F2: flush and scroll drain overflowQueue and preserve pending items
// ============================================================================

test('WI-29 F2: user scroll or flushReadyBlocks drains overflowQueue while maintaining in-flight cap <= 2', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // 48 SPAN nodes (3 batches of 16)
    const TOTAL_SPANS = 48;
    const spanNodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 50, right: 600, bottom: 900, height: 850 });

    for (let i = 0; i < TOTAL_SPANS; i++) {
      const span = mock.fakeEl('SPAN', { left: 10, top: 60 + i * 15, right: 400, bottom: 72 + i * 15, height: 12 });
      span.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `SPAN Item ${i + 1}`,
        parentElement: span,
        isConnected: true
      };
      spanNodes.push(tn);
    }

    // Control batch resolution manually
    const pendingBatchResolvers = [];
    mock.runtime.sendMessage = (msg, cb) => {
      if (msg?.action === 'TRANSLATE_BATCH') {
        mock.requestedBatches.push(msg.payload.items);
        pendingBatchResolvers.push(() => {
          const results = msg.payload.items.map((it) => ({
            id: it.id,
            text: '[vi] ' + it.text,
            revision: it.revision
          }));
          cb({ ok: true, results, missingIds: [], failed: 0, partial: false });
        });
      } else if (typeof cb === 'function') {
        cb({ ok: true });
      }
    };

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'), body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return { nextNode: () => spanNodes[cursor++] || null };
      },
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = mock.win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // 2 batches dispatched, 1 chunk in overflowQueue
    assert.equal(mock.requestedBatches.length, 2, '2 batches in flight');
    assert.equal(dom.getOverflowQueue().length, 1, '1 chunk in overflowQueue');

    // Trigger user scroll: overflow queue must NOT exceed in-flight limit
    for (const listener of mock.scrollListeners) {
      listener();
    }
    assert.equal(mock.requestedBatches.length, 2, 'Still 2 batches (cap respected on scroll)');

    // Resolve batch 1: slot opens, overflow queue is immediately drained
    const resolveBatch1 = pendingBatchResolvers.shift();
    resolveBatch1();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Batch 3 must now be dispatched
    assert.equal(mock.requestedBatches.length, 3, 'Batch 3 dispatched after batch 1 resolved');
    assert.equal(dom.getOverflowQueue().length, 0, 'overflowQueue now empty');

    // Resolve remaining batches
    while (pendingBatchResolvers.length > 0) {
      pendingBatchResolvers.shift()();
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    // All 48 translated
    for (let i = 0; i < TOTAL_SPANS; i++) {
      assert.ok(spanNodes[i].nodeValue.startsWith('[vi]'), `Item ${i + 1} translated`);
    }
  } finally {
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-29 F1: initial sweep divides work into slices and yields across ticks
// ============================================================================

test('WI-29 F1: initial sweep divides work into slices and yields across ticks when DOM is large', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    const mock = createMockEnvironment();
    setupGlobals(mock);

    // 600 nodes in viewport (each slice is 250 nodes, so it must yield at least twice)
    const TOTAL_NODES = 600;
    const textNodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 50, right: 600, bottom: 800, height: 750 });

    for (let i = 0; i < TOTAL_NODES; i++) {
      const span = mock.fakeEl('SPAN', { left: 10, top: 50 + (i % 50) * 10, right: 400, bottom: 58 + (i % 50) * 10, height: 8 });
      span.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `Chunked Item ${i + 1}`,
        parentElement: span,
        isConnected: true
      };
      textNodes.push(tn);
    }

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'), body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return { nextNode: () => textNodes[cursor++] || null };
      },
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = mock.win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // The first batch must have been dispatched immediately during slice 1!
    assert.ok(mock.requestedBatches.length >= 1, 'First batch dispatched immediately');
    assert.equal(mock.requestedBatches[0].length, 16, 'First batch has 16 items');

    // Wait for yielded slices to run across ticks
    await new Promise((resolve) => setTimeout(resolve, 150));

    const session = dom.getScrollSession();
    assert.ok(session.sweepYieldCount >= 2, `Sweep must have yielded at least 2 times, got: ${session.sweepYieldCount}`);
  } finally {
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

