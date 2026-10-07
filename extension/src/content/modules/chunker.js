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