// WebMCP Translator Kit — Background Module: Cache & Error Log
// Handles L2 storage cache synchronization, epoch counters, and session error logs

import {
  hashText,
  L2_CACHE_KEY,
  L2_CACHE_TTL_MS,
  L2_MAX_SIZE_BYTES,
  pruneL2Cache
} from '../../cache.mjs';

export const MAX_ERROR_LOG_ENTRIES = 50;
let errorLog = [];

export async function initErrorLog() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.local) {
        const resLocal = await chrome.storage.local.get(['errorLog']);
        if (Array.isArray(resLocal?.errorLog) && resLocal.errorLog.length > 0) {
          errorLog = resLocal.errorLog.slice(0, MAX_ERROR_LOG_ENTRIES);
          return;
        }
      }
      if (chrome.storage.session) {
        const res = await chrome.storage.session.get(['errorLog']);
        if (Array.isArray(res?.errorLog)) {
          errorLog = res.errorLog.slice(0, MAX_ERROR_LOG_ENTRIES);
        }
      }
    }
  } catch {}
}

export async function getErrorLog() {
  if (errorLog.length === 0) {
    await initErrorLog();
  }
  return [...errorLog];
}

export async function clearErrorLog() {
  errorLog = [];
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.session) {
        await chrome.storage.session.remove(['errorLog']);
      }
      if (chrome.storage.local) {
        await chrome.storage.local.remove(['errorLog']);
      }
    }
  } catch {}
  return { ok: true };
}

export async function recordErrorLog(err, { model = '', tabId = null, isTerminal = false } = {}) {
  if (!err) return null;
  if (err.logged) return null;
  if (typeof err === 'object') {
    err.logged = true;
  }
  const rawProviderMsg = typeof err.details?.providerMessage === 'string' ? err.details.providerMessage.trim() : '';
  const providerMsg = rawProviderMsg ? rawProviderMsg.slice(0, 200) : '';
  let msg = err.message || (typeof err === 'string' ? err : 'Unknown error');
  if (providerMsg && !msg.includes(providerMsg)) {
    msg = `${msg} (${providerMsg})`;
  }
  if (msg.length > 300) {
    msg = msg.slice(0, 297) + '...';
  }
  const entry = {
    time: new Date().toISOString(),
    code: err.code || err.name || 'ERROR',
    message: msg,
    model: model || err.model || '',
    tabId: tabId ?? null
  };
  errorLog.unshift(entry);
  if (errorLog.length > MAX_ERROR_LOG_ENTRIES) {
    errorLog = errorLog.slice(0, MAX_ERROR_LOG_ENTRIES);
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.session) {
        await chrome.storage.session.set({ errorLog });
      }
      if (chrome.storage.local) {
        await chrome.storage.local.set({ errorLog });
      }
    }
  } catch {}

  if (isTerminal) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'TRANSLATE_TERMINAL_ERROR',
          error: entry,
          tabId
        }).catch(() => {});
      }
    } catch {}
  }
  return entry;
}

// L2 Storage Mutex: serializes clearL2Cache and flushL2Cache to prevent race conditions
let pendingL2Writes = new Map();
let l2WriteTimer = null;
let isClearingL2 = false;
let clearingL2Count = 0;
let l2Epoch = 0;
let l2MemoryOnly = false;
let l2StorageChain = Promise.resolve();

function runInL2StorageChain(fn) {
  const next = l2StorageChain.then(fn, fn);
  l2StorageChain = next.catch(() => {});
  return next;
}

export function getL2Epoch() {
  return l2Epoch;
}

export function isL2MemoryOnly() {
  return l2MemoryOnly;
}

export function _setL2MemoryOnlyForTest(val) {
  l2MemoryOnly = Boolean(val);
}

export function isL2Clearing() {
  return isClearingL2;
}

export function enqueueL2Cache(key, text) {
  if (!key || typeof text !== 'string') return;
  if (isClearingL2 || l2MemoryOnly) return;
  const l2Key = /^[0-9a-f]{8}$/i.test(key) ? key : hashText(key);
  const entryEpoch = l2Epoch;
  pendingL2Writes.set(l2Key, { keyHash: hashText(key), text, savedAt: Date.now(), epoch: entryEpoch });
  if (l2WriteTimer) clearTimeout(l2WriteTimer);
  l2WriteTimer = setTimeout(() => {
    flushL2Cache().catch(() => {});
  }, 2000);
}

