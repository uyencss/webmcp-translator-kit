// WebMCP Translator Kit — Focused Verification for Sol 6.1 Acceptance Criteria
// Verifies:
// 1. Fallback rows delegation to renderFallbackList in popup.js with zero test regression
// 2. Single PARTIAL_BATCH logging (elimination of duplicate log in batch-executor.mjs)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFallbackRow, renderFallbackList } from '../extension/src/popup/modules/fallback-rows.mjs';
import { mergeBatchResults } from '../extension/src/sw/modules/batch-executor.mjs';
import { applyUiLocale } from '../extension/src/popup/modules/theme-manager.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'extension', 'src');
const popupSrc = fs.readFileSync(path.join(SRC, 'popup.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
const batchExecSrc = fs.readFileSync(path.join(SRC, 'sw', 'modules', 'batch-executor.mjs'), 'utf8');

test('Sol 6.1 Blocker 1: popup.js delegates fallback rows to renderFallbackList module', () => {
  // 1. Static assertion: popup.js must import and call renderFallbackList
  assert.ok(popupSrc.includes("import { renderFallbackList } from './popup/modules/fallback-rows.mjs'"),
    'popup.js must import renderFallbackList from fallback-rows.mjs');
  assert.ok(popupSrc.includes('renderFallbackList({'),
    'popup.js must invoke renderFallbackList with configuration object');

  // 2. Static assertion: popup.js must preserve fallback star control block for VM test compatibility
  const handlerIdx = popupSrc.indexOf('btnFallbackFav.addEventListener');
  assert.ok(handlerIdx > 0, 'popup.js must retain btnFallbackFav.addEventListener control');
  const handlerEnd = popupSrc.indexOf('\n      });\n\n      modelWrap.appendChild', handlerIdx);
  assert.ok(handlerEnd > handlerIdx, 'popup.js must retain modelWrap.appendChild following event listener');

  // 3. Behavioral assertion: renderFallbackList handles empty and populated lists
  const emptyContainer = {
    innerHTML: '',
    children: [],
    appendChild(child) { this.children.push(child); }
  };
  const mockDocument = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        children: [],
        appendChild(c) { this.children.push(c); },
        setAttribute() {},
        addEventListener() {}
      };
    }
  };

  const origDocument = globalThis.document;
  try {
    globalThis.document = mockDocument;
    const btnAdd = { disabled: false };

    // Empty state
    renderFallbackList({
      container: emptyContainer,
      fallbacks: [],
      btnAddFallback: btnAdd,
      currentUiLocale: 'vi',
      SVG_ICONS: { trash: '<svg></svg>', star: '<svg></svg>', eye: '<svg></svg>' },
      t: (_loc, key) => key
    });
    assert.equal(emptyContainer.children.length, 1);
    assert.equal(emptyContainer.children[0].className, 'auto-sites-empty');
    assert.equal(btnAdd.disabled, false);

    // Populated state with 2 items
    const populatedContainer = {
      innerHTML: '',
      children: [],
      appendChild(child) { this.children.push(child); }
    };
    renderFallbackList({
      container: populatedContainer,
      fallbacks: [
        { id: 'fb1', model: 'ag/gemini-3.8-flash', baseURL: 'https://api.example/v1' },
        { id: 'fb2', model: 'do/glm-5.3-flash', baseURL: 'https://api2.example/v1' }
      ],
      btnAddFallback: btnAdd,
      currentUiLocale: 'en',
      SVG_ICONS: { trash: '<svg></svg>', star: '<svg></svg>', eye: '<svg></svg>' },
      t: (_loc, key) => key
    });
    assert.equal(populatedContainer.children.length, 2);
    assert.equal(btnAdd.disabled, true, 'Add fallback button must be disabled at max 2 fallbacks');
  } finally {
    globalThis.document = origDocument;
  }
});

