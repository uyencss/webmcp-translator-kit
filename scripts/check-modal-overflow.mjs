#!/usr/bin/env node
// WebMCP Translator Kit — WI-45/WI-46 Modal Overflow Measurement
// Spawns headless Chrome (zero external dependencies) and verifies
// that modal rows and input groups fit within popup clientWidth (<= clientWidth + 1)
// in both dark and light themes.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import cp, { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 1. Find chrome-headless-shell binary (use the latest version in puppeteer cache)
export function findChromeHeadlessShell() {
  if (process.env.CHROME_HEADLESS_SHELL && fs.existsSync(process.env.CHROME_HEADLESS_SHELL)) {
    return process.env.CHROME_HEADLESS_SHELL;
  }
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }

  const baseDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Puppeteer chrome-headless-shell directory not found: ${baseDir}`);
  }

  const entries = fs.readdirSync(baseDir).filter(name => !name.startsWith('.'));
  // Sort versions descending (e.g. 150 > 148 > 131)
  entries.sort((a, b) => {
    const parseVer = s => s.replace(/^[a-zA-Z_-]+/, '').split('.').map(Number);
    const va = parseVer(a);
    const vb = parseVer(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const diff = (vb[i] || 0) - (va[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  for (const entry of entries) {
    const possiblePaths = [
      path.join(baseDir, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
      path.join(baseDir, entry, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
      path.join(baseDir, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      path.join(baseDir, entry, 'chrome-headless-shell')
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  throw new Error(`No chrome-headless-shell binary found inside ${baseDir}`);
}

// 2. Ensure extension/dist/popup.html exists
export const popupHtmlPath = path.resolve(rootDir, 'extension', 'dist', 'popup.html');

// Pure helpers for DevTools discovery & target matching (exported for unit testing)
export function parseDevToolsEndpoint(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/DevTools listening on ws:\/\/(\[[^\]]+\]|[^:/]+):(\d+)\/(\S*)/);
  if (!match) return null;
  return {
    host: match[1],
    port: Number(match[2]),
    path: match[3] || '',
    wsUrl: `ws://${match[1]}:${match[2]}/${match[3] || ''}`
  };
}

export function matchPopupTarget(targets, expectedUrl) {
  if (!Array.isArray(targets) || !expectedUrl) return null;
  return targets.find(t => t && t.type === 'page' && t.url === expectedUrl) || null;
}

