// WebMCP Translator Kit — Model Discovery & Base URL Security Module
// Provides L2 cache-backed model listing, cryptographic key fingerprinting,
// and centralized HTTPS/loopback permission validation.

import { createTypedError } from './security.mjs';
import { isSecureOrLoopbackBaseURL, normalizeOrigin } from '../../consent.mjs';

export const MODEL_CACHE_FRESH_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MODEL_CACHE_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Hash full key + baseURL into SHA-256 hex string (zero key material stored)
export async function computeKeyFingerprint(key, baseURL) {
  if (!key) return '';
  const normBaseURL = String(baseURL || '').trim();
  const data = new TextEncoder().encode(`${key}::${normBaseURL}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Model Discovery (L2 storage.local cache with TTL & background revalidation)
// Fail-fast diagnostic: SW fetch to the provider needs its host permission.
// Without it the request dies as opaque "Failed to fetch" — surface the real
// cause instead. Skipped in test mode (harness bypasses the permission system).
export async function checkBaseUrlPermission({
  baseURL,
  testMode = false,
  permissionContains
}) {
  if (!isSecureOrLoopbackBaseURL(baseURL)) {
    return createTypedError(
      'INSECURE_ENDPOINT_BLOCKED',
      'Chỉ chấp nhận Base URL HTTPS hoặc loopback HTTP (localhost, 127.0.0.1) — không gửi dữ liệu qua HTTP từ xa',
      false,
      { reason: 'HTTPS_REQUIRED' }
    );
  }
  if (testMode) return null;
  const baseOrigin = baseURL ? normalizeOrigin(baseURL) : null;
  if (!baseOrigin) return null;
  let granted = false;
  try {
    if (typeof permissionContains === 'function') {
      granted = await permissionContains(baseOrigin);
    }
  } catch {
    granted = false;
  }
  if (!granted) {
    return createTypedError(
      'PERMISSION_REQUIRED',
      'Chưa cấp quyền kết nối Base URL — bấm nút khiên cạnh ô Base URL để cấp quyền rồi thử lại',
      false,
      { origin: baseOrigin, permissionType: 'host' }
    );
  }
  return null;
}

let _revalidateModelsPromise = null;

export async function listModelsWithContext(options = {}, {
  router,
  ensureStorageAccess,
  getStoredSettings,
  getStoredApiKey,
  checkDataConsentAccepted,
  CURRENT_DATA_CONSENT_VERSION,
  testMode = false,
  permissionContains,
  notifyModelsUpdated
}) {
  const forceRefresh = Boolean(options && options.forceRefresh);
  if (typeof ensureStorageAccess === 'function') {
    await ensureStorageAccess();
  }
  const settings = typeof getStoredSettings === 'function' ? (await getStoredSettings()) : {};

  // P1-1: Consent Gate — gate LIST_MODELS (+ mọi op chạm key/endpoint) bằng dataConsent accepted
  if (typeof checkDataConsentAccepted === 'function' && !checkDataConsentAccepted(settings)) {
    return createTypedError(
      'DATA_CONSENT_REQUIRED',
      'Data consent not accepted — please accept terms in popup before listing models',
      false,
      { dataConsentVersion: CURRENT_DATA_CONSENT_VERSION }
    );
  }

  const apiKey = (options && options.apiKey) || (typeof getStoredApiKey === 'function' ? (await getStoredApiKey()) : '');
  const baseURL = (options && options.baseURL) || settings.baseURL || '';

  // P1-2: Centralized HTTPS/loopback guard — remote http chặn + lỗi rõ ngay cả khi cache stale
  const basePermError = await checkBaseUrlPermission({
    baseURL,
    testMode,
    permissionContains
  });
  if (basePermError) return basePermError;

  if (!baseURL || !apiKey) {
    return await router.listModels({ forceRefresh, baseURL, apiKey });
  }

  const fingerprint = await computeKeyFingerprint(apiKey, baseURL);

  // Read L2 cache from storage.local
  let cached = null;
  try {
    const res = await chrome.storage.local.get(['modelListCache']);
    cached = res.modelListCache;
  } catch {}

  const isCacheValid = Boolean(
    cached &&
    cached.baseURL === baseURL &&
    cached.keyFingerprint === fingerprint &&
    Array.isArray(cached.models) &&
    typeof cached.fetchedAt === 'number'
  );

  const now = Date.now();
  const age = isCacheValid ? (now - cached.fetchedAt) : Infinity;

  // 1. Force refresh: bypass L1 and L2
  if (forceRefresh) {
    const fetchRes = await router.listModels({ forceRefresh: true, baseURL, apiKey });
    if (fetchRes && Array.isArray(fetchRes.models)) {
      const fetchedAt = Date.now();
      await chrome.storage.local.set({
        modelListCache: {
          baseURL,
          keyFingerprint: fingerprint,
          models: fetchRes.models,
          fetchedAt
        }
      });
      return { models: fetchRes.models, stale: false, fetchedAt };
    }
    // Fetch failed: if stale cache exists within 7 days, return stale + error
    if (isCacheValid && age <= MODEL_CACHE_STALE_MAX_MS) {
      return {
        models: cached.models,
        stale: true,
        fetchedAt: cached.fetchedAt,
        error: fetchRes?.error || fetchRes
      };
    }
    return fetchRes;
  }

  // 2. Fresh (<24h): return immediately
  if (isCacheValid && age < MODEL_CACHE_FRESH_MS) {
    return {
      models: cached.models,
      stale: false,
      fetchedAt: cached.fetchedAt
    };
  }

  // 3. Stale (<= 7 days): return immediately, revalidate in background (shared promise)
  if (isCacheValid && age <= MODEL_CACHE_STALE_MAX_MS) {
    if (!_revalidateModelsPromise) {
      _revalidateModelsPromise = (async () => {
        try {
          const permErr = await checkBaseUrlPermission({
            baseURL,
            testMode,
            permissionContains
          });
          if (permErr) return;
          const fetchRes = await router.listModels({ forceRefresh: true, baseURL, apiKey });
          if (fetchRes && Array.isArray(fetchRes.models)) {
            const fetchedAt = Date.now();
            await chrome.storage.local.set({
              modelListCache: {
                baseURL,
                keyFingerprint: fingerprint,
                models: fetchRes.models,
                fetchedAt
              }
            });
            if (typeof notifyModelsUpdated === 'function') {
              notifyModelsUpdated({ models: fetchRes.models, fetchedAt });
            }
          }
        } catch {
        } finally {
          _revalidateModelsPromise = null;
        }
      })();
    }
    return {
      models: cached.models,
      stale: true,
      fetchedAt: cached.fetchedAt,
      refreshing: true
    };
  }

  // 4. Missing, fingerprint changed, or > 7 days: blocking fetch
  const fetchRes = await router.listModels({ forceRefresh: true, baseURL, apiKey });
  if (fetchRes && Array.isArray(fetchRes.models)) {
    const fetchedAt = Date.now();
    await chrome.storage.local.set({
      modelListCache: {
        baseURL,
        keyFingerprint: fingerprint,
        models: fetchRes.models,
        fetchedAt
      }
    });
    return { models: fetchRes.models, stale: false, fetchedAt };
  }
  return fetchRes;
}
