import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';

test('settings: SETTINGS_VERSION is defined as 4', () => {
  assert.equal(typeof SETTINGS_VERSION, 'number');
  assert.equal(SETTINGS_VERSION, 4);
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
  assert.deepEqual(migrated.fallbacks, []);
  assert.equal(migrated.fallbackModels, undefined);
  assert.deepEqual(migrated.favoriteModels, []);
  assert.deepEqual(migrated.autoTranslateSites, []);

  // Verify rateLimits defaults are populated
  assert.deepEqual(migrated.rateLimits, DEFAULT_SETTINGS.rateLimits);
});

test('settings: migrateSettings converts v1 to canonical v4 with default new fields', () => {
  const v1Raw = {
    version: 1,
    baseURL: 'http://localhost:8080/v1',
    model: 'ag/gemini-3.1-pro-low',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    rateLimits: DEFAULT_SETTINGS.rateLimits
  };

  const migrated = migrateSettings(v1Raw);

  assert.equal(migrated.version, 4);
  assert.equal(migrated.baseURL, v1Raw.baseURL);
  assert.equal(migrated.model, v1Raw.model);
  assert.equal(migrated.translationMode, 'scroll-follow');
  assert.equal(migrated.widgetVisible, true);
  assert.deepEqual(migrated.fallbacks, []);
  assert.equal(migrated.fallbackModels, undefined);
  assert.deepEqual(migrated.favoriteModels, []);
  assert.deepEqual(migrated.autoTranslateSites, []);
});

test('settings: migrateSettings converts v2 fallbackModels to v4 fallbacks with inherit', () => {
  const raw = {
    version: 2,
    baseURL: 'http://localhost:8080/v1',
    model: 'primary-model',
    fallbackModels: ['primary-model', 'fb-1', 'fb-1', '', '   ', 'fb-2', 'fb-3']
  };

  const migrated = migrateSettings(raw);

  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.fallbacks, [
    { id: 'fb1', model: 'fb-1' },
    { id: 'fb2', model: 'fb-2' }
  ]);
  assert.equal(migrated.fallbackModels, undefined);
});

