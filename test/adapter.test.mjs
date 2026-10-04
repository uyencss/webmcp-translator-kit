// WebMCP Translator Kit — Direct 9router Adapter Unit Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirect9Router } from '../extension/src/adapter/direct9router.mjs';
import { createFakeProvider } from './helpers/fake-provider.mjs';

const fastOptions = {
  timeoutMs: 120,
  listModelsTimeoutMs: 500,
  retryInitialDelayMs: 15,
  retryMaxDelayMs: 30,
  retryTimeoutDelayMs: 20,
  retryJitterRatio: 0.1
};

test('Case 1: listModels ok, cache hit, invalidation on baseURL/apiKey change', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const config = {
      baseURL,
      apiKey: 'test-key-1',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    };
    const router = createDirect9Router(config);

    // First call -> cache miss, fetches models
    const res1 = await router.listModels();
    assert.ok(Array.isArray(res1.models), 'res1.models should be an array');
    assert.equal(res1.models.length, 2);
    assert.equal(fake.getLog().length, 1, 'Expected exactly 1 request to provider');

    // Second call -> cache hit! No new HTTP request
    const res2 = await router.listModels();
    assert.deepEqual(res2, res1);
    assert.equal(fake.getLog().length, 1, 'Expected still 1 request due to cache hit');

    // Invalidation on baseURL change
    config.baseURL = `${baseURL}/modified`;
    const res3 = await router.listModels();
    assert.ok(Array.isArray(res3.models));
    assert.equal(fake.getLog().length, 2, 'Expected new request after baseURL change');

    // Invalidation on apiKey change
    config.apiKey = 'test-key-2';
    const res4 = await router.listModels();
    assert.ok(Array.isArray(res4.models));
    assert.equal(fake.getLog().length, 3, 'Expected new request after apiKey change');

    // Review A2 finding: listModels after TTL (using injectable now) -> re-queries provider (cache miss)
    let simulatedNow = 1000;
    const ttlRouter = createDirect9Router({
      baseURL,
      apiKey: 'test-key-ttl',
      model: 'ag/gemini-3.1-pro-low',
      listModelsTtlMs: 300000,
      now: () => simulatedNow,
      ...fastOptions
    });
    fake.clearLog();
    const ttlRes1 = await ttlRouter.listModels();
    assert.ok(Array.isArray(ttlRes1.models));
    assert.equal(fake.getLog().length, 1, 'Initial call should hit provider');

    // Call before TTL -> cache hit
    simulatedNow += 200000; // 200s < 300s TTL
    const ttlRes2 = await ttlRouter.listModels();
    assert.deepEqual(ttlRes2, ttlRes1);
    assert.equal(fake.getLog().length, 1, 'Call before TTL should use cache');

    // Call after TTL -> cache miss, re-fetch from provider
    simulatedNow += 150000; // total 350s > 300s TTL
    const ttlRes3 = await ttlRouter.listModels();
    assert.ok(Array.isArray(ttlRes3.models));
    assert.equal(fake.getLog().length, 2, 'Call after TTL should re-query provider');
  } finally {
    await fake.stop();
  }
});

test('Case 2: listModels HTTP errors (401, 403, 404, 429, 5xx) and network error', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const config = {
      baseURL,
      apiKey: 'test-key',
      ...fastOptions
    };
    const router = createDirect9Router(config);

    // 401
    fake.setMode('http_error', { statusCode: 401 });
    config.apiKey = 'key-401';
    const err401 = await router.listModels();
    assert.equal(err401.error?.code, 'HTTP_401');
    assert.equal(err401.error?.retryable, false);
    assert.equal(err401.error?.details?.status, 401);

    // 403
    fake.setMode('http_error', { statusCode: 403 });
    config.apiKey = 'key-403';
    const err403 = await router.listModels();
    assert.equal(err403.error?.code, 'HTTP_403');
    assert.equal(err403.error?.retryable, false);
    assert.equal(err403.error?.details?.status, 403);

    // 404
    fake.setMode('http_error', { statusCode: 404 });
    config.apiKey = 'key-404';
    const err404 = await router.listModels();
    assert.equal(err404.error?.code, 'HTTP_404');
    assert.equal(err404.error?.retryable, false);
    assert.equal(err404.error?.details?.status, 404);

    // 429
    fake.setMode('rate_limit', { retryAfter: '1' });
    config.apiKey = 'key-429';
    const err429 = await router.listModels();
    assert.equal(err429.error?.code, 'HTTP_429');
    assert.equal(err429.error?.retryable, true);
    assert.equal(err429.error?.details?.status, 429);

    // 5xx (500)
    fake.setMode('http_error', { statusCode: 500 });
    config.apiKey = 'key-500';
    const err500 = await router.listModels();
    assert.equal(err500.error?.code, 'HTTP_5xx');
    assert.equal(err500.error?.retryable, true);
    assert.equal(err500.error?.details?.status, 500);

    // Network error (unreachable host/port)
    const deadRouter = createDirect9Router({
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
      ...fastOptions
    });
    const errNet = await deadRouter.listModels();
    assert.equal(errNet.error?.code, 'NETWORK');
    assert.equal(errNet.error?.retryable, true);
    assert.ok(errNet.error?.details?.reason);
  } finally {
    await fake.stop();
  }
});

