// WebMCP Translator Kit — WI-37 Unit & Integration Tests
// Pin propagation + run reset tests:
// 1. Pin lan tới scroll dispatch: recovery fallback thành công trả pin → 16 items tiếp theo trong CÙNG run dùng fallback model, không restart primary, không leo thang lại.
// 2. Pin reset run mới: init run/session mới (user Dịch / auto-start mới) → fallbackConsumed/fallbackModel về primary hiện tại của settings; run mới với primary mới gửi đúng primary mới, không dính fallback cũ.

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
      querySelectorAll: (sel) => [],
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
    id: 'test-ext-wi37',
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
    createTreeWalker: (root, filter) => {
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
// 1. Mandatory Test 1: Pin propagation to scroll dispatch
// Recovery fallback returns pin -> next 16 items in SAME run use fallback model,
// do NOT restart primary, do NOT escalate again.
// ============================================================================
test('WI-37: Pin lan tới scroll dispatch — recovery fallback thành công trả pin → 16 items tiếp theo trong CÙNG run dùng fallback model, không restart primary, không leo thang lại', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const primaryModel = 'ag/gemini-3.1-pro-low';
    const fallbackModel = 'ag/claude-3-5-sonnet';

    const recordedBatches = [];

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      recordedBatches.push({
        action: msg.action,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        itemCount: payload.items?.length || 0,
        items: payload.items || []
      });

      if (recordedBatches.length === 1) {
        // Batch 1 (items 0..15): SW simulates primary failing, then falling back to fallbackModel and succeeding
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH-FB] ${it.text}`
            })),
            actualModel: fallbackModel,
            fallbackIndex: 1
          });
        }, 10);
      } else {
        // Batch 2 (items 16..31): Must be dispatched on fallbackModel with fallbackConsumed: true
        setTimeout(() => {
          cb({
            ok: true,
            results: payload.items.map((it) => ({
              id: it.id,
              revision: it.revision,
              text: `[DICH-FB2] ${it.text}`
            })),
            actualModel: fallbackModel,
            fallbackIndex: 1
          });
        }, 10);
      }
    });

    // Start scroll-follow session with primary model
    dom.startScrollFollowSession({
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: primaryModel
    });

    // Wait for Batch 1 (items 0..15) to be dispatched and processed
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(recordedBatches.length, 1, 'Batch 1 must be dispatched initially');
    assert.equal(recordedBatches[0].model, primaryModel, 'Batch 1 initial send must be on primaryModel');
    assert.equal(recordedBatches[0].fallbackConsumed, false, 'Batch 1 must not have fallbackConsumed set initially');
    assert.equal(recordedBatches[0].itemCount, 16, 'Batch 1 must contain 16 items');

    // Verify pin has propagated into scrollSession state
    const session = dom.getScrollSession();
    assert.equal(session.fallbackConsumed, true, 'scrollSession.fallbackConsumed must be pinned to true');
    assert.equal(session.fallbackModel, fallbackModel, `scrollSession.fallbackModel must be pinned to ${fallbackModel}`);
    assert.ok(session.fallbackConsumedIds.size >= 16, 'fallbackConsumedIds must track Batch 1 items');

    // Now, scroll down: block 2 (16 items: 16..31) becomes ready in the SAME run
    session.readyBlocks.add(env.block2);
    dom.flushReadyBlocks();

    // Wait for Batch 2 to be dispatched and processed
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Assertions matching acceptance criteria:
    // 1. Total batches dispatched: exactly 2
    assert.equal(recordedBatches.length, 2, 'Batch 2 must be dispatched for next 16 items');

    // 2. Batch 2 used fallback model directly!
    assert.equal(
      recordedBatches[1].model,
      fallbackModel,
      `Next 16 items in SAME run must use fallback model (${fallbackModel}), NOT primary (${primaryModel})`
    );

    // 3. Batch 2 carried fallbackConsumed: true flag
    assert.equal(
      recordedBatches[1].fallbackConsumed,
      true,
      'Next 16 items must pass fallbackConsumed: true so SW does not escalate further'
    );

    // 4. Batch 2 contains the next 16 items (items 16..31)
    assert.equal(recordedBatches[1].itemCount, 16, 'Batch 2 must contain exactly 16 items');

    // 5. Total applied count reflects all 32 items
    const status = dom.getStatus();
    assert.equal(status.totalApplied, 32, 'All 32 items across both batches must be applied');
    assert.equal(status.actualModel, fallbackModel, 'Status actualModel must report fallbackModel');
  } finally {
    env.restore();
  }
});

// ============================================================================
// 2. Mandatory Test 2: Pin reset run mới
// init run/session mới (user Dịch / auto-start mới) → fallbackConsumed/fallbackModel
// về primary hiện tại của settings; run mới với primary mới gửi đúng primary mới, không dính fallback cũ.
// ============================================================================
test('WI-37: Pin reset run mới (user Dịch / startScrollFollowSession) — fallbackConsumed/fallbackModel về settings hiện tại, run mới gửi đúng primary mới không dính fallback cũ', async () => {
  const env = setupDomEnvironment();
  try {
    const dom = env.dom;
    const session = dom.getScrollSession();

    // Simulate prior run where fallback was consumed and pinned
    const oldPrimary = 'ag/old-primary';
    const oldFallback = 'ag/claude-3-5-sonnet';
    session.fallbackConsumed = true;
    session.fallbackModel = oldFallback;
    session.runConfig = { revision: 1, fallbackConsumed: true, model: oldFallback };
    if (!session.fallbackConsumedIds) session.fallbackConsumedIds = new Set();
    session.fallbackConsumedIds.add('old-item-1');
    session.fallbackConsumedIds.add('old-item-2');

    assert.equal(session.fallbackConsumed, true, 'Precondition: fallbackConsumed was true');
    assert.equal(session.fallbackModel, oldFallback, 'Precondition: fallbackModel was oldFallback');
    assert.ok(session.fallbackConsumedIds.size > 0, 'Precondition: fallbackConsumedIds had entries');

    // User triggers new translation session ("Dịch ngay") with brand new primary model
    const newPrimary = 'ag/new-primary-gpt4o';
    const recordedBatches = [];

    env.setBatchResponseHandler((msg, cb) => {
      const payload = msg.payload || {};
      recordedBatches.push({
        action: msg.action,
        model: payload.model,
        fallbackConsumed: Boolean(payload.fallbackConsumed),
        itemCount: payload.items?.length || 0
      });
      setTimeout(() => {
        cb({
          ok: true,
          results: payload.items.map((it) => ({
            id: it.id,
            revision: it.revision,
            text: `[NEW-PRIMARY] ${it.text}`
          })),
          actualModel: newPrimary,
          fallbackIndex: 0
        });
      }, 10);
    });

    // Start fresh scroll session with newPrimary
    dom.startScrollFollowSession({
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: newPrimary
    });

    // 1. Verify immediate reset of fallback state in scrollSession
    assert.equal(session.fallbackConsumed, false, 'fallbackConsumed must reset to false on new session');
    assert.equal(session.fallbackModel, null, 'fallbackModel must reset to null on new session');
    assert.equal(session.fallbackConsumedIds.size, 0, 'fallbackConsumedIds must be cleared on new session');
    assert.equal(session.runConfig.fallbackConsumed, false, 'runConfig.fallbackConsumed must be false');
    assert.equal(session.runConfig.model, null, 'runConfig.model must be null');

    // 2. Wait for initial batch of new session to dispatch
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(recordedBatches.length >= 1, 'New run must dispatch at least 1 batch');

    // 3. New run must send newPrimary, NOT oldFallback!
    assert.equal(
      recordedBatches[0].model,
      newPrimary,
      `New run must send newPrimary (${newPrimary}), NOT oldFallback (${oldFallback})`
    );

    // 4. New run must NOT carry fallbackConsumed flag from old run
    assert.equal(
      recordedBatches[0].fallbackConsumed,
      false,
      'New run must NOT have fallbackConsumed: true'
    );
  } finally {
    env.restore();
  }
});

