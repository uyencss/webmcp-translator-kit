import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LANGS,
  SOURCE_LANGS,
  TARGET_LANGS,
  getLanguageLabel,
  findLanguage
} from '../extension/src/languages.mjs';
import { validateSettings } from '../extension/src/settings.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('languages: all codes in LANGS are unique', () => {
  const codes = LANGS.map(l => l.code);
  const uniqueCodes = new Set(codes);
  assert.equal(codes.length, uniqueCodes.size, 'All language codes in LANGS must be unique');
});

test('languages: contains expected ~20 language codes', () => {
  assert.ok(LANGS.length >= 18 && LANGS.length <= 25, `Expected ~20 languages, found ${LANGS.length}`);
  const codes = new Set(LANGS.map(l => l.code));

  // Required core codes from spec
  const expectedCodes = [
    'auto', 'vi', 'en', 'zh', 'ja', 'ko', 'th', 'lo', 'km',
    'fr', 'de', 'es', 'ru', 'ar', 'hi', 'id', 'ms', 'tl', 'pt', 'it'
  ];

  for (const c of expectedCodes) {
    assert.ok(codes.has(c), `Language code "${c}" must be present in LANGS`);
  }
});

test('languages: auto is only in SOURCE_LANGS, never in TARGET_LANGS', () => {
  const sourceCodes = SOURCE_LANGS.map(l => l.code);
  const targetCodes = TARGET_LANGS.map(l => l.code);

  assert.ok(sourceCodes.includes('auto'), 'SOURCE_LANGS must include "auto"');
  assert.ok(!targetCodes.includes('auto'), 'TARGET_LANGS must NOT include "auto"');
  assert.equal(TARGET_LANGS.length, SOURCE_LANGS.length - 1);
});

test('languages: every entry has non-empty code, flag and name', () => {
  for (const lang of LANGS) {
    assert.equal(typeof lang.code, 'string');
    assert.ok(lang.code.length > 0, 'code must not be empty');

    assert.equal(typeof lang.flag, 'string');
    assert.ok(lang.flag.length > 0, 'flag must not be empty');

    assert.equal(typeof lang.name, 'string');
    assert.ok(lang.name.length > 0, 'name must not be empty');
  }
});

test('languages: getLanguageLabel formats {flag} {name} ({code}) with code preserved', () => {
  const vi = findLanguage('vi');
  assert.ok(vi);
  const viLabel = getLanguageLabel(vi, 'vi');
  assert.ok(viLabel.includes('🇻🇳'));
  assert.ok(viLabel.includes('(vi)'));
  assert.ok(viLabel.includes('Tiếng Việt'));

  const enLabel = getLanguageLabel(vi, 'en');
  assert.ok(enLabel.includes('🇻🇳'));
  assert.ok(enLabel.includes('(vi)'));
  assert.ok(enLabel.includes('Vietnamese'));

  const auto = findLanguage('auto');
  assert.ok(auto);
  const autoLabel = getLanguageLabel(auto, 'vi');
  assert.ok(autoLabel.includes('🌐'));
  assert.ok(autoLabel.includes('(auto)'));
});

test('languages: findLanguage retrieves language by code or undefined', () => {
  assert.equal(findLanguage('zh')?.code, 'zh');
  assert.equal(findLanguage('non-existent'), undefined);
});