test('settings: migrateSettings normalizes fallbacks (assigns stable id, trims baseURL, limits to 2)', () => {
  const raw = {
    baseURL: 'http://localhost:8080/v1',
    model: 'primary-model',
    fallbacks: [
      { id: 'custom-1', baseURL: '  http://fb1.example.com/v1  ', model: 'model-a' },
      { id: '', model: 'model-b' },
      { id: 'custom-3', model: 'model-c' }
    ]
  };

  const migrated = migrateSettings(raw);

  assert.equal(migrated.fallbacks.length, 2);
  assert.deepEqual(migrated.fallbacks[0], { id: 'custom-1', baseURL: 'http://fb1.example.com/v1', model: 'model-a' });
  assert.deepEqual(migrated.fallbacks[1], { id: 'fb1', model: 'model-b' });
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

test('settings: migrateSettings strips api_key and fallback_api_keys to prevent credential leakage', () => {
  const dirty = {
    baseURL: 'http://localhost:8080/v1',
    model: 'gpt-4o-mini',
    api_key: 'sk-secret-key-12345',
    apiKey: 'sk-another-secret',
    fallback_api_keys: { fb1: 'sk-fb-secret' },
    fallbackApiKeys: { fb1: 'sk-fb-secret-2' },
    fallbacks: [
      { id: 'fb1', model: 'fb-model', apiKey: 'leak-1', key: 'leak-2' }
    ]
  };

  const migrated = migrateSettings(dirty);

  assert.equal(migrated.api_key, undefined);
  assert.equal(migrated.apiKey, undefined);
  assert.equal(migrated.fallback_api_keys, undefined);
  assert.equal(migrated.fallbackApiKeys, undefined);
  assert.ok(!('api_key' in migrated));
  assert.ok(!('apiKey' in migrated));
  assert.ok(!('fallback_api_keys' in migrated));
  assert.ok(!('fallbackApiKeys' in migrated));
  assert.equal(migrated.fallbacks[0].apiKey, undefined);
  assert.equal(migrated.fallbacks[0].key, undefined);
});

test('settings: migrateSettings is strictly idempotent across multiple passes', () => {
  const raw = {
    baseURL: 'https://api.9router.com/v1',
    model: 'ag/gemini-3.1-pro-low',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    translationMode: 'full',
    widgetVisible: false,
    fallbacks: [
      { id: 'fb1', model: 'ag/gemini-3.8-flash', baseURL: 'https://backup.com/v1' }
    ],
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
    assert.deepEqual(res.fallbacks, []);
    assert.equal(res.fallbackModels, undefined);
    assert.deepEqual(res.favoriteModels, []);
    assert.deepEqual(res.rateLimits, DEFAULT_SETTINGS.rateLimits);
  }
});

test('settings: validateSettings accepts valid v3 settings object', () => {
  const valid = {
    version: 3,
    baseURL: 'http://localhost:8080/v1',
    model: 'do/deepseek-v4.1-flash',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    translationMode: 'scroll-follow',
    widgetVisible: true,
    fallbacks: [
      { id: 'fb1', model: 'ag/gemini-3.8-flash' },
      { id: 'fb2', baseURL: 'https://alt-router.com/v1', model: 'gpt-4o-mini' }
    ],
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

  // 4. Injected api_key / fallback_api_keys
  const withKey = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    api_key: 'secret'
  });
  assert.equal(withKey.valid, false);
  assert.ok(withKey.errors.some((e) => e.includes('api_key')));

  const withFbKeys = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallback_api_keys: { fb1: 'secret' }
  });
  assert.equal(withFbKeys.valid, false);
  assert.ok(withFbKeys.errors.some((e) => e.includes('fallback_api_keys')));

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

  // 6. fallbacks exceeding max 2
  const fbTooMany = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbacks: [
      { id: 'fb1', model: 'm1' },
      { id: 'fb2', model: 'm2' },
      { id: 'fb3', model: 'm3' }
    ]
  });
  assert.equal(fbTooMany.valid, false);
  assert.ok(fbTooMany.errors.some((e) => e.includes('more than 2')));

  // 7. fallbacks with duplicate id
  const fbDupes = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbacks: [
      { id: 'fb1', model: 'm1' },
      { id: 'fb1', model: 'm2' }
    ]
  });
  assert.equal(fbDupes.valid, false);
  assert.ok(fbDupes.errors.some((e) => e.includes('unique')));

  // 8. fallbacks with empty model or id
  const fbEmpty = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbacks: [
      { id: 'fb1', model: '' }
    ]
  });
  assert.equal(fbEmpty.valid, false);
  assert.ok(fbEmpty.errors.some((e) => e.includes('model must be a non-empty string')));

  // 9. fallbacks with invalid baseURL
  const fbBadURL = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbacks: [
      { id: 'fb1', baseURL: 'ftp://invalid', model: 'm1' }
    ]
  });
  assert.equal(fbBadURL.valid, false);
  assert.ok(fbBadURL.errors.some((e) => e.includes('baseURL must be a valid HTTP(S) URL')));

  // 10. fallbacks containing api key
  const fbWithKey = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbacks: [
      { id: 'fb1', model: 'm1', apiKey: 'secret' }
    ]
  });
  assert.equal(fbWithKey.valid, false);
  assert.ok(fbWithKey.errors.some((e) => e.includes('must not contain api key')));

  // 11. Obsolete fallbackModels rejected
  const obsoleteFb = validateSettings({
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    fallbackModels: ['m1']
  });
  assert.equal(obsoleteFb.valid, false);
  assert.ok(obsoleteFb.errors.some((e) => e.includes('fallbackModels has been replaced by fallbacks')));
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
    fallbacks: [{ id: 'fb1', model: 'fb-model-1' }]
  });

  // Popup sends only 1 field
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
  assert.deepEqual(merged.fallbacks, [{ id: 'fb1', model: 'fb-model-1' }]);
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
    { origin: 'https://example.com', mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null },
    { origin: 'http://127.0.0.1:8089', mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null },
    { origin: 'http://site.org:8080', mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null }
  ]);

  // Test capping to 200 items
  const manySites = Array.from({ length: 250 }, (_, i) => `https://site-${i}.com`);
  const migratedCapped = migrateSettings({ autoTranslateSites: manySites });
  assert.equal(migratedCapped.autoTranslateSites.length, 200);
  assert.deepEqual(migratedCapped.autoTranslateSites[0], {
    origin: 'https://site-0.com',
    mode: 'inherit',
    autoStart: true,
    sourceLanguage: null,
    targetLanguage: null
  });
  assert.deepEqual(migratedCapped.autoTranslateSites[199], {
    origin: 'https://site-199.com',
    mode: 'inherit',
    autoStart: true,
    sourceLanguage: null,
    targetLanguage: null
  });
});

