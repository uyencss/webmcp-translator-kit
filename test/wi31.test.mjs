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
// WI-31 F1: Block-level budget and yield for empty/detached/offscreen blocks
// Repro Sol F1: 20,000 empty blocks -> bounded walker calls and yields > 0
// ============================================================================

test('WI-31 F1: flushReadyBlocks bounds empty/detached/offscreen blocks at block-level and yields (repro Sol F1: 20k empty blocks)', async () => {
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

    // 20,000 empty blocks
    const TOTAL_BLOCKS = 20000;
    const blocks = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 0, right: 600, bottom: 800, height: 800 });

    for (let i = 0; i < TOTAL_BLOCKS; i++) {
      const p = mock.fakeEl('P', { left: 0, top: 10, right: 500, bottom: 30, height: 20 });
      p.parentElement = container;
      // Empty block: no text nodes inside!
      blocks.push(p);
    }

    let createWalkerCalls = 0;
    let nextNodeCalls = 0;

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'),
      body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: (root) => {
        createWalkerCalls++;
        return {
          nextNode: () => {
            nextNodeCalls++;
            return null; // Empty block has no text nodes
          }
        };
      },
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    dom = mock.win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    const session = dom.getScrollSession();

    // Populate readyBlocks with 20,000 empty blocks
    for (const b of blocks) {
      session.readyBlocks.add(b);
    }

    // Measure walker calls performed strictly within flushReadyBlocks()
    createWalkerCalls = 0;
    nextNodeCalls = 0;

    // Call flushReadyBlocks synchronously
    dom.flushReadyBlocks();

    // In the first slice / synchronous run:
    // Walker calls MUST be bounded <= 250 (SWEEP_SLICE_NODE_BUDGET)
    // and yield must be scheduled (yields > 0)
    assert.ok(
      createWalkerCalls <= 250,
      `Synchronous createTreeWalker calls must be <= 250, got ${createWalkerCalls} (repro Sol F1: 20,000)`
    );
    assert.ok(
      nextNodeCalls <= 250,
      `Synchronous nextNode calls must be <= 250, got ${nextNodeCalls}`
    );
    assert.ok(
      session.sweepYieldCount > 0,
      `Flush must yield when budget is exhausted: sweepYieldCount must be > 0, got ${session.sweepYieldCount}`
    );
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-31 F2: Revalidate candidate excludes queuedIds, preserves uniqueness,
// and ensures applied nodes are never counted as failed
// Repro Sol F2: 500 nodes -> 500 applied, 0 failed, queued unique
// ============================================================================

