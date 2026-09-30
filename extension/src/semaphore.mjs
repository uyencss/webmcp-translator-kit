// WebMCP Translator Kit — Concurrency Semaphore
// Contract Version: webmcp-translator-contract/1
// Pure module: No chrome.* APIs used.

export class SemaphoreTimeoutError extends Error {
  constructor(message = 'Semaphore acquisition timed out') {
    super(message);
    this.name = 'SemaphoreTimeoutError';
    this.code = 'TIMEOUT';
    this.retryable = false;
  }
}

export function createSemaphore({ maxConcurrency = 2, timeoutMs = 120000 } = {}) {
  let activeCount = 0;
  const queue = [];

  function acquire(customTimeoutMs, signal) {
    if (signal?.aborted) {
      const err = new Error(signal.reason ? String(signal.reason) : 'Semaphore acquisition aborted');
      err.name = 'AbortError';
      err.code = 'ABORTED';
      return Promise.reject(err);
    }
    if (activeCount < maxConcurrency) {
      activeCount++;
      return Promise.resolve(true);
    }

    const waitTimeoutMs = typeof customTimeoutMs === 'number' ? customTimeoutMs : timeoutMs;

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null,
        signal,
        onAbort: null
      };

      if (signal) {
        waiter.onAbort = () => {
          const idx = queue.indexOf(waiter);
          if (idx !== -1) {
            queue.splice(idx, 1);
            if (waiter.timer) clearTimeout(waiter.timer);
            const err = new Error(signal.reason ? String(signal.reason) : 'Semaphore acquisition aborted');
            err.name = 'AbortError';
            err.code = 'ABORTED';
            reject(err);
          }
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      if (waitTimeoutMs > 0 && Number.isFinite(waitTimeoutMs)) {
        waiter.timer = setTimeout(() => {
          const idx = queue.indexOf(waiter);
          if (idx !== -1) {
            queue.splice(idx, 1);
            if (waiter.onAbort && signal) {
              signal.removeEventListener('abort', waiter.onAbort);
            }
            reject(new SemaphoreTimeoutError(`Semaphore acquisition timed out after ${waitTimeoutMs}ms`));
          }
        }, waitTimeoutMs);
      }

      queue.push(waiter);
    });
  }

  function release() {
    if (queue.length > 0) {
      const next = queue.shift();
      if (next.timer) {
        clearTimeout(next.timer);
      }
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.resolve(true);
    } else {
      activeCount = Math.max(0, activeCount - 1);
    }
  }

  async function withPermit(fn, customTimeoutMs, signal) {
    await acquire(customTimeoutMs, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    acquire,
    release,
    withPermit,
    active: () => activeCount,
    waiting: () => queue.length,
    getMaxConcurrency: () => maxConcurrency
  };
}
