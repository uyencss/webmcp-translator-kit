// WebMCP Translator Kit — WI-46 Unit Tests
// F1: Cleanup lifecycle, no use-after-clear, synchronous escalation SIGTERM -> SIGKILL, no hanging timers.
// F2: Ephemeral port (--remote-debugging-port=0), DevTools ready enforcement, exact page target matching (no permissive fallback).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseDevToolsEndpoint,
  matchPopupTarget,
  isProcessRunning,
  killChildProcessSync,
  cleanup,
  sleepSync
} from '../scripts/check-modal-overflow.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.resolve(__dirname, '../scripts/check-modal-overflow.mjs');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

// ============================================================================
// 1. F2: Pure Unit Tests — parseDevToolsEndpoint
// ============================================================================

test('WI-46 F2: parseDevToolsEndpoint extracts host, port, and wsUrl for IPv4 and IPv6', () => {
  const ipv4Banner = 'DevTools listening on ws://127.0.0.1:58432/devtools/browser/abc-123\n';
  const parsed4 = parseDevToolsEndpoint(ipv4Banner);
  assert.deepEqual(parsed4, {
    host: '127.0.0.1',
    port: 58432,
    path: 'devtools/browser/abc-123',
    wsUrl: 'ws://127.0.0.1:58432/devtools/browser/abc-123'
  });

  const ipv6Banner = 'DevTools listening on ws://[::1]:61234/devtools/browser/def-456\n';
  const parsed6 = parseDevToolsEndpoint(ipv6Banner);
  assert.deepEqual(parsed6, {
    host: '[::1]',
    port: 61234,
    path: 'devtools/browser/def-456',
    wsUrl: 'ws://[::1]:61234/devtools/browser/def-456'
  });

  const localhostBanner = 'DevTools listening on ws://localhost:9999/devtools/browser/xyz\n';
  const parsedLocal = parseDevToolsEndpoint(localhostBanner);
  assert.deepEqual(parsedLocal, {
    host: 'localhost',
    port: 9999,
    path: 'devtools/browser/xyz',
    wsUrl: 'ws://localhost:9999/devtools/browser/xyz'
  });

  assert.strictEqual(parseDevToolsEndpoint('Random chrome startup log line'), null);
  assert.strictEqual(parseDevToolsEndpoint(''), null);
  assert.strictEqual(parseDevToolsEndpoint(null), null);
});

// ============================================================================
// 2. F2: Pure Unit Tests — matchPopupTarget
// ============================================================================

test('WI-46 F2: matchPopupTarget strictly matches exact page type and exact URL', () => {
  const expectedUrl = 'file:///path/to/extension/dist/popup.html';

  const targets = [
    { type: 'background_page', url: expectedUrl, id: 'bg1' },
    { type: 'service_worker', url: expectedUrl, id: 'sw1' },
    { type: 'page', url: 'https://example.com/popup.html', id: 'p1' },
    { type: 'page', url: 'file:///other/path/popup.html', id: 'p2' },
    { type: 'page', url: expectedUrl, id: 'valid-target', webSocketDebuggerUrl: 'ws://...' }
  ];

  const matched = matchPopupTarget(targets, expectedUrl);
  assert.ok(matched, 'Must find valid target');
  assert.strictEqual(matched.id, 'valid-target');
  assert.strictEqual(matched.type, 'page');
  assert.strictEqual(matched.url, expectedUrl);

  // Negative cases
  assert.strictEqual(matchPopupTarget([], expectedUrl), null);
  assert.strictEqual(matchPopupTarget(null, expectedUrl), null);
  assert.strictEqual(
    matchPopupTarget([
      { type: 'iframe', url: expectedUrl },
      { type: 'page', url: 'file:///another/popup.html' }
    ], expectedUrl),
    null,
    'Must not match non-page or partial url'
  );
});

// ============================================================================
// 3. F1: Process Lifecycle & Synchronous Kill Escalation
// ============================================================================

test('WI-46 F1: isProcessRunning correctly determines liveness', async () => {
  const child = spawn('sleep', ['5']);
  assert.strictEqual(isProcessRunning(child.pid), true);

  killChildProcessSync(child, 1000, 20);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(isProcessRunning(child.pid), false);
  assert.strictEqual(isProcessRunning(9999999), false);
  assert.strictEqual(isProcessRunning(null), false);
});

test('WI-46 F1: killChildProcessSync escalates from SIGTERM to SIGKILL if child ignores SIGTERM', async () => {
  // Child script that traps SIGTERM and refuses to exit
  const stubbornChild = spawn('node', [
    '-e',
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
  ]);

  // Give child time to boot and register SIGTERM listener
  await new Promise(r => setTimeout(r, 250));

  const pid = stubbornChild.pid;
  assert.strictEqual(isProcessRunning(pid), true);

  const t0 = Date.now();
  // Call killChildProcessSync with short 200ms timeout for SIGTERM before escalating to SIGKILL
  killChildProcessSync(stubbornChild, 200, 20);
  const elapsed = Date.now() - t0;

  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(isProcessRunning(pid), false, 'Child must be terminated by SIGKILL');
  assert.ok(elapsed >= 180, `Must have waited for timeout before escalation (elapsed: ${elapsed}ms)`);

  // Calling again on dead child is safe and idempotent
  killChildProcessSync(stubbornChild);
  cleanup();
});

test('WI-46 F1: cleanup function is idempotent and guards against null / use-after-clear', () => {
  // Calling cleanup when proc is null must be safe
  assert.doesNotThrow(() => {
    cleanup();
    cleanup();
  });
});

// ============================================================================
// 4. F1 & F2: Script Static Invariants
// ============================================================================

test('WI-46 F2: check-modal-overflow.mjs uses ephemeral port 0 and no hardcoded 9222', () => {
  assert.ok(
    scriptSource.includes("'--remote-debugging-port=0'"),
    'Must pass --remote-debugging-port=0 for ephemeral port allocation'
  );
  assert.ok(
    !scriptSource.includes('PORT = 9222'),
    'Must not hardcode PORT = 9222'
  );
  assert.ok(
    !scriptSource.includes(':9222'),
    'Must not reference fixed port 9222'
  );
});

test('WI-46 F2: check-modal-overflow.mjs enforces devToolsReady before discovery and exact target matching', () => {
  assert.ok(
    scriptSource.includes('if (!devToolsReady || detectedPort <= 0)'),
    'Must verify devToolsReady and detectedPort > 0 before proceeding to target discovery'
  );
  assert.ok(
    scriptSource.includes('matchPopupTarget('),
    'Must use matchPopupTarget for target selection'
  );
  assert.ok(
    !scriptSource.includes("t.url.includes('popup.html')"),
    'Must not use permissive includes match'
  );
  assert.ok(
    !scriptSource.includes("/json/new?"),
    'Must not open fallback tab with /json/new'
  );
});

test('WI-46 F1: check-modal-overflow.mjs cleanup does not have unreferenced timers or use-after-clear', () => {
  assert.ok(
    !scriptSource.includes('setTimeout(() => {\n      try { proc.kill'),
    'Must not have use-after-clear setTimeout callback accessing proc'
  );
  assert.ok(
    scriptSource.includes('const child = proc;'),
    'Must safely capture child reference before clearing proc'
  );
  assert.ok(
    scriptSource.includes('proc = null;'),
    'Must clear proc reference immediately'
  );
});
