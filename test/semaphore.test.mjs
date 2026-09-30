// WebMCP Translator Kit — Semaphore Unit Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSemaphore,
  SemaphoreTimeoutError
} from '../extension/src/semaphore.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('semaphore: limit 2 allows 2 concurrent acquisitions and queues 3rd', async () => {
  const sem = createSemaphore({ maxConcurrency: 2, timeoutMs: 5000 });
  assert.equal(sem.active(), 0);
  assert.equal(sem.waiting(), 0);

  // 1st acquires immediately
  await sem.acquire();
  assert.equal(sem.active(), 1);
  assert.equal(sem.waiting(), 0);

  // 2nd acquires immediately
  await sem.acquire();
  assert.equal(sem.active(), 2);
  assert.equal(sem.waiting(), 0);

  // 3rd is queued
  let thirdAcquired = false;
  const thirdPromise = sem.acquire().then(() => {
    thirdAcquired = true;
  });

  await sleep(10);
  assert.equal(thirdAcquired, false, '3rd must wait in queue');
  assert.equal(sem.active(), 2);
  assert.equal(sem.waiting(), 1);

  // Release 1 slot
  sem.release();
  await thirdPromise;
  assert.equal(thirdAcquired, true, '3rd acquires after a release');
  assert.equal(sem.active(), 2);
  assert.equal(sem.waiting(), 0);

  sem.release();
  sem.release();
  assert.equal(sem.active(), 0);
});

test('semaphore: strict FIFO ordering', async () => {
  const sem = createSemaphore({ maxConcurrency: 1, timeoutMs: 5000 });
  await sem.acquire(); // slot taken

  const order = [];
  const p1 = sem.acquire().then(() => { order.push('first'); });
  const p2 = sem.acquire().then(() => { order.push('second'); });
  const p3 = sem.acquire().then(() => { order.push('third'); });

  assert.equal(sem.waiting(), 3);

  sem.release();
  await p1;
  assert.deepEqual(order, ['first']);

  sem.release();
  await p2;
  assert.deepEqual(order, ['first', 'second']);

  sem.release();
  await p3;
  assert.deepEqual(order, ['first', 'second', 'third']);

  sem.release();
  assert.equal(sem.active(), 0);
});

test('semaphore: release in finally prevents deadlock on error', async () => {
  const sem = createSemaphore({ maxConcurrency: 2, timeoutMs: 5000 });
  await sem.acquire(); // slot 1
  await sem.acquire(); // slot 2

  let thirdAcquired = false;
  const p3 = sem.acquire().then(() => {
    thirdAcquired = true;
  });

  // Task on slot 2 throws an error, but releases in finally
  try {
    throw new Error('Simulated provider failure');
  } catch (err) {
    // handled
  } finally {
    sem.release();
  }

  await p3;
  assert.equal(thirdAcquired, true, 'Waiter must acquire even when active task throws');

  sem.release();
  sem.release();
  assert.equal(sem.active(), 0);
});

test('semaphore: acquisition timeout throws typed TIMEOUT error', async () => {
  const sem = createSemaphore({ maxConcurrency: 1, timeoutMs: 50 });
  await sem.acquire(); // slot taken

  let errorCaught = null;
  try {
    await sem.acquire(50); // custom timeout 50ms
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught, 'Expected acquisition to reject on timeout');
  assert.equal(errorCaught.code, 'TIMEOUT');
  assert.equal(errorCaught.retryable, false);
  assert.ok(errorCaught instanceof SemaphoreTimeoutError);
  assert.equal(sem.waiting(), 0, 'Timed out waiter must be removed from queue');

  // Slot freed afterwards
  sem.release();
  assert.equal(sem.active(), 0);

  // Subsequent acquire succeeds normally
  await sem.acquire();
  assert.equal(sem.active(), 1);
  sem.release();
});

test('semaphore: withPermit wrapper executes and releases cleanly', async () => {
  const sem = createSemaphore({ maxConcurrency: 2 });
  const result = await sem.withPermit(async () => {
    assert.equal(sem.active(), 1);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(sem.active(), 0);

  // withPermit handles exceptions
  await assert.rejects(
    () => sem.withPermit(async () => {
      assert.equal(sem.active(), 1);
      throw new Error('error in permit');
    }),
    /error in permit/
  );
  assert.equal(sem.active(), 0);
});

test('semaphore: pre-aborted signal rejects immediately without occupying slot', async () => {
  const sem = createSemaphore({ maxConcurrency: 1 });
  const controller = new AbortController();
  controller.abort('pre_aborted');

  await assert.rejects(
    () => sem.acquire(undefined, controller.signal),
    (err) => err.code === 'ABORTED' && err.name === 'AbortError'
  );
  assert.equal(sem.active(), 0);
  assert.equal(sem.waiting(), 0);
});

test('semaphore: in-queue abort removes waiter and rejects immediately', async () => {
  const sem = createSemaphore({ maxConcurrency: 1 });
  await sem.acquire(); // slot 1 taken
  assert.equal(sem.active(), 1);

  const controller = new AbortController();
  const acquirePromise = sem.acquire(5000, controller.signal);
  assert.equal(sem.waiting(), 1);

  // Abort while waiting
  controller.abort('navigation');

  await assert.rejects(
    acquirePromise,
    (err) => err.code === 'ABORTED' && err.name === 'AbortError'
  );
  assert.equal(sem.waiting(), 0);
  assert.equal(sem.active(), 1);

  // Releasing the slot allows subsequent acquire
  sem.release();
  assert.equal(sem.active(), 0);
  await sem.acquire();
  assert.equal(sem.active(), 1);
  sem.release();
});

