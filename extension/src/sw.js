// WebMCP Translator Kit — Background Service Worker (Direct Mode)
// Contract Version: webmcp-translator-contract/1

const TRANSLATE_TIMEOUT_MS = 60000;
const LIST_MODELS_TIMEOUT_MS = 15000;

const DEFAULTS = {
  provider: {
    timeoutMs: TRANSLATE_TIMEOUT_MS,
    listModelsTimeoutMs: LIST_MODELS_TIMEOUT_MS,
    maxRetries: 2,
    maxTimeoutRetries: 1,
    retryInitialDelayMs: 500,
    retryMaxDelayMs: 1000,
    retryTimeoutDelayMs: 800,
    retryJitterRatio: 0.2
  },
  batch: {
    maxItems: 64,
    maxSourceBytesUtf8: 24576, // 24 KiB
    maxResponseBytes: 65536
  },
  cache: {
    listModels: {
      ttlMs: 300000 // 5 minutes
    }
  }
};

let storageAccessInitialized = false;
let listModelsMemoryCache = null; // { data, timestamp, cacheKey }

// Helper to create typed errors strictly conforming to schemas/error.schema.json
function createTypedError(code, message, retryable, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.retryable = Boolean(retryable);
  err.details = details;
  return {
    error: {
      code,
      message,
      retryable: Boolean(retryable),
      details
    }
  };
}

// 4.1 Storage Access Level: TRUSTED_CONTEXTS
async function ensureStorageAccess() {
  if (storageAccessInitialized) return;
  try {
    if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function') {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
    storageAccessInitialized = true;
  } catch (err) {
    storageAccessInitialized = false;
    throw createTypedError(
      'KEY_ACCESS_UNAVAILABLE',
      'Could not establish TRUSTED_CONTEXTS access level on storage',
      false,
      { reason: err && err.message ? String(err.message) : 'setAccessLevel failed' }
    );
  }
}

const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';

// Storage helpers
async function getStoredSettings() {
  await ensureStorageAccess();
  const res = await chrome.storage.local.get(['settings']);
  return res.settings || {
    baseURL: 'http://localhost:8080/v1',
    model: DEFAULT_MODEL,
    sourceLanguage: 'auto',
    targetLanguage: 'vi'
  };
}

async function getStoredApiKey() {
  await ensureStorageAccess();
  const res = await chrome.storage.local.get(['api_key']);
  return res.api_key || '';
}

function normalizeBaseURL(url) {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '');
}

