import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clampTabMaxBatches,
  clampSiteMaxBatches,
  clampProviderConcurrency,
  clampRateLimitValues,
  RATE_LIMIT_BOUNDS,
  DEFAULT_SETTINGS,
  migrateSettings,
  validateSettings
} from '../extension/src/settings.mjs';

import { createSemaphore } from '../extension/src/semaphore.mjs';
import {
  resolveLimits,
  updateProviderConcurrency,
  getProviderSemaphore
} from '../extension/src/sw.js';

import { SUPPORTED_UI_LOCALES, t, MESSAGES } from '../extension/src/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupHtmlPath = path.resolve(__dirname, '../extension/src/popup.html');
const popupCssPath = path.resolve(__dirname, '../extension/src/popup.css');
const popupJsPath = path.resolve(__dirname, '../extension/src/popup.js');

const htmlSrc = fs.readFileSync(popupHtmlPath, 'utf8');
const cssSrc = fs.readFileSync(popupCssPath, 'utf8');
const jsSrc = fs.readFileSync(popupJsPath, 'utf8');

// ============================================================================
// 1. Clamping ngoài khoảng (Out-of-range bounds, types, edges)
// ============================================================================

test('WI-28: clampTabMaxBatches enforces 1..20 bounds and defaults on invalid input', () => {
  // Lower bound clamping
  assert.equal(clampTabMaxBatches(0), 1);
  assert.equal(clampTabMaxBatches(-5), 1);
  assert.equal(clampTabMaxBatches(-999), 1);

  // Upper bound clamping
  assert.equal(clampTabMaxBatches(21), 20);
  assert.equal(clampTabMaxBatches(50), 20);
  assert.equal(clampTabMaxBatches(999), 20);

  // In-range values preserved
  assert.equal(clampTabMaxBatches(1), 1);
  assert.equal(clampTabMaxBatches(4), 4);
  assert.equal(clampTabMaxBatches(10), 10);
  assert.equal(clampTabMaxBatches(20), 20);

  // Numeric string parsing
  assert.equal(clampTabMaxBatches('15'), 15);
  assert.equal(clampTabMaxBatches('0'), 1);
  assert.equal(clampTabMaxBatches('100'), 20);

  // Non-number / invalid input fallback to default (4)
  assert.equal(clampTabMaxBatches(''), 4);
  assert.equal(clampTabMaxBatches('invalid'), 4);
  assert.equal(clampTabMaxBatches(null), 4);
  assert.equal(clampTabMaxBatches(undefined), 4);
  assert.equal(clampTabMaxBatches(NaN), 4);
  assert.equal(clampTabMaxBatches(Infinity), 4);

  // Decimal rounding
  assert.equal(clampTabMaxBatches(4.2), 4);
  assert.equal(clampTabMaxBatches(4.8), 5);
  assert.equal(clampTabMaxBatches(0.4), 1);
  assert.equal(clampTabMaxBatches(20.4), 20);
});

test('WI-28: clampSiteMaxBatches enforces 1..60 bounds and defaults on invalid input', () => {
  // Lower bound clamping
  assert.equal(clampSiteMaxBatches(0), 1);
  assert.equal(clampSiteMaxBatches(-10), 1);
  assert.equal(clampSiteMaxBatches(-999), 1);

  // Upper bound clamping
  assert.equal(clampSiteMaxBatches(61), 60);
  assert.equal(clampSiteMaxBatches(100), 60);
  assert.equal(clampSiteMaxBatches(999), 60);

  // In-range values preserved
  assert.equal(clampSiteMaxBatches(1), 1);
  assert.equal(clampSiteMaxBatches(12), 12);
  assert.equal(clampSiteMaxBatches(30), 30);
  assert.equal(clampSiteMaxBatches(60), 60);

  // Numeric string parsing
  assert.equal(clampSiteMaxBatches('25'), 25);
  assert.equal(clampSiteMaxBatches('0'), 1);
  assert.equal(clampSiteMaxBatches('500'), 60);

  // Non-number / invalid input fallback to default (12)
  assert.equal(clampSiteMaxBatches(''), 12);
  assert.equal(clampSiteMaxBatches('abc'), 12);
  assert.equal(clampSiteMaxBatches(null), 12);
  assert.equal(clampSiteMaxBatches(undefined), 12);
  assert.equal(clampSiteMaxBatches(NaN), 12);

  // Decimal rounding
  assert.equal(clampSiteMaxBatches(11.9), 12);
  assert.equal(clampSiteMaxBatches(0.2), 1);
  assert.equal(clampSiteMaxBatches(60.9), 60);
});

