// WebMCP Translator Kit — WI-32 Unit Tests
// Watchdog reconciliation + Bisect retry for zero-item / truncated batches
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createDirect9Router } from '../extension/src/adapter/direct9router.mjs';
import { reconcileWatchdog } from '../extension/src/sw.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastOptions = {
  timeoutMs: 5000,
  listModelsTimeoutMs: 1000,
  maxRetries: 0,
  maxTimeoutRetries: 0,
  retryInitialDelayMs: 10,
  retryMaxDelayMs: 20,
  retryTimeoutDelayMs: 10,
  retryJitterRatio: 0
};

// ============================================================================
// 1. Bisect retry: 49 items fail -> halves -> đủ results
// ============================================================================
test('bisect hội tụ (49 items fail → halves → đủ results)', async () => {
  const items = [];
  for (let i = 0; i < 49; i++) {
    items.push({
      id: `node_${i}`,
      revision: 0,
      text: `Paragraph content line number ${i} for translation testing.`
    });
  }

  const calls = [];
  const enc = new TextEncoder();

  const fetchImpl = async (url, opts) => {
    const payload = JSON.parse(opts.body);
    const userMsg = JSON.parse(payload.messages[1].content);
    calls.push({ count: userMsg.length, ids: userMsg.map((it) => it.id) });

    // When batch has 49 items: simulate gemini-3.8-flash truncated zero-item output
    if (userMsg.length === 49) {
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"results": [{"id": "' + userMsg[0].id + '", ' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ];
      let idx = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: async () => idx < chunks.length ? { done: false, value: enc.encode(chunks[idx++]) } : { done: true },
            cancel: async () => {}
          })
        }
      };
    }

    // Halves (<= 25 items): successfully translated
    const results = userMsg.map((it) => ({
      id: it.id,
      revision: it.revision,
      text: `[vi] ${it.text}`
    }));
    const sseBody = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ results }) } }] })}\n\ndata: [DONE]\n\n`;
    let readDone = false;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => {
            if (!readDone) {
              readDone = true;
              return { done: false, value: enc.encode(sseBody) };
            }
            return { done: true };
          },
          cancel: async () => {}
        })
      }
    };
  };

  const router = createDirect9Router({
    baseURL: 'http://127.0.0.1:9090/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.8-flash',
    fetchImpl,
    ...fastOptions
  });

  const res = await router.translateBatch({ items });

  assert.ok(!res.error, `translateBatch must succeed after bisect: ${JSON.stringify(res.error)}`);
  assert.equal(res.results.length, 49, 'Must converge to all 49 results');
  assert.equal(res.partial, false, 'Batch must not be partial when all items succeed');
  assert.deepEqual(res.missingIds, [], 'missingIds must be empty');

  // Verify that initial 49 items failed, then 25 items and 24 items were requested
  assert.equal(calls.length, 3, 'Must have made exactly 3 provider calls: 1 initial (49) + 2 halves (25, 24)');
  assert.equal(calls[0].count, 49, 'First call must be 49 items');
  assert.equal(calls[1].count, 25, 'Second call must be first half of 25 items');
  assert.equal(calls[2].count, 24, 'Third call must be second half of 24 items');

  // Verify all 49 items are present in final results
  const resIds = new Set(res.results.map((r) => r.id));
  assert.equal(resIds.size, 49);
  for (let i = 0; i < 49; i++) {
    assert.ok(resIds.has(`node_${i}`));
  }
});

// ============================================================================
// 2. Stream-rỗng error ngay không retry
// ============================================================================
test('stream-rỗng error ngay không retry', async () => {
  let callCount = 0;
  const enc = new TextEncoder();

  const fetchImpl = async () => {
    callCount++;
    // SSE stream with 0 content bytes
    const chunks = ['data: [DONE]\n\n'];
    let idx = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => idx < chunks.length ? { done: false, value: enc.encode(chunks[idx++]) } : { done: true },
          cancel: async () => {}
        })
      }
    };
  };

  const router = createDirect9Router({
    baseURL: 'http://127.0.0.1:9090/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.8-flash',
    fetchImpl,
    ...fastOptions
  });

  const items = [
    { id: 'item_1', revision: 0, text: 'Hello 1' },
    { id: 'item_2', revision: 0, text: 'Hello 2' },
    { id: 'item_3', revision: 0, text: 'Hello 3' },
    { id: 'item_4', revision: 0, text: 'Hello 4' },
    { id: 'item_5', revision: 0, text: 'Hello 5' }
  ];

  const res = await router.translateBatch({ items });

  assert.ok(res.error, 'Must return error on empty stream');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
  assert.equal(callCount, 1, 'Stream-rỗng must error immediately without retry or bisect');
});

// ============================================================================
// 3. Abort giữa bisect dừng sạch
// ============================================================================
test('abort giữa bisect dừng sạch', async () => {
  const controller = new AbortController();
  const items = [];
  for (let i = 0; i < 49; i++) {
    items.push({ id: `node_${i}`, revision: 0, text: `Text ${i}` });
  }

  let callCount = 0;
  const enc = new TextEncoder();

  const fetchImpl = async (url, opts) => {
    callCount++;
    const payload = JSON.parse(opts.body);
    const userMsg = JSON.parse(payload.messages[1].content);

    if (userMsg.length === 49) {
      // 49 items: fails with zero item truncated stream
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"results": [{"id": "' + userMsg[0].id + '", ' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ];
      let idx = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: async () => idx < chunks.length ? { done: false, value: enc.encode(chunks[idx++]) } : { done: true },
            cancel: async () => {}
          })
        }
      };
    }

    // During first half: caller aborts
    controller.abort('caller_abort_test');
    throw new DOMException('The operation was aborted', 'AbortError');
  };

  const router = createDirect9Router({
    baseURL: 'http://127.0.0.1:9090/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.8-flash',
    fetchImpl,
    ...fastOptions
  });

  const res = await router.translateBatch({ items, signal: controller.signal });

  assert.ok(res.error, 'Must return error on abort');
  assert.equal(res.error.code, 'ABORTED');
  assert.equal(callCount, 2, 'Second half (24 items) must never be dispatched after abort in first half');
});

// ============================================================================
// 4. Watchdog 2 vòng rồi dừng + failed-count đúng
// ============================================================================
test('watchdog 2 vòng rồi dừng + failed-count đúng (SW helper)', () => {
  // Scenario A: Initial check with 83 collected, 48 applied, 3 already failed -> 32 unapplied
  const state0 = {
    queueLength: 0,
    inFlight: 0,
    watching: true,
    collected: 83,
    applied: 48,
    failed: 3,
    rounds: 0,
    lastApplied: 0
  };

  // Round 1 triggers re-queue
  const round1 = reconcileWatchdog(state0);
  assert.equal(round1.shouldRequeue, true);
  assert.equal(round1.stable, false);
  assert.equal(round1.rounds, 1);
  assert.equal(round1.lastApplied, 48);
  assert.equal(round1.unappliedCount, 32);

  // Scenario B: Round 1 finishes with NO PROGRESS (applied still 48)
  const state1NoProgress = {
    queueLength: 0,
    inFlight: 0,
    watching: true,
    collected: 83,
    applied: 48,
    failed: 3,
    rounds: 1,
    lastApplied: 48
  };

  // Must stop immediately: no infinite loop when no progress made
  const stoppedNoProgress = reconcileWatchdog(state1NoProgress);
  assert.equal(stoppedNoProgress.shouldRequeue, false);
  assert.equal(stoppedNoProgress.stable, true);
  assert.equal(stoppedNoProgress.failed, 35, 'Remainder must be added to failed-count: 3 + 32 = 35');
  assert.equal(stoppedNoProgress.unappliedRemainder, 32);
  assert.equal(stoppedNoProgress.stoppedReason, 'no_progress');
  assert.ok(stoppedNoProgress.logEntry, 'Must generate Log entry');
  assert.equal(stoppedNoProgress.logEntry.code, 'WATCHDOG_UNAPPLIED');

  // Scenario C: Round 1 made progress (applied increased to 64) -> Round 2 triggers
  const state1Progress = {
    queueLength: 0,
    inFlight: 0,
    watching: true,
    collected: 83,
    applied: 64,
    failed: 3,
    rounds: 1,
    lastApplied: 48
  };
  const round2 = reconcileWatchdog(state1Progress);
  assert.equal(round2.shouldRequeue, true);
  assert.equal(round2.rounds, 2);
  assert.equal(round2.lastApplied, 64);
  assert.equal(round2.unappliedCount, 16); // 83 - 64 - 3 = 16

  // Scenario D: Round 2 finishes (max 2 rounds reached)
  const state2MaxRounds = {
    queueLength: 0,
    inFlight: 0,
    watching: true,
    collected: 83,
    applied: 64,
    failed: 3,
    rounds: 2,
    lastApplied: 64
  };
  const stoppedMaxRounds = reconcileWatchdog(state2MaxRounds);
  assert.equal(stoppedMaxRounds.shouldRequeue, false);
  assert.equal(stoppedMaxRounds.stable, true);
  assert.equal(stoppedMaxRounds.rounds, 2);
  assert.equal(stoppedMaxRounds.failed, 19, 'Remainder must be added to failed-count: 3 + 16 = 19');
  assert.equal(stoppedMaxRounds.unappliedRemainder, 16);
  assert.equal(stoppedMaxRounds.stoppedReason, 'max_rounds');
  assert.equal(stoppedMaxRounds.logEntry.code, 'WATCHDOG_UNAPPLIED');
});

test('watchdog 2 vòng rồi dừng + failed-count đúng (Content.js DOM runtime)', async () => {
  const contentPath = path.join(__dirname, '..', 'extension', 'src', 'content.js');
  const contentSrc = fs.readFileSync(contentPath, 'utf8');

  const saved = {};
  for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
    if (k in globalThis) saved[k] = globalThis[k];
  }

  try {
    function fakeEl(tagName = 'DIV') {
      return {
        nodeType: 1, style: {}, dataset: {}, tagName, id: '', isConnected: true,
        setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {},
        querySelector: () => fakeEl(), querySelectorAll: () => [],
        setPointerCapture() {}, releasePointerCapture() {}, attachShadow: () => fakeEl(),
        closest: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 50, height: 50 }),
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
        focus() {}, click() {}, isContentEditable: false, parentElement: null
      };
    }

    const parent = fakeEl('P');
    const nodes = [];
    for (let i = 0; i < 32; i++) {
      nodes.push({
        nodeType: 3,
        nodeValue: `Text item number ${i}`,
        parentElement: parent,
        isConnected: true
      });
    }

    const win = {
      innerHeight: 800, innerWidth: 1200, top: null,
      addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
      scrollTo() {}
    };
    win.top = win;

    const sentMessages = [];
    const runtime = {
      id: 'test-ext-id',
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => {
        sentMessages.push(msg);
        if (msg?.action === 'WIDGET_GET_STATE') {
          if (cb) cb({ effective: 'on', permission: true, hasKey: true, autoStart: false, widgetVisible: true });
        } else if (msg?.action === 'TRANSLATE_BATCH') {
          // Provider returns error (e.g. fatal INVALID_SCHEMA zero-item)
          if (cb) {
            setTimeout(() => {
              cb({
                error: { code: 'INVALID_SCHEMA', message: 'Translated content missing results array' },
                fatal: true,
                applied: 0,
                failed: msg.payload?.items?.length || 0
              });
            }, 5);
          }
        } else if (msg?.action === 'RECORD_ERROR_LOG') {
          if (cb) cb({ ok: true });
        }
        return Promise.resolve({ ok: true });
      }
    };

    globalThis.window = win;
    globalThis.document = {
      documentElement: fakeEl('HTML'),
      body: fakeEl('BODY'),
      createElement: (t) => fakeEl(t),
      getElementById: () => null,
      addEventListener() {}, removeEventListener() {},
      querySelectorAll: (sel) => (sel === 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote' ? [parent] : []),
      createTreeWalker: () => {
        let i = 0;
        return {
          nextNode: () => (i < nodes.length ? nodes[i++] : null)
        };
      }
    };
    globalThis.location = { href: 'http://example.com/test', origin: 'http://example.com' };
    globalThis.chrome = {
      runtime,
      storage: { session: { set: async () => {}, get: async () => ({}) }, local: { get: async () => ({}) } }
    };
    globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
    globalThis.IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
    globalThis.MutationObserver = class {
      observe() {} disconnect() {}
    };

    vm.runInThisContext(contentSrc);

    const dom = win.__translatorDom;
    assert.ok(dom, 'window.__translatorDom must exist');

    // Collect all 32 nodes
    const col = dom.collect();
    assert.equal(col.length, 32, 'Must collect 32 nodes');

    // Start scroll-follow session with fast watchdog backoff (10ms)
    dom.startScrollFollowSession({ watchdogBackoffMs: 10 });
    const sess = dom.getScrollSession();
    assert.equal(sess.watching, true);

    // Initial batch dispatch will fail via mock
    dom.flushReadyBlocks();

    // Wait for watchdog rounds to execute and settle
    await new Promise((r) => setTimeout(r, 120));

    const status = dom.getStatus();
    assert.equal(status.stable, true, 'Status must be marked stable');
    assert.equal(status.totalFailed, 32, 'failed-count must accurately show 32 failed items');
    assert.equal(sess.failedIds.size, 32, 'failedIds must contain all 32 items');

    // Verify RECORD_ERROR_LOG was dispatched to SW with WATCHDOG_UNAPPLIED
    const logMsg = sentMessages.find((m) => m?.action === 'RECORD_ERROR_LOG' && m?.error?.code === 'WATCHDOG_UNAPPLIED');
    assert.ok(logMsg, 'RECORD_ERROR_LOG with WATCHDOG_UNAPPLIED must be dispatched');
    assert.equal(logMsg.error.details.unappliedCount, 32);
  } finally {
    for (const k of ['window', 'document', 'location', 'chrome', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'IntersectionObserver', 'MutationObserver']) {
      if (k in saved) globalThis[k] = saved[k];
      else delete globalThis[k];
    }
  }
});