test('Case 3: listModels timeout and empty models list (INVALID_SCHEMA)', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const config = {
      baseURL,
      apiKey: 'test-key-timeout',
      ...fastOptions,
      listModelsTimeoutMs: 60
    };
    const router = createDirect9Router(config);

    // Timeout
    fake.setMode('hang');
    const errTimeout = await router.listModels();
    assert.equal(errTimeout.error?.code, 'TIMEOUT');
    assert.equal(errTimeout.error?.retryable, false);
    assert.equal(errTimeout.error?.details?.timeoutMs, 60);

    // Empty models list -> INVALID_SCHEMA
    fake.setMode('models_empty');
    config.apiKey = 'test-key-empty';
    const errEmpty = await router.listModels();
    assert.equal(errEmpty.error?.code, 'INVALID_SCHEMA');
    assert.equal(errEmpty.error?.retryable, false);
  } finally {
    await fake.stop();
  }
});

test('Case 4: translateBatch happy path (bijection preservation)', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    });

    const items = [
      { id: 'item-1', revision: 0, text: 'Hello' },
      { id: 'item-2', revision: 3, text: 'World' }
    ];

    const res = await router.translateBatch({
      items,
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      model: 'ag/gemini-3.1-pro-low'
    });

    assert.ok(!res.error, 'Expected success without error: ' + JSON.stringify(res.error));
    assert.equal(res.requestedModel, 'ag/gemini-3.1-pro-low');
    assert.equal(res.actualModel, 'ag/gemini-3.1-pro-low');
    assert.equal(res.model, 'ag/gemini-3.1-pro-low');
    assert.ok(typeof res.elapsedMs === 'number');

    assert.equal(res.results.length, 2);
    assert.deepEqual(res.results[0], { id: 'item-1', revision: 0, text: '[translated] Hello' });
    assert.deepEqual(res.results[1], { id: 'item-2', revision: 3, text: '[translated] World' });
  } finally {
    await fake.stop();
  }
});

test('Case 5: Caps enforcement (items, requestBytes, responseBytes)', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    });

    // 1. Items cap: 65 items (> 64)
    const tooManyItems = [];
    for (let i = 0; i < 65; i++) {
      tooManyItems.push({ id: `id-${i}`, revision: 0, text: 'short' });
    }
    const errItems = await router.translateBatch({ items: tooManyItems });
    assert.equal(errItems.error?.code, 'CAP_EXCEEDED');
    assert.equal(errItems.error?.details?.capType, 'items');
    assert.equal(errItems.error?.details?.limit, 64);
    assert.equal(errItems.error?.details?.actual, 65);

    // 2. Request bytes cap: 25 KiB (> 24576 bytes)
    const bigItem = [{ id: 'big-1', revision: 0, text: 'A'.repeat(25000) }];
    const errBytes = await router.translateBatch({ items: bigItem });
    assert.equal(errBytes.error?.code, 'CAP_EXCEEDED');
    assert.equal(errBytes.error?.details?.capType, 'requestBytes');
    assert.equal(errBytes.error?.details?.limit, 24576);
    assert.equal(errBytes.error?.details?.actual, 25000);

    // 3. Response bytes cap: provider returns > 65536 bytes
    fake.setMode('oversized');
    const normalItems = [{ id: 'item-1', revision: 0, text: 'test' }];
    const errResp = await router.translateBatch({ items: normalItems });
    assert.equal(errResp.error?.code, 'CAP_EXCEEDED');
    assert.equal(errResp.error?.details?.capType, 'responseBytes');
    assert.equal(errResp.error?.details?.limit, 65536);
  } finally {
    await fake.stop();
  }
});

