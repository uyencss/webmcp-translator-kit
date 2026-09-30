import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';

test('settings: SETTINGS_VERSION is defined as 2', () => {
  assert.equal(typeof SETTINGS_VERSION, 'number');
  assert.equal(SETTINGS_VERSION, 2);
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
  assert.equal(migrated.translationMode, 'scroll-follow');
  assert.equal(migrated.widgetVisible, true);
  assert.deepEqual(migrated.fallbackModels, []);
  assert.deepEqual(migrated.favoriteModels, []);
  assert.deepEqual(migrated.autoTranslateSites, []);

  // Verify rateLimits defaults are populated
  assert.deepEqual(migrated.rateLimits, DEFAULT_SETTINGS.rateLimits);
});

test('settings: migrateSettings converts v1 to canonical v2 with default new fields', () => {
  const v1Raw = {
    version: 1,
    baseURL: 'http://localhost:8080/v1',
    model: 'ag/gemini-3.1-pro-low',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    rateLimits: DEFAULT_SETTINGS.rateLimits
  };

  const migrated = migrateSettings(v1Raw);

  assert.equal(migrated.version, 2);
  assert.equal(migrated.baseURL, v1Raw.baseURL);
  assert.equal(migrated.model, v1Raw.model);
  assert.equal(migrated.translationMode, 'scroll-follow');
  assert.equal(migrated.widgetVisible, true);
  assert.deepEqual(migrated.fallbackModels, []);
  assert.deepEqual(migrated.favoriteModels, []);
  assert.deepEqual(migrated.autoTranslateSites, []);
});

test('settings: migrateSettings normalizes fallbackModels (dedupes, removes primary, limits to 2)', () => {
  const raw = {
    baseURL: 'http://localhost:8080/v1',
    model: 'primary-model',
    fallbackModels: ['primary-model', 'fb-1', 'fb-1', '', '   ', 'fb-2', 'fb-3']
  };

  const migrated = migrateSettings(raw);

  assert.deepEqual(migrated.fallbackModels, ['fb-1', 'fb-2']);
});

test('settings: migrateSettings normalizes favoriteModels (dedupes, limits to 50)', () => {
  const sixtyModels = Array.from({ length: 60 }, (_, i) => `model-${i}`);
  sixtyModels.push('model-0'); // duplicate

  const raw = {
    favoriteModels: sixtyModels
  };

  const migrated = migrateSettings(raw);

  assert.equal(migrated.favoriteModels.length, 50);
  assert.equal(migrated.favoriteModels[0], 'model-0');
  assert.equal(migrated.favoriteModels[49], 'model-49');
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

test('settings: migrateSettings is strictly idempotent across multiple passes', () => {
  const raw = {
    baseURL: 'https://api.9router.com/v1',
    model: 'ag/gemini-3.1-pro-low',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    translationMode: 'full',
    widgetVisible: false,
    fallbackModels: ['ag/gemini-3.8-flash'],
    favoriteModels: ['fav-a', 'fav-b'],
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
    assert.equal(res.translationMode, DEFAULT_SETTINGS.translationMode);
    assert.equal(res.widgetVisible, DEFAULT_SETTINGS.widgetVisible);
    assert.deepEqual(res.fallbackModels, []);
    assert.deepEqual(res.favoriteModels, []);
    assert.deepEqual(res.rateLimits, DEFAULT_SETTINGS.rateLimits);
  }
});

test('settings: validateSettings accepts valid v2 settings object', () => {
  const valid = {
    version: 2,
    baseURL: 'http://localhost:8080/v1',
    model: 'do/deepseek-v4.1-flash',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    translationMode: 'scroll-follow',
    widgetVisible: true,
    fallbackModels: ['ag/gemini-3.8-flash', 'gpt-4o-mini'],
    favoriteModels: ['do/deepseek-v4.1-flash', 'ag/gemini-3.8-flash'],
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

  // 5. Invalid translationMode
  const badMode = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    translationMode: 'invalid-mode'
  });
  assert.equal(badMode.valid, false);
  assert.ok(badMode.errors.some((e) => e.includes('translationMode')));

  // 6. fallbackModels containing primary model
  const fbWithPrimary = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbackModels: ['test']
  });
  assert.equal(fbWithPrimary.valid, false);
  assert.ok(fbWithPrimary.errors.some((e) => e.includes('primary model')));

  // 7. fallbackModels exceeding max 2
  const fbTooMany = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbackModels: ['fb1', 'fb2', 'fb3']
  });
  assert.equal(fbTooMany.valid, false);
  assert.ok(fbTooMany.errors.some((e) => e.includes('more than 2')));

  // 8. fallbackModels with duplicates
  const fbDupes = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbackModels: ['fb1', 'fb1']
  });
  assert.equal(fbDupes.valid, false);
  assert.ok(fbDupes.errors.some((e) => e.includes('duplicate')));

  // 9. favoriteModels with duplicates
  const favDupes = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    favoriteModels: ['fav1', 'fav1']
  });
  assert.equal(favDupes.valid, false);
  assert.ok(favDupes.errors.some((e) => e.includes('duplicate')));

  // 10. widgetVisible not boolean
  const badWidget = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    widgetVisible: 'yes'
  });
  assert.equal(badWidget.valid, false);
  assert.ok(badWidget.errors.some((e) => e.includes('widgetVisible')));
});

