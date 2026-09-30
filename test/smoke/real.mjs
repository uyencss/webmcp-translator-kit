// Optional Real Endpoint Smoke Test for WebMCP Translator Kit (Direct Slice)
// Reads NINE_ROUTER_BASE_URL and NINE_ROUTER_TOKEN from environment.
// Never logs or persists tokens. Exits 0 with [SKIP] if env vars are missing.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, '..', '..', 'extension', 'dist');
const FIXTURE_PATH = path.resolve(HERE, 'fixture.html');

const DEFAULT_CHROME = path.join(
  process.env.HOME || '',
  '.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);

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
      }, 30000);

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

// Simple static HTTP server for fixture.html
function createFixtureServer(port = parseInt(process.env.FIXTURE_PORT || '8091', 10)) {
  const fixtureContent = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const server = http.createServer((req, res) => {
    if (req.url === '/fixture.html' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureContent);
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

async function main() {
  const rawBaseUrl = process.env.NINE_ROUTER_BASE_URL?.trim();
  const rawToken = process.env.NINE_ROUTER_TOKEN?.trim();

  if (!rawBaseUrl || !rawToken) {
    console.log('[SKIP] NINE_ROUTER_BASE_URL or NINE_ROUTER_TOKEN not set in environment. Skipping real smoke test.');
    process.exit(0);
  }

  const FIXTURE_PORT = parseInt(process.env.FIXTURE_PORT || '8091', 10);
  const fixtureServer = createFixtureServer(FIXTURE_PORT);
  await fixtureServer.start();
  console.log(`[1/5] Fixture server running at http://127.0.0.1:${FIXTURE_PORT}`);

  const chromeBin = getChromeBin();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-real-'));

  let chromeProc = null;
  let cdp = null;
  const testResults = [];

  function record(id, name, pass, detail = '') {
    testResults.push({ id, name, pass, detail });
  }

  try {
    console.log('[2/5] Launching Chrome for Testing with unpacked extension...');
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
      throw new Error('Chrome failed to expose DevTools port');
    }
    console.log(`[3/5] Chrome CDP ready on port ${cdpPort}`);

    const versionInfo = await fetchJson(cdpPort, '/json/version');
    cdp = new CdpConnection(versionInfo.webSocketDebuggerUrl);
    await cdp.connect();

    console.log(`[4/5] Discovering & attaching to extension Service Worker (${EXPECTED_EXT_ID})...`);

    const swPromise = new Promise((resolve) => {
      cdp.addEventListener((msg) => {
        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
          const info = msg.params?.targetInfo;
          if (info?.type === 'service_worker' && info?.url?.includes(EXPECTED_EXT_ID)) {
            resolve(info);
          }
        }
      });
    });

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const swTarget = await Promise.race([
      swPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout waiting for Service Worker target after 15s`)), 15000)
      )
    ]);

    const attachSwRes = await cdp.send('Target.attachToTarget', {
      targetId: swTarget.targetId,
      flatten: true
    });
    const swSessionId = attachSwRes.sessionId;

    await cdp.send('Runtime.enable', {}, swSessionId);
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, swSessionId);
    await sleep(150);

    // Normalize Base URL to include /v1 if missing
    const targetBaseUrl = rawBaseUrl.endsWith('/v1') ? rawBaseUrl : rawBaseUrl.replace(/\/+$/, '') + '/v1';

    // Configure storage via SW dispatchMessage without logging the token
    await cdp.evaluate(`
      (async () => {
        await self.__translatorSw.dispatchMessage({
          action: 'SAVE_SETTINGS',
          settings: {
            baseURL: ${JSON.stringify(targetBaseUrl)},
            model: '${DEFAULT_MODEL}',
            sourceLanguage: 'auto',
            targetLanguage: 'vi'
          }
        });
        await self.__translatorSw.dispatchMessage({
          action: 'SET_KEY',
          key: ${JSON.stringify(rawToken)}
        });
      })()
    `, swSessionId);

    console.log('[5/5] Executing translation test with real 9router endpoint...');

    // Open fixture tab
    const fixtureUrl = `http://127.0.0.1:${FIXTURE_PORT}/fixture.html`;
    const tabTarget = await cdp.send('Target.createTarget', { url: fixtureUrl });
    const attachTabRes = await cdp.send('Target.attachToTarget', {
      targetId: tabTarget.targetId,
      flatten: true
    });
    const fixtureSessionId = attachTabRes.sessionId;

    await cdp.send('Runtime.enable', {}, fixtureSessionId);
    await cdp.send('Runtime.addBinding', { name: '__cdpSendToSw' }, fixtureSessionId);

    // Bridge messages
    cdp.addEventListener(async (msg) => {
      if (msg.sessionId === fixtureSessionId && msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__cdpSendToSw') {
        const { callId, payload } = JSON.parse(msg.params.payload);
        try {
          const swRes = await cdp.evaluate(
            `self.__translatorSw.dispatchMessage(${JSON.stringify(payload)})`,
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

    const contentJsSource = fs.readFileSync(path.join(EXTENSION_DIR, 'content.js'), 'utf8');
    await cdp.evaluate(`${contentJsSource}\n;true;`, fixtureSessionId, false);

    const initialTitle = await cdp.evaluate('window.__fixture.getTitleText()', fixtureSessionId);
    const initialFav = await cdp.evaluate('window.__fixture.getFavText()', fixtureSessionId);
    assert.equal(initialTitle, '欢迎使用翻译系统');
    assert.equal(initialFav, '收藏');

    // Execute real translation
    const tStart = Date.now();
    const trResult = await cdp.evaluate(`
      window.__translatorDom.executeTranslation({
        sourceLanguage: 'auto',
        targetLanguage: 'vi',
        model: '${DEFAULT_MODEL}'
      })
    `, fixtureSessionId, true);
    const latencyMs = Date.now() - tStart;

    assert.ok(trResult && trResult.ok === true, 'Translation failed: ' + JSON.stringify(trResult));
    assert.ok(trResult.applied >= 2, `Expected at least 2 nodes applied, got ${trResult.applied}`);

    const translatedTitle = await cdp.evaluate('window.__fixture.getTitleText()', fixtureSessionId);
    const translatedFav = await cdp.evaluate('window.__fixture.getFavText()', fixtureSessionId);

    // Verify translated text has changed from Chinese
    assert.notEqual(translatedTitle, initialTitle, 'Title text should have changed');
    assert.notEqual(translatedFav, initialFav, 'Fav button text should have changed');

    record('REAL_TR', 'Real 9router translation & patch', true, `Model: ${DEFAULT_MODEL}, Applied: ${trResult.applied}, Latency: ${latencyMs}ms`);

    // Verify restore
    const restoreRes = await cdp.evaluate('window.__translatorDom.restore()', fixtureSessionId, false);
    assert.ok(restoreRes && restoreRes.restored >= 2, `Expected at least 2 nodes restored, got ${restoreRes.restored}`);

    const restoredTitle = await cdp.evaluate('window.__fixture.getTitleText()', fixtureSessionId);
    const restoredFav = await cdp.evaluate('window.__fixture.getFavText()', fixtureSessionId);
    assert.equal(restoredTitle, initialTitle);
    assert.equal(restoredFav, initialFav);

    record('REAL_RESTORE', 'Real translation restore original text', true, `Restored: ${restoreRes.restored} nodes`);

  } finally {
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

    await fixtureServer.stop();
  }

  console.log('\n=================== REAL SMOKE TEST RESULTS ===================');
  console.log('| ID           | Test Name                              | Status | Detail');
  console.log('|--------------|----------------------------------------|--------|------------------------------------------------');
  let allPass = true;
  for (const t of testResults) {
    if (!t.pass) allPass = false;
    const status = t.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`| ${t.id.padEnd(12)} | ${t.name.padEnd(38)} | ${status.padEnd(6)} | ${t.detail}`);
  }
  console.log('=================================================================\n');

  if (allPass && testResults.length >= 2) {
    console.log('🎉 REAL ENDPOINT TESTS PASSED! Exit code 0.');
    process.exit(0);
  } else {
    console.error('❌ Some tests failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL REAL SMOKE TEST ERROR:', err?.message || err);
  process.exit(1);
});