test('Case 6: Schema and bijection edge cases', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    });

    const items = [
      { id: 'i1', revision: 0, text: 'one' },
      { id: 'i2', revision: 1, text: 'two' }
    ];

    // Bad outer JSON
    fake.setMode('bad_json');
    const errBadOuter = await router.translateBatch({ items });
    assert.equal(errBadOuter.error?.code, 'INVALID_SCHEMA');

    // Missing results field
    fake.setMode('missing_results_field');
    const errMissingField = await router.translateBatch({ items });
    assert.equal(errMissingField.error?.code, 'INVALID_SCHEMA');

    // Bad inner JSON
    fake.setMode('bad_inner_json');
    const errBadInner = await router.translateBatch({ items });
    assert.equal(errBadInner.error?.code, 'INVALID_SCHEMA');

    // Length mismatch (WI-20: partial match returns success with partial: true, missingIds: ['i2'])
    fake.setMode('wrong_length');
    const resLen = await router.translateBatch({ items });
    assert.equal(resLen.partial, true);
    assert.deepEqual(resLen.missingIds, ['i2']);
    assert.equal(resLen.results?.length, 1);
    assert.equal(resLen.results?.[0]?.id, 'i1');

    // Missing ID (WI-20: partial match returns success with partial: true, missingIds: ['i1'])
    fake.setMode('missing_id');
    const resMissingId = await router.translateBatch({ items });
    assert.equal(resMissingId.partial, true);
    assert.deepEqual(resMissingId.missingIds, ['i1']);
    assert.equal(resMissingId.results?.length, 1);
    assert.equal(resMissingId.results?.[0]?.id, 'i2');

    // Zero-match: when 0 items match input -> INVALID_SCHEMA
    const resZeroMatch = await router.translateBatch({
      items: [{ id: 'zero-only', revision: 0, text: 'hello' }]
    });
    assert.equal(resZeroMatch.error?.code, 'INVALID_SCHEMA');

    // Extra ID
    fake.setMode('extra_id');
    const errExtraId = await router.translateBatch({ items });
    assert.equal(errExtraId.error?.code, 'INVALID_SCHEMA');

    // Duplicate ID
    fake.setMode('duplicate_id');
    const errDup = await router.translateBatch({ items });
    assert.equal(errDup.error?.code, 'INVALID_SCHEMA');

    // Revision mismatch
    fake.setMode('revision_mismatch');
    const errRev = await router.translateBatch({ items });
    assert.equal(errRev.error?.code, 'INVALID_SCHEMA');

    // Markdown-fenced JSON -> OK!
    fake.setMode('fenced_json');
    const resFenced = await router.translateBatch({ items });
    assert.ok(!resFenced.error, 'Fenced JSON should be successfully parsed');
    assert.equal(resFenced.results?.length, 2);
  } finally {
    await fake.stop();
  }
});

test('Case 7: Retry policy (429, 500, timeout, 401)', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions,
      sleep: () => Promise.resolve() // instant sleep in tests
    });

    const items = [{ id: 'retry-item', revision: 0, text: 'hello' }];

    // 1. 429 with Retry-After: 1s -> retries once and succeeds
    fake.clearLog();
    fake.setMode('rate_limit', { rateLimitCount: 1, retryAfter: '1' });
    const res429 = await router.translateBatch({ items });
    assert.ok(!res429.error, '429 retry should succeed');
    assert.equal(fake.getLog().length, 2, 'Expected 2 attempts for 429 retry');

    // 2. 500: retries twice and succeeds
    fake.clearLog();
    fake.setMode('http_500_twice');
    const res500Success = await router.translateBatch({ items });
    assert.ok(!res500Success.error, '500 twice then success should succeed');
    assert.equal(fake.getLog().length, 3, 'Expected 3 attempts (1 initial + 2 retries)');

    // 3. 500: retries twice and exhausts retries -> HTTP_5xx
    fake.clearLog();
    fake.setMode('http_error', { statusCode: 500 });
    const err500Fail = await router.translateBatch({ items });
    assert.equal(err500Fail.error?.code, 'HTTP_5xx');
    assert.equal(fake.getLog().length, 3, 'Expected 3 attempts before exhausting retries');

    // 4. Timeout: retries once and succeeds
    fake.clearLog();
    fake.setMode('timeout_once', { delayMs: 150 });
    const resTimeoutSuccess = await router.translateBatch({ items });
    assert.ok(!resTimeoutSuccess.error, 'Timeout retry should succeed');
    assert.equal(fake.getLog().length, 2, 'Expected 2 attempts for timeout retry');

    // 5. 401: strictly NO retry
    fake.clearLog();
    fake.setMode('http_error', { statusCode: 401 });
    const err401 = await router.translateBatch({ items });
    assert.equal(err401.error?.code, 'HTTP_401');
    assert.equal(fake.getLog().length, 1, 'Expected exactly 1 request for 401 (no retries)');
  } finally {
    await fake.stop();
  }
});

