// WebMCP Translator Kit — Content Script (DOM Scanner & Patcher)
// Top Frame only, ISOLATED World

(function () {
  if (window !== window.top) return;
  if (window.__webMcpTranslatorInjected) return;
  window.__webMcpTranslatorInjected = true;

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1
  };
  const PATCH_MIN_INTERVAL_MS = 200;
  const PATCH_GROUP_SIZE = 64;
  const MAX_BATCH_ITEMS = 64;
  const MAX_BATCH_BYTES = 24576; // 24 KiB
  const throttle = { maxConcurrentRequests: 2 };

  const documentId = 'doc_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
  let epoch = 0;
  let idCounter = 1;

  const nodeToRec = new WeakMap();
  const idToRec = new Map();
  const restoreKept = new Map();

  let isTranslating = false;
  let lastTranslateStatus = {
    state: 'idle',
    totalCollected: 0,
    totalApplied: 0,
    totalFailed: 0,
    totalRestored: 0,
    chunksTotal: 0,
    chunksDone: 0,
    bytesTotal: 0,
    error: null,
    model: null,
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

  function restore() {
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
    return { restored, skipped };
  }

  // Count UTF-8 bytes
  function countUtf8Bytes(str) {
    return new TextEncoder().encode(str).length;
  }

  // Chunk items to respect limits: <= 64 items and <= 24 KiB UTF-8
  function chunkItems(items) {
    const chunks = [];
    let currentChunk = [];
    let currentBytes = 0;

    for (const it of items) {
      const itBytes = countUtf8Bytes(it.text);
      if (currentChunk.length >= MAX_BATCH_ITEMS || (currentBytes + itBytes > MAX_BATCH_BYTES && currentChunk.length > 0)) {
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
            resolve({ error: { code: 'NETWORK', message: chrome.runtime.lastError.message } });
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  // Chunk-level recovery: retry 1 time, binary split if depth < 2 && items.length > 8
  async function translateChunkWithRecovery(items, settings = {}, depth = 0, targetEpoch = epoch) {
    if (targetEpoch !== undefined && epoch !== targetEpoch) {
      return { cancelled: true, applied: 0, failed: 0 };
    }
    if (!items || items.length === 0) {
      return { applied: 0, failed: 0 };
    }

    const NON_RETRYABLE_CODES = new Set([
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
      'MODEL_NOT_ALLOWED'
    ]);

    function isNonRetryable(err) {
      if (!err) return false;
      if (NON_RETRYABLE_CODES.has(err.code)) return true;
      if (err.retryable === false && err.code !== 'TIMEOUT') return true;
      return false;
    }

    // 1. Initial sendChunk
    let resp = await sendChunk(items, settings, targetEpoch);
    if (targetEpoch !== undefined && epoch !== targetEpoch) {
      return { cancelled: true, applied: 0, failed: 0 };
    }

    if (resp && resp.error && isNonRetryable(resp.error)) {
      if (resp.error.code === 'RATE_LIMITED') {
        const retrySec = Math.ceil((resp.error.details?.retryAfterMs || 0) / 1000);
        console.warn(`[WebMCP Translator] Quota exceeded (${resp.error.details?.scope || 'tab'}): retry after ${retrySec}s`);
      }
      return { applied: 0, failed: items.length, error: resp.error, fatal: true };
    }

    if (resp && Array.isArray(resp.results)) {
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

    if (resp && Array.isArray(resp.results)) {
      const patchResult = await applyBatchThrottled(resp.results, targetEpoch);
      return { applied: patchResult.applied, failed: 0 };
    }

    // 3. If still failing, depth < 2 and items.length > 8: binary split & recurse sequentially
    if (depth < 2 && items.length > 8) {
      const mid = Math.ceil(items.length / 2);
      const leftItems = items.slice(0, mid);
      const rightItems = items.slice(mid);

      const leftRes = await translateChunkWithRecovery(leftItems, settings, depth + 1, targetEpoch);
      if (leftRes.cancelled) {
        return leftRes;
      }

      const rightRes = await translateChunkWithRecovery(rightItems, settings, depth + 1, targetEpoch);
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

  // Full page translate execution
  async function executeTranslation(settings = {}) {
    if (isTranslating) return { alreadyRunning: true };
    isTranslating = true;
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
        totalCollected: items.length,
        totalApplied: 0,
        totalFailed: 0,
        totalRestored: 0,
        chunksTotal: chunks.length,
        chunksDone: 0,
        bytesTotal,
        error: null,
        model: targetModel,
        elapsedMs: 0
      };

      if (items.length === 0) {
        const elapsedMs = Date.now() - startTime;
        isTranslating = false;
        lastTranslateStatus.state = 'done';
        lastTranslateStatus.elapsedMs = elapsedMs;
        return { ok: true, collected: 0, applied: 0, failed: 0, model: targetModel, elapsedMs };
      }

      let nextIndex = 0;
      let totalApplied = 0;
      let totalFailed = 0;
      let chunksDone = 0;
      let lastError = null;

      async function worker() {
        while (nextIndex < chunks.length) {
          if (epoch !== currentEpoch) break;
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
            currentEpoch
          );

          if (epoch !== currentEpoch) break;

          totalApplied += chunkRes.applied || 0;
          totalFailed += chunkRes.failed || 0;
          if (chunkRes.error) {
            lastError = chunkRes.error;
          }

          chunksDone++;
          lastTranslateStatus.totalApplied = totalApplied;
          lastTranslateStatus.totalFailed = totalFailed;
          lastTranslateStatus.chunksDone = chunksDone;

          if (chunkRes.fatal) {
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

      if (epoch !== currentEpoch) {
        return { cancelled: true };
      }

      const elapsedMs = Date.now() - startTime;
      lastTranslateStatus.elapsedMs = elapsedMs;
      lastTranslateStatus.chunksDone = chunksDone;
      lastTranslateStatus.totalApplied = totalApplied;
      lastTranslateStatus.totalFailed = totalFailed;
      lastTranslateStatus.model = targetModel;

      // Chỉ khi applied === 0 && failed > 0 mới trả về dạng lỗi để popup hiện lỗi
      if (totalApplied === 0 && totalFailed > 0) {
        lastTranslateStatus.state = 'error';
        lastTranslateStatus.error = lastError || { code: 'CHUNK_FAILED', message: 'Tất cả các chunk đều thất bại' };
        isTranslating = false;
        return {
          error: lastTranslateStatus.error,
          applied: 0,
          failed: totalFailed,
          model: targetModel,
          elapsedMs
        };
      }

      lastTranslateStatus.state = 'done';
      lastTranslateStatus.error = null;
      isTranslating = false;
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
        isTranslating = false;
        const elapsedMs = Date.now() - startTime;
        lastTranslateStatus.state = 'error';
        lastTranslateStatus.error = { code: 'INTERNAL', message: err && err.message ? String(err.message) : 'Translation failed' };
        lastTranslateStatus.model = targetModel;
        lastTranslateStatus.elapsedMs = elapsedMs;
        return { error: lastTranslateStatus.error, applied: 0, failed: 0, model: targetModel, elapsedMs };
      }
      return { cancelled: true };
    }
  }

  // Runtime message handler for Popup & Tests
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    if (message.action === 'CONTENT_START_TRANSLATION') {
      executeTranslation(message.settings || {}).then(sendResponse);
      return true; // async
    }

    if (message.action === 'CONTENT_RESTORE') {
      const res = restore();
      lastTranslateStatus.state = 'restored';
      lastTranslateStatus.totalRestored = res.restored;
      sendResponse({ ok: true, ...res });
      return false;
    }

    if (message.action === 'CONTENT_GET_STATUS') {
      sendResponse({
        ok: true,
        status: lastTranslateStatus,
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
    getStatus: () => ({ ...lastTranslateStatus, restorable: restoreKept.size }),
    documentId,
    getEpoch: () => epoch,
    setEpoch: (n) => { epoch = n; }
  };
})();
