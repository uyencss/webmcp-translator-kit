// WebMCP Translator Kit — In-Memory LRU Translation Cache
// Contract Version: webmcp-translator-contract/1
// Pure module: No chrome.* APIs used.

export const PROMPT_VERSION = 'v1';

export function countUtf8Bytes(str) {
  if (typeof str !== 'string') return 0;
  return new TextEncoder().encode(str).length;
}

export function normalizeSourceText(str) {
  return String(str ?? '').normalize('NFC');
}

// 32-bit FNV-1a non-cryptographic hash
export function hashText(str) {
  let hash = 2166136261 >>> 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function cacheKey(item, ctx = {}) {
  const rawText = typeof item === 'string' ? item : (item?.text ?? '');
  const normText = normalizeSourceText(rawText);
  const textHash = hashText(normText);
  const srcLang = (ctx.sourceLanguage || 'auto').trim().toLowerCase();
  const tgtLang = (ctx.targetLanguage || 'vi').trim().toLowerCase();
  const baseURL = (ctx.baseURL || '').trim().replace(/\/+$/, '');
  const model = (ctx.model || '').trim();
  const promptVersion = ctx.promptVersion || PROMPT_VERSION;
  return `${textHash}:${srcLang}:${tgtLang}:${baseURL}:${model}:${promptVersion}`;
}

export function createTranslationCache({
  ttlMs = 600000,
  maxEntries = 500,
  maxSizeBytes = 2097152,
  now = Date.now
} = {}) {
  // Map maintains insertion order: first key is LRU (oldest), last is MRU (newest)
  const entries = new Map();
  let currentBytes = 0;

  function getEntrySize(val) {
    if (typeof val === 'string') {
      return countUtf8Bytes(val);
    }
    if (val && typeof val.text === 'string') {
      return countUtf8Bytes(val.text);
    }
    return countUtf8Bytes(JSON.stringify(val ?? ''));
  }

  function get(key, sourceOrCustomNow, customNow) {
    const entry = entries.get(key);
    if (!entry) return undefined;

    let source = undefined;
    let currentTime = now();
    if (typeof sourceOrCustomNow === 'number') {
      currentTime = sourceOrCustomNow;
    } else if (typeof sourceOrCustomNow === 'string') {
      source = normalizeSourceText(sourceOrCustomNow);
      if (typeof customNow === 'number') {
        currentTime = customNow;
      }
    }

    // Boundary: now - createdAt >= ttlMs indicates expired
    if (currentTime - entry.createdAt >= ttlMs) {
      entries.delete(key);
      currentBytes = Math.max(0, currentBytes - entry.size);
      return undefined;
    }

    // 32-bit hash collision verification: if source is provided, entry.source must match
    if (source !== undefined && entry.source !== undefined && entry.source !== source) {
      return undefined;
    }

    // Refresh recency on cache hit
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, sourceOrCustomNow, customNow) {
    let source = undefined;
    let currentTime = now();
    if (typeof sourceOrCustomNow === 'number') {
      currentTime = sourceOrCustomNow;
    } else if (typeof sourceOrCustomNow === 'string') {
      source = normalizeSourceText(sourceOrCustomNow);
      if (typeof customNow === 'number') {
        currentTime = customNow;
      }
    }
    const entrySize = getEntrySize(value);

    // If a single entry exceeds the entire byte budget, do not cache (skip without crash)
    if (entrySize > maxSizeBytes) {
      return false;
    }

    // If key already exists, remove old entry and deduct its size
    if (entries.has(key)) {
      const existing = entries.get(key);
      currentBytes = Math.max(0, currentBytes - existing.size);
      entries.delete(key);
    }

    // Evict LRU entries if capacity (entries or bytes) exceeded
    while (
      entries.size + 1 > maxEntries ||
      currentBytes + entrySize > maxSizeBytes
    ) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestEntry = entries.get(oldestKey);
      entries.delete(oldestKey);
      if (oldestEntry) {
        currentBytes = Math.max(0, currentBytes - oldestEntry.size);
      }
    }

    entries.set(key, {
      value,
      source,
      size: entrySize,
      createdAt: currentTime
    });
    currentBytes += entrySize;
    return true;
  }

  function size() {
    const numEntries = entries.size;
    const numBytes = currentBytes;
    return {
      entries: numEntries,
      bytes: numBytes,
      valueOf() {
        return numEntries;
      },
      [Symbol.toPrimitive](hint) {
        if (hint === 'number') return numEntries;
        return `[Cache entries=${numEntries} bytes=${numBytes}]`;
      }
    };
  }

  function clear() {
    entries.clear();
    currentBytes = 0;
  }

  return {
    get,
    set,
    size,
    clear
  };
}

export const L2_CACHE_KEY = 'trCache';
export const L2_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (604,800,000 ms)
export const L2_MAX_SIZE_BYTES = 2.5 * 1024 * 1024; // 2.5 MiB (2,621,440 bytes)

/**
 * Prunes expired entries and applies LRU eviction (by savedAt) to keep trCache within maxSizeBytes.
 * Mutates trCache in-place.
 *
 * @param {Record<string, { text: string, savedAt: number }>} trCache
 * @param {number} [incomingBytes=0]
 * @param {{ ttlMs?: number, maxSizeBytes?: number, now?: () => number }} [options]
 * @returns {boolean} true if within budget, false if incoming exceeds max budget
 */
export function pruneL2Cache(trCache, incomingBytes = 0, {
  ttlMs = L2_CACHE_TTL_MS,
  maxSizeBytes = L2_MAX_SIZE_BYTES,
  now = Date.now
} = {}) {
  if (!trCache || typeof trCache !== 'object') return false;
  if (incomingBytes > maxSizeBytes) return false;

  const currentTime = typeof now === 'function' ? now() : (typeof now === 'number' ? now : Date.now());

  // 1. Evict expired entries
  for (const key of Object.keys(trCache)) {
    const entry = trCache[key];
    if (!entry || typeof entry.savedAt !== 'number' || currentTime - entry.savedAt >= ttlMs) {
      delete trCache[key];
    }
  }

  // 2. Measure UTF-8 bytes and evict LRU if needed
  let curBytes = countUtf8Bytes(JSON.stringify(trCache));
  if (curBytes + incomingBytes <= maxSizeBytes) {
    return true;
  }

  // Sort keys by savedAt ascending (oldest first)
  const sortedKeys = Object.keys(trCache).sort((a, b) => {
    const sa = trCache[a]?.savedAt || 0;
    const sb = trCache[b]?.savedAt || 0;
    return sa - sb;
  });

  for (const k of sortedKeys) {
    delete trCache[k];
    curBytes = countUtf8Bytes(JSON.stringify(trCache));
    if (curBytes + incomingBytes <= maxSizeBytes) {
      break;
    }
  }

  return true;
}

