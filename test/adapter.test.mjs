// WebMCP Translator Kit — Direct 9router Adapter Unit Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirect9Router } from '../extension/src/adapter/direct9router.mjs';
import { createFakeProvider } from './helpers/fake-provider.mjs';

const fastOptions = {
  timeoutMs: 120,
  listModelsTimeoutMs: 120,
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

    // Length mismatch
    fake.setMode('wrong_length');
    const errLen = await router.translateBatch({ items });
    assert.equal(errLen.error?.code, 'INVALID_SCHEMA');

    // Missing ID
    fake.setMode('missing_id');
    const errMissingId = await router.translateBatch({ items });
    assert.equal(errMissingId.error?.code, 'INVALID_SCHEMA');

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
      ...fastOptions
    });

    const items = [{ id: 'abort-1', revision: 0, text: 'abort me' }];

    // 1. Caller aborts during request
    fake.setMode('delay', { delayMs: 250 });
    const controller = new AbortController();
    setTimeout(() => controller.abort('User navigated away'), 20);

    const resAbort = await router.translateBatch({
      items,
      signal: controller.signal
    });

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
    baseURL: 'http://example.com/v1',
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
    baseURL: 'http://example.com/v1',
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
    baseURL: 'http://example.com/v1',
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