test('settings: migrateSettings preserves and normalizes per-site object configurations', () => {
  const raw = {
    autoTranslateSites: [
      {
        origin: 'https://full-custom.com/subpath',
        mode: 'full',
        autoStart: false,
        sourceLanguage: ' zh ',
        targetLanguage: 'en'
      },
      {
        origin: 'http://scroll-site.org',
        mode: 'scroll-follow',
        autoStart: true
      },
      {
        origin: 'https://invalid-mode.com',
        mode: 'turbo',
        autoStart: 'not-bool'
      },
      {
        origin: 'https://full-custom.com' // duplicate after origin normalization
      }
    ]
  };

  const migrated = migrateSettings(raw);

  assert.deepEqual(migrated.autoTranslateSites, [
    {
      origin: 'https://full-custom.com',
      mode: 'full',
      autoStart: false,
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    },
    {
      origin: 'http://scroll-site.org',
      mode: 'scroll-follow',
      autoStart: true,
      sourceLanguage: null,
      targetLanguage: null
    },
    {
      origin: 'https://invalid-mode.com',
      mode: 'inherit',
      autoStart: true,
      sourceLanguage: null,
      targetLanguage: null
    }
  ]);
});

test('settings: validateSettings accepts valid autoTranslateSites and rejects invalid entries', () => {
  // Valid (both strings and objects)
  const valid = {
    baseURL: 'http://localhost:8080/v1',
    model: 'test',
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    autoTranslateSites: [
      'https://example.com',
      {
        origin: 'http://127.0.0.1:8089',
        mode: 'full',
        autoStart: false,
        sourceLanguage: 'en',
        targetLanguage: 'vi'
      }
    ]
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

  // Rejects non-origin / unnormalized entries in string format
  const unnormalizedStr = validateSettings({
    ...valid,
    autoTranslateSites: ['https://example.com/path']
  });
  assert.equal(unnormalizedStr.valid, false);
  assert.ok(unnormalizedStr.errors.some((e) => e.includes('valid normalized HTTP(S) origin')));

  // Rejects non-origin / unnormalized entries in object format
  const unnormalizedObj = validateSettings({
    ...valid,
    autoTranslateSites: [{ origin: 'https://example.com/path' }]
  });
  assert.equal(unnormalizedObj.valid, false);
  assert.ok(unnormalizedObj.errors.some((e) => e.includes('valid normalized HTTP(S) origin')));

  // Rejects invalid mode
  const invalidMode = validateSettings({
    ...valid,
    autoTranslateSites: [{ origin: 'https://example.com', mode: 'fast-forward' }]
  });
  assert.equal(invalidMode.valid, false);
  assert.ok(invalidMode.errors.some((e) => e.includes('mode must be')));

  // Rejects non-boolean autoStart
  const invalidAutoStart = validateSettings({
    ...valid,
    autoTranslateSites: [{ origin: 'https://example.com', autoStart: 1 }]
  });
  assert.equal(invalidAutoStart.valid, false);
  assert.ok(invalidAutoStart.errors.some((e) => e.includes('autoStart must be a boolean')));

  // Rejects duplicates
  const dupes = validateSettings({
    ...valid,
    autoTranslateSites: ['https://example.com', { origin: 'https://example.com' }]
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
  assert.deepEqual(merged.autoTranslateSites, [
    { origin: 'https://auto1.com', mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null },
    { origin: 'https://auto2.com', mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null }
  ]);

  // Updating autoTranslateSites partially preserves other fields
  const updatedAuto = migrateSettings({
    ...merged,
    autoTranslateSites: ['https://auto3.com']
  });
  assert.equal(updatedAuto.model, 'new-model');
  assert.deepEqual(updatedAuto.autoTranslateSites, [
    { origin: 'https://auto3.com', mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null }
  ]);
});