// Model Discovery (GET {baseURL}/models, 5min cache)
async function listModels() {
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = await getStoredApiKey();
  const baseURL = normalizeBaseURL(settings.baseURL);

  const missing = [];
  if (!baseURL) missing.push('baseURL');
  if (!apiKey) missing.push('apiKey');
  if (missing.length > 0) {
    return createTypedError(
      'MISSING_CONFIG',
      `Missing required configuration: ${missing.join(', ')}`,
      false,
      { missing }
    );
  }

  const cacheKey = `${baseURL}::${apiKey.slice(0, 8)}`;
  const now = Date.now();
  if (
    listModelsMemoryCache &&
    listModelsMemoryCache.cacheKey === cacheKey &&
    now - listModelsMemoryCache.timestamp < DEFAULTS.cache.listModels.ttlMs
  ) {
    return { models: listModelsMemoryCache.data };
  }

  const controller = new AbortController();
  const timeoutMs = DEFAULTS.provider.listModelsTimeoutMs || LIST_MODELS_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseURL}/models`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      if (resp.status === 401) {
        return createTypedError('HTTP_401', 'Provider returned 401 Unauthorized', false, { status: 401, statusText: resp.statusText });
      }
      if (resp.status === 403) {
        return createTypedError('HTTP_403', 'Provider returned 403 Forbidden', false, { status: 403, statusText: resp.statusText });
      }
      if (resp.status === 404) {
        return createTypedError('HTTP_404', 'Provider returned 404 Not Found', false, { status: 404, statusText: resp.statusText });
      }
      if (resp.status === 429) {
        return createTypedError('HTTP_429', 'Provider returned 429 Rate Limit', true, { status: 429, statusText: resp.statusText });
      }
      if (resp.status >= 500) {
        return createTypedError('HTTP_5xx', `Provider returned server error ${resp.status}`, true, { status: resp.status, statusText: resp.statusText });
      }
      return createTypedError('INVALID_SCHEMA', `Provider returned HTTP ${resp.status}`, false, { schemaErrors: [`HTTP_${resp.status}`] });
    }

    const json = await resp.json();
    let rawModels = [];
    if (Array.isArray(json.models)) {
      rawModels = json.models;
    } else if (Array.isArray(json.data)) {
      rawModels = json.data;
    } else {
      return createTypedError('INVALID_SCHEMA', 'Invalid models response schema from provider', false, {
        schemaErrors: ['Missing models or data array']
      });
    }

    const models = rawModels
      .filter((m) => m && typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({ id: m.id }));

    if (models.length === 0) {
      return createTypedError('INVALID_SCHEMA', 'No valid model objects returned', false, {
        schemaErrors: ['Empty or invalid model objects']
      });
    }

    listModelsMemoryCache = {
      data: models,
      timestamp: now,
      cacheKey
    };

    return { models };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return createTypedError('TIMEOUT', `listModels timed out after ${timeoutMs}ms`, false, {
        timeoutMs
      });
    }
    return createTypedError('NETWORK', err && err.message ? String(err.message) : 'Network error during listModels', true, {
      message: err && err.message ? String(err.message) : 'Network error'
    });
  }
}

// Compute UTF-8 bytes for text
function countUtf8Bytes(str) {
  return new TextEncoder().encode(str).length;
}

// Delay with jitter helper
function delayWithJitter(baseMs, jitterRatio) {
  const jitter = (Math.random() * 2 - 1) * jitterRatio; // [-jitterRatio, +jitterRatio]
  const delay = Math.round(baseMs * (1 + jitter));
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
}

// Safe parse JSON from LLM content (handling markdown code fences)
function parseLlmJson(content) {
  if (!content || typeof content !== 'string') return null;
  let text = content.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Batch Translation (POST {baseURL}/chat/completions, stream: false)
async function translateBatch(input) {
  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const apiKey = await getStoredApiKey();
  const baseURL = normalizeBaseURL(settings.baseURL);

  const { items, sourceLanguage = 'auto', targetLanguage = 'vi', model } = input;
  const targetModel = model || settings.model;

  // 1. Config check
  const missing = [];
  if (!baseURL) missing.push('baseURL');
  if (!apiKey) missing.push('apiKey');
  if (!targetModel) missing.push('model');
  if (missing.length > 0) {
    return createTypedError('MISSING_CONFIG', `Missing required configuration: ${missing.join(', ')}`, false, { missing });
  }

  // 2. Pre-dispatch batch checks
  if (!Array.isArray(items) || items.length === 0) {
    return createTypedError('INVALID_SCHEMA', 'Items array is empty or not an array', false, { schemaErrors: ['Empty items'] });
  }

  if (items.length > DEFAULTS.batch.maxItems) {
    return createTypedError('CAP_EXCEEDED', `Batch item count exceeds limit of ${DEFAULTS.batch.maxItems}`, false, {
      capType: 'items',
      limit: DEFAULTS.batch.maxItems,
      actual: items.length
    });
  }

  let totalSourceBytes = 0;
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || typeof it.text !== 'string' || typeof it.revision !== 'number') {
      return createTypedError('INVALID_SCHEMA', 'Item missing mandatory id, text, or revision', false, {
        schemaErrors: ['Invalid item structure']
      });
    }
    totalSourceBytes += countUtf8Bytes(it.text);
  }

  if (totalSourceBytes > DEFAULTS.batch.maxSourceBytesUtf8) {
    return createTypedError('CAP_EXCEEDED', `Batch source bytes exceed limit of ${DEFAULTS.batch.maxSourceBytesUtf8}`, false, {
      capType: 'requestBytes',
      limit: DEFAULTS.batch.maxSourceBytesUtf8,
      actual: totalSourceBytes
    });
  }

  // Construct request payload
  const systemPrompt = [
    'You are a professional web page text translator.',
    `Translate each given item from ${sourceLanguage} to ${targetLanguage}.`,
    'Preserve technical codes, punctuation, and formatting.',
    'Output MUST be valid strictly formatted JSON with the exact structure:',
    '{"results": [{"id": "...", "revision": 0, "text": "..."}]}',
    'Each result item MUST have matching "id" and "revision" identical to the input item.',
    'Do not include explanations, notes, or markdown formatting.'
  ].join(' ');

  const requestItems = items.map((it) => ({
    id: it.id,
    revision: it.revision,
    text: it.text
  }));

  const requestBody = JSON.stringify({
    model: targetModel,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(requestItems) }
    ],
    temperature: 0.1
  });

  const batchStart = Date.now();
  const timeoutMs = TRANSLATE_TIMEOUT_MS;
  const maxTimeoutRetries = DEFAULTS.provider.maxTimeoutRetries; // 1
  const maxNetworkRetries = DEFAULTS.provider.maxRetries; // 2
  let timeoutRetries = 0;
  let networkRetries = 0;
  let lastErrorResult = null;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        body: requestBody,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Check HTTP error status
      if (!resp.ok) {
        const status = resp.status;
        const statusText = resp.statusText;

        if (status === 401) {
          const err = createTypedError('HTTP_401', 'Provider returned 401 Unauthorized', false, { status: 401, statusText });
          err.elapsedMs = Date.now() - batchStart;
          err.model = targetModel;
          err.error.elapsedMs = err.elapsedMs;
          err.error.model = targetModel;
          return err;
        }
        if (status === 403) {
          const err = createTypedError('HTTP_403', 'Provider returned 403 Forbidden', false, { status: 403, statusText });
          err.elapsedMs = Date.now() - batchStart;
          err.model = targetModel;
          err.error.elapsedMs = err.elapsedMs;
          err.error.model = targetModel;
          return err;
        }
        if (status === 404) {
          const err = createTypedError('HTTP_404', 'Provider returned 404 Not Found', false, { status: 404, statusText });
          err.elapsedMs = Date.now() - batchStart;
          err.model = targetModel;
          err.error.elapsedMs = err.elapsedMs;
          err.error.model = targetModel;
          return err;
        }
        if (status === 429) {
          // Parse Retry-After
          const retryAfterHeader = resp.headers.get('Retry-After');
          let retryAfterMs = 1000;
          if (retryAfterHeader) {
            const parsedSeconds = parseInt(retryAfterHeader, 10);
            if (!Number.isNaN(parsedSeconds)) {
              retryAfterMs = parsedSeconds * 1000;
            }
          }
          if (retryAfterMs > 10000) {
            const err = createTypedError('HTTP_429', 'Remote rate limit Retry-After exceeds 10,000ms', false, {
              status: 429,
              retryAfterMs
            });
            err.elapsedMs = Date.now() - batchStart;
            err.model = targetModel;
            err.error.elapsedMs = err.elapsedMs;
            err.error.model = targetModel;
            return err;
          }
          lastErrorResult = createTypedError('HTTP_429', 'Remote 9router rate limit exceeded (HTTP 429)', true, {
            status: 429,
            retryAfterMs
          });
          lastErrorResult.elapsedMs = Date.now() - batchStart;
          lastErrorResult.model = targetModel;
          lastErrorResult.error.elapsedMs = lastErrorResult.elapsedMs;
          lastErrorResult.error.model = targetModel;

          if (networkRetries < maxNetworkRetries) {
            networkRetries++;
            await new Promise((r) => setTimeout(r, Math.min(retryAfterMs, 10000)));
            continue;
          }
          return lastErrorResult;
        }
        if (status === 504) {
          // Gateway timeout (treated as timeout with timeout retry)
          lastErrorResult = createTypedError('TIMEOUT', `Provider gateway timeout HTTP 504 (${statusText || 'Gateway Timeout'})`, false, {
            status: 504,
            statusText,
            timeoutMs
          });
          lastErrorResult.elapsedMs = Date.now() - batchStart;
          lastErrorResult.model = targetModel;
          lastErrorResult.error.elapsedMs = lastErrorResult.elapsedMs;
          lastErrorResult.error.model = targetModel;

          if (timeoutRetries < maxTimeoutRetries) {
            timeoutRetries++;
            await delayWithJitter(DEFAULTS.provider.retryTimeoutDelayMs, DEFAULTS.provider.retryJitterRatio);
            continue;
          }
          return lastErrorResult;
        }
        if (status >= 500) {
          lastErrorResult = createTypedError('HTTP_5xx', `Provider server error HTTP ${status}`, true, { status, statusText });
          lastErrorResult.elapsedMs = Date.now() - batchStart;
          lastErrorResult.model = targetModel;
          lastErrorResult.error.elapsedMs = lastErrorResult.elapsedMs;
          lastErrorResult.error.model = targetModel;

          if (networkRetries < maxNetworkRetries) {
            networkRetries++;
            const baseDelay = networkRetries === 1 ? DEFAULTS.provider.retryInitialDelayMs : DEFAULTS.provider.retryMaxDelayMs;
            await delayWithJitter(baseDelay, DEFAULTS.provider.retryJitterRatio);
            continue;
          }
          return lastErrorResult;
        }

        const err = createTypedError('INVALID_SCHEMA', `Provider returned HTTP ${status}`, false, {
          schemaErrors: [`HTTP_${status}: ${statusText}`]
        });
        err.elapsedMs = Date.now() - batchStart;
        err.model = targetModel;
        err.error.elapsedMs = err.elapsedMs;
        err.error.model = targetModel;
        return err;
      }

      // Check Content-Length if present
      const contentLengthHeader = resp.headers.get('Content-Length');
      if (contentLengthHeader) {
        const len = parseInt(contentLengthHeader, 10);
        if (!Number.isNaN(len) && len > DEFAULTS.batch.maxResponseBytes) {
          const err = createTypedError('CAP_EXCEEDED', `Response Content-Length exceeds limit of ${DEFAULTS.batch.maxResponseBytes}`, false, {
            capType: 'responseBytes',
            limit: DEFAULTS.batch.maxResponseBytes,
            actual: len
          });
          err.elapsedMs = Date.now() - batchStart;
          err.model = targetModel;
          err.error.elapsedMs = err.elapsedMs;
          err.error.model = targetModel;
          return err;
        }
      }

      // Read response body with byte cap check
      const reader = resp.body.getReader();
      const chunks = [];
      let totalBytesReceived = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytesReceived += value.length;
        if (totalBytesReceived > DEFAULTS.batch.maxResponseBytes) {
          controller.abort();
          const err = createTypedError('CAP_EXCEEDED', `Response body exceeded limit of ${DEFAULTS.batch.maxResponseBytes} bytes`, false, {
            capType: 'responseBytes',
            limit: DEFAULTS.batch.maxResponseBytes,
            actual: totalBytesReceived
          });
          err.elapsedMs = Date.now() - batchStart;
          err.model = targetModel;
          err.error.elapsedMs = err.elapsedMs;
          err.error.model = targetModel;
          return err;
        }
        chunks.push(value);
      }

      const merged = new Uint8Array(totalBytesReceived);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const rawText = new TextDecoder().decode(merged);

      let responseJson = null;
      try {
        responseJson = JSON.parse(rawText);
      } catch (e) {
        const err = createTypedError('INVALID_SCHEMA', 'Provider response is not valid JSON', false, {
          schemaErrors: ['Malformed outer response JSON']
        });
        err.elapsedMs = Date.now() - batchStart;
        err.model = targetModel;
        err.error.elapsedMs = err.elapsedMs;
        err.error.model = targetModel;
        return err;
      }

      const content = responseJson.choices && responseJson.choices[0] && responseJson.choices[0].message
        ? responseJson.choices[0].message.content
        : null;

      if (!content) {
        const err = createTypedError('INVALID_SCHEMA', 'Missing choices[0].message.content in provider response', false, {
          schemaErrors: ['Missing message content']
        });
        err.elapsedMs = Date.now() - batchStart;
        err.model = targetModel;
        err.error.elapsedMs = err.elapsedMs;
        err.error.model = targetModel;
        return err;
      }

      const parsedResults = parseLlmJson(content);
      if (!parsedResults || !Array.isArray(parsedResults.results)) {
        const err = createTypedError('INVALID_SCHEMA', 'Translated content missing results array', false, {
          schemaErrors: ['Missing results array in LLM JSON output']
        });
        err.elapsedMs = Date.now() - batchStart;
        err.model = targetModel;
        err.error.elapsedMs = err.elapsedMs;
        err.error.model = targetModel;
        return err;
      }

      const results = parsedResults.results;

      // Bijection validation
      if (results.length !== items.length) {
        const err = createTypedError('INVALID_SCHEMA', `Results length (${results.length}) does not match input length (${items.length})`, false, {
          schemaErrors: [`Length mismatch: expected ${items.length}, got ${results.length}`]
        });
        err.elapsedMs = Date.now() - batchStart;
        err.model = targetModel;
        err.error.elapsedMs = err.elapsedMs;
        err.error.model = targetModel;
        return err;
      }

      const resultMap = new Map();
      const schemaErrors = [];

      for (const r of results) {
        if (!r || typeof r.id !== 'string' || typeof r.revision !== 'number' || typeof r.text !== 'string') {
          schemaErrors.push('Result item missing id, revision, or text string');
          continue;
        }
        if (resultMap.has(r.id)) {
          schemaErrors.push(`Duplicate result id: ${r.id}`);
        }
        resultMap.set(r.id, r);
      }

      if (schemaErrors.length > 0) {
        const err = createTypedError('INVALID_SCHEMA', 'Result item schema validation failed', false, { schemaErrors });
        err.elapsedMs = Date.now() - batchStart;
        err.model = targetModel;
        err.error.elapsedMs = err.elapsedMs;
        err.error.model = targetModel;
        return err;
      }

      // Check all input items are accounted for with matching revision
      const verifiedResults = [];
      for (const it of items) {
        const matched = resultMap.get(it.id);
        if (!matched) {
          const err = createTypedError('INVALID_SCHEMA', `Missing translation result for input id: ${it.id}`, false, {
            schemaErrors: [`Missing result for item ${it.id}`]
          });
          err.elapsedMs = Date.now() - batchStart;
          err.model = targetModel;
          err.error.elapsedMs = err.elapsedMs;
          err.error.model = targetModel;
          return err;
        }
        if (matched.revision !== it.revision) {
          const err = createTypedError('INVALID_SCHEMA', `Revision mismatch for item ${it.id}: expected ${it.revision}, got ${matched.revision}`, false, {
            schemaErrors: [`Revision mismatch for ${it.id}`]
          });
          err.elapsedMs = Date.now() - batchStart;
          err.model = targetModel;
          err.error.elapsedMs = err.elapsedMs;
          err.error.model = targetModel;
          return err;
        }
        verifiedResults.push({
          id: matched.id,
          revision: matched.revision,
          text: matched.text
        });
      }

      // Privacy log hygiene: only log counts and model id, never text
      const actualModel = responseJson.model || 'unknown';
      const elapsedMs = Date.now() - batchStart;

      // Successfully validated
      return {
        results: verifiedResults,
        requestedModel: targetModel,
        actualModel,
        model: actualModel !== 'unknown' ? actualModel : targetModel,
        elapsedMs
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        lastErrorResult = createTypedError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, false, {
          timeoutMs
        });
        lastErrorResult.elapsedMs = Date.now() - batchStart;
        lastErrorResult.model = targetModel;
        lastErrorResult.error.elapsedMs = lastErrorResult.elapsedMs;
        lastErrorResult.error.model = targetModel;

        if (timeoutRetries < maxTimeoutRetries) {
          timeoutRetries++;
          await delayWithJitter(DEFAULTS.provider.retryTimeoutDelayMs, DEFAULTS.provider.retryJitterRatio);
          continue;
        }
        return lastErrorResult;
      }

      lastErrorResult = createTypedError('NETWORK', err && err.message ? String(err.message) : 'Network error during request', true, {
        message: err && err.message ? String(err.message) : 'Network error'
      });
      lastErrorResult.elapsedMs = Date.now() - batchStart;
      lastErrorResult.model = targetModel;
      lastErrorResult.error.elapsedMs = lastErrorResult.elapsedMs;
      lastErrorResult.error.model = targetModel;

      if (networkRetries < maxNetworkRetries) {
        networkRetries++;
        const baseDelay = networkRetries === 1 ? DEFAULTS.provider.retryInitialDelayMs : DEFAULTS.provider.retryMaxDelayMs;
        await delayWithJitter(baseDelay, DEFAULTS.provider.retryJitterRatio);
        continue;
      }
      return lastErrorResult;
    }
  }

  return lastErrorResult || createTypedError('NETWORK', 'All retry attempts exhausted', true);
}

// Startup hook
chrome.runtime.onInstalled.addListener(() => {
  ensureStorageAccess().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureStorageAccess().catch(() => {});
});

// Runtime Message Handler
async function handleRuntimeMessage(message, sender = { frameId: 0 }) {
  switch (message.action) {
    case 'PING':
      return { ok: true, version: '0.1.0' };

    case 'GET_SETTINGS': {
      const settings = await getStoredSettings();
      const hasKey = Boolean(await getStoredApiKey());
      return { settings, hasKey };
    }

    case 'SAVE_SETTINGS': {
      await ensureStorageAccess();
      if (message.settings) {
        await chrome.storage.local.set({ settings: message.settings });
        listModelsMemoryCache = null; // Invalidate cache
      }
      return { ok: true };
    }

    case 'SET_KEY': {
      await ensureStorageAccess();
      if (typeof message.key === 'string') {
        await chrome.storage.local.set({ api_key: message.key });
        listModelsMemoryCache = null; // Invalidate cache
      }
      return { ok: true };
    }

    case 'DELETE_KEY': {
      await ensureStorageAccess();
      await chrome.storage.local.remove(['api_key']);
      listModelsMemoryCache = null; // Invalidate cache
      return { ok: true };
    }

    case 'HAS_KEY': {
      const key = await getStoredApiKey();
      return { hasKey: Boolean(key) };
    }

    case 'LIST_MODELS': {
      return await listModels();
    }

    case 'TRANSLATE_BATCH': {
      // Verify sender metadata: must be top frame
      if (sender && typeof sender.frameId === 'number' && sender.frameId !== 0) {
        return createTypedError('PERMISSION_REQUIRED', 'Only top frame translation is permitted', false, {
          permissionType: 'host'
        });
      }
      return await translateBatch(message.payload || {});
    }

    default:
      return { error: { code: 'UNKNOWN_ACTION', message: `Unknown action ${message.action}` } };
  }
}

// Runtime Message Dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return false;

  handleRuntimeMessage(message, sender)
    .then(sendResponse)
    .catch((e) => {
      if (e && e.error) {
        sendResponse(e);
      } else {
        sendResponse(createTypedError('KEY_ACCESS_UNAVAILABLE', e && e.message ? String(e.message) : 'Internal error', false));
      }
    });

  return true; // Keep channel open for async response
});

// Expose dispatcher for CDP inspection & smoke tests
self.__translatorSw = {
  dispatchMessage: (message, sender = { frameId: 0 }) => handleRuntimeMessage(message, sender),
  translateBatch,
  listModels,
  ensureStorageAccess,
  getStoredSettings,
  getStoredApiKey,
  DEFAULT_MODEL,
  TRANSLATE_TIMEOUT_MS,
  LIST_MODELS_TIMEOUT_MS
};