test('Case 8: Model pinning & no fallback', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'default-config-model',
      ...fastOptions
    });

    const items = [{ id: 'pin-1', revision: 0, text: 'pin test' }];

    // Request with explicit model
    const res = await router.translateBatch({
      items,
      model: 'pinned-explicit-model-v2'
    });

    assert.ok(!res.error);
    assert.equal(res.requestedModel, 'pinned-explicit-model-v2');
    assert.equal(res.actualModel, 'pinned-explicit-model-v2');
    assert.equal(res.model, 'pinned-explicit-model-v2');

    // Verify request body on wire
    const log = fake.getLog();
    assert.equal(log.length, 1);
    const sentPayload = JSON.parse(log[0].body);
    assert.equal(sentPayload.model, 'pinned-explicit-model-v2', 'Sent model must match requested model');

    // Case 8 supplement (Review A2 finding): caller does not pass model -> adapter defaults to config.model
    fake.clearLog();
    const resDefaultModel = await router.translateBatch({ items });
    assert.ok(!resDefaultModel.error);
    assert.equal(resDefaultModel.requestedModel, 'default-config-model');
    assert.equal(resDefaultModel.actualModel, 'default-config-model');
    assert.equal(resDefaultModel.model, 'default-config-model');
    const log2 = fake.getLog();
    assert.equal(log2.length, 1);
    const sent2 = JSON.parse(log2[0].body);
    assert.equal(sent2.model, 'default-config-model', 'Sent model must match config.model when omitted');
  } finally {
    await fake.stop();
  }
});

test('Case 9: Abort signal handling', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions,
      timeoutMs: 1000
    });

    const items = [{ id: 'abort-1', revision: 0, text: 'abort me' }];

    // 1. Caller aborts during request
    fake.setMode('delay', { delayMs: 250 });
    const controller = new AbortController();
    const pending = router.translateBatch({
      items,
      signal: controller.signal
    });
    const requestDeadline = Date.now() + 1000;
    while (fake.getLog().length === 0 && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fake.getLog().length, 1, 'fake server must receive the request before aborting');
    controller.abort('User navigated away');
    const resAbort = await pending;

    assert.equal(resAbort.error?.code, 'ABORTED');
    assert.equal(resAbort.error?.retryable, false);
    assert.equal(fake.getLog().length, 1, 'Aborted request should not retry');

    // 2. Pre-aborted signal
    fake.clearLog();
    const preAborted = AbortSignal.abort('Pre aborted');
    const resPreAbort = await router.translateBatch({
      items,
      signal: preAborted
    });
    assert.equal(resPreAbort.error?.code, 'ABORTED');
    assert.equal(fake.getLog().length, 0, 'Pre-aborted request should never hit network');
  } finally {
    await fake.stop();
  }
});

