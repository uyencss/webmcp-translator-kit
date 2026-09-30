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

  function get(key, customNow) {
    const entry = entries.get(key);
    if (!entry) return undefined;

    const currentTime = typeof customNow === 'number' ? customNow : now();
    // Boundary: now - createdAt >= ttlMs indicates expired
    if (currentTime - entry.createdAt >= ttlMs) {
      entries.delete(key);
      currentBytes = Math.max(0, currentBytes - entry.size);
      return undefined;
    }

    // Refresh recency on cache hit
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value, customNow) {
    const currentTime = typeof customNow === 'number' ? customNow : now();
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
