// WebMCP Translator Kit — Content Script Runtime Bundle
// AUTO-GENERATED from extension/src/content/modules/*.js via scripts/sync-content.mjs. DO NOT EDIT DIRECTLY.
// Source modules: extension/src/content/modules/{constants,walker,chunker,engine,scroll-observer,widget-dom,messages}.js
// WebMCP Translator Kit — Content Script Module: Constants & Scope Bootstrap
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

(function () {
  if (window !== window.top) return;
  if (window.__webMcpTranslatorInjected) return;
  window.__webMcpTranslatorInjected = true;

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1
  };
  const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote';
  // Scroll-follow coverage: current viewport + one viewport ahead only.
  // (Previously [-2H, +3H]; whole-page prefetch burned minutes on slow
  // upstreams with frozen progress. Translated nodes stay translated.)
  const SCROLL_BEHIND_H = 0;
  const SCROLL_AHEAD_H = 2;
  const SCROLL_ROOT_MARGIN = '0px 0px 200% 0px';
  const PATCH_MIN_INTERVAL_MS = 200;
  const PATCH_GROUP_SIZE = 64;
  const MAX_BATCH_ITEMS = 64;
  const MAX_BATCH_BYTES = 24576; // 24 KiB
  const MAX_IN_FLIGHT_BATCHES = 2; // ≤2 batch in-flight concurrency limit
  const SCROLL_DEBOUNCE_MS = 250;
  const throttle = {
    maxConcurrentRequests: 2,
    debounceMinMs: 200,
    debounceMaxMs: 300
  };

  // Stale-context guard: after an extension reload/update the old injected
  // script loses its runtime port and every chrome.runtime.sendMessage throws
  // synchronously ("Extension context invalidated"). The stale script must
  // halt timers/sessions silently (no uncaught errors, no retry spam); a page
  // reload injects a fresh script which works normally.
  let __wmtHalted = false;
  let widgetProgressIntervalId = null;
  function __wmtValidContext() {
    try { return !!(chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function'); } catch { return false; }
  }
  function __wmtInvalidatedErr(err) {
    const m = err && err.message ? String(err.message) : String(err || '');
    return /extension context invalidated|context invalidated/i.test(m);
  }
  function __wmtHaltStale() {
    if (__wmtHalted) return;
    __wmtHalted = true;
    autoStarting = false;
    try { if (autoStartTimer) { clearTimeout(autoStartTimer); autoStartTimer = null; } } catch {}
    try {
      if (widgetProgressIntervalId !== null) {
        clearInterval(widgetProgressIntervalId);
        widgetProgressIntervalId = null;
      }
    } catch {}
    try { stopScrollFollowSession(false); } catch {}
    try { isTranslating = false; activeRunToken++; } catch {}
    try { updateFabBusy(); } catch {}
  }
  // Fire-and-forget sender: never throws, never spams after invalidation.
  function __wmtFire(payload) {
    if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
    try {
      chrome.runtime.sendMessage(payload, () => {
        try {
          const le = chrome.runtime && chrome.runtime.lastError ? (chrome.runtime.lastError.message || '') : '';
          if (/extension context invalidated|context invalidated/i.test(le)) __wmtHaltStale();
        } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
      });
    } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
  }

  // Floating-button busy indicator hook (wired up by initFloatingWidget)
  let fabBusySetter = null;
  const WIDGET_FALLBACK_LABELS = {
    widget_title: 'WebMCP Translator',
    widget_close_label: 'Đóng panel',
    widget_status_label: 'Trạng thái:',
    widget_status_on: 'Đang bật',
    widget_status_off: 'Đang tắt',
    widget_toggle_tab_on: 'Tắt dịch tab này',
    widget_toggle_tab_off: 'Bật dịch tab này',
    widget_mode_scroll: 'Dịch đuổi theo scroll',
    widget_mode_full: 'Dịch toàn trang',
    widget_btn_translate: 'Dịch ngay',
    widget_btn_restore: 'Khôi phục',
    widget_model_label: 'Mô hình',
    widget_hint: 'Mở popup để cấu hình key/quyền/model',
    widget_warn_no_perm: 'Thiếu quyền host! Mở popup để cấp quyền.',
    widget_warn_no_key: 'Chưa cấu hình API key! Mở popup để nhập key.',
    fav_empty_hint_dropdown: 'Chưa có model yêu thích (đang hiện tất cả)',
    config_fab_size_label: 'Cỡ icon nổi'
  };
  let widgetTHook = (key, params) => {
    if (typeof window !== 'undefined' && window.__wmtI18n && typeof window.__wmtI18n.t === 'function') {
      return window.__wmtI18n.t('vi', key, params);
    }
    return WIDGET_FALLBACK_LABELS[key] || key;
  };
  function setFabBusy(busy) {
    try {
      if (typeof fabBusySetter === 'function') fabBusySetter(Boolean(busy));
    } catch {}
  }

  // Busy = actual in-flight translation work (not merely "watching"), or
  // initial auto-start scheduling window before first batch is dispatched.
  // This is what stops the spinner from running forever after everything is done.
  function updateFabBusy() {
    setFabBusy(autoStarting || isTranslating || scrollSession.inFlight > 0);
  }

  const documentId = 'doc_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
  let epoch = 0;
  let idCounter = 1;
  let currentMode = 'full'; // 'full' | 'scroll-follow'

  const AUTO_SETTLE_MS = 500;
  const AUTO_QUERY_RETRY_MS = 1200;
  const AUTO_QUERY_MAX_RETRIES = 2;
  let autoStartAttempted = false;
  let autoStarting = false;
  let userRestored = false;
  let autoStartTimer = null;
  let autoStartQueryRetries = 0;
  // Monotonically increasing widget-state request sequence: every queryState()
  // issuance and every pushed WIDGET_STATE_CHANGED advances it. A query reply
  // whose sequence is older than the latest issuance/push is stale (out of
  // order) and must be ignored so a late effective:'on' cannot clobber a
  // newer effective:'off'.
  let widgetQuerySeq = 0;

  const nodeToRec = new WeakMap();
  const idToRec = new Map();
  const restoreKept = new Map();

  // Pending set tracking active in-flight items by key: `${id}:${revision}:${epoch}`
  const pendingSet = new Set();

  let isTranslating = false;
  let activeRunToken = 0;
  let lastTranslateStatus = {
    state: 'idle',
    mode: 'full',
    watching: false,
    totalCollected: 0,
    totalApplied: 0,
    totalFailed: 0,
    totalRestored: 0,
    chunksTotal: 0,
    chunksDone: 0,
    bytesTotal: 0,
    error: null,
    lastError: null,
    progressApplied: 0,
    model: null,
    actualModel: null,
    fallbackIndex: 0,
    elapsedMs: 0
  };

// WebMCP Translator Kit — Content Script Module: DOM Walker & Visibility Filters
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

  function isHidden(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute('hidden')) return true;
      if (cur.hasAttribute('aria-hidden') && cur.getAttribute('aria-hidden') === 'true') return true;
      if (cur.hasAttribute('data-private')) return true;
      let cs = null;
      try { cs = window.getComputedStyle(cur); } catch (e) { cs = null; }
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function eligibleTextNode(tn) {
    if (!tn || tn.nodeType !== 3) return false;
    const text = tn.nodeValue;
    if (text == null || !/\S/.test(text)) return false;
    const parent = tn.parentElement;
    if (!parent) return false;
    if (SKIP_TAGS[parent.tagName]) return false;

    let cur = parent;
    while (cur && cur.nodeType === 1) {
      if (cur.id === '__wmt-widget-host' || (cur.hasAttribute && cur.hasAttribute('data-wmt-ignore'))) return false;
      if (SKIP_TAGS[cur.tagName]) return false;
      if (cur.isContentEditable) return false;
      if (cur.tagName === 'INPUT' || cur.tagName === 'TEXTAREA') return false;
      cur = cur.parentElement;
    }

    if (isHidden(parent)) return false;
    return true;
  }

  function ensureRec(tn) {
    let rec = nodeToRec.get(tn);
    if (!rec) {
      const id = 'T' + (idCounter++);
      rec = {
        id,
        node: tn,
        original: tn.nodeValue,
        translated: null,
        revision: 0,
        expectedApply: null,
        expectedRestore: null
      };
      nodeToRec.set(tn, rec);
      idToRec.set(id, rec);
    } else if (!idToRec.has(rec.id)) {
      idToRec.set(rec.id, rec);
    }
    return rec;
  }

  function refreshIfExternallyModified(rec) {
    const node = rec.node;
    if (!node || !node.isConnected) return false;
    let cur;
    try { cur = node.nodeValue; } catch (e) { return false; }
    if (cur === rec.original) return false;
    if (rec.expectedApply !== null && cur === rec.expectedApply) return false;
    if (rec.expectedRestore !== null && cur === rec.expectedRestore) return false;
    if (rec.translated !== null && cur === rec.translated) return false;

    rec.original = cur;
    rec.translated = null;
    rec.expectedApply = null;
    rec.expectedRestore = null;
    restoreKept.delete(rec.id);
    rec.revision++;
    return true;
  }

  function collect(root, filterViewport = false) {
    root = root || document.body || document.documentElement;
    if (root.id === '__wmt-widget-host' || (root.hasAttribute && root.hasAttribute('data-wmt-ignore'))) {
      return [];
    }
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let tn;
    while ((tn = walker.nextNode())) {
      if (!eligibleTextNode(tn)) continue;
      const rec = ensureRec(tn);
      refreshIfExternallyModified(rec);
      if (rec.translated !== null && tn.nodeValue === rec.translated) continue;
      out.push({
        id: rec.id,
        text: tn.nodeValue,
        revision: rec.revision,
        documentId
      });
    }
    return out;
  }

  function lookup(id) {
    return idToRec.get(id) || null;
  }

  // Throttled application of translation results in groups
  async function applyBatchThrottled(results, targetEpoch = epoch) {
    let applied = 0;
    let alreadyApplied = 0;
    const skipped = [];

    const items = results || [];
    if (targetEpoch !== epoch) {
      items.forEach((r) => skipped.push({ id: r?.id, reason: 'EPOCH_MISMATCH' }));
      return { applied: 0, alreadyApplied: 0, skipped };
    }

    for (let i = 0; i < items.length; i += PATCH_GROUP_SIZE) {
      if (targetEpoch !== epoch) {
        for (let j = i; j < items.length; j++) {
          skipped.push({ id: items[j]?.id, reason: 'EPOCH_MISMATCH' });
        }
        break;
      }

      const group = items.slice(i, i + PATCH_GROUP_SIZE);
      for (const r of group) {
        if (!r || typeof r.id !== 'string' || typeof r.text !== 'string' || typeof r.revision !== 'number') {
          skipped.push({ id: r?.id, reason: 'INVALID_SCHEMA' });
          continue;
        }
        const rec = lookup(r.id);
        if (!rec) {
          skipped.push({ id: r.id, reason: 'UNKNOWN_ID' });
          continue;
        }
        const node = rec.node;
        if (!node.isConnected) {
          skipped.push({ id: r.id, reason: 'DETACHED' });
          continue;
        }
        refreshIfExternallyModified(rec);
        if (r.revision !== rec.revision) {
          skipped.push({ id: r.id, reason: 'REVISION_MISMATCH' });
          continue;
        }
        if (node.nodeValue !== rec.original) {
          if (node.nodeValue === r.text && rec.translated === r.text) {
            skipped.push({ id: r.id, reason: 'ALREADY_APPLIED' });
            alreadyApplied++;
            continue;
          }
          skipped.push({ id: r.id, reason: 'MODIFIED' });
          continue;
        }

        rec.translated = r.text;
        rec.expectedApply = r.text;
        try {
          node.nodeValue = r.text; // nodeValue ONLY
          applied++;
          restoreKept.set(rec.id, rec);
          if (scrollSession.failedIds && scrollSession.failedIds.has(rec.id)) {
            scrollSession.failedIds.delete(rec.id);
            if (lastTranslateStatus.totalFailed > 0) {
              lastTranslateStatus.totalFailed--;
            }
          }
        } catch (err) {
          rec.translated = null;
          rec.expectedApply = null;
          skipped.push({ id: r.id, reason: 'WRITE_FAILED' });
        }
      }

      if (i + PATCH_GROUP_SIZE < items.length && PATCH_MIN_INTERVAL_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, PATCH_MIN_INTERVAL_MS));
      }
    }

    return { applied, alreadyApplied, skipped };
  }

  // Restore DOM nodes: epoch++ + CANCEL_PENDING + stop active sessions + clear pending
// WebMCP Translator Kit — Content Script Module: Chunker & Text Batches
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

  function restore() {
    userRestored = true;
    if (autoStartTimer) {
      clearTimeout(autoStartTimer);
      autoStartTimer = null;
    }
    autoStarting = false;

    // 1. Advance epoch to immediately drop in-flight / late-arriving responses
    epoch++;
    const cancelEpoch = epoch;

    // 2. Fire-and-forget CANCEL_PENDING to Service Worker (stale-safe)
    __wmtFire({ action: 'CANCEL_PENDING', epoch: cancelEpoch });

    // 3. Stop both scroll-follow session and full translation runs
    stopScrollFollowSession(false);
    isTranslating = false;
    activeRunToken++;
    updateFabBusy();

    // 4. Clear pending tracking set
    pendingSet.clear();

    // 5. Restore original text nodes
    let restored = 0;
    const skipped = [];
    const seen = new Set();

    function handle(rec, id) {
      if (seen.has(id)) return;
      seen.add(id);
      if (rec.translated == null) return;
      const node = rec.node;
      if (!node.isConnected) {
        skipped.push({ id, reason: 'DETACHED' });
        return;
      }
      if (node.nodeValue !== rec.translated) {
        skipped.push({ id, reason: 'SITE_MODIFIED' });
        return;
      }

      rec.expectedRestore = rec.original;
      node.nodeValue = rec.original;
      rec.translated = null;
      rec.expectedApply = null;
      rec.expectedRestore = null;
      restoreKept.delete(id);
      restored++;
    }

    idToRec.forEach(handle);
    restoreKept.forEach(handle);

    lastTranslateStatus.state = 'restored';
    lastTranslateStatus.totalRestored = restored;
    return { restored, skipped };
  }

  // Count UTF-8 bytes
  function countUtf8Bytes(str) {
    return new TextEncoder().encode(str).length;
  }

  // Chunk items to respect limits: <= maxItems and <= maxBytes UTF-8.
  // Scroll mode uses much smaller chunks (16 items / 6 KiB): a full-size
  // 64-node batch through a reasoning upstream takes ~56s (measured live),
  // right at the 60s timeout edge — one slow chunk then burns minutes in
  // retry->split while both in-flight slots look frozen. Small chunks finish
  // in ~15s each with visible progress and cheap retries.
  const SCROLL_MAX_BATCH_ITEMS = 16;
  const SCROLL_MAX_BATCH_BYTES = 6144; // 6 KiB
  function chunkItems(items, maxItems = MAX_BATCH_ITEMS, maxBytes = MAX_BATCH_BYTES) {
    const chunks = [];
    let currentChunk = [];
    let currentBytes = 0;

    for (const it of items) {
      const itBytes = countUtf8Bytes(it.text);
      if (currentChunk.length >= maxItems || (currentBytes + itBytes > maxBytes && currentChunk.length > 0)) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }
      currentChunk.push(it);
      currentBytes += itBytes;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    return chunks;
  }

  function isDroppedOnRestartError(errMessage) {
    if (!errMessage || typeof errMessage !== 'string') return false;
    const msg = errMessage.toLowerCase();
    return (
      msg.includes('message port closed') ||
      msg.includes('receiving end does not exist') ||
      msg.includes('port closed') ||
      msg.includes('service worker')
    );
  }

  // Send chunk wrapper (stale-context safe: resolves ABORTED, never throws)
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

// WebMCP Translator Kit — Content Script Module: Scroll-Follow Observer
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

  function scheduleSweepYield(fn) {
    if (typeof setTimeout === 'function') {
      return { type: 'timer', id: setTimeout(fn, 0) };
    }
    if (typeof requestAnimationFrame === 'function') {
      return { type: 'raf', id: requestAnimationFrame(fn) };
    }
    return { type: 'promise', id: Promise.resolve().then(fn) };
  }

  function cancelSweepYield(handle) {
    if (!handle) return;
    try {
      if (handle.type === 'timer' && typeof clearTimeout === 'function') {
        clearTimeout(handle.id);
      } else if (handle.type === 'raf' && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(handle.id);
      }
    } catch {}
  }

  function scheduleScrollFlush() {
    if (__wmtHalted) return;
    if (!scrollSession.active) return;
    if (scrollSession.debounceTimer) return;
    const delay = throttle.debounceMinMs || SCROLL_DEBOUNCE_MS;
    scrollSession.debounceTimer = setTimeout(() => {
      scrollSession.debounceTimer = null;
      flushReadyBlocks();
    }, delay);
  }

  function getTextNodeRect(tn) {
    if (!tn) return null;
    try {
      if (typeof document !== 'undefined' && typeof document.createRange === 'function') {
        const range = document.createRange();
        try { range.selectNodeContents(tn); } catch { range.selectNode(tn); }
        const r = range.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0 || r.top !== 0 || r.bottom !== 0)) {
          return r;
        }
      }
    } catch {}
    try {
      let cur = tn.parentElement;
      while (cur) {
        if (typeof cur.getBoundingClientRect === 'function') {
          const r = cur.getBoundingClientRect();
          if (r) return r;
        }
        cur = cur.parentElement;
      }
    } catch {}
    return null;
  }

  const MAX_OVERFLOW_ITEMS = 512;

  function enqueueOverflowChunks(newChunks) {
    if (!scrollSession.overflowQueue) scrollSession.overflowQueue = [];
    if (!scrollSession.queuedIds) scrollSession.queuedIds = new Set();
    if (!newChunks || newChunks.length === 0) return;

    for (const chunk of newChunks) {
      if (chunk && chunk.length > 0) {
        const uniqueChunk = [];
        for (const it of chunk) {
          if (!it || !it.id) continue;
          if (scrollSession.queuedIds.has(it.id)) continue;
          const rec = lookup(it.id);
          if (!rec || !rec.node || !rec.node.isConnected) continue;
          if (rec.translated !== null && rec.node.nodeValue === rec.translated) continue;
          const pendingKey = `${rec.id}:${rec.revision}:${epoch}`;
          if (pendingSet.has(pendingKey)) continue;
          if (scrollSession.blockedIds.has(rec.id) || scrollSession.failedIds.has(rec.id)) continue;

          scrollSession.queuedIds.add(it.id);
          uniqueChunk.push(it);
        }
        if (uniqueChunk.length > 0) {
          scrollSession.overflowQueue.push(uniqueChunk);
        }
      }
    }

    let totalItems = 0;
    for (const chunk of scrollSession.overflowQueue) {
      totalItems += chunk.length;
    }

    if (totalItems > MAX_OVERFLOW_ITEMS) {
      let toDrop = totalItems - MAX_OVERFLOW_ITEMS;
      let droppedRealCount = 0;
      const droppedRealIds = new Set();

      function isRealDrop(it) {
        if (!it || !it.id) return false;
        const rec = lookup(it.id);
        if (!rec) return true;
        // Node already translated / applied cannot be counted as a failed drop
        if (rec.translated !== null && rec.node && rec.node.nodeValue === rec.translated) return false;
        // Node currently in flight cannot be counted as a failed drop
        const pendingKey = `${rec.id}:${rec.revision}:${epoch}`;
        if (pendingSet.has(pendingKey)) return false;
        return true;
      }

      while (toDrop > 0 && scrollSession.overflowQueue.length > 0) {
        const oldestChunk = scrollSession.overflowQueue[0];
        if (oldestChunk.length <= toDrop) {
          scrollSession.overflowQueue.shift();
          for (const it of oldestChunk) {
            if (it && it.id) {
              scrollSession.queuedIds.delete(it.id);
              if (isRealDrop(it) && !droppedRealIds.has(it.id)) {
                droppedRealIds.add(it.id);
                droppedRealCount++;
                scrollSession.failedIds.add(it.id);
              }
            }
          }
          toDrop -= oldestChunk.length;
        } else {
          const droppedItems = oldestChunk.splice(0, toDrop);
          for (const it of droppedItems) {
            if (it && it.id) {
              scrollSession.queuedIds.delete(it.id);
              if (isRealDrop(it) && !droppedRealIds.has(it.id)) {
                droppedRealIds.add(it.id);
                droppedRealCount++;
                scrollSession.failedIds.add(it.id);
              }
            }
          }
          toDrop = 0;
        }
      }

      if (droppedRealCount > 0) {
        lastTranslateStatus.totalFailed += droppedRealCount;
        if (!scrollSession.overflowWarned) {
          scrollSession.overflowWarned = true;
          console.warn(`[translator] Overflow queue exceeded cap (${MAX_OVERFLOW_ITEMS}); dropped ${droppedRealCount} oldest items`);
        }
      }
    }
  }

  function revalidateCandidate(it, chunkEpoch = epoch) {
    if (!it || !it.id) return null;
    const rec = lookup(it.id);
    if (!rec || !rec.node || !rec.node.isConnected) return null;
    refreshIfExternallyModified(rec);
    if (scrollSession.blockedIds.has(rec.id) || scrollSession.failedIds.has(rec.id)) return null;
    if (scrollSession.fallbackConsumedIds && scrollSession.fallbackConsumedIds.has(rec.id)) return null;
    if (scrollSession.queuedIds && scrollSession.queuedIds.has(rec.id)) return null;
    if (rec.translated !== null && rec.node.nodeValue === rec.translated) return null;
    const pendingKey = `${rec.id}:${rec.revision}:${chunkEpoch}`;
    if (pendingSet.has(pendingKey)) return null;
    return {
      id: rec.id,
      text: rec.node.nodeValue,
      revision: rec.revision,
      documentId
    };
  }

  function drainOverflowQueue() {
    if (__wmtHalted || !__wmtValidContext() || !scrollSession.active) return false;
    if (!scrollSession.overflowQueue || scrollSession.overflowQueue.length === 0) return false;
    let dispatched = false;
    while (scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES && scrollSession.overflowQueue.length > 0) {
      const chunk = scrollSession.overflowQueue.shift();
      if (!chunk || chunk.length === 0) continue;

      if (scrollSession.queuedIds) {
        for (const it of chunk) {
          if (it && it.id) scrollSession.queuedIds.delete(it.id);
        }
      }

      const validItems = [];
      const batchPendingKeys = [];
      const chunkEpoch = epoch;
      const seenChunkIds = new Set();

      for (const it of chunk) {
        if (!it || !it.id || seenChunkIds.has(it.id)) continue;
        const valid = revalidateCandidate(it, chunkEpoch);
        if (!valid) continue;
        const key = `${valid.id}:${valid.revision}:${chunkEpoch}`;
        if (pendingSet.has(key)) continue;
        pendingSet.add(key);
        batchPendingKeys.push(key);
        seenChunkIds.add(valid.id);
        validItems.push(valid);
      }

      if (validItems.length === 0) continue;

      scrollSession.inFlight++;
      updateFabBusy();
      dispatched = true;
      dispatchScrollBatch(validItems, batchPendingKeys, chunkEpoch);
    }
    return dispatched;
  }

  function dispatchScrollCandidateRecs(candidateRecs) {
    if (!candidateRecs || candidateRecs.length === 0) {
      if (scrollSession.inFlight === 0 && (!scrollSession.overflowQueue || scrollSession.overflowQueue.length === 0) && !scrollSession.sweepActive) {
        checkWatchdogReconciliation();
      }
      return;
    }

    const curEpoch = epoch;
    const validRecs = [];
    const seenBatchIds = new Set();

    for (const c of candidateRecs) {
      if (!c || !c.id || seenBatchIds.has(c.id)) continue;
      const valid = revalidateCandidate(c, curEpoch);
      if (!valid) continue;
      seenBatchIds.add(c.id);
      validRecs.push({
        ...valid,
        dist: typeof c.dist === 'number' ? c.dist : 0
      });
    }

    if (validRecs.length === 0) {
      if (scrollSession.inFlight === 0 && (!scrollSession.overflowQueue || scrollSession.overflowQueue.length === 0) && !scrollSession.sweepActive) {
        checkWatchdogReconciliation();
      }
      return;
    }

    // Sort by distance to viewport center
    validRecs.sort((a, b) => a.dist - b.dist);

    const items = validRecs.map((c) => ({
      id: c.id,
      text: c.text,
      revision: c.revision,
      documentId: c.documentId
    }));

    // Track unique collected nodes for status (scroll mode collects over time)
    if (!scrollSession.collectedIds) scrollSession.collectedIds = new Set();
    for (const it of items) {
      scrollSession.collectedIds.add(it.id);
    }
    lastTranslateStatus.totalCollected = scrollSession.collectedIds.size;

    const chunks = chunkItems(items, SCROLL_MAX_BATCH_ITEMS, SCROLL_MAX_BATCH_BYTES);

    while (scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES && chunks.length > 0) {
      const chunk = chunks.shift();
      if (!chunk || chunk.length === 0) break;

      const readyChunk = [];
      const batchPendingKeys = [];
      for (const it of chunk) {
        const valid = revalidateCandidate(it, curEpoch);
        if (!valid) continue;
        const key = `${valid.id}:${valid.revision}:${curEpoch}`;
        if (pendingSet.has(key)) continue;
        pendingSet.add(key);
        batchPendingKeys.push(key);
        readyChunk.push(valid);
      }

      if (readyChunk.length === 0) continue;

      scrollSession.inFlight++;
      updateFabBusy();
      dispatchScrollBatch(readyChunk, batchPendingKeys, curEpoch);
    }

    if (chunks.length > 0) {
      enqueueOverflowChunks(chunks);
    }
  }

  const SWEEP_SLICE_TIME_BUDGET_MS = 8;
  const SWEEP_SLICE_NODE_BUDGET = 250;
  const SWEEP_MAX_CONSECUTIVE_PAST_BOTTOM = 30;
  const SWEEP_MAX_TOTAL_SCANNED = 10000;

  function initialScrollSweep() {
    if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
    if (!scrollSession.active) return;
    if (scrollSession.sweepActive) return;

    const H = window.innerHeight || 800;
    const topBound = SCROLL_BEHIND_H * H;
    const bottomBound = (SCROLL_AHEAD_H + 1) * H;

    const root = document.body || document.documentElement;
    if (!root) {
      flushReadyBlocks();
      return;
    }

    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    } catch {
      flushReadyBlocks();
      return;
    }
    if (!walker) {
      flushReadyBlocks();
      return;
    }

    const sweepEpoch = epoch;
    const seenRecIds = new Set();
    const candidateRecs = [];
    let totalScanned = 0;
    let consecutivePastBottom = 0;

    scrollSession.sweepActive = true;

    function step() {
      scrollSession.sweepTimer = null;
      if (__wmtHalted || !__wmtValidContext() || !scrollSession.active || epoch !== sweepEpoch) {
        scrollSession.sweepActive = false;
        return;
      }

      // Revalidate any buffered candidates after yield to drop nodes translated by a flush
      if (candidateRecs.length > 0) {
        for (let i = candidateRecs.length - 1; i >= 0; i--) {
          if (!revalidateCandidate(candidateRecs[i], sweepEpoch)) {
            candidateRecs.splice(i, 1);
          }
        }
      }

      const sliceStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      let sliceNodes = 0;
      let stoppedEarly = false;
      let hitSliceBudget = false;

      try {
        let tn;
        while ((tn = walker.nextNode())) {
          totalScanned++;
          sliceNodes++;

          if (eligibleTextNode(tn)) {
            const rect = getTextNodeRect(tn);
            if (rect) {
              if (rect.top > bottomBound) {
                consecutivePastBottom++;
                if (consecutivePastBottom >= SWEEP_MAX_CONSECUTIVE_PAST_BOTTOM) {
                  stoppedEarly = true;
                  break;
                }
              } else if (rect.bottom >= topBound) {
                consecutivePastBottom = 0;

                const blockCenterY = rect.top + (rect.height || (rect.bottom - rect.top) || 0) / 2;
                const distToViewport = Math.abs(blockCenterY - H / 2);

                const rec = ensureRec(tn);
                refreshIfExternallyModified(rec);
                if (!scrollSession.blockedIds.has(rec.id) && !scrollSession.failedIds.has(rec.id) && !(scrollSession.queuedIds && scrollSession.queuedIds.has(rec.id))) {
                  if (rec.translated === null || tn.nodeValue !== rec.translated) {
                    const pendingKey = `${rec.id}:${rec.revision}:${epoch}`;
                    if (!pendingSet.has(pendingKey) && !seenRecIds.has(rec.id)) {
                      seenRecIds.add(rec.id);
                      candidateRecs.push({
                        id: rec.id,
                        text: tn.nodeValue,
                        revision: rec.revision,
                        documentId,
                        dist: distToViewport
                      });

                      // Dispatch immediately as soon as we have enough for a batch!
                      if (candidateRecs.length >= SCROLL_MAX_BATCH_ITEMS && scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES) {
                        const batch = candidateRecs.splice(0, SCROLL_MAX_BATCH_ITEMS);
                        dispatchScrollCandidateRecs(batch);
                      }
                    }
                  }
                }
              } else {
                consecutivePastBottom = 0;
              }
            }
          }

          if (totalScanned >= SWEEP_MAX_TOTAL_SCANNED) {
            stoppedEarly = true;
            break;
          }

          if (sliceNodes >= SWEEP_SLICE_NODE_BUDGET) {
            hitSliceBudget = true;
            break;
          }
          const now = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
          if (now - sliceStart >= SWEEP_SLICE_TIME_BUDGET_MS) {
            hitSliceBudget = true;
            break;
          }
        }
      } catch (err) {
        stoppedEarly = true;
      }

      // If yielding and haven't dispatched any batch yet, dispatch whatever we have collected so far!
      if (hitSliceBudget && scrollSession.inFlight === 0 && candidateRecs.length > 0) {
        const batch = candidateRecs.splice(0, Math.min(candidateRecs.length, SCROLL_MAX_BATCH_ITEMS));
        dispatchScrollCandidateRecs(batch);
      }

      const isExhausted = stoppedEarly || totalScanned >= SWEEP_MAX_TOTAL_SCANNED || (!hitSliceBudget);

      if (!isExhausted) {
        scrollSession.sweepYieldCount++;
        scrollSession.sweepTimer = scheduleSweepYield(step);
        return;
      }

      // Sweep finished
      scrollSession.sweepActive = false;
      if (candidateRecs.length > 0) {
        dispatchScrollCandidateRecs(candidateRecs.splice(0, candidateRecs.length));
      } else if (scrollSession.inFlight === 0 && (!scrollSession.overflowQueue || scrollSession.overflowQueue.length === 0)) {
        if (scrollSession.readyBlocks.size > 0 || scrollSession.domSweepNeeded || scrollSession.flushBlockWalker || scrollSession.followUpDomWalker) {
          flushReadyBlocks();
        } else {
          checkWatchdogReconciliation();
          updateFabBusy();
        }
      }
    }

    // Run first step synchronously so the first batch goes out immediately!
    step();
  }

  async function flushReadyBlocks() {
    if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
    if (!scrollSession.active) return;

    if (scrollSession.flushTimer) {
      cancelSweepYield(scrollSession.flushTimer);
      scrollSession.flushTimer = null;
    }

    // F2: Prioritize pending overflow queue
    drainOverflowQueue();

    // Dispatch ≤2 batch in-flight; batch 3 waits in readySet
    if (scrollSession.inFlight >= MAX_IN_FLIGHT_BATCHES) return;

    const H = window.innerHeight || 800;
    const topBound = SCROLL_BEHIND_H * H;
    const bottomBound = (SCROLL_AHEAD_H + 1) * H;

    const sliceStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    let sliceNodes = 0;
    let hitBudget = false;
    const candidateRecs = [];
    const deferredBlocks = [];
    if (!scrollSession.flushSeenRecIds) scrollSession.flushSeenRecIds = new Set();
    const seenRecIds = scrollSession.flushSeenRecIds;

    // Phase A: Process blocks currently in readyBlocks or active flushBlockWalker
    while (scrollSession.readyBlocks.size > 0 || scrollSession.flushBlockWalker) {
      if (sliceNodes >= SWEEP_SLICE_NODE_BUDGET) {
        hitBudget = true;
        break;
      }
      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
      if (now - sliceStart >= SWEEP_SLICE_TIME_BUDGET_MS) {
        hitBudget = true;
        break;
      }

      if (!scrollSession.flushBlockWalker) {
        const it = scrollSession.readyBlocks.values().next();
        if (it.done) break;
        const block = it.value;
        scrollSession.readyBlocks.delete(block);
        sliceNodes++;

        if (!block || !block.isConnected) continue;
        let rect;
        try { rect = block.getBoundingClientRect(); } catch { continue; }
        if (rect.bottom < topBound) continue;
        if (rect.top > bottomBound) {
          deferredBlocks.push(block);
          continue;
        }

        const blockCenterY = rect.top + (rect.height || (rect.bottom - rect.top) || 0) / 2;
        const distToViewport = Math.abs(blockCenterY - H / 2);
        scrollSession.flushCurrentBlock = { block, dist: distToViewport };
        try {
          scrollSession.flushBlockWalker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
        } catch {
          scrollSession.flushBlockWalker = null;
          continue;
        }
      }

      const walker = scrollSession.flushBlockWalker;
      const distToViewport = scrollSession.flushCurrentBlock?.dist || 0;
      let tn;
      while ((tn = walker.nextNode())) {
        sliceNodes++;
        if (eligibleTextNode(tn)) {
          const rec = ensureRec(tn);
          refreshIfExternallyModified(rec);
          if (!scrollSession.blockedIds.has(rec.id) && !scrollSession.failedIds.has(rec.id) && !(scrollSession.queuedIds && scrollSession.queuedIds.has(rec.id))) {
            if (rec.translated === null || tn.nodeValue !== rec.translated) {
              const pendingKey = `${rec.id}:${rec.revision}:${epoch}`;
              if (!pendingSet.has(pendingKey) && !seenRecIds.has(rec.id)) {
                seenRecIds.add(rec.id);
                candidateRecs.push({
                  id: rec.id,
                  text: tn.nodeValue,
                  revision: rec.revision,
                  documentId,
                  dist: distToViewport
                });

                if (candidateRecs.length >= SCROLL_MAX_BATCH_ITEMS && scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES) {
                  const batch = candidateRecs.splice(0, SCROLL_MAX_BATCH_ITEMS);
                  dispatchScrollCandidateRecs(batch);
                }
              }
            }
          }
        }

        if (sliceNodes >= SWEEP_SLICE_NODE_BUDGET) {
          hitBudget = true;
          break;
        }
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        if (now - sliceStart >= SWEEP_SLICE_TIME_BUDGET_MS) {
          hitBudget = true;
          break;
        }
      }

      if (hitBudget) {
        break;
      } else {
        scrollSession.flushBlockWalker = null;
        scrollSession.flushCurrentBlock = null;
      }
    }

    // Phase B: Walk DOM text nodes in [topBound, bottomBound] if domSweepNeeded or followUpDomWalker active
    if (!hitBudget && (scrollSession.domSweepNeeded || scrollSession.followUpDomWalker)) {
      if (!scrollSession.followUpDomWalker) {
        const root = document.body || document.documentElement;
        if (root) {
          try {
            scrollSession.followUpDomWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
          } catch {
            scrollSession.followUpDomWalker = null;
          }
        }
      }

      while (scrollSession.followUpDomWalker) {
        let tn;
        try {
          tn = scrollSession.followUpDomWalker.nextNode();
        } catch {
          scrollSession.followUpDomWalker = null;
          break;
        }
        if (!tn) {
          scrollSession.followUpDomWalker = null;
          scrollSession.domSweepNeeded = false;
          break;
        }

        sliceNodes++;
        if (eligibleTextNode(tn)) {
          const rect = getTextNodeRect(tn);
          if (rect && rect.bottom >= topBound && rect.top <= bottomBound) {
            const blockCenterY = rect.top + (rect.height || (rect.bottom - rect.top) || 0) / 2;
            const distToViewport = Math.abs(blockCenterY - H / 2);
            const rec = ensureRec(tn);
            refreshIfExternallyModified(rec);
            if (!scrollSession.blockedIds.has(rec.id) && !scrollSession.failedIds.has(rec.id) && !(scrollSession.fallbackConsumedIds && scrollSession.fallbackConsumedIds.has(rec.id)) && !(scrollSession.queuedIds && scrollSession.queuedIds.has(rec.id))) {
              if (rec.translated === null || tn.nodeValue !== rec.translated) {
                const pendingKey = `${rec.id}:${rec.revision}:${epoch}`;
                if (!pendingSet.has(pendingKey) && !seenRecIds.has(rec.id)) {
                  seenRecIds.add(rec.id);
                  candidateRecs.push({
                    id: rec.id,
                    text: tn.nodeValue,
                    revision: rec.revision,
                    documentId,
                    dist: distToViewport
                  });

                  if (candidateRecs.length >= SCROLL_MAX_BATCH_ITEMS && scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES) {
                    const batch = candidateRecs.splice(0, SCROLL_MAX_BATCH_ITEMS);
                    dispatchScrollCandidateRecs(batch);
                  }
                }
              }
            }
          }
        }

        if (sliceNodes >= SWEEP_SLICE_NODE_BUDGET) {
          hitBudget = true;
          break;
        }
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        if (now - sliceStart >= SWEEP_SLICE_TIME_BUDGET_MS) {
          hitBudget = true;
          break;
        }
      }
    }

    if (deferredBlocks.length > 0) {
      for (const b of deferredBlocks) {
        scrollSession.readyBlocks.add(b);
      }
    }

    if (candidateRecs.length > 0) {
      dispatchScrollCandidateRecs(candidateRecs);
    }

    const hasMore = hitBudget || Boolean(scrollSession.flushBlockWalker) || Boolean(scrollSession.followUpDomWalker);

    if (hasMore) {
      scrollSession.sweepYieldCount++;
      scrollSession.flushTimer = scheduleSweepYield(() => {
        scrollSession.flushTimer = null;
        flushReadyBlocks();
      });
    } else {
      seenRecIds.clear();
    }
  }

  function hasResultsTraceSigns(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) return false;
    const hasResultsKey = /["']?results["']?\s*:/i.test(trimmed) || /["']results["']/i.test(trimmed);
    const hasItemFragment = /\{\s*["']?id["']?/i.test(trimmed);
    const hasResultsTrace = hasResultsKey || hasItemFragment;
    const hasErrorKey = /["']?error["']?\s*:/i.test(trimmed);
    if (hasErrorKey && !hasResultsTrace) return false;
    return hasResultsTrace;
  }

  function isZeroByteOrZeroTrace(err) {
    if (!err) return false;
    if (err.code !== 'INVALID_SCHEMA' && err.code !== 'ZERO_ITEM') return false;
    const details = err.details;
    if (!details) return false;
    if (details.isErrorJson) return true;
    if (details.contentBytes === 0) return true;
    if (details.streamBytes === 0) return true;
    if (details.rawHead === '') return true;
    if (typeof details.rawHead === 'string') {
      return !hasResultsTraceSigns(details.rawHead);
    }
    return false;
  }

  async function dispatchScrollBatch(chunk, batchPendingKeys, chunkEpoch) {
    // Fatal outcomes must not reschedule a flush (avoids hot-loop spam)
    let batchFatal = false;
    try {
      if (__wmtHalted || !__wmtValidContext() || (chunkEpoch !== undefined && epoch !== chunkEpoch) || !scrollSession.active) {
        if (__wmtHalted || !__wmtValidContext()) __wmtHaltStale();
        batchFatal = true;
        return;
      }
      const hasConsumedItem = Array.isArray(chunk) && chunk.some((it) => scrollSession?.fallbackConsumedIds?.has(it?.id));
      const isFallbackActive = Boolean(hasConsumedItem || scrollSession.fallbackConsumed || scrollSession.runConfig?.fallbackConsumed);
      const scrollModel = (isFallbackActive && (scrollSession.fallbackModel || scrollSession.runConfig?.model)) || scrollSession.settings.model || 'ag/gemini-3.1-pro-low';
      const res = await translateChunkWithRecovery(
        chunk,
        {
          sourceLanguage: scrollSession.settings.sourceLanguage || 'auto',
          targetLanguage: scrollSession.settings.targetLanguage || 'vi',
          model: scrollModel,
          configRevision: scrollSession.settings.configRevision,
          ...(isFallbackActive ? { fallbackConsumed: true } : {})
        },
        0,
        chunkEpoch,
        scrollSession.runConfig
      );

      if ((chunkEpoch !== undefined && epoch !== chunkEpoch) || !scrollSession.active || res?.cancelled) {
        return;
      }

      if (res.applied) {
        lastTranslateStatus.totalApplied += res.applied;
        lastTranslateStatus.lastError = null;
      }
      const isFallbackConsumed = Boolean(
        res.error?.details?.fallbackConsumed ||
        res.error?.fallbackConsumed ||
        res.fallbackConsumed ||
        scrollSession.runConfig?.fallbackConsumed
      );
      if (isFallbackConsumed) {
        scrollSession.fallbackConsumed = true;
        const sessionPrimary = (scrollSession?.active ? scrollSession?.settings?.model : null) || scrollSession?.runConfig?.primaryModel || 'ag/gemini-3.1-pro-low';
        const fbModel =
          (res.fallbackModel && res.fallbackModel !== sessionPrimary ? res.fallbackModel : null) ||
          (scrollSession.fallbackModel && scrollSession.fallbackModel !== sessionPrimary ? scrollSession.fallbackModel : null) ||
          (scrollSession.runConfig?.model && scrollSession.runConfig.model !== sessionPrimary ? scrollSession.runConfig.model : null) ||
          (res.actualModel && res.actualModel !== sessionPrimary ? res.actualModel : null) ||
          res.fallbackModel ||
          scrollSession.fallbackModel ||
          scrollSession.runConfig?.model ||
          res.error?.details?.model ||
          res.error?.details?.lastAttemptedModel;
        if (fbModel) {
          scrollSession.fallbackModel = fbModel;
        }
        if (Array.isArray(chunk)) {
          if (!scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds = new Set();
          for (const it of chunk) {
            if (it?.id) scrollSession.fallbackConsumedIds.add(it.id);
          }
        }
      }
      if (res.failed) {
        const isBypass = !isFallbackConsumed && (res.error?.code === 'INVALID_SCHEMA' || res.error?.code === 'ZERO_ITEM') && !isZeroByteOrZeroTrace(res.error);
        if (!res.error || !isBypass) {
          lastTranslateStatus.totalFailed += res.failed;
        }
      }
      if (res.error) {
        lastTranslateStatus.lastError = res.error;
      }

      // WI-20 / WI-23: Missing or failed items in this batch are recorded in blockedIds and failedIds for the current run
      // so they are counted as failed only once and not repeatedly rescheduled across scroll events in this session.
      if (Array.isArray(res.missingIds) && res.missingIds.length > 0 && res.error?.code !== 'RATE_LIMITED') {
        for (const mid of res.missingIds) {
          scrollSession.blockedIds.add(mid);
          scrollSession.failedIds.add(mid);
          if (isFallbackConsumed) {
            if (!scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds = new Set();
            scrollSession.fallbackConsumedIds.add(mid);
          }
        }
      }

      if (res.fatal) {
        batchFatal = true;
        if (res.error?.code !== 'RATE_LIMITED') {
          for (const item of chunk) {
            scrollSession.blockedIds.add(item.id);
            if (isFallbackConsumed) {
              if (!scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds = new Set();
              scrollSession.fallbackConsumedIds.add(item.id);
            }
            const isWatchdogRetryable = !isFallbackConsumed && (res.error?.code === 'INVALID_SCHEMA' || res.error?.code === 'ZERO_ITEM') && !isZeroByteOrZeroTrace(res.error);
            if (!['OPT_IN_REQUIRED', 'SITE_NOT_ALLOWED', 'PERMISSION_REQUIRED',
              'CONSENT_STATE_UNAVAILABLE', 'CONSENT_DENIED', 'KEY_ACCESS_UNAVAILABLE',
              'MISSING_CONFIG', 'HTTP_401', 'HTTP_403', 'DROPPED_ON_RESTART'].includes(res.error?.code) && !isWatchdogRetryable) {
              scrollSession.failedIds.add(item.id);
            }
            if (res.error?.code === 'ABORTED' || res.cancelled) {
              if (!scrollSession.abortedIds) scrollSession.abortedIds = new Set();
              scrollSession.abortedIds.add(item.id);
              scrollSession.failedIds.add(item.id);
            }
          }
        }
        // Lifecycle aborts stop this batch without replay; the watcher stays
        // available for a later scroll after config changes or SW restart.
        if (['OPT_IN_REQUIRED', 'SITE_NOT_ALLOWED', 'PERMISSION_REQUIRED',
          'CONSENT_STATE_UNAVAILABLE', 'CONSENT_DENIED', 'KEY_ACCESS_UNAVAILABLE',
          'MISSING_CONFIG', 'HTTP_401', 'HTTP_403'].includes(res.error?.code)) cancelActiveTranslation();
      }

      // Handle RATE_LIMITED with single timer + jitter (no spin)
      if (res.error && res.error.code === 'RATE_LIMITED') {
        const retryAfterMs = (res.error.details?.retryAfterMs || 2000) + Math.floor(Math.random() * 100) + 50;
        if (!scrollSession.retryTimer) {
          scrollSession.retryTimer = setTimeout(() => {
            scrollSession.retryTimer = null;
            flushReadyBlocks();
          }, retryAfterMs);
        }
      } else if (res.error && res.error.code === 'DROPPED_ON_RESTART') {
        // Terminal for this batch, do not auto-replay; nodes remain unpatched and can be re-triggered
        batchFatal = true;
      } else if (res.error && res.error.code === 'ABORTED') {
        // Cancelled on purpose (navigation/config/epoch): do not reschedule
        batchFatal = true;
        for (const item of chunk) {
          scrollSession.blockedIds.add(item.id);
          scrollSession.failedIds.add(item.id);
          if (!scrollSession.abortedIds) scrollSession.abortedIds = new Set();
          scrollSession.abortedIds.add(item.id);
        }
      }
    } catch (err) {
      // Non-fatal error during scroll dispatch
    } finally {
      // Clear pending set in finally
      for (const k of batchPendingKeys) {
        pendingSet.delete(k);
      }
      if ((chunkEpoch === undefined || epoch === chunkEpoch) && scrollSession.active) {
        scrollSession.inFlight = Math.max(0, scrollSession.inFlight - 1);
        updateFabBusy();
        if (!batchFatal && scrollSession.active && scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES) {
          if (scrollSession.overflowQueue && scrollSession.overflowQueue.length > 0) {
            drainOverflowQueue();
          }
          if (scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES && (scrollSession.readyBlocks.size > 0 || scrollSession.domSweepNeeded || scrollSession.flushBlockWalker || scrollSession.followUpDomWalker)) {
            scheduleScrollFlush();
          }
        }
        if (scrollSession.inFlight === 0 && (!scrollSession.overflowQueue || scrollSession.overflowQueue.length === 0) && !scrollSession.sweepActive) {
          checkWatchdogReconciliation();
        }
      }
    }
  }

  function checkWatchdogReconciliation() {
    if (__wmtHalted || !__wmtValidContext()) return;
    if (!scrollSession.active || !scrollSession.watching) {
      if (lastTranslateStatus.state === 'translating') {
        lastTranslateStatus.state = lastTranslateStatus.totalApplied > 0 ? 'done' : 'idle';
      }
      return;
    }
    if (scrollSession.inFlight > 0) return;
    if (scrollSession.overflowQueue && scrollSession.overflowQueue.length > 0) return;
    if (scrollSession.sweepActive) return;
    if (scrollSession.watchdogTimer) return;

    if (scrollSession.watchdogRunToken !== activeRunToken) {
      scrollSession.watchdogRunToken = activeRunToken;
      scrollSession.watchdogRounds = 0;
      scrollSession.watchdogLastApplied = lastTranslateStatus.totalApplied || 0;
    }

    const currentApplied = lastTranslateStatus.totalApplied || 0;
    const currentCollected = scrollSession.collectedIds ? scrollSession.collectedIds.size : (lastTranslateStatus.totalCollected || 0);

    // Find collected items that are not yet applied and not in failedIds (excluding settled failed items)
    const unappliedRecs = [];
    if (scrollSession.collectedIds) {
      for (const id of scrollSession.collectedIds) {
        if (scrollSession.failedIds && scrollSession.failedIds.has(id)) continue;
        if (scrollSession.abortedIds && scrollSession.abortedIds.has(id)) continue;
        const rec = lookup(id);
        if (!rec || !rec.node || !rec.node.isConnected) continue;
        if (rec.translated !== null || restoreKept.has(id) || rec.node.nodeValue === rec.translated) continue;
        unappliedRecs.push(rec);
      }
    }

    if (unappliedRecs.length === 0) {
      if (lastTranslateStatus.state === 'translating') {
        lastTranslateStatus.state = 'done';
      }
      lastTranslateStatus.stable = true;
      return;
    }

    // Unapplied items exist!
    // Rule: No infinite loop: bound rounds/run-token, stop when no progress (applied does not increase between rounds)
    // Max 2 rounds per run:
    const canRequeue = scrollSession.watchdogRounds < 2 &&
      (scrollSession.watchdogRounds === 0 || currentApplied > scrollSession.watchdogLastApplied);

    if (!canRequeue) {
      // Stop: remainder into footer failed-count + Log entry + existing Retry button
      for (const rec of unappliedRecs) {
        scrollSession.failedIds.add(rec.id);
        scrollSession.blockedIds.add(rec.id);
      }
      lastTranslateStatus.totalFailed = scrollSession.failedIds.size;
      if (lastTranslateStatus.state === 'translating') {
        lastTranslateStatus.state = 'done';
      }
      lastTranslateStatus.stable = true;

      // Log entry to SW:
      try {
        if (chrome?.runtime?.sendMessage) {
          const p = chrome.runtime.sendMessage({
            action: 'RECORD_ERROR_LOG',
            error: {
              code: 'WATCHDOG_UNAPPLIED',
              message: `Watchdog reconciliation: ${unappliedRecs.length} item(s) unapplied after retry`,
              details: {
                unappliedCount: unappliedRecs.length,
                ids: unappliedRecs.map((r) => r.id),
                totalCollected: currentCollected,
                totalApplied: currentApplied,
                totalFailed: lastTranslateStatus.totalFailed
              }
            },
            model: scrollSession.settings?.model || lastTranslateStatus.model || '',
            isTerminal: false
          });
          if (p && typeof p.catch === 'function') {
            p.catch(() => {});
          }
        }
      } catch {}
      return;
    }

    // Auto re-queue 1 round (backoff)
    scrollSession.watchdogRounds++;
    scrollSession.watchdogLastApplied = currentApplied;
    const backoffMs = typeof scrollSession.settings?.watchdogBackoffMs === 'number'
      ? scrollSession.settings.watchdogBackoffMs
      : (scrollSession.watchdogRounds * 500);

    const curToken = activeRunToken;
    scrollSession.watchdogTimer = setTimeout(() => {
      scrollSession.watchdogTimer = null;
      if (__wmtHalted || !scrollSession.active || activeRunToken !== curToken) return;

      // Unblock unapplied items so they can be dispatched
      for (const rec of unappliedRecs) {
        if (scrollSession.abortedIds && scrollSession.abortedIds.has(rec.id)) continue;
        if (scrollSession.failedIds && scrollSession.failedIds.has(rec.id)) continue;
        if (scrollSession.fallbackConsumedIds && scrollSession.fallbackConsumedIds.has(rec.id)) continue;
        scrollSession.blockedIds.delete(rec.id);
        scrollSession.failedIds.delete(rec.id);
        if (scrollSession.queuedIds) scrollSession.queuedIds.delete(rec.id);
      }
      const eligibleToDispatch = unappliedRecs.filter((r) =>
        (!scrollSession.abortedIds || !scrollSession.abortedIds.has(r.id)) &&
        (!scrollSession.failedIds || !scrollSession.failedIds.has(r.id)) &&
        (!scrollSession.fallbackConsumedIds || !scrollSession.fallbackConsumedIds.has(r.id))
      );
      if (eligibleToDispatch.length > 0) {
        dispatchScrollCandidateRecs(eligibleToDispatch);
      }
      drainOverflowQueue();
    }, backoffMs);
  }

  function startScrollFollowSession(settings = {}) {
    if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
    // Stop any running full translation
    isTranslating = false;
    activeRunToken++;

    epoch++;
    const currentEpoch = epoch;
    __wmtFire({ action: 'CANCEL_PENDING', epoch: currentEpoch });
    pendingSet.clear();

    stopScrollFollowSession(false);

    currentMode = 'scroll-follow';
    scrollSession.active = true;
    scrollSession.watching = true;
    scrollSession.settings = settings || {};
    scrollSession.fallbackConsumed = false;
    scrollSession.fallbackModel = null;
    scrollSession.runConfig = {
      primaryModel: settings?.model || 'ag/gemini-3.1-pro-low',
      revision: typeof settings.configRevision === 'number' ? settings.configRevision : null,
      fallbackConsumed: false,
      model: null
    };
    scrollSession.blockedIds.clear();
    scrollSession.failedIds.clear();
    if (!scrollSession.abortedIds) scrollSession.abortedIds = new Set();
    else scrollSession.abortedIds.clear();
    if (!scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds = new Set();
    else scrollSession.fallbackConsumedIds.clear();
    scrollSession.watchdogRounds = 0;
    scrollSession.watchdogLastApplied = 0;
    scrollSession.watchdogRunToken = activeRunToken;
    if (scrollSession.watchdogTimer) {
      clearTimeout(scrollSession.watchdogTimer);
      scrollSession.watchdogTimer = null;
    }
    updateFabBusy();
    scrollSession.epoch = currentEpoch;

    lastTranslateStatus.mode = 'scroll-follow';
    lastTranslateStatus.watching = true;
    lastTranslateStatus.state = 'translating';
    lastTranslateStatus.lastError = null;
    lastTranslateStatus.progressApplied = 0;
    lastTranslateStatus.model = settings.model || 'ag/gemini-3.1-pro-low';
    lastTranslateStatus.actualModel = null;
    lastTranslateStatus.fallbackIndex = 0;

    // 1 IntersectionObserver for block containers (viewport + one ahead)
    scrollSession.mainObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          scrollSession.readyBlocks.add(entry.target);
        } else {
          scrollSession.readyBlocks.delete(entry.target);
        }
      }
      scheduleScrollFlush();
    }, {
      root: null,
      rootMargin: SCROLL_ROOT_MARGIN,
      threshold: 0
    });

    // Lazily observe candidate block containers and seed initial readyBlocks in [-2H, 3H]
    const H = window.innerHeight || 800;
    const topBound = SCROLL_BEHIND_H * H;
    const bottomBound = (SCROLL_AHEAD_H + 1) * H;
    const blocks = document.querySelectorAll(BLOCK_SELECTOR);
    for (const b of blocks) {
      if (b.closest && (b.closest('#__wmt-widget-host') || b.closest('[data-wmt-ignore]'))) continue;
      scrollSession.mainObserver.observe(b);
      try {
        const rect = b.getBoundingClientRect();
        if (rect.bottom >= topBound && rect.top <= bottomBound) {
          scrollSession.readyBlocks.add(b);
        }
      } catch {}
    }

    // Detect nested scroll roots: maximum 2 secondary roots
    const candidateRoots = document.querySelectorAll('div, section, main, article');
    let secondaryRootsCount = 0;
    for (const el of candidateRoots) {
      if (secondaryRootsCount >= 2) break;
      if (el.closest && (el.closest('#__wmt-widget-host') || el.closest('[data-wmt-ignore]'))) continue;
      try {
        const cs = window.getComputedStyle(el);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
          const secObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                scrollSession.readyBlocks.add(entry.target);
              } else {
                scrollSession.readyBlocks.delete(entry.target);
              }
            }
            scheduleScrollFlush();
          }, {
            root: el,
            rootMargin: SCROLL_ROOT_MARGIN,
            threshold: 0
          });
          const childBlocks = el.querySelectorAll(BLOCK_SELECTOR);
          for (const cb of childBlocks) {
            secObserver.observe(cb);
          }
          scrollSession.secondaryObservers.push(secObserver);
          secondaryRootsCount++;
        }
      } catch {}
    }

    // Fallback scroll listener for rapid scroll updates (rAF-coalesced so
    // very fast up/down flings don't run full scans more than once per frame)
    scrollSession.scrollListener = () => {
      // WI-23: Retain IDs already marked failed in current run; only clear non-failed blocked IDs (lifecycle aborts)
      scrollSession.blockedIds = new Set(scrollSession.failedIds);
      if (scrollSession.scrollRaf) return;
      scrollSession.scrollRaf = requestAnimationFrame(() => {
        scrollSession.scrollRaf = null;
        if (!scrollSession.active) return;
        scanViewportBlocks();
      });
    };

    const scanViewportBlocks = () => {
      scrollSession.domSweepNeeded = true;
      if (scrollSession.flushSeenRecIds) {
        scrollSession.flushSeenRecIds.clear();
      }
      if (scrollSession.overflowQueue && scrollSession.overflowQueue.length > 0) {
        drainOverflowQueue();
      }
      if (scrollSession.inFlight >= MAX_IN_FLIGHT_BATCHES) return;
      if (scrollSession.readyBlocks.size === 0) {
        const H = window.innerHeight || 800;
        const topBound = SCROLL_BEHIND_H * H;
        const bottomBound = (SCROLL_AHEAD_H + 1) * H;
        const blocks = document.querySelectorAll(BLOCK_SELECTOR);
        for (const b of blocks) {
          if (b.closest && (b.closest('#__wmt-widget-host') || b.closest('[data-wmt-ignore]'))) continue;
          try {
            const rect = b.getBoundingClientRect();
            if (rect.bottom >= topBound && rect.top <= bottomBound) {
              scrollSession.readyBlocks.add(b);
            }
          } catch {}
        }
      }
      scheduleScrollFlush();
    };
    window.addEventListener('scroll', scrollSession.scrollListener, { passive: true });

    // MutationObserver to gather newly added blocks (ignoring detached) + debounce
    scrollSession.mutationObserver = new MutationObserver((mutations) => {
      let hasNew = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            if (node.id === '__wmt-widget-host' || (node.hasAttribute && node.hasAttribute('data-wmt-ignore'))) continue;
            scrollSession.readyBlocks.add(node);
            scrollSession.domSweepNeeded = true;
            if (node.matches && node.matches(BLOCK_SELECTOR)) {
              scrollSession.mainObserver?.observe(node);
            }
            if (node.querySelectorAll) {
              const sub = node.querySelectorAll(BLOCK_SELECTOR);
              for (const s of sub) {
                scrollSession.mainObserver?.observe(s);
              }
            }
            hasNew = true;
          }
        }
      }
      if (hasNew) scheduleScrollFlush();
    });

    scrollSession.mutationObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // WI-26: Initial sweep collects ALL eligible text nodes in viewport + ahead
    // (regardless of tag, including DIV/SPAN on Douyin-style pages), and sends the first batch.
    // Leftover or newly revealed items are handled via observer/scan on scroll.
    initialScrollSweep();
  }

  function stopScrollFollowSession(updateStatus = true) {
    if (scrollSession.mainObserver) {
      scrollSession.mainObserver.disconnect();
      scrollSession.mainObserver = null;
    }
    for (const obs of scrollSession.secondaryObservers) {
      obs.disconnect();
    }
    scrollSession.secondaryObservers = [];
    if (scrollSession.mutationObserver) {
      scrollSession.mutationObserver.disconnect();
      scrollSession.mutationObserver = null;
    }
    if (scrollSession.scrollListener) {
      window.removeEventListener('scroll', scrollSession.scrollListener);
      scrollSession.scrollListener = null;
    }
    if (scrollSession.scrollRaf) {
      try { cancelAnimationFrame(scrollSession.scrollRaf); } catch {}
      scrollSession.scrollRaf = null;
    }
    if (scrollSession.debounceTimer) {
      clearTimeout(scrollSession.debounceTimer);
      scrollSession.debounceTimer = null;
    }
    if (scrollSession.retryTimer) {
      clearTimeout(scrollSession.retryTimer);
      scrollSession.retryTimer = null;
    }
    if (scrollSession.sweepTimer) {
      cancelSweepYield(scrollSession.sweepTimer);
      scrollSession.sweepTimer = null;
    }
    if (scrollSession.flushTimer) {
      cancelSweepYield(scrollSession.flushTimer);
      scrollSession.flushTimer = null;
    }
    scrollSession.flushBlockWalker = null;
    scrollSession.flushCurrentBlock = null;
    scrollSession.followUpDomWalker = null;
    scrollSession.followUpConsecutivePastBottom = 0;
    scrollSession.domSweepNeeded = false;
    scrollSession.overflowWarned = false;
    if (scrollSession.flushSeenRecIds) {
      scrollSession.flushSeenRecIds.clear();
    }
    scrollSession.overflowQueue = [];
    if (scrollSession.queuedIds) scrollSession.queuedIds.clear();
    scrollSession.sweepActive = false;
    scrollSession.sweepYieldCount = 0;
    scrollSession.readyBlocks.clear();
    scrollSession.blockedIds.clear();
    scrollSession.failedIds.clear();
    if (scrollSession.abortedIds) scrollSession.abortedIds.clear();
    if (scrollSession.fallbackConsumedIds) scrollSession.fallbackConsumedIds.clear();
    scrollSession.fallbackConsumed = false;
    scrollSession.fallbackModel = null;
    if (scrollSession.runConfig) {
      scrollSession.runConfig.fallbackConsumed = false;
      scrollSession.runConfig.model = null;
      scrollSession.runConfig.primaryModel = null;
    }
    scrollSession.settings = {};
    if (scrollSession.watchdogTimer) {
      clearTimeout(scrollSession.watchdogTimer);
      scrollSession.watchdogTimer = null;
    }
    scrollSession.watchdogRounds = 0;
    scrollSession.watchdogLastApplied = 0;
    scrollSession.active = false;
    scrollSession.watching = false;
    scrollSession.inFlight = 0;
    updateFabBusy();

    if (updateStatus) {
      lastTranslateStatus.watching = false;
      // A stopped session must not keep reporting 'translating' (popup would
      // poll "watching" forever); a later start resets to a fresh session.
      if (lastTranslateStatus.state === 'translating') {
        lastTranslateStatus.state = lastTranslateStatus.totalApplied > 0 ? 'done' : 'idle';
      }
    }
  }

  function cancelActiveTranslation() {
    if (autoStartTimer) {
      clearTimeout(autoStartTimer);
      autoStartTimer = null;
    }
    autoStarting = false;
    epoch++;
    __wmtFire({ action: 'CANCEL_PENDING', epoch });
    stopScrollFollowSession(true);
    isTranslating = false;
    activeRunToken++;
    pendingSet.clear();
    updateFabBusy();
  }

  // ============================================================================
  // Floating Widget (Shadow DOM in content.js)
  // ============================================================================
