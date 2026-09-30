import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';

test('settings: SETTINGS_VERSION is defined as a positive number', () => {
  assert.equal(typeof SETTINGS_VERSION, 'number');
  assert.ok(SETTINGS_VERSION >= 1);
});

test('settings: migrateSettings converts v0 (unversioned) to canonical version with defaults', () => {
  const v0Raw = {
    baseURL: 'http://my-custom-router:9000/v1',
    model: 'custom-model',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    customProperty: 'hello-world'
  };

  const migrated = migrateSettings(v0Raw);

  assert.equal(migrated.version, SETTINGS_VERSION);
  assert.equal(migrated.baseURL, 'http://my-custom-router:9000/v1');
  assert.equal(migrated.model, 'custom-model');
  assert.equal(migrated.sourceLanguage, 'zh');
  assert.equal(migrated.targetLanguage, 'en');
  assert.equal(migrated.customProperty, 'hello-world');

  // Verify rateLimits defaults are populated
  assert.deepEqual(migrated.rateLimits, DEFAULT_SETTINGS.rateLimits);
});

test('settings: migrateSettings strips api_key and apiKey to prevent credential leakage into settings record', () => {
  const dirty = {
    baseURL: 'http://localhost:8080/v1',
    model: 'gpt-4o-mini',
    api_key: 'sk-secret-key-12345',
    apiKey: 'sk-another-secret'
  };

  const migrated = migrateSettings(dirty);

  assert.equal(migrated.api_key, undefined);
  assert.equal(migrated.apiKey, undefined);
  assert.ok(!('api_key' in migrated));
  assert.ok(!('apiKey' in migrated));
});

test('settings: migrateSettings is strictly idempotent', () => {
  const raw = {
    baseURL: 'https://api.9router.com/v1',
    model: 'ag/gemini-3.1-pro-low',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    extra: 'preserved'
  };

  const firstPass = migrateSettings(raw);
  const secondPass = migrateSettings(firstPass);

  assert.deepEqual(firstPass, secondPass);
});

test('settings: migrateSettings handles null, undefined, empty, and primitive values without crashing', () => {
  const cases = [undefined, null, {}, [], '', 123, true];

  for (const c of cases) {
    const res = migrateSettings(c);
    assert.equal(typeof res, 'object');
    assert.notEqual(res, null);
    assert.equal(res.version, SETTINGS_VERSION);
    assert.equal(res.baseURL, DEFAULT_SETTINGS.baseURL);
    assert.equal(res.model, DEFAULT_SETTINGS.model);
    assert.equal(res.sourceLanguage, DEFAULT_SETTINGS.sourceLanguage);
    assert.equal(res.targetLanguage, DEFAULT_SETTINGS.targetLanguage);
    assert.deepEqual(res.rateLimits, DEFAULT_SETTINGS.rateLimits);
  }
});

test('settings: validateSettings accepts valid settings object', () => {
  const valid = {
    version: 1,
    baseURL: 'http://localhost:8080/v1',
    model: 'do/deepseek-v4.1-flash',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    rateLimits: {
      windowSeconds: 60,
      tab: { maxBatches: 4, maxSourceCodePoints: 12000 },
      site: { maxBatches: 12, maxSourceCodePoints: 36000 }
    }
  };

  const res = validateSettings(valid);
  assert.equal(res.valid, true);
  assert.equal(res.errors, undefined);
});

test('settings: validateSettings rejects invalid fields and credential inclusion', () => {
  // 1. Non-object
  assert.equal(validateSettings(null).valid, false);
  assert.equal(validateSettings('not an object').valid, false);

  // 2. Invalid baseURL
  assert.equal(validateSettings({
    baseURL: 'ftp://invalid-url',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi'
  }).valid, false);

  // 3. Missing/empty model
  assert.equal(validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: '   ',
    sourceLanguage: 'auto',
    targetLanguage: 'vi'
  }).valid, false);

  // 4. Injected api_key
  const withKey = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    api_key: 'secret'
  });
  assert.equal(withKey.valid, false);
  assert.ok(withKey.errors.some((e) => e.includes('api_key')));

  // 5. Malformed rateLimits
  const badRateLimits = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    rateLimits: { windowSeconds: -1 }
  });
  assert.equal(badRateLimits.valid, false);
});