export function clearPendingL2Writes() {
  pendingL2Writes.clear();
  if (l2WriteTimer) {
    clearTimeout(l2WriteTimer);
    l2WriteTimer = null;
  }
}

export async function clearL2Cache() {
  l2Epoch++;
  if (l2WriteTimer) {
    clearTimeout(l2WriteTimer);
    l2WriteTimer = null;
  }
  pendingL2Writes.clear();
  clearingL2Count++;
  isClearingL2 = true;

  return runInL2StorageChain(async () => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        l2MemoryOnly = false;
        return;
      }

      let removeSucceeded = false;
      try {
        await chrome.storage.local.remove([L2_CACHE_KEY]);
        removeSucceeded = true;
      } catch (e1) {
        try {
          await chrome.storage.local.remove([L2_CACHE_KEY]);
          removeSucceeded = true;
        } catch (e2) {
          removeSucceeded = false;
        }
      }

      if (removeSucceeded) {
        l2MemoryOnly = false;
        return;
      }

      try {
        await chrome.storage.local.set({ [L2_CACHE_KEY]: {} });
        const verify = await chrome.storage.local.get([L2_CACHE_KEY]);
        const cacheObj = verify?.[L2_CACHE_KEY];
        const isClean = !cacheObj || (typeof cacheObj === 'object' && Object.keys(cacheObj).length === 0);
        if (isClean) {
          l2MemoryOnly = false;
        } else {
          l2MemoryOnly = true;
        }
      } catch (setErr) {
        l2MemoryOnly = true;
      }
    } catch (outerErr) {
      l2MemoryOnly = true;
    } finally {
      clearingL2Count = Math.max(0, clearingL2Count - 1);
      if (clearingL2Count === 0) {
        isClearingL2 = false;
      }
      pendingL2Writes.clear();
      if (l2WriteTimer) {
        clearTimeout(l2WriteTimer);
        l2WriteTimer = null;
      }
    }
  });
}

export async function flushL2Cache() {
  if (l2MemoryOnly || isClearingL2) return;
  const currentEpoch = l2Epoch;
  if (l2WriteTimer) {
    clearTimeout(l2WriteTimer);
    l2WriteTimer = null;
  }
  if (pendingL2Writes.size === 0) return;
  const toWrite = new Map(pendingL2Writes);
  pendingL2Writes.clear();

  return runInL2StorageChain(async () => {
    if (l2Epoch !== currentEpoch || l2MemoryOnly || isClearingL2) return;
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      const res = await chrome.storage.local.get([L2_CACHE_KEY]);
      if (l2Epoch !== currentEpoch || l2MemoryOnly || isClearingL2) return;
      const rawCache = (res && res[L2_CACHE_KEY] && typeof res[L2_CACHE_KEY] === 'object')
        ? res[L2_CACHE_KEY]
        : {};
      const trCache = {};
      for (const [k, v] of Object.entries(rawCache)) {
        if (v && typeof v === 'object' && typeof v.keyHash === 'string' && !('key' in v)) {
          trCache[k] = {
            keyHash: v.keyHash,
            text: v.text,
            savedAt: v.savedAt
          };
        }
      }
      for (const [k, v] of toWrite.entries()) {
        if (v && (v.epoch === undefined || v.epoch === currentEpoch)) {
          trCache[k] = {
            keyHash: v.keyHash,
            text: v.text,
            savedAt: v.savedAt
          };
        }
      }
      pruneL2Cache(trCache, 0, { ttlMs: L2_CACHE_TTL_MS, maxSizeBytes: L2_MAX_SIZE_BYTES });
      if (l2Epoch !== currentEpoch || l2MemoryOnly || isClearingL2) return;
      await chrome.storage.local.set({ [L2_CACHE_KEY]: trCache });
    } catch (e) {
      // Quota or storage write failures ignored silently per WI-15 spec
    }
  });
}