test('WI-28: clampProviderConcurrency enforces 1..4 bounds and defaults on invalid input', () => {
  // Lower bound clamping
  assert.equal(clampProviderConcurrency(0), 1);
  assert.equal(clampProviderConcurrency(-2), 1);
  assert.equal(clampProviderConcurrency(-100), 1);

  // Upper bound clamping
  assert.equal(clampProviderConcurrency(5), 4);
  assert.equal(clampProviderConcurrency(10), 4);
  assert.equal(clampProviderConcurrency(99), 4);

  // In-range values preserved
  assert.equal(clampProviderConcurrency(1), 1);
  assert.equal(clampProviderConcurrency(2), 2);
  assert.equal(clampProviderConcurrency(3), 3);
  assert.equal(clampProviderConcurrency(4), 4);

  // Numeric string parsing
  assert.equal(clampProviderConcurrency('3'), 3);
  assert.equal(clampProviderConcurrency('0'), 1);
  assert.equal(clampProviderConcurrency('10'), 4);

  // Non-number / invalid input fallback to default (2)
  assert.equal(clampProviderConcurrency(''), 2);
  assert.equal(clampProviderConcurrency('concurrency'), 2);
  assert.equal(clampProviderConcurrency(null), 2);
  assert.equal(clampProviderConcurrency(undefined), 2);
  assert.equal(clampProviderConcurrency(NaN), 2);

  // Decimal rounding
  assert.equal(clampProviderConcurrency(1.8), 2);
  assert.equal(clampProviderConcurrency(3.2), 3);
});

test('WI-28: clampRateLimitValues clamps all 3 tunables in a single call', () => {
  const result = clampRateLimitValues({
    tabMaxBatches: 99,
    siteMaxBatches: -5,
    providerConcurrency: 10
  });

  assert.deepEqual(result, {
    tabMaxBatches: 20,
    siteMaxBatches: 1,
    providerConcurrency: 4
  });
});

test('WI-28: migrateSettings and validateSettings clamp and validate rate tunables', () => {
  // migrateSettings clamps out-of-range values in rateLimits and providerConcurrency
  const migrated = migrateSettings({
    providerConcurrency: 10,
    rateLimits: {
      windowSeconds: 60,
      tab: { maxBatches: 50 },
      site: { maxBatches: -3 }
    }
  });

  assert.equal(migrated.providerConcurrency, 4);
  assert.equal(migrated.rateLimits.windowSeconds, 60);
  assert.equal(migrated.rateLimits.tab.maxBatches, 20);
  assert.equal(migrated.rateLimits.site.maxBatches, 1);

  // validateSettings: valid settings with providerConcurrency 1..4
  const valid = validateSettings({
    ...DEFAULT_SETTINGS,
    providerConcurrency: 3
  });
  assert.equal(valid.valid, true);

  // validateSettings: rejects invalid providerConcurrency (< 1 or > 4 or non-integer)
  const invalidLow = validateSettings({
    ...DEFAULT_SETTINGS,
    providerConcurrency: 0
  });
  assert.equal(invalidLow.valid, false);
  assert.ok(invalidLow.errors.some(e => e.includes('providerConcurrency')));

  const invalidHigh = validateSettings({
    ...DEFAULT_SETTINGS,
    providerConcurrency: 5
  });
  assert.equal(invalidHigh.valid, false);
  assert.ok(invalidHigh.errors.some(e => e.includes('providerConcurrency')));

  const invalidFloat = validateSettings({
    ...DEFAULT_SETTINGS,
    providerConcurrency: 2.5
  });
  assert.equal(invalidFloat.valid, false);
  assert.ok(invalidFloat.errors.some(e => e.includes('providerConcurrency')));
});

// ============================================================================
// 2. resolveLimits dùng settings (Settings integration)
// ============================================================================

