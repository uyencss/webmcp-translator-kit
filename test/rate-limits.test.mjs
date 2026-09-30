// WebMCP Translator Kit — Rate Limits Unit Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countCodePoints,
  createLimitState,
  prune,
  evaluate,
  record,
  resolveLimits,
  DEFAULT_RATE_LIMITS
} from '../extension/src/rate-limits.mjs';

test('countCodePoints: Unicode code points vs UTF-16 code units (surrogate pairs)', () => {
  assert.equal(countCodePoints(''), 0);
  assert.equal(countCodePoints('hello'), 5);

  // Emojis (each takes 2 UTF-16 code units, but 1 Unicode code point)
  const thumb = '👍';
  assert.equal(thumb.length, 2, 'UTF-16 length is 2');
  assert.equal(countCodePoints(thumb), 1, 'Unicode code points count must be 1');

  const rocket = '🚀';
  assert.equal(rocket.length, 2, 'UTF-16 length is 2');
  assert.equal(countCodePoints(rocket), 1, 'Unicode code points count must be 1');

  // CJK Extension B: '𠮷' (U+20BB7)
  const cjkExtB = '𠮷';
  assert.equal(cjkExtB.length, 2, 'UTF-16 length is 2');
  assert.equal(countCodePoints(cjkExtB), 1, 'Unicode code points count must be 1');

  // Combined mixed string: 'A' (1) + '𠮷' (1) + 'B' (1) + '🚀' (1) + 'C' (1) = 5 code points, length = 7
  const mixed = 'A𠮷B🚀C';
  assert.equal(mixed.length, 7);
  assert.equal(countCodePoints(mixed), 5);

  // Non-string handling
  assert.equal(countCodePoints(null), 0);
  assert.equal(countCodePoints(undefined), 0);
});

test('createLimitState: returns empty initial state', () => {
  const state = createLimitState();
  assert.ok(state && Array.isArray(state.events));
  assert.equal(state.events.length, 0);
});

test('prune: removes events >= windowSeconds*1000 and retains newer events', () => {
  const now = 100000;
  const windowSec = 60;
  const windowMs = 60000;

  const state = {
    events: [
      { t: now - 70000, codePoints: 100 }, // Expired
      { t: now - 60000, codePoints: 200 }, // Exactly at boundary (now - t == 60000) -> pruned
      { t: now - 59999, codePoints: 300 }, // Active (retained)
      { t: now - 1000, codePoints: 400 }   // Active (retained)
    ]
  };

  prune(state, now, windowSec);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].codePoints, 300);
  assert.equal(state.events[1].codePoints, 400);

  // Safe with null/malformed state
  const safe1 = prune(null, now, windowSec);
  assert.deepEqual(safe1, { events: [] });
  const safe2 = prune({}, now, windowSec);
  assert.deepEqual(safe2, { events: [] });
});

