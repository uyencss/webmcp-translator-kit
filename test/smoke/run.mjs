// Automated Smoke Test Suite for WebMCP Translator Kit (Direct Slice)
// Validates: Load extension, translate & patch, skip list, restore, and typed 429 error.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeServer } from './fake-9router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..', '..', 'extension', 'dist');
const DEFAULT_CHROME = path.join(
  process.env.HOME || '',
  '.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);

// Known Extension ID calculated from manifest key
const EXPECTED_EXT_ID = 'feicbphhimmhddfdlahlfmhkhodkdffl';
const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';

function getChromeBin() {
  const b = process.env.CHROME_BIN || DEFAULT_CHROME;
  if (!fs.existsSync(b)) {
    throw new Error(`CHROME_NOT_FOUND: ${b}`);
  }
  return b;
}

function fetchJson(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.callbacks = new Map();
    this.eventListeners = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('WebSocket connection failed: ' + e?.message));
      this.ws.onmessage = async (event) => {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        try {
          const msg = JSON.parse(text);
          if (msg.id && this.callbacks.has(msg.id)) {
            const { resolve: res, reject: rej } = this.callbacks.get(msg.id);
            this.callbacks.delete(msg.id);
            if (msg.error) rej(new Error('CDP error: ' + JSON.stringify(msg.error)));
            else res(msg.result);
          }
          for (const listener of this.eventListeners) {
            listener(msg);
          }
        } catch {}
      };
    });
  }

  addEventListener(listener) {
    this.eventListeners.push(listener);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP Timeout on ${method}`));
        }
      }, 60000);

      this.callbacks.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });

      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  async evaluate(expression, sessionId = undefined, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error('EVAL_ERROR: ' + JSON.stringify(r.exceptionDetails));
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

async function runSingleAttempt() {
  const FAKE_PORT = 8089;
  const fakeServer = createFakeServer(FAKE_PORT);
  await fakeServer.start();
  console.log(`[1/6] Fake 9router running at http://127.0.0.1:${FAKE_PORT}`);

  const chromeBin = getChromeBin();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-slice-'));

  let chromeProc = null;
  let cdp = null;
  const testResults = [];

  function record(id, name, pass, detail = '') {
    testResults.push({ id, name, pass, detail });
  }

  try {
    console.log(`[2/6] Launching Chrome for Testing with unpacked extension...`);
    chromeProc = spawn(chromeBin, [
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=SafeBrowsing',
      '--window-size=1200,800',
      `--user-data-dir=${profileDir}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      'about:blank'
    ], {
      stdio: 'ignore',
      detached: process.platform !== 'win32'
    });

    // Wait for DevToolsActivePort
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    const t0 = Date.now();
    let cdpPort = 0;
    while (Date.now() - t0 < 15000) {
      await sleep(100);
      try {
        const raw = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        cdpPort = parseInt(raw[0], 10);
        if (cdpPort > 0) break;
      } catch {}
    }

    if (!cdpPort) {
      throw new Error('Chrome failed to expose DevTools port within 15s');
    }
    console.log(`[3/6] Chrome CDP ready on port ${cdpPort}`);

    const versionInfo = await fetchJson(cdpPort, '/json/version');
    cdp = new CdpConnection(versionInfo.webSocketDebuggerUrl);
    await cdp.connect();

    // Step 4: Discover & attach to extension service worker
    console.log(`[4/6] Discovering & attaching to extension Service Worker (${EXPECTED_EXT_ID})...`);

    let swTargetFound = null;
    const swPromise = new Promise((resolve) => {
      cdp.addEventListener((msg) => {
        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
          const info = msg.params?.targetInfo;
          if (info?.type === 'service_worker' && info?.url?.includes(EXPECTED_EXT_ID)) {
            swTargetFound = info;
            resolve(info);
          }
        }
      });
    });

    await cdp.send('Target.setDiscoverTargets', { discover: true });

    // Wait for SW target with clear 15s timeout
    const swTarget = await Promise.race([
      swPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout waiting for Service Worker target (${EXPECTED_EXT_ID}/sw.js) after 15s`)), 15000)
      )
    ]);

    const attachSwRes = await cdp.send('Target.attachToTarget', {
      targetId: swTarget.targetId,
      flatten: true
    });
    const swSessionId = attachSwRes.sessionId;
    console.log(`Attached to Service Worker targetId=${swTarget.targetId}, sessionId=${swSessionId}`);

    // Enable runtime domain on SW and wait briefly for execution context
    await cdp.send('Runtime.enable', {}, swSessionId);
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, swSessionId);
    await sleep(150);

    // Test 1: Load extension & SW responsive
    try {
      const pingRes = await cdp.evaluate('self.__translatorSw.dispatchMessage({ action: "PING" })', swSessionId);
      assert.ok(pingRes && pingRes.ok === true && pingRes.version === '0.1.0', 'PING response valid: ' + JSON.stringify(pingRes));
      record('T1', 'Load extension & SW responsive', true, `Version: ${pingRes.version}`);
    } catch (e) {
      record('T1', 'Load extension & SW responsive', false, e.message);
    }

    // Configure extension with fake 9router via Service Worker storage
    const fixtureOrigin = `http://127.0.0.1:${FAKE_PORT}`;
    const fixtureUrl = `http://127.0.0.1:${FAKE_PORT}/fixture.html`;

    await cdp.evaluate(`
      (async () => {
        const popupSender = { url: 'chrome-extension://${EXPECTED_EXT_ID}/popup.html' };
        await self.__translatorSw.dispatchMessage({
          action: 'SAVE_SETTINGS',
          settings: {
            baseURL: 'http://127.0.0.1:${FAKE_PORT}/v1',
            model: '${DEFAULT_MODEL}',
            sourceLanguage: 'auto',
            targetLanguage: 'vi'
          }
        }, popupSender);
        await self.__translatorSw.dispatchMessage({
          action: 'SET_KEY',
          key: 'fake-test-key'
        }, popupSender);
        await self.__translatorSw.dispatchMessage({
          action: 'SET_SITE_ENABLED',
          origin: '${fixtureOrigin}',
          enabled: true
        }, popupSender);
      })()
    `, swSessionId);

    // Open Chinese fixture tab
    const tabTarget = await cdp.send('Target.createTarget', { url: fixtureUrl });
    const attachTabRes = await cdp.send('Target.attachToTarget', {
      targetId: tabTarget.targetId,
      flatten: true
    });
    const fixtureSessionId = attachTabRes.sessionId;

    // Enable Runtime domain on fixture tab for message bridge binding
    await cdp.send('Runtime.enable', {}, fixtureSessionId);
    await cdp.send('Runtime.addBinding', { name: '__cdpSendToSw' }, fixtureSessionId);

    // Bridge messages between fixture tab and SW
    cdp.addEventListener(async (msg) => {
      if (msg.sessionId === fixtureSessionId && msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__cdpSendToSw') {
        const { callId, payload } = JSON.parse(msg.params.payload);
        try {
          const swRes = await cdp.evaluate(
            `self.__translatorSw.dispatchMessage(${JSON.stringify(payload)}, { frameId: 0, url: ${JSON.stringify(fixtureUrl)}, tab: { id: 1, url: ${JSON.stringify(fixtureUrl)} } })`,
            swSessionId
          );
          await cdp.evaluate(
            `window.__cdpReply(${JSON.stringify(callId)}, ${JSON.stringify(swRes)})`,
            fixtureSessionId,
            false
          );
        } catch (err) {
          await cdp.evaluate(
            `window.__cdpReply(${JSON.stringify(callId)}, { error: { message: ${JSON.stringify(err.message)} } })`,
            fixtureSessionId,
            false
          );
        }
      }
    });

    // Setup chrome.runtime messaging bridge on fixture tab
    await cdp.evaluate(`
      window.__bridgePending = new Map();
      window.__bridgeCallId = 1;
      window.__cdpReply = function(callId, response) {
        if (window.__bridgePending.has(callId)) {
          const cb = window.__bridgePending.get(callId);
          window.__bridgePending.delete(callId);
          cb(response);
        }
      };

      window.chrome = window.chrome || {};
      window.chrome.runtime = window.chrome.runtime || {};
      window.chrome.runtime.onMessage = {
        addListener: () => {},
        removeListener: () => {},
        hasListener: () => false
      };
      window.chrome.runtime.sendMessage = function(message, callback) {
        const callId = window.__bridgeCallId++;
        if (typeof callback === 'function') {
          window.__bridgePending.set(callId, callback);
        }
        window.__cdpSendToSw(JSON.stringify({ callId, payload: message }));
      };
    `, fixtureSessionId, false);

    // Inject content.js into the fixture tab
    const contentJsSource = fs.readFileSync(path.join(EXTENSION_DIR, 'content.js'), 'utf8');
    await cdp.evaluate(`${contentJsSource}\n;true;`, fixtureSessionId, false);

    // Verify initial Chinese text before translation
    const initialTitle = await cdp.evaluate('window.__fixture.getTitleText()', fixtureSessionId);
    const initialFav = await cdp.evaluate('window.__fixture.getFavText()', fixtureSessionId);
    assert.equal(initialTitle, '欢迎使用翻译系统');
    assert.equal(initialFav, '收藏');

    // Test 2: Translate and Patch DOM (SVG + listener intact)
    try {
      const trResult = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      assert.ok(trResult && trResult.ok === true, 'executeTranslation returned ok: ' + JSON.stringify(trResult));
      assert.ok(trResult.applied >= 3, `Expected at least 3 nodes applied, got ${trResult.applied}`);

      // Check text changed
      const translatedTitle = await cdp.evaluate('window.__fixture.getTitleText()', fixtureSessionId);
      const translatedFav = await cdp.evaluate('window.__fixture.getFavText()', fixtureSessionId);
      assert.equal(translatedTitle, '[vi] 欢迎使用翻译系统');
      assert.equal(translatedFav, '[vi] 收藏');

      // Check SVG preserved and click listener working
      const clicksBefore = await cdp.evaluate('window.__fixture.getClicks()', fixtureSessionId);
      await cdp.evaluate(`
        document.getElementById('fav').click();
        document.getElementById('fav').click();
      `, fixtureSessionId, false);
      const clicksAfter = await cdp.evaluate('window.__fixture.getClicks()', fixtureSessionId);
      const svgExists = await cdp.evaluate(`!!document.querySelector('#fav svg')`, fixtureSessionId);

      assert.equal(clicksBefore, 0);
      assert.equal(clicksAfter, 2);
      assert.equal(svgExists, true);

      record('T2', 'Translate + Patch DOM (SVG & listener intact)', true, `Applied: ${trResult.applied}, Clicks: 2, SVG kept`);
    } catch (e) {
      record('T2', 'Translate + Patch DOM (SVG & listener intact)', false, e.message);
    }

    // Test 3: Skip list check
    try {
      const codeVal = await cdp.evaluate('window.__fixture.getCodeText()', fixtureSessionId);
      const preVal = await cdp.evaluate('window.__fixture.getPreText()', fixtureSessionId);
      const inputVal = await cdp.evaluate('window.__fixture.getInputValue()', fixtureSessionId);
      const textareaVal = await cdp.evaluate('window.__fixture.getTextareaValue()', fixtureSessionId);
      const hiddenVal = await cdp.evaluate('window.__fixture.getHiddenText()', fixtureSessionId);

      assert.equal(codeVal, "const codeBlock = '保留代码';");
      assert.equal(preVal, "function preFormatted() { return '保持原样'; }");
      assert.equal(inputVal, '输入框内容');
      assert.equal(textareaVal, '多行文本输入');
      assert.equal(hiddenVal, '隐藏内容不可见');

      record('T3', 'Skip list elements untouched', true, 'code, pre, input, textarea, hidden all preserved');
    } catch (e) {
      record('T3', 'Skip list elements untouched', false, e.message);
    }

    // Test 4: Restore original
    try {
      const restoreRes = await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);
      assert.ok(restoreRes && restoreRes.restored >= 3, `Expected at least 3 restored, got ${restoreRes.restored}`);

      const restoredTitle = await cdp.evaluate('window.__fixture.getTitleText()', fixtureSessionId);
      const restoredFav = await cdp.evaluate('window.__fixture.getFavText()', fixtureSessionId);

      assert.equal(restoredTitle, '欢迎使用翻译系统');
      assert.equal(restoredFav, '收藏');

      record('T4', 'Restore original text', true, `Restored: ${restoreRes.restored} nodes`);
    } catch (e) {
      record('T4', 'Restore original text', false, e.message);
    }

    // Test 5: Typed Error on HTTP 429
    try {
      fakeServer.setMode('rate_limit_429');

      const errRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 'T1', revision: 0, text: '测试限流' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, {
          frameId: 0,
          url: '${fixtureUrl}',
          tab: { id: 1, url: '${fixtureUrl}' }
        })
      `, swSessionId, true);

      assert.ok(errRes && errRes.error, 'Expected error object, got: ' + JSON.stringify(errRes));
      assert.equal(errRes.error.code, 'HTTP_429', `Expected error code HTTP_429, got ${errRes.error.code}`);
      assert.equal(errRes.error.retryable, true, 'HTTP_429 should be retryable');
      assert.equal(errRes.error.details?.status, 429);
      assert.ok(typeof errRes.error.details?.retryAfterMs === 'number', 'retryAfterMs should be a number');

      record('T5', 'Typed error on HTTP 429', true, `Code: ${errRes.error.code}, Retryable: ${errRes.error.retryable}, RetryAfterMs: ${errRes.error.details.retryAfterMs}`);
    } catch (e) {
      record('T5', 'Typed error on HTTP 429', false, e.message);
    }

    // Test 6: Large batch 24 items (fake server) -> completes without timeout (chunked 16+8)
    try {
      fakeServer.setMode('normal');

      await cdp.evaluate(`
        const prevContent = document.getElementById('content');
        if (prevContent) prevContent.style.display = 'none';
        const prevBf = document.getElementById('below-fold');
        if (prevBf) prevBf.style.display = 'none';

        let t6Container = document.getElementById('t6-container');
        if (!t6Container) {
          t6Container = document.createElement('div');
          t6Container.id = 't6-container';
          document.body.appendChild(t6Container);
        }
        t6Container.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; padding: 10px; margin: 0;';
        t6Container.innerHTML = '';
        for (let i = 1; i <= 24; i++) {
          const span = document.createElement('span');
          span.className = 't6-item';
          span.style.cssText = 'display: inline-block; padding: 2px 4px; font-size: 12px;';
          span.textContent = '测试长文本批次第 ' + i + ' 节点';
          t6Container.appendChild(span);
        }
      `, fixtureSessionId, false);

      const t6Result = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      assert.ok(t6Result && t6Result.ok === true, 'T6 executeTranslation failed: ' + JSON.stringify(t6Result));
      assert.equal(t6Result.collected, 24, `Expected 24 collected nodes, got ${t6Result.collected}`);
      assert.equal(t6Result.applied, 24, `Expected 24 applied nodes, got ${t6Result.applied}`);

      const firstTranslated = await cdp.evaluate("document.querySelector('#t6-container span:first-child').textContent", fixtureSessionId);
      const lastTranslated = await cdp.evaluate("document.querySelector('#t6-container span:last-child').textContent", fixtureSessionId);
      assert.equal(firstTranslated, '[vi] 测试长文本批次第 1 节点');
      assert.equal(lastTranslated, '[vi] 测试长文本批次第 24 节点');

      record('T6', 'Large batch 24 items (no timeout)', true, `Collected: 24, Applied: 24, Single request (cap 64)`);
    } catch (e) {
      record('T6', 'Large batch 24 items (no timeout)', false, e.message);
    }

    // Test 7: Fake server delay 25s on 1st request -> retry and succeed (no TIMEOUT returned)
    try {
      fakeServer.clearLog();
      fakeServer.setMode('timeout_first');

      const t0 = Date.now();
      const t7Res = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [
              { id: 'T7-1', revision: 0, text: '延时重试第一项' },
              { id: 'T7-2', revision: 0, text: '延时重试第二项' }
            ],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, {
          frameId: 0,
          url: '${fixtureUrl}',
          tab: { id: 1, url: '${fixtureUrl}' }
        })
      `, swSessionId, true);
      const elapsed = Date.now() - t0;

      assert.ok(t7Res && !t7Res.error, 'T7 expected success without error, got: ' + JSON.stringify(t7Res));
      assert.ok(Array.isArray(t7Res.results) && t7Res.results.length === 2, 'T7 expected 2 translation results');
      assert.equal(t7Res.results[0].text, '[vi] 延时重试第一项');
      assert.equal(t7Res.results[1].text, '[vi] 延时重试第二项');
      assert.ok(elapsed >= 24000, `Expected elapsed >= 24000ms due to 25s initial delay, got ${elapsed}ms`);

      const logInfo = await fetchJson(FAKE_PORT, '/__admin/get-log');
      const reqCount = Array.isArray(logInfo?.log) ? logInfo.log.length : 0;
      assert.ok(reqCount >= 2, `Expected at least 2 requests logged on fake server, got ${reqCount}`);

      record('T7', 'Fake server 25s delay -> retry succeeds', true, `Elapsed: ${(elapsed / 1000).toFixed(1)}s, ${reqCount} requests, retry OK`);
    } catch (e) {
      record('T7', 'Fake server 25s delay -> retry succeeds', false, e.message);
    }

    // Test 8: Full DOM without scrolling (below-the-fold nodes translated)
    try {
      fakeServer.setMode('normal');

      // Clean up T6 elements and unhide content & below-fold
      await cdp.evaluate(`
        const t6 = document.getElementById('t6-container');
        if (t6) t6.remove();
        const content = document.getElementById('content');
        if (content) content.style.display = '';
        const bf = document.getElementById('below-fold');
        if (bf) bf.style.display = '';
        window.scrollTo(0, 0);
      `, fixtureSessionId, false);

      // Restore to ensure original Chinese text
      await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);

      // Assert scroll position is 0 before translation
      const scrollYBefore = await cdp.evaluate('window.scrollY', fixtureSessionId);
      assert.equal(scrollYBefore, 0, `Expected window.scrollY === 0 before translation, got ${scrollYBefore}`);

      // Verify below-fold paragraphs are in Chinese before translation
      const bfP1Before = await cdp.evaluate("window.__fixture.getBfP1Text()", fixtureSessionId);
      const bfP2Before = await cdp.evaluate("window.__fixture.getBfP2Text()", fixtureSessionId);
      assert.equal(bfP1Before, '折叠线下段落一');
      assert.equal(bfP2Before, '折叠线下段落二');

      // Execute translation on whole DOM
      const t8Result = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      assert.ok(t8Result && t8Result.ok === true, 'T8 executeTranslation failed: ' + JSON.stringify(t8Result));
      assert.ok(t8Result.applied >= 5, `Expected at least 5 nodes applied, got ${t8Result.applied}`);

      // Assert window was NEVER scrolled
      const scrollYAfter = await cdp.evaluate('window.scrollY', fixtureSessionId);
      assert.equal(scrollYAfter, 0, `Expected window.scrollY === 0 after translation (never scrolled), got ${scrollYAfter}`);

      // Assert both below-fold paragraphs are translated
      const bfP1After = await cdp.evaluate("window.__fixture.getBfP1Text()", fixtureSessionId);
      const bfP2After = await cdp.evaluate("window.__fixture.getBfP2Text()", fixtureSessionId);
      assert.equal(bfP1After, '[vi] 折叠线下段落一');
      assert.equal(bfP2After, '[vi] 折叠线下段落二');

      record('T8', 'Full DOM without scrolling', true, `scrollY: 0, below-fold paragraphs translated, applied: ${t8Result.applied}`);
    } catch (e) {
      record('T8', 'Full DOM without scrolling', false, e.message);
    }

    // Test 9: Single request batching (collected <= 64 items & <= 24 KiB in ONE request)
    try {
      fakeServer.setMode('normal');

      // Restore the page first
      const restoreRes = await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);
      assert.ok(restoreRes && restoreRes.restored >= 5, `T9 expected at least 5 nodes restored, got ${restoreRes?.restored}`);

      // Reset fake-server request counter
      fakeServer.clearLog();

      // Run executeTranslation
      const t9Result = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      assert.ok(t9Result && t9Result.ok === true, 'T9 executeTranslation failed: ' + JSON.stringify(t9Result));
      assert.ok(t9Result.collected <= 64, `Expected collected <= 64, got ${t9Result.collected}`);
      assert.ok(t9Result.applied === t9Result.collected, `Expected all collected nodes applied, got ${t9Result.applied}/${t9Result.collected}`);

      // Assert exactly 1 POST /chat/completions request was made
      const logInfo = await fetchJson(FAKE_PORT, '/__admin/get-log');
      const reqCount = Array.isArray(logInfo?.log) ? logInfo.log.length : 0;
      assert.equal(reqCount, 1, `Expected exactly 1 request to fake 9router for whole page, got ${reqCount}`);

      record('T9', 'Single request batching', true, `Collected: ${t9Result.collected}, Requests: ${reqCount} (single request batch)`);
    } catch (e) {
      record('T9', 'Single request batching', false, e.message);
    }

    // Test 10: Chunk recovery: retry + split, no abort
    try {
      fakeServer.setMode('normal');

      // Restore page first to ensure >= 24 untranslated nodes
      const restoreRes = await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);
      assert.ok(restoreRes && restoreRes.restored >= 24, `T10 expected >= 24 nodes restored, got ${restoreRes?.restored}`);

      // Wrap window.chrome.runtime.sendMessage to simulate chunk timeout on items.length > 16 twice
      await cdp.evaluate(`
        window.__injectFail = 0;
        window.__origSendMessage = window.chrome.runtime.sendMessage;
        window.chrome.runtime.sendMessage = function(message, callback) {
          if (
            message &&
            message.action === 'TRANSLATE_BATCH' &&
            message.payload &&
            Array.isArray(message.payload.items) &&
            message.payload.items.length > 16 &&
            window.__injectFail < 2
          ) {
            window.__injectFail++;
            if (typeof callback === 'function') {
              setTimeout(() => {
                callback({ error: { code: 'TIMEOUT', message: 'injected', retryable: false } });
              }, 10);
            }
            return;
          }
          return window.__origSendMessage.apply(this, arguments);
        };
      `, fixtureSessionId, false);

      const t10Result = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      const injectFailCount = await cdp.evaluate('window.__injectFail', fixtureSessionId);

      // Restore original sendMessage
      await cdp.evaluate(`
        if (window.__origSendMessage) {
          window.chrome.runtime.sendMessage = window.__origSendMessage;
          delete window.__origSendMessage;
        }
      `, fixtureSessionId, false);

      assert.ok(t10Result && t10Result.ok === true, 'T10 executeTranslation failed: ' + JSON.stringify(t10Result));
      assert.equal(t10Result.applied, t10Result.collected, `Expected applied (${t10Result.applied}) === collected (${t10Result.collected})`);
      assert.equal(t10Result.failed, 0, `Expected failed === 0, got ${t10Result.failed}`);
      assert.equal(injectFailCount, 2, `Expected __injectFail === 2, got ${injectFailCount}`);

      record('T10', 'Chunk recovery: retry + split, no abort', true, `Collected: ${t10Result.collected}, Applied: ${t10Result.applied}, Failed: 0, Injected: ${injectFailCount}`);
    } catch (e) {
      try {
        await cdp.evaluate(`
          if (window.__origSendMessage) {
            window.chrome.runtime.sendMessage = window.__origSendMessage;
            delete window.__origSendMessage;
          }
        `, fixtureSessionId, false);
      } catch {}
      record('T10', 'Chunk recovery: retry + split, no abort', false, e.message);
    }

    // Test 11: Storage access level TRUSTED_CONTEXTS
    try {
      const accessLevel = await cdp.evaluate(`
        (async () => {
          if (typeof chrome.storage?.local?.getAccessLevel === 'function') {
            return await chrome.storage.local.getAccessLevel();
          }
          return 'NOT_IMPLEMENTED';
        })()
      `, swSessionId, true);
      assert.equal(accessLevel, 'TRUSTED_CONTEXTS', `Expected TRUSTED_CONTEXTS, got ${accessLevel}`);
      record('T11', 'Storage access level TRUSTED_CONTEXTS', true, `Access level: ${accessLevel}`);
    } catch (e) {
      record('T11', 'Storage access level TRUSTED_CONTEXTS', false, e.message);
    }

    // Test 12: Forged payload ignored & sender enforced
    try {
      const forgedPayload = {
        tabId: 99,
        frameId: 0,
        origin: 'https://evil.example',
        items: [{ id: 'T12-1', revision: 0, text: '伪造测试' }],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: DEFAULT_MODEL
      };

      // 12a: Sender frameId 1 !== 0 -> PERMISSION_REQUIRED
      const res12a = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: ${JSON.stringify(forgedPayload)}
        }, { frameId: 1 })
      `, swSessionId, true);
      assert.equal(res12a?.error?.code, 'PERMISSION_REQUIRED', `Expected PERMISSION_REQUIRED, got ${res12a?.error?.code}`);

      // 12b: Sender frameId 0 but non-opted site -> OPT_IN_REQUIRED
      const notOptedSender = {
        frameId: 0,
        url: 'https://not-opted.example/page',
        tab: { id: 1, url: 'https://not-opted.example/page' }
      };
      const res12b = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: ${JSON.stringify(forgedPayload)}
        }, ${JSON.stringify(notOptedSender)})
      `, swSessionId, true);
      assert.equal(res12b?.error?.code, 'OPT_IN_REQUIRED', `Expected OPT_IN_REQUIRED, got ${res12b?.error?.code}`);

      // 12c: After SET_SITE_ENABLED for that origin -> allowed to call provider
      const popupSenderStr = JSON.stringify({ url: `chrome-extension://${EXPECTED_EXT_ID}/popup.html` });
      await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'SET_SITE_ENABLED',
          origin: 'https://not-opted.example',
          enabled: true
        }, ${popupSenderStr})
      `, swSessionId, true);

      const res12c = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: ${JSON.stringify(forgedPayload)}
        }, ${JSON.stringify(notOptedSender)})
      `, swSessionId, true);
      assert.ok(res12c && !res12c.error, `Expected successful translation after opt-in, got ${JSON.stringify(res12c)}`);
      assert.ok(Array.isArray(res12c.results) && res12c.results.length === 1, 'Expected 1 result item');

      record('T12', 'Forged payload ignored & sender enforced', true, 'frameId check, opt-in check, and authorized dispatch all passed');
    } catch (e) {
      record('T12', 'Forged payload ignored & sender enforced', false, e.message);
    }

    // Test 13: Fail-closed key hygiene & self-recovery
    try {
      const popupSenderStr = JSON.stringify({ url: `chrome-extension://${EXPECTED_EXT_ID}/popup.html` });

      // 13a: Monkey-patch setAccessLevel to throw
      await cdp.evaluate(`
        self.__origSetAccessLevel = chrome.storage.local.setAccessLevel;
        chrome.storage.local.setAccessLevel = () => { throw new Error('injected storage access failure'); };
        self.__translatorSw._resetStorageAccessStateForTest();
      `, swSessionId, true);

      // 13b: Privileged call LIST_MODELS must fail with KEY_ACCESS_UNAVAILABLE
      const failRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'LIST_MODELS'
        }, ${popupSenderStr})
      `, swSessionId, true);

      assert.equal(failRes?.error?.code, 'KEY_ACCESS_UNAVAILABLE', `Expected KEY_ACCESS_UNAVAILABLE, got ${failRes?.error?.code}`);

      // 13c: Restore function, reset test state, and retry -> should succeed
      await cdp.evaluate(`
        chrome.storage.local.setAccessLevel = self.__origSetAccessLevel;
        delete self.__origSetAccessLevel;
        self.__translatorSw._resetStorageAccessStateForTest();
      `, swSessionId, true);

      const okRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'LIST_MODELS'
        }, ${popupSenderStr})
      `, swSessionId, true);

      assert.ok(okRes && Array.isArray(okRes.models) && !okRes.error, `Expected models array after recovery, got ${JSON.stringify(okRes)}`);

      record('T13', 'Fail-closed key & recovery', true, 'Refused with KEY_ACCESS_UNAVAILABLE on failure, recovered on retry');
    } catch (e) {
      // Clean up monkey-patch if failed
      try {
        await cdp.evaluate(`
          if (self.__origSetAccessLevel) {
            chrome.storage.local.setAccessLevel = self.__origSetAccessLevel;
            delete self.__origSetAccessLevel;
          }
        `, swSessionId, true);
      } catch {}
      record('T13', 'Fail-closed key & recovery', false, e.message);
    }

  } finally {
    console.log('[5/6] Cleaning up test processes...');
    try { cdp?.close(); } catch {}
    if (chromeProc) {
      try {
        if (chromeProc.pid && process.platform !== 'win32') {
          process.kill(-chromeProc.pid, 'SIGKILL');
        } else {
          chromeProc.kill('SIGKILL');
        }
      } catch {}
    }

    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}

    await fakeServer.stop();
  }

  // Print results table
  console.log('\n=================== SMOKE TEST RESULTS ===================');
  console.log('| ID | Test Name                              | Status | Detail');
  console.log('|----|----------------------------------------|--------|------------------------------------------------');
  let allPass = true;
  for (const t of testResults) {
    if (!t.pass) allPass = false;
    const status = t.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`| ${t.id.padEnd(2)} | ${t.name.padEnd(38)} | ${status.padEnd(6)} | ${t.detail}`);
  }
  console.log('==========================================================\n');

  return allPass && testResults.length >= 13;
}

async function main() {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`\n[RETRY] Smoke test attempt ${attempt}/${MAX_ATTEMPTS}...`);
      await sleep(1000);
    }
    try {
      const ok = await runSingleAttempt();
      if (ok) {
        console.log('🎉 ALL TESTS PASSED! Exit code 0.');
        process.exit(0);
      }
    } catch (err) {
      console.error(`Attempt ${attempt} failed with error:`, err?.message || err);
      if (attempt === MAX_ATTEMPTS) {
        console.error('FATAL TEST ERROR: All retry attempts exhausted.');
        process.exit(1);
      }
    }
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