test('WI-28: resolveLimits reads limits from settings or rateLimits, falling back to defaults', () => {
  // Case 1: Pass full settings object
  const settingsObj = {
    ...DEFAULT_SETTINGS,
    rateLimits: {
      windowSeconds: 60,
      tab: { maxBatches: 16, maxSourceCodePoints: 12000 },
      site: { maxBatches: 48, maxSourceCodePoints: 36000 }
    }
  };

  const limitsFromSettings = resolveLimits(settingsObj);
  assert.equal(limitsFromSettings.windowSeconds, 60);
  assert.equal(limitsFromSettings.tab.maxBatches, 16);
  assert.equal(limitsFromSettings.site.maxBatches, 48);

  // Case 2: Pass direct rateLimits object
  const directRateLimits = {
    windowSeconds: 60,
    tab: { maxBatches: 8, maxSourceCodePoints: 10000 },
    site: { maxBatches: 24, maxSourceCodePoints: 30000 }
  };

  const limitsFromRL = resolveLimits(directRateLimits);
  assert.equal(limitsFromRL.windowSeconds, 60);
  assert.equal(limitsFromRL.tab.maxBatches, 8);
  assert.equal(limitsFromRL.site.maxBatches, 24);

  // Case 3: Empty / null / undefined resolves to defaults (tab: 4, site: 12, window: 60)
  const defaultLimits = resolveLimits(null);
  assert.equal(defaultLimits.windowSeconds, 60);
  assert.equal(defaultLimits.tab.maxBatches, 4);
  assert.equal(defaultLimits.site.maxBatches, 12);

  const defaultLimitsUndef = resolveLimits(undefined);
  assert.equal(defaultLimitsUndef.windowSeconds, 60);
  assert.equal(defaultLimitsUndef.tab.maxBatches, 4);
  assert.equal(defaultLimitsUndef.site.maxBatches, 12);
});

// ============================================================================
// 3. Semaphore tôn trọng concurrency mới (Dynamic concurrency updates)
// ============================================================================

test('WI-28: semaphore respects initial concurrency and setMaxConcurrency changes', async () => {
  const sem = createSemaphore({ maxConcurrency: 2, timeoutMs: 1000 });
  assert.equal(sem.getMaxConcurrency(), 2);
  assert.equal(sem.active(), 0);
  assert.equal(sem.waiting(), 0);

  // Acquire 2 slots (fills maxConcurrency)
  await sem.acquire();
  await sem.acquire();
  assert.equal(sem.active(), 2);
  assert.equal(sem.waiting(), 0);

  // 3rd acquire must queue
  let acquired3 = false;
  const p3 = sem.acquire().then(() => { acquired3 = true; });
  assert.equal(acquired3, false);
  assert.equal(sem.waiting(), 1);

  // Expand concurrency from 2 to 3: queued waiter should immediately resolve
  sem.setMaxConcurrency(3);
  assert.equal(sem.getMaxConcurrency(), 3);
  await p3;
  assert.equal(acquired3, true);
  assert.equal(sem.active(), 3);
  assert.equal(sem.waiting(), 0);

  // Queue a 4th waiter
  let acquired4 = false;
  const p4 = sem.acquire().then(() => { acquired4 = true; });
  assert.equal(sem.waiting(), 1);

  // Reduce concurrency from 3 to 1 while 3 permits are active
  sem.setMaxConcurrency(1);
  assert.equal(sem.getMaxConcurrency(), 1);
  assert.equal(sem.active(), 3); // in-flight permits are not forcibly revoked
  assert.equal(sem.waiting(), 1); // 4th waiter still waiting

  // Release 1st slot: active goes from 3 to 2. Since 2 >= 1, 4th waiter does NOT run
  sem.release();
  assert.equal(sem.active(), 2);
  assert.equal(acquired4, false);
  assert.equal(sem.waiting(), 1);

  // Release 2nd slot: active goes from 2 to 1. Since 1 >= 1, 4th waiter does NOT run
  sem.release();
  assert.equal(sem.active(), 1);
  assert.equal(acquired4, false);
  assert.equal(sem.waiting(), 1);

  // Release 3rd slot: active drops below 1 (to 0), so 4th waiter resolves and becomes active (active = 1)
  sem.release();
  await p4;
  assert.equal(acquired4, true);
  assert.equal(sem.active(), 1);
  assert.equal(sem.waiting(), 0);

  // Clean release of 4th slot
  sem.release();
  assert.equal(sem.active(), 0);
  assert.equal(sem.waiting(), 0);
});

