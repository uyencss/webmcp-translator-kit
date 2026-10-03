import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// WI-26: scroll-follow batch đầu quét mọi thẻ (bug thật trên douyin)
// ============================================================================

test('WI-26: DOM fixture with text in div/span outside BLOCK_SELECTOR included in initial batch without scrolling', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
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

    // Douyin-style fixture: title and author are in DIV/SPAN elements, completely outside BLOCK_SELECTOR
    const videoCard = fakeEl('DIV', { left: 0, top: 50, right: 600, bottom: 150, height: 100 });
    const spanTitle = fakeEl('SPAN', { left: 10, top: 55, right: 450, bottom: 95, height: 40 });
    spanTitle.parentElement = videoCard;
    const nodeTitle = { nodeType: 3, nodeValue: '抖音热门视频标题 (Douyin Viral Video Title)', parentElement: spanTitle, isConnected: true };

    const divAuthor = fakeEl('DIV', { left: 10, top: 105, right: 250, bottom: 140, height: 35 });
    divAuthor.parentElement = videoCard;
    const nodeAuthor = { nodeType: 3, nodeValue: '创作者: 抖音小助手 (Creator: Douyin Assistant)', parentElement: divAuthor, isConnected: true };

    // A block selector element far down below the initial viewport ([0, 1600])
    const pBelow = fakeEl('P', { left: 0, top: 3200, right: 600, bottom: 3300, height: 100 });
    const nodeBelow = { nodeType: 3, nodeValue: 'Bình luận bên dưới khi người dùng scroll trang', parentElement: pBelow, isConnected: true };

    const allTextNodes = [nodeTitle, nodeAuthor, nodeBelow];

    const scrollListeners = [];
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

    let translationRequests = 0;
    const requestedBatches = [];

    const runtime = {
      id: 'test-ext-id', lastError: null, onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        if (msg?.action === 'WIDGET_GET_STATE') {
          cb({ effective: 'on', permission: true, hasKey: true, autoStart: false, widgetVisible: true });
        } else if (msg?.action === 'TRANSLATE_BATCH') {
          translationRequests++;
          requestedBatches.push(msg.payload.items);
          const items = msg.payload.items;
          const results = items.map((it) => ({
            id: it.id,
            text: '[vi] ' + it.text,
            revision: it.revision
          }));
          cb({
            ok: true,
            results,
            missingIds: [],
            failed: 0,
            partial: false
          });
        } else if (typeof cb === 'function') cb({ ok: true });
      }
    };

    let rafCallbacks = [];
    globalThis.chrome = { runtime };
    globalThis.window = win;
    globalThis.document = {
      documentElement: fakeEl('HTML'), body: fakeEl('BODY'),
      getElementById: () => null,
      createElement: (tag) => fakeEl(tag),
      createTreeWalker: (root) => {
        let list;
        if (root === pBelow) {
          list = [nodeBelow];
        } else if (root === videoCard) {
          list = [nodeTitle, nodeAuthor];
        } else {
          list = allTextNodes;
        }
        let cursor = 0;
        return { nextNode: () => list[cursor++] || null };
      },
      // BLOCK_SELECTOR only matches pBelow (not div or span)
      querySelectorAll: (selector) => {
        if (selector === 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote') {
          return [pBelow];
        }
        return [];
      },
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'https:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };
    globalThis.cancelAnimationFrame = (id) => {
      if (id > 0 && id <= rafCallbacks.length) rafCallbacks[id - 1] = null;
    };
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;
    assert.ok(dom, 'content must expose __translatorDom');

    // 1. Start scroll-follow session WITHOUT scrolling
    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Acceptance 2a: initial batch contains the text in div/span outside BLOCK_SELECTOR
    assert.ok(translationRequests >= 1, 'Initial batch must be dispatched without user scrolling');
    const firstBatch = requestedBatches[0];
    assert.ok(firstBatch, 'First batch must exist');

    const firstBatchTexts = firstBatch.map(it => it.text);
    assert.ok(
      firstBatchTexts.some(t => t.includes('抖音热门视频标题')),
      'Initial batch must contain span title text outside BLOCK_SELECTOR'
    );
    assert.ok(
      firstBatchTexts.some(t => t.includes('创作者: 抖音小助手')),
      'Initial batch must contain div author text outside BLOCK_SELECTOR'
    );
    assert.ok(
      !firstBatchTexts.some(t => t.includes('Bình luận bên dưới')),
      'Initial batch must NOT contain out-of-viewport text'
    );

    // Verify DOM replacement happened as usual
    assert.ok(
      nodeTitle.nodeValue.startsWith('[vi]'),
      `span title nodeValue must be replaced with translated text, got: "${nodeTitle.nodeValue}"`
    );
    assert.ok(
      nodeAuthor.nodeValue.startsWith('[vi]'),
      `div author nodeValue must be replaced with translated text, got: "${nodeAuthor.nodeValue}"`
    );

    // 2. Now user scrolls: pBelow comes into viewport
    assert.ok(scrollListeners.length > 0, 'Scroll listener must be registered');
    pBelow.setRect({ left: 0, top: 120, right: 600, bottom: 220, height: 100 });

    for (const listener of scrollListeners) {
      listener();
    }
    // Flush rAF
    while (rafCallbacks.length > 0) {
      const cbs = rafCallbacks.slice();
      rafCallbacks = [];
      for (const cb of cbs) {
        if (typeof cb === 'function') cb(performance.now());
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 400));

    // Acceptance 2b: scrolling continues to work and dispatches subsequent batches
    assert.equal(translationRequests, 2, 'Scrolling into view must dispatch next batch for pBelow');
    const secondBatch = requestedBatches[1];
    const secondBatchTexts = secondBatch.map(it => it.text);
    assert.ok(
      secondBatchTexts.some(t => t.includes('Bình luận bên dưới')),
      'Second batch on scroll must contain pBelow text'
    );
    assert.ok(
      !secondBatchTexts.some(t => t.includes('抖音热门视频标题')),
      'Second batch must NOT re-include already translated span title'
    );
    assert.ok(
      nodeBelow.nodeValue.startsWith('[vi]'),
      `nodeBelow must be translated on scroll, got: "${nodeBelow.nodeValue}"`
    );

    dom.stopScrollFollowSession();
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

test('WI-26: initial sweep ignores hidden or data-wmt-ignore DIV/SPAN nodes', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    function fakeEl(tagName = 'DIV', initialRect = { left: 0, top: 0, right: 500, bottom: 50, height: 50 }, attrs = {}) {
      let rect = { ...initialRect };
      const el = {
        nodeType: 1,
        style: {}, dataset: {}, tagName, id: attrs.id || '', isConnected: true,
        appendChild(c) { return c; },
        setAttribute() {},
        getAttribute: (name) => attrs[name] || null,
        hasAttribute: (name) => Boolean(attrs[name]),
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
        closest: (sel) => {
          if (sel === '[data-wmt-ignore]' && attrs['data-wmt-ignore']) return el;
          if (sel === '#__wmt-widget-host' && attrs.id === '__wmt-widget-host') return el;
          return null;
        },
        getBoundingClientRect: () => rect,
        setRect(r) { rect = { ...r }; },
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isContentEditable: false, parentElement: null
      };
      return el;
    }

    const visibleSpan = fakeEl('SPAN', { left: 0, top: 20, right: 300, bottom: 60, height: 40 });
    const nodeVisible = { nodeType: 3, nodeValue: 'Visible Douyin Title', parentElement: visibleSpan, isConnected: true };

    const ignoredDiv = fakeEl('DIV', { left: 0, top: 70, right: 300, bottom: 100, height: 30 }, { 'data-wmt-ignore': 'true' });
    const nodeIgnored = { nodeType: 3, nodeValue: 'Ignored text in douyin widget', parentElement: ignoredDiv, isConnected: true };

    const hiddenDiv = fakeEl('DIV', { left: 0, top: 110, right: 300, bottom: 140, height: 30 }, { hidden: 'true' });
    const nodeHidden = { nodeType: 3, nodeValue: 'Hidden subtitle', parentElement: hiddenDiv, isConnected: true };

    const allTextNodes = [nodeVisible, nodeIgnored, nodeHidden];

    const win = {
      innerHeight: 800, innerWidth: 1200, top: null,
      addEventListener: () => {}, removeEventListener: () => {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;

    const requestedBatches = [];
    const runtime = {
      id: 'test-ext-id', lastError: null, onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        if (msg?.action === 'TRANSLATE_BATCH') {
          requestedBatches.push(msg.payload.items);
          cb({
            ok: true,
            results: msg.payload.items.map(it => ({ id: it.id, text: '[vi] ' + it.text, revision: it.revision })),
            missingIds: [], failed: 0, partial: false
          });
        } else if (typeof cb === 'function') cb({ ok: true });
      }
    };

    globalThis.chrome = { runtime };
    globalThis.window = win;
    globalThis.document = {
      documentElement: fakeEl('HTML'), body: fakeEl('BODY'),
      getElementById: () => null, createElement: (tag) => fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return { nextNode: () => allTextNodes[cursor++] || null };
      },
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'https:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;

    dom.startScrollFollowSession({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(requestedBatches.length, 1, 'Exactly one initial batch sent');
    const texts = requestedBatches[0].map(it => it.text);
    assert.deepEqual(texts, ['Visible Douyin Title'], 'Initial sweep must only include visible, non-ignored text');

    dom.stopScrollFollowSession();
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

test('WI-26: full-page mode behavior remains unchanged and translates all eligible text nodes', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    function fakeEl(tagName = 'DIV') {
      return {
        nodeType: 1,
        style: {}, dataset: {}, tagName, id: '', isConnected: true,
        appendChild(c) { return c; },
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
        closest: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 50, height: 50 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isContentEditable: false, parentElement: null
      };
    }

    const divA = fakeEl('DIV');
    const nodeA = { nodeType: 3, nodeValue: 'Full page div text', parentElement: divA, isConnected: true };
    const spanB = fakeEl('SPAN');
    const nodeB = { nodeType: 3, nodeValue: 'Full page span text', parentElement: spanB, isConnected: true };
    const pC = fakeEl('P');
    const nodeC = { nodeType: 3, nodeValue: 'Full page p text', parentElement: pC, isConnected: true };
    const nodes = [nodeA, nodeB, nodeC];

    const win = {
      innerHeight: 800, innerWidth: 1200, top: null,
      addEventListener: () => {}, removeEventListener: () => {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;

    const requestedBatches = [];
    const runtime = {
      id: 'test-ext-id', lastError: null, onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        if (msg?.action === 'TRANSLATE_BATCH') {
          requestedBatches.push(msg.payload.items);
          cb({
            ok: true,
            results: msg.payload.items.map(it => ({ id: it.id, text: '[vi] ' + it.text, revision: it.revision })),
            missingIds: [], failed: 0, partial: false
          });
        } else if (typeof cb === 'function') cb({ ok: true });
      }
    };

    globalThis.chrome = { runtime };
    globalThis.window = win;
    globalThis.document = {
      documentElement: fakeEl('HTML'), body: fakeEl('BODY'),
      getElementById: () => null, createElement: (tag) => fakeEl(tag),
      createTreeWalker: () => {
        let cursor = 0;
        return { nextNode: () => nodes[cursor++] || null };
      },
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}
    };
    globalThis.location = { protocol: 'https:' };
    globalThis.NodeFilter = { SHOW_TEXT: 4 };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    class FakeObserver { constructor() {} observe() {} unobserve() {} disconnect() {} }
    globalThis.IntersectionObserver = FakeObserver;
    globalThis.MutationObserver = FakeObserver;

    vm.runInThisContext(contentSrc, { filename: 'content.js' });
    const dom = win.__translatorDom;

    const res = await dom.executeTranslation({ sourceLanguage: 'auto', targetLanguage: 'vi', model: 'ag/m' });
    assert.equal(res.ok, true, 'Full page translation must succeed');
    assert.equal(res.collected, 3, 'All 3 nodes collected in full page mode');
    assert.equal(res.applied, 3, 'All 3 nodes applied');
    assert.ok(nodeA.nodeValue.startsWith('[vi]'), 'nodeA translated');
    assert.ok(nodeB.nodeValue.startsWith('[vi]'), 'nodeB translated');
    assert.ok(nodeC.nodeValue.startsWith('[vi]'), 'nodeC translated');
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});

