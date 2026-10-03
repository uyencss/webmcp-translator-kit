// WebMCP Translator Kit — WI-39 Unit & Integration Tests
// Fix Sol round 22 finding (wi1115-sol-verdict22.md, P2):
// Bug: Late primary success enters syncFallbackState because a sibling already consumed fallback;
//      prioritized response's primary model and overwrote fallback pin;
//      retry refresh then dispatched primary with contradictory state {model:"primary", fallbackConsumed:true}.
// Fix: When fallback pin is active in run: late primary response must NOT overwrite pin;
//      syncFallbackState respects active pin;
//      invariant: never dispatch contradictory {model:primary, fallbackConsumed:true} -> resolve to pinned model before sending.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function setupDomEnvironment(options = {}) {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of [
    'window', 'document', 'location', 'chrome', 'NodeFilter',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval',
    'clearInterval', 'IntersectionObserver', 'MutationObserver'
  ]) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  const elementsById = new Map();

  function fakeEl(tagName = 'DIV', initialRect = { left: 0, top: 0, right: 500, bottom: 50, height: 50 }) {
    let rect = { ...initialRect };
    const children = [];
    const eventListeners = {};
    const textNodes = [];

    const el = {
      nodeType: 1,
      style: {},
      dataset: {},
      tagName,
      id: '',
      isConnected: true,
      children,
      _textNodes: textNodes,
      appendChild(c) {
        children.push(c);
        c.parentElement = el;
        if (c.nodeType === 3) textNodes.push(c);
        return c;
      },
      setAttribute(k, v) { el[k] = v; },
      getAttribute(k) { return el[k] || null; },
      hasAttribute(k) { return Boolean(el[k]); },
      classList: {
        toggle() {},
        add() {},
        remove() {},
        contains: () => false
      },
      addEventListener(evt, fn) {
        eventListeners[evt] = eventListeners[evt] || [];
        eventListeners[evt].push(fn);
      },
      removeEventListener(evt, fn) {
        if (eventListeners[evt]) {
          eventListeners[evt] = eventListeners[evt].filter(f => f !== fn);
        }
      },
      dispatchEvent(evt) {
        const type = typeof evt === 'string' ? evt : evt.type;
        (eventListeners[type] || []).forEach(fn => fn(evt));
      },
      click() {
        (eventListeners['click'] || []).forEach(fn => fn({ type: 'click', target: el }));
      },
      querySelector: (sel) => {
        if (typeof sel === 'string' && sel.startsWith('#')) {
          const id = sel.slice(1);
          if (!elementsById.has(id)) {
            const child = fakeEl('DIV');
            child.id = id;
            elementsById.set(id, child);
          }
          return elementsById.get(id);
        }
        return fakeEl();
      },
      querySelectorAll: () => [],
      setPointerCapture() {},
      releasePointerCapture() {},
      attachShadow: () => fakeEl('SHADOW'),
      closest: () => null,
      getBoundingClientRect: () => rect,
      setRect(r) { rect = { ...r }; },
      textContent: '',
      innerHTML: '',
      value: '',
      checked: false,
      disabled: false,
      title: '',
      focus() {},
      isContentEditable: false,
      parentElement: null
    };
    return el;
  }

  // Pre-populate blocks and text nodes
  const blocks = [];
  const allTextNodes = [];

  const block1 = fakeEl('P', { left: 0, top: 50, right: 600, bottom: 200, height: 150 });
  block1.id = 'block-1';
  blocks.push(block1);
  for (let i = 0; i < 16; i++) {
    const tn = {
      nodeType: 3,
      nodeValue: `Paragraph 1 text item number ${i}`,
      parentElement: block1,
      isConnected: true
    };
    block1.appendChild(tn);
    allTextNodes.push(tn);
  }

  const block2 = fakeEl('P', { left: 0, top: 250, right: 600, bottom: 400, height: 150 });
  block2.id = 'block-2';
  blocks.push(block2);
  for (let i = 16; i < 32; i++) {
    const tn = {
      nodeType: 3,
      nodeValue: `Paragraph 2 text item number ${i}`,
      parentElement: block2,
      isConnected: true
    };
    block2.appendChild(tn);
    allTextNodes.push(tn);
  }

  const win = {
    innerHeight: 800,
    innerWidth: 1200,
    top: null,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
    scrollTo() {}
  };
  win.top = win;

  const sentMessages = [];
  let batchResponseHandler = null;
  const messageListeners = [];

  const runtime = {
    id: 'test-ext-wi39',
    lastError: null,
    onMessage: {
      addListener(fn) {
        messageListeners.push(fn);
      }
    },
    sendMessage: (msg, cb) => {
      sentMessages.push(msg);
      if (msg?.action === 'WIDGET_GET_STATE') {
        if (cb) {
          cb({
            effective: options.effective || 'on',
            permission: options.permission ?? true,
            hasKey: options.hasKey ?? true,
            autoStart: Boolean(options.autoStart),
            widgetVisible: true,
            mode: options.mode || 'scroll-follow',
            model: options.model || 'ag/gemini-3.1-pro-low'
          });
        }
      } else if (msg?.action === 'TRANSLATE_BATCH') {
        if (batchResponseHandler) {
          batchResponseHandler(msg, cb);
        } else if (cb) {
          cb({
            ok: true,
            results: msg.payload.items.map(it => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH] ${it.text}`
            }))
          });
        }
      } else if (msg?.action === 'WIDGET_SET_MODE') {
        if (cb) cb({ ok: true });
      } else if (msg?.action === 'RECORD_ERROR_LOG') {
        if (cb) cb({ ok: true });
      } else if (typeof cb === 'function') {
        cb({ ok: true });
      }
      return Promise.resolve({ ok: true });
    }
  };

  globalThis.window = win;
  globalThis.document = {
    documentElement: fakeEl('HTML'),
    body: fakeEl('BODY'),
    createElement: (t) => {
      const el = fakeEl(t);
      if (t === 'div' && el.id === '__wmt-widget-host') {
        elementsById.set('__wmt-widget-host', el);
      }
      return el;
    },
    getElementById: (id) => elementsById.get(id) || null,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: (sel) => {
      if (sel === 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote') {
        return (options.initialBlocks ? options.initialBlocks(blocks) : [block1]);
      }
      return [];
    },
    createTreeWalker: (root) => {
      let list = [];
      if (root && root._textNodes) {
        list = root._textNodes;
      } else if (!root || root === document.body || root === document.documentElement) {
        list = allTextNodes;
      } else {
        list = allTextNodes.filter(n => n.parentElement === root);
      }
      let i = 0;
      return {
        nextNode: () => (i < list.length ? list[i++] : null)
      };
    }
  };
  globalThis.location = { href: 'https://example.com/article', origin: 'https://example.com', protocol: 'https:' };
  globalThis.chrome = {
    runtime,
    storage: {
      session: { set: async () => {}, get: async () => ({}) },
      local: { get: async () => ({}), set: async () => {} }
    }
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.requestAnimationFrame = (cb) => {
    return setTimeout(cb, 0);
  };
  globalThis.cancelAnimationFrame = (id) => {
    clearTimeout(id);
  };

  vm.runInThisContext(contentSrc, { filename: 'content.js' });

  const dom = win.__translatorDom;

  function restore() {
    try {
      if (dom && typeof dom.stopScrollFollowSession === 'function') {
        dom.stopScrollFollowSession(false);
      }
    } catch {}
    for (const k of [
      'window', 'document', 'location', 'chrome', 'NodeFilter',
      'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval',
      'clearInterval', 'IntersectionObserver', 'MutationObserver'
    ]) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }

  return {
    dom,
    win,
    block1,
    block2,
    blocks,
    allTextNodes,
    elementsById,
    sentMessages,
    setBatchResponseHandler: (fn) => { batchResponseHandler = fn; },
    dispatchRuntimeMessage: (msg, sendResponse) => {
      for (const fn of messageListeners) {
        fn(msg, {}, sendResponse || (() => {}));
      }
    },
    restore
  };
}

// ============================================================================
// 1. Repro Test Sol Round 22:
// Fallback pinned -> Sibling primary success arrives late -> Retry must remain
// on fallback model, NOT overwrite pin and NOT dispatch { model: primary, fallbackConsumed: true }.
// ============================================================================
test('WI-39 repro Sol r22: fallback pinned -> sibling primary success -> retry stays on fallback, never dispatches primary with fallbackConsumed:true', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';

    const recordedDispatches = [];

    const collected = dom.collect(env.block1, false);
    const itemsA = collected.slice(0, 4);
    const itemsB = collected.slice(4, 8);
    const idA0 = itemsA[0].id;
    const idB0 = itemsB[0].id;

    // Shared runConfig for the current run
    const sharedRunConfig = { revision: null, fallbackConsumed: false, model: null, primaryModel };

    let batchBCallback = null;
    let batchBItems = null;

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      const dispatchInfo = {
        action: msg.action,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        firstItemId: payload.items?.[0]?.id,
        items: payload.items || []
      };
      recordedDispatches.push(dispatchInfo);

      const firstId = payload.items?.[0]?.id;

      if (firstId === idA0 && recordedDispatches.length === 1) {
        // Initial send of Batch A: fails with 500 error to enter 800ms retry wait
        setTimeout(() => {
          cb({
            ok: false,
            error: { code: 'NETWORK', message: 'Temporary primary network error', retryable: true }
          });
        }, 5);
      } else if (firstId === idB0 && !batchBCallback) {
        // Initial send of Batch B on primary: hold callback to simulate delayed in-flight primary
        batchBCallback = cb;
        batchBItems = payload.items;
      } else if (firstId === idA0) {
        // Retry of Batch A: completes successfully
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH-RETRY] ${it.text}`
            })),
            actualModel: payload.model,
            fallbackConsumed: Boolean(payload.fallbackConsumed)
          });
        }, 5);
      }
    });

    const initialSettings = {
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: primaryModel,
      fallbackConsumed: false
    };

    // Start Batch A and Batch B concurrently
    const pA = dom.translateChunkWithRecovery(itemsA, initialSettings, 0, dom.getEpoch(), sharedRunConfig);
    const pB = dom.translateChunkWithRecovery(itemsB, initialSettings, 0, dom.getEpoch(), sharedRunConfig);

    // Wait until both initial dispatches are recorded and Batch B callback is captured
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(recordedDispatches.length, 2, 'Both Batch A and Batch B initial sends dispatched');
    assert.equal(recordedDispatches[0].model, primaryModel);
    assert.equal(recordedDispatches[0].fallbackConsumed, false);
    assert.equal(recordedDispatches[1].model, primaryModel);
    assert.equal(recordedDispatches[1].fallbackConsumed, false);
    assert.ok(batchBCallback, 'Batch B in-flight callback captured');

    // While Batch A is waiting in its 800ms retry window:
    // A sibling establishes the fallback pin!
    sharedRunConfig.fallbackConsumed = true;
    sharedRunConfig.model = fallbackModel;

    // Now, Batch B's in-flight PRIMARY response finally arrives and succeeds late!
    // It returns actualModel: primaryModel with fallbackConsumed: false.
    batchBCallback({
      ok: true,
      results: batchBItems.map((it) => ({
        id: it.id,
        revision: it.revision,
        text: `[DICH-PRIMARY-LATE] ${it.text}`
      })),
      actualModel: primaryModel,
      fallbackIndex: 0,
      fallbackConsumed: false
    });

    // Let Batch B settle
    const resB = await pB;
    assert.equal(resB.applied, 4, 'Batch B applied all 4 items');

    // CRITICAL ASSERTION 1:
    // Sibling primary success entering syncFallbackState MUST NOT overwrite the active fallback pin!
    assert.equal(
      sharedRunConfig.model,
      fallbackModel,
      `sharedRunConfig.model must remain pinned to fallbackModel (${fallbackModel}), NOT overwritten by late primary (${primaryModel})`
    );
    assert.equal(
      sharedRunConfig.fallbackConsumed,
      true,
      'sharedRunConfig.fallbackConsumed must remain true'
    );

    // Wait for Batch A's retry to finish (800ms timer + processing)
    const resA = await pA;
    assert.equal(resA.applied, 4, 'Batch A applied all 4 items on retry');

    // Find Batch A retry dispatch
    const retryDispatches = recordedDispatches.filter(d => d.firstItemId === idA0 && d !== recordedDispatches[0]);
    assert.equal(retryDispatches.length, 1, 'Batch A must have retried exactly once');
    const retryDispatch = retryDispatches[0];

    // CRITICAL REPRO ASSERTION 2 (Sol round 22):
    // Retry MUST dispatch with fallbackModel, NOT primaryModel!
    assert.equal(
      retryDispatch.model,
      fallbackModel,
      `Batch A retry must dispatch with fallbackModel (${fallbackModel}), NOT primaryModel (${primaryModel})`
    );
    assert.equal(
      retryDispatch.fallbackConsumed,
      true,
      'Batch A retry must carry fallbackConsumed: true'
    );

    // CRITICAL INVARIANT:
    // Verify that NO dispatch ever had contradictory { model: primaryModel, fallbackConsumed: true }
    for (const d of recordedDispatches) {
      if (d.model === primaryModel) {
        assert.equal(
          d.fallbackConsumed,
          false,
          `Invariant violation: dispatch with model=${primaryModel} cannot have fallbackConsumed=true!`
        );
      }
    }
  } finally {
    env.restore();
  }
});

