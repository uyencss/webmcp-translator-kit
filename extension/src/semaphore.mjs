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

  function acquire(customTimeoutMs) {
    if (activeCount < maxConcurrency) {
      activeCount++;
      return Promise.resolve(true);
    }

    const waitTimeoutMs = typeof customTimeoutMs === 'number' ? customTimeoutMs : timeoutMs;

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null
      };

      if (waitTimeoutMs > 0 && Number.isFinite(waitTimeoutMs)) {
        waiter.timer = setTimeout(() => {
          const idx = queue.indexOf(waiter);
          if (idx !== -1) {
            queue.splice(idx, 1);
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
      next.resolve(true);
    } else {
      activeCount = Math.max(0, activeCount - 1);
    }
  }

  async function withPermit(fn, customTimeoutMs) {
    await acquire(customTimeoutMs);
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
