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
        if (!res.error.logged) {
          try {
            if (chrome?.runtime?.sendMessage) {
              chrome.runtime.sendMessage({
                action: 'RECORD_ERROR_LOG',
                error: res.error,
                model: scrollModel,
                isTerminal: Boolean(res.fatal)
              }).catch(() => {});
            }
          } catch {}
          if (typeof res.error === 'object' && res.error) {
            res.error.logged = true;
          }
        }
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