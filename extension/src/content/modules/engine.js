// WebMCP Translator Kit — Content Script Module: Translation Dispatch Engine
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

  function sendChunk(items, settings = {}, chunkEpoch = epoch, runConfig = null) {
    if (__wmtHalted || !__wmtValidContext()) {
      __wmtHaltStale();
      return Promise.resolve({ error: { code: 'ABORTED', message: 'Extension context invalidated', retryable: false } });
    }
    const hasConsumedItem = Boolean(scrollSession?.active && Array.isArray(items) && items.some((it) => scrollSession?.fallbackConsumedIds?.has(it?.id)));
    const fallbackConsumed = Boolean(
      settings.fallbackConsumed ||
      hasConsumedItem ||
      runConfig?.fallbackConsumed ||
      (scrollSession?.active && (scrollSession?.fallbackConsumed || scrollSession?.runConfig?.fallbackConsumed))
    );
    const primaryModel =
      runConfig?.primaryModel ||
      settings?.primaryModel ||
      (!settings.fallbackConsumed ? settings.model : null) ||
      (scrollSession?.active ? scrollSession?.settings?.model : null) ||
      'ag/gemini-3.1-pro-low';

    let effectiveModel =
      (fallbackConsumed && (
        (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
        (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null)))
      )) ||
      settings.model ||
      'ag/gemini-3.1-pro-low';

    // Invariant: never dispatch contradictory { model: primary, fallbackConsumed: true }
    let dispatchFallbackConsumed = fallbackConsumed;
    if (dispatchFallbackConsumed && effectiveModel === primaryModel) {
      const pinned =
        (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
        (runConfig?.fallbackModel && runConfig.fallbackModel !== primaryModel ? runConfig.fallbackModel : null) ||
        (scrollSession?.active && (scrollSession.fallbackModel || (scrollSession.runConfig?.model !== primaryModel ? scrollSession.runConfig.model : null))) ||
        (scrollSession?.active && scrollSession?.fallbackModel && scrollSession.fallbackModel !== primaryModel ? scrollSession.fallbackModel : null) ||
        (settings.fallbackModel && settings.fallbackModel !== primaryModel ? settings.fallbackModel : null) ||
        (Array.isArray(settings.fallbacks) && settings.fallbacks[0]?.model && settings.fallbacks[0].model !== primaryModel ? settings.fallbacks[0].model : null) ||
        (scrollSession?.active && Array.isArray(scrollSession?.settings?.fallbacks) && scrollSession.settings.fallbacks[0]?.model && scrollSession.settings.fallbacks[0].model !== primaryModel ? scrollSession.settings.fallbacks[0].model : null);
      if (pinned) {
        effectiveModel = pinned;
      } else {
        dispatchFallbackConsumed = false;
      }
    }

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            action: 'TRANSLATE_BATCH',
            epoch: chunkEpoch,
            payload: {
              items,
              sourceLanguage: settings.sourceLanguage || 'auto',
              targetLanguage: settings.targetLanguage || 'vi',
              model: effectiveModel,
              ...(dispatchFallbackConsumed ? { fallbackConsumed: true } : {})
            }
          },
          (response) => {
            try {
              if (chrome.runtime && chrome.runtime.lastError) {
                const lastErrMsg = chrome.runtime.lastError.message || '';
                if (/extension context invalidated|context invalidated/i.test(lastErrMsg)) {
                  __wmtHaltStale();
                  resolve({ error: { code: 'ABORTED', message: 'Extension context invalidated', retryable: false } });
                } else if (isDroppedOnRestartError(lastErrMsg)) {
                  resolve({
                    error: {
                      code: 'DROPPED_ON_RESTART',
                      message: 'Request lost when service worker restarted',
                      retryable: false,
                      details: { originalError: lastErrMsg }
                    }
                  });
                } else {
                  resolve({ error: { code: 'NETWORK', message: lastErrMsg } });
                }
              } else {
                resolve(response);
              }
            } catch (e) {
              if (__wmtInvalidatedErr(e)) {
                __wmtHaltStale();
                resolve({ error: { code: 'ABORTED', message: 'Extension context invalidated', retryable: false } });
              } else {
                resolve({ error: { code: 'NETWORK', message: String((e && e.message) || e) } });
              }
            }
          }
        );
      } catch (e) {
        if (__wmtInvalidatedErr(e)) {
          __wmtHaltStale();
          resolve({ error: { code: 'ABORTED', message: 'Extension context invalidated', retryable: false } });
        } else {
          resolve({ error: { code: 'NETWORK', message: String((e && e.message) || e) } });
        }
      }
    });
  }

  // Chunk-level recovery: retry 1 time, binary split if depth < 2 && items.length > 8
  async function translateChunkWithRecovery(items, settings = {}, depth = 0, targetEpoch = epoch, runConfig = { revision: null }) {
    if (targetEpoch !== undefined && epoch !== targetEpoch) {
      return { cancelled: true, applied: 0, failed: 0 };
    }
    if (!items || items.length === 0) {
      return { applied: 0, failed: 0 };
    }

    const NON_RETRYABLE_CODES = new Set([
      'DROPPED_ON_RESTART',
      'OPT_IN_REQUIRED',
      'SITE_NOT_ALLOWED',
      'PERMISSION_REQUIRED',
      'KEY_ACCESS_UNAVAILABLE',
      'CONSENT_STATE_UNAVAILABLE',
      'RATE_STATE_UNAVAILABLE',
      'RATE_LIMITED',
      'MISSING_CONFIG',
      'CONSENT_DENIED',
      'INVALID_SCHEMA',
      'CAP_EXCEEDED',
      'MODEL_NOT_ALLOWED',
      'ABORTED'
    ]);

    function isNonRetryable(err) {
      if (!err) return false;
      if (NON_RETRYABLE_CODES.has(err.code)) return true;
      if (err.retryable === false && err.code !== 'TIMEOUT') return true;
      return false;
    }

    function checkRevisionMismatch(r) {
      if (!r) return null;
      if (typeof r.configRevision === 'number') {
        if (typeof r.currentConfigRevision === 'number' && r.configRevision !== r.currentConfigRevision) {
          return 'Configuration changed in-flight';
        }
        if (runConfig.revision !== null && runConfig.revision !== undefined && r.configRevision !== runConfig.revision) {
          return 'Configuration revision mismatch';
        }
        if (runConfig.revision === null) {
          runConfig.revision = r.configRevision;
        }
      }
      return null;
    }

    const primaryModel =
      runConfig?.primaryModel ||
      settings?.primaryModel ||
      (!settings.fallbackConsumed ? settings.model : null) ||
      (scrollSession?.active ? scrollSession?.settings?.model : null) ||
      'ag/gemini-3.1-pro-low';
    if (runConfig && !runConfig.primaryModel) {
      runConfig.primaryModel = primaryModel;
    }

    let currentSettings = { ...settings };
    function refreshLivePin() {
      if (targetEpoch !== undefined && epoch !== targetEpoch) return;
      const isConsumed = Boolean(
        currentSettings.fallbackConsumed ||
        settings.fallbackConsumed ||
        runConfig?.fallbackConsumed ||
        (scrollSession?.active && (scrollSession?.fallbackConsumed || scrollSession?.runConfig?.fallbackConsumed)) ||
        (scrollSession?.active && Array.isArray(items) && items.some((it) => scrollSession?.fallbackConsumedIds?.has(it?.id)))
      );
      if (isConsumed) {
        currentSettings.fallbackConsumed = true;
        const liveModel =
          (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
          (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null))) ||
          (currentSettings.model && currentSettings.model !== primaryModel ? currentSettings.model : null) ||
          runConfig?.model ||
          currentSettings.model ||
          null;
        if (liveModel) {
          currentSettings.model = liveModel;
        }
        if (runConfig) {
          runConfig.fallbackConsumed = true;
          if (liveModel) {
            runConfig.model = liveModel;
          }
        }
        if (scrollSession && scrollSession.active) {
          scrollSession.fallbackConsumed = true;
          if (liveModel) {
            scrollSession.fallbackModel = liveModel;
          }
        }
      }
    }
    refreshLivePin();

    function extractFallbackInfo(r) {
      if (!r) return { consumed: false, model: null };
      const consumed = Boolean(
        r.fallbackConsumed ||
        r.error?.fallbackConsumed ||
        r.error?.details?.fallbackConsumed ||
        (r.fallbackIndex && r.fallbackIndex > 0)
      );
      const model = consumed
        ? (r.error?.details?.model ||
           r.error?.details?.lastAttemptedModel ||
           r.error?.details?.toModel ||
           r.actualModel ||
           null)
        : null;
      return { consumed, model };
    }

    function syncFallbackState(r) {
      if (targetEpoch !== undefined && epoch !== targetEpoch) return;
      const fb = extractFallbackInfo(r);

      const pinnedModel =
        (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
        (runConfig?.fallbackModel && runConfig.fallbackModel !== primaryModel ? runConfig.fallbackModel : null) ||
        (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null))) ||
        (currentSettings.fallbackConsumed && currentSettings.model !== primaryModel ? currentSettings.model : null) ||
        null;

      const isPinActive = Boolean(
        pinnedModel ||
        runConfig?.fallbackConsumed ||
        (scrollSession?.active && (scrollSession?.fallbackConsumed || scrollSession?.runConfig?.fallbackConsumed)) ||
        currentSettings.fallbackConsumed
      );

      if (isPinActive) {
        currentSettings.fallbackConsumed = true;
        if (runConfig) runConfig.fallbackConsumed = true;
        if (scrollSession && scrollSession.active) {
          scrollSession.fallbackConsumed = true;
          if (Array.isArray(items)) {
            if (!scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds = new Set();
            for (const it of items) {
              if (it?.id) scrollSession.fallbackConsumedIds.add(it.id);
            }
          }
        }

        // Late primary response must not overwrite active fallback pin:
        // if fb.consumed === false (late primary), respect currently pinned model
        const effectiveModel = (fb.consumed && fb.model)
          ? fb.model
          : (pinnedModel || (currentSettings.model !== primaryModel ? currentSettings.model : null));

        if (effectiveModel) {
          currentSettings.model = effectiveModel;
          if (runConfig) {
            runConfig.model = effectiveModel;
          }
          if (scrollSession && scrollSession.active) {
            scrollSession.fallbackModel = effectiveModel;
          }
        }
        return;
      }

      if (fb.consumed) {
        currentSettings.fallbackConsumed = true;
        const effectiveModel =
          fb.model ||
          runConfig?.model ||
          (scrollSession?.active && (scrollSession?.fallbackModel || scrollSession?.runConfig?.model)) ||
          currentSettings.model;
        if (effectiveModel) {
          currentSettings.model = effectiveModel;
        }
        if (runConfig) {
          runConfig.fallbackConsumed = true;
          if (effectiveModel) {
            runConfig.model = effectiveModel;
          }
        }
        if (scrollSession && scrollSession.active) {
          scrollSession.fallbackConsumed = true;
          if (effectiveModel) {
            scrollSession.fallbackModel = effectiveModel;
          }
          if (Array.isArray(items)) {
            if (!scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds = new Set();
            for (const it of items) {
              if (it?.id) scrollSession.fallbackConsumedIds.add(it.id);
            }
          }
        }
      }
    }

    // 1. Initial sendChunk
    refreshLivePin();
    if (currentSettings.fallbackConsumed) {
      const pinned =
        (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
        (scrollSession?.active && (scrollSession.fallbackModel || (scrollSession.runConfig?.model !== primaryModel ? scrollSession.runConfig.model : null))) ||
        (currentSettings.model !== primaryModel ? currentSettings.model : null);
      if (pinned) {
        currentSettings.model = pinned;
      }
    }
    let resp = await sendChunk(items, currentSettings, targetEpoch, runConfig);
    if (targetEpoch !== undefined && epoch !== targetEpoch) {
      return { cancelled: true, applied: 0, failed: 0 };
    }

    const mismatch1 = checkRevisionMismatch(resp);
    if (mismatch1) {
      return {
        cancelled: true,
        applied: 0,
        failed: items.length,
        fatal: true,
        error: { code: 'ABORTED', message: mismatch1, retryable: false }
      };
    }

    syncFallbackState(resp);
    refreshLivePin();

    let rateLimitAttempts = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;
    while (resp && resp.error && resp.error.code === 'RATE_LIMITED' && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
      rateLimitAttempts++;
      const reportedMs = Number(resp.error.details?.retryAfterMs);
      const backoffMs = 2000 * Math.pow(2, rateLimitAttempts - 1);
      const delay = Math.min(Math.max(!isNaN(reportedMs) && reportedMs > 0 ? reportedMs : backoffMs, 1000), 60000);
      const retrySec = Math.ceil(delay / 1000);
      console.warn(`[WebMCP Translator] Quota exceeded (${resp.error.details?.scope || 'tab'}): attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}, waiting ${retrySec}s before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (targetEpoch !== undefined && epoch !== targetEpoch) {
        return { cancelled: true, applied: 0, failed: 0 };
      }
      refreshLivePin();
      resp = await sendChunk(items, currentSettings, targetEpoch, runConfig);
      syncFallbackState(resp);
      refreshLivePin();
    }
    if (resp && resp.error && isNonRetryable(resp.error)) {
      const isFb = Boolean(currentSettings.fallbackConsumed || resp.error.fallbackConsumed || resp.error.details?.fallbackConsumed || runConfig?.fallbackConsumed || (scrollSession?.active && scrollSession?.fallbackConsumed));
      const isRespFb = Boolean(resp.error.fallbackConsumed || resp.error.details?.fallbackConsumed);
      const fbMod = isFb
        ? (isRespFb ? (resp.error.details?.model || resp.error.details?.lastAttemptedModel) : null) ||
          (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
          (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null))) ||
          (currentSettings.model !== primaryModel ? currentSettings.model : null) ||
          null
        : null;
      return {
        applied: 0,
        failed: items.length,
        error: resp.error,
        fatal: true,
        ...(isFb ? { fallbackConsumed: true, fallbackModel: fbMod } : {}),
        ...(resp.actualModel || fbMod ? { actualModel: resp.actualModel || fbMod } : {})
      };
    }

    if (resp && Array.isArray(resp.results)) {
      if (resp.actualModel) {
        const isRunFallback = Boolean(
          currentSettings.fallbackConsumed ||
          runConfig?.fallbackConsumed ||
          (scrollSession?.active && scrollSession?.fallbackConsumed)
        );
        const isRespFallback = Boolean(resp.fallbackConsumed || (resp.fallbackIndex && resp.fallbackIndex > 0));
        if (!isRunFallback || isRespFallback) {
          lastTranslateStatus.actualModel = resp.actualModel;
          lastTranslateStatus.fallbackIndex = resp.fallbackIndex || 0;
        }
      }
      const patchResult = await applyBatchThrottled(resp.results, targetEpoch);
      if (targetEpoch !== undefined && epoch !== targetEpoch) {
        return { cancelled: true, applied: 0, failed: 0 };
      }
      refreshLivePin();
      const failedCount = Array.isArray(resp.missingIds) ? resp.missingIds.length : (resp.failed || 0);
      const missingIds = Array.isArray(resp.missingIds)
        ? resp.missingIds
        : (failedCount > 0 ? items.filter((it) => !resp.results?.some((r) => r && r.id === it.id)).map((it) => it.id) : []);
      const isFallback = Boolean(
        currentSettings.fallbackConsumed ||
        resp.fallbackConsumed ||
        runConfig?.fallbackConsumed ||
        (scrollSession?.active && scrollSession?.fallbackConsumed) ||
        (resp.fallbackIndex && resp.fallbackIndex > 0)
      );
      const isRespFallback = Boolean(resp.fallbackConsumed || (resp.fallbackIndex && resp.fallbackIndex > 0));
      const fallbackModel = isFallback
        ? (isRespFallback ? resp.actualModel : null) ||
          (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
          (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null))) ||
          (currentSettings.model !== primaryModel ? currentSettings.model : null) ||
          runConfig?.model ||
          currentSettings.model ||
          null
        : null;
      // return { applied: patchResult.applied, failed: failedCount, missingIds };
      return {
        applied: patchResult.applied,
        failed: failedCount,
        missingIds,
        ...(isFallback ? { fallbackConsumed: true, fallbackModel } : {}),
        ...(resp.actualModel || fallbackModel ? { actualModel: resp.actualModel || fallbackModel } : {})
      };
    }

    // 2. Retry 1 time after ~800 ms if error
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (targetEpoch !== undefined && epoch !== targetEpoch) {
      return { cancelled: true, applied: 0, failed: 0 };
    }

    refreshLivePin();
    if (currentSettings.fallbackConsumed) {
      const pinned =
        (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
        (scrollSession?.active && (scrollSession.fallbackModel || (scrollSession.runConfig?.model !== primaryModel ? scrollSession.runConfig.model : null))) ||
        (currentSettings.model !== primaryModel ? currentSettings.model : null);
      if (pinned) {
        currentSettings.model = pinned;
      }
    }
    resp = await sendChunk(items, currentSettings, targetEpoch, runConfig);
    if (targetEpoch !== undefined && epoch !== targetEpoch) {
      return { cancelled: true, applied: 0, failed: 0 };
    }

    const mismatch2 = checkRevisionMismatch(resp);
    if (mismatch2) {
      return {
        cancelled: true,
        applied: 0,
        failed: items.length,
        fatal: true,
        error: { code: 'ABORTED', message: mismatch2, retryable: false }
      };
    }

    syncFallbackState(resp);
    refreshLivePin();

    if (resp && resp.error && isNonRetryable(resp.error)) {
      const isFb = Boolean(currentSettings.fallbackConsumed || resp.error.fallbackConsumed || resp.error.details?.fallbackConsumed || runConfig?.fallbackConsumed || (scrollSession?.active && scrollSession?.fallbackConsumed));
      const isRespFb = Boolean(resp.error.fallbackConsumed || resp.error.details?.fallbackConsumed);
      const fbMod = isFb
        ? (isRespFb ? (resp.error.details?.model || resp.error.details?.lastAttemptedModel) : null) ||
          (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
          (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null))) ||
          (currentSettings.model !== primaryModel ? currentSettings.model : null) ||
          null
        : null;
      return {
        applied: 0,
        failed: items.length,
        error: resp.error,
        fatal: true,
        ...(isFb ? { fallbackConsumed: true, fallbackModel: fbMod } : {}),
        ...(resp.actualModel || fbMod ? { actualModel: resp.actualModel || fbMod } : {})
      };
    }

    if (resp && Array.isArray(resp.results)) {
      if (resp.actualModel) {
        const isRunFallback = Boolean(
          currentSettings.fallbackConsumed ||
          runConfig?.fallbackConsumed ||
          (scrollSession?.active && scrollSession?.fallbackConsumed)
        );
        const isRespFallback = Boolean(resp.fallbackConsumed || (resp.fallbackIndex && resp.fallbackIndex > 0));
        if (!isRunFallback || isRespFallback) {
          lastTranslateStatus.actualModel = resp.actualModel;
          lastTranslateStatus.fallbackIndex = resp.fallbackIndex || 0;
        }
      }
      const patchResult = await applyBatchThrottled(resp.results, targetEpoch);
      if (targetEpoch !== undefined && epoch !== targetEpoch) {
        return { cancelled: true, applied: 0, failed: 0 };
      }
      refreshLivePin();
      const failedCount = Array.isArray(resp.missingIds) ? resp.missingIds.length : (resp.failed || 0);
      const missingIds = Array.isArray(resp.missingIds)
        ? resp.missingIds
        : (failedCount > 0 ? items.filter((it) => !resp.results?.some((r) => r && r.id === it.id)).map((it) => it.id) : []);
      const isFallback = Boolean(
        currentSettings.fallbackConsumed ||
        resp.fallbackConsumed ||
        runConfig?.fallbackConsumed ||
        (scrollSession?.active && scrollSession?.fallbackConsumed) ||
        (resp.fallbackIndex && resp.fallbackIndex > 0)
      );
      const isRespFallback = Boolean(resp.fallbackConsumed || (resp.fallbackIndex && resp.fallbackIndex > 0));
      const fallbackModel = isFallback
        ? (isRespFallback ? resp.actualModel : null) ||
          (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
          (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null))) ||
          (currentSettings.model !== primaryModel ? currentSettings.model : null) ||
          runConfig?.model ||
          currentSettings.model ||
          null
        : null;
      return {
        applied: patchResult.applied,
        failed: failedCount,
        missingIds,
        ...(isFallback ? { fallbackConsumed: true, fallbackModel } : {}),
        ...(resp.actualModel || fallbackModel ? { actualModel: resp.actualModel || fallbackModel } : {})
      };
    }

    // If fallback was consumed, retry budget (1 retry) is now exhausted: terminal error.
    // Do not bisect from primary, do not restart primary, do not escalate again.
    if (currentSettings.fallbackConsumed) {
      const pinned =
        (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) ||
        (scrollSession?.active && (scrollSession?.fallbackModel || (scrollSession?.runConfig?.model !== primaryModel ? scrollSession?.runConfig?.model : null))) ||
        (currentSettings.model !== primaryModel ? currentSettings.model : null) ||
        currentSettings.model;
      return {
        applied: 0,
        failed: items.length,
        error: resp?.error,
        fatal: true,
        fallbackConsumed: true,
        fallbackModel: pinned,
        actualModel: pinned
      };
    }

    // 3. If still failing, depth < 2 and items.length > 8: binary split & recurse sequentially
    if (depth < 2 && items.length > 8) {
      refreshLivePin();
      const mid = Math.ceil(items.length / 2);
      const leftItems = items.slice(0, mid);
      const rightItems = items.slice(mid);

      const leftRes = await translateChunkWithRecovery(leftItems, currentSettings, depth + 1, targetEpoch, runConfig);
      if (targetEpoch !== undefined && epoch !== targetEpoch) {
        return { cancelled: true, applied: 0, failed: 0 };
      }
      if (leftRes.cancelled || leftRes.fatal) {
        return leftRes;
      }
      refreshLivePin();

      const rightSettings = runConfig?.fallbackConsumed || leftRes.fallbackConsumed || (scrollSession?.active && scrollSession?.fallbackConsumed)
        ? { ...currentSettings, model: (runConfig?.model && runConfig.model !== primaryModel ? runConfig.model : null) || leftRes.fallbackModel || (scrollSession?.active && scrollSession?.fallbackModel) || (currentSettings.model !== primaryModel ? currentSettings.model : null) || currentSettings.model, fallbackConsumed: true }
        : currentSettings;

      const rightRes = await translateChunkWithRecovery(rightItems, rightSettings, depth + 1, targetEpoch, runConfig);
      if (targetEpoch !== undefined && epoch !== targetEpoch) {
        return { cancelled: true, applied: 0, failed: 0 };
      }
      if (rightRes.cancelled) {
        return rightRes;
      }
      refreshLivePin();

      const combinedMissing = [
        ...(Array.isArray(leftRes.missingIds) ? leftRes.missingIds : []),
        ...(Array.isArray(rightRes.missingIds) ? rightRes.missingIds : [])
      ];

      const splitFallbackConsumed = Boolean(
        currentSettings.fallbackConsumed ||
        leftRes.fallbackConsumed ||
        rightRes.fallbackConsumed ||
        runConfig?.fallbackConsumed ||
        (scrollSession?.active && scrollSession?.fallbackConsumed)
      );
      const splitFallbackModel = splitFallbackConsumed
        ? (rightRes.fallbackModel || leftRes.fallbackModel || runConfig?.model || (scrollSession?.active && scrollSession?.fallbackModel) || currentSettings.model || rightRes.actualModel || leftRes.actualModel || null)
        : null;

      return {
        applied: (leftRes.applied || 0) + (rightRes.alreadyApplied || 0) + (leftRes.alreadyApplied || 0) + (rightRes.applied || 0),
        alreadyApplied: (leftRes.alreadyApplied || 0) + (rightRes.alreadyApplied || 0),
        failed: (leftRes.failed || 0) + (rightRes.failed || 0),
        missingIds: combinedMissing,
        error: rightRes.error || leftRes.error || resp?.error,
        ...(splitFallbackConsumed ? { fallbackConsumed: true, fallbackModel: splitFallbackModel } : {}),
        ...(rightRes.actualModel || leftRes.actualModel || splitFallbackModel ? { actualModel: rightRes.actualModel || leftRes.actualModel || splitFallbackModel } : {}),
        ...(rightRes.fatal ? { fatal: true } : {})
      };
    }

    // 4. Otherwise record failure
    const isTerminalFallback = Boolean(
      currentSettings.fallbackConsumed ||
      resp?.fallbackConsumed ||
      resp?.error?.fallbackConsumed ||
      resp?.error?.details?.fallbackConsumed ||
      runConfig?.fallbackConsumed ||
      (scrollSession?.active && scrollSession?.fallbackConsumed) ||
      (resp?.fallbackIndex && resp.fallbackIndex > 0)
    );
    const terminalFbModel = isTerminalFallback
      ? (resp?.error?.details?.model || resp?.error?.details?.lastAttemptedModel || resp?.actualModel || runConfig?.model || (scrollSession?.active && scrollSession?.fallbackModel) || currentSettings.model || null)
      : null;

    return {
      applied: 0,
      failed: items.length,
      missingIds: items.map((it) => it.id),
      error: resp?.error || { code: 'CHUNK_FAILED', message: 'Chunk translation failed' },
      ...(isTerminalFallback ? { fallbackConsumed: true, fallbackModel: terminalFbModel } : {}),
      ...(resp?.actualModel || terminalFbModel ? { actualModel: resp?.actualModel || terminalFbModel } : {})
    };
  }

  // ============================================================================
  // Full Page Translate Execution
  // ============================================================================
  async function executeTranslation(settings = {}) {
    if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return { cancelled: true }; }
    if (isTranslating && !settings.force) return { alreadyRunning: true };

    epoch++;
    const currentEpoch = epoch;
    __wmtFire({ action: 'CANCEL_PENDING', epoch: currentEpoch });
    pendingSet.clear();

    // Stop scroll-follow session before starting full page translation
    stopScrollFollowSession(true);

    isTranslating = true;
    updateFabBusy();
    currentMode = 'full';
    if (scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds.clear();
    scrollSession.fallbackConsumed = false;
    scrollSession.fallbackModel = null;
    if (scrollSession.runConfig) {
      scrollSession.runConfig.fallbackConsumed = false;
      scrollSession.runConfig.model = null;
      scrollSession.runConfig.primaryModel = null;
    }
    scrollSession.settings = {};
    const runToken = ++activeRunToken;
    const finishRun = () => { if (activeRunToken === runToken) { isTranslating = false; updateFabBusy(); } };
    const startTime = Date.now();
    const targetModel = settings.model || 'ag/gemini-3.1-pro-low';

    try {
      const items = collect(document.body, false);
      const chunks = chunkItems(items);
      const bytesTotal = items.reduce((sum, it) => sum + countUtf8Bytes(it.text), 0);

      lastTranslateStatus = {
        state: 'translating',
        mode: 'full',
        watching: false,
        totalCollected: items.length,
        totalApplied: 0,
        totalFailed: 0,
        totalRestored: 0,
        chunksTotal: chunks.length,
        chunksDone: 0,
        bytesTotal,
        error: null,
        lastError: null,
        progressApplied: 0,
        model: targetModel,
        actualModel: targetModel,
        fallbackIndex: 0,
        elapsedMs: 0
      };

      if (items.length === 0) {
        const elapsedMs = Date.now() - startTime;
        finishRun();
        lastTranslateStatus.state = 'done';
        lastTranslateStatus.elapsedMs = elapsedMs;
        return { ok: true, collected: 0, applied: 0, failed: 0, model: targetModel, elapsedMs };
      }

      let nextIndex = 0;
      let totalApplied = 0;
      let totalFailed = 0;
      let chunksDone = 0;
      let lastError = null;
      let runAborted = false;
      const runConfig = {
        primaryModel: targetModel,
        revision: typeof settings.configRevision === 'number' ? settings.configRevision : null
      };

      async function worker() {
        while (nextIndex < chunks.length) {
          if (epoch !== currentEpoch || runAborted) break;
          const chunkIdx = nextIndex++;
          const chunk = chunks[chunkIdx];

          const chunkRes = await translateChunkWithRecovery(
            chunk,
            {
              sourceLanguage: settings.sourceLanguage || 'auto',
              targetLanguage: settings.targetLanguage || 'vi',
              model: (runConfig && runConfig.model) || targetModel,
              primaryModel: targetModel,
              ...(runConfig?.fallbackConsumed ? { fallbackConsumed: true } : {})
            },
            0,
            currentEpoch,
            runConfig
          );

          if (epoch !== currentEpoch) break;

          const chunkApplied = (chunkRes.applied || 0) + (chunkRes.alreadyApplied || 0);
          totalApplied += chunkApplied;
          totalFailed += chunkRes.failed || 0;
          if (chunkRes.error) {
            lastError = chunkRes.error;
          }

          chunksDone++;
          lastTranslateStatus.totalApplied = Math.max(lastTranslateStatus.totalApplied || 0, totalApplied);
          lastTranslateStatus.totalFailed = totalFailed;
          lastTranslateStatus.chunksDone = chunksDone;

          if (runAborted || chunkRes.fatal || chunkRes.cancelled) {
            runAborted = true;
            break;
          }
        }
      }

      const poolSize = Math.min(throttle.maxConcurrentRequests || 2, chunks.length);
      const workers = [];
      for (let i = 0; i < poolSize; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (epoch !== currentEpoch && !runAborted) {
        finishRun();
        return { cancelled: true };
      }

      const elapsedMs = Date.now() - startTime;
      const finalApplied = Math.max(
        totalApplied,
        lastTranslateStatus.totalApplied || 0,
        lastTranslateStatus.progressApplied || 0
      );
      lastTranslateStatus.elapsedMs = elapsedMs;
      lastTranslateStatus.chunksDone = chunksDone;
      lastTranslateStatus.totalCollected = items.length;
      lastTranslateStatus.totalApplied = finalApplied;
      lastTranslateStatus.totalFailed = totalFailed;
      lastTranslateStatus.model = targetModel;

      // Handle fatal or fully failed run
      if ((finalApplied === 0 && totalFailed > 0) || (lastError && (lastError.code === 'DROPPED_ON_RESTART' || lastError.code === 'ABORTED')) || (runAborted && lastError)) {
        lastTranslateStatus.state = 'error';
        lastTranslateStatus.error = lastError || { code: 'CHUNK_FAILED', message: 'All chunks failed' };
        if (!lastTranslateStatus.error?.logged) {
          try {
            if (chrome?.runtime?.sendMessage) {
              chrome.runtime.sendMessage({
                action: 'RECORD_ERROR_LOG',
                error: lastTranslateStatus.error,
                model: targetModel,
                isTerminal: true
              }).catch(() => {});
            }
          } catch {}
          if (typeof lastTranslateStatus.error === 'object' && lastTranslateStatus.error) {
            lastTranslateStatus.error.logged = true;
          }
        }
        finishRun();
        return {
          ok: false,
          error: lastTranslateStatus.error,
          cancelled: runAborted || lastError?.code === 'ABORTED',
          applied: finalApplied,
          failed: totalFailed,
          model: targetModel,
          elapsedMs
        };
      }

      lastTranslateStatus.state = 'done';
      lastTranslateStatus.error = null;
      lastTranslateStatus.lastError = null;
      finishRun();
      return {
        ok: true,
        collected: items.length,
        applied: finalApplied,
        failed: totalFailed,
        model: targetModel,
        elapsedMs
      };
    } catch (err) {
      if (epoch === currentEpoch) {
        finishRun();
        const elapsedMs = Date.now() - startTime;
        lastTranslateStatus.state = 'error';
        lastTranslateStatus.error = { code: 'INTERNAL', message: err && err.message ? String(err.message) : 'Translation failed' };
        try {
          if (chrome?.runtime?.sendMessage) {
            chrome.runtime.sendMessage({
              action: 'RECORD_ERROR_LOG',
              error: lastTranslateStatus.error,
              model: targetModel,
              isTerminal: true
            }).catch(() => {});
          }
        } catch {}
        if (typeof lastTranslateStatus.error === 'object' && lastTranslateStatus.error) {
          lastTranslateStatus.error.logged = true;
        }
        lastTranslateStatus.model = targetModel;
        lastTranslateStatus.elapsedMs = elapsedMs;
        return { ok: false, error: lastTranslateStatus.error, applied: 0, failed: 0, model: targetModel, elapsedMs };
      }
      return { cancelled: true };
    }
  }

  // ============================================================================
  // Scroll-Follow Engine
  // ============================================================================
  const scrollSession = {
    active: false,
    watching: false,
    epoch: 0,
    inFlight: 0,
    mainObserver: null,
    secondaryObservers: [],
    mutationObserver: null,
    scrollListener: null,
    readyBlocks: new Set(),
    blockedIds: new Set(),
    failedIds: new Set(),
    abortedIds: new Set(),
    overflowQueue: [],
    queuedIds: new Set(),
    overflowWarned: false,
    sweepTimer: null,
    sweepActive: false,
    sweepYieldCount: 0,
    flushTimer: null,
    flushBlockWalker: null,
    flushCurrentBlock: null,
    followUpDomWalker: null,
    followUpConsecutivePastBottom: 0,
    domSweepNeeded: false,
    flushSeenRecIds: new Set(),
    debounceTimer: null,
    retryTimer: null,
    watchdogTimer: null,
    watchdogRounds: 0,
    watchdogLastApplied: 0,
    watchdogRunToken: 0,
    scrollRaf: null,
    settings: {},
    fallbackConsumed: false,
    fallbackModel: null,
    runConfig: null,
    fallbackConsumedIds: new Set()
  };
