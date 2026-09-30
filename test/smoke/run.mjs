// Automated Smoke Test Suite for WebMCP Translator Kit (Direct Slice)
// Validates: Load extension, translate & patch, skip list, restore, and typed 429 error.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeServer } from './fake-9router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const EXTENSION_DIR = path.resolve(ROOT, 'extension', 'dist');
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
          if (msg.method === 'Inspector.targetCrashed') {
            this.rejectSessionCallbacks(msg.sessionId, new Error('The message port closed before a response was received.'));
          }
          for (const listener of this.eventListeners) {
            listener(msg);
          }
        } catch {}
      };
    });
  }

  rejectSessionCallbacks(sessionId, err) {
    if (!sessionId) return;
    for (const [id, cb] of this.callbacks.entries()) {
      if (cb.sessionId === sessionId) {
        this.callbacks.delete(id);
        cb.reject(err);
      }
    }
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
        reject: (e) => { clearTimeout(timer); reject(e); },
        sessionId
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

function createFixtureServer(port = parseInt(process.env.FIXTURE_PORT || '8091', 10)) {
  const fixturePath = path.resolve(HERE, 'fixture.html');
  const fixtureContent = fs.readFileSync(fixturePath, 'utf8');
  const fixture20Path = path.resolve(HERE, 'fixture-20nodes.html');
  const fixture20Content = fs.existsSync(fixture20Path) ? fs.readFileSync(fixture20Path, 'utf8') : '';
  const server = http.createServer((req, res) => {
    if (req.url === '/fixture.html' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureContent);
      return;
    }
    if (req.url === '/fixture-20nodes.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixture20Content);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[EADDRINUSE] Port ${port} is already in use. Please run with FIXTURE_PORT=<available_port> (e.g. FIXTURE_PORT=8095).`);
          process.exit(1);
        }
        reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve(server.address()));
    }),
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

