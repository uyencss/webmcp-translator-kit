// WebMCP Translator Kit — Direct 9router Adapter
// Contract Version: webmcp-translator-contract/1
// Pure module: No chrome.* APIs used.

function normalizeBaseURL(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/+$/, '');
}

function countUtf8Bytes(str) {
  return new TextEncoder().encode(str).length;
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
    const baseURL = getBaseURL();
    const apiKey = getApiKey();

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
    const { items, sourceLanguage = 'auto', targetLanguage = 'vi', model, signal } = input;
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

    const requestBody = JSON.stringify({
      model: targetModel,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(requestItems) }
      ],
      temperature: 0.1
    });

    const batchStart = now();
    let timeoutRetries = 0;
    let networkRetries = 0;
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
            Accept: 'application/json'
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

          const err = createTypedError('INVALID_SCHEMA', `Provider returned HTTP ${status}`, false, {
            schemaErrors: [`HTTP_${status}: ${statusText}`]
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

        // Read response body with byte cap check
        let rawText = '';
        if (resp.body && typeof resp.body.getReader === 'function') {
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
        } else if (typeof resp.text === 'function') {
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
          const err = createTypedError('INVALID_SCHEMA', 'Missing choices[0].message.content in provider response', false, {
            schemaErrors: ['Missing message content']
          });
          err.elapsedMs = now() - batchStart;
          err.model = targetModel;
          return err;
        }

        const parsedResults = parseLlmJson(content);
        if (!parsedResults || !Array.isArray(parsedResults.results)) {
          const err = createTypedError('INVALID_SCHEMA', 'Translated content missing results array', false, {
            schemaErrors: ['Missing results array in LLM JSON output']
          });
          err.elapsedMs = now() - batchStart;
          err.model = targetModel;
          return err;
        }

        const results = parsedResults.results;

        // Bijection validation
        if (results.length !== items.length) {
          const err = createTypedError('INVALID_SCHEMA', `Results length (${results.length}) does not match input length (${items.length})`, false, {
            schemaErrors: [`Length mismatch: expected ${items.length}, got ${results.length}`]
          });
          err.elapsedMs = now() - batchStart;
          err.model = targetModel;
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
          err.elapsedMs = now() - batchStart;
          err.model = targetModel;
          return err;
        }

        const verifiedResults = [];
        for (const it of items) {
          const matched = resultMap.get(it.id);
          if (!matched) {
            const err = createTypedError('INVALID_SCHEMA', `Missing translation result for input id: ${it.id}`, false, {
              schemaErrors: [`Missing result for item ${it.id}`]
            });
            err.elapsedMs = now() - batchStart;
            err.model = targetModel;
            return err;
          }
          if (matched.revision !== it.revision) {
            const err = createTypedError('INVALID_SCHEMA', `Revision mismatch for item ${it.id}: expected ${it.revision}, got ${matched.revision}`, false, {
              schemaErrors: [`Revision mismatch for ${it.id}`]
            });
            err.elapsedMs = now() - batchStart;
            err.model = targetModel;
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
        const elapsedMs = now() - batchStart;
        let actualBaseURLHost = '';
        try {
          actualBaseURLHost = new URL(baseURL).host;
        } catch {}

        return {
          results: verifiedResults,
          requestedModel: targetModel,
          actualModel,
          model: actualModel !== 'unknown' ? actualModel : targetModel,
          actualBaseURLHost,
          elapsedMs
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

  return {
    listModels,
    translateBatch
  };
}