test('WI-28: updateProviderConcurrency clamps value and updates providerSemaphore in sw', () => {
  const sem = getProviderSemaphore();
  assert.ok(sem, 'providerSemaphore must exist');

  // Update to 3
  const c3 = updateProviderConcurrency(3);
  assert.equal(c3, 3);
  assert.equal(sem.getMaxConcurrency(), 3);

  // Update with out-of-range value (10 -> clamped to 4)
  const c10 = updateProviderConcurrency(10);
  assert.equal(c10, 4);
  assert.equal(sem.getMaxConcurrency(), 4);

  // Update with out-of-range value (0 -> clamped to 1)
  const c0 = updateProviderConcurrency(0);
  assert.equal(c0, 1);
  assert.equal(sem.getMaxConcurrency(), 1);

  // Restore default 2
  const c2 = updateProviderConcurrency(2);
  assert.equal(c2, 2);
  assert.equal(sem.getMaxConcurrency(), 2);
});

// ============================================================================
// 4. UI Elements in popup.html, popup.css & i18n
// ============================================================================

test('WI-28: popup.html contains rate limits section with 3 inputs, hint, and warning', () => {
  assert.ok(htmlSrc.includes('rate-limits-card'), 'popup.html must contain rate-limits-card');
  assert.ok(htmlSrc.includes('id="input-rate-tab"'), 'popup.html must contain input-rate-tab');
  assert.ok(htmlSrc.includes('id="input-rate-site"'), 'popup.html must contain input-rate-site');
  assert.ok(htmlSrc.includes('id="input-rate-concurrency"'), 'popup.html must contain input-rate-concurrency');
  assert.ok(htmlSrc.includes('id="rate-limits-hint"'), 'popup.html must contain rate-limits-hint');
  assert.ok(htmlSrc.includes('rate-limits-warning'), 'popup.html must contain rate-limits-warning');

  // Verify input constraints in HTML
  assert.ok(htmlSrc.includes('id="input-rate-tab" min="1" max="20"'), 'input-rate-tab must specify min=1 max=20');
  assert.ok(htmlSrc.includes('id="input-rate-site" min="1" max="60"'), 'input-rate-site must specify min=1 max=60');
  assert.ok(htmlSrc.includes('id="input-rate-concurrency" min="1" max="4"'), 'input-rate-concurrency must specify min=1 max=4');
});

test('WI-28: popup.css defines styling for rate limits and light theme overrides', () => {
  assert.ok(cssSrc.includes('.rate-limits-card'), 'popup.css must style .rate-limits-card');
  assert.ok(cssSrc.includes('.rate-limit-input'), 'popup.css must style .rate-limit-input');
  assert.ok(cssSrc.includes('.rate-limits-hint'), 'popup.css must style .rate-limits-hint');
  assert.ok(cssSrc.includes('.rate-limits-warning'), 'popup.css must style .rate-limits-warning');

  // Light theme overrides
  assert.ok(cssSrc.includes('[data-theme="light"] .rate-limits-card'), 'popup.css must contain light theme for .rate-limits-card');
  assert.ok(cssSrc.includes('[data-theme="light"] .rate-limit-input'), 'popup.css must contain light theme for .rate-limit-input');
  assert.ok(cssSrc.includes('[data-theme="light"] .rate-limits-warning'), 'popup.css must contain light theme for .rate-limits-warning');
});

test('WI-28: i18n catalog contains all 6 rate limits keys across all 7 locales', () => {
  const requiredKeys = [
    'conn_rate_limits_title',
    'conn_rate_tab_label',
    'conn_rate_site_label',
    'conn_rate_concurrency_label',
    'conn_rate_clamp_hint',
    'conn_rate_warning'
  ];

  for (const locale of SUPPORTED_UI_LOCALES) {
    for (const key of requiredKeys) {
      assert.ok(
        MESSAGES[locale] && typeof MESSAGES[locale][key] === 'string' && MESSAGES[locale][key].trim().length > 0,
        `Locale "${locale}" must have non-empty message for key "${key}"`
      );
    }

    // Verify hint parameter replacement: min and max
    const hint = t(locale, 'conn_rate_clamp_hint', { min: 1, max: 20 });
    assert.ok(hint.includes('1'), `Hint for ${locale} should include min (1)`);
    assert.ok(hint.includes('20'), `Hint for ${locale} should include max (20)`);
  }
});
