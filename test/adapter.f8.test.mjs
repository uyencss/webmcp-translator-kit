// WebMCP Translator Kit — F8 Adapter Network Resilience Unit Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDirect9Router } from '../extension/src/adapter/direct9router.mjs';

const fastOptions = {
  timeoutMs: 1000,
  listModelsTimeoutMs: 500,
  maxRetries: 2,
  retryInitialDelayMs: 15,
  retryMaxDelayMs: 30,
  retryTimeoutDelayMs: 20,
  retryJitterRatio: 0.1
};

test('F8 Case 1: Destroy socket mid-response -> typed NETWORK retryable after 3 attempts, zero text leakage', async () => {
  let attempts = 0;

  const server = http.createServer((req, res) => {
    attempts++;
    req.on('data', () => {});
    req.on('end', () => {
      // Send partial response then abruptly destroy the underlying socket
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('{"choices":[{"message":{"content":"{\\"results\\":[');
      setTimeout(() => {
        try { req.socket.destroy(); } catch {}
      }, 5);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    });

    const secretText = 'TOP_SECRET_PROMPT_F8_MID_RESPONSE_789';
    const result = await router.translateBatch({
      items: [{ id: 'f8-1', revision: 0, text: secretText }],
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: 'ag/gemini-3.1-pro-low'
    });

    assert.ok(result.error, 'Expected error result from mid-response socket destroy');
    assert.equal(result.error.code, 'NETWORK', `Expected NETWORK error code, got: ${result.error.code}`);
    assert.equal(result.error.retryable, true, 'NETWORK error must be retryable');
    assert.equal(attempts, 3, `Expected exactly 3 attempts (1 initial + 2 retries), got: ${attempts}`);

    // Text privacy assertion: secretText must never leak into error message or details
    const errString = JSON.stringify(result);
    assert.ok(!errString.includes(secretText), 'Error object must not leak input item text');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('F8 Case 2: Destroy socket mid-request -> typed NETWORK retryable after 3 attempts, zero text leakage', async () => {
  let attempts = 0;

  const server = http.createServer((req) => {
    attempts++;
    // Immediately destroy the connection upon receiving the request
    try { req.socket.destroy(); } catch {}
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    });

    const secretText = 'TOP_SECRET_PROMPT_F8_MID_REQUEST_456';
    const result = await router.translateBatch({
      items: [{ id: 'f8-2', revision: 0, text: secretText }],
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: 'ag/gemini-3.1-pro-low'
    });

    assert.ok(result.error, 'Expected error result from mid-request socket destroy');
    assert.equal(result.error.code, 'NETWORK', `Expected NETWORK error code, got: ${result.error.code}`);
    assert.equal(result.error.retryable, true, 'NETWORK error must be retryable');
    assert.equal(attempts, 3, `Expected exactly 3 attempts (1 initial + 2 retries), got: ${attempts}`);

    const errString = JSON.stringify(result);
    assert.ok(!errString.includes(secretText), 'Error object must not leak input item text');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('F8 Case 3: Abort mid-batch -> typed ABORTED with 0 retries (1 attempt), zero text leakage', async () => {
  let attempts = 0;
  let markRequestReceived;
  const requestReceived = new Promise((resolve) => { markRequestReceived = resolve; });

  const server = http.createServer((req) => {
    attempts++;
    markRequestReceived();
    // Hold request without replying until aborted
    req.on('data', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const router = createDirect9Router({
      baseURL,
      apiKey: 'test-key',
      model: 'ag/gemini-3.1-pro-low',
      ...fastOptions
    });

    const secretText = 'TOP_SECRET_PROMPT_F8_ABORT_123';
    const controller = new AbortController();

    const batchPromise = router.translateBatch({
      items: [{ id: 'f8-3', revision: 0, text: secretText }],
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
      model: 'ag/gemini-3.1-pro-low',
      signal: controller.signal
    });

    // Abort only after the local server received the request.
    await requestReceived;
    controller.abort('User explicitly aborted translation');

    const result = await batchPromise;

    assert.ok(result.error, 'Expected error result from aborted batch');
    assert.equal(result.error.code, 'ABORTED', `Expected ABORTED error code, got: ${result.error.code}`);
    assert.equal(result.error.retryable, false, 'ABORTED error must NOT be retryable');
    assert.equal(attempts, 1, `Expected exactly 1 attempt on abort, got: ${attempts}`);

    const errString = JSON.stringify(result);
    assert.ok(!errString.includes(secretText), 'Error object must not leak input item text');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
