// WebMCP Translator Kit — Direct 9router Adapter
// Contract Version: webmcp-translator-contract/1
// Pure module: No chrome.* APIs used.
//
// Transport note (owner-approved deviation from the frozen `stream:false`):
// chat completions are requested with `stream:true`. When the provider
// answers `text/event-stream`, translated items are emitted progressively
// via `input.onProgress({id, revision, text})` as soon as each result item
// is complete, and the final aggregated result keeps the exact legacy shape
// (bijection-validated). Non-SSE responses use the legacy parse unchanged.

import { createIncrementalResultsParser } from '../sse-json.mjs';

function normalizeBaseURL(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/+$/, '');
}

function countUtf8Bytes(str) {
  return new TextEncoder().encode(str).length;
}

function safeSliceHead(str, maxLen = 300) {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  let end = maxLen;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) {
    end--;
  }
  return str.slice(0, end);
}

function createTypedError(code, message, retryable, details = {}) {
  return {
    error: {
      code,
      message,
      retryable: Boolean(retryable),
      details
    }
  };
}

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

export function isErrorJson(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (!s || s.startsWith('<') || s.startsWith('<!DOCTYPE')) return false;

  const hasResultsKey = /["']?results["']?\s*:/i.test(s) || /["']results["']/i.test(s);
  const hasItemFragment = /\{\s*["']?id["']?/i.test(s);
  const hasResultsTrace = hasResultsKey || hasItemFragment;

  const hasErrorKey = /["']?error["']?\s*:/i.test(s);
  return hasErrorKey && !hasResultsTrace;
}

function hasJsonOrResultsSigns(rawHead) {
  if (!rawHead || typeof rawHead !== 'string') return false;
  const str = rawHead.trim();
  if (!str) return false;
  if (str.startsWith('<') || str.startsWith('<!DOCTYPE')) return false;

  if (isErrorJson(str)) {
    return false;
  }

  const hasResultsKey = /["']?results["']?\s*:/i.test(str) || /["']results["']/i.test(str);
  const hasItemFragment = /\{\s*["']?id["']?/i.test(str);
  return hasResultsKey || hasItemFragment;
}

export function createDirect9Router(config = {}) {
  const fetchImpl = config.fetchImpl || fetch;
  const timeoutMs = config.timeoutMs ?? 60000;
  const listModelsTimeoutMs = config.listModelsTimeoutMs ?? 15000;
  const listModelsTtlMs = config.listModelsTtlMs ?? 300000; // 5 minutes
  const maxRetries = config.maxRetries ?? 2;
  const maxTimeoutRetries = config.maxTimeoutRetries ?? 1;

  function getMaxRetries() {
    if (typeof config.getMaxRetries === 'function') {
      return config.getMaxRetries();
    }
    if (config.maxRetries !== undefined) {
      return config.maxRetries;
    }
    return maxRetries;
  }
  const retryInitialDelayMs = config.retryInitialDelayMs ?? 500;
  const retryMaxDelayMs = config.retryMaxDelayMs ?? 1000;
  const retryTimeoutDelayMs = config.retryTimeoutDelayMs ?? 800;
  const retryJitterRatio = config.retryJitterRatio ?? 0.2;

  const batchConfig = {
    maxItems: 64,
    maxSourceBytesUtf8: 24576,
    maxResponseBytes: 65536,
    ...(config.batch || {})
  };

  const now = config.now || Date.now;
  const sleep = config.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = config.random || Math.random;

  function delayWithJitter(baseMs, jitterRatio) {
    const jitter = (random() * 2 - 1) * jitterRatio; // [-jitterRatio, +jitterRatio]
    const delay = Math.round(baseMs * (1 + jitter));
    return sleep(Math.max(0, delay));
  }

  function getBaseURL() {
    return normalizeBaseURL(config.baseURL !== undefined ? config.baseURL : '');
  }

  function getApiKey() {
    return config.apiKey !== undefined ? String(config.apiKey) : '';
  }

  function getModel() {
    return config.model !== undefined ? String(config.model) : '';
  }

  // listModels cache state
  let cachedModels = null;
  let lastCacheKey = null;
  let lastTimestamp = 0;
  let lastBaseURL = null;
  let lastApiKey = null;

  async function listModels(options = {}) {
    const forceRefresh = Boolean(options && options.forceRefresh);
    const baseURL = normalizeBaseURL(options.baseURL !== undefined ? options.baseURL : getBaseURL());
    const apiKey = options.apiKey !== undefined ? String(options.apiKey) : getApiKey();

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

    // Invalidation when baseURL or apiKey changes
    if (lastBaseURL !== null && (baseURL !== lastBaseURL || apiKey !== lastApiKey)) {
      cachedModels = null;
      lastCacheKey = null;
      lastTimestamp = 0;
    }

    const currentTime = now();
    if (
      !forceRefresh &&
      cachedModels &&
      lastCacheKey === cacheKey &&
      currentTime - lastTimestamp < listModelsTtlMs
    ) {
      return { models: cachedModels };
    }

    let timeoutTriggered = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutTriggered = true;
      try { controller.abort(); } catch {}
    }, listModelsTimeoutMs);

    try {
      const url = `${baseURL}/models`;
      const resp = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      });

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

      let json;
      if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        const onStreamAbort = () => {
          try { reader.cancel(controller.signal.reason); } catch {}
        };
        if (controller.signal.aborted) {
          onStreamAbort();
        } else {
          controller.signal.addEventListener('abort', onStreamAbort, { once: true });
        }
        const chunks = [];
        try {
          while (true) {
            if (controller.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
            if (done) break;
            chunks.push(value);
          }
        } finally {
          controller.signal.removeEventListener('abort', onStreamAbort);
        }
        let totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        const rawText = new TextDecoder().decode(merged);
        try {
          json = JSON.parse(rawText);
        } catch {
          return createTypedError('INVALID_SCHEMA', 'Invalid JSON from provider', false, {
            schemaErrors: ['Failed to parse JSON response']
          });
        }
      } else if (typeof resp.json === 'function') {
        try {
          json = await Promise.race([
            resp.json(),
            new Promise((_, reject) => {
              if (controller.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
              controller.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            })
          ]);
        } catch (e) {
          if (timeoutTriggered || controller.signal.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
            return createTypedError('TIMEOUT', `listModels timed out after ${listModelsTimeoutMs}ms`, false, {
              timeoutMs: listModelsTimeoutMs
            });
          }
          return createTypedError('INVALID_SCHEMA', 'Invalid JSON from provider', false, {
            schemaErrors: ['Failed to parse JSON response']
          });
        }
      }

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

      cachedModels = models;
      lastTimestamp = currentTime;
      lastCacheKey = cacheKey;
      lastBaseURL = baseURL;
      lastApiKey = apiKey;

      return { models };
    } catch (err) {
      if (timeoutTriggered || controller.signal.aborted || err.name === 'AbortError' || err.name === 'TimeoutError') {
        return createTypedError('TIMEOUT', `listModels timed out after ${listModelsTimeoutMs}ms`, false, {
          timeoutMs: listModelsTimeoutMs
        });
      }
      return createTypedError('NETWORK', err && err.message ? String(err.message) : 'Network error during listModels', true, {
        reason: err && err.message ? String(err.message) : 'Network error'
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function translateBatch(input = {}) {
    const { items, sourceLanguage = 'auto', targetLanguage = 'vi', model, signal, onProgress } = input;
    const emitProgress = (item) => {
      try {
        if (typeof onProgress === 'function' && item && typeof item.id === 'string') onProgress(item);
      } catch {}
    };
    const baseURL = normalizeBaseURL(input.baseURL !== undefined ? input.baseURL : getBaseURL());
    const apiKey = input.apiKey !== undefined ? String(input.apiKey) : getApiKey();
    const targetModel = model || getModel();

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

    if (items.length > batchConfig.maxItems) {
      return createTypedError('CAP_EXCEEDED', `Batch item count exceeds limit of ${batchConfig.maxItems}`, false, {
        capType: 'items',
        limit: batchConfig.maxItems,
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

    if (totalSourceBytes > batchConfig.maxSourceBytesUtf8) {
      return createTypedError('CAP_EXCEEDED', `Batch source bytes exceed limit of ${batchConfig.maxSourceBytesUtf8}`, false, {
        capType: 'requestBytes',
        limit: batchConfig.maxSourceBytesUtf8,
        actual: totalSourceBytes
      });
    }

    // 3. Check caller signal before dispatch
    if (signal?.aborted) {
      return createTypedError('ABORTED', 'Operation aborted by caller', false, {
        reason: signal.reason ? String(signal.reason) : 'Caller aborted'
      });
    }

    // 4. Construct request payload
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

    const payload = {
      model: targetModel,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(requestItems) }
      ],
      temperature: 0.1
    };

    let requestBody = JSON.stringify(payload);

    const batchStart = now();

    async function executeSingleBatch(batchItems) {
      const systemPrompt = [
        'You are a professional web page text translator.',
        `Translate each given item from ${sourceLanguage} to ${targetLanguage}.`,
        'Preserve technical codes, punctuation, and formatting.',
        'Output MUST be valid strictly formatted JSON with the exact structure:',
        '{"results": [{"id": "...", "revision": 0, "text": "..."}]}',
        'Each result item MUST have matching "id" and "revision" identical to the input item.',
        'Do not include explanations, notes, or markdown formatting.'
      ].join(' ');

      const requestItems = batchItems.map((it) => ({
        id: it.id,
        revision: it.revision,
        text: it.text
      }));

      const payload = {
        model: targetModel,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(requestItems) }
        ],
        temperature: 0.1
      };

      let requestBody = JSON.stringify(payload);

      let timeoutRetries = 0;
      let networkRetries = 0;
      let tempRetryAttempted = false;
      let lastErrorResult = null;

      while (true) {
        if (signal?.aborted) {
          return createTypedError('ABORTED', 'Operation aborted by caller', false, {
            reason: signal.reason ? String(signal.reason) : 'Caller aborted'
          });
        }

        const internalController = new AbortController();
        let timeoutTriggered = false;
        let callerAborted = false;

        const onCallerAbort = () => {
          callerAborted = true;
          try {
            internalController.abort('caller_aborted');
          } catch {}
        };

        if (signal) {
          signal.addEventListener('abort', onCallerAbort, { once: true });
        }

        const timeoutId = setTimeout(() => {
          timeoutTriggered = true;
          try {
            internalController.abort('timeout');
          } catch {}
        }, timeoutMs);

        try {
          const resp = await fetchImpl(`${baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              Accept: 'text/event-stream, application/json'
            },
            body: requestBody,
            signal: internalController.signal
          });

          if (signal?.aborted || callerAborted) {
            return createTypedError('ABORTED', 'Operation aborted by caller', false, {
              reason: signal?.reason ? String(signal.reason) : 'Caller aborted'
            });
          }

          // Check HTTP error status
          if (!resp.ok) {
            const status = resp.status;
            const statusText = resp.statusText;

            if (status === 401) {
              const err = createTypedError('HTTP_401', 'Provider returned 401 Unauthorized', false, { status: 401, statusText });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }
            if (status === 403) {
              const err = createTypedError('HTTP_403', 'Provider returned 403 Forbidden', false, { status: 403, statusText });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }
            if (status === 404) {
              const err = createTypedError('HTTP_404', 'Provider returned 404 Not Found', false, { status: 404, statusText });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }
            if (status === 400 && !tempRetryAttempted && ('temperature' in payload)) {
              tempRetryAttempted = true;
              delete payload.temperature;
              requestBody = JSON.stringify(payload);
              continue;
            }
            if (status === 429) {
              let retryAfterHeader = null;
              if (resp.headers) {
                retryAfterHeader = typeof resp.headers.get === 'function'
                  ? resp.headers.get('Retry-After')
                  : resp.headers['retry-after'] || resp.headers['Retry-After'];
              }
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
                err.elapsedMs = now() - batchStart;
                err.model = targetModel;
                return err;
              }

              lastErrorResult = createTypedError('HTTP_429', 'Remote 9router rate limit exceeded (HTTP 429)', true, {
                status: 429,
                retryAfterMs
              });
              lastErrorResult.elapsedMs = now() - batchStart;
              lastErrorResult.model = targetModel;

              if (networkRetries < getMaxRetries()) {
                networkRetries++;
                await sleep(Math.min(retryAfterMs, 10000));
                if (signal?.aborted) {
                  return createTypedError('ABORTED', 'Operation aborted by caller', false, {
                    reason: signal.reason ? String(signal.reason) : 'Caller aborted'
                  });
                }
                continue;
              }
              return lastErrorResult;
            }

            if (status === 504) {
              lastErrorResult = createTypedError('TIMEOUT', `Provider gateway timeout HTTP 504 (${statusText || 'Gateway Timeout'})`, false, {
                status: 504,
                statusText,
                timeoutMs
              });
              lastErrorResult.elapsedMs = now() - batchStart;
              lastErrorResult.model = targetModel;

              if (timeoutRetries < maxTimeoutRetries) {
                timeoutRetries++;
                await delayWithJitter(retryTimeoutDelayMs, retryJitterRatio);
                if (signal?.aborted) {
                  return createTypedError('ABORTED', 'Operation aborted by caller', false, {
                    reason: signal.reason ? String(signal.reason) : 'Caller aborted'
                  });
                }
                continue;
              }
              return lastErrorResult;
            }

            if (status >= 500) {
              lastErrorResult = createTypedError('HTTP_5xx', `Provider server error HTTP ${status}`, true, { status, statusText });
              lastErrorResult.elapsedMs = now() - batchStart;
              lastErrorResult.model = targetModel;

              if (networkRetries < getMaxRetries()) {
                networkRetries++;
                const baseDelay = networkRetries === 1 ? retryInitialDelayMs : retryMaxDelayMs;
                await delayWithJitter(baseDelay, retryJitterRatio);
                if (signal?.aborted) {
                  return createTypedError('ABORTED', 'Operation aborted by caller', false, {
                    reason: signal.reason ? String(signal.reason) : 'Caller aborted'
                  });
                }
                continue;
              }
              return lastErrorResult;
            }

            let body = '';
            try {
              if (typeof resp.text === 'function') {
                const text = await resp.text();
                if (text && typeof text === 'string') {
                  body = text.trim().slice(0, 500);
                }
              }
            } catch {}

            let providerMessage = '';
            if (body) {
              try {
                const parsed = JSON.parse(body);
                if (parsed?.error?.message && typeof parsed.error.message === 'string') {
                  providerMessage = parsed.error.message;
                } else if (parsed?.message && typeof parsed.message === 'string') {
                  providerMessage = parsed.message;
                }
              } catch {}
            }

            const statusLabel = statusText ? `HTTP_${status}: ${statusText}` : `HTTP_${status}`;
            const schemaErrors = [statusLabel];
            if (providerMessage) {
              schemaErrors.push(providerMessage);
            } else if (body) {
              schemaErrors.push(body);
            }

            const err = createTypedError('INVALID_SCHEMA', `Provider returned HTTP ${status}`, false, {
              status,
              statusText,
              body: body || undefined,
              providerBody: body || undefined,
              providerMessage: providerMessage || undefined,
              schemaErrors
            });
            err.elapsedMs = now() - batchStart;
            err.model = targetModel;
            return err;
          }

          // Check Content-Length header if present
          let contentLengthHeader = null;
          if (resp.headers) {
            contentLengthHeader = typeof resp.headers.get === 'function'
              ? resp.headers.get('Content-Length')
              : resp.headers['content-length'] || resp.headers['Content-Length'];
          }
          if (contentLengthHeader) {
            const len = parseInt(contentLengthHeader, 10);
            if (!Number.isNaN(len) && len > batchConfig.maxResponseBytes) {
              const err = createTypedError('CAP_EXCEEDED', `Response Content-Length exceeds limit of ${batchConfig.maxResponseBytes}`, false, {
                capType: 'responseBytes',
                limit: batchConfig.maxResponseBytes,
                actual: len
              });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }
          }

          // Detect SSE transport (provider answers text/event-stream)
          let respContentType = '';
          try {
            respContentType = typeof resp.headers?.get === 'function'
              ? (resp.headers.get('Content-Type') || resp.headers.get('content-type') || '')
              : (resp.headers?.['content-type'] || resp.headers?.['Content-Type'] || '');
          } catch {}
          const isSseStream = /text\/event-stream/i.test(respContentType || '') &&
            resp.body && typeof resp.body.getReader === 'function';

          async function readSseResults() {
            const parser = createIncrementalResultsParser();
            const reader = resp.body.getReader();
            const onStreamAbort = () => {
              try { reader.cancel(internalController.signal.reason); } catch {}
            };
            if (internalController.signal.aborted) {
              onStreamAbort();
            } else {
              internalController.signal.addEventListener('abort', onStreamAbort, { once: true });
            }
            const decoder = new TextDecoder();
            let sseBuf = '';
            let rawContentBuf = '';
            let rawStreamBuf = '';
            let totalBytesReceived = 0;
            let sseModel = null;
            let finishReason = null;
            let reasoningOnlyChunks = 0;
            const capExceeded = (actual) => {
              const err = createTypedError('CAP_EXCEEDED', `Response body exceeded limit of ${batchConfig.maxResponseBytes} bytes`, false, {
                capType: 'responseBytes',
                limit: batchConfig.maxResponseBytes,
                actual
              });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return { errorResult: err };
            };
            const flushSseLines = () => {
              const parts = sseBuf.split('\n');
              sseBuf = parts.pop();
              for (const line of parts) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const payload = t.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let chunk;
                try { chunk = JSON.parse(payload); } catch { continue; }
                if (!sseModel && typeof chunk?.model === 'string') sseModel = chunk.model;

                const choice = chunk?.choices?.[0];
                const chunkFinishReason = choice?.finish_reason || chunk?.finish_reason;
                if (typeof chunkFinishReason === 'string' && chunkFinishReason) {
                  finishReason = chunkFinishReason;
                }

                const deltaContent = typeof choice?.delta?.content === 'string'
                  ? choice.delta.content
                  : (Array.isArray(choice?.delta?.content) ? choice.delta.content.map(p => typeof p === 'string' ? p : (p?.text || '')).join('') : null);
                const messageContent = typeof choice?.message?.content === 'string'
                  ? choice.message.content
                  : (Array.isArray(choice?.message?.content) ? choice.message.content.map(p => typeof p === 'string' ? p : (p?.text || '')).join('') : null);

                const textContent = (deltaContent !== null && deltaContent.length > 0)
                  ? deltaContent
                  : (messageContent !== null && messageContent.length > 0)
                    ? messageContent
                    : null;

                if (typeof textContent === 'string' && textContent.length > 0) {
                  rawContentBuf += textContent;
                  for (const item of parser.push(textContent)) emitProgress(item);
                } else {
                  const hasReasoning = Boolean(
                    (typeof choice?.delta?.reasoning_content === 'string' && choice.delta.reasoning_content.length > 0) ||
                    (typeof choice?.delta?.thought === 'string' && choice.delta.thought.length > 0) ||
                    (typeof choice?.message?.reasoning_content === 'string' && choice.message.reasoning_content.length > 0) ||
                    (typeof choice?.message?.thought === 'string' && choice.message.thought.length > 0) ||
                    (typeof choice?.delta?.reasoning === 'string' && choice.delta.reasoning.length > 0) ||
                    (typeof choice?.message?.reasoning === 'string' && choice.message.reasoning.length > 0) ||
                    (typeof chunk?.reasoning_content === 'string' && chunk.reasoning_content.length > 0) ||
                    (typeof chunk?.thought === 'string' && chunk.thought.length > 0)
                  );
                  if (hasReasoning) {
                    reasoningOnlyChunks++;
                  }
                }
              }
            };
            try {
              while (true) {
                if (internalController.signal.aborted) {
                  throw new DOMException('The operation was aborted', 'AbortError');
                }
                const { done, value } = await reader.read();
                if (internalController.signal.aborted) {
                  throw new DOMException('The operation was aborted', 'AbortError');
                }
                if (done) break;
                totalBytesReceived += value.length;
                if (totalBytesReceived > batchConfig.maxResponseBytes) {
                  try { internalController.abort(); } catch {}
                  return capExceeded(totalBytesReceived);
                }
                const chunkStr = decoder.decode(value, { stream: true });
                sseBuf += chunkStr;
                rawStreamBuf += chunkStr;
                flushSseLines();
              }
            } finally {
              try { internalController.signal.removeEventListener('abort', onStreamAbort); } catch {}
            }
            try {
              const finalStr = decoder.decode();
              sseBuf += finalStr;
              rawStreamBuf += finalStr;
            } catch {}
            flushSseLines();
            const fin = parser.finish();
            if (fin.items.length === 0) {
              const contentBytes = countUtf8Bytes(rawContentBuf);
              const streamBytes = totalBytesReceived;
              const rawHead = contentBytes > 0 ? safeSliceHead(rawContentBuf, 300) : (streamBytes > 0 ? safeSliceHead(rawStreamBuf, 300) : '');
              const errJson = isErrorJson(rawHead) || isErrorJson(rawContentBuf) || isErrorJson(rawStreamBuf);
              const err = createTypedError('INVALID_SCHEMA', errJson ? 'Provider returned error JSON response' : 'Translated content missing results array', false, {
                rawHead,
                contentBytes,
                streamBytes,
                finishReason: finishReason ?? null,
                items: 0,
                itemsCount: 0,
                malformed: fin.malformed,
                truncated: fin.truncated,
                reasoningOnlyChunks,
                zeroItem: !errJson,
                isErrorJson: errJson,
                schemaErrors: [
                  errJson ? 'Provider returned error JSON response' : `SSE stream yielded 0 items (malformed: ${fin.malformed}, truncated: ${fin.truncated}${reasoningOnlyChunks ? `, reasoningOnly: ${reasoningOnlyChunks}` : ''})`
                ]
              });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return { errorResult: err };
            }
            return {
              items: fin.items,
              model: sseModel,
              truncated: fin.truncated,
              finishReason,
              reasoningOnlyChunks
            };
          }

          // Read response body with byte cap check
          let rawText = '';
          let sseOut = null;
          if (isSseStream) {
            sseOut = await readSseResults();
            if (sseOut.errorResult) return sseOut.errorResult;
          }

          if (!isSseStream && resp.body && typeof resp.body.getReader === 'function') {
            const reader = resp.body.getReader();
            const onStreamAbort = () => {
              try { reader.cancel(internalController.signal.reason); } catch {}
            };
            if (internalController.signal.aborted) {
              onStreamAbort();
            } else {
              internalController.signal.addEventListener('abort', onStreamAbort, { once: true });
            }

            const chunks = [];
            let totalBytesReceived = 0;

            try {
              while (true) {
                if (internalController.signal.aborted) {
                  throw new DOMException('The operation was aborted', 'AbortError');
                }
                const { done, value } = await reader.read();
                if (internalController.signal.aborted) {
                  throw new DOMException('The operation was aborted', 'AbortError');
                }
                if (done) break;
                totalBytesReceived += value.length;
                if (totalBytesReceived > batchConfig.maxResponseBytes) {
                  try {
                    internalController.abort();
                  } catch {}
                  const err = createTypedError('CAP_EXCEEDED', `Response body exceeded limit of ${batchConfig.maxResponseBytes} bytes`, false, {
                    capType: 'responseBytes',
                    limit: batchConfig.maxResponseBytes,
                    actual: totalBytesReceived
                  });
                  err.elapsedMs = now() - batchStart;
                  err.model = targetModel;
                  return err;
                }
                chunks.push(value);
              }
            } finally {
              internalController.signal.removeEventListener('abort', onStreamAbort);
            }

            const merged = new Uint8Array(totalBytesReceived);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            rawText = new TextDecoder().decode(merged);
          } else if (!isSseStream && typeof resp.text === 'function') {
            rawText = await Promise.race([
              resp.text(),
              new Promise((_, reject) => {
                if (internalController.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
                internalController.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
              })
            ]);
            const byteLen = countUtf8Bytes(rawText);
            if (byteLen > batchConfig.maxResponseBytes) {
              const err = createTypedError('CAP_EXCEEDED', `Response body exceeded limit of ${batchConfig.maxResponseBytes} bytes`, false, {
                capType: 'responseBytes',
                limit: batchConfig.maxResponseBytes,
                actual: byteLen
              });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }
          }

          let responseJson = null;
          let parsedResults = null;
          if (sseOut) {
            parsedResults = { results: sseOut.items };
          } else {
            try {
              responseJson = JSON.parse(rawText);
            } catch {
              const err = createTypedError('INVALID_SCHEMA', 'Provider response is not valid JSON', false, {
                schemaErrors: ['Malformed outer response JSON']
              });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }

            const content = responseJson.choices && responseJson.choices[0] && responseJson.choices[0].message
              ? responseJson.choices[0].message.content
              : null;

            if (!content) {
              const errJson = (responseJson && typeof responseJson === 'object' && 'error' in responseJson) || isErrorJson(rawText);
              const err = createTypedError('INVALID_SCHEMA', errJson ? 'Provider returned error JSON response' : 'Missing choices[0].message.content in provider response', false, {
                rawHead: safeSliceHead(rawText, 300),
                contentBytes: countUtf8Bytes(rawText),
                zeroItem: !errJson,
                isErrorJson: errJson,
                schemaErrors: [errJson ? 'Provider returned error JSON response' : 'Missing message content']
              });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }

            parsedResults = parseLlmJson(content);
            if (!parsedResults || !Array.isArray(parsedResults.results)) {
              const contentBytes = countUtf8Bytes(content || '');
              const rawHead = contentBytes > 0 ? safeSliceHead(content || '', 300) : '';
              const errJson = isErrorJson(rawHead) || isErrorJson(content);
              const err = createTypedError('INVALID_SCHEMA', errJson ? 'Provider returned error JSON response' : 'Translated content missing results array', false, {
                rawHead,
                contentBytes,
                zeroItem: !errJson,
                isErrorJson: errJson,
                schemaErrors: [errJson ? 'Provider returned error JSON response' : 'Missing results array in LLM JSON output']
              });
              err.elapsedMs = now() - batchStart;
              err.model = targetModel;
              return err;
            }
          }

          return {
            ok: true,
            results: parsedResults.results,
            sseOut,
            responseJson
          };
        } catch (err) {
          if (signal?.aborted || callerAborted) {
            return createTypedError('ABORTED', 'Operation aborted by caller', false, {
              reason: signal?.reason ? String(signal.reason) : 'Caller aborted'
            });
          }

          if (timeoutTriggered || err.name === 'AbortError' || err.name === 'TimeoutError') {
            lastErrorResult = createTypedError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, false, {
              timeoutMs
            });
            lastErrorResult.elapsedMs = now() - batchStart;
            lastErrorResult.model = targetModel;

            if (timeoutRetries < maxTimeoutRetries) {
              timeoutRetries++;
              await delayWithJitter(retryTimeoutDelayMs, retryJitterRatio);
              if (signal?.aborted) {
                return createTypedError('ABORTED', 'Operation aborted by caller', false, {
                  reason: signal.reason ? String(signal.reason) : 'Caller aborted'
                });
              }
              continue;
            }
            return lastErrorResult;
          }

          lastErrorResult = createTypedError('NETWORK', err && err.message ? String(err.message) : 'Network error during request', true, {
            reason: err && err.message ? String(err.message) : 'Network error'
          });
          lastErrorResult.elapsedMs = now() - batchStart;
          lastErrorResult.model = targetModel;

          if (networkRetries < getMaxRetries()) {
            networkRetries++;
            const baseDelay = networkRetries === 1 ? retryInitialDelayMs : retryMaxDelayMs;
            await delayWithJitter(baseDelay, retryJitterRatio);
            if (signal?.aborted) {
              return createTypedError('ABORTED', 'Operation aborted by caller', false, {
                reason: signal.reason ? String(signal.reason) : 'Caller aborted'
              });
            }
            continue;
          }
          return lastErrorResult;
        } finally {
          clearTimeout(timeoutId);
          if (signal) {
            signal.removeEventListener('abort', onCallerAbort);
          }
        }
      }
    }

    function isBisectableZeroItem(attempt, batchItems, depth) {
      if (depth >= 3 || !Array.isArray(batchItems) || batchItems.length === 0) return false;
      const isZeroOrTruncated = (attempt?.error && attempt.error.code === 'INVALID_SCHEMA') ||
        (!attempt?.error && Array.isArray(attempt?.results) && attempt.results.length === 0);
      if (!isZeroOrTruncated) return false;

      const details = attempt?.error?.details || {};
      const rawHead = details.rawHead !== undefined ? details.rawHead : '';
      const contentBytes = details.contentBytes;

      // Stream rỗng hoàn toàn (0 bytes content) → error ngay, không bisect vô ích.
      if (contentBytes === 0 || !rawHead || typeof rawHead !== 'string' || rawHead.trim() === '') {
        return false;
      }

      // Phân biệt bằng rawHead có dấu hiệu JSON/results dở dang vs JSON rác toàn phần
      if (!hasJsonOrResultsSigns(rawHead)) {
        return false;
      }

      return true;
    }

    async function executeBatchWithBisect(batchItems, depth = 0, isRetry = false) {
      if (signal?.aborted) {
        return createTypedError('ABORTED', 'Operation aborted by caller', false, {
          reason: signal.reason ? String(signal.reason) : 'Caller aborted'
        });
      }

      const attempt = await executeSingleBatch(batchItems);

      if (signal?.aborted || attempt?.error?.code === 'ABORTED') {
        return createTypedError('ABORTED', 'Operation aborted by caller', false, {
          reason: signal?.reason ? String(signal.reason) : 'Caller aborted'
        });
      }

      if (!attempt.error && Array.isArray(attempt.results) && attempt.results.length > 0) {
        return attempt;
      }

      if (!isBisectableZeroItem(attempt, batchItems, depth)) {
        return attempt;
      }

      // F4: chỉ split khi CẢ HAI nửa đều ≥4 (tức batch ≥8 mới split);
      // batch <8 mà zero-item → 1 retry nguyên batch duy nhất rồi error.
      if (batchItems.length < 8) {
        if (isRetry) {
          return attempt;
        }
        if (signal?.aborted) {
          return createTypedError('ABORTED', 'Operation aborted by caller', false, {
            reason: signal.reason ? String(signal.reason) : 'Caller aborted'
          });
        }
        const retryAttempt = await executeSingleBatch(batchItems);
        if (signal?.aborted || retryAttempt?.error?.code === 'ABORTED') {
          return createTypedError('ABORTED', 'Operation aborted by caller', false, {
            reason: signal?.reason ? String(signal.reason) : 'Caller aborted'
          });
        }
        return retryAttempt;
      }

      // chia batch ĐÔI, retry từng nửa (chỉ khi batch >= 8, đảm bảo cả 2 nửa đều >= 4)
      const mid = Math.ceil(batchItems.length / 2);
      const firstHalf = batchItems.slice(0, mid);
      const secondHalf = batchItems.slice(mid);

      if (signal?.aborted) {
        return createTypedError('ABORTED', 'Operation aborted by caller', false, {
          reason: signal.reason ? String(signal.reason) : 'Caller aborted'
        });
      }

      const firstRes = await executeBatchWithBisect(firstHalf, depth + 1, false);
      if (signal?.aborted || firstRes?.error?.code === 'ABORTED') {
        return createTypedError('ABORTED', 'Operation aborted by caller', false, {
          reason: signal?.reason ? String(signal.reason) : 'Caller aborted'
        });
      }

      const secondRes = await executeBatchWithBisect(secondHalf, depth + 1, false);
      if (signal?.aborted || secondRes?.error?.code === 'ABORTED') {
        return createTypedError('ABORTED', 'Operation aborted by caller', false, {
          reason: signal?.reason ? String(signal.reason) : 'Caller aborted'
        });
      }

      const combinedResults = [];
      if (!firstRes.error && Array.isArray(firstRes.results)) {
        combinedResults.push(...firstRes.results);
      }
      if (!secondRes.error && Array.isArray(secondRes.results)) {
        combinedResults.push(...secondRes.results);
      }

      // gộp results; vẫn 0 item mới trả error.
      if (combinedResults.length === 0) {
        return firstRes.error ? firstRes : (secondRes.error ? secondRes : attempt);
      }

      return {
        ok: true,
        results: combinedResults,
        sseOut: secondRes.sseOut || firstRes.sseOut,
        responseJson: secondRes.responseJson || firstRes.responseJson
      };
    }

    function isZeroItemError(err) {
      if (!err) return false;
      const e = err.error || err;
      if (e.code !== 'INVALID_SCHEMA') return false;
      const details = e.details || {};
      const rawHead = details.rawHead || '';
      if (details.isErrorJson || isErrorJson(rawHead)) return false;
      if (details.zeroItem === true || details.items === 0 || details.itemsCount === 0) {
        return true;
      }
      const msg = String(e.message || '');
      if (msg.includes('missing results array') || msg.includes('Zero matching items') || msg.includes('0 items')) {
        return true;
      }
      return false;
    }

    const firstAttempt = await executeBatchWithBisect(items, 0);
    if (firstAttempt.error) {
      const errObj = firstAttempt.error.error || firstAttempt.error;
      const details = errObj.details || {};
      const rawHead = details.rawHead || '';
      const errJson = details.isErrorJson || isErrorJson(rawHead);
      if (!errJson && isZeroItemError(firstAttempt.error)) {
        errObj.details = {
          ...details,
          zeroItem: true,
          exhausted: true
        };
      }
      return firstAttempt;
    }

    const firstResults = firstAttempt.results;
    if (!Array.isArray(firstResults)) {
      const err = createTypedError('INVALID_SCHEMA', 'Translated content missing results array', false, {
        schemaErrors: ['Missing results array in LLM JSON output'],
        zeroItem: true,
        exhausted: true
      });
      err.elapsedMs = now() - batchStart;
      err.model = targetModel;
      return err;
    }

    const resultMap = new Map();
    const schemaErrors = [];

    for (const r of firstResults) {
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
      err.elapsedMs = now() - batchStart;
      err.model = targetModel;
      return err;
    }

    if (firstResults.length > items.length) {
      const err = createTypedError('INVALID_SCHEMA', `Results length (${firstResults.length}) exceeds input length (${items.length})`, false, {
        schemaErrors: [`Extra items in results: expected ${items.length}, got ${firstResults.length}`]
      });
      err.elapsedMs = now() - batchStart;
      err.model = targetModel;
      return err;
    }

    const matchedMap = new Map();
    const missingItems = [];

    for (const it of items) {
      const matched = resultMap.get(it.id);
      if (!matched) {
        missingItems.push(it);
        continue;
      }
      if (matched.revision !== it.revision) {
        const err = createTypedError('INVALID_SCHEMA', `Revision mismatch for item ${it.id}: expected ${it.revision}, got ${matched.revision}`, false, {
          schemaErrors: [`Revision mismatch for ${it.id}`]
        });
        err.elapsedMs = now() - batchStart;
        err.model = targetModel;
        return err;
      }
      matchedMap.set(it.id, {
        id: matched.id,
        revision: matched.revision,
        text: matched.text
      });
    }

    // Zero matched items (either firstResults empty, or none of the input items matched)
    if (matchedMap.size === 0) {
      const err = createTypedError('INVALID_SCHEMA', 'Zero matching items returned by provider', false, {
        schemaErrors: ['No matching results for input items'],
        zeroItem: true,
        exhausted: true
      });
      err.elapsedMs = now() - batchStart;
      err.model = targetModel;
      return err;
    }

    let retryAttempt = null;
    // Internal retry EXACTLY ONCE for missing items if any
    if (missingItems.length > 0) {
      if (signal?.aborted) {
        return createTypedError('ABORTED', 'Operation aborted by caller', false, {
          reason: signal.reason ? String(signal.reason) : 'Caller aborted'
        });
      }

      try {
        retryAttempt = await executeBatchWithBisect(missingItems, 0);
      } catch (e) {
        if (signal?.aborted) {
          return createTypedError('ABORTED', 'Operation aborted by caller', false, {
            reason: signal.reason ? String(signal.reason) : 'Caller aborted'
          });
        }
      }

      if (signal?.aborted || retryAttempt?.error?.code === 'ABORTED') {
        return createTypedError('ABORTED', 'Operation aborted by caller', false, {
          reason: signal?.reason ? String(signal.reason) : 'Caller aborted'
        });
      }

      if (retryAttempt && !retryAttempt.error && Array.isArray(retryAttempt.results)) {
        const retryMap = new Map();
        for (const r of retryAttempt.results) {
          if (r && typeof r.id === 'string' && typeof r.text === 'string' && typeof r.revision === 'number') {
            if (!retryMap.has(r.id)) {
              retryMap.set(r.id, r);
            }
          }
        }
        for (const it of missingItems) {
          const matched = retryMap.get(it.id);
          if (matched && matched.revision === it.revision) {
            matchedMap.set(it.id, {
              id: matched.id,
              revision: matched.revision,
              text: matched.text
            });
          }
        }
      }
    }

    const verifiedResults = [];
    const missingIds = [];
    for (const it of items) {
      if (matchedMap.has(it.id)) {
        verifiedResults.push(matchedMap.get(it.id));
      } else {
        missingIds.push(it.id);
      }
    }

    const partial = missingIds.length > 0;
    const firstModel = (firstAttempt.sseOut && firstAttempt.sseOut.model) || (firstAttempt.responseJson && firstAttempt.responseJson.model);
    const retryModel = (retryAttempt?.sseOut && retryAttempt.sseOut.model) || (retryAttempt?.responseJson && retryAttempt.responseJson.model);
    const actualModel = retryModel || firstModel || 'unknown';
    const elapsedMs = now() - batchStart;
    let actualBaseURLHost = '';
    try {
      actualBaseURLHost = new URL(baseURL).host;
    } catch {}

    return {
      results: verifiedResults,
      partial,
      missingIds,
      requestedModel: targetModel,
      actualModel,
      model: actualModel !== 'unknown' ? actualModel : targetModel,
      actualBaseURLHost,
      elapsedMs
    };
  }

  return {
    listModels,
    translateBatch
  };
}