// WebMCP Translator Kit — Content Script Module: Floating Mascot Widget DOM
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

  function initFloatingWidget() {
    // Only inject on HTTP(S) pages
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (document.getElementById('__wmt-widget-host')) return;

    const host = document.createElement('div');
    host.id = '__wmt-widget-host';
    host.setAttribute('data-wmt-ignore', 'true');
    host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;line-height:normal;';

    // Attach open Shadow DOM
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        --wmt-fs-scale: 1;
        --wmt-fab-scale: 1;
        color: #f4f4f5;
        --wmt-panel-bg: #121318;
        --wmt-text-title: #f4f4f5;
        --wmt-text-body: #f4f4f5;
        --wmt-text-secondary: #a1a1aa;
        --wmt-text-muted: #71717a;
        --wmt-border: rgba(255, 255, 255, 0.08);
        --wmt-surface: rgba(255, 255, 255, 0.04);
        --wmt-surface-hover: rgba(255, 255, 255, 0.09);
        --wmt-mode-bg: rgba(255, 255, 255, 0.03);
        --wmt-mode-border: rgba(255, 255, 255, 0.06);
        --wmt-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }
      :host([data-fontscale="sm"]) {
        font-size: 11.5px;
        --wmt-fs-scale: 0.9;
      }
      :host([data-fontscale="sm"]) .wmt-panel {
        font-size: 11.5px;
        padding: 11px;
        gap: 8px;
      }
      :host([data-fontscale="sm"]) .wmt-title {
        font-size: 12.5px;
      }
      :host([data-fontscale="sm"]) .wmt-switch-btn,
      :host([data-fontscale="sm"]) .wmt-action-btn,
      :host([data-fontscale="sm"]) .wmt-model-select {
        font-size: 11px;
        padding: 5px 10px;
      }
      :host([data-fontscale="md"]) {
        font-size: 13px;
        --wmt-fs-scale: 1;
      }
      :host([data-fontscale="lg"]) {
        font-size: 15px;
        --wmt-fs-scale: 1.15;
      }
      :host([data-fontscale="lg"]) .wmt-panel {
        font-size: 15px;
        padding: 16px;
        gap: 12px;
      }
      :host([data-fontscale="lg"]) .wmt-title {
        font-size: 16px;
      }
      :host([data-fontscale="lg"]) .wmt-switch-btn,
      :host([data-fontscale="lg"]) .wmt-action-btn,
      :host([data-fontscale="lg"]) .wmt-model-select {
        font-size: 13.5px;
        padding: 7px 14px;
      }
      :host([data-theme="light"]) {
        color: #0f172a;
        --wmt-panel-bg: #ffffff;
        --wmt-text-title: #0f172a;
        --wmt-text-body: #1e293b;
        --wmt-text-secondary: #475569;
        --wmt-text-muted: #64748b;
        --wmt-border: rgba(0, 0, 0, 0.1);
        --wmt-surface: rgba(0, 0, 0, 0.04);
        --wmt-surface-hover: rgba(0, 0, 0, 0.08);
        --wmt-mode-bg: rgba(0, 0, 0, 0.02);
        --wmt-mode-border: rgba(0, 0, 0, 0.08);
        --wmt-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.8);
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      .wmt-btn {
        width: calc(44px * var(--wmt-fab-scale, 1));
        height: calc(44px * var(--wmt-fab-scale, 1));
        border-radius: 50%;
        background: #3b82f6;
        color: #ffffff;
        border: none;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
        cursor: grab;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        touch-action: none;
        user-select: none;
        transition: transform 0.15s ease, background-color 0.2s;
        outline: none;
      }
      .wmt-btn svg {
        width: calc(22px * var(--wmt-fab-scale, 1));
        height: calc(22px * var(--wmt-fab-scale, 1));
      }
      .wmt-mascot-img {
        width: 100%;
        height: 100%;
        border-radius: 0;
        object-fit: contain;
        pointer-events: none;
        user-select: none;
        transition: transform 0.15s ease;
        filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.28));
      }
      .wmt-btn.has-mascot {
        background: transparent !important;
        box-shadow: none !important;
        border: none !important;
        border-radius: 0 !important;
        width: calc(52px * var(--wmt-fab-scale, 1));
        height: calc(52px * var(--wmt-fab-scale, 1));
      }
      .wmt-btn.has-mascot .wmt-badge {
        display: none !important;
      }
      .wmt-btn.has-mascot:hover {
        background: transparent !important;
      }
      .wmt-btn.has-mascot:hover .wmt-mascot-img {
        transform: scale(1.08);
        filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.38));
      }
      .wmt-btn.has-mascot:focus-visible {
        outline: none !important;
      }
      .wmt-btn.has-mascot:active {
        background: transparent !important;
        box-shadow: none !important;
      }
      .wmt-btn.has-mascot:active .wmt-mascot-img {
        transform: scale(0.95);
      }
      .wmt-btn.busy .wmt-mascot-img,
      .wmt-btn.state-thinking .wmt-mascot-img {
        animation: wmtMascotThinking 1.1s ease-in-out infinite;
      }
      .wmt-btn.state-idle .wmt-mascot-img {
        animation: wmtMascotIdle 3.5s ease-in-out infinite;
      }
      .wmt-btn.state-done .wmt-mascot-img {
        animation: wmtMascotDone 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }

      /* Halo Orbit Ring with Animated Dot */
      .wmt-halo {
        position: absolute;
        top: -8px;
        left: -8px;
        right: -8px;
        bottom: -8px;
        border-radius: 50%;
        pointer-events: none;
        display: none;
        transition: all 0.3s ease;
      }
      .wmt-btn.has-mascot .wmt-halo {
        display: block;
      }
      .wmt-halo-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 1.5px solid rgba(139, 92, 246, 0.35);
        box-shadow: 0 0 12px rgba(139, 92, 246, 0.2);
        transition: border-color 0.3s, box-shadow 0.3s;
      }
      .wmt-halo-orbit {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        animation: wmtHaloOrbit 3.5s linear infinite;
        transform-origin: center center;
      }
      .wmt-halo-dot {
        position: absolute;
        top: -4px;
        left: 50%;
        transform: translateX(-50%);
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #a78bfa;
        box-shadow: 0 0 8px #a78bfa, 0 0 14px #8b5cf6;
        transition: background 0.3s, box-shadow 0.3s;
      }

      /* Halo State Variations */
      .wmt-btn.has-mascot.state-idle .wmt-halo-ring {
        border-color: rgba(167, 139, 250, 0.4);
        box-shadow: 0 0 10px rgba(167, 139, 250, 0.25);
      }
      .wmt-btn.has-mascot.state-idle .wmt-halo-dot {
        background: #c4b5fd;
        box-shadow: 0 0 8px #c4b5fd, 0 0 14px #a78bfa;
      }
      .wmt-btn.has-mascot.busy .wmt-halo-ring,
      .wmt-btn.has-mascot.state-thinking .wmt-halo-ring {
        border-color: rgba(56, 189, 248, 0.85);
        box-shadow: 0 0 18px rgba(56, 189, 248, 0.5);
      }
      .wmt-btn.has-mascot.busy .wmt-halo-orbit,
      .wmt-btn.has-mascot.state-thinking .wmt-halo-orbit {
        animation-duration: 1.1s;
      }
      .wmt-btn.has-mascot.busy .wmt-halo-dot,
      .wmt-btn.has-mascot.state-thinking .wmt-halo-dot {
        background: #38bdf8;
        box-shadow: 0 0 10px #38bdf8, 0 0 20px #0ea5e9;
      }
      .wmt-btn.has-mascot.state-done .wmt-halo-ring {
        border-color: rgba(16, 185, 129, 0.85);
        box-shadow: 0 0 20px rgba(16, 185, 129, 0.5);
      }
      .wmt-btn.has-mascot.state-done .wmt-halo-orbit {
        animation-duration: 0.8s;
      }
      .wmt-btn.has-mascot.state-done .wmt-halo-dot {
        background: #10b981;
        box-shadow: 0 0 12px #34d399, 0 0 22px #059669;
      }

      /* Floating Animated Zzz for Idle Sleep State */
      .wmt-mascot-zzz {
        display: none;
        position: absolute;
        top: -18px;
        right: -2px;
        pointer-events: none;
        user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-weight: 800;
        color: #c4b5fd;
        text-shadow: 0 0 6px rgba(167, 139, 250, 0.8);
        align-items: flex-end;
        gap: 2px;
      }
      .wmt-btn.has-mascot.state-idle .wmt-mascot-zzz {
        display: flex;
      }
      .wmt-mascot-zzz span {
        display: inline-block;
        opacity: 0;
        animation: wmtFloatZzz 2.6s ease-in-out infinite;
      }
      .wmt-mascot-zzz span:nth-child(1) {
        font-size: 11px;
        animation-delay: 0s;
      }
      .wmt-mascot-zzz span:nth-child(2) {
        font-size: 14px;
        animation-delay: 0.6s;
      }
      .wmt-mascot-zzz span:nth-child(3) {
        font-size: 18px;
        animation-delay: 1.2s;
      }

      @keyframes wmtHaloOrbit {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes wmtFloatZzz {
        0% {
          transform: translate(0, 6px) scale(0.6);
          opacity: 0;
        }
        25% {
          opacity: 0.95;
        }
        70% {
          opacity: 0.85;
        }
        100% {
          transform: translate(8px, -20px) scale(1.15);
          opacity: 0;
        }
      }
      @keyframes wmtMascotPulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.12); }
      }
      @keyframes wmtMascotIdle {
        0%, 100% { transform: translateY(0px) scale(1); }
        50% { transform: translateY(-2px) scale(1.03); }
      }
      @keyframes wmtMascotThinking {
        0%, 100% { transform: scale(1) rotate(0deg); }
        25% { transform: scale(1.08) rotate(-3deg); }
        75% { transform: scale(1.08) rotate(3deg); }
      }
      @keyframes wmtMascotDone {
        0% { transform: scale(0.9); }
        50% { transform: scale(1.18); }
        100% { transform: scale(1); }
      }
      .wmt-btn:hover {
        background: #2563eb;
      }
      .wmt-btn:focus-visible {
        outline: 2px solid #93c5fd;
        outline-offset: 2px;
      }
      .wmt-btn:active {
        cursor: grabbing;
      }
      .wmt-badge {
        position: absolute;
        top: calc(2px * var(--wmt-fab-scale, 1));
        right: calc(2px * var(--wmt-fab-scale, 1));
        width: calc(10px * var(--wmt-fab-scale, 1));
        height: calc(10px * var(--wmt-fab-scale, 1));
        border-radius: 50%;
        border: 2px solid #ffffff;
        background: #9ca3af;
      }
      .wmt-badge.active {
        background: #10b981;
      }
      .wmt-badge.busy {
        background: #f59e0b;
        animation: wmtPulse 1s ease-in-out infinite;
      }
      .wmt-badge.done {
        background: #10b981;
        box-shadow: 0 0 6px rgba(16, 185, 129, 0.8);
      }
      @keyframes wmtPulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
      .wmt-btn.busy svg {
        animation: wmtSpin 1s linear infinite;
      }
      @keyframes wmtSpin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .wmt-panel {
        position: absolute;
        bottom: calc(44px * var(--wmt-fab-scale, 1) + 10px);
        right: 0;
        width: 280px;
        transform: scale(var(--wmt-fs-scale, 1));
        transform-origin: bottom right;
        background: var(--wmt-panel-bg);
        border-radius: 12px;
        box-shadow: var(--wmt-shadow);
        border: 1px solid var(--wmt-border);
        color: var(--wmt-text-body);
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        animation: wmtFadeIn 0.15s ease-out;
      }
      @keyframes wmtFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .wmt-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--wmt-border);
        padding-bottom: 8px;
      }
      .wmt-title {
        font-weight: 600;
        font-size: 14px;
        color: var(--wmt-text-title);
      }
      .wmt-close {
        background: transparent;
        border: none;
        color: var(--wmt-text-muted);
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
      }
      .wmt-close:hover {
        color: var(--wmt-text-title);
        background: var(--wmt-surface-hover);
      }
      .wmt-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .wmt-status-tag {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 9999px;
        background: var(--wmt-surface);
        color: var(--wmt-text-secondary);
      }
      .wmt-status-tag.on {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
      }
      .wmt-model-row {
        gap: 8px;
        align-items: center;
      }
      .wmt-model-lbl {
        font-size: 11px;
        font-weight: 500;
        color: var(--wmt-text-secondary);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .wmt-model-select {
        flex: 1;
        min-width: 0;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 11.5px;
        font-family: inherit;
        border: 1px solid var(--wmt-border);
        background: var(--wmt-surface);
        color: var(--wmt-text-title);
        outline: none;
        cursor: pointer;
      }
      .wmt-model-select:focus-visible {
        border-color: #3b82f6;
      }
      .wmt-switch-btn {
        width: 100%;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border: 1px solid var(--wmt-border);
        background: var(--wmt-surface);
        color: var(--wmt-text-secondary);
        transition: background 0.15s;
      }
      .wmt-switch-btn:hover {
        background: var(--wmt-surface-hover);
        color: var(--wmt-text-title);
      }
      .wmt-switch-btn.active {
        background: #ef4444;
        color: #ffffff;
        border-color: #ef4444;
      }
      .wmt-mode-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--wmt-mode-bg);
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid var(--wmt-mode-border);
      }
      .wmt-mode-label {
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
      }
      .wmt-actions {
        display: flex;
        gap: 8px;
      }
      .wmt-action-btn {
        flex: 1;
        padding: 7px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        border: none;
        cursor: pointer;
        transition: background 0.15s;
      }
      .wmt-btn-primary {
        background: #3b82f6;
        color: #ffffff;
      }
      .wmt-btn-primary:hover {
        background: #2563eb;
      }
      .wmt-btn-secondary {
        background: var(--wmt-surface);
        color: var(--wmt-text-secondary);
        border: 1px solid var(--wmt-border);
      }
      .wmt-btn-secondary:hover {
        background: var(--wmt-surface-hover);
        color: var(--wmt-text-title);
      }
      .wmt-progress {
        font-size: 11px;
        color: #38bdf8;
        text-align: center;
        line-height: 1.3;
      }
      .wmt-hint {
        font-size: 11px;
        color: var(--wmt-text-muted);
        text-align: center;
        line-height: 1.3;
      }
      .wmt-warning {
        font-size: 11px;
        color: #f87171;
        background: rgba(239, 68, 68, 0.12);
        padding: 6px;
        border-radius: 4px;
        line-height: 1.3;
      }
    `;

    const container = document.createElement('div');
    container.innerHTML = `
      <button class="wmt-btn" id="wmt-fab" aria-label="WebMCP Translator" title="WebMCP Translator" tabindex="0">
        <div class="wmt-halo" id="wmt-halo" aria-hidden="true">
          <div class="wmt-halo-ring"></div>
          <div class="wmt-halo-orbit">
            <div class="wmt-halo-dot"></div>
          </div>
        </div>
        <div class="wmt-mascot-zzz" id="wmt-mascot-zzz" aria-hidden="true">
          <span>z</span><span>z</span><span>Z</span>
        </div>
        <img class="wmt-mascot-img" id="wmt-mascot-img" alt="Mascot" style="display: none;" />
        <svg class="wmt-default-svg" id="wmt-default-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m5 8 6 6"/>
          <path d="m4 14 6-6 2-3"/>
          <path d="M2 5h12"/>
          <path d="M7 2h1"/>
          <path d="m22 22-5-10-5 10"/>
          <path d="M14 18h6"/>
        </svg>
        <span class="wmt-badge" id="wmt-badge"></span>
      </button>
      <div class="wmt-panel" id="wmt-panel" style="display: none;">
        <div class="wmt-header">
          <span class="wmt-title">WebMCP Translator</span>
          <button class="wmt-close" id="wmt-close" aria-label="Close">✕</button>
        </div>
        <div class="wmt-row">
          <span class="wmt-status-lbl"></span>
          <span class="wmt-status-tag" id="wmt-status-tag"></span>
        </div>
        <div class="wmt-row wmt-model-row">
          <span class="wmt-model-lbl"></span>
          <select class="wmt-model-select" id="wmt-model-select" aria-label="Model"></select>
        </div>
        <button class="wmt-switch-btn" id="wmt-toggle-tab"></button>
        <div class="wmt-mode-group">
          <label class="wmt-mode-label">
            <input type="radio" name="wmt-mode" value="scroll-follow" checked />
            <span class="wmt-mode-text-scroll"></span>
          </label>
          <label class="wmt-mode-label">
            <input type="radio" name="wmt-mode" value="full" />
            <span class="wmt-mode-text-full"></span>
          </label>
        </div>
        <div class="wmt-actions">
          <button class="wmt-action-btn wmt-btn-primary" id="wmt-action-translate"></button>
          <button class="wmt-action-btn wmt-btn-secondary" id="wmt-action-restore"></button>
        </div>
        <div id="wmt-progress" class="wmt-progress" style="display:none;"></div>
        <div id="wmt-warn-msg" class="wmt-warning" style="display:none;"></div>
        <div class="wmt-hint"></div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(container);

    let currentMascotState = 'idle'; // 'idle' | 'thinking' | 'done'
    let doneStateTimer = null;
    let prevBusyState = false;

    const MASCOT_MAP = {
      'polyglot-owl': 'icons/mascots/polyglot-owl.png',
      'babel-cat': 'icons/mascots/babel-cat.png',
      'globe-fox': 'icons/mascots/globe-fox.png',
      'lingo-parrot': 'icons/mascots/lingo-parrot.png',
      'robo-babel': 'icons/mascots/robo-babel.png'
    };

    function updateMascotVisual(stateOverride) {
      if (stateOverride) currentMascotState = stateOverride;
      const mascotImg = container.querySelector('#wmt-mascot-img');
      const defaultSvg = container.querySelector('#wmt-default-svg');
      const fabBtn = container.querySelector('#wmt-fab');
      const badgeEl = container.querySelector('#wmt-badge');
      if (!mascotImg || !defaultSvg || !fabBtn) return;

      const mascotTheme = (typeof widgetState.fabMascot === 'string' && widgetState.fabMascot) ? widgetState.fabMascot : 'default';
      const VALID_THEMES = ['polyglot-owl', 'babel-cat', 'globe-fox', 'lingo-parrot', 'robo-babel'];

      fabBtn.classList.remove('state-idle', 'state-thinking', 'state-done');
      fabBtn.classList.add(`state-${currentMascotState}`);

      if (badgeEl) {
        badgeEl.classList.toggle('busy', currentMascotState === 'thinking');
        badgeEl.classList.toggle('done', currentMascotState === 'done');
      }

      if (mascotTheme !== 'default' && VALID_THEMES.includes(mascotTheme)) {
        fabBtn.classList.add('has-mascot');
        const stateName = (currentMascotState === 'thinking') ? 'thinking'
                        : (currentMascotState === 'done') ? 'done'
                        : 'idle';
        const subfolderPath = `icons/mascots/${mascotTheme}/${stateName}.png`;
        const flatPath = (currentMascotState === 'thinking') ? `icons/mascots/${mascotTheme}-thinking.png`
                       : (currentMascotState === 'done') ? `icons/mascots/${mascotTheme}-done.png`
                       : `icons/mascots/${mascotTheme}.png`;

        try {
          const getUrl = (p) => (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
            ? chrome.runtime.getURL(p)
            : p;
          const targetUrl = getUrl(subfolderPath);
          if (mascotImg.src !== targetUrl) {
            mascotImg.src = targetUrl;
          }
          mascotImg.style.display = 'block';
          defaultSvg.style.display = 'none';
          mascotImg.onerror = () => {
            try {
              const flatUrl = getUrl(flatPath);
              if (mascotImg.src !== flatUrl) {
                mascotImg.src = flatUrl;
                return;
              }
              const fallbackUrl = getUrl(`icons/mascots/${mascotTheme}.png`);
              if (mascotImg.src !== fallbackUrl) {
                mascotImg.src = fallbackUrl;
                return;
              }
            } catch {}
            fabBtn.classList.remove('has-mascot');
            mascotImg.style.display = 'none';
            defaultSvg.style.display = 'block';
          };
        } catch {
          fabBtn.classList.remove('has-mascot');
          mascotImg.style.display = 'none';
          defaultSvg.style.display = 'block';
        }
      } else {
        fabBtn.classList.remove('has-mascot');
        mascotImg.style.display = 'none';
        defaultSvg.style.display = 'block';
      }
    }

    fabBusySetter = (busy) => {
      const f = container.querySelector('#wmt-fab');
      const b = container.querySelector('#wmt-badge');
      if (f) f.classList.toggle('busy', busy);
      if (b) b.classList.toggle('busy', busy);

      if (busy) {
        if (doneStateTimer) { clearTimeout(doneStateTimer); doneStateTimer = null; }
        updateMascotVisual('thinking');
      } else if (prevBusyState && !busy) {
        updateMascotVisual('done');
        if (doneStateTimer) clearTimeout(doneStateTimer);
        doneStateTimer = setTimeout(() => {
          updateMascotVisual('idle');
          doneStateTimer = null;
        }, 3000);
      } else if (!doneStateTimer) {
        updateMascotVisual('idle');
      }
      prevBusyState = Boolean(busy);
    };
    updateFabBusy();

    const fab = container.querySelector('#wmt-fab');
    const panel = container.querySelector('#wmt-panel');
    const badge = container.querySelector('#wmt-badge');
    const statusTag = container.querySelector('#wmt-status-tag');
    const toggleTabBtn = container.querySelector('#wmt-toggle-tab');
    const closeBtn = container.querySelector('#wmt-close');
    const translateBtn = container.querySelector('#wmt-action-translate');
    const restoreBtn = container.querySelector('#wmt-action-restore');
    const modeRadios = container.querySelectorAll('input[name="wmt-mode"]');
    const warnMsg = container.querySelector('#wmt-warn-msg');
    const progressEl = container.querySelector('#wmt-progress');
    const statusLbl = container.querySelector('.wmt-status-lbl');
    const modelSelect = container.querySelector('#wmt-model-select');
    const modelLbl = container.querySelector('.wmt-model-lbl');
    const modeTextScroll = container.querySelector('.wmt-mode-text-scroll');
    const modeTextFull = container.querySelector('.wmt-mode-text-full');
    const hintEl = container.querySelector('.wmt-hint');

    let currentUiLocale = 'vi';
    let currentTheme = 'dark';
    let currentFontScale = 'md';
    let isPanelOpen = false;
    let widgetState = {
      effective: 'off',
      siteEnabled: false,
      tabOverride: null,
      permission: false,
      mode: 'scroll-follow',
      widgetVisible: true,
      position: null,
      hasKey: false,
      uiLocale: 'vi',
      theme: 'dark',
      uiFontScale: 'md'
    };

    function wmtT(key, params) {
      if (typeof window !== 'undefined' && window.__wmtI18n && typeof window.__wmtI18n.t === 'function') {
        return window.__wmtI18n.t(currentUiLocale, key, params);
      }
      return WIDGET_FALLBACK_LABELS[key] || key;
    }
    widgetTHook = wmtT;

    function renderWidgetI18n() {
      if (closeBtn) closeBtn.setAttribute('aria-label', wmtT('widget_close_label'));
      if (statusLbl) statusLbl.textContent = wmtT('widget_status_label');
      if (modelLbl) modelLbl.textContent = wmtT('widget_model_label');
      if (modelSelect) modelSelect.setAttribute('aria-label', wmtT('widget_model_label'));
      if (modeTextScroll) modeTextScroll.textContent = wmtT('widget_mode_scroll');
      if (modeTextFull) modeTextFull.textContent = wmtT('widget_mode_full');
      if (translateBtn) translateBtn.textContent = wmtT('widget_btn_translate');
      if (restoreBtn) restoreBtn.textContent = wmtT('widget_btn_restore');
      if (hintEl) hintEl.textContent = wmtT('widget_hint');
      const isEffectiveOn = widgetState.effective === 'on';
      if (statusTag) statusTag.textContent = isEffectiveOn ? wmtT('widget_status_on') : wmtT('widget_status_off');
      if (toggleTabBtn) toggleTabBtn.textContent = isEffectiveOn ? wmtT('widget_toggle_tab_on') : wmtT('widget_toggle_tab_off');
    }
    renderWidgetI18n();

    function refreshWidgetProgress() {
      if (!progressEl) return;
      const running = isTranslating || scrollSession.watching;
      if (!isPanelOpen || !running) {
        progressEl.style.display = 'none';
        return;
      }
      const st = lastTranslateStatus || {};
      const applied = st.totalApplied || 0;
      const collected = st.totalCollected || 0;
      const failed = st.totalFailed || 0;
      let text = collected > 0
        ? wmtT('detail_translating_nodes', { applied, collected })
        : wmtT('status_translating');
      if (failed > 0) text += ' ' + wmtT('status_failed_count', { count: failed });
      if (st.lastError && st.lastError.code) text += ` [${st.lastError.code}]`;
      progressEl.textContent = text;
      progressEl.style.display = 'block';
    }
    widgetProgressIntervalId = setInterval(refreshWidgetProgress, 800);

    function setPanelVisibility(open) {
      isPanelOpen = open;
      panel.style.display = isPanelOpen ? 'flex' : 'none';
      if (isPanelOpen) {
        renderWidgetI18n();
      }
    }

    let lastPresentationTime = 0;

    function applyState(st) {
      if (!st) return;
      if (st.isPresentation) {
        lastPresentationTime = Date.now();
      }
      const isStaleQuery = (Date.now() - lastPresentationTime < 3000) && !st.isPresentation && (st.fabMascot !== undefined || st.fabSize !== undefined);
      const effectiveSt = isStaleQuery
        ? { ...st, fabMascot: widgetState.fabMascot, fabSize: widgetState.fabSize }
        : st;
      widgetState = { ...widgetState, ...effectiveSt };

      if (modelSelect) {
        const curModel = st.model || widgetState.model || '';
        const list = Array.isArray(st.availableModels) && st.availableModels.length > 0
          ? st.availableModels
          : (Array.isArray(widgetState.availableModels) && widgetState.availableModels.length > 0
              ? widgetState.availableModels
              : [curModel].filter(Boolean));
        if (list.length > 0) {
          modelSelect.innerHTML = '';
          if ((st.showFavoritesOnly || widgetState.showFavoritesOnly) && (st.favoritesHint || widgetState.favoritesHint)) {
            const hintOpt = document.createElement('option');
            hintOpt.disabled = true;
            hintOpt.textContent = `(${wmtT('fav_empty_hint_dropdown')})`;
            modelSelect.appendChild(hintOpt);
          }
          const seen = new Set();
          for (const m of list) {
            const val = typeof m === 'string' ? m : m?.id;
            if (val && !seen.has(val)) {
              seen.add(val);
              const opt = document.createElement('option');
              opt.value = val;
              opt.textContent = val;
              if (val === curModel) opt.selected = true;
              modelSelect.appendChild(opt);
            }
          }
          if (curModel && !seen.has(curModel)) {
            const opt = document.createElement('option');
            opt.value = curModel;
            opt.textContent = curModel;
            opt.selected = true;
            modelSelect.appendChild(opt);
          }
          modelSelect.value = curModel;
        }
      }

      const supportedUiLocales = (typeof window !== 'undefined' && window.__wmtI18n && window.__wmtI18n.SUPPORTED_UI_LOCALES) || ['vi', 'en', 'ja', 'ko', 'zh', 'es', 'ru'];
      if (widgetState.uiLocale && supportedUiLocales.includes(widgetState.uiLocale)) {
        currentUiLocale = widgetState.uiLocale;
        renderWidgetI18n();
      }

      if (widgetState.theme && (widgetState.theme === 'dark' || widgetState.theme === 'light')) {
        currentTheme = widgetState.theme;
        host.setAttribute('data-theme', currentTheme);
      }

      if (widgetState.uiFontScale && (widgetState.uiFontScale === 'sm' || widgetState.uiFontScale === 'md' || widgetState.uiFontScale === 'lg')) {
        currentFontScale = widgetState.uiFontScale;
        host.setAttribute('data-fontscale', currentFontScale);
      }

      if (typeof widgetState.fabSize === 'number' && !Number.isNaN(widgetState.fabSize)) {
        const clampedFabSize = Math.max(0.75, Math.min(1.5, widgetState.fabSize));
        host.setAttribute('data-fabsize', String(clampedFabSize));
        host.style.setProperty('--wmt-fab-scale', String(clampedFabSize));
      }

      // Mascot Icon (WI-52)
      updateMascotVisual();

      // Effective Consent & Auto-Start Gates (only evaluated on non-presentation updates)
      if (!st.isPresentation) {
        const dataConsentAccepted = widgetState.dataConsentAccepted === true;
        const isEffectiveOn = widgetState.effective === 'on' && dataConsentAccepted;
        if (!dataConsentAccepted || !isEffectiveOn || widgetState.permission !== true || widgetState.hasKey !== true) {
          if (autoStartTimer) {
            clearTimeout(autoStartTimer);
            autoStartTimer = null;
          }
          autoStartAttempted = false;
          autoStarting = false;
          updateFabBusy();
          if (isTranslating || scrollSession.active || scrollSession.watching || scrollSession.inFlight > 0) {
            cancelActiveTranslation();
          }
        }

        badge.classList.toggle('active', isEffectiveOn);
        statusTag.textContent = isEffectiveOn ? wmtT('widget_status_on') : wmtT('widget_status_off');
        statusTag.classList.toggle('on', isEffectiveOn);

        toggleTabBtn.textContent = isEffectiveOn ? wmtT('widget_toggle_tab_on') : wmtT('widget_toggle_tab_off');
        toggleTabBtn.classList.toggle('active', isEffectiveOn);

        // Mode
        const activeMode = widgetState.mode || 'scroll-follow';
        currentMode = activeMode;
        modeRadios.forEach((r) => {
          r.checked = r.value === activeMode;
        });
      }

      // Visibility
      if (widgetState.widgetVisible === false) {
        host.style.display = 'none';
        return;
      }
      host.style.display = 'block';

      // Position
      if (widgetState.position && typeof widgetState.position.x === 'number' && typeof widgetState.position.y === 'number') {
        const x = Math.max(0, Math.min(window.innerWidth - 60, widgetState.position.x));
        const y = Math.max(0, Math.min(window.innerHeight - 60, widgetState.position.y));
        host.style.left = x + 'px';
        host.style.top = y + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      }

      // Warnings
      if (!widgetState.permission) {
        warnMsg.textContent = wmtT('widget_warn_no_perm');
        warnMsg.style.display = 'block';
      } else if (!widgetState.hasKey) {
        warnMsg.textContent = wmtT('widget_warn_no_key');
        warnMsg.style.display = 'block';
      } else {
        warnMsg.style.display = 'none';
      }
    }

    function checkAutoStart(st) {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      if (autoStartAttempted) return;

      if (!st || !st.autoStart || userRestored) return;
      // Defensive gates mirror the SW WIDGET_GET_STATE gate: never auto-start
      // when consent is off, permission/key is missing, or context is stale.
      // Effective consent is required (missing field means not enabled).
      if (st.effective !== 'on') return;
      if (st.hasKey !== true) return;
      if (st.permission !== true) return;
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

      // Consume the one-shot attempt only once a valid enabled state is ready
      // to schedule: an initial disabled (no_key/no_permission/site-off)
      // response must not block a later enabled push, because the
      // WIDGET_STATE_CHANGED re-query requires !autoStartAttempted.
      autoStartAttempted = true;
      autoStarting = true;
      updateFabBusy();

      autoStartTimer = setTimeout(() => {
        autoStartTimer = null;
        try {
          if (__wmtHalted || !__wmtValidContext()) {
            autoStarting = false;
            updateFabBusy();
            __wmtHaltStale();
            return;
          }
          if (userRestored) {
            autoStarting = false;
            updateFabBusy();
            return;
          }
          if (isTranslating || scrollSession.watching) {
            autoStarting = false;
            updateFabBusy();
            return;
          }
          if (!lastTranslateStatus) {
            autoStarting = false;
            updateFabBusy();
            return;
          }

          // Re-check the latest state: permission/hasKey/autoStart may have
          // changed during the settle interval while effective stayed on.
          // A failed re-check must not start and must leave auto-start
          // retryable for a later complete positive update.
          const latest = widgetState || st || {};
          if (!latest.autoStart || latest.effective !== 'on' || latest.hasKey !== true || latest.permission !== true) {
            autoStartAttempted = false;
            autoStarting = false;
            updateFabBusy();
            return;
          }
          if (location.protocol !== 'http:' && location.protocol !== 'https:') {
            autoStartAttempted = false;
            autoStarting = false;
            updateFabBusy();
            return;
          }
          const targetMode = latest.mode || 'scroll-follow';
          currentMode = targetMode;
          lastTranslateStatus.mode = targetMode;

          // Auto-start scheduled window elapsed: hand over to in-flight translation
          autoStarting = false;
          updateFabBusy();

          if (targetMode === 'scroll-follow') {
            startScrollFollowSession(latest);
          } else {
            executeTranslation(latest).catch((e) => {
              if (__wmtInvalidatedErr(e)) __wmtHaltStale();
            });
          }
        } catch (err) {
          autoStarting = false;
          updateFabBusy();
          if (__wmtInvalidatedErr(err)) { __wmtHaltStale(); return; }
          try { console.error('[WebMCP Translator] auto-start failed:', err && err.message ? err.message : err); } catch {}
          try {
            if (lastTranslateStatus) {
              lastTranslateStatus.error = { code: 'AUTOSTART_FAILED', message: String((err && err.message) || err) };
            }
          } catch {}
        }
      }, AUTO_SETTLE_MS);
    }

    function queryState() {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      const mySeq = ++widgetQuerySeq;
      try {
        chrome.runtime.sendMessage({ action: 'WIDGET_GET_STATE' }, (resp) => {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              const leMsg = chrome.runtime.lastError.message || '';
              if (/extension context invalidated|context invalidated/i.test(leMsg)) { __wmtHaltStale(); return; }
              // Stale transport failure: a newer query or pushed state already
              // supersedes this reply; the latest request owns bounded retries.
              if (mySeq < widgetQuerySeq) return;
              // Transient SW-side failure (e.g. startup race): retry boundedly
              // so a fresh load still auto-starts without manual interaction.
              if (!autoStartAttempted && autoStartQueryRetries < AUTO_QUERY_MAX_RETRIES && !__wmtHalted && __wmtValidContext()) {
                autoStartQueryRetries++;
                setTimeout(queryState, AUTO_QUERY_RETRY_MS);
              }
              return;
            }
          } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
          // Ignore out-of-order replies older than the latest query or a newer
          // pushed state; only the latest authoritative response may apply.
          if (mySeq < widgetQuerySeq) return;
          if (resp && !resp.error) {
            autoStartQueryRetries = 0;
            applyState(resp);
            checkAutoStart(resp);
          } else if (resp && resp.error && !autoStartAttempted && autoStartQueryRetries < AUTO_QUERY_MAX_RETRIES && !__wmtHalted && __wmtValidContext()) {
            autoStartQueryRetries++;
            setTimeout(queryState, AUTO_QUERY_RETRY_MS);
          }
        });
      } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
    }

    // Drag implementation using Pointer Events
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialHostLeft = 0;
    let initialHostTop = 0;
    let pointerCapturedId = null;

    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      isDragging = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = host.getBoundingClientRect();
      initialHostLeft = rect.left;
      initialHostTop = rect.top;
      pointerCapturedId = e.pointerId;
      try {
        fab.setPointerCapture(e.pointerId);
      } catch {}
    });

    fab.addEventListener('pointermove', (e) => {
      if (pointerCapturedId === null) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (!isDragging && Math.hypot(dx, dy) > 5) {
        isDragging = true;
      }
      if (isDragging) {
        requestAnimationFrame(() => {
          const clampedX = Math.max(0, Math.min(window.innerWidth - 50, initialHostLeft + dx));
          const clampedY = Math.max(0, Math.min(window.innerHeight - 50, initialHostTop + dy));
          host.style.left = clampedX + 'px';
          host.style.top = clampedY + 'px';
          host.style.right = 'auto';
          host.style.bottom = 'auto';
        });
      }
    });

    function finishDrag(e) {
      if (pointerCapturedId === null) return;
      try {
        fab.releasePointerCapture(pointerCapturedId);
      } catch {}
      pointerCapturedId = null;

      if (isDragging) {
        const rect = host.getBoundingClientRect();
        const clampedX = Math.max(0, Math.min(window.innerWidth - 50, rect.left));
        const clampedY = Math.max(0, Math.min(window.innerHeight - 50, rect.top));
        __wmtFire({
          action: 'WIDGET_SET_POSITION',
          x: clampedX,
          y: clampedY
        });
      } else {
        setPanelVisibility(!isPanelOpen);
      }
      isDragging = false;
    }

    fab.addEventListener('pointerup', finishDrag);
    fab.addEventListener('pointercancel', (e) => {
      if (pointerCapturedId !== null) {
        try { fab.releasePointerCapture(pointerCapturedId); } catch {}
        pointerCapturedId = null;
      }
      isDragging = false;
    });

    // Keyboard navigation: Enter/Space toggles panel, Escape closes panel/drag, Arrows move
    fab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setPanelVisibility(!isPanelOpen);
      } else if (e.key === 'Escape') {
        if (isPanelOpen) {
          e.preventDefault();
          setPanelVisibility(false);
        }
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const rect = host.getBoundingClientRect();
        let curX = rect.left;
        let curY = rect.top;
        const step = 10;
        if (e.key === 'ArrowUp') curY -= step;
        if (e.key === 'ArrowDown') curY += step;
        if (e.key === 'ArrowLeft') curX -= step;
        if (e.key === 'ArrowRight') curX += step;
        const clampedX = Math.max(0, Math.min(window.innerWidth - 50, curX));
        const clampedY = Math.max(0, Math.min(window.innerHeight - 50, curY));
        host.style.left = clampedX + 'px';
        host.style.top = clampedY + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      }
    });

    fab.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const rect = host.getBoundingClientRect();
        __wmtFire({
          action: 'WIDGET_SET_POSITION',
          x: Math.round(rect.left),
          y: Math.round(rect.top)
        });
      }
    });

    closeBtn.addEventListener('click', () => setPanelVisibility(false));

    // Tab ON/OFF toggle: sends WIDGET_SET_ENABLED (stale-safe)
    toggleTabBtn.addEventListener('click', () => {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      const targetEnabled = widgetState.effective !== 'on';
      try {
        chrome.runtime.sendMessage({
          action: 'WIDGET_SET_ENABLED',
          enabled: targetEnabled
        }, (resp) => {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
              return;
            }
          } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
          if (resp && resp.error) {
          if (resp.error.code === 'PERMISSION_REQUIRED') {
            warnMsg.textContent = wmtT('widget_warn_no_perm');
            warnMsg.style.display = 'block';
          }
          return;
        }
        applyState(resp);
        if (!targetEnabled) {
          // Turning OFF restores the original page text (not just stopping)
          try {
            restore();
          } catch {
            stopScrollFollowSession(true);
            __wmtFire({ action: 'CANCEL_PENDING', epoch });
          }
        } else if (widgetState.effective === 'on') {
          // Turning ON starts translating immediately (scroll-aware), same as translate now
          try {
            if (currentMode === 'scroll-follow' || widgetState.mode === 'scroll-follow') {
              startScrollFollowSession(widgetState);
            } else {
              executeTranslation(widgetState).catch((e) => {
                if (__wmtInvalidatedErr(e)) __wmtHaltStale();
              });
            }
          } catch (err) {
            if (__wmtInvalidatedErr(err)) { __wmtHaltStale(); return; }
            try { console.error('[WebMCP Translator] widget enable-start failed:', err && err.message ? err.message : err); } catch {}
          }
        }
        });
      } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
    });

    // Mode Selector: sends WIDGET_SET_MODE (stale-safe)
    modeRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
        if (r.checked) {
          const selectedMode = r.value;
          try {
            chrome.runtime.sendMessage({
              action: 'WIDGET_SET_MODE',
              mode: selectedMode
            }, (resp) => {
              try {
                if (chrome.runtime && chrome.runtime.lastError) {
                  if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
                  return;
                }
              } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
              if (resp && !resp.error) {
                currentMode = selectedMode;
                lastTranslateStatus.mode = selectedMode;
                if (selectedMode === 'scroll-follow' && widgetState.effective === 'on') {
                  startScrollFollowSession();
                } else if (selectedMode === 'full') {
                  stopScrollFollowSession(true);
                }
              }
            });
          } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
        }
      });
    });

    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
        const selectedModel = modelSelect.value;
        if (!selectedModel) return;
        try {
          chrome.runtime.sendMessage({
            action: 'WIDGET_SET_MODE',
            mode: currentMode,
            model: selectedModel
          }, (resp) => {
            try {
              if (chrome.runtime && chrome.runtime.lastError) {
                if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
                return;
              }
            } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
            if (resp && !resp.error) {
              widgetState.model = selectedModel;
            }
          });
        } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
      });
    }

    // Translate Now Button
    translateBtn.addEventListener('click', () => {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      setPanelVisibility(false);
      if (currentMode === 'scroll-follow') {
        startScrollFollowSession({ ...widgetState, force: true });
      } else {
        executeTranslation({ ...widgetState, force: true }).catch((e) => {
          if (__wmtInvalidatedErr(e)) __wmtHaltStale();
        });
      }
    });

    // Restore Button
    restoreBtn.addEventListener('click', () => {
      setPanelVisibility(false);
      restore();
    });

    // Focus & Visibility re-query
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') queryState();
    });
    window.addEventListener('focus', () => queryState());

    // Window resize viewport clamp
    window.addEventListener('resize', () => {
      const rect = host.getBoundingClientRect();
      const clampedX = Math.max(0, Math.min(window.innerWidth - 50, rect.left));
      const clampedY = Math.max(0, Math.min(window.innerHeight - 50, rect.top));
      if (clampedX !== rect.left || clampedY !== rect.top) {
        host.style.left = clampedX + 'px';
        host.style.top = clampedY + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      }
    });

    // Append to document.documentElement
    document.documentElement.appendChild(host);
    queryState();

    // Listen for push notifications (re-evaluate auto-start when consent /
    // permission arrives after load; queryState bounds retries internally)
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