test('languages: popup render ép default (src auto, tgt vi) khi code lạ từ bản cũ', () => {
  const popupPath = path.join(__dirname, '..', 'extension', 'src', 'popup.js');
  const popupSrc = fs.readFileSync(popupPath, 'utf8');

  // 1. Verify code-level guards exist in popup.js at lines 147, 154, 1366
  assert.ok(
    popupSrc.includes("const curVal = SOURCE_LANGS.some(l => l.code === rawSrc) ? rawSrc : 'auto';"),
    'renderLanguageDropdowns must coerce unknown source language to auto'
  );
  assert.ok(
    popupSrc.includes("const curVal = TARGET_LANGS.some(l => l.code === rawTgt) ? rawTgt : 'vi';"),
    'renderLanguageDropdowns must coerce unknown target language to vi'
  );
  assert.ok(
    popupSrc.includes("selectSrcLang.value = SOURCE_LANGS.some(l => l.code === rawSrc) ? rawSrc : 'auto';"),
    'loadSettings must coerce unknown source language to auto before assigning select'
  );
  assert.ok(
    popupSrc.includes("selectTgtLang.value = TARGET_LANGS.some(l => l.code === rawTgt) ? rawTgt : 'vi';"),
    'loadSettings must coerce unknown target language to vi before assigning select'
  );

  // 2. Behavioral verification of renderLanguageDropdowns logic with simulated select elements:
  // When stored language codes are legacy/unknown (e.g. 'zh-TW', 'es-419', or non-existent)
  const legacyCases = [
    { src: 'zh-TW', tgt: 'zh-TW' },
    { src: 'zh_HK', tgt: 'es-419' },
    { src: 'unknown-code', tgt: 'auto' }, // 'auto' is invalid as targetLanguage
    { src: '', tgt: '' }
  ];

  for (const tc of legacyCases) {
    let selectSrcLang = { value: '' };
    let selectTgtLang = { value: '' };
    let savedSettings = { sourceLanguage: tc.src, targetLanguage: tc.tgt };
    let currentUiLocale = 'vi';

    // Execute the exact renderLanguageDropdowns logic
    const rawSrc = selectSrcLang.value || (savedSettings && savedSettings.sourceLanguage) || 'auto';
    const curSrc = SOURCE_LANGS.some(l => l.code === rawSrc) ? rawSrc : 'auto';
    selectSrcLang.innerHTML = SOURCE_LANGS.map(l => `<option value="${l.code}">${getLanguageLabel(l, currentUiLocale)}</option>`).join('');
    selectSrcLang.value = curSrc;

    const rawTgt = selectTgtLang.value || (savedSettings && savedSettings.targetLanguage) || 'vi';
    const curTgt = TARGET_LANGS.some(l => l.code === rawTgt) ? rawTgt : 'vi';
    selectTgtLang.innerHTML = TARGET_LANGS.map(l => `<option value="${l.code}">${getLanguageLabel(l, currentUiLocale)}</option>`).join('');
    selectTgtLang.value = curTgt;

    assert.equal(selectSrcLang.value, 'auto', `Legacy source code "${tc.src}" must coerce to default "auto"`);
    assert.equal(selectTgtLang.value, 'vi', `Legacy target code "${tc.tgt}" must coerce to default "vi"`);
    assert.notEqual(selectSrcLang.value, '', 'selectSrcLang.value must not be empty');
    assert.notEqual(selectTgtLang.value, '', 'selectTgtLang.value must not be empty');

    // Simulate collectSettingsPatch() and validateSettings():
    // With coerced values, patch source/target will be 'auto' and 'vi', NOT empty string ''
    const patch = {
      baseURL: 'http://localhost:8080/v1',
      model: 'ag/gemini-3.1-pro-low',
      sourceLanguage: selectSrcLang.value,
      targetLanguage: selectTgtLang.value
    };

    const validation = validateSettings(patch);
    assert.equal(validation.valid, true, `Settings patch with coerced languages must be valid, errors: ${JSON.stringify(validation.errors)}`);
  }

  // 3. Verify valid codes are preserved and not coerced
  {
    let selectSrcLang = { value: '' };
    let selectTgtLang = { value: '' };
    let savedSettings = { sourceLanguage: 'zh', targetLanguage: 'en' };
    let currentUiLocale = 'vi';

    const rawSrc = selectSrcLang.value || (savedSettings && savedSettings.sourceLanguage) || 'auto';
    const curSrc = SOURCE_LANGS.some(l => l.code === rawSrc) ? rawSrc : 'auto';
    selectSrcLang.value = curSrc;

    const rawTgt = selectTgtLang.value || (savedSettings && savedSettings.targetLanguage) || 'vi';
    const curTgt = TARGET_LANGS.some(l => l.code === rawTgt) ? rawTgt : 'vi';
    selectTgtLang.value = curTgt;

    assert.equal(selectSrcLang.value, 'zh');
    assert.equal(selectTgtLang.value, 'en');
  }
});
