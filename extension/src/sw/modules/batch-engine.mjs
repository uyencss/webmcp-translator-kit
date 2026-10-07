// WebMCP Translator Kit — Background Module: Batch Translation Engine
// Encapsulates the complete batch execution loop, fallback cascade, cache lookups, and error logging.

export function createBatchEngine({
  getProviderSemaphore,
  activeBatchControllers,
  tabEpochs,
  getConfigRevision,
  pushTranslateProgress,
  verifyTabDispatchPolicy,
  getStoredSettings,
  getStoredApiKey,
  resolveFallbackChain,
  DEFAULT_MODEL = 'ag/gemini-3.1-pro-low',
  resolveFallbackPlan,
  recordErrorLog,
  resolveAttemptCache,
  checkL2CacheForMisses,
  translateBatch,
  commitTranslatedCache,
  mergeBatchResults,
  extractHost,
  PROMPT_VERSION,
  cacheKey,
  normalizeSourceText,
  translationCache,
  isL2MemoryOnly,
  isL2Clearing,
  getL2Epoch,
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  hashText,
  enqueueL2Cache,
  createTypedError
}) {
  async function executeBatchTranslation({
    payload = {},
    misses = [],
    hits = [],
    batchConfigRevision = (typeof getConfigRevision === 'function' ? getConfigRevision() : 0),
    tabId = null,
    epoch = undefined,
    origin = null
  }) {
    const currentConfigRevision = typeof getConfigRevision === 'function' ? getConfigRevision() : 0;
    const forwardProgress = (item) => pushTranslateProgress(tabId, epoch, item);
    const requestId = payload.requestId || ('req_' + Math.random().toString(36).slice(2));
    let controller = null;
    if (typeof tabId === 'number') {
      controller = new AbortController();
      activeBatchControllers.set(requestId, {
        controller,
        tabId,
        revision: batchConfigRevision,
        epoch,
        origin
      });
    }

    const currentSemaphore = getProviderSemaphore();
    const signal = controller ? controller.signal : payload.signal;

    try {
      await currentSemaphore.acquire(undefined, signal);
    } catch (err) {
      if (controller) {
        activeBatchControllers.delete(requestId);
      }
      if (err?.code === 'TIMEOUT') {
        return createTypedError('TIMEOUT', 'Provider concurrency queue timed out waiting for available slot', false, {
          maxConcurrentRequests: currentSemaphore.getMaxConcurrency()
        });
      }
      if (err?.code === 'ABORTED' || err?.name === 'AbortError') {
        return createTypedError('ABORTED', 'Operation aborted before acquiring provider slot', false, {
          reason: signal?.reason ? String(signal.reason) : 'aborted'
        });
      }
      throw err;
    }

    // After acquiring semaphore: check if already aborted while waiting for permit
    if (signal?.aborted) {
      currentSemaphore.release();
      if (controller) {
        activeBatchControllers.delete(requestId);
      }
      return createTypedError('ABORTED', 'Operation aborted before acquiring provider slot', false, {
        reason: signal.reason ? String(signal.reason) : 'aborted'
      });
    }

    // Pre-dispatch guard: verify configuration revision, tab existence, origin match, consent, and tab epoch
    const guardCheck = await verifyTabDispatchPolicy({
      tabId,
      origin,
      epoch,
      expectedConfigRevision: batchConfigRevision
    });
    if (guardCheck && guardCheck.error) {
      currentSemaphore.release();
      if (controller) {
        activeBatchControllers.delete(requestId);
      }
      return guardCheck;
    }

    const storedSettings = await getStoredSettings();
    const primaryKey = await getStoredApiKey();
    let storedFbKeys = {};
    try {
      const fbKeysRes = await chrome.storage.local.get(['fallback_api_keys']);
      storedFbKeys = fbKeysRes.fallback_api_keys || {};
    } catch {}

    const chain = resolveFallbackChain(
      (payload && typeof payload.model === 'string' && payload.model.trim())
        ? { ...storedSettings, model: payload.model.trim(), fallbackConsumed: Boolean(payload?.fallbackConsumed) }
        : { ...storedSettings, fallbackConsumed: Boolean(payload?.fallbackConsumed) },
      storedFbKeys,
      primaryKey
    );
    const requestedModel = chain[0]?.model || DEFAULT_MODEL;

    let currentMisses = [...misses];
    let currentHits = [...hits];
    let finalProviderRes = null;
    let actualModel = null;
    let actualBaseURL = chain[0]?.baseURL || storedSettings.baseURL || '';
    let fallbackIndex = 0;
    let fallbackConsumed = Boolean(payload?.fallbackConsumed);
    let lastAttemptedModel = requestedModel;
    const newlyTranslatedItems = [];

    try {
      for (let attemptIndex = 0; attemptIndex < chain.length && attemptIndex < 3; attemptIndex++) {
        const currentConfig = chain[attemptIndex];
        const currentModel = currentConfig.model;
        const currentBaseURL = currentConfig.baseURL;
        const currentApiKey = currentConfig.apiKey;
        lastAttemptedModel = currentModel;

        // Re-verify signal and policy guard before each attempt
        if (signal?.aborted) {
          return createTypedError('ABORTED', 'Operation aborted during attempt', false, {
            reason: signal.reason ? String(signal.reason) : 'aborted'
          });
        }
        const guardCheckAttempt = await verifyTabDispatchPolicy({
          tabId,
          origin,
          epoch,
          expectedConfigRevision: batchConfigRevision
        });
        if (guardCheckAttempt && guardCheckAttempt.error) {
          return guardCheckAttempt;
        }

        // Check cache for this specific attempt
        if (attemptIndex > 0) {
          const attemptCache = resolveAttemptCache({
            misses: currentMisses,
            currentHits,
            currentBaseURL,
            currentModel,
            payload,
            storedSettings,
            translationCache,
            PROMPT_VERSION,
            cacheKey,
            normalizeSourceText
          });
          currentMisses = attemptCache.remainingMisses;

          currentMisses = await checkL2CacheForMisses({
            remainingMisses: currentMisses,
            currentHits,
            storedSettings,
            isL2MemoryOnly,
            isL2Clearing,
            getL2Epoch,
            chromeStorageLocal: typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null,
            L2_CACHE_KEY,
            L2_CACHE_TTL_MS,
            normalizeSourceText,
            hashText,
            translationCache
          });

          // If all misses hit cache for this fallback model, complete without provider call
          if (currentMisses.length === 0) {
            actualModel = currentModel;
            actualBaseURL = currentBaseURL;
            fallbackIndex = attemptIndex;
            finalProviderRes = { ok: true, results: [] };
            break;
          }
        }

        let attemptRes;
        try {
          attemptRes = await translateBatch({
            ...payload,
            baseURL: currentBaseURL,
            apiKey: currentApiKey,
            model: currentModel,
            items: currentMisses.map((m) => m.item),
            signal,
            onProgress: forwardProgress
          });
        } catch (err) {
          attemptRes = (err && err.error) ? err : createTypedError('NETWORK', err?.message || 'Network error', true);
        }

        if (attemptRes && !attemptRes.error && Array.isArray(attemptRes.results)) {
          actualModel = currentModel;
          actualBaseURL = currentBaseURL;
          fallbackIndex = attemptIndex;
          finalProviderRes = attemptRes;

          // Collect newly translated items; caching is deferred until configRevision & tabEpoch checks pass
          for (let i = 0; i < currentMisses.length; i++) {
            const miss = currentMisses[i];
            const resItem = attemptRes.results.find((r) => r && r.id === miss.item.id);
            if (resItem && typeof resItem.text === 'string') {
              newlyTranslatedItems.push({
                item: miss.item,
                text: resItem.text
              });
            }
          }

          // Add translated items to currentHits
          for (let i = 0; i < currentMisses.length; i++) {
            const miss = currentMisses[i];
            const resItem = attemptRes.results.find((r) => r && r.id === miss.item.id);
            if (resItem && typeof resItem.text === 'string') {
              currentHits.push({
                index: miss.index,
                result: {
                  id: miss.item.id,
                  revision: miss.item.revision,
                  text: resItem.text
                }
              });
            }
          }
          break;
        }

        // Handle attempt failure
        finalProviderRes = attemptRes;
        const plan = resolveFallbackPlan(attemptRes, chain, attemptIndex, { fallbackConsumed });
        if (!plan.shouldFallback) {
          break;
        }

        fallbackConsumed = true;
        if (payload) {
          payload.fallbackConsumed = true;
        }

        // Log entry ghi rõ model đã đổi (dùng message/provider-message hiện có)
        const providerMsg = attemptRes?.error?.details?.providerMessage ||
          attemptRes?.error?.message ||
          'Model fallback';
        const logMessage = `${providerMsg} (model changed: ${currentModel} -> ${plan.nextModel})`;
        await recordErrorLog({
          code: attemptRes?.error?.code || 'MODEL_FALLBACK',
          message: logMessage,
          details: {
            ...(attemptRes?.error?.details || {}),
            fromModel: currentModel,
            toModel: plan.nextModel,
            providerMessage: attemptRes?.error?.details?.providerMessage || undefined,
            fallbackConsumed: true
          }
        }, {
          model: `${currentModel} -> ${plan.nextModel}`,
          tabId,
          isTerminal: false
        });
      }
    } finally {
      currentSemaphore.release();
      if (controller) {
        activeBatchControllers.delete(requestId);
      }
    }

    if (finalProviderRes && finalProviderRes.error) {
      if (fallbackConsumed) {
        finalProviderRes.error.details = {
          ...(finalProviderRes.error.details || {}),
          fallbackConsumed: true
        };
      }
      if (chain.skippedFallbacks && chain.skippedFallbacks.length > 0) {
        finalProviderRes.error.details = {
          ...(finalProviderRes.error.details || {}),
          skippedFallbacks: chain.skippedFallbacks
        };
      }
      const finalModel = lastAttemptedModel || actualModel || requestedModel;
      if (finalProviderRes.error.details) {
        finalProviderRes.error.details.model = finalModel;
        finalProviderRes.error.details.lastAttemptedModel = finalModel;
      }
      await recordErrorLog(finalProviderRes.error, {
        model: finalModel,
        tabId,
        isTerminal: true
      });
      return finalProviderRes;
    }

    // If configuration revision changed while batch was in-flight, do NOT cache and abort
    if (batchConfigRevision !== currentConfigRevision) {
      return {
        ...createTypedError(
          'ABORTED',
          'Translation batch discarded due to configuration change',
          false,
          {
            batchConfigRevision,
            currentConfigRevision
          }
        ),
        configRevision: batchConfigRevision,
        currentConfigRevision
      };
    }

    // If tab epoch changed while batch was in-flight, do NOT cache and abort if older
    if (epoch !== undefined && tabEpochs.has(tabId) && epoch < tabEpochs.get(tabId)) {
      return createTypedError(
        'ABORTED',
        'Translation batch discarded due to epoch change',
        false,
        { reason: 'epoch_changed' }
      );
    }

    // Populate cache strictly under actualModel and actualBaseURL only after config & epoch checks pass
    commitTranslatedCache({
      newlyTranslatedItems,
      actualBaseURL,
      actualModel,
      payload,
      storedSettings,
      PROMPT_VERSION,
      cacheKey,
      normalizeSourceText,
      translationCache,
      enqueueL2Cache,
      isL2MemoryOnly
    });

    const missingIds = Array.isArray(finalProviderRes?.missingIds) ? finalProviderRes.missingIds : [];

    if (missingIds.length > 0) {
      try {
        await recordErrorLog({
          code: 'PARTIAL_BATCH',
          message: `Batch partially completed: ${missingIds.length} item(s) missing`,
          details: { missingIds }
        }, {
          model: actualModel || lastAttemptedModel,
          tabId,
          isTerminal: false
        });
      } catch {}
    }

    const batchOutcome = await mergeBatchResults({
      hits,
      misses,
      currentHits,
      finalProviderRes,
      payload,
      requestedModel,
      actualModel,
      currentModel: lastAttemptedModel,
      fallbackIndex,
      actualBaseURL,
      batchConfigRevision,
      currentConfigRevision,
      tabId,
      extractHost
    });

    return {
      ...batchOutcome,
      partial: Boolean(finalProviderRes?.partial || missingIds.length > 0),
      missingIds,
      failed: missingIds.length
    };
  }

  return {
    executeBatchTranslation
  };
}
