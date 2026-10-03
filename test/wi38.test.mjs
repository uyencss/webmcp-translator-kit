// WebMCP Translator Kit — WI-38 Unit & Integration Tests
// Fix 2 findings from Sol round 21 (wi1115-sol-verdict21.md, P2 race):
// 1. concurrent-pin-refresh: Concurrent batch retries refresh pin from live run state after wait;
//    sibling batch retries on fallback model with fallbackConsumed: true instead of primary with fallbackConsumed: false.
// 2. epoch-guard-new-run: Starting a new scroll run advances epoch immediately;
//    old in-flight fallback response from previous run is dropped and does not re-pin new session.

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
    id: 'test-ext-wi38',
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
// 1. Repro Test 1: concurrent-pin-refresh
// Sol round 21 F1: Concurrent batch retries ignore a newly established run pin:
// currentSettings is captured before waiting, then reused without refreshing runConfig.
// Repro: Sibling establishes fallback pin during wait; next retry must refresh live pin
// and dispatch on fallbackModel with fallbackConsumed: true instead of primary with false.
// ============================================================================
test('WI-38: concurrent-pin-refresh — concurrent retry refreshes run pin after wait, does NOT retry on primary with fallbackConsumed:false', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';

    const recordedDispatches = [];
    let resolveBatch1Retry = null;
    let resolveBatch2Retry = null;

    const collected = dom.collect(env.block1, false);
    const itemsA = collected.slice(0, 4);
    const itemsB = collected.slice(4, 8);
    const idA0 = itemsA[0].id;
    const idB0 = itemsB[0].id;

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

      if (recordedDispatches.length === 1 && firstId === idA0) {
        // Initial send of Batch A: fails with 500 error to enter 800ms retry wait
        setTimeout(() => {
          cb({
            ok: false,
            error: { code: 'NETWORK', message: 'Primary temporary error', retryable: true }
          });
        }, 5);
      } else if (recordedDispatches.length === 2 && firstId === idB0) {
        // Initial send of Batch B: fails with 500 error to enter 800ms retry wait slightly after Batch A
        setTimeout(() => {
          cb({
            ok: false,
            error: { code: 'NETWORK', message: 'Primary temporary error', retryable: true }
          });
        }, 80);
      } else if (firstId === idA0) {
        // Retry of Batch A: succeeds on fallbackModel and establishes the run pin
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH-FB-A] ${it.text}`
            })),
            actualModel: fallbackModel,
            fallbackIndex: 1,
            fallbackConsumed: true
          });
          if (resolveBatch1Retry) resolveBatch1Retry();
        }, 10);
      } else if (firstId === idB0) {
        // Retry of Batch B: must have refreshed live pin and sent on fallbackModel
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH-FB-B] ${it.text}`
            })),
            actualModel: fallbackModel,
            fallbackIndex: 1,
            fallbackConsumed: true
          });
          if (resolveBatch2Retry) resolveBatch2Retry();
        }, 10);
      }
    });

    // Shared runConfig for the current run
    const sharedRunConfig = { revision: null, fallbackConsumed: false, model: null };

    // Start Batch A and Batch B concurrently with initial primary settings
    const initialSettings = {
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: primaryModel,
      fallbackConsumed: false
    };

    const pA = dom.translateChunkWithRecovery(itemsA, initialSettings, 0, dom.getEpoch(), sharedRunConfig);
    const pB = dom.translateChunkWithRecovery(itemsB, initialSettings, 0, dom.getEpoch(), sharedRunConfig);

    const [resA, resB] = await Promise.all([pA, pB]);

    // Both batches should complete successfully
    assert.equal(resA.applied, 4, 'Batch A must apply all 4 items');
    assert.equal(resB.applied, 4, 'Batch B must apply all 4 items');

    // Verify dispatch sequence:
    // Dispatch 1: Batch A initial send (model: primaryModel, fallbackConsumed: false)
    assert.equal(recordedDispatches[0].model, primaryModel);
    assert.equal(recordedDispatches[0].fallbackConsumed, false);

    // Dispatch 2: Batch B initial send (model: primaryModel, fallbackConsumed: false)
    assert.equal(recordedDispatches[1].model, primaryModel);
    assert.equal(recordedDispatches[1].fallbackConsumed, false);

    // After 800ms wait:
    // Batch A retried and established fallback pin:
    assert.equal(sharedRunConfig.fallbackConsumed, true, 'sharedRunConfig must have fallbackConsumed=true');
    assert.equal(sharedRunConfig.model, fallbackModel, `sharedRunConfig must pin model=${fallbackModel}`);

    // Dispatch 3: Batch A retry (or whichever retried first)
    // Dispatch 4: Batch B retry
    const batchBRetryDispatch = recordedDispatches.slice(2).find(d => d.firstItemId === idB0);
    assert.ok(batchBRetryDispatch, 'Batch B retry must have been dispatched');

    // CRITICAL REPRO ASSERTION:
    // Batch B retry MUST NOT have used primaryModel with fallbackConsumed: false!
    // It must have refreshed the live pin and dispatched on fallbackModel with fallbackConsumed: true!
    assert.equal(
      batchBRetryDispatch.model,
      fallbackModel,
      `Batch B retry after wait must use fallbackModel (${fallbackModel}), NOT stale captured primaryModel (${primaryModel})`
    );
    assert.equal(
      batchBRetryDispatch.fallbackConsumed,
      true,
      'Batch B retry after wait must carry fallbackConsumed: true to prevent second escalation'
    );
  } finally {
    env.restore();
  }
});

