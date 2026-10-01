// WebMCP Translator Kit — Content Script (DOM Scanner, Scroll-Follow Engine, Floating Widget)
// Top Frame only, ISOLATED World

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

  // Floating-button busy indicator hook (wired up by initFloatingWidget)
  let fabBusySetter = null;
  function setFabBusy(busy) {
    try {
      if (typeof fabBusySetter === 'function') fabBusySetter(Boolean(busy));
    } catch {}
  }

  // Busy = actual in-flight translation work (not merely "watching"). This is
  // what stops the spinner from running forever after everything is done.
  function updateFabBusy() {
    setFabBusy(isTranslating || scrollSession.inFlight > 0);
  }

  const documentId = 'doc_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
  let epoch = 0;
  let idCounter = 1;
  let currentMode = 'full'; // 'full' | 'scroll-follow'

  const AUTO_SETTLE_MS = 500;
  let autoStartAttempted = false;
  let userRestored = false;
  let autoStartTimer = null;

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
    const skipped = [];

    const items = results || [];
    if (targetEpoch !== epoch) {
      items.forEach((r) => skipped.push({ id: r?.id, reason: 'EPOCH_MISMATCH' }));
      return { applied: 0, skipped };
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

    return { applied, skipped };
  }

  // Restore DOM nodes: epoch++ + CANCEL_PENDING + stop active sessions + clear pending
  function restore() {
    userRestored = true;
    if (autoStartTimer) {
      clearTimeout(autoStartTimer);
      autoStartTimer = null;
    }

    // 1. Advance epoch to immediately drop in-flight / late-arriving responses
    epoch++;
    const cancelEpoch = epoch;

    // 2. Fire-and-forget CANCEL_PENDING to Service Worker
    try {
      chrome.runtime.sendMessage({ action: 'CANCEL_PENDING', epoch: cancelEpoch }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch {}

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

  // Send chunk wrapper
  function sendChunk(items, settings = {}, chunkEpoch = epoch) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'TRANSLATE_BATCH',
          epoch: chunkEpoch,
          payload: {
            items,
            sourceLanguage: settings.sourceLanguage || 'auto',
            targetLanguage: settings.targetLanguage || 'vi',
            model: settings.model || 'ag/gemini-3.1-pro-low'
          }
        },
        (response) => {
          if (chrome.runtime.lastError) {
            const lastErrMsg = chrome.runtime.lastError.message || '';
            if (isDroppedOnRestartError(lastErrMsg)) {
              resolve({
                error: {
                  code: 'DROPPED_ON_RESTART',
                  message: 'Yêu cầu bị mất khi service worker khởi động lại',
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
        }
      );
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

    // 1. Initial sendChunk
    let resp = await sendChunk(items, settings, targetEpoch);
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

    if (resp && resp.error && isNonRetryable(resp.error)) {
      if (resp.error.code === 'RATE_LIMITED') {
        const retrySec = Math.ceil((resp.error.details?.retryAfterMs || 0) / 1000);
        console.warn(`[WebMCP Translator] Quota exceeded (${resp.error.details?.scope || 'tab'}): retry after ${retrySec}s`);
      }
      return { applied: 0, failed: items.length, error: resp.error, fatal: true };
    }

    if (resp && Array.isArray(resp.results)) {
      if (resp.actualModel) {
        lastTranslateStatus.actualModel = resp.actualModel;
        lastTranslateStatus.fallbackIndex = resp.fallbackIndex || 0;
      }
      const patchResult = await applyBatchThrottled(resp.results, targetEpoch);
      return { applied: patchResult.applied, failed: 0 };
    }

    // 2. Retry 1 time after ~800 ms if error
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (targetEpoch !== undefined && epoch !== targetEpoch) {
      return { cancelled: true, applied: 0, failed: 0 };
    }

    resp = await sendChunk(items, settings, targetEpoch);
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

    if (resp && Array.isArray(resp.results)) {
      if (resp.actualModel) {
        lastTranslateStatus.actualModel = resp.actualModel;
        lastTranslateStatus.fallbackIndex = resp.fallbackIndex || 0;
      }
      const patchResult = await applyBatchThrottled(resp.results, targetEpoch);
      return { applied: patchResult.applied, failed: 0 };
    }

    // 3. If still failing, depth < 2 and items.length > 8: binary split & recurse sequentially
    if (depth < 2 && items.length > 8) {
      const mid = Math.ceil(items.length / 2);
      const leftItems = items.slice(0, mid);
      const rightItems = items.slice(mid);

      const leftRes = await translateChunkWithRecovery(leftItems, settings, depth + 1, targetEpoch, runConfig);
      if (leftRes.cancelled) {
        return leftRes;
      }

      const rightRes = await translateChunkWithRecovery(rightItems, settings, depth + 1, targetEpoch, runConfig);
      if (rightRes.cancelled) {
        return rightRes;
      }

      return {
        applied: (leftRes.applied || 0) + (rightRes.applied || 0),
        failed: (leftRes.failed || 0) + (rightRes.failed || 0),
        error: rightRes.error || leftRes.error || resp?.error
      };
    }

    // 4. Otherwise record failure
    return {
      applied: 0,
      failed: items.length,
      error: resp?.error || { code: 'CHUNK_FAILED', message: 'Chunk translation failed' }
    };
  }

  // ============================================================================
  // Full Page Translate Execution
  // ============================================================================
  async function executeTranslation(settings = {}) {
    if (isTranslating && !settings.force) return { alreadyRunning: true };

    // Stop scroll-follow session before starting full page translation
    stopScrollFollowSession(true);

    isTranslating = true;
    updateFabBusy();
    currentMode = 'full';
    const runToken = ++activeRunToken;
    const finishRun = () => { if (activeRunToken === runToken) { isTranslating = false; updateFabBusy(); } };
    epoch++;
    const currentEpoch = epoch;
    const startTime = Date.now();
    const targetModel = settings.model || 'ag/gemini-3.1-pro-low';

    // Cancel pending queue in SW for this tab before starting new epoch (fire-and-forget)
    try {
      chrome.runtime.sendMessage({ action: 'CANCEL_PENDING', epoch: currentEpoch }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch {}

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
      const runConfig = { revision: typeof settings.configRevision === 'number' ? settings.configRevision : null };

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
              model: targetModel
            },
            0,
            currentEpoch,
            runConfig
          );

          if (epoch !== currentEpoch || runAborted) break;

          totalApplied += chunkRes.applied || 0;
          totalFailed += chunkRes.failed || 0;
          if (chunkRes.error) {
            lastError = chunkRes.error;
          }

          chunksDone++;
          lastTranslateStatus.totalApplied = totalApplied;
          lastTranslateStatus.totalFailed = totalFailed;
          lastTranslateStatus.chunksDone = chunksDone;

          if (chunkRes.fatal || chunkRes.cancelled) {
            runAborted = true;
            epoch++;
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
      lastTranslateStatus.elapsedMs = elapsedMs;
      lastTranslateStatus.chunksDone = chunksDone;
      lastTranslateStatus.totalApplied = totalApplied;
      lastTranslateStatus.totalFailed = totalFailed;
      lastTranslateStatus.model = targetModel;

      // Handle fatal or fully failed run
      if ((totalApplied === 0 && totalFailed > 0) || (lastError && (lastError.code === 'DROPPED_ON_RESTART' || lastError.code === 'ABORTED')) || (runAborted && lastError)) {
        lastTranslateStatus.state = 'error';
        lastTranslateStatus.error = lastError || { code: 'CHUNK_FAILED', message: 'Tất cả các chunk đều thất bại' };
        finishRun();
        return {
          ok: false,
          error: lastTranslateStatus.error,
          cancelled: runAborted || lastError?.code === 'ABORTED',
          applied: totalApplied,
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
        applied: totalApplied,
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
    debounceTimer: null,
    retryTimer: null,
    scrollRaf: null,
    settings: {}
  };

  function scheduleScrollFlush() {
    if (!scrollSession.active) return;
    if (scrollSession.debounceTimer) return;
    const delay = throttle.debounceMinMs || SCROLL_DEBOUNCE_MS;
    scrollSession.debounceTimer = setTimeout(() => {
      scrollSession.debounceTimer = null;
      flushReadyBlocks();
    }, delay);
  }

  async function flushReadyBlocks() {
    if (!scrollSession.active) return;
    // Dispatch ≤2 batch in-flight; batch 3 waits in readySet
    if (scrollSession.inFlight >= MAX_IN_FLIGHT_BATCHES) return;

    const H = window.innerHeight || 800;
    const topBound = SCROLL_BEHIND_H * H;
    const bottomBound = SCROLL_AHEAD_H * H;

    const candidateRecs = [];
    const seenRecIds = new Set();

    if (scrollSession.readyBlocks.size === 0) {
      const curBlocks = document.querySelectorAll(BLOCK_SELECTOR);
      for (const b of curBlocks) {
        if (b.closest && (b.closest('#__wmt-widget-host') || b.closest('[data-wmt-ignore]'))) continue;
        try {
          const rect = b.getBoundingClientRect();
          if (rect.bottom >= topBound && rect.top <= bottomBound) {
            scrollSession.readyBlocks.add(b);
          }
        } catch {}
      }
    }

    for (const block of scrollSession.readyBlocks) {
      if (!block || !block.isConnected) {
        scrollSession.readyBlocks.delete(block);
        continue;
      }
      let rect;
      try {
        rect = block.getBoundingClientRect();
      } catch {
        continue;
      }
      // Check block within [-2H, 3H] viewport bounds; prune far blocks so
      // fast long-distance scrolls don't grow the set unboundedly
      if (rect.bottom < topBound || rect.top > bottomBound) {
        scrollSession.readyBlocks.delete(block);
        continue;
      }

      const blockCenterY = rect.top + rect.height / 2;
      const distToViewport = Math.abs(blockCenterY - H / 2);

      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      let tn;
      while ((tn = walker.nextNode())) {
        if (!eligibleTextNode(tn)) continue;
        const rec = ensureRec(tn);
        refreshIfExternallyModified(rec);
        if (rec.translated !== null && tn.nodeValue === rec.translated) continue;

        // Skip pending items by (id, revision, epoch)
        const pendingKey = `${rec.id}:${rec.revision}:${epoch}`;
        if (pendingSet.has(pendingKey)) continue;

        if (!seenRecIds.has(rec.id)) {
          seenRecIds.add(rec.id);
          candidateRecs.push({
            id: rec.id,
            text: tn.nodeValue,
            revision: rec.revision,
            documentId,
            dist: distToViewport
          });
        }
      }
    }

    if (candidateRecs.length === 0) {
      if (scrollSession.inFlight === 0 && lastTranslateStatus.state === 'translating') {
        lastTranslateStatus.state = 'done';
      }
      return;
    }

    // Sort by distance to viewport center
    candidateRecs.sort((a, b) => a.dist - b.dist);

    const items = candidateRecs.map((c) => ({
      id: c.id,
      text: c.text,
      revision: c.revision,
      documentId: c.documentId
    }));

    // Track unique collected nodes for status (scroll mode collects over time)
    if (!scrollSession.collectedIds) scrollSession.collectedIds = new Set();
    for (const c of candidateRecs) {
      scrollSession.collectedIds.add(c.id);
    }
    lastTranslateStatus.totalCollected = scrollSession.collectedIds.size;

    const chunks = chunkItems(items, SCROLL_MAX_BATCH_ITEMS, SCROLL_MAX_BATCH_BYTES);

    while (scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES && chunks.length > 0) {
      const chunk = chunks.shift();
      if (!chunk || chunk.length === 0) break;

      const chunkEpoch = epoch;
      const batchPendingKeys = [];
      for (const it of chunk) {
        const key = `${it.id}:${it.revision}:${chunkEpoch}`;
        pendingSet.add(key);
        batchPendingKeys.push(key);
      }

      scrollSession.inFlight++;
      updateFabBusy();
      dispatchScrollBatch(chunk, batchPendingKeys, chunkEpoch);
    }
  }

  async function dispatchScrollBatch(chunk, batchPendingKeys, chunkEpoch) {
    // Fatal outcomes must not reschedule a flush (avoids hot-loop spam)
    let batchFatal = false;
    try {
      const res = await translateChunkWithRecovery(
        chunk,
        {
          sourceLanguage: scrollSession.settings.sourceLanguage || 'auto',
          targetLanguage: scrollSession.settings.targetLanguage || 'vi',
          model: scrollSession.settings.model || 'ag/gemini-3.1-pro-low',
          configRevision: scrollSession.settings.configRevision
        },
        0,
        chunkEpoch
      );

      if (epoch !== chunkEpoch || !scrollSession.active) {
        return;
      }

      if (res.applied) {
        lastTranslateStatus.totalApplied += res.applied;
        lastTranslateStatus.lastError = null;
      }
      if (res.failed) {
        lastTranslateStatus.totalFailed += res.failed;
      }
      if (res.error) {
        lastTranslateStatus.lastError = res.error;
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
      }
    } catch (err) {
      // Non-fatal error during scroll dispatch
    } finally {
      // Clear pending set in finally
      for (const k of batchPendingKeys) {
        pendingSet.delete(k);
      }
      scrollSession.inFlight = Math.max(0, scrollSession.inFlight - 1);
      updateFabBusy();
      if (!batchFatal && scrollSession.active && scrollSession.inFlight < MAX_IN_FLIGHT_BATCHES) {
        scheduleScrollFlush();
      }
    }
  }

  function startScrollFollowSession(settings = {}) {
    // Stop any running full translation
    isTranslating = false;
    activeRunToken++;

    stopScrollFollowSession(false);

    currentMode = 'scroll-follow';
    scrollSession.active = true;
    scrollSession.watching = true;
    scrollSession.settings = settings || {};
    updateFabBusy();
    scrollSession.epoch = epoch;

    lastTranslateStatus.mode = 'scroll-follow';
    lastTranslateStatus.watching = true;
    lastTranslateStatus.state = 'translating';
    lastTranslateStatus.lastError = null;
    lastTranslateStatus.progressApplied = 0;
    lastTranslateStatus.model = settings.model || 'ag/gemini-3.1-pro-low';

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
    const bottomBound = SCROLL_AHEAD_H * H;
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
      if (scrollSession.scrollRaf) return;
      scrollSession.scrollRaf = requestAnimationFrame(() => {
        scrollSession.scrollRaf = null;
        if (!scrollSession.active) return;
        scanViewportBlocks();
      });
    };

    const scanViewportBlocks = () => {
      const curH = window.innerHeight || 800;
      const curTopBound = SCROLL_BEHIND_H * curH;
      const curBottomBound = SCROLL_AHEAD_H * curH;
      const allBlocks = document.querySelectorAll(BLOCK_SELECTOR);
      for (const b of allBlocks) {
        if (b.closest && (b.closest('#__wmt-widget-host') || b.closest('[data-wmt-ignore]'))) continue;
        try {
          const rect = b.getBoundingClientRect();
          if (rect.bottom >= curTopBound && rect.top <= curBottomBound) {
            scrollSession.readyBlocks.add(b);
          } else {
            scrollSession.readyBlocks.delete(b);
          }
        } catch {}
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
            if (node.matches && node.matches(BLOCK_SELECTOR)) {
              scrollSession.mainObserver?.observe(node);
              hasNew = true;
            }
            if (node.querySelectorAll) {
              const sub = node.querySelectorAll(BLOCK_SELECTOR);
              for (const s of sub) {
                scrollSession.mainObserver?.observe(s);
                hasNew = true;
              }
            }
          }
        }
      }
      if (hasNew) scheduleScrollFlush();
    });

    scrollSession.mutationObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // Flush immediately (no debounce wait): observers are attached, so this
    // only ever sends each node once thanks to the pendingSet guard.
    flushReadyBlocks();
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
    scrollSession.readyBlocks.clear();
    scrollSession.active = false;
    scrollSession.watching = false;
    scrollSession.inFlight = 0;
    updateFabBusy();

    if (updateStatus) {
      lastTranslateStatus.watching = false;
    }
  }

  // ============================================================================
  // Floating Widget (Shadow DOM in content.js)
  // ============================================================================
  function initFloatingWidget() {
    // Only inject on HTTP(S) pages
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (document.getElementById('__wmt-widget-host')) return;

    const host = document.createElement('div');
    host.id = '__wmt-widget-host';
    host.setAttribute('data-wmt-ignore', 'true');
    host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;line-height:normal;';

    // Attach closed Shadow DOM
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        color: #f4f4f5;
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      .wmt-btn {
        width: 44px;
        height: 44px;
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
        top: 2px;
        right: 2px;
        width: 10px;
        height: 10px;
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
        bottom: 54px;
        right: 0;
        width: 280px;
        background: #121318;
        border-radius: 12px;
        box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
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
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 8px;
      }
      .wmt-title {
        font-weight: 600;
        font-size: 14px;
        color: #f4f4f5;
      }
      .wmt-close {
        background: transparent;
        border: none;
        color: #71717a;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
      }
      .wmt-close:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.09);
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
        background: rgba(255, 255, 255, 0.06);
        color: #a1a1aa;
      }
      .wmt-status-tag.on {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
      }
      .wmt-switch-btn {
        width: 100%;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.04);
        color: #a1a1aa;
        transition: background 0.15s;
      }
      .wmt-switch-btn:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #ffffff;
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
        background: rgba(255, 255, 255, 0.03);
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.06);
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
        background: rgba(255, 255, 255, 0.04);
        color: #a1a1aa;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .wmt-btn-secondary:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #ffffff;
      }
      .wmt-progress {
        font-size: 11px;
        color: #38bdf8;
        text-align: center;
        line-height: 1.3;
      }
      .wmt-hint {
        font-size: 11px;
        color: #71717a;
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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
          <button class="wmt-close" id="wmt-close" aria-label="Đóng panel">✕</button>
        </div>
        <div class="wmt-row">
          <span>Trạng thái:</span>
          <span class="wmt-status-tag" id="wmt-status-tag">Đang tắt</span>
        </div>
        <button class="wmt-switch-btn" id="wmt-toggle-tab">Bật dịch tab này</button>
        <div class="wmt-mode-group">
          <label class="wmt-mode-label">
            <input type="radio" name="wmt-mode" value="scroll-follow" checked />
            Dịch đuổi theo scroll
          </label>
          <label class="wmt-mode-label">
            <input type="radio" name="wmt-mode" value="full" />
            Dịch toàn trang
          </label>
        </div>
        <div class="wmt-actions">
          <button class="wmt-action-btn wmt-btn-primary" id="wmt-action-translate">Dịch ngay</button>
          <button class="wmt-action-btn wmt-btn-secondary" id="wmt-action-restore">Khôi phục</button>
        </div>
        <div id="wmt-progress" class="wmt-progress" style="display:none;"></div>
        <div id="wmt-warn-msg" class="wmt-warning" style="display:none;"></div>
        <div class="wmt-hint">Mở popup để cấu hình key/quyền/model</div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(container);

    fabBusySetter = (busy) => {
      const f = container.querySelector('#wmt-fab');
      const b = container.querySelector('#wmt-badge');
      if (f) f.classList.toggle('busy', busy);
      if (b) b.classList.toggle('busy', busy);
    };

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
      let text = collected > 0 ? `Đang dịch ${applied}/${collected} nodes...` : 'Đang dịch...';
      if (failed > 0) text += ` (${failed} lỗi)`;
      if (st.lastError && st.lastError.code) text += ` [${st.lastError.code}]`;
      progressEl.textContent = text;
      progressEl.style.display = 'block';
    }
    setInterval(refreshWidgetProgress, 800);

    let isPanelOpen = false;
    let widgetState = {
      effective: 'off',
      siteEnabled: false,
      tabOverride: null,
      permission: true,
      mode: 'scroll-follow',
      widgetVisible: true,
      position: null,
      hasKey: true
    };

    function setPanelVisibility(open) {
      isPanelOpen = open;
      panel.style.display = isPanelOpen ? 'flex' : 'none';
    }

    function applyState(st) {
      if (!st) return;
      widgetState = { ...widgetState, ...st };

      // Effective Consent
      const isEffectiveOn = widgetState.effective === 'on';
      if (!isEffectiveOn) {
        if (autoStartTimer) {
          clearTimeout(autoStartTimer);
          autoStartTimer = null;
        }
        if (scrollSession.watching) {
          stopScrollFollowSession(true);
        }
      }

      // Visibility
      if (widgetState.widgetVisible === false) {
        host.style.display = 'none';
        return;
      }
      host.style.display = 'block';

      badge.classList.toggle('active', isEffectiveOn);
      statusTag.textContent = isEffectiveOn ? 'Đang bật' : 'Đang tắt';
      statusTag.classList.toggle('on', isEffectiveOn);

      toggleTabBtn.textContent = isEffectiveOn ? 'Tắt dịch tab này' : 'Bật dịch tab này';
      toggleTabBtn.classList.toggle('active', isEffectiveOn);

      // Mode
      const activeMode = widgetState.mode || 'scroll-follow';
      currentMode = activeMode;
      modeRadios.forEach((r) => {
        r.checked = r.value === activeMode;
      });

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
        warnMsg.textContent = 'Thiếu quyền host! Mở popup để cấp quyền.';
        warnMsg.style.display = 'block';
      } else if (!widgetState.hasKey) {
        warnMsg.textContent = 'Chưa cấu hình API key! Mở popup để nhập key.';
        warnMsg.style.display = 'block';
      } else {
        warnMsg.style.display = 'none';
      }
    }

    function checkAutoStart(st) {
      if (autoStartAttempted) return;
      autoStartAttempted = true;

      if (!st || !st.autoStart || userRestored) return;
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

      const targetMode = st.mode || 'scroll-follow';
      autoStartTimer = setTimeout(() => {
        autoStartTimer = null;
        if (userRestored) return;
        if (isTranslating || scrollSession.watching) return;

        currentMode = targetMode;
        lastTranslateStatus.mode = targetMode;

        if (targetMode === 'scroll-follow') {
          startScrollFollowSession(st);
        } else {
          executeTranslation(st);
        }
      }, AUTO_SETTLE_MS);
    }

    function queryState() {
      chrome.runtime.sendMessage({ action: 'WIDGET_GET_STATE' }, (resp) => {
        if (!chrome.runtime.lastError && resp && !resp.error) {
          applyState(resp);
          checkAutoStart(resp);
        }
      });
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
        chrome.runtime.sendMessage({
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
        chrome.runtime.sendMessage({
          action: 'WIDGET_SET_POSITION',
          x: Math.round(rect.left),
          y: Math.round(rect.top)
        });
      }
    });

    closeBtn.addEventListener('click', () => setPanelVisibility(false));

    // Tab ON/OFF toggle: sends WIDGET_SET_ENABLED
    toggleTabBtn.addEventListener('click', () => {
      const targetEnabled = widgetState.effective !== 'on';
      chrome.runtime.sendMessage({
        action: 'WIDGET_SET_ENABLED',
        enabled: targetEnabled
      }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.error) {
          if (resp.error.code === 'PERMISSION_REQUIRED') {
            warnMsg.textContent = 'Cần cấp quyền host! Hãy mở popup để cấp quyền.';
            warnMsg.style.display = 'block';
          }
          return;
        }
        applyState(resp);
        if (!targetEnabled) {
          // Turning OFF stops session & cancels queue; does not auto-restore text
          stopScrollFollowSession(true);
          try {
            chrome.runtime.sendMessage({ action: 'CANCEL_PENDING', epoch }, () => {
              if (chrome.runtime.lastError) {}
            });
          } catch {}
        }
      });
    });

    // Mode Selector: sends WIDGET_SET_MODE
    modeRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked) {
          const selectedMode = r.value;
          chrome.runtime.sendMessage({
            action: 'WIDGET_SET_MODE',
            mode: selectedMode
          }, (resp) => {
            if (!chrome.runtime.lastError && resp && !resp.error) {
              currentMode = selectedMode;
              lastTranslateStatus.mode = selectedMode;
              if (selectedMode === 'scroll-follow' && widgetState.effective === 'on') {
                startScrollFollowSession();
              } else if (selectedMode === 'full') {
                stopScrollFollowSession(true);
              }
            }
          });
        }
      });
    });

    // Translate Now Button
    translateBtn.addEventListener('click', () => {
      setPanelVisibility(false);
      if (currentMode === 'scroll-follow') {
        startScrollFollowSession(widgetState);
      } else {
        executeTranslation(widgetState);
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

    // Listen for push notifications
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.action === 'WIDGET_STATE_CHANGED') {
        applyState(msg);
      }
    });
  }

  // ============================================================================
  // Runtime Message Handler for Popup, SW & Tests
  // ============================================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    if (message.action === 'CONTENT_START_TRANSLATION') {
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
        executeTranslation(message.settings || {}).then(sendResponse);
        return true; // async
      }
    }

    if (message.action === 'CONTENT_SET_MODE') {
      const targetMode = message.mode;
      if (targetMode === 'scroll-follow' || targetMode === 'full') {
        epoch++;
        try {
          chrome.runtime.sendMessage({ action: 'CANCEL_PENDING', epoch }, () => {
            if (chrome.runtime.lastError) {}
          });
        } catch {}
        stopScrollFollowSession(false);
        isTranslating = false;
        activeRunToken++;
        pendingSet.clear();
        currentMode = targetMode;
        lastTranslateStatus.mode = targetMode;

        if (targetMode === 'scroll-follow') {
          chrome.runtime.sendMessage({ action: 'WIDGET_GET_STATE' }, (st) => {
            if (!chrome.runtime.lastError && st && st.effective === 'on') {
              startScrollFollowSession(st);
            }
          });
        } else if (targetMode === 'full') {
          chrome.runtime.sendMessage({ action: 'WIDGET_GET_STATE' }, (st) => {
            if (!chrome.runtime.lastError && st && st.effective === 'on') {
              executeTranslation(st);
            }
          });
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
        if (scrollSession.collectedIds) scrollSession.collectedIds.add(rec.id);
        else lastTranslateStatus.totalCollected++;
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
          fallbackIndex: lastTranslateStatus.fallbackIndex || 0
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
      restorable: restoreKept.size
    }),
    _getWidgetHost: () => document.getElementById('__wmt-widget-host'),
    documentId,
    getEpoch: () => epoch,
    setEpoch: (n) => { epoch = n; },
    startScrollFollowSession,
    stopScrollFollowSession
  };

  // Fire-and-forget CANCEL_PENDING on navigation / page hide
  window.addEventListener('pagehide', () => {
    try {
      epoch++;
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({ action: 'CANCEL_PENDING', epoch, reason: 'pagehide' }, () => {
          if (chrome.runtime?.lastError) { /* ignore */ }
        });
      }
    } catch {}
  });

  // bfcache restore: re-sync epoch so stale in-flight work cannot patch us
  window.addEventListener('pageshow', (e) => {
    try {
      if (e && e.persisted) {
        epoch++;
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
          chrome.runtime.sendMessage({ action: 'CANCEL_PENDING', epoch }, () => {
            if (chrome.runtime?.lastError) { /* ignore */ }
          });
        }
      }
    } catch {}
  });

  // Initialize floating widget
  if (document.documentElement) {
    initFloatingWidget();
  } else {
    document.addEventListener('DOMContentLoaded', initFloatingWidget);
  }
})();