test('Case 10: Privacy invariant: error objects never contain item text', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    });

    const sensitiveText = 'SECRET_PAGE_CONTENT_987654321';
    const items = [{ id: 'priv-1', revision: 0, text: sensitiveText }];

    // CAP_EXCEEDED
    const tooMany = Array.from({ length: 65 }, (_, i) => ({ id: `id-${i}`, revision: 0, text: sensitiveText }));
    const errCap = await router.translateBatch({ items: tooMany });
    assert.ok(!JSON.stringify(errCap).includes(sensitiveText), 'CAP_EXCEEDED must not contain text');

    // INVALID_SCHEMA
    fake.setMode('missing_id');
    const errSchema = await router.translateBatch({ items });
    assert.ok(!JSON.stringify(errSchema).includes(sensitiveText), 'INVALID_SCHEMA must not contain text');

    // HTTP_401
    fake.setMode('http_error', { statusCode: 401 });
    const err401 = await router.translateBatch({ items });
    assert.ok(!JSON.stringify(err401).includes(sensitiveText), 'HTTP_401 must not contain text');

    // HTTP_429
    fake.setMode('rate_limit', { rateLimitCount: 10, retryAfter: 15 });
    const err429 = await router.translateBatch({ items });
    assert.ok(!JSON.stringify(err429).includes(sensitiveText), 'HTTP_429 must not contain text');

    // TIMEOUT
    fake.setMode('hang');
    const errTimeout = await router.translateBatch({ items });
    assert.ok(!JSON.stringify(errTimeout).includes(sensitiveText), 'TIMEOUT must not contain text');
  } finally {
    await fake.stop();
  }
});

