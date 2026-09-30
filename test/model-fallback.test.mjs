import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFallbackPlan,
  resolveFallbackChain,
  extractHost,
  STOP_ERROR_CODES,
  FALLBACK_ELIGIBLE_CODES
} from '../extension/src/sw.js';

test('fallback: resolveFallbackPlan returns no fallback for successful result or null error', () => {
  const plan1 = resolveFallbackPlan(null, ['model-a', 'model-b'], 0);
  assert.equal(plan1.shouldFallback, false);
  assert.equal(plan1.reason, 'NO_ERROR');

  const plan2 = resolveFallbackPlan(undefined, ['model-a', 'model-b'], 0);
  assert.equal(plan2.shouldFallback, false);
  assert.equal(plan2.reason, 'NO_ERROR');
});

test('fallback: resolveFallbackPlan advances sequentially on NETWORK, TIMEOUT, and HTTP_5xx', () => {
  const chain = ['model-primary', 'model-fb1', 'model-fb2'];

  // 1. NETWORK on primary (attempt 0) -> advances to fb1 (index 1)
  const netErr = { error: { code: 'NETWORK', message: 'Connection reset' } };
  const netPlan = resolveFallbackPlan(netErr, chain, 0);
  assert.equal(netPlan.shouldFallback, true);
  assert.equal(netPlan.nextIndex, 1);
  assert.equal(netPlan.nextModel, 'model-fb1');

  // 2. TIMEOUT on fb1 (attempt 1) -> advances to fb2 (index 2)
  const timeoutErr = { error: { code: 'TIMEOUT', message: 'Gateway timeout' } };
  const timeoutPlan = resolveFallbackPlan(timeoutErr, chain, 1);
  assert.equal(timeoutPlan.shouldFallback, true);
  assert.equal(timeoutPlan.nextIndex, 2);
  assert.equal(timeoutPlan.nextModel, 'model-fb2');

  // 3. HTTP_5xx on primary (attempt 0) -> advances to fb1 (index 1)
  const serverErr = { error: { code: 'HTTP_5xx', message: 'Internal Server Error' } };
  const serverPlan = resolveFallbackPlan(serverErr, chain, 0);
  assert.equal(serverPlan.shouldFallback, true);
  assert.equal(serverPlan.nextIndex, 1);
  assert.equal(serverPlan.nextModel, 'model-fb1');
});

test('fallback: resolveFallbackPlan stops when chain is exhausted', () => {
  const chain2 = ['model-primary', 'model-fb1'];
  const netErr = { error: { code: 'NETWORK', message: 'Connection reset' } };

  // Attempt 1 in a 2-model chain -> nextIndex 2 >= chain.length -> CHAIN_EXHAUSTED
  const exhausted2 = resolveFallbackPlan(netErr, chain2, 1);
  assert.equal(exhausted2.shouldFallback, false);
  assert.equal(exhausted2.reason, 'CHAIN_EXHAUSTED');
  assert.deepEqual(exhausted2.terminalError, netErr);

  // Attempt 2 in a 3-model chain -> nextIndex 3 >= 3 -> CHAIN_EXHAUSTED
  const chain3 = ['model-primary', 'model-fb1', 'model-fb2'];
  const exhausted3 = resolveFallbackPlan(netErr, chain3, 2);
  assert.equal(exhausted3.shouldFallback, false);
  assert.equal(exhausted3.reason, 'CHAIN_EXHAUSTED');
  assert.deepEqual(exhausted3.terminalError, netErr);

  // Chain with only 1 model -> NO_FALLBACK_MODELS
  const chain1 = ['model-primary'];
  const singlePlan = resolveFallbackPlan(netErr, chain1, 0);
  assert.equal(singlePlan.shouldFallback, false);
  assert.equal(singlePlan.reason, 'NO_FALLBACK_MODELS');
});

test('fallback: resolveFallbackPlan stops immediately on all STOP-LIST errors', () => {
  const chain = ['model-primary', 'model-fb1', 'model-fb2'];

  const expectedStopCodes = [
    'HTTP_401',
    'HTTP_403',
    'HTTP_404',
    'HTTP_429',
    'MISSING_CONFIG',
    'MODEL_NOT_ALLOWED',
    'PERMISSION_REQUIRED',
    'OPT_IN_REQUIRED',
    'SITE_NOT_ALLOWED',
    'RATE_LIMITED',
    'RATE_STATE_UNAVAILABLE',
    'CAP_EXCEEDED',
    'INVALID_SCHEMA',
    'ABORTED',
    'DROPPED_ON_RESTART'
  ];

  // Verify STOP_ERROR_CODES includes all expected codes
  for (const c of expectedStopCodes) {
    assert.ok(STOP_ERROR_CODES.includes(c), `STOP_ERROR_CODES missing ${c}`);
  }

  // Verify each code aborts fallback
  for (const code of expectedStopCodes) {
    const err = { error: { code, message: `Simulated error for ${code}` } };
    const plan = resolveFallbackPlan(err, chain, 0);
    assert.equal(plan.shouldFallback, false, `Code ${code} should NOT fallback`);
    assert.equal(plan.reason, 'STOP_LIST');
    assert.deepEqual(plan.terminalError, err);
  }
});

test('fallback: resolveFallbackPlan rejects unknown or non-eligible error codes', () => {
  const chain = ['model-primary', 'model-fb1'];
  const unknownErr = { error: { code: 'UNKNOWN_RANDOM_ERROR', message: 'Random' } };
  const plan = resolveFallbackPlan(unknownErr, chain, 0);
  assert.equal(plan.shouldFallback, false);
  assert.equal(plan.reason, 'NOT_ELIGIBLE');
});

