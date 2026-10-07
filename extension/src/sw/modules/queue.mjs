// WebMCP Translator Kit — Background Module: Queue & Watchdog
// Handles watchdog reconciliation, fallback plans, provider chain calculations, and error categorization

import { normalizeOrigin } from '../../consent.mjs';

export const STOP_ERROR_CODES = Object.freeze([
  'HTTP_401',
  'HTTP_403',
  'HTTP_404',
  'HTTP_429',
  'DATA_CONSENT_REQUIRED',
  'INSECURE_ENDPOINT_BLOCKED',
  'ENDPOINT_REDIRECT_UNSUPPORTED',
  'MISSING_CONFIG',
  'MODEL_NOT_ALLOWED',
  'PERMISSION_REQUIRED',
  'OPT_IN_REQUIRED',
  'SITE_NOT_ALLOWED',
  'RATE_LIMITED',
  'RATE_STATE_UNAVAILABLE',
  'CAP_EXCEEDED',
  'INVALID_SCHEMA',
  'ABORTED',
  'DROPPED_ON_RESTART'
]);

export const FALLBACK_ELIGIBLE_CODES = Object.freeze([
  'NETWORK',
  'TIMEOUT',
  'HTTP_5xx'
]);

export function reconcileWatchdog(state = {}) {
  const {
    queue = [],
    queueLength = Array.isArray(queue) ? queue.length : (typeof queue === 'number' ? queue : 0),
    inFlight = 0,
    watching = false,
    collected = 0,
    applied = 0,
    failed = 0,
    runToken = 0,
    rounds = 0,
    lastApplied = 0
  } = state;

  if (queueLength > 0 || inFlight > 0 || !watching) {
    return {
      action: 'none',
      shouldRequeue: false,
      stable: false,
      rounds,
      failed,
      applied,
      collected,
      runToken
    };
  }

  const unapplied = Math.max(0, collected - applied - failed);

  if (unapplied === 0) {
    return {
      action: 'stable',
      shouldRequeue: false,
      stable: true,
      rounds,
      failed,
      applied,
      collected,
      runToken,
      unappliedRemainder: 0
    };
  }

  if (rounds >= 2 || (rounds > 0 && applied <= lastApplied)) {
    const finalFailed = failed + unapplied;
    return {
      action: 'finalize',
      shouldRequeue: false,
      stable: true,
      rounds,
      failed: finalFailed,
      applied,
      collected,
      runToken,
      unappliedRemainder: unapplied,
      logEntry: {
        code: 'WATCHDOG_UNAPPLIED',
        message: `Watchdog reconciliation: ${unapplied} item(s) unapplied after retry`,
        details: { unappliedRemainder: unapplied, finalFailed }
      },
      stoppedReason: rounds >= 2 ? 'max_rounds' : 'no_progress'
    };
  }

  const nextRound = rounds + 1;
  const backoffMs = nextRound * 500;
  return {
    action: 'requeue',
    shouldRequeue: true,
    stable: false,
    rounds: nextRound,
    lastApplied: applied,
    backoffMs,
    unappliedCount: unapplied,
    failed,
    applied,
    collected,
    runToken
  };
}

