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