// ============================================================================
// 2. Scroll session integration:
// Fallback pinned -> late primary success -> next scroll batch uses fallback, NOT primary
// ============================================================================
test('WI-39 scroll session: fallback pinned -> late primary success -> next scroll batch uses fallback model, NOT primary', async () => {
  const env = setupDomEnvironment({
    initialBlocks: (blocks) => [blocks[0]]
  });
  try {
    const dom = env.dom;
    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';

    const recordedDispatches = [];
    let initialBatchCallback = null;

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      const dispatchInfo = {
        action: msg.action,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        firstItemId: payload.items?.[0]?.id,
        items: payload.items || []
      };
      recordedDispatches.push(dispatchInfo);

      if (recordedDispatches.length === 1) {
        // Hold initial batch of block 1
        initialBatchCallback = cb;
      } else {
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH-SCROLL] ${it.text}`
            })),
            actualModel: payload.model,
            fallbackConsumed: Boolean(payload.fallbackConsumed)
          });
        }, 5);
      }
    });

    // 1. Start scroll follow session with primaryModel
    dom.startScrollFollowSession({
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: primaryModel
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(recordedDispatches.length, 1, 'Initial batch of block 1 dispatched');
    assert.equal(recordedDispatches[0].model, primaryModel);
    assert.equal(recordedDispatches[0].fallbackConsumed, false);

    const session = dom.getScrollSession();
    assert.ok(session && session.active);

    // 2. Establish fallback pin on the session (e.g. from a parallel batch)
    session.fallbackConsumed = true;
    session.fallbackModel = fallbackModel;
    if (session.runConfig) {
      session.runConfig.fallbackConsumed = true;
      session.runConfig.model = fallbackModel;
    }

    // 3. Late primary response arrives for block 1
    assert.ok(initialBatchCallback);
    initialBatchCallback({
      ok: true,
      results: recordedDispatches[0].items.map((it) => ({
        id: it.id,
        revision: it.revision,
        text: `[DICH-PRIMARY-LATE] ${it.text}`
      })),
      actualModel: primaryModel,
      fallbackIndex: 0,
      fallbackConsumed: false
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify session pin was NOT overwritten by late primary
    assert.equal(
      session.fallbackModel,
      fallbackModel,
      `session.fallbackModel must remain fallbackModel (${fallbackModel})`
    );
    assert.equal(session.fallbackConsumed, true);

    // 4. Now user scrolls down: block 2 becomes ready
    session.readyBlocks.add(env.block2);
    dom.flushReadyBlocks();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // A new dispatch must have been sent for block 2
    assert.ok(recordedDispatches.length >= 2, 'Block 2 batch must have dispatched');
    const block2Dispatch = recordedDispatches[1];

    // CRITICAL ASSERTION: Block 2 batch MUST use fallbackModel, NOT primaryModel!
    assert.equal(
      block2Dispatch.model,
      fallbackModel,
      `Subsequent scroll batch must use fallbackModel (${fallbackModel}), NOT primaryModel (${primaryModel})`
    );
    assert.equal(
      block2Dispatch.fallbackConsumed,
      true,
      'Subsequent scroll batch must carry fallbackConsumed: true'
    );
  } finally {
    env.restore();
  }
});

// ============================================================================
// 3. Invariant test:
// sendChunk resolves contradictory { model: primary, fallbackConsumed: true }
// to the pinned model before sending, guaranteeing no contradictory dispatch.
// ============================================================================
test('WI-39 invariant: never dispatch contradictory { model: primary, fallbackConsumed: true }', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';

    const recordedDispatches = [];
    env.setBatchResponseHandler((msg, cb) => {
      recordedDispatches.push({
        model: msg.payload?.model,
        fallbackConsumed: Boolean(msg.payload?.fallbackConsumed)
      });
      cb({
        ok: true,
        results: (msg.payload?.items || []).map(it => ({ id: it.id, revision: it.revision, text: it.text }))
      });
    });

    const collected = dom.collect(env.block1, false);
    const items = collected.slice(0, 4);

    // Pass contradictory settings: model is primaryModel, but fallbackConsumed: true
    // with runConfig pinned to fallbackModel
    const runConfig = {
      revision: null,
      fallbackConsumed: true,
      model: fallbackModel,
      primaryModel
    };

    const settings = {
      model: primaryModel,
      fallbackConsumed: true
    };

    await dom.translateChunkWithRecovery(items, settings, 0, dom.getEpoch(), runConfig);

    assert.equal(recordedDispatches.length, 1);
    const d = recordedDispatches[0];

    // Must resolve to pinned model before sending!
    assert.equal(d.model, fallbackModel, `Dispatch must resolve to pinned model (${fallbackModel})`);
    assert.equal(d.fallbackConsumed, true);
  } finally {
    env.restore();
  }
});