test('evaluate: allowed when empty, exact boundaries, and proper exceeded tracking', () => {
  const limits = { maxBatches: 4, maxSourceCodePoints: 12000, windowSeconds: 60 };
  const now = 500000;

  // 1. Allowed when state is empty
  const state = createLimitState();
  const res1 = evaluate(state, { batches: 1, codePoints: 1000 }, limits, now);
  assert.equal(res1.allowed, true);
  assert.equal(res1.retryAfterMs, 0);
  assert.equal(res1.used.batches, 0);
  assert.equal(res1.used.codePoints, 0);
  assert.equal(res1.exceeded, null);

  // Record 3 batches of 3000 code points each (total 3 batches, 9000 code points)
  record(state, { batches: 1, codePoints: 3000 }, now - 40000);
  record(state, { batches: 1, codePoints: 3000 }, now - 30000);
  record(state, { batches: 1, codePoints: 3000 }, now - 20000);

  // Exact boundary 1: 4th batch with 3000 code points -> exactly 4 batches, 12000 code points -> allowed!
  const resExact = evaluate(state, { batches: 1, codePoints: 3000 }, limits, now);
  assert.equal(resExact.allowed, true);
  assert.equal(resExact.retryAfterMs, 0);
  assert.equal(resExact.used.batches, 3);
  assert.equal(resExact.used.codePoints, 9000);

  // Exceeding code points: 4th batch with 3001 code points -> 12001 code points -> denied!
  const resExceedCp = evaluate(state, { batches: 1, codePoints: 3001 }, limits, now);
  assert.equal(resExceedCp.allowed, false);
  assert.equal(resExceedCp.exceeded, 'codePoints');
  assert.equal(resExceedCp.used.batches, 3);
  assert.equal(resExceedCp.used.codePoints, 9000);
  assert.ok(resExceedCp.retryAfterMs > 0);
  // To free 1 code point, the oldest event (now - 40000, 3000 code points) must expire at (now - 40000 + 60000) = now + 20000
  assert.equal(resExceedCp.retryAfterMs, 20000);

  // Record 4th batch
  record(state, { batches: 1, codePoints: 2000 }, now - 10000);
  // Current state: 4 batches, 11000 code points

  // Exceeding batches: 5th batch with 500 code points (total 11500 code points < 12000, but 5 batches > 4)
  const resExceedBatches = evaluate(state, { batches: 1, codePoints: 500 }, limits, now);
  assert.equal(resExceedBatches.allowed, false);
  assert.equal(resExceedBatches.exceeded, 'batches');
  // 1 oldest event must expire (now - 40000) -> 20000ms wait
  assert.equal(resExceedBatches.retryAfterMs, 20000);
});

test('evaluate: dual cap bottleneck & sliding window expiry', () => {
  const limits = { maxBatches: 2, maxSourceCodePoints: 5000, windowSeconds: 60 };
  const now = 200000;
  const state = createLimitState();

  // Event 1: at now - 50000 (expires at now + 10000), 2000 code points
  record(state, { batches: 1, codePoints: 2000 }, now - 50000);
  // Event 2: at now - 20000 (expires at now + 40000), 2500 code points
  record(state, { batches: 1, codePoints: 2500 }, now - 20000);
  // Current: 2 batches, 4500 code points

  // New batch: cost = { batches: 1, codePoints: 2000 }
  // Batches: 2 + 1 = 3 > 2 -> needs 1 batch to expire -> event 1 must expire -> wait 10000ms
  // Code points: 4500 + 2000 = 6500 > 5000 -> deficit = 1500 -> event 1 frees 2000 >= 1500 -> wait 10000ms
  const eval1 = evaluate(state, { batches: 1, codePoints: 2000 }, limits, now);
  assert.equal(eval1.allowed, false);
  assert.equal(eval1.retryAfterMs, 10000);

  // New batch with larger code points: cost = { batches: 1, codePoints: 3000 }
  // Batches: needs 1 batch to expire -> wait 10000ms
  // Code points: 4500 + 3000 = 7500 > 5000 -> deficit = 2500 -> event 1 frees 2000 < 2500, needs event 2!
  // Event 2 expires at now + 40000 -> wait 40000ms!
  // Bottleneck is code points!
  const eval2 = evaluate(state, { batches: 1, codePoints: 3000 }, limits, now);
  assert.equal(eval2.allowed, false);
  assert.equal(eval2.exceeded, 'codePoints');
  assert.equal(eval2.retryAfterMs, 40000);

  // After 60s, window slides past event 1:
  const nowLater = now + 10001; // now - 50000 + 60000 = now + 10000, so event 1 is expired at now + 10001
  const evalLater = evaluate(state, { batches: 1, codePoints: 2000 }, limits, nowLater);
  assert.equal(evalLater.allowed, true);
  assert.equal(evalLater.retryAfterMs, 0);
  assert.equal(evalLater.used.batches, 1);
  assert.equal(evalLater.used.codePoints, 2500);
});

