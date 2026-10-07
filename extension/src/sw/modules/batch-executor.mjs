// WebMCP Translator Kit — Background Module: Batch Translation Executor
// Encapsulates batch attempt execution, per-attempt cache lookup/commit, and ordered result merging

export function resolveAttemptCache({
  misses = [],
  currentHits = [],
  currentBaseURL = '',
  currentModel = '',
  payload = {},
  storedSettings = {},
  translationCache,
  PROMPT_VERSION,
  cacheKey,
  normalizeSourceText
}) {
  const attemptCacheContext = {
    baseURL: currentBaseURL || '',
    model: currentModel,
    sourceLanguage: payload.sourceLanguage || storedSettings.sourceLanguage || 'auto',
    targetLanguage: payload.targetLanguage || storedSettings.targetLanguage || 'vi',
    promptVersion: PROMPT_VERSION
  };
  const remainingMisses = [];
  for (const m of misses) {
    const normText = normalizeSourceText(m.item?.text);
    const k = cacheKey(m.item, attemptCacheContext);
    const cachedText = translationCache.get(k, normText);
    if (cachedText !== undefined) {
      currentHits.push({
        index: m.index,
        result: {
          id: m.item.id,
          revision: m.item.revision,
          text: cachedText
        }
      });
    } else {
      remainingMisses.push({
        ...m,
        key: k
      });
    }
  }

  return { remainingMisses, attemptCacheContext };
}

export async function checkL2CacheForMisses({
  remainingMisses = [],
  currentHits = [],
  storedSettings = {},
  isL2MemoryOnly,
  isL2Clearing,
  getL2Epoch,
  chromeStorageLocal,
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  normalizeSourceText,
  hashText,
  translationCache = null
}) {
  if (storedSettings.cacheEnabled === false || isL2MemoryOnly() || isL2Clearing() || remainingMisses.length === 0) {
    return remainingMisses;
  }
  try {
    if (!chromeStorageLocal) return remainingMisses;
    const readEpoch = getL2Epoch();
    const l2Res = await chromeStorageLocal.get([L2_CACHE_KEY]);
    if (!isL2MemoryOnly() && !isL2Clearing() && getL2Epoch() === readEpoch) {
      const trCache = l2Res?.[L2_CACHE_KEY];
      if (trCache && typeof trCache === 'object') {
        const now = Date.now();
        const afterL2Misses = [];
        for (const m of remainingMisses) {
          const l2Key = /^[0-9a-f]{8}$/i.test(m.key) ? m.key : hashText(m.key);
          const entry = trCache[l2Key];
          const reqHash = hashText(m.key);
          const isValidShape = entry && typeof entry === 'object' && typeof entry.text === 'string' && typeof entry.keyHash === 'string' && !('key' in entry);
          const isMatch = isValidShape && entry.keyHash === reqHash;
          if (isMatch && (now - (entry.savedAt || 0) < L2_CACHE_TTL_MS)) {
            const normText = normalizeSourceText(m.item?.text);
            if (translationCache) {
              translationCache.set(m.key, entry.text, normText);
            }
            currentHits.push({
              index: m.index,
              result: {
                id: m.item.id,
                revision: m.item.revision,
                text: entry.text
              }
            });
          } else {
            afterL2Misses.push(m);
          }
        }
        return afterL2Misses;
      }
    }
  } catch {}
  return remainingMisses;
}

export function commitTranslatedCache({
  newlyTranslatedItems = [],
  actualBaseURL = '',
  actualModel = '',
  payload = {},
  storedSettings = {},
  PROMPT_VERSION,
  cacheKey,
  normalizeSourceText,
  translationCache,
  enqueueL2Cache,
  isL2MemoryOnly
}) {
  if (newlyTranslatedItems.length === 0) return;
  const actualCacheContext = {
    baseURL: actualBaseURL || '',
    model: actualModel,
    sourceLanguage: payload.sourceLanguage || storedSettings.sourceLanguage || 'auto',
    targetLanguage: payload.targetLanguage || storedSettings.targetLanguage || 'vi',
    promptVersion: PROMPT_VERSION
  };

  for (const { item, text } of newlyTranslatedItems) {
    const k = cacheKey(item, actualCacheContext);
    translationCache.set(k, text, normalizeSourceText(item?.text));
    if (storedSettings.cacheEnabled !== false && !isL2MemoryOnly()) {
      enqueueL2Cache(k, text);
    }
  }
}

export async function mergeBatchResults({
  hits = [],
  misses = [],
  currentHits = [],
  finalProviderRes = {},
  payload = {},
  requestedModel = '',
  actualModel = '',
  currentModel = '',
  fallbackIndex = 0,
  actualBaseURL = '',
  batchConfigRevision = 0,
  currentConfigRevision = 0,
  tabId = null,
  extractHost
}) {
  const totalCount = hits.length + misses.length;
  const merged = new Array(totalCount);

  for (const h of currentHits) {
    if (h && typeof h.index === 'number') {
      merged[h.index] = h.result;
    }
  }

  const cleanResults = merged.filter(Boolean);
  const actualBaseURLHost = extractHost(actualBaseURL);
  const missingIds = Array.isArray(finalProviderRes?.missingIds) ? finalProviderRes.missingIds : [];

  return {
    ...finalProviderRes,
    results: cleanResults,
    partial: Boolean(finalProviderRes?.partial || missingIds.length > 0),
    missingIds,
    failed: missingIds.length,
    requestedModel,
    actualModel: actualModel || requestedModel,
    fallbackIndex,
    fallbackConsumed: Boolean(payload?.fallbackConsumed || (typeof fallbackIndex === 'number' && fallbackIndex > 0)),
    actualBaseURLHost,
    configRevision: batchConfigRevision,
    currentConfigRevision
  };
}
