// WebMCP Translator Kit — Popup Module: State & Autosave
// Handles rate limit clamping, dirty state tracking, and settings patch generation

import {
  clampTabMaxBatches,
  clampSiteMaxBatches,
  clampProviderConcurrency,
  clampFabSize
} from '../../settings.mjs';

export function clampRateLimitTunables({ tabBatches, siteBatches, concurrency } = {}) {
  return {
    tabBatches: clampTabMaxBatches(tabBatches),
    siteBatches: clampSiteMaxBatches(siteBatches),
    concurrency: clampProviderConcurrency(concurrency)
  };
}

export function buildRateLimitsConfig({
  tabBatches,
  siteBatches,
  concurrency,
  savedLimits = {}
} = {}) {
  const clamped = clampRateLimitTunables({ tabBatches, siteBatches, concurrency });
  return {
    providerConcurrency: clamped.concurrency,
    rateLimits: {
      windowSeconds: 60,
      tab: {
        maxBatches: clamped.tabBatches,
        maxSourceCodePoints: savedLimits?.tab?.maxSourceCodePoints || 12000
      },
      site: {
        maxBatches: clamped.siteBatches,
        maxSourceCodePoints: savedLimits?.site?.maxSourceCodePoints || 36000
      }
    }
  };
}

export function collectCleanFallbacks({
  fallbacks = [],
  doc = typeof document !== 'undefined' ? document : null,
  isSecureOrLoopbackBaseURL,
  currentUiLocale,
  t,
  DEFAULT_MODEL = 'ag/gemini-3.1-pro-low'
} = {}) {
  const out = [];
  for (let i = 0; i < fallbacks.length; i++) {
    const fb = fallbacks[i];
    const fbUrlInput = doc ? doc.getElementById(`input-fallback-url-${i}`) : null;
    const fbModelSelect = doc ? doc.getElementById(`select-fallback-${i}`) : null;
    const fbUrl = fbUrlInput ? fbUrlInput.value.trim() : (fb.baseURL || '');
    const fbModel = fbModelSelect ? fbModelSelect.value : (fb.model || DEFAULT_MODEL);
    if (fbUrl) {
      if (!/^https?:\/\/.+/i.test(fbUrl) || (isSecureOrLoopbackBaseURL && !isSecureOrLoopbackBaseURL(fbUrl))) {
        return { fallbacks: null, error: t(currentUiLocale, 'err_fallback_base_url_invalid', { index: i + 1 }) };
      }
    }
    out.push({ id: fb.id || `fb${i + 1}`, model: fbModel, baseURL: fbUrl || undefined });
  }
  return { fallbacks: out, error: null };
}