test('fallback: resolveFallbackPlan handles both typed error envelope and flat Error object', () => {
  const chain = ['model-primary', 'model-fb1'];

  // Flat error object
  const flatErr = new Error('500 Server Error');
  flatErr.code = 'HTTP_5xx';

  const plan = resolveFallbackPlan(flatErr, chain, 0);
  assert.equal(plan.shouldFallback, true);
  assert.equal(plan.nextIndex, 1);
  assert.equal(plan.nextModel, 'model-fb1');
});

test('fallback: resolveFallbackChain (a) inherits baseURL and key from primary when missing in fallback', () => {
  const settings = {
    baseURL: 'https://primary.example.com/v1',
    model: 'primary-model',
    fallbacks: [
      { id: 'fb1', model: 'fallback-model-1' }
    ]
  };
  const primaryKey = 'sk-primary-key';
  const fbKeys = {};

  const chain = resolveFallbackChain(settings, fbKeys, primaryKey);

  assert.equal(chain.length, 2);
  // Attempt 0: Primary
  assert.deepEqual(chain[0], {
    id: 'primary',
    baseURL: 'https://primary.example.com/v1',
    apiKey: 'sk-primary-key',
    model: 'primary-model'
  });
  // Attempt 1: Inherits baseURL and apiKey from primary
  assert.deepEqual(chain[1], {
    id: 'fb1',
    baseURL: 'https://primary.example.com/v1',
    apiKey: 'sk-primary-key',
    model: 'fallback-model-1'
  });
});

test('fallback: resolveFallbackChain (b) uses custom baseURL and distinct fallback apiKey when provided', () => {
  const settings = {
    baseURL: 'https://primary.example.com/v1',
    model: 'primary-model',
    fallbacks: [
      { id: 'fb1', baseURL: 'https://custom-fallback.example.com/v1', model: 'fb-model-1' }
    ]
  };
  const primaryKey = 'sk-primary-key';
  const fbKeys = {
    fb1: 'sk-fallback-1-key'
  };

  const chain = resolveFallbackChain(settings, fbKeys, primaryKey);

  assert.equal(chain.length, 2);
  assert.deepEqual(chain[1], {
    id: 'fb1',
    baseURL: 'https://custom-fallback.example.com/v1',
    apiKey: 'sk-fallback-1-key',
    model: 'fb-model-1'
  });
});

test('fallback: resolveFallbackChain (c) uses custom baseURL but inherits primary key when fallback key is not set (same-origin only)', () => {
  const settings = {
    baseURL: 'https://primary.example.com/v1',
    model: 'primary-model',
    fallbacks: [
      { id: 'fb1', baseURL: 'https://primary.example.com/v2', model: 'fb-model-1' }
    ]
  };
  const primaryKey = 'sk-primary-key';
  const fbKeys = {}; // No key for fb1

  const chain = resolveFallbackChain(settings, fbKeys, primaryKey);

  assert.equal(chain.length, 2);
  assert.deepEqual(chain[1], {
    id: 'fb1',
    baseURL: 'https://primary.example.com/v2',
    apiKey: 'sk-primary-key', // Inherited from primary because same origin
    model: 'fb-model-1'
  });
  assert.deepEqual(chain.skippedFallbacks, []);
});

test('fallback: resolveFallbackChain (d) skips fallback with different origin when fallback key is not set', () => {
  const settings = {
    baseURL: 'https://primary.example.com/v1',
    model: 'primary-model',
    fallbacks: [
      { id: 'fb1', baseURL: 'https://custom-fallback.example.com/v1', model: 'fb-model-1' }
    ]
  };
  const primaryKey = 'sk-primary-key';
  const fbKeys = {}; // No key for fb1

  const chain = resolveFallbackChain(settings, fbKeys, primaryKey);

  assert.equal(chain.length, 1); // fb1 skipped!
  assert.deepEqual(chain[0], {
    id: 'primary',
    baseURL: 'https://primary.example.com/v1',
    apiKey: 'sk-primary-key',
    model: 'primary-model'
  });
  assert.deepEqual(chain.skippedFallbacks, [
    { id: 'fb1', reason: 'missing_key_for_origin' }
  ]);
});

test('fallback: resolveFallbackPlan works seamlessly with object chain configs', () => {
  const objectChain = [
    { id: 'primary', baseURL: 'https://p.com', apiKey: 'k1', model: 'model-primary' },
    { id: 'fb1', baseURL: 'https://fb.com', apiKey: 'k2', model: 'model-fb1' }
  ];

  const err = { error: { code: 'HTTP_5xx', message: 'Server error' } };
  const plan = resolveFallbackPlan(err, objectChain, 0);

  assert.equal(plan.shouldFallback, true);
  assert.equal(plan.nextIndex, 1);
  assert.equal(plan.nextModel, 'model-fb1');
  assert.deepEqual(plan.nextConfig, objectChain[1]);
});

test('fallback: extractHost extracts host and port correctly, stripping path and protocol', () => {
  assert.equal(extractHost('http://localhost:8080/v1'), 'localhost:8080');
  assert.equal(extractHost('https://api.openai.com/v1/chat'), 'api.openai.com');
  assert.equal(extractHost('http://127.0.0.1:9789/custom/v1'), '127.0.0.1:9789');
  assert.equal(extractHost('invalid-url'), '');
});