export function resolveFallbackPlan(err, chain, attemptIndex = 0, options = {}) {
  if (!err) {
    return { shouldFallback: false, reason: 'NO_ERROR' };
  }

  const code = (typeof err === 'object' && err !== null)
    ? (err.error?.code || err.code || '')
    : '';

  const details = (typeof err === 'object' && err !== null)
    ? (err.error?.details || err.details || {})
    : {};

  const rawHead = details?.rawHead || '';
  const isErrJson = Boolean(details?.isErrorJson) || (
    typeof rawHead === 'string' &&
    /["']?error["']?\s*:/i.test(rawHead) &&
    !(/["']?results["']?\s*:/i.test(rawHead) || /["']results["']/i.test(rawHead) || /\{\s*["']?id["']?/i.test(rawHead))
  );

  const isExhaustedZeroItem = code === 'INVALID_SCHEMA' &&
    !isErrJson &&
    Boolean(details?.exhausted || err?.exhausted || err?.error?.exhausted);

  if (STOP_ERROR_CODES.includes(code)) {
    if (!isExhaustedZeroItem) {
      return {
        shouldFallback: false,
        reason: 'STOP_LIST',
        terminalError: err,
        attemptIndex
      };
    }
  }

  if (!FALLBACK_ELIGIBLE_CODES.includes(code) && !isExhaustedZeroItem) {
    return {
      shouldFallback: false,
      reason: 'NOT_ELIGIBLE',
      terminalError: err,
      attemptIndex
    };
  }

  if (!Array.isArray(chain) || chain.length <= 1) {
    return {
      shouldFallback: false,
      reason: 'NO_FALLBACK_MODELS',
      terminalError: err,
      attemptIndex
    };
  }

  if (options?.fallbackConsumed || details.fallbackConsumed || (isExhaustedZeroItem && attemptIndex > 0)) {
    return {
      shouldFallback: false,
      reason: 'FALLBACK_CONSUMED',
      terminalError: err,
      attemptIndex
    };
  }

  const nextIndex = attemptIndex + 1;
  if (nextIndex >= chain.length || nextIndex >= 3) {
    return {
      shouldFallback: false,
      reason: 'CHAIN_EXHAUSTED',
      terminalError: err,
      attemptIndex
    };
  }

  const nextItem = chain[nextIndex];
  const nextModel = typeof nextItem === 'string'
    ? nextItem.trim()
    : (nextItem && typeof nextItem.model === 'string' ? nextItem.model.trim() : '');

  if (!nextModel) {
    return {
      shouldFallback: false,
      reason: 'INVALID_NEXT_MODEL',
      terminalError: err,
      attemptIndex
    };
  }

  return {
    shouldFallback: true,
    nextIndex,
    nextModel,
    nextConfig: typeof nextItem === 'object' ? nextItem : undefined
  };
}

export function extractHost(urlStr) {
  try {
    return new URL(urlStr).host;
  } catch {
    return '';
  }
}

export function resolveFallbackChain(settings = {}, fallbackApiKeys = {}, primaryKey = '') {
  const primaryModel = settings.model || 'ag/gemini-3.1-pro-low';
  const configuredFallbacks = Array.isArray(settings.fallbacks) ? settings.fallbacks : [];
  const match = settings.fallbackConsumed && configuredFallbacks.find((fb) => fb && fb.model && fb.model.trim() === primaryModel);
  let primaryBaseURL = settings.baseURL || '';
  let primaryApiKey = primaryKey || '';
  if (match) {
    const fbId = typeof match.id === 'string' && match.id.trim() ? match.id.trim() : 'fb1';
    if (match.baseURL && typeof match.baseURL === 'string') primaryBaseURL = match.baseURL.trim();
    if (fbId && fallbackApiKeys && fallbackApiKeys[fbId]) {
      primaryApiKey = fallbackApiKeys[fbId];
    }
  }
  const primaryConfig = {
    id: 'primary',
    baseURL: primaryBaseURL,
    apiKey: primaryApiKey,
    model: primaryModel
  };

  const primaryOrigin = primaryConfig.baseURL ? normalizeOrigin(primaryConfig.baseURL) : null;
  const fallbackConfigs = [];
  const skippedFallbacks = [];

  for (const fb of configuredFallbacks) {
    if (fb && typeof fb === 'object' && fb.model) {
      const fbId = typeof fb.id === 'string' && fb.id.trim() ? fb.id.trim() : 'fb1';
      const fbBaseURL = (typeof fb.baseURL === 'string' && fb.baseURL.trim()) ? fb.baseURL.trim() : primaryConfig.baseURL;
      const fbOrigin = fbBaseURL ? normalizeOrigin(fbBaseURL) : primaryOrigin;
      const hasDedicatedKey = Boolean(fbId && fallbackApiKeys && fallbackApiKeys[fbId]);

      if (hasDedicatedKey) {
        fallbackConfigs.push({
          id: fbId,
          baseURL: fbBaseURL,
          apiKey: fallbackApiKeys[fbId],
          model: fb.model.trim()
        });
      } else if (fbOrigin && primaryOrigin && fbOrigin === primaryOrigin) {
        fallbackConfigs.push({
          id: fbId,
          baseURL: fbBaseURL,
          apiKey: primaryKey || '',
          model: fb.model.trim()
        });
      } else {
        skippedFallbacks.push({
          id: fbId,
          reason: 'missing_key_for_origin'
        });
      }
    }
  }

  const chain = [primaryConfig, ...fallbackConfigs].slice(0, 3);
  chain.skippedFallbacks = skippedFallbacks;
  return chain;
}

export function fallbacksEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i] || {};
    const itemB = b[i] || {};
    if (itemA.id !== itemB.id) return false;
    if ((itemA.baseURL || '') !== (itemB.baseURL || '')) return false;
    if (itemA.model !== itemB.model) return false;
  }
  return true;
}
