// WebMCP Translator Kit — WI-47 Unit Tests
// Fix 1 finding Sol round 30 (wi1115-sol-verdict30.md, P2)
// Liveness sole source of truth is process.kill(pid, 0).
// ps failures/timeouts must NEVER decide to skip termination signals (SIGTERM -> SIGKILL).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isProcessRunning,
  killChildProcessSync,
  cleanup
} from '../scripts/check-modal-overflow.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.resolve(__dirname, '../scripts/check-modal-overflow.mjs');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

// ============================================================================
// 1. Acceptance 2: ps-fail mà kill-0-success vẫn gửi đủ SIGTERM→SIGKILL
// ============================================================================

test('WI-47: ps-fail mà kill-0-success vẫn gửi đủ SIGTERM→SIGKILL (no early skip)', () => {
  const origKill = process.kill;
  const origSpawnSync = cp.spawnSync;

  const sentSignals = [];
  let isAlive = true;
  let psCallCount = 0;

  const mockChild = {
    pid: 88888,
    exitCode: null,
    kill(sig) {
      sentSignals.push(sig);
      if (sig === 'SIGKILL') {
        isAlive = false;
      }
    }
  };

  try {
    // 1. Mock process.kill: kill(pid, 0) succeeds while process is alive, throws ESRCH when dead
    process.kill = (pid, sig) => {
      if (pid === 88888 && sig === 0) {
        if (isAlive) return true;
        const err = new Error('kill ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return origKill.call(process, pid, sig);
    };

    // 2. Mock spawnSync: any `ps` invocation fails or times out (status: 1, error)
    cp.spawnSync = (cmd, args, opts) => {
      if (cmd === 'ps') {
        psCallCount++;
        return {
          status: 1,
          stdout: '',
          stderr: 'ps: command failed or timed out',
          error: new Error('ps: mock failure')
        };
      }
      return origSpawnSync.call(cp, cmd, args, opts);
    };

    // 3. Verify isProcessRunning is true via kill(0) despite ps failure
    assert.strictEqual(isProcessRunning(88888), true, 'Liveness must be true via kill(0) despite ps failure');

    // 4. Run killChildProcessSync with short timeouts
    killChildProcessSync(mockChild, 50, 10, 50);

    // 5. Verify both SIGTERM and SIGKILL were sent in order without early-skipping
    assert.deepEqual(sentSignals, ['SIGTERM', 'SIGKILL'], 'Must send SIGTERM followed by SIGKILL without early-skipping');
    assert.ok(psCallCount >= 1, 'ps must have been called (and failed) during the process');
    assert.strictEqual(isProcessRunning(88888), false, 'Process must be marked dead after SIGKILL terminates it');
  } finally {
    process.kill = origKill;
    cp.spawnSync = origSpawnSync;
  }
});

test('WI-47: ps throwing exception does not prevent killChildProcessSync from sending SIGTERM and SIGKILL', () => {
  const origKill = process.kill;
  const origSpawnSync = cp.spawnSync;

  const sentSignals = [];
  let isAlive = true;

  const mockChild = {
    pid: 77777,
    exitCode: null,
    kill(sig) {
      sentSignals.push(sig);
      if (sig === 'SIGKILL') {
        isAlive = false;
      }
    }
  };

  try {
    process.kill = (pid, sig) => {
      if (pid === 77777 && sig === 0) {
        if (isAlive) return true;
        const err = new Error('kill ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return origKill.call(process, pid, sig);
    };

    cp.spawnSync = (cmd, args, opts) => {
      if (cmd === 'ps') {
        throw new Error('spawnSync ps ENOENT (binary not found)');
      }
      return origSpawnSync.call(cp, cmd, args, opts);
    };

    killChildProcessSync(mockChild, 50, 10, 50);
    assert.deepEqual(sentSignals, ['SIGTERM', 'SIGKILL'], 'Must send SIGTERM and SIGKILL even if spawnSync ps throws');
  } finally {
    process.kill = origKill;
    cp.spawnSync = origSpawnSync;
  }
});

// ============================================================================
// 2. Liveness Source of Truth: ESRCH = dead, EPERM = alive
// ============================================================================

test('WI-47: isProcessRunning treats EPERM as running and ESRCH as dead', () => {
  const origKill = process.kill;
  try {
    process.kill = (pid, sig) => {
      if (pid === 70001 && sig === 0) {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      if (pid === 70002 && sig === 0) {
        const err = new Error('No such process');
        err.code = 'ESRCH';
        throw err;
      }
      return origKill.call(process, pid, sig);
    };

    assert.strictEqual(isProcessRunning(70001), true, 'EPERM indicates process is alive (insufficient permissions)');
    assert.strictEqual(isProcessRunning(70002), false, 'ESRCH indicates process is dead');
    assert.strictEqual(isProcessRunning(0), false, 'Invalid PID 0 returns false');
    assert.strictEqual(isProcessRunning(-1), false, 'Negative PID returns false');
    assert.strictEqual(isProcessRunning(NaN), false, 'NaN PID returns false');
    assert.strictEqual(isProcessRunning(null), false, 'null PID returns false');
  } finally {
    process.kill = origKill;
  }
});

// ============================================================================
// 3. Static Invariants: check-modal-overflow.mjs
// ============================================================================

test('WI-47: check-modal-overflow.mjs does not use ps exit code/output to skip signals or conclude not running', () => {
  // Must NOT contain old buggy pattern: if (res.status !== 0 || !res.stdout) return false;
  assert.ok(
    !scriptSource.includes('if (res.status !== 0 || !res.stdout) return false'),
    'Must not conclude not running when ps fails or times out'
  );

  // Must import cp for mockability in tests
  assert.ok(
    scriptSource.includes("import cp,"),
    'Must import cp for mockability'
  );

  // Must check process.kill(pid, 0) as sole source of truth for liveness
  assert.ok(
    scriptSource.includes('process.kill(pid, 0)'),
    'Must use process.kill(pid, 0) for liveness check'
  );

  // Must handle EPERM as alive
  assert.ok(
    scriptSource.includes("err.code === 'EPERM'"),
    'Must treat EPERM as alive'
  );
});