// Process lifecycle & synchronous cleanup helpers
const _sab = new SharedArrayBuffer(4);
const _int32 = new Int32Array(_sab);
export function sleepSync(ms) {
  try {
    Atomics.wait(_int32, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

export function isProcessRunning(pid) {
  if (!pid || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  let running = false;
  try {
    process.kill(pid, 0);
    running = true;
  } catch (err) {
    // ESRCH = chết thật, EPERM/EACCES = còn sống nhưng khác quyền → vẫn gửi signal
    running = Boolean(err && (err.code === 'EPERM' || err.code === 'EACCES'));
  }

  // ps (nếu giữ) chỉ để log thông tin, KHÔNG được quyết định bỏ qua signal
  try {
    const fn = cp?.spawnSync || spawnSync;
    fn('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 });
  } catch {}

  return running;
}

export function killChildProcessSync(child, termTimeoutMs = 1500, pollIntervalMs = 50, killTimeoutMs = 500) {
  if (!child || !child.pid) return;
  const pid = child.pid;

  // 1. Initial kill-0 check: process.kill(pid, 0) là nguồn chân lý duy nhất cho liveness
  if (!isProcessRunning(pid)) {
    return;
  }

  // 2. Gửi SIGTERM
  try {
    child.kill('SIGTERM');
  } catch {}

  // 3. Chờ có timeout (poll kill-0 liveness)
  const start = Date.now();
  while (Date.now() - start < termTimeoutMs) {
    if (!isProcessRunning(pid)) {
      return;
    }
    sleepSync(pollIntervalMs);
  }

  // 4. SIGKILL nếu vẫn còn sống sau SIGTERM timeout
  if (isProcessRunning(pid)) {
    try {
      child.kill('SIGKILL');
    } catch {}

    const killStart = Date.now();
    while (Date.now() - killStart < killTimeoutMs) {
      if (!isProcessRunning(pid)) {
        return;
      }
      sleepSync(25);
    }
  }

  // 5. Verify cuối (log thông tin chẩn đoán nếu tiến trình vẫn chưa dừng)
  if (isProcessRunning(pid)) {
    try {
      const fn = cp?.spawnSync || spawnSync;
      const res = fn('ps', ['-o', 'state=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 });
      const info = res?.stdout?.trim() || '';
      if (info && !info.includes('Z')) {
        console.warn(`[check:layout] Warning: Child process ${pid} still running after SIGKILL (state: ${info})`);
      }
    } catch {}
  }
}

let proc = null;
let ws = null;

export function cleanup() {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  const child = proc;
  proc = null; // Guard against reuse / use-after-clear
  if (child) {
    killChildProcessSync(child);
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('uncaughtException', (err) => {
  console.error('[check:layout] Uncaught exception:', err);
  cleanup();
  process.exit(1);
});
process.on('exit', () => {
  cleanup();
});

export async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Helper to query CDP JSON endpoints
export function fetchJson(host, port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const cleanHost = host.replace(/^\[|\]$/g, '');
    const req = http.request({
      host: cleanHost,
      port,
      path: urlPath,
      method,
      headers: { Host: `localhost:${port}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.setTimeout(3000, () => {
      req.destroy(new Error('HTTP request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function runLayoutCheck(options = {}) {
  const targetHtmlPath = options.popupHtmlPath || popupHtmlPath;
  if (!fs.existsSync(targetHtmlPath)) {
    console.log('[check:layout] popup.html not found, running build first...');
    execSync('node scripts/build.mjs', { cwd: rootDir, stdio: 'inherit' });
  }

  const binary = options.chromeBin || findChromeHeadlessShell();
  console.log(`[check:layout] Using chrome-headless-shell: ${binary}`);

  const expectedUrl = pathToFileURL(targetHtmlPath).href;

  // 1. Spawn headless-shell with ephemeral port (--remote-debugging-port=0)
  proc = spawn(binary, [
    '--headless',
    '--remote-debugging-port=0',
    '--allow-file-access-from-files',
    '--window-size=400,900',
    expectedUrl
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.on('exit', () => {
    if (proc && proc.exitCode !== null) {
      proc = null;
    }
  });

  let detectedHost = '127.0.0.1';
  let detectedPort = 0;
  let devToolsReady = false;
  let stderrBuffer = '';

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    if (!devToolsReady) {
      const parsed = parseDevToolsEndpoint(stderrBuffer);
      if (parsed && parsed.port > 0) {
        detectedHost = parsed.host;
        detectedPort = parsed.port;
        devToolsReady = true;
      }
    }
  });

  // Wait strictly for devToolsReady on ephemeral port
  const t0 = Date.now();
  const devToolsTimeoutMs = options.devToolsTimeoutMs || 5000;
  while (!devToolsReady && Date.now() - t0 < devToolsTimeoutMs) {
    await sleep(50);
  }

  if (!devToolsReady || detectedPort <= 0) {
    throw new Error(
      `Chrome failed to start or did not report DevTools port within ${devToolsTimeoutMs}ms (stderr: ${stderrBuffer.trim()})`
    );
  }

  console.log(`[check:layout] DevTools ready on ${detectedHost}:${detectedPort}`);

  // 2. Discover exact popup target via GET http://<host>:<port>/json
  let tab = null;
  let lastTargets = null;
  const discoveryDeadline = Date.now() + (options.discoveryTimeoutMs || 5000);
  const hostsToTry = [detectedHost, '127.0.0.1', '[::1]'].filter((v, i, a) => a.indexOf(v) === i);

  while (Date.now() < discoveryDeadline) {
    for (const h of hostsToTry) {
      try {
        const resp = await fetchJson(h, detectedPort, '/json');
        if (Array.isArray(resp)) {
          lastTargets = resp;
          tab = matchPopupTarget(resp, expectedUrl);
          if (tab) {
            detectedHost = h;
            break;
          }
        }
      } catch {}
    }
    if (tab) break;
    await sleep(100);
  }

  if (!tab) {
    const summary = Array.isArray(lastTargets)
      ? lastTargets.map(t => ({ type: t.type, url: t.url }))
      : lastTargets;
    throw new Error(
      `Failed to find exact popup target (type="page", url="${expectedUrl}") on port ${detectedPort} within 5s. Discovered targets: ${JSON.stringify(summary)}`
    );
  }

  if (!tab.webSocketDebuggerUrl) {
    throw new Error(`Unable to resolve webSocketDebuggerUrl for popup.html target: ${JSON.stringify(tab)}`);
  }

  // Connect WebSocket
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  });

  let msgId = 1;
  function sendCdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timeout = setTimeout(() => {
        ws.removeEventListener('message', onMsg);
        reject(new Error(`CDP command timeout: ${method}`));
      }, 10000);

      const onMsg = (event) => {
        try {
          const resp = JSON.parse(event.data);
          if (resp.id === id) {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            if (resp.error) reject(new Error(`CDP Error (${method}): ${JSON.stringify(resp.error)}`));
            else resolve(resp.result);
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Set viewport to simulate popup (372px)
  await sendCdp('Emulation.setDeviceMetricsOverride', {
    width: 372,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false
  });

  // Brief pause for initial layout settle
  await sleep(150);

  const themes = ['dark', 'light'];
  let totalChecks = 0;
  let failedChecks = 0;

  for (const theme of themes) {
    console.log(`\n============================================================`);
    console.log(`[check:layout] Theme: ${theme.toUpperCase()}`);
    console.log(`============================================================`);

    const evalResult = await sendCdp('Runtime.evaluate', {
      expression: `(() => {
        // 1. Set theme attributes
        document.documentElement.setAttribute('data-theme', '${theme}');
        document.body.setAttribute('data-theme', '${theme}');
        document.documentElement.style.width = '372px';
        document.body.style.width = '372px';

        // 2. Open modal config (call openModal if available, or simulate classes)
        if (typeof window.openModal === 'function') {
          try { window.openModal('config'); } catch (_) {}
        }
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
          overlay.style.display = 'flex';
          overlay.removeAttribute('aria-hidden');
          overlay.style.maxWidth = '372px';
        }
        const cfg = document.getElementById('tabpanel-config');
        if (cfg) {
          cfg.classList.remove('hidden');
        }
        const logPanel = document.getElementById('tabpanel-log');
        if (logPanel) {
          logPanel.classList.add('hidden');
        }

        // 3. Make all config subpanels visible for complete measurement
        document.querySelectorAll('.config-subpanel').forEach(p => p.classList.remove('hidden'));

        // 4. Query all target elements
        const selectors = [
          '.modal-container [class*="row"]',
          '.input-with-button',
          '.config-subpanel > *'
        ];
        const elements = Array.from(document.querySelectorAll(selectors.join(', ')));

        return elements.map(el => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
          const scrollWidth = el.scrollWidth;
          const clientWidth = el.clientWidth;
          const fits = scrollWidth <= clientWidth + 1;

          // Provide descriptive label
          let label = tag + id + cls;
          const inputChild = el.querySelector('input, select');
          if (inputChild && inputChild.id) {
            label += ' (for #' + inputChild.id + ')';
          }

          return {
            label,
            scrollWidth,
            clientWidth,
            fits
          };
        });
      })()`,
      returnByValue: true
    });

    const items = evalResult?.result?.value;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`No elements matched layout selectors in theme ${theme}`);
    }

    for (const item of items) {
      totalChecks++;
      if (item.fits) {
        console.log(`  PASS [${theme}] ${item.label}: scrollWidth ${item.scrollWidth} <= clientWidth ${item.clientWidth} + 1`);
      } else {
        failedChecks++;
        console.error(`  FAIL [${theme}] ${item.label}: scrollWidth ${item.scrollWidth} > clientWidth ${item.clientWidth} + 1 (OVERFLOW)`);
      }
    }
  }

  console.log(`\n------------------------------------------------------------`);
  console.log(`[check:layout] Result: ${totalChecks - failedChecks}/${totalChecks} checks PASSED across 2 themes`);
  console.log(`------------------------------------------------------------`);

  if (failedChecks > 0) {
    console.error(`[check:layout] FAILED: ${failedChecks} element(s) overflowed!`);
    process.exitCode = 1;
  } else {
    console.log(`[check:layout] SUCCESS: All modal rows and input groups fit without overflow.`);
    process.exitCode = 0;
  }
}

// Auto-run if executed directly as main script
const isMain = Boolean(
  process.argv[1] &&
  (fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1])))
);

if (isMain) {
  try {
    await runLayoutCheck();
  } catch (err) {
    console.error('[check:layout] Error during execution:', err);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}