test('settings: merge-patch pattern preserves previously saved fields when partial payload is supplied', () => {
  const existingSettings = migrateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'primary-model',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    translationMode: 'scroll-follow',
    widgetVisible: false,
    favoriteModels: ['fav-model-1'],
    fallbackModels: ['fb-model-1']
  });

  // Popup sends only 4 legacy fields or only 1 field
  const partialPatch = {
    model: 'updated-primary-model'
  };

  const merged = migrateSettings({
    ...existingSettings,
    ...partialPatch
  });

  // Model is updated
  assert.equal(merged.model, 'updated-primary-model');
  // All other fields from existing settings are preserved intact
  assert.equal(merged.baseURL, 'http://localhost:8080/v1');
  assert.equal(merged.translationMode, 'scroll-follow');
  assert.equal(merged.widgetVisible, false);
  assert.deepEqual(merged.favoriteModels, ['fav-model-1']);
  assert.deepEqual(merged.fallbackModels, ['fb-model-1']);
  assert.deepEqual(merged.autoTranslateSites, []);
});

test('settings: migrateSettings normalizes autoTranslateSites (normalizes to origin, filters invalid/non-http, dedupes, limits to 200)', () => {
  const raw = {
    autoTranslateSites: [
      'https://example.com/path?q=1#hash',
      'http://127.0.0.1:8089/fixture.html',
      'https://example.com', // duplicate after normalization
      'ftp://invalid.com',
      'chrome-extension://abcdef/popup.html',
      'not a url',
      '',
      123,
      null,
      'http://site.org:8080/nested'
    ]
  };

  const migrated = migrateSettings(raw);

  assert.deepEqual(migrated.autoTranslateSites, [
    'https://example.com',
    'http://127.0.0.1:8089',
    'http://site.org:8080'
  ]);

  // Test capping to 200 items
  const manySites = Array.from({ length: 250 }, (_, i) => `https://site-${i}.com`);
  const migratedCapped = migrateSettings({ autoTranslateSites: manySites });
  assert.equal(migratedCapped.autoTranslateSites.length, 200);
  assert.equal(migratedCapped.autoTranslateSites[0], 'https://site-0.com');
  assert.equal(migratedCapped.autoTranslateSites[199], 'https://site-199.com');
});

test('settings: validateSettings accepts valid autoTranslateSites and rejects invalid entries', () => {
  // Valid
  const valid = {
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    autoTranslateSites: ['https://example.com', 'http://127.0.0.1:8089']
  };
  assert.equal(validateSettings(valid).valid, true);

  // Rejects non-array
  const nonArray = validateSettings({ ...valid, autoTranslateSites: 'https://example.com' });
  assert.equal(nonArray.valid, false);
  assert.ok(nonArray.errors.some((e) => e.includes('autoTranslateSites')));

  // Rejects > 200 items
  const tooMany = validateSettings({
    ...valid,
    autoTranslateSites: Array.from({ length: 201 }, (_, i) => `https://site-${i}.com`)
  });
  assert.equal(tooMany.valid, false);
  assert.ok(tooMany.errors.some((e) => e.includes('more than 200')));

  // Rejects non-origin / unnormalized entries
  const unnormalized = validateSettings({
    ...valid,
    autoTranslateSites: ['https://example.com/path']
  });
  assert.equal(unnormalized.valid, false);
  assert.ok(unnormalized.errors.some((e) => e.includes('valid normalized HTTP(S) origin')));

  // Rejects non-HTTP(S) scheme
  const nonHttp = validateSettings({
    ...valid,
    autoTranslateSites: ['chrome://extensions']
  });
  assert.equal(nonHttp.valid, false);
  assert.ok(nonHttp.errors.some((e) => e.includes('valid normalized HTTP(S) origin')));

  // Rejects duplicates
  const dupes = validateSettings({
    ...valid,
    autoTranslateSites: ['https://example.com', 'https://example.com']
  });
  assert.equal(dupes.valid, false);
  assert.ok(dupes.errors.some((e) => e.includes('duplicate')));
});

test('settings: merge-patch preserves autoTranslateSites when partial payload without it is supplied', () => {
  const existingSettings = migrateSettings({
    autoTranslateSites: ['https://auto1.com', 'https://auto2.com']
  });

  const merged = migrateSettings({
    ...existingSettings,
    model: 'new-model'
  });

  assert.equal(merged.model, 'new-model');
  assert.deepEqual(merged.autoTranslateSites, ['https://auto1.com', 'https://auto2.com']);

  // Updating autoTranslateSites partially preserves other fields
  const updatedAuto = migrateSettings({
    ...merged,
    autoTranslateSites: ['https://auto3.com']
  });
  assert.equal(updatedAuto.model, 'new-model');
  assert.deepEqual(updatedAuto.autoTranslateSites, ['https://auto3.com']);
});