test('resolveLimits: defaults and overrides', () => {
  // Defaults from contract
  const d = resolveLimits();
  assert.equal(d.windowSeconds, 60);
  assert.equal(d.tab.maxBatches, 4);
  assert.equal(d.tab.maxSourceCodePoints, 12000);
  assert.equal(d.site.maxBatches, 12);
  assert.equal(d.site.maxSourceCodePoints, 36000);

  // Custom valid override
  const custom = resolveLimits({
    windowSeconds: 30,
    tab: { maxBatches: 2, maxSourceCodePoints: 5000 },
    site: { maxBatches: 6 }
  });
  assert.equal(custom.windowSeconds, 30);
  assert.equal(custom.tab.maxBatches, 2);
  assert.equal(custom.tab.maxSourceCodePoints, 5000);
  assert.equal(custom.site.maxBatches, 6);
  assert.equal(custom.site.maxSourceCodePoints, 36000); // kept default

  // Invalid / negative values fall back to defaults
  const invalid = resolveLimits({
    windowSeconds: -5,
    tab: { maxBatches: 0, maxSourceCodePoints: 'bad' },
    site: null
  });
  assert.equal(invalid.windowSeconds, 60);
  assert.equal(invalid.tab.maxBatches, 4);
  assert.equal(invalid.tab.maxSourceCodePoints, 12000);
  assert.equal(invalid.site.maxBatches, 12);
});

test('evaluate: retryAfterMs precision for batches and code points', () => {
  const limits = { maxBatches: 2, maxSourceCodePoints: 1000, windowSeconds: 10 };
  const now = 100000;
  const state = createLimitState();

  // 1. Batches limit: 2 events spaced by 2s
  record(state, { batches: 1, codePoints: 100 }, now - 8000); // expires at now + 2000
  record(state, { batches: 1, codePoints: 100 }, now - 4000); // expires at now + 6000

  // 3rd batch: needs 1 event to expire -> event 1 expires in 2000ms
  const res1 = evaluate(state, { batches: 1, codePoints: 100 }, limits, now);
  assert.equal(res1.allowed, false);
  assert.equal(res1.exceeded, 'batches');
  assert.equal(res1.retryAfterMs, 2000);

  // 2. Code points limit: state with 1 event of 800 code points
  const stateCp = createLimitState();
  record(stateCp, { batches: 1, codePoints: 800 }, now - 5000); // expires at now + 5000

  // Batch with 400 code points (total 1200 > 1000, but 2 batches <= 2)
  const resCp = evaluate(stateCp, { batches: 1, codePoints: 400 }, limits, now);
  assert.equal(resCp.allowed, false);
  assert.equal(resCp.exceeded, 'codePoints');
  assert.equal(resCp.retryAfterMs, 5000);
});

test('resilience: invalid, corrupt, or undefined state handled gracefully', () => {
  const limits = { maxBatches: 4, maxSourceCodePoints: 12000, windowSeconds: 60 };
  const now = 100000;

  // null state
  const resNull = evaluate(null, { batches: 1, codePoints: 100 }, limits, now);
  assert.equal(resNull.allowed, true);

  // undefined state
  const resUndef = evaluate(undefined, { batches: 1, codePoints: 100 }, limits, now);
  assert.equal(resUndef.allowed, true);

  // corrupt events array
  const resCorrupt = evaluate({ events: 'not-an-array' }, { batches: 1, codePoints: 100 }, limits, now);
  assert.equal(resCorrupt.allowed, true);

  // corrupt event entries
  const corruptEntriesState = {
    events: [null, undefined, { notAnEvent: true }, { t: now - 1000, codePoints: 'invalid' }]
  };
  const resEntries = evaluate(corruptEntriesState, { batches: 1, codePoints: 100 }, limits, now);
  assert.equal(resEntries.allowed, true);

  // record on corrupt state
  const stateToFix = {};
  record(stateToFix, { batches: 1, codePoints: 50 }, now);
  assert.ok(Array.isArray(stateToFix.events));
  assert.equal(stateToFix.events.length, 1);
  assert.equal(stateToFix.events[0].codePoints, 50);

  // prune on corrupt state
  const pruned = prune({ events: null }, now, 60);
  assert.deepEqual(pruned.events, []);
});