test('H1 (a): translateBatch times out when body stream stalls after HTTP 200', async () => {
  const neverEndingStream = new ReadableStream({
    start() {
      // Intentionally never calls controller.close() or enqueue()
    }
  });
  const mockFetch = async () => new Response(neverEndingStream, {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const router = createDirect9Router({
    baseURL: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 50,
    maxTimeoutRetries: 0,
    fetchImpl: mockFetch
  });

  const t0 = Date.now();
  const res = await router.translateBatch({
    items: [{ id: '1', revision: 0, text: 'hello' }]
  });
  const elapsed = Date.now() - t0;

  assert.ok(res.error, 'Expected error response');
  assert.equal(res.error.code, 'TIMEOUT');
  assert.ok(elapsed <= 300, `Expected elapsed <= 300ms, got ${elapsed}ms`);
});

test('H1 (b): listModels times out when body json stalls after HTTP 200', async () => {
  const neverEndingStream = new ReadableStream({
    start() {
      // Intentionally never calls controller.close() or enqueue()
    }
  });
  const mockFetch = async () => new Response(neverEndingStream, {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const router = createDirect9Router({
    baseURL: 'https://example.com/v1',
    apiKey: 'test-key',
    listModelsTimeoutMs: 50,
    fetchImpl: mockFetch
  });

  const t0 = Date.now();
  const res = await router.listModels();
  const elapsed = Date.now() - t0;

  assert.ok(res.error, 'Expected error response');
  assert.equal(res.error.code, 'TIMEOUT');
  assert.ok(elapsed <= 300, `Expected elapsed <= 300ms, got ${elapsed}ms`);
});

test('H1 (c): translateBatch times out when stream stalls mid-body after initial chunks', async () => {
  const partialStream = new ReadableStream({
    start(controller) {
      // Send opening chunk, then stall forever
      controller.enqueue(new TextEncoder().encode('{"model":"test-model","choices":[{"message":{"content":"'));
    }
  });
  const mockFetch = async () => new Response(partialStream, {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const router = createDirect9Router({
    baseURL: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 50,
    maxTimeoutRetries: 0,
    fetchImpl: mockFetch
  });

  const t0 = Date.now();
  const res = await router.translateBatch({
    items: [{ id: '1', revision: 0, text: 'hello' }]
  });
  const elapsed = Date.now() - t0;

  assert.ok(res.error, 'Expected error response');
  assert.equal(res.error.code, 'TIMEOUT');
  assert.ok(elapsed <= 300, `Expected elapsed <= 300ms, got ${elapsed}ms`);
});

test('N5: router.listModels accepts per-call baseURL and apiKey parameters', async () => {
  const fake = createFakeProvider();
  const { baseURL } = await fake.start();

  try {
    const router = createDirect9Router({
      baseURL: 'http://invalid-initial-host.example.com',
      apiKey: 'invalid-initial-key',
      ...fastOptions
    });

    const res = await router.listModels({
      baseURL,
      apiKey: 'per-call-key'
    });

    assert.ok(Array.isArray(res.models), 'Models list should be returned');
    assert.equal(fake.getLog().length, 1, 'Fake provider should receive exactly 1 request');
  } finally {
    await fake.stop();
  }
});

test('WI-10 (b): retry-bỏ-temperature 1 lần khi gặp HTTP 400', async () => {
  const requests = [];
  const mockFetch = async (url, options) => {
    const bodyStr = options.body;
    const bodyJson = JSON.parse(bodyStr);
    requests.push({ url, options, bodyJson });

    if (requests.length === 1) {
      // First request: verify temperature was sent, respond with HTTP 400
      assert.equal(bodyJson.temperature, 0.1, 'First request must include temperature');
      return new Response(JSON.stringify({
        error: { message: 'temperature is not supported for this model' }
      }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Second request: retry should NOT include temperature
    assert.equal('temperature' in bodyJson, false, 'Retry request must omit temperature');
    assert.equal(bodyJson.model, 'do/glm-5.3-flash');
    assert.ok(Array.isArray(bodyJson.messages));

    const responseContent = JSON.stringify({
      results: [
        { id: 'item-1', revision: 1, text: 'Bản dịch thử nghiệm' }
      ]
    });

    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      model: 'do/glm-5.3-flash',
      choices: [{ message: { role: 'assistant', content: responseContent } }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const router = createDirect9Router({
    baseURL: 'https://router.example.com/v1',
    apiKey: 'test-key',
    model: 'do/glm-5.3-flash',
    fetchImpl: mockFetch,
    ...fastOptions
  });

  const res = await router.translateBatch({
    items: [{ id: 'item-1', revision: 1, text: 'Test text' }]
  });

  assert.equal(requests.length, 2, 'Must retry exactly once');
  assert.ok(res.results, 'Translation should succeed after retry without temperature');
  assert.equal(res.results[0].text, 'Bản dịch thử nghiệm');
});

test('WI-10 (b): retry-bỏ-temperature chỉ retry ĐÚNG 1 lần khi vẫn gặp HTTP 400', async () => {
  let callCount = 0;
  const bodies = [];
  const mockFetch = async (url, options) => {
    callCount++;
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      error: { message: 'Still invalid request' }
    }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const router = createDirect9Router({
    baseURL: 'https://router.example.com/v1',
    apiKey: 'test-key',
    model: 'do/glm-5.3-flash',
    fetchImpl: mockFetch,
    ...fastOptions
  });

  const res = await router.translateBatch({
    items: [{ id: 'item-1', revision: 1, text: 'Test' }]
  });

  assert.equal(callCount, 2, 'Must retry at most once (total 2 attempts)');
  assert.equal('temperature' in bodies[0], true, 'Attempt 1 had temperature');
  assert.equal('temperature' in bodies[1], false, 'Attempt 2 omitted temperature');
  assert.ok(res.error, 'Must return error after retry fails');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
});

test('WI-10 (a): body lỗi provider xuất hiện trong details và schemaErrors khi HTTP 4xx', async () => {
  const providerErrorJson = JSON.stringify({
    error: {
      message: 'Model glm-5.3-flash does not exist or quota exhausted',
      type: 'invalid_request_error',
      code: 'model_not_found'
    }
  });

  // Test with JSON error body (after single retry when 400)
  const mockFetchJson = async () => new Response(providerErrorJson, {
    status: 400,
    statusText: 'Bad Request',
    headers: { 'Content-Type': 'application/json' }
  });

  const router = createDirect9Router({
    baseURL: 'https://router.example.com/v1',
    apiKey: 'test-key',
    model: 'do/glm-5.3-flash',
    fetchImpl: mockFetchJson,
    ...fastOptions
  });

  const res = await router.translateBatch({
    items: [{ id: 'item-1', revision: 1, text: 'Test' }]
  });

  assert.ok(res.error, 'Expected error response');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
  assert.ok(res.error.details, 'Error must contain details');
  assert.ok(
    res.error.details.body?.includes('Model glm-5.3-flash does not exist') ||
    res.error.details.providerBody?.includes('Model glm-5.3-flash does not exist'),
    'Provider body must appear in details'
  );
  assert.ok(
    res.error.details.schemaErrors.some(e => e.includes('Model glm-5.3-flash does not exist')),
    'Provider message must appear in schemaErrors'
  );

  // Test with plain text error body
  const plainTextError = 'Custom raw error message from 9router gateway';
  const mockFetchPlain = async () => new Response(plainTextError, {
    status: 422,
    statusText: 'Unprocessable Entity',
    headers: { 'Content-Type': 'text/plain' }
  });

  const routerPlain = createDirect9Router({
    baseURL: 'https://router.example.com/v1',
    apiKey: 'test-key',
    model: 'do/glm-5.3-flash',
    fetchImpl: mockFetchPlain,
    ...fastOptions
  });

  const resPlain = await routerPlain.translateBatch({
    items: [{ id: 'item-1', revision: 1, text: 'Test' }]
  });

  assert.ok(resPlain.error, 'Expected error response');
  assert.equal(resPlain.error.code, 'INVALID_SCHEMA');
  assert.ok(resPlain.error.details, 'Error must contain details');
  assert.equal(resPlain.error.details.body, plainTextError, 'Plain text body must appear in details.body');
  assert.ok(
    resPlain.error.details.schemaErrors.some(e => e.includes(plainTextError)),
    'Plain text error must appear in schemaErrors'
  );
});

test('WI-20: merge sau retry khi thiếu item ở lượt đầu', async () => {
  let callCount = 0;
  const mockFetch = async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user');
    const inputItems = JSON.parse(userMsg.content);

    if (callCount === 1) {
      // First attempt: returns only first item
      const results = [{ id: inputItems[0].id, revision: inputItems[0].revision, text: `[trans] ${inputItems[0].text}` }];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ results }) } }],
        model: 'test-model'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Retry attempt: inputItems contains only the missing items
    assert.equal(inputItems.length, 1);
    assert.equal(inputItems[0].id, 'item-2');
    const results = [{ id: inputItems[0].id, revision: inputItems[0].revision, text: `[trans] ${inputItems[0].text}` }];
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ results }) } }],
      model: 'test-model'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const router = createDirect9Router({
    baseURL: 'https://test.router/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.1-pro-low',
    fetchImpl: mockFetch,
    ...fastOptions
  });

  const res = await router.translateBatch({
    items: [
      { id: 'item-1', revision: 0, text: 'First' },
      { id: 'item-2', revision: 0, text: 'Second' }
    ]
  });

  assert.equal(callCount, 2, 'Must have made 2 calls (initial + 1 retry)');
  assert.equal(res.partial, false, 'partial should be false after all items matched in retry');
  assert.deepEqual(res.missingIds, [], 'missingIds should be empty');
  assert.equal(res.results.length, 2, 'Should merge results from both passes');
  assert.equal(res.results[0].id, 'item-1');
  assert.equal(res.results[1].id, 'item-2');
  assert.equal(res.results[0].text, '[trans] First');
  assert.equal(res.results[1].text, '[trans] Second');
});

test('WI-20: zero-match vẫn trả về lỗi INVALID_SCHEMA', async () => {
  const mockFetch = async () => {
    // Return empty results array or non-matching IDs
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ results: [] }) } }],
      model: 'test-model'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const router = createDirect9Router({
    baseURL: 'https://test.router/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.1-pro-low',
    fetchImpl: mockFetch,
    ...fastOptions
  });

  const res = await router.translateBatch({
    items: [{ id: 'item-1', revision: 0, text: 'First' }]
  });

  assert.ok(res.error, 'Must return error object');
  assert.equal(res.error.code, 'INVALID_SCHEMA');
});

test('WI-20: abort giữa retry trả về lỗi ABORTED', async () => {
  let callCount = 0;
  const ac = new AbortController();

  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      // First attempt: returns partial
      const results = [{ id: 'item-1', revision: 0, text: 'First translated' }];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ results }) } }],
        model: 'test-model'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Before or during second call, trigger abort
    ac.abort('aborted_during_retry');
    throw new DOMException('The operation was aborted', 'AbortError');
  };

  const router = createDirect9Router({
    baseURL: 'https://test.router/v1',
    apiKey: 'test-key',
    model: 'ag/gemini-3.1-pro-low',
    fetchImpl: mockFetch,
    ...fastOptions
  });

  const res = await router.translateBatch({
    items: [
      { id: 'item-1', revision: 0, text: 'First' },
      { id: 'item-2', revision: 0, text: 'Second' }
    ],
    signal: ac.signal
  });

  assert.ok(res.error, 'Must return error on abort');
  assert.equal(res.error.code, 'ABORTED');
});