test('Sol 6.1 Blocker 2: PARTIAL_BATCH is logged exactly once (no duplicate in batch-executor.mjs)', async () => {
  // 1. Static assertion: batch-executor.mjs must NOT log PARTIAL_BATCH
  assert.ok(!batchExecSrc.includes("code: 'PARTIAL_BATCH'"),
    'batch-executor.mjs must NOT contain duplicate PARTIAL_BATCH logging');

  // 2. Static assertion: sw.js must log PARTIAL_BATCH once and return non-terminal flags
  assert.ok(swSrc.includes("code: 'PARTIAL_BATCH'"), 'sw.js must contain primary PARTIAL_BATCH error log');
  assert.ok(swSrc.includes('isTerminal: false'), 'PARTIAL_BATCH in sw.js must be non-terminal');
  assert.ok(swSrc.includes('failed: missingIds.length'), 'sw.js must calculate failed count');

  // 3. Behavioral assertion: mergeBatchResults correctly flags partial and missingIds without double-logging
  const mockHits = [{ index: 0, result: { text: 'Hello', id: '1' } }];
  const mockMisses = [{ index: 1, id: '2' }];
  const mockProviderRes = {
    results: [],
    partial: true,
    missingIds: ['2']
  };

  const outcome = await mergeBatchResults({
    hits: mockHits,
    misses: mockMisses,
    currentHits: mockHits,
    finalProviderRes: mockProviderRes,
    payload: {},
    requestedModel: 'primary-model',
    actualModel: 'fallback-model',
    currentModel: 'fallback-model',
    fallbackIndex: 1,
    actualBaseURL: 'https://api.example/v1',
    batchConfigRevision: 1,
    currentConfigRevision: 1,
    tabId: 101,
    extractHost: (url) => new URL(url).host
  });

  assert.equal(outcome.partial, true);
  assert.deepEqual(outcome.missingIds, ['2']);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.actualModel, 'fallback-model');
  assert.equal(outcome.fallbackIndex, 1);
  assert.equal(outcome.fallbackConsumed, true);
});

test('Sol 6.1 Blocker 3: applyUiLocale assigns currentUiLocale before executing render functions', () => {
  // 1. Static assertion in popup.js: currentUiLocale assignment must precede renderLocalizedStrings inside applyUiLocaleModule callback
  const fnIdx = popupSrc.indexOf('function applyUiLocale(locale)');
  assert.ok(fnIdx > 0, 'popup.js must define applyUiLocale');
  const fnEnd = popupSrc.indexOf('function renderLanguageDropdowns', fnIdx);
  const fnBody = popupSrc.slice(fnIdx, fnEnd);

  const assignIdx = fnBody.indexOf('currentUiLocale = loc;');
  const renderIdx = fnBody.indexOf('renderLocalizedStrings();');
  assert.ok(assignIdx > 0, 'applyUiLocale must assign currentUiLocale');
  assert.ok(renderIdx > 0, 'applyUiLocale must call renderLocalizedStrings');
  assert.ok(assignIdx < renderIdx, 'currentUiLocale = loc must execute BEFORE renderLocalizedStrings()');

  // 2. Behavioral assertion: theme-manager applyUiLocale updates DOM lang, selectUiLocale value, and executes callback
  const mockDoc = {
    documentElement: {
      lang: 'en'
    }
  };
  const mockSelect = {
    value: 'en'
  };
  let observedLocaleInCb = null;

  const origDocument = globalThis.document;
  try {
    globalThis.document = mockDoc;
    const returnedLoc = applyUiLocale('vi', mockSelect, (loc) => {
      observedLocaleInCb = loc;
    });

    assert.equal(returnedLoc, 'vi');
    assert.equal(mockDoc.documentElement.lang, 'vi');
    assert.equal(mockSelect.value, 'vi');
    assert.equal(observedLocaleInCb, 'vi');

    // Unsupported fallback to DEFAULT_UI_LOCALE ('vi')
    const fallbackLoc = applyUiLocale('invalid-locale-xyz', mockSelect, (loc) => {
      observedLocaleInCb = loc;
    });
    assert.equal(fallbackLoc, 'vi');
    assert.equal(mockDoc.documentElement.lang, 'vi');
    assert.equal(mockSelect.value, 'vi');
    assert.equal(observedLocaleInCb, 'vi');
  } finally {
    globalThis.document = origDocument;
  }
});
