// WebMCP Translator Kit — Pure Rate Limiting Module
// Contract Version: webmcp-translator-contract/1
// Pure module: No chrome.* APIs used.

export const DEFAULT_RATE_LIMITS = {
  windowSeconds: 60,
  tab: {
    maxBatches: 4,
    maxSourceCodePoints: 12000
  },
  site: {
    maxBatches: 12,
    maxSourceCodePoints: 36000
  }
};

/**
 * Counts Unicode code points using Array.from(str).length.
 * Correctly counts surrogate pairs (e.g. emoji, CJK Ext-B) as 1 code point.
 */
export function countCodePoints(str) {
  if (typeof str !== 'string' || str.length === 0) return 0;
  return Array.from(str).length;
}

/**
 * Creates an empty limit state object.
 */
export function createLimitState() {
  return { events: [] };
}

/**
 * Prunes events older than the sliding window.
 * Event timestamp t is pruned if now - t >= windowSeconds * 1000.
 */
export function prune(state, now, windowSeconds = 60) {
  if (!state || typeof state !== 'object') {
    return { events: [] };
  }
  if (!Array.isArray(state.events)) {
    state.events = [];
    return state;
  }
  const winSec = (typeof windowSeconds === 'number' && windowSeconds > 0) ? windowSeconds : 60;
  const windowMs = winSec * 1000;
  const cutoff = now - windowMs;
  state.events = state.events.filter((e) => e && typeof e.t === 'number' && e.t > cutoff);
  return state;
}

/**
 * Evaluates whether a new batch with given cost is allowed under the limits.
 *
 * @param {object} state - limit state with { events: Array<{ t: number, codePoints: number }> }
 * @param {object} cost - { batches: number, codePoints: number }
 * @param {object} limits - { maxBatches: number, maxSourceCodePoints: number, windowSeconds?: number }
 * @param {number} now - current timestamp in ms
 * @param {number} [windowSeconds=60] - fallback window in seconds
 * @returns {{ allowed: boolean, retryAfterMs: number, used: { batches: number, codePoints: number }, exceeded: null|'batches'|'codePoints' }}
 */
export function evaluate(state, cost, limits, now, windowSeconds = 60) {
  if (!state || !Array.isArray(state.events)) {
    state = createLimitState();
  }
  const winSec = (limits && typeof limits.windowSeconds === 'number' && limits.windowSeconds > 0)
    ? limits.windowSeconds
    : (typeof windowSeconds === 'number' && windowSeconds > 0 ? windowSeconds : 60);

  prune(state, now, winSec);

  const maxBatches = limits?.maxBatches ?? 4;
  const maxCodePoints = limits?.maxSourceCodePoints ?? 12000;
  const reqBatches = cost?.batches ?? 1;
  const reqCodePoints = cost?.codePoints ?? 0;

  let usedBatches = state.events.length;
  let usedCodePoints = 0;
  for (let i = 0; i < state.events.length; i++) {
    usedCodePoints += state.events[i].codePoints || 0;
  }

  const batchesExceeded = (usedBatches + reqBatches) > maxBatches;
  const codePointsExceeded = (usedCodePoints + reqCodePoints) > maxCodePoints;

  if (!batchesExceeded && !codePointsExceeded) {
    return {
      allowed: true,
      retryAfterMs: 0,
      used: { batches: usedBatches, codePoints: usedCodePoints },
      exceeded: null
    };
  }

  // Calculate retryAfterMs for batches
  let waitBatchesMs = 0;
  if (batchesExceeded) {
    const k = usedBatches + reqBatches - maxBatches;
    // We need the oldest k events to expire
    if (k > 0 && k <= state.events.length) {
      const targetEvent = state.events[k - 1];
      waitBatchesMs = Math.max(0, targetEvent.t + winSec * 1000 - now);
    } else {
      waitBatchesMs = winSec * 1000;
    }
  }

  // Calculate retryAfterMs for code points
  let waitCodePointsMs = 0;
  if (codePointsExceeded) {
    const needToFree = usedCodePoints + reqCodePoints - maxCodePoints;
    let freed = 0;
    let targetIndex = -1;
    for (let i = 0; i < state.events.length; i++) {
      freed += state.events[i].codePoints || 0;
      if (freed >= needToFree) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex >= 0) {
      waitCodePointsMs = Math.max(0, state.events[targetIndex].t + winSec * 1000 - now);
    } else {
      waitCodePointsMs = winSec * 1000;
    }
  }

  const retryAfterMs = Math.max(1, Math.ceil(Math.max(waitBatchesMs, waitCodePointsMs)));

  let exceeded = null;
  if (batchesExceeded && !codePointsExceeded) {
    exceeded = 'batches';
  } else if (!batchesExceeded && codePointsExceeded) {
    exceeded = 'codePoints';
  } else {
    // Both exceeded: bottleneck determines exceeded metric
    exceeded = waitCodePointsMs > waitBatchesMs ? 'codePoints' : 'batches';
  }

  return {
    allowed: false,
    retryAfterMs,
    used: { batches: usedBatches, codePoints: usedCodePoints },
    exceeded
  };
}

/**
 * Records an admitted batch cost.
 */
export function record(state, cost, now) {
  if (!state || typeof state !== 'object') return;
  if (!Array.isArray(state.events)) {
    state.events = [];
  }
  const codePoints = cost?.codePoints ?? 0;
  state.events.push({
    t: now,
    codePoints
  });
}

/**
 * Resolves limits from settings or falls back to defaults.
 */
export function resolveLimits(settingsRateLimits) {
  const defaults = DEFAULT_RATE_LIMITS;
  if (!settingsRateLimits || typeof settingsRateLimits !== 'object') {
    return {
      windowSeconds: defaults.windowSeconds,
      tab: { ...defaults.tab },
      site: { ...defaults.site }
    };
  }

  const windowSeconds = (typeof settingsRateLimits.windowSeconds === 'number' && settingsRateLimits.windowSeconds > 0)
    ? settingsRateLimits.windowSeconds
    : defaults.windowSeconds;

  const tab = {
    maxBatches: (typeof settingsRateLimits.tab?.maxBatches === 'number' && settingsRateLimits.tab.maxBatches > 0)
      ? settingsRateLimits.tab.maxBatches
      : defaults.tab.maxBatches,
    maxSourceCodePoints: (typeof settingsRateLimits.tab?.maxSourceCodePoints === 'number' && settingsRateLimits.tab.maxSourceCodePoints > 0)
      ? settingsRateLimits.tab.maxSourceCodePoints
      : defaults.tab.maxSourceCodePoints
  };

  const site = {
    maxBatches: (typeof settingsRateLimits.site?.maxBatches === 'number' && settingsRateLimits.site.maxBatches > 0)
      ? settingsRateLimits.site.maxBatches
      : defaults.site.maxBatches,
    maxSourceCodePoints: (typeof settingsRateLimits.site?.maxSourceCodePoints === 'number' && settingsRateLimits.site.maxSourceCodePoints > 0)
      ? settingsRateLimits.site.maxSourceCodePoints
      : defaults.site.maxSourceCodePoints
  };

  return { windowSeconds, tab, site };
}