// ============================================================================
// 2. Repro Test 2: epoch-guard-new-run
// Sol round 21 F2: Starting a new scroll run does not advance the epoch.
// An old in-flight fallback response passes the epoch guard and repins the new session;
// reproduced its next batch using old-fallback instead of new-primary.
// ============================================================================
test('WI-38: epoch-guard-new-run — startScrollFollowSession advances epoch immediately, dropping in-flight fallback responses and preventing re-pin of new session', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const oldPrimary = 'ag/old-primary';
    const oldFallback = 'ag/old-fallback';
    const newPrimary = 'ag/new-primary-clean';

    const recordedDispatches = [];
    let delayedOldRunCallback = null;

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      const info = {
        action: msg.action,
        epoch: msg.epoch,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        itemCount: payload.items?.length || 0,
        items: payload.items || []
      };
      recordedDispatches.push(info);

      if (payload.model === oldPrimary) {
        // Old Run (Session 1): do not reply yet; hold callback to simulate in-flight slow fallback
        delayedOldRunCallback = cb;
      } else {
        // New Run (Session 2): reply normally
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH-NEW] ${it.text}`
            })),
            actualModel: payload.model,
            fallbackIndex: 0
          });
        }, 10);
      }
    });

    const initialEpoch = dom.getEpoch();

    // 1. Start Session 1 with oldPrimary
    dom.startScrollFollowSession({
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: oldPrimary
    });

    const session1Epoch = dom.getEpoch();
    assert.ok(session1Epoch > initialEpoch, 'startScrollFollowSession must advance epoch immediately at start');
    assert.ok(delayedOldRunCallback, 'Batch 1 of Session 1 must be dispatched and held in-flight');
    assert.equal(recordedDispatches.length, 1);
    assert.equal(recordedDispatches[0].model, oldPrimary);

    // 2. While Session 1 Batch 1 is still in-flight, user/caller starts Session 2 with newPrimary
    dom.startScrollFollowSession({
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: newPrimary
    });

    const session2Epoch = dom.getEpoch();
    assert.ok(session2Epoch > session1Epoch, 'Starting Session 2 must advance epoch again');

    const session = dom.getScrollSession();
    assert.equal(session.epoch, session2Epoch, 'Session 2 epoch must match current advanced epoch');
    assert.equal(session.fallbackConsumed, false, 'Session 2 fallbackConsumed must be initialized to false');
    assert.equal(session.fallbackModel, null, 'Session 2 fallbackModel must be initialized to null');

    // 3. Now simulate the delayed in-flight response from Session 1 finally returning:
    // It returns a fallback success with actualModel: oldFallback and fallbackConsumed: true!
    assert.ok(delayedOldRunCallback, 'Delayed callback from Session 1 must exist');
    delayedOldRunCallback({
      ok: true,
      results: recordedDispatches[0].items.map((it) => ({
        id: it.id,
        revision: it.revision,
        text: `[DICH-OLD-FB] ${it.text}`
      })),
      actualModel: oldFallback,
      fallbackIndex: 1,
      fallbackConsumed: true
    });

    // Wait for any async handlers/promises to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // CRITICAL REPRO ASSERTION:
    // Because epoch was advanced at the start of Session 2, the late-arriving response from Session 1
    // was dropped silently. Session 2 MUST NOT be re-pinned with oldFallback!
    assert.equal(
      session.fallbackConsumed,
      false,
      'Session 2 must NOT have fallbackConsumed set to true by old in-flight response'
    );
    assert.equal(
      session.fallbackModel,
      null,
      `Session 2 fallbackModel must NOT be re-pinned to oldFallback (${oldFallback})`
    );

    // 4. Now scroll down in Session 2: block2 becomes ready in Session 2
    session.readyBlocks.add(env.block2);
    dom.flushReadyBlocks();

    // Wait for Session 2's batch to dispatch and process
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Session 2 must have dispatched its batch
    const session2Dispatches = recordedDispatches.filter(d => d.epoch === session2Epoch);
    assert.ok(session2Dispatches.length >= 1, 'Session 2 must have dispatched its batch');

    // CRITICAL ASSERTION:
    // Session 2's batch MUST use newPrimary, NOT oldFallback!
    assert.equal(
      session2Dispatches[0].model,
      newPrimary,
      `Session 2 must dispatch with newPrimary (${newPrimary}), NOT oldFallback (${oldFallback})`
    );
    assert.equal(
      session2Dispatches[0].fallbackConsumed,
      false,
      'Session 2 must have fallbackConsumed: false'
    );
  } finally {
    env.restore();
  }
});
