// WebMCP Translator Kit — Cache Unit Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTranslationCache,
  cacheKey,
  hashText,
  countUtf8Bytes,
  normalizeSourceText,
  PROMPT_VERSION
} from '../extension/src/cache.mjs';

test('countUtf8Bytes: accurate UTF-8 bytes count', () => {
  assert.equal(countUtf8Bytes(''), 0);
  assert.equal(countUtf8Bytes('hello'), 5);
  // Vietnamese accented characters (UTF-8 multi-byte: 'ế' is 3 bytes, 'ệ' is 3 bytes -> total 14)
  assert.equal(countUtf8Bytes('Tiếng Việt'), 14);
  // Emoji (4 bytes in UTF-8)
  assert.equal(countUtf8Bytes('🚀'), 4);
  assert.equal(countUtf8Bytes(null), 0);
  assert.equal(countUtf8Bytes(undefined), 0);
});

test('hashText: deterministic non-crypto hash', () => {
  const h1 = hashText('Hello world');
  const h2 = hashText('Hello world');
  const h3 = hashText('Different text');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(typeof h1, 'string');
  assert.equal(h1.length, 8);
});

test('cacheKey: key sensitivity to parameters', () => {
  const baseCtx = {
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    promptVersion: 'v1'
  };

  const key1 = cacheKey({ text: 'Hello' }, baseCtx);

  // Same context produces identical key
  const keySame = cacheKey({ text: 'Hello' }, baseCtx);
  assert.equal(key1, keySame);

  // String input directly
  const keyStr = cacheKey('Hello', baseCtx);
  assert.equal(key1, keyStr);

  // Change model -> miss
  const keyDiffModel = cacheKey('Hello', { ...baseCtx, model: 'ag/gemini-3.1-pro-low' });
  assert.notEqual(key1, keyDiffModel);

  // Change baseURL -> miss
  const keyDiffBase = cacheKey('Hello', { ...baseCtx, baseURL: 'https://proxy.example.com' });
  assert.notEqual(key1, keyDiffBase);

  // Change source language -> miss
  const keyDiffSrc = cacheKey('Hello', { ...baseCtx, sourceLanguage: 'en' });
  assert.notEqual(key1, keyDiffSrc);

  // Change target language -> miss
  const keyDiffTgt = cacheKey('Hello', { ...baseCtx, targetLanguage: 'ja' });
  assert.notEqual(key1, keyDiffTgt);

  // Change prompt version -> miss
  const keyDiffVer = cacheKey('Hello', { ...baseCtx, promptVersion: 'v2' });
  assert.notEqual(key1, keyDiffVer);

  // Change text -> miss
  const keyDiffText = cacheKey('Goodbye', baseCtx);
  assert.notEqual(key1, keyDiffText);
});

test('cache: get/set basic operations', () => {
  const cache = createTranslationCache({ ttlMs: 600000, maxEntries: 10, maxSizeBytes: 10000 });
  assert.equal(cache.get('k1'), undefined);

  const ok = cache.set('k1', 'xin chào', 1000);
  assert.equal(ok, true);
  assert.equal(cache.get('k1', 1500), 'xin chào');
  assert.equal(cache.size().entries, 1);
  assert.equal(cache.size().bytes, countUtf8Bytes('xin chào'));
});

test('cache: TTL expiration boundary (now injectable)', () => {
  const ttlMs = 600000; // 10 minutes
  const cache = createTranslationCache({ ttlMs, maxEntries: 10, maxSizeBytes: 10000 });

  const t0 = 100000;
  cache.set('k1', 'val1', t0);

  // Just before expiry (boundary < ttlMs) -> hit
  assert.equal(cache.get('k1', t0 + ttlMs - 1), 'val1');

  // Exact boundary (now - createdAt >= ttlMs) -> expired (miss + deleted)
  assert.equal(cache.get('k1', t0 + ttlMs), undefined);

  // Ensure expired entry is purged from size
  assert.equal(cache.size().entries, 0);
  assert.equal(cache.size().bytes, 0);
  assert.equal(cache.get('k1', t0 + ttlMs + 5000), undefined);
});

test('cache: LRU eviction by maxEntries', () => {
  const cache = createTranslationCache({ ttlMs: 600000, maxEntries: 3, maxSizeBytes: 10000 });

  cache.set('k1', 'val1', 1000);
  cache.set('k2', 'val2', 1001);
  cache.set('k3', 'val3', 1002);
  assert.equal(cache.size().entries, 3);

  // Access k1 -> refreshes recency (order becomes: k2 [oldest], k3, k1 [newest])
  assert.equal(cache.get('k1', 1003), 'val1');

  // Insert k4 -> should evict k2 (least recently used)
  cache.set('k4', 'val4', 1004);
  assert.equal(cache.size().entries, 3);
  assert.equal(cache.get('k2', 1005), undefined, 'k2 should have been evicted');
  assert.equal(cache.get('k1', 1005), 'val1', 'k1 should still exist');
  assert.equal(cache.get('k3', 1005), 'val3', 'k3 should still exist');
  assert.equal(cache.get('k4', 1005), 'val4', 'k4 should still exist');
});

