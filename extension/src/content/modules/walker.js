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