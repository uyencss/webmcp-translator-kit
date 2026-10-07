// WebMCP Translator Kit — Content Script Module: Message Bus & Event Listeners
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === 'WIDGET_STATE_CHANGED') {
        // Presentation-only pushes (mascot, size) apply visually without
        // interrupting or cancelling a pending auto-start session or triggering a roundtrip query.
        if (msg.isPresentation) {
          try {
            const { action, isPresentation, ...pushedState } = msg;
            void action;
            if (Object.keys(pushedState).length > 0) {
              applyState({ ...pushedState, isPresentation: true });
            }
          } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
          return;
        }

        // Full state push: newer pushed state supersedes any in-flight queryState() reply.
        widgetQuerySeq++;
        try {
          if (autoStartTimer) {
            clearTimeout(autoStartTimer);
            autoStartTimer = null;
            autoStartAttempted = false;
          }
          autoStarting = false;
          updateFabBusy();
        } catch {}
        try {
          const { action, ...pushedState } = msg;
          void action;
          if (Object.keys(pushedState).length > 0) applyState(pushedState);
        } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } }
        try {
          if (!__wmtHalted && __wmtValidContext()) {
            autoStartQueryRetries = 0;
            queryState();
          }
        } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
      }
    });

    // Real-time presentation updates via storage changes
    if (typeof chrome !== 'undefined' && chrome?.storage?.onChanged) {
      try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === 'local' && changes.settings?.newValue) {
            const s = changes.settings.newValue;
            applyState({
              fabMascot: s.fabMascot,
              fabSize: s.fabSize,
              theme: s.theme,
              uiLocale: s.uiLocale,
              uiFontScale: s.uiFontScale,
              widgetVisible: s.widgetVisible,
              isPresentation: true
            });
          }
        });
      } catch {}
    }
  }

  // ============================================================================
  // Runtime Message Handler for Popup, SW & Tests
  // ============================================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    if (message.action === 'CONTENT_START_TRANSLATION') {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); try { sendResponse({ ok: false, error: 'STALE_CONTEXT' }); } catch {} return false; }
      const mode = message.mode || message.settings?.translationMode || 'full';
      if (mode === 'scroll-follow') {
        startScrollFollowSession(message.settings || {});
        sendResponse({
          ok: true,
          mode: 'scroll-follow',
          watching: true,
          state: 'translating',
          totalCollected: lastTranslateStatus.totalCollected,
          totalApplied: lastTranslateStatus.totalApplied,
          totalFailed: lastTranslateStatus.totalFailed,
          model: message.settings?.model || lastTranslateStatus.model
        });
        return false;
      } else {
        executeTranslation(message.settings || {}).then(sendResponse, (e) => {
          if (__wmtInvalidatedErr(e)) __wmtHaltStale();
          try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch {}
        });
        return true; // async
      }
    }

    if (message.action === 'CONTENT_SET_MODE') {
      const targetMode = message.mode;
      if (targetMode === 'scroll-follow' || targetMode === 'full') {
        epoch++;
        __wmtFire({ action: 'CANCEL_PENDING', epoch });
        stopScrollFollowSession(false);
        isTranslating = false;
        activeRunToken++;
        pendingSet.clear();
        currentMode = targetMode;
        lastTranslateStatus.mode = targetMode;

        if (!__wmtHalted && __wmtValidContext()) {
          if (targetMode === 'scroll-follow') {
            try {
              chrome.runtime.sendMessage({ action: 'WIDGET_GET_STATE' }, (st) => {
                try {
                  if (chrome.runtime && chrome.runtime.lastError) {
                    if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
                    return;
                  }
                } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
                if (st && st.effective === 'on') {
                  startScrollFollowSession(st);
                }
              });
            } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
          } else if (targetMode === 'full') {
            try {
              chrome.runtime.sendMessage({ action: 'WIDGET_GET_STATE' }, (st) => {
                try {
                  if (chrome.runtime && chrome.runtime.lastError) {
                    if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
                    return;
                  }
                } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
                if (st && st.effective === 'on') {
                  executeTranslation(st).catch((e) => {
                    if (__wmtInvalidatedErr(e)) __wmtHaltStale();
                  });
                }
              });
            } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
          }
        }

        sendResponse({
          ok: true,
          mode: targetMode,
          status: {
            ...lastTranslateStatus,
            mode: targetMode,
            watching: scrollSession.watching
          }
        });
        return false;
      }
      sendResponse({ ok: false, error: 'INVALID_MODE' });
      return false;
    }

    if (message.action === 'CONTENT_RESTORE') {
      const res = restore();
      sendResponse({ ok: true, ...res });
      return false;
    }

    // Progressive patch: SW forwards each completed streamed item ASAP.
    // Same guards as the final path (epoch/rec/revision/original); duplicates
    // from retries/fallbacks are idempotent no-ops. Never rejects the batch.
    if (message.action === 'TRANSLATE_PROGRESS') {
      try {
        const it = message.item || {};
        if (typeof message.epoch === 'number' && message.epoch !== epoch) {
          sendResponse({ ok: true, applied: false, reason: 'EPOCH_MISMATCH' });
          return false;
        }
        if (!it || typeof it.id !== 'string' || typeof it.text !== 'string' || typeof it.revision !== 'number') {
          sendResponse({ ok: true, applied: false, reason: 'INVALID_ITEM' });
          return false;
        }
        const rec = lookup(it.id);
        if (!rec || !rec.node || !rec.node.isConnected) {
          sendResponse({ ok: true, applied: false, reason: 'UNKNOWN_OR_DETACHED' });
          return false;
        }
        refreshIfExternallyModified(rec);
        if (it.revision !== rec.revision) {
          sendResponse({ ok: true, applied: false, reason: 'REVISION_MISMATCH' });
          return false;
        }
        if (rec.node.nodeValue === it.text && rec.translated === it.text) {
          sendResponse({ ok: true, applied: false, reason: 'ALREADY_APPLIED' });
          return false;
        }
        if (rec.node.nodeValue !== rec.original) {
          sendResponse({ ok: true, applied: false, reason: 'MODIFIED' });
          return false;
        }
        rec.translated = it.text;
        rec.expectedApply = it.text;
        try {
          rec.node.nodeValue = it.text;
        } catch {
          rec.translated = null;
          rec.expectedApply = null;
          sendResponse({ ok: true, applied: false, reason: 'WRITE_FAILED' });
          return false;
        }
        restoreKept.set(rec.id, rec);
        if (currentMode === 'scroll-follow') {
          if (scrollSession.collectedIds) scrollSession.collectedIds.add(rec.id);
          else lastTranslateStatus.totalCollected++;
        }
        lastTranslateStatus.totalApplied++;
        lastTranslateStatus.progressApplied = (lastTranslateStatus.progressApplied || 0) + 1;
        updateFabBusy();
        sendResponse({ ok: true, applied: true });
      } catch {
        sendResponse({ ok: true, applied: false, reason: 'INTERNAL' });
      }
      return false;
    }

    if (message.action === 'CONTENT_GET_STATUS') {
      sendResponse({
        ok: true,
        status: {
          ...lastTranslateStatus,
          mode: currentMode,
          watching: scrollSession.watching,
          actualModel: lastTranslateStatus.actualModel || lastTranslateStatus.model,
          fallbackIndex: lastTranslateStatus.fallbackIndex || 0,
          autoStarting,
          busy: Boolean(autoStarting || isTranslating || scrollSession.inFlight > 0)
        },
        restorableCount: restoreKept.size,
        documentId,
        epoch
      });
      return false;
    }

    return false;
  });

  // Expose __translatorDom for direct inspection/testing
  window.__translatorDom = {
    collect,
    applyBatchThrottled,
    restore,
    executeTranslation,
    sendChunk,
    translateChunkWithRecovery,
    getStatus: () => ({
      ...lastTranslateStatus,
      mode: currentMode,
      watching: scrollSession.watching,
      restorable: restoreKept.size,
      autoStarting,
      busy: Boolean(autoStarting || isTranslating || scrollSession.inFlight > 0)
    }),
    isAutoStarting: () => autoStarting,
    hasAutoStartTimer: () => Boolean(autoStartTimer),
    setAutoStartTimerForTest: (t) => {
      autoStartTimer = t;
      if (t) autoStarting = true;
    },
    isFabBusy: () => Boolean(autoStarting || isTranslating || scrollSession.inFlight > 0),
    _getWidgetHost: () => document.getElementById('__wmt-widget-host'),
    _wmtT: (k, p) => widgetTHook(k, p),
    documentId,
    getEpoch: () => epoch,
    setEpoch: (n) => { epoch = n; },
    startScrollFollowSession,
    stopScrollFollowSession,
    flushReadyBlocks,
    initialScrollSweep,
    getScrollSession: () => scrollSession,
    getOverflowQueue: () => scrollSession.overflowQueue,
    checkWatchdogReconciliation,
    dispatchScrollBatch,
    dispatchScrollCandidateRecs,
    getWatchdogStatus: () => ({
      rounds: scrollSession.watchdogRounds,
      lastApplied: scrollSession.watchdogLastApplied,
      runToken: scrollSession.watchdogRunToken
    })
  };

  // Fire-and-forget CANCEL_PENDING on navigation / page hide (stale-safe)
  window.addEventListener('pagehide', () => {
    try {
      if (autoStartTimer) {
        clearTimeout(autoStartTimer);
        autoStartTimer = null;
      }
      autoStarting = false;
      updateFabBusy();
      epoch++;
      __wmtFire({ action: 'CANCEL_PENDING', epoch, reason: 'pagehide' });
    } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
  });

  // bfcache restore: re-sync epoch so stale in-flight work cannot patch us
  window.addEventListener('pageshow', (e) => {
    try {
      if (e && e.persisted) {
        if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
        epoch++;
        __wmtFire({ action: 'CANCEL_PENDING', epoch });
      }
    } catch (err) { if (__wmtInvalidatedErr(err)) __wmtHaltStale(); }
  });

  // Initialize floating widget
  if (document.documentElement) {
    initFloatingWidget();
  } else {
    document.addEventListener('DOMContentLoaded', initFloatingWidget);
  }
})();