test('cache: LRU eviction by maxSizeBytes (oldest evicted != largest entry)', () => {
  // Budget: 250 bytes
  const maxSizeBytes = 250;
  const cache = createTranslationCache({ ttlMs: 600000, maxEntries: 100, maxSizeBytes });

  // Entry 1 (oldest): 50 bytes
  const text1 = 'A'.repeat(50);
  cache.set('k1', text1, 1000);

  // Entry 2 (middle, largest): 150 bytes
  const text2 = 'B'.repeat(150);
  cache.set('k2', text2, 1001);

  // Entry 3 (newest): 50 bytes
  const text3 = 'C'.repeat(50);
  cache.set('k3', text3, 1002);

  // Current total: 50 + 150 + 50 = 250 bytes (exact full capacity)
  assert.equal(cache.size().entries, 3);
  assert.equal(cache.size().bytes, 250);

  // Insert Entry 4: 30 bytes
  // Exceeds 250 bytes. Eviction must remove k1 (oldest, 50 bytes), NOT k2 (largest, 150 bytes)!
  const text4 = 'D'.repeat(30);
  cache.set('k4', text4, 1003);

  // k1 was oldest -> evicted
  assert.equal(cache.get('k1', 1004), undefined, 'Oldest entry k1 must be evicted');
  // k2 (largest) is retained!
  assert.equal(cache.get('k2', 1004), text2, 'Largest entry k2 must NOT be evicted before older entries');
  assert.equal(cache.get('k3', 1004), text3, 'k3 must be retained');
  assert.equal(cache.get('k4', 1004), text4, 'k4 must be retained');

  // Final size: 150 + 50 + 30 = 230 bytes <= 250 bytes
  assert.equal(cache.size().entries, 3);
  assert.equal(cache.size().bytes, 230);
});

test('cache: oversized single entry (> maxSizeBytes) is ignored without crash', () => {
  const maxSizeBytes = 100;
  let fakeNow = 1000;
  const cache = createTranslationCache({ ttlMs: 600000, maxEntries: 10, maxSizeBytes, now: () => fakeNow });

  cache.set('k1', 'small');
  assert.equal(cache.size().entries, 1);

  // Entry exceeding maxSizeBytes alone (150 bytes > 100 bytes)
  const hugeText = 'X'.repeat(150);
  const result = cache.set('k_huge', hugeText);
  assert.equal(result, false, 'Oversized entry must return false');

  // Verify it was not added and existing entry was untouched
  assert.equal(cache.get('k_huge'), undefined);
  assert.equal(cache.get('k1'), 'small');
  assert.equal(cache.size().entries, 1);
  assert.equal(cache.size().bytes, countUtf8Bytes('small'));
});

test('cache: clear resets all entries and byte count', () => {
  const cache = createTranslationCache({ ttlMs: 600000, maxEntries: 10, maxSizeBytes: 10000 });
  cache.set('k1', 'val1');
  cache.set('k2', 'val2');
  assert.equal(cache.size().entries, 2);
  assert.ok(cache.size().bytes > 0);

  cache.clear();
  assert.equal(cache.size().entries, 0);
  assert.equal(cache.size().bytes, 0);
  assert.equal(cache.get('k1'), undefined);
  assert.equal(cache.get('k2'), undefined);
});

test('M1: 32-bit FNV-1a cache collision prevention with source verification', () => {
  // Offline discovered collision pair for FNV-1a 32-bit:
  // hashText('vr5c7lrg9g') === '3065017d'
  // hashText('4nqmqum3fx') === '3065017d'
  const textA = 'vr5c7lrg9g';
  const textB = '4nqmqum3fx';

  assert.equal(hashText(textA), '3065017d');
  assert.equal(hashText(textB), '3065017d');
  assert.notEqual(textA, textB, 'Precondition: textA and textB must be distinct strings');

  const ctx = {
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    promptVersion: PROMPT_VERSION
  };

  const keyA = cacheKey(textA, ctx);
  const keyB = cacheKey(textB, ctx);
  assert.equal(keyA, keyB, 'Precondition: keyA and keyB collide to identical cache key');

  const cache = createTranslationCache({ ttlMs: 600000 });

  // 1. Set translation for textA
  const okA = cache.set(keyA, '[vi] Bản dịch A', textA);
  assert.equal(okA, true);

  // 2. Query cache for textB using colliding key -> must MISS (not return translation of A)
  const hitB = cache.get(keyB, textB);
  assert.equal(hitB, undefined, 'Cache get for colliding textB must be a miss due to source mismatch');

  // 3. Query cache for textA -> must HIT
  const hitA = cache.get(keyA, textA);
  assert.equal(hitA, '[vi] Bản dịch A', 'Cache get for original textA must hit');

  // 4. Overwrite entry with translation for textB
  const okB = cache.set(keyB, '[vi] Bản dịch B', textB);
  assert.equal(okB, true);

  // 5. Query for textB -> must HIT with textB translation
  const hitBAfter = cache.get(keyB, textB);
  assert.equal(hitBAfter, '[vi] Bản dịch B', 'Cache get for textB after overwrite must return textB translation');

  // 6. Query for textA -> must now MISS
  const hitAAfter = cache.get(keyA, textA);
  assert.equal(hitAAfter, undefined, 'Cache get for textA after overwrite must miss');
});