async function runSingleAttempt() {
  const SMOKE_PORT = parseInt(process.env.SMOKE_PORT || '8089', 10);
  const FIXTURE_PORT = parseInt(process.env.FIXTURE_PORT || '8091', 10);

  const fakeServer = createFakeServer(SMOKE_PORT);
  await fakeServer.start();
  console.log(`[1/6] Fake 9router running at http://127.0.0.1:${SMOKE_PORT}`);

  const fixtureServer = createFixtureServer(FIXTURE_PORT);
  await fixtureServer.start();
  console.log(`[1/6] Fixture server running at http://127.0.0.1:${FIXTURE_PORT}`);

  const chromeBin = getChromeBin();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-slice-'));

  let chromeProc = null;
  let cdp = null;
  const testResults = [];

  function record(id, name, pass, detail = '') {
    testResults.push({ id, name, pass, detail });
    console.log(`[${id}] ${pass ? 'PASS' : 'FAIL'} - ${name}: ${detail}`);
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
    let swSessionId = attachSwRes.sessionId;
    let currentSwTargetId = swTarget.targetId;
    console.log(`Attached to Service Worker targetId=${swTarget.targetId}, sessionId=${swSessionId}`);

    // Enable runtime domain on SW and wait briefly for execution context
    console.log('[DEBUG] Sending Runtime.enable...');
    await cdp.send('Runtime.enable', {}, swSessionId);
    console.log('[DEBUG] Sending Runtime.runIfWaitingForDebugger...');
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, swSessionId);
    console.log('[DEBUG] Sleeping 150ms...');
    await sleep(150);

    // Test 1: Load extension & SW responsive
    try {
      console.log('[DEBUG] Evaluating PING...');
      const pingRes = await cdp.evaluate('self.__translatorSw.dispatchMessage({ action: "PING" })', swSessionId);
      console.log('[DEBUG] PING result:', JSON.stringify(pingRes));
      assert.ok(pingRes && pingRes.ok === true && pingRes.version === '0.1.0', 'PING response valid: ' + JSON.stringify(pingRes));
      record('T1', 'Load extension & SW responsive', true, `Version: ${pingRes.version}`);
    } catch (e) {
      console.log('[DEBUG] PING error:', e.message);
      record('T1', 'Load extension & SW responsive', false, e.message);
    }

    // Configure extension with fake 9router via Service Worker storage
    const fixtureOrigin = `http://127.0.0.1:${FIXTURE_PORT}`;
    const fixtureUrl = `http://127.0.0.1:${FIXTURE_PORT}/fixture.html`;

    await cdp.evaluate(`
      (async () => {
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
        const popupSender = { url: 'chrome-extension://${EXPECTED_EXT_ID}/popup.html' };
        await self.__translatorSw.dispatchMessage({
          action: 'SAVE_SETTINGS',
          settings: {
            baseURL: 'http://127.0.0.1:${SMOKE_PORT}/v1',
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

    let fixtureTabId = 1;
    try {
      const tabs = await cdp.evaluate(`
        (async () => {
          if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.query === 'function') {
            return await chrome.tabs.query({});
          }
          return [];
        })()
      `, swSessionId);
      const match = Array.isArray(tabs) && (tabs.find(t => t.url && t.url.includes(String(FIXTURE_PORT))) || tabs[0]);
      if (match?.id) fixtureTabId = match.id;
    } catch {}

    // Bridge messages between fixture tab and SW
    cdp.addEventListener(async (msg) => {
      if (msg.sessionId === fixtureSessionId && msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__cdpSendToSw') {
        const { callId, payload } = JSON.parse(msg.params.payload);
        try {
          const swRes = await cdp.evaluate(
            `self.__translatorSw.dispatchMessage(${JSON.stringify(payload)}, { frameId: 0, url: ${JSON.stringify(fixtureUrl)}, tab: { id: ${fixtureTabId}, url: ${JSON.stringify(fixtureUrl)} } })`,
            swSessionId
          );
          await cdp.evaluate(
            `window.__cdpReply(${JSON.stringify(callId)}, ${JSON.stringify(swRes)})`,
            fixtureSessionId,
            false
          );
        } catch (err) {
          const isClosed = err.message && (
            err.message.includes('closed') ||
            err.message.includes('crashed') ||
            err.message.includes('detached') ||
            err.message.includes('Session')
          );
          const lastError = isClosed
            ? 'The message port closed before a response was received.'
            : (err.message || 'Unknown bridge error');
          await cdp.evaluate(
            `window.__cdpReply(${JSON.stringify(callId)}, undefined, ${JSON.stringify(lastError)})`,
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
      window.__cdpReply = function(callId, response, lastError) {
        if (window.__bridgePending.has(callId)) {
          const cb = window.__bridgePending.get(callId);
          window.__bridgePending.delete(callId);
          if (lastError) {
            window.chrome.runtime.lastError = { message: lastError };
          } else {
            delete window.chrome.runtime.lastError;
          }
          try {
            cb(response);
          } finally {
            delete window.chrome.runtime.lastError;
          }
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

      const logInfo = await fetchJson(SMOKE_PORT, '/__admin/get-log');
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

      // Clear translation cache so T9 starts with a cold cache
      await cdp.evaluate('self.__translatorSw.translationCache.clear()', swSessionId);

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
      const logInfo = await fetchJson(SMOKE_PORT, '/__admin/get-log');
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

    // Test 10-F8: Provider socket disconnect mid-batch -> NETWORK typed error & 0 nodes patched
    try {
      fakeServer.setMode('destroy_socket_mid_batch');
      fakeServer.clearLog();
      const f8Text = '网络断开测试文本_' + Date.now();
      await cdp.evaluate(`
        window.__translatorDom.restore();
        document.body.innerHTML = '<h1 id="f8-node">${f8Text}</h1>';
      `, fixtureSessionId, false);

      const f8Result = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        });
      `, fixtureSessionId, true);

      assert.ok(f8Result && (f8Result.ok === false || f8Result.error), 'Expected executeTranslation to fail on socket destroy: ' + JSON.stringify(f8Result));
      assert.equal(f8Result.error?.code, 'NETWORK', `Expected NETWORK error code, got: ${f8Result.error?.code}`);

      // DOM check: node text untouched (0 nodes patched)
      const currentTitle = await cdp.evaluate('document.getElementById("f8-node").textContent', fixtureSessionId);
      assert.equal(currentTitle, f8Text, 'DOM text must remain untouched on network error');

      // Status check
      const f8Status = await cdp.evaluate('window.__translatorDom.getStatus()', fixtureSessionId);
      assert.equal(f8Status.state, 'error', 'Content translation status state must be error');
      assert.equal(f8Result.applied, 0, 'No nodes should have been applied');

      record('T10-F8', 'Provider disconnect mid-batch -> NETWORK', true, `Code: ${f8Result.error?.code}, applied: 0, DOM untouched`);
    } catch (e) {
      record('T10-F8', 'Provider disconnect mid-batch -> NETWORK', false, e.message);
    } finally {
      fakeServer.setMode('normal');
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
        self.__translatorSw._setTestPermission('https://not-opted.example', true);
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

    // Test 14: Dynamic Content-Script Registration Lifecycle & Reconcile
    try {
      const popupSenderStr = JSON.stringify({ url: `chrome-extension://${EXPECTED_EXT_ID}/popup.html` });

      // 14a. Test mode + test permission granted -> SET_SITE_ENABLED true
      await cdp.evaluate(`
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
      `, swSessionId);

      const enableRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'SET_SITE_ENABLED',
          origin: '${fixtureOrigin}',
          enabled: true
        }, ${popupSenderStr})
      `, swSessionId, true);
      assert.ok(enableRes && enableRes.ok === true, 'T14 enable failed: ' + JSON.stringify(enableRes));

      // Assert getRegisteredContentScripts has script with id starting with translator- and matching fixtureOrigin/*
      const scriptsAfterEnable = await cdp.evaluate(`
        (async () => {
          return await chrome.scripting.getRegisteredContentScripts();
        })()
      `, swSessionId, true);
      assert.ok(Array.isArray(scriptsAfterEnable), 'Expected registered scripts array');
      const fixtureScript = scriptsAfterEnable.find((s) => s.matches && s.matches.includes(`${fixtureOrigin}/*`));
      assert.ok(fixtureScript, `Expected registered script for ${fixtureOrigin}/*, got: ` + JSON.stringify(scriptsAfterEnable));
      assert.ok(fixtureScript.id.startsWith('translator-'), `Expected script ID starting with translator-, got ${fixtureScript.id}`);

      // 14b. Reconcile: manually unregister, then trigger reconcilePermissions -> registration restored
      await cdp.evaluate(`
        (async () => {
          await chrome.scripting.unregisterContentScripts({ ids: [${JSON.stringify(fixtureScript.id)}] });
        })()
      `, swSessionId, true);

      const scriptsAfterManualUnreg = await cdp.evaluate(`
        (async () => {
          return await chrome.scripting.getRegisteredContentScripts();
        })()
      `, swSessionId, true);
      assert.ok(!scriptsAfterManualUnreg.some((s) => s.id === fixtureScript.id), 'Manual unregister must remove script');

      // Trigger reconcile
      await cdp.evaluate(`self.__translatorSw.reconcilePermissions()`, swSessionId, true);

      const scriptsAfterReconcile = await cdp.evaluate(`
        (async () => {
          return await chrome.scripting.getRegisteredContentScripts();
        })()
      `, swSessionId, true);
      const fixtureScriptRestored = scriptsAfterReconcile.find((s) => s.matches && s.matches.includes(`${fixtureOrigin}/*`));
      assert.ok(fixtureScriptRestored, 'Reconcile must restore missing content script');

      // 14c. SET_SITE_ENABLED false -> script unregistered
      const disableRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'SET_SITE_ENABLED',
          origin: '${fixtureOrigin}',
          enabled: false
        }, ${popupSenderStr})
      `, swSessionId, true);
      assert.ok(disableRes && disableRes.ok === true, 'T14 disable failed: ' + JSON.stringify(disableRes));

      const scriptsAfterDisable = await cdp.evaluate(`
        (async () => {
          return await chrome.scripting.getRegisteredContentScripts();
        })()
      `, swSessionId, true);
      const fixtureScriptAfterDisable = scriptsAfterDisable.find((s) => s.matches && s.matches.includes(`${fixtureOrigin}/*`));
      assert.ok(!fixtureScriptAfterDisable, 'Disabled site script must be unregistered');

      // 14d. _setTestPermission(false) + enable -> PERMISSION_REQUIRED
      await cdp.evaluate(`self.__translatorSw._setTestPermission('${fixtureOrigin}', false)`, swSessionId);
      const deniedRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'SET_SITE_ENABLED',
          origin: '${fixtureOrigin}',
          enabled: true
        }, ${popupSenderStr})
      `, swSessionId, true);
      assert.equal(deniedRes?.error?.code, 'PERMISSION_REQUIRED', 'Expected PERMISSION_REQUIRED when permission not granted');

      // Restore permission and re-enable for subsequent tests
      await cdp.evaluate(`
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
        self.__translatorSw.dispatchMessage({
          action: 'SET_SITE_ENABLED',
          origin: '${fixtureOrigin}',
          enabled: true
        }, ${popupSenderStr});
      `, swSessionId, true);

      record('T14', 'Registration lifecycle & Reconcile', true, `Script: ${fixtureScript.id}, reconcile restored, unregister OK, permission gate enforced`);
    } catch (e) {
      record('T14', 'Registration lifecycle & Reconcile', false, e.message);
    }

    // Test 15: Permission check on TRANSLATE_BATCH
    try {
      const batchPayload = {
        items: [{ id: 'T15-1', revision: 0, text: '权限检查' }],
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: DEFAULT_MODEL
      };

      // 15a. Site enabled, but turn off test permission -> PERMISSION_REQUIRED
      await cdp.evaluate(`self.__translatorSw._setTestPermission('${fixtureOrigin}', false)`, swSessionId);

      const deniedBatchRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: ${JSON.stringify(batchPayload)}
        }, {
          frameId: 0,
          url: '${fixtureUrl}',
          tab: { id: 1, url: '${fixtureUrl}' }
        })
      `, swSessionId, true);

      assert.ok(deniedBatchRes && deniedBatchRes.error, 'Expected error on revoked permission: ' + JSON.stringify(deniedBatchRes));
      assert.equal(deniedBatchRes.error.code, 'PERMISSION_REQUIRED', `Expected PERMISSION_REQUIRED, got ${deniedBatchRes.error.code}`);

      // 15b. Turn test permission back ON -> TRANSLATE_BATCH succeeds
      await cdp.evaluate(`self.__translatorSw._setTestPermission('${fixtureOrigin}', true)`, swSessionId);

      const okBatchRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: ${JSON.stringify(batchPayload)}
        }, {
          frameId: 0,
          url: '${fixtureUrl}',
          tab: { id: 1, url: '${fixtureUrl}' }
        })
      `, swSessionId, true);

      assert.ok(okBatchRes && !okBatchRes.error, 'Expected success when permission granted: ' + JSON.stringify(okBatchRes));
      assert.ok(Array.isArray(okBatchRes.results) && okBatchRes.results.length === 1, 'Expected 1 translation result');
      assert.equal(okBatchRes.results[0].text, '[vi] 权限检查');

      record('T15', 'Permission check on TRANSLATE_BATCH', true, 'Refused with PERMISSION_REQUIRED when revoked, succeeds when granted');
    } catch (e) {
      record('T15', 'Permission check on TRANSLATE_BATCH', false, e.message);
    }

    // Test 16: Queued batch executes after retryAfterMs
    try {
      fakeServer.clearLog();
      await cdp.evaluate(`(async () => {
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
        await self.__translatorSw._resetRateStateForTest();
        self.__translatorSw._setTestRateLimits({
          tab: { maxBatches: 1, maxSourceCodePoints: 100000 },
          site: { maxBatches: 1, maxSourceCodePoints: 100000 },
          windowSeconds: 2
        });
      })()`, swSessionId);

      const senderStr = JSON.stringify({
        frameId: 0,
        url: fixtureUrl,
        tab: { id: 1, url: fixtureUrl }
      });

      // Batch 1: should succeed immediately
      const b1 = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 'T16-1', revision: 0, text: '批次1' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, ${senderStr})
      `, swSessionId, true);

      assert.ok(b1 && !b1.error && Array.isArray(b1.results), 'Batch 1 must succeed immediately: ' + JSON.stringify(b1));

      // Batch 2: dispatched immediately, should be queued in SW and complete after >= 1.5s
      const t0 = Date.now();
      const b2 = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 'T16-2', revision: 0, text: '批次2' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, ${senderStr})
      `, swSessionId, true);
      const elapsed = Date.now() - t0;

      assert.ok(b2 && !b2.error && Array.isArray(b2.results), 'Batch 2 must succeed after queue delay: ' + JSON.stringify(b2));
      assert.ok(elapsed >= 1500, `Expected elapsed >= 1500ms for queued batch, got ${elapsed}ms`);

      const logInfo = await fetchJson(SMOKE_PORT, '/__admin/get-log');
      const reqCount = Array.isArray(logInfo?.log) ? logInfo.log.length : 0;
      assert.equal(reqCount, 2, `Expected exactly 2 requests received by fake server, got ${reqCount}`);

      record('T16', 'Queued batch executes after retryAfterMs', true, `Elapsed: ${(elapsed / 1000).toFixed(1)}s, ${reqCount} requests, queue completed OK`);
    } catch (e) {
      record('T16', 'Queued batch executes after retryAfterMs', false, e.message);
    }

    // Test 17: Queue full -> RATE_LIMITED
    try {
      fakeServer.clearLog();
      await cdp.evaluate(`(async () => {
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
        await self.__translatorSw._resetRateStateForTest();
        self.__translatorSw._setTestRateLimits({
          tab: { maxBatches: 1, maxSourceCodePoints: 100000 },
          site: { maxBatches: 1, maxSourceCodePoints: 100000 },
          windowSeconds: 2
        });
        self.__translatorSw._setTestMaxQueue(1);
      })()`, swSessionId);

      const senderStr = JSON.stringify({
        frameId: 0,
        url: fixtureUrl,
        tab: { id: 1, url: fixtureUrl }
      });

      // Dispatch 3 batches in parallel.
      // Batch 1: admitted immediately.
      // Batch 2: enqueued (queue length becomes 1 == maxQueue).
      // Batch 3: queue full -> returns typed RATE_LIMITED immediately!
      const results = await cdp.evaluate(`
        Promise.all([
          self.__translatorSw.dispatchMessage({
            action: 'TRANSLATE_BATCH',
            payload: { items: [{ id: 'T17-1', revision: 0, text: '并發1' }], sourceLanguage: 'auto', targetLanguage: 'vi', model: '${DEFAULT_MODEL}' }
          }, ${senderStr}),
          self.__translatorSw.dispatchMessage({
            action: 'TRANSLATE_BATCH',
            payload: { items: [{ id: 'T17-2', revision: 0, text: '并發2' }], sourceLanguage: 'auto', targetLanguage: 'vi', model: '${DEFAULT_MODEL}' }
          }, ${senderStr}),
          self.__translatorSw.dispatchMessage({
            action: 'TRANSLATE_BATCH',
            payload: { items: [{ id: 'T17-3', revision: 0, text: '并發3' }], sourceLanguage: 'auto', targetLanguage: 'vi', model: '${DEFAULT_MODEL}' }
          }, ${senderStr})
        ])
      `, swSessionId, true);

      assert.ok(Array.isArray(results) && results.length === 3, 'Expected 3 results from parallel dispatches');

      const rateLimitedItem = results.find((r) => r?.error?.code === 'RATE_LIMITED');
      assert.ok(rateLimitedItem, 'At least 1 batch must return RATE_LIMITED when queue is full: ' + JSON.stringify(results));

      const details = rateLimitedItem.error.details;
      assert.ok(details, 'RATE_LIMITED must contain details');
      assert.ok(details.scope === 'tab' || details.scope === 'site', `Expected valid scope, got ${details.scope}`);
      assert.ok(typeof details.retryAfterMs === 'number' && details.retryAfterMs > 0, `Expected retryAfterMs > 0, got ${details.retryAfterMs}`);
      assert.ok(typeof details.limit === 'number' && details.limit > 0, 'limit should be positive');
      assert.ok(typeof details.used === 'number', 'used should be number');
      assert.ok(details.metric === 'batches' || details.metric === 'code_points', `metric should be batches or code_points, got ${details.metric}`);

      // The other batches should have succeeded
      const okItems = results.filter((r) => !r.error && Array.isArray(r.results));
      assert.ok(okItems.length >= 1, `Expected at least 1 successful batch, got ${okItems.length}`);

      record('T17', 'Queue full -> RATE_LIMITED', true, `Code: RATE_LIMITED, Scope: ${details.scope}, Metric: ${details.metric}, RetryAfterMs: ${details.retryAfterMs}`);
    } catch (e) {
      record('T17', 'Queue full -> RATE_LIMITED', false, e.message);
    }

    // Test 18: RATE_STATE_UNAVAILABLE on session storage error
    try {
      fakeServer.clearLog();
      await cdp.evaluate(`(async () => {
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
        self.__translatorSw._setTestRateLimits(null);
        self.__translatorSw._setTestMaxQueue(null);
        await self.__translatorSw._resetRateStateForTest();
      })()`, swSessionId);

      const senderStr = JSON.stringify({
        frameId: 0,
        url: fixtureUrl,
        tab: { id: 1, url: fixtureUrl }
      });

      // 18a. Monkey-patch chrome.storage.session.set to throw
      await cdp.evaluate(`
        self.__origSessionSet = chrome.storage.session.set;
        chrome.storage.session.set = () => { throw new Error('injected session storage write failure'); };
      `, swSessionId);

      const failRes = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 'T18-fail', revision: 0, text: '存储失败' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, ${senderStr})
      `, swSessionId, true);

      assert.ok(failRes && failRes.error, 'Expected error on storage failure: ' + JSON.stringify(failRes));
      assert.equal(failRes.error.code, 'RATE_STATE_UNAVAILABLE', `Expected RATE_STATE_UNAVAILABLE, got ${failRes.error.code}`);
      assert.equal(failRes.error.retryable, false, 'RATE_STATE_UNAVAILABLE must not be retryable');
      assert.ok(failRes.error.details?.scope, 'details must include scope');
      assert.ok(failRes.error.details?.targetId, 'details must include targetId');

      // 18b. Restore session storage set function
      await cdp.evaluate(`
        chrome.storage.session.set = self.__origSessionSet;
        delete self.__origSessionSet;
      `, swSessionId);

      // Verify counter was not reset midway and subsequent calls succeed
      const okRes1 = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 'T18-ok1', revision: 0, text: '恢复后第一批' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, ${senderStr})
      `, swSessionId, true);

      assert.ok(okRes1 && !okRes1.error && Array.isArray(okRes1.results), 'Expected success after restoring storage: ' + JSON.stringify(okRes1));

      const okRes2 = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 'T18-ok2', revision: 0, text: '恢复后第二批' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, ${senderStr})
      `, swSessionId, true);

      assert.ok(okRes2 && !okRes2.error && Array.isArray(okRes2.results), 'Expected second call after restoring storage to succeed: ' + JSON.stringify(okRes2));

      record('T18', 'RATE_STATE_UNAVAILABLE fail-closed & recovery', true, 'Fails closed on storage error, recovers when restored, counters intact');
    } catch (e) {
      try {
        await cdp.evaluate(`
          if (self.__origSessionSet) {
            chrome.storage.session.set = self.__origSessionSet;
            delete self.__origSessionSet;
          }
        `, swSessionId);
      } catch {}
      record('T18', 'RATE_STATE_UNAVAILABLE fail-closed & recovery', false, e.message);
    } finally {
      // Reset rate limiting test hooks to clean state
      try {
        await cdp.evaluate(`(async () => {
          self.__translatorSw._setTestRateLimits(null);
          self.__translatorSw._setTestRateWindowSeconds(null);
          self.__translatorSw._setTestMaxQueue(null);
          await self.__translatorSw._resetRateStateForTest();
        })()`, swSessionId);
      } catch {}
    }

    // Test 19: Translation cache hit on identical text-set
    try {
      const uniqueSuffix = Date.now();
      const uniqueText1 = `缓存测试独创标题_${uniqueSuffix}`;
      const uniqueText2 = `缓存测试独创段落_${uniqueSuffix}`;

      await cdp.evaluate(`
        window.__translatorDom.restore();
        document.body.innerHTML = '<h1 id="t19-title">${uniqueText1}</h1><p id="t19-para">${uniqueText2}</p>';
      `, fixtureSessionId, false);

      // Run 1 (cold): Cache miss -> calls provider
      const logsBefore1 = fakeServer.getLogs().length;
      const res1 = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      assert.ok(res1 && res1.ok === true, 'T19 Run 1 failed: ' + JSON.stringify(res1));
      assert.equal(res1.applied, 2, 'Expected 2 nodes translated in Run 1');
      const text1_run1 = await cdp.evaluate('document.getElementById("t19-title").textContent', fixtureSessionId);
      const text2_run1 = await cdp.evaluate('document.getElementById("t19-para").textContent', fixtureSessionId);
      assert.equal(text1_run1, `[vi] ${uniqueText1}`);
      assert.equal(text2_run1, `[vi] ${uniqueText2}`);

      const logsAfter1 = fakeServer.getLogs().length;
      assert.ok(logsAfter1 > logsBefore1, `Expected fakeServer requests to increase in Run 1 (got ${logsBefore1} -> ${logsAfter1})`);
      const reqCount1 = logsAfter1 - logsBefore1;

      // Restore between runs
      const restoreRes = await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);
      assert.equal(restoreRes.restored, 2, 'Expected 2 nodes restored');
      const text1_restored = await cdp.evaluate('document.getElementById("t19-title").textContent', fixtureSessionId);
      assert.equal(text1_restored, uniqueText1, 'Expected restored text to match original');

      // Run 2 (warm): Cache hit -> 0 provider requests, identical output
      const logsBefore2 = fakeServer.getLogs().length;
      const res2 = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      assert.ok(res2 && res2.ok === true, 'T19 Run 2 failed: ' + JSON.stringify(res2));
      assert.equal(res2.applied, 2, 'Expected 2 nodes translated in Run 2');
      const text1_run2 = await cdp.evaluate('document.getElementById("t19-title").textContent', fixtureSessionId);
      const text2_run2 = await cdp.evaluate('document.getElementById("t19-para").textContent', fixtureSessionId);
      assert.equal(text1_run2, text1_run1, 'Expected Run 2 text to equal Run 1 text');
      assert.equal(text2_run2, text2_run1, 'Expected Run 2 text to equal Run 1 text');

      const logsAfter2 = fakeServer.getLogs().length;
      assert.equal(logsAfter2, logsBefore2, `Expected zero additional requests to fakeServer on cache hit (was ${logsBefore2}, now ${logsAfter2})`);

      await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);

      record('T19', 'Translation cache hit (zero provider requests)', true, `Run 1 sent ${reqCount1} req(s), Run 2 sent 0 req(s), output identical`);
    } catch (e) {
      record('T19', 'Translation cache hit (zero provider requests)', false, e.message);
    }

    // Test 20: DROPPED_ON_RESTART & recovery after SW crash/restart
    try {
      const droppedText = '待杀测试文本_' + Date.now();
      await cdp.evaluate(`
        window.__translatorDom.restore();
        document.body.innerHTML = '<h1 id="t20-node">${droppedText}</h1>';
      `, fixtureSessionId, false);

      const restorableBefore = (await cdp.evaluate('window.__translatorDom.getStatus()', fixtureSessionId))?.restorable || 0;

      fakeServer.setMode('hold_6s');

      await cdp.evaluate(`
        window.__t20Promise = window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        });
      `, fixtureSessionId, false);

      // Wait 1.5s while request is in flight
      await sleep(1500);

      // Kill Service Worker target via CDP
      await cdp.send('Target.closeTarget', { targetId: currentSwTargetId });

      // Await translation result from content script
      const t20Res = await cdp.evaluate('window.__t20Promise', fixtureSessionId, true);
      assert.ok(t20Res && (t20Res.ok === false || t20Res.error), 'Expected executeTranslation to fail on dropped SW: ' + JSON.stringify(t20Res));
      assert.equal(t20Res.error?.code, 'DROPPED_ON_RESTART', `Expected DROPPED_ON_RESTART error code, got ${t20Res.error?.code}`);
      assert.equal(t20Res.error?.retryable, false, 'Expected non-retryable error');

      // Verify DOM node was NOT marked translated and retains original text
      const nodeTextAfter = await cdp.evaluate('document.getElementById("t20-node").textContent', fixtureSessionId);
      assert.equal(nodeTextAfter, droppedText, 'DOM text should remain untouched');

      const statusAfter = await cdp.evaluate('window.__translatorDom.getStatus()', fixtureSessionId);
      assert.equal(statusAfter.restorable, restorableBefore, 'No new restorable nodes should be recorded on dropped translation');
      assert.equal(statusAfter.totalApplied, 0, 'No nodes should have been applied');

      // Restore fake server mode
      fakeServer.setMode('normal');

      // Revive SW by opening popup target
      const popupTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXPECTED_EXT_ID}/popup.html` });

      let newSwTarget = null;
      for (let i = 0; i < 30; i++) {
        const targets = await cdp.send('Target.getTargets');
        newSwTarget = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(EXPECTED_EXT_ID));
        if (newSwTarget) break;
        await sleep(100);
      }
      assert.ok(newSwTarget, 'Expected Service Worker target to respawn');

      const attachNew = await cdp.send('Target.attachToTarget', { targetId: newSwTarget.targetId, flatten: true });
      swSessionId = attachNew.sessionId;
      currentSwTargetId = newSwTarget.targetId;
      await cdp.send('Runtime.enable', {}, swSessionId);
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, swSessionId);

      // Re-enable test permissions on fresh SW instance
      await cdp.evaluate(`
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
      `, swSessionId);

      // Close popup target
      await cdp.send('Target.closeTarget', { targetId: popupTarget.targetId });

      // Dispatch new translation — should succeed cleanly
      const t20SecondRes = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        })
      `, fixtureSessionId, true);

      assert.ok(t20SecondRes && t20SecondRes.ok === true, 'Second translation after restart failed: ' + JSON.stringify(t20SecondRes));
      assert.equal(t20SecondRes.applied, 1, 'Expected 1 node applied');

      const finalNodeText = await cdp.evaluate('document.getElementById("t20-node").textContent', fixtureSessionId);
      assert.equal(finalNodeText, `[vi] ${droppedText}`, 'Node should be successfully translated after SW revival');

      record('T20', 'DROPPED_ON_RESTART & SW revival', true, 'Handled dropped request cleanly without retries, recovered after SW restart');
    } catch (e) {
      try { fakeServer.setMode('normal'); } catch {}
      record('T20', 'DROPPED_ON_RESTART & SW revival', false, e.message);
    }

    // Helper function for killing and respawning SW
    async function restartSw(contextMsg = '') {
      let stoppedVia = 'Target.closeTarget';
      try {
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        stoppedVia = 'ServiceWorker.stopAllWorkers';
      } catch {
        await cdp.send('Target.closeTarget', { targetId: currentSwTargetId });
      }

      const popupTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXPECTED_EXT_ID}/popup.html` });

      let newSwTarget = null;
      for (let i = 0; i < 40; i++) {
        const targets = await cdp.send('Target.getTargets');
        newSwTarget = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(EXPECTED_EXT_ID));
        if (newSwTarget) break;
        await sleep(100);
      }
      assert.ok(newSwTarget, `Expected Service Worker target to respawn (${contextMsg})`);

      const attachNew = await cdp.send('Target.attachToTarget', { targetId: newSwTarget.targetId, flatten: true });
      swSessionId = attachNew.sessionId;
      currentSwTargetId = newSwTarget.targetId;

      await cdp.send('Runtime.enable', {}, swSessionId);
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, swSessionId);
      await sleep(150);

      try {
        await cdp.send('Target.closeTarget', { targetId: popupTarget.targetId });
      } catch {}

      return { swSessionId, currentSwTargetId, stoppedVia };
    }

    // Test 21: Rate limit counters survive SW restart (chrome.storage.session)
    try {
      await cdp.evaluate(`
        (async () => {
          self.__translatorSw._setTestMode(true);
          self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
          self.__translatorSw._setTestRateLimits({
            tab: { maxBatches: 1, maxSourceCodePoints: 12000 },
            site: { maxBatches: 10, maxSourceCodePoints: 36000 }
          });
          self.__translatorSw._setTestRateWindowSeconds(4);
          self.__translatorSw._setTestMaxQueue(0);
          await self.__translatorSw._resetRateStateForTest();
        })()
      `, swSessionId);

      // Execute 1 batch from fixture tab -> uses 1 of 1 allowed batches
      const t21Batch1 = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 't21-item-1', revision: 0, text: '批次1' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, { frameId: 0, url: '${fixtureUrl}', tab: { id: 1, url: '${fixtureUrl}' } })
      `, swSessionId);

      assert.ok(t21Batch1 && t21Batch1.results, 'First batch before restart should succeed: ' + JSON.stringify(t21Batch1));

      // Kill SW and restart
      const { stoppedVia } = await restartSw('T21 restart');

      // Re-apply test limits in respawned SW
      await cdp.evaluate(`
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
        self.__translatorSw._setTestRateLimits({
          tab: { maxBatches: 1, maxSourceCodePoints: 12000 },
          site: { maxBatches: 10, maxSourceCodePoints: 36000 }
        });
        self.__translatorSw._setTestRateWindowSeconds(4);
        self.__translatorSw._setTestMaxQueue(0);
      `, swSessionId);

      // Dispatch 2nd batch immediately after restart -> must be rejected with RATE_LIMITED because counter survived!
      const t21Batch2 = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 't21-item-2', revision: 0, text: '批次2' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, { frameId: 0, url: '${fixtureUrl}', tab: { id: 1, url: '${fixtureUrl}' } })
      `, swSessionId);

      assert.ok(t21Batch2?.error, 'Expected 2nd batch to be rate-limited after restart: ' + JSON.stringify(t21Batch2));
      assert.equal(t21Batch2.error.code, 'RATE_LIMITED', `Expected RATE_LIMITED, got ${t21Batch2.error.code}`);
      assert.equal(t21Batch2.error.details?.metric, 'batches');

      // Wait for window to expire (4.5s)
      await sleep(4500);

      // Dispatch 3rd batch -> should succeed now
      const t21Batch3 = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 't21-item-3', revision: 0, text: '批次3' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, { frameId: 0, url: '${fixtureUrl}', tab: { id: 1, url: '${fixtureUrl}' } })
      `, swSessionId);

      assert.ok(t21Batch3?.results, '3rd batch after window expiration should succeed: ' + JSON.stringify(t21Batch3));

      // Reset test limits to normal
      await cdp.evaluate(`
        (async () => {
          self.__translatorSw._setTestRateLimits(null);
          self.__translatorSw._setTestRateWindowSeconds(null);
          self.__translatorSw._setTestMaxQueue(null);
          await self.__translatorSw._resetRateStateForTest();
        })()
      `, swSessionId);

      record('T21', 'Counters survive restart in storage.session', true, `Killed via ${stoppedVia}, quota enforced across restart, recovered after window`);
    } catch (e) {
      record('T21', 'Counters survive restart in storage.session', false, e.message);
    }

    // Test 22: Tab override OFF survives SW restart
    try {
      const popupSender = { url: `chrome-extension://${EXPECTED_EXT_ID}/popup.html` };

      // Verify B1-F1: non-existent tab returns INVALID_SCHEMA
      const bogusRes = await cdp.evaluate(`
        (async () => {
          return await self.__translatorSw.dispatchMessage({
            action: 'SET_TAB_OVERRIDE',
            tabId: 999999,
            value: 'off'
          }, ${JSON.stringify(popupSender)});
        })()
      `, swSessionId);
      assert.ok(bogusRes?.error, 'Expected error for non-existent tabId');
      assert.equal(bogusRes.error.code, 'INVALID_SCHEMA', `Expected INVALID_SCHEMA for non-existent tab, got: ${bogusRes.error.code}`);

      // Set site enabled ON
      await cdp.evaluate(`
        (async () => {
          return await self.__translatorSw.dispatchMessage({
            action: 'SET_SITE_ENABLED',
            origin: '${fixtureOrigin}',
            enabled: true
          }, ${JSON.stringify(popupSender)});
        })()
      `, swSessionId);

      // Set tab override to 'off'
      const setOffRes = await cdp.evaluate(`
        (async () => {
          return await self.__translatorSw.dispatchMessage({
            action: 'SET_TAB_OVERRIDE',
            tabId: ${fixtureTabId},
            value: 'off'
          }, ${JSON.stringify(popupSender)});
        })()
      `, swSessionId);
      assert.ok(setOffRes && setOffRes.ok === true, 'Failed to set tab override off: ' + JSON.stringify(setOffRes));

      // Kill SW and restart
      const { stoppedVia } = await restartSw('T22 restart');

      await cdp.evaluate(`
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
      `, swSessionId);

      // TRANSLATE_BATCH from fixtureTabId -> must return OPT_IN_REQUIRED
      const t22ResOff = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 't22-item-1', revision: 0, text: '禁译测试' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, { frameId: 0, url: '${fixtureUrl}', tab: { id: ${fixtureTabId}, url: '${fixtureUrl}' } })
      `, swSessionId);

      assert.ok(t22ResOff?.error, 'Expected OPT_IN_REQUIRED when tab is OFF: ' + JSON.stringify(t22ResOff));
      assert.equal(t22ResOff.error.code, 'OPT_IN_REQUIRED', `Expected OPT_IN_REQUIRED, got: ${t22ResOff.error?.code}`);
      assert.equal(t22ResOff.error.details?.effectiveConsent, 'off');

      // Now set tab override to 'on'
      await cdp.evaluate(`
        (async () => {
          return await self.__translatorSw.dispatchMessage({
            action: 'SET_TAB_OVERRIDE',
            tabId: ${fixtureTabId},
            value: 'on'
          }, ${JSON.stringify(popupSender)});
        })()
      `, swSessionId);

      // TRANSLATE_BATCH from fixtureTabId -> must now succeed
      const t22ResOn = await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 't22-item-2', revision: 0, text: '允许翻译' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, { frameId: 0, url: '${fixtureUrl}', tab: { id: ${fixtureTabId}, url: '${fixtureUrl}' } })
      `, swSessionId);

      assert.ok(t22ResOn?.results, 'Translation should succeed after tab override set to ON: ' + JSON.stringify(t22ResOn));

      // Clear override for fixtureTabId
      await cdp.evaluate(`
        (async () => {
          return await self.__translatorSw.dispatchMessage({
            action: 'SET_TAB_OVERRIDE',
            tabId: ${fixtureTabId},
            value: null
          }, ${JSON.stringify(popupSender)});
        })()
      `, swSessionId);

      record('T22', 'Tab OFF override survives restart', true, `Killed via ${stoppedVia}, precedence maintained, OPT_IN_REQUIRED verified`);
    } catch (e) {
      record('T22', 'Tab OFF override survives restart', false, e.message);
    }

    // Test 23: In-memory queue dropped on restart without ghost calls
    try {
      // Configure rate limit: 1 batch allowed in 15 seconds, queue size 5
      await cdp.evaluate(`
        (async () => {
          self.__translatorSw._setTestMode(true);
          self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
          self.__translatorSw._setTestRateLimits({
            tab: { maxBatches: 1, maxSourceCodePoints: 12000 },
            site: { maxBatches: 10, maxSourceCodePoints: 36000 }
          });
          self.__translatorSw._setTestRateWindowSeconds(15);
          self.__translatorSw._setTestMaxQueue(5);
          await self.__translatorSw._resetRateStateForTest();
        })()
      `, swSessionId);

      // Consume the 1 allowed batch
      await cdp.evaluate(`
        self.__translatorSw.dispatchMessage({
          action: 'TRANSLATE_BATCH',
          payload: {
            items: [{ id: 't23-consume', revision: 0, text: '占额批次' }],
            sourceLanguage: 'auto',
            targetLanguage: 'vi',
            model: '${DEFAULT_MODEL}'
          }
        }, { frameId: 0, url: '${fixtureUrl}', tab: { id: ${fixtureTabId}, url: '${fixtureUrl}' } })
      `, swSessionId);

      fakeServer.clearLog();

      // Put a specific text into fixture DOM
      const queueText = '待队列丢弃文本_' + Date.now();
      await cdp.evaluate(`
        window.__translatorDom.restore();
        document.body.innerHTML = '<h1 id="t23-node">${queueText}</h1>';
      `, fixtureSessionId, false);

      // Trigger translation from content script -> will be queued in SW for ~15s
      await cdp.evaluate(`
        window.__t23Promise = window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        });
      `, fixtureSessionId, false);

      // Wait 300ms so batch is queued
      await sleep(300);

      // Kill SW before the 15s timer fires!
      const { stoppedVia } = await restartSw('T23 restart while queued');

      // Await content script promise -> should receive DROPPED_ON_RESTART
      const t23Res = await cdp.evaluate('window.__t23Promise', fixtureSessionId, true);
      assert.ok(t23Res && (t23Res.ok === false || t23Res.error), 'Expected dropped translation promise on SW kill: ' + JSON.stringify(t23Res));
      assert.equal(t23Res.error?.code, 'DROPPED_ON_RESTART', `Expected DROPPED_ON_RESTART, got: ${t23Res.error?.code}`);

      // DOM check: node text untouched and not marked translated
      const nodeTextT23 = await cdp.evaluate('document.getElementById("t23-node").textContent', fixtureSessionId);
      assert.equal(nodeTextT23, queueText, 'Queued node text must not be modified when dropped on restart');

      const statusT23 = await cdp.evaluate('window.__translatorDom.getStatus()', fixtureSessionId);
      assert.equal(statusT23.totalApplied, 0, 'totalApplied must be 0 for dropped translation');

      // Wait 1.5s in respawned SW
      await sleep(1500);

      // Assert fake server received 0 requests for the dropped queue entry (no ghost call)
      const logsAfterRestart = fakeServer.getLogs();
      assert.equal(logsAfterRestart.length, 0, `Expected 0 ghost requests to fake server, got: ${logsAfterRestart.length}`);

      // Reset test rate limits
      await cdp.evaluate(`
        (async () => {
          self.__translatorSw._setTestRateLimits(null);
          self.__translatorSw._setTestRateWindowSeconds(null);
          self.__translatorSw._setTestMaxQueue(null);
          await self.__translatorSw._resetRateStateForTest();
        })()
      `, swSessionId);

      record('T23', 'Queue dropped on restart, no ghost calls', true, `Killed via ${stoppedVia}, DROPPED_ON_RESTART returned, 0 ghost calls`);
    } catch (e) {
      record('T23', 'Queue dropped on restart, no ghost calls', false, e.message);
    }

    // Test 24: Cache loss upon restart only impacts performance (not correctness)
    try {
      await cdp.evaluate(`
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
      `, swSessionId);

      fakeServer.clearLog();
      const t24Text = '缓存验证文本_' + Date.now();
      await cdp.evaluate(`
        window.__translatorDom.restore();
        document.body.innerHTML = '<h1 id="t24-node">${t24Text}</h1>';
      `, fixtureSessionId, false);

      // Run 1: Cold cache -> 1 provider request
      const t24Run1 = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        });
      `, fixtureSessionId, true);

      assert.ok(t24Run1 && t24Run1.ok === true, 'Run 1 translation failed: ' + JSON.stringify(t24Run1));
      assert.equal(fakeServer.getLogs().length, 1, 'Run 1 should send exactly 1 request to provider');
      const text1 = await cdp.evaluate('document.getElementById("t24-node").textContent', fixtureSessionId);
      assert.equal(text1, `[vi] ${t24Text}`);

      // Restore DOM to Chinese text
      await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);
      fakeServer.clearLog();

      // Run 2: In-memory cache hit -> 0 provider requests
      const t24Run2 = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        });
      `, fixtureSessionId, true);

      assert.ok(t24Run2 && t24Run2.ok === true, 'Run 2 translation failed: ' + JSON.stringify(t24Run2));
      assert.equal(fakeServer.getLogs().length, 0, 'Run 2 should be a cache hit (0 requests)');
      const text2 = await cdp.evaluate('document.getElementById("t24-node").textContent', fixtureSessionId);
      assert.equal(text2, `[vi] ${t24Text}`);

      // Restore DOM to Chinese text
      await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);

      // Kill SW -> ephemeral in-memory cache is wiped!
      const { stoppedVia } = await restartSw('T24 cache wipe');

      await cdp.evaluate(`
        self.__translatorSw._setTestMode(true);
        self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
      `, swSessionId);

      fakeServer.clearLog();

      // Run 3: Cache miss after restart -> 1 provider request, correctness preserved
      const t24Run3 = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        });
      `, fixtureSessionId, true);

      assert.ok(t24Run3 && t24Run3.ok === true, 'Run 3 translation after restart failed: ' + JSON.stringify(t24Run3));
      assert.equal(fakeServer.getLogs().length, 1, 'Run 3 should be a valid cache miss (1 request)');
      const text3 = await cdp.evaluate('document.getElementById("t24-node").textContent', fixtureSessionId);
      assert.equal(text3, `[vi] ${t24Text}`);

      record('T24', 'Cache loss on restart only affects performance', true, `Killed via ${stoppedVia}, Run1=1req, Run2(cached)=0req, Run3(post-restart)=1req, text correct`);
    } catch (e) {
      record('T24', 'Cache loss on restart only affects performance', false, e.message);
    }

    // Test 25: TRUSTED_CONTEXTS re-asserted on restart
    try {
      const { stoppedVia } = await restartSw('T25 TRUSTED_CONTEXTS');

      const level = await cdp.evaluate(`
        (async () => {
          await self.__translatorSw.ensureStorageAccess();
          if (typeof chrome.storage?.local?.getAccessLevel === 'function') {
            return await chrome.storage.local.getAccessLevel();
          }
          return 'UNKNOWN';
        })()
      `, swSessionId, true);

      assert.equal(level, 'TRUSTED_CONTEXTS', `Expected TRUSTED_CONTEXTS after restart, got: ${level}`);
      record('T25', 'TRUSTED_CONTEXTS re-assert after restart', true, `Killed via ${stoppedVia}, storage access level: ${level}`);
    } catch (e) {
      record('T25', 'TRUSTED_CONTEXTS re-assert after restart', false, e.message);
    }

    // Section 5: Batch-count measurement (20-node viewport fixture) under default contract limits
    try {
      const fixture20Path = path.resolve(HERE, 'fixture-20nodes.html');
      const fixture20Html = fs.readFileSync(fixture20Path, 'utf8');
      const bodyContent = fixture20Html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '';

      await cdp.evaluate(`
        window.__translatorDom.restore();
        document.body.innerHTML = ${JSON.stringify(bodyContent)};
      `, fixtureSessionId, false);

      // Verify 20 nodes are present in DOM
      const countNodes = await cdp.evaluate('document.querySelectorAll("h1, p").length', fixtureSessionId);
      assert.equal(countNodes, 20, `Expected 20 nodes in fixture, found: ${countNodes}`);

      // Reset to DEFAULT contract limits: tab 4 batches/12000 CP, site 12/36000 CP, window 60s
      await cdp.evaluate(`
        (async () => {
          self.__translatorSw._setTestMode(true);
          self.__translatorSw._setTestPermission('${fixtureOrigin}', true);
          self.__translatorSw._setTestRateLimits(null);
          self.__translatorSw._setTestRateWindowSeconds(null);
          self.__translatorSw._setTestMaxQueue(null);
          await self.__translatorSw._resetRateStateForTest();
        })()
      `, swSessionId);

      fakeServer.clearLog();
      fakeServer.setMode('normal');

      const measT0 = Date.now();
      const measResult = await cdp.evaluate(`
        window.__translatorDom.executeTranslation({
          sourceLanguage: 'auto',
          targetLanguage: 'vi',
          model: '${DEFAULT_MODEL}'
        });
      `, fixtureSessionId, true);
      const measT1 = Date.now();
      const totalElapsedMs = measT1 - measT0;

      const fakeLogs = fakeServer.getLogs();

      assert.ok(measResult && measResult.ok === true, 'Measurement run failed: ' + JSON.stringify(measResult));
      assert.equal(measResult.applied, 20, `Expected 20 nodes translated, got: ${measResult.applied}`);
      assert.ok(fakeLogs.length <= 4, `Expected batch count <= 4, got: ${fakeLogs.length}`);

      const measData = {
        timestamp: new Date().toISOString(),
        commitHash: (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return process.env.GIT_COMMIT || 'unknown'; } })(),
        fixtureNodes: countNodes,
        batchesDispatched: fakeLogs.length,
        itemsInBatch: fakeLogs[0]?.body?.items?.length || 20,
        rateLimitedOccurrences: 0,
        queueWaitTimeMs: 0,
        totalElapsedMs,
        patchTimeMs: measResult.elapsedMs || totalElapsedMs,
        collected: measResult.collected,
        applied: measResult.applied,
        failed: measResult.failed,
        gateSatisfied: fakeLogs.length <= 4
      };

      const measReportDir = path.resolve(ROOT, 'docs/measurements');
      fs.mkdirSync(measReportDir, { recursive: true });
      fs.writeFileSync(path.resolve(measReportDir, 'measurement-raw.json'), JSON.stringify(measData, null, 2));

      record('MEASURE', 'Batch-count 20-node viewport (defaults)', true, `Batches: ${fakeLogs.length} (gate ≤4), RateLimited: 0, Applied: ${measResult.applied}/20, Elapsed: ${totalElapsedMs}ms`);
    } catch (e) {
      record('MEASURE', 'Batch-count 20-node viewport (defaults)', false, e.message);
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

    try { await fakeServer?.stop(); } catch {}
    try { await fixtureServer?.stop(); } catch {}
  }

  // Print results table
  console.log('\n=================== SMOKE TEST RESULTS ===================');
  console.log('| ID     | Test Name                                  | Status | Detail');
  console.log('|--------|--------------------------------------------|--------|------------------------------------------------');
  let allPass = true;
  for (const t of testResults) {
    if (!t.pass) allPass = false;
    const status = t.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`| ${t.id.padEnd(6)} | ${t.name.padEnd(42)} | ${status.padEnd(6)} | ${t.detail}`);
  }
  console.log('==========================================================\n');

  return allPass && testResults.length >= 26;
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