test('WI-31 F2: sweep candidate revalidate excludes queuedIds, preserves unique queue, and never marks applied nodes as failed (repro Sol F2: 500 nodes -> 500 applied, 0 failed, queued unique)', async () => {
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

    // 500 nodes in viewport
    const TOTAL_NODES = 500;
    const allNodes = [];
    const container = mock.fakeEl('DIV', { left: 0, top: 0, right: 600, bottom: 800, height: 800 });

    for (let i = 0; i < TOTAL_NODES; i++) {
      const p = mock.fakeEl('P', { left: 0, top: 10, right: 500, bottom: 30, height: 20 });
      p.parentElement = container;
      const tn = {
        nodeType: 3,
        nodeValue: `Paragraph #${i + 1}`,
        parentElement: p,
        isConnected: true
      };
      allNodes.push(tn);
    }

    let cursor = 0;
    globalThis.document = {
      documentElement: mock.fakeEl('HTML'),
      body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => ({
        nextNode: () => allNodes[cursor++] || null
      }),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    dom = mock.win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // Trigger flush while sweep is running to simulate sweep/flush candidate overlap
    dom.flushReadyBlocks();

    // Wait for all slices and batches to complete and drain
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Verify queue uniqueness: any queued entries must have unique IDs
    const overflow = dom.getOverflowQueue();
    const allQueuedItems = overflow.flatMap((c) => c);
    const uniqueQueuedIds = new Set(allQueuedItems.map((it) => it.id));
    assert.equal(
      uniqueQueuedIds.size,
      allQueuedItems.length,
      `Queued items must have unique IDs without duplication: got ${uniqueQueuedIds.size} unique out of ${allQueuedItems.length} queued`
    );

    // Verify all 500 nodes were applied and 0 failed
    const status = dom.getStatus();
    assert.equal(
      status.totalApplied,
      TOTAL_NODES,
      `All 500 nodes must be successfully applied, got ${status.totalApplied}`
    );
    assert.equal(
      status.totalFailed,
      0,
      `totalFailed must be 0 (repro Sol F2: 110 failed oan), got ${status.totalFailed}`
    );
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-31 F3: Follow-up discovery does not stop early on below-bound siblings
// Repro Sol F3: DIV revealed after 30 offscreen siblings is requested
// ============================================================================

test('WI-31 F3: follow-up discovery does not stop early after 30 below-bound siblings and requests DIV in viewport (repro Sol F3: DIV after 30 offscreen siblings)', async () => {
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

    // Initial visible item in viewport
    const initialDiv = mock.fakeEl('DIV', { left: 0, top: 100, right: 500, bottom: 150, height: 50 });
    const initialTextNode = {
      nodeType: 3,
      nodeValue: 'Initial Visible Node',
      parentElement: initialDiv,
      isConnected: true
    };

    // 35 offscreen sibling elements past bottom bound (> 1600)
    const offscreenSiblings = [];
    for (let i = 0; i < 35; i++) {
      const offDiv = mock.fakeEl('DIV', { left: 0, top: 3000 + i * 50, right: 500, bottom: 3050 + i * 50, height: 50 });
      const tn = {
        nodeType: 3,
        nodeValue: `Offscreen Sibling #${i + 1}`,
        parentElement: offDiv,
        isConnected: true
      };
      offscreenSiblings.push(tn);
    }

    // Target DIV revealed into viewport, placed AFTER the 35 offscreen siblings in DOM order
    const targetDiv = mock.fakeEl('DIV', { left: 0, top: 200, right: 500, bottom: 250, height: 50 });
    const targetTextNode = {
      nodeType: 3,
      nodeValue: 'DIV revealed into viewport after 30 offscreen siblings',
      parentElement: targetDiv,
      isConnected: true
    };

    const docElements = [initialTextNode, ...offscreenSiblings, targetTextNode];

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
      querySelectorAll: (sel) => [],
      addEventListener() {},
      removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    dom = mock.win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });

    // Wait for initial batch to resolve
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Trigger scroll / follow-up discovery
    for (const listener of mock.scrollListeners) {
      listener();
    }
    while (mock.rafCallbacks.length > 0) {
      const cb = mock.rafCallbacks.shift();
      if (typeof cb === 'function') cb();
    }

    // Allow follow-up scan to run and complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The target DIV after 35 offscreen siblings MUST be discovered and requested!
    const allDispatchedTexts = mock.requestedBatches.flatMap((b) => b.map((x) => x.text));
    assert.ok(
      allDispatchedTexts.includes('DIV revealed into viewport after 30 offscreen siblings'),
      'Target DIV after 35 offscreen siblings must be requested (repro Sol F3: got 0 requests)'
    );

    const session = dom.getScrollSession();
    assert.equal(session.domSweepNeeded, false, 'domSweepNeeded must be cleared only after scanning all bounds');
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

// ============================================================================
// WI-31 F2 (b): Applied node is never counted as failed (drop accounting correction)
// ============================================================================

test('WI-31 F2 (b): applied node is never counted as failed (drop accounting invariant)', async () => {
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

    const p = mock.fakeEl('P', { left: 0, top: 10, right: 500, bottom: 30, height: 20 });
    const tn = {
      nodeType: 3,
      nodeValue: 'Original Text Content',
      parentElement: p,
      isConnected: true
    };

    globalThis.document = {
      documentElement: mock.fakeEl('HTML'),
      body: mock.fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => mock.fakeEl(tag),
      createTreeWalker: () => ({
        nextNode: () => tn
      }),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    };

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    dom = mock.win.__translatorDom;

    // Hold batches so they are not auto-applied before our manual call
    mock.runtime.sendMessage = (msg, cb) => {
      if (msg?.action === 'WIDGET_GET_STATE') {
        cb({ effective: 'on', permission: true, hasKey: true, autoStart: false, widgetVisible: true });
      } else if (msg?.action === 'TRANSLATE_BATCH') {
        mock.translationRequests.push(msg);
        mock.requestedBatches.push(msg.payload.items);
      }
    };

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    const session = dom.getScrollSession();

    // Initial batch is dispatched
    await new Promise((resolve) => setTimeout(resolve, 10));

    const recId = mock.requestedBatches[0]?.[0]?.id;
    assert.ok(recId, 'Record ID must exist');

    // Simulate an overflow drop that previously marked this ID as failed
    session.failedIds.add(recId);
    const statusBefore = dom.getStatus();
    const origFailed = statusBefore.totalFailed;
    // Manually increment totalFailed to simulate the drop counter
    statusBefore.totalFailed = origFailed + 1;

    // Now apply batch containing the translation for this record
    const applyRes = await dom.applyBatchThrottled([
      { id: recId, text: '[vi] Translated Text Content', revision: 0 }
    ], dom.getEpoch());

    assert.equal(applyRes.applied, 1, 'Node was applied');
    assert.equal(session.failedIds.has(recId), false, 'Applied node must be removed from failedIds');
    assert.equal(dom.getStatus().totalFailed, origFailed, 'totalFailed must be decremented: applied node is never failed');
  } finally {
    dom?.stopScrollFollowSession?.(false);
    for (const k of Object.keys(saved)) {
      globalThis[k] = saved[k];
    }
  }
});

