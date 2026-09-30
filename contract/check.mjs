#!/usr/bin/env node
/**
 * check.mjs — Zero-dependency contract verification script for WebMCP Translator Kit.
 *
 * Verifies:
 * 1. All JSON and JSON Schema files parse without errors.
 * 2. All schemas specify $id, type: "object", and additionalProperties: false.
 * 3. All 20 typed error codes are aligned between direct-interface.md and error.schema.json.
 * 4. defaults.json contains all required frozen fields and exact initial default values.
 * 5. Every value in defaults.json matches the defaults table in direct-interface.md.
 * 6. All 6 required contract deliverables exist.
 * 7. No personal or machine paths appear in contract files.
 * 8. Schemas and direct-interface.md require canonical fields (items[].documentId, result.text, signal).
 * 9. Cross-checks against context/plan.md TS block if available.
 *
 * Exits with code 0 and prints CONTRACT_OK upon complete success.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const CONTRACT_DIR = path.dirname(__filename);

// 1. Verify required files and directory structure
const EXPECTED_ITEMS = [
  'README.md',
  'direct-interface.md',
  'defaults.json',
  'lifecycle.md',
  'schemas',
  'check.mjs',
];

for (const item of EXPECTED_ITEMS) {
  const itemPath = path.join(CONTRACT_DIR, item);
  assert(fs.existsSync(itemPath), `Missing required contract item: ${item}`);
}

const SCHEMA_FILES = [
  'translateBatch.request.schema.json',
  'translateBatch.result.schema.json',
  'listModels.result.schema.json',
  'error.schema.json',
];

for (const schemaFile of SCHEMA_FILES) {
  const schemaPath = path.join(CONTRACT_DIR, 'schemas', schemaFile);
  assert(fs.existsSync(schemaPath), `Missing schema file: schemas/${schemaFile}`);
}

// 2. Parse and validate JSON files & schemas
const defaultsPath = path.join(CONTRACT_DIR, 'defaults.json');
const defaultsContent = fs.readFileSync(defaultsPath, 'utf8');
const defaults = JSON.parse(defaultsContent);

const parsedSchemas = {};
for (const schemaFile of SCHEMA_FILES) {
  const schemaPath = path.join(CONTRACT_DIR, 'schemas', schemaFile);
  const raw = fs.readFileSync(schemaPath, 'utf8');
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${schemaFile}: ${err.message}`);
  }

  assert(schema.$id, `Schema ${schemaFile} must define an $id`);
  assert(
    schema.$id.startsWith('https://schemas.webmcp.org/translator/contract/v1/'),
    `Schema ${schemaFile} $id must start with https://schemas.webmcp.org/translator/contract/v1/`
  );
  assert.strictEqual(schema.type, 'object', `Schema ${schemaFile} top-level type must be 'object'`);
  assert.strictEqual(
    schema.additionalProperties,
    false,
    `Schema ${schemaFile} must enforce additionalProperties: false`
  );

  parsedSchemas[schemaFile] = schema;
}

// 3. Verify defaults.json content
assert.strictEqual(defaults.version, 'webmcp-translator-contract/1', 'defaults.version mismatch');
// Adjusted 2026-09-30 per measured batch latency (receipt R-49): 20000 -> 45000 (real-page TIMEOUT incident).
// Adjusted 2026-09-30 R-50 (receipts/dispatch-receipts.md): 45000 -> 60000, chunk 16/12KiB -> 64/24KiB (full-DOM single-request mode).
assert.strictEqual(defaults.provider.timeoutMs, 60000, 'provider.timeoutMs must be 60000 (measured adjustment 2026-09-30 R-50)');
assert.strictEqual(defaults.provider.listModelsTimeoutMs, 15000, 'provider.listModelsTimeoutMs must be 15000');
assert.strictEqual(defaults.provider.retryOnTimeout, 1, 'provider.retryOnTimeout must be 1');
assert.strictEqual(defaults.provider.maxRetries, 2, 'provider.maxRetries must be 2');
assert.strictEqual(defaults.provider.retryInitialDelayMs, 500, 'provider.retryInitialDelayMs must be 500');
assert.strictEqual(defaults.provider.retryMaxDelayMs, 1000, 'provider.retryMaxDelayMs must be 1000');
assert.strictEqual(defaults.provider.retryJitterRatio, 0.2, 'provider.retryJitterRatio must be 0.2');

// Adjusted 2026-09-30 (receipt R-49): 32 -> 16 items, 16384 -> 12288 bytes to keep p95 latency under the provider timeout.
assert.strictEqual(defaults.batch.maxItems, 64, 'batch.maxItems must be 64 (measured adjustment 2026-09-30 R-50)');
assert.strictEqual(defaults.batch.maxSourceBytesUtf8, 24576, 'batch.maxSourceBytesUtf8 must be 24576 (measured adjustment 2026-09-30 R-50)');
assert.strictEqual(defaults.batch.maxResponseBytes, 65536, 'batch.maxResponseBytes must be 65536');

assert.strictEqual(defaults.rateLimits.windowSeconds, 60, 'rateLimits.windowSeconds must be 60');
assert.strictEqual(defaults.rateLimits.tab.maxBatches, 4, 'rateLimits.tab.maxBatches must be 4');
assert.strictEqual(defaults.rateLimits.tab.maxSourceCodePoints, 12000, 'rateLimits.tab.maxSourceCodePoints must be 12000');
assert.strictEqual(defaults.rateLimits.site.maxBatches, 12, 'rateLimits.site.maxBatches must be 12');
assert.strictEqual(defaults.rateLimits.site.maxSourceCodePoints, 36000, 'rateLimits.site.maxSourceCodePoints must be 36000');

assert.strictEqual(defaults.cache.translation.ttlMs, 600000, 'cache.translation.ttlMs must be 600000');
assert.strictEqual(defaults.cache.translation.maxEntries, 500, 'cache.translation.maxEntries must be 500');
assert.strictEqual(defaults.cache.translation.maxSizeBytes, 2097152, 'cache.translation.maxSizeBytes must be 2097152');
assert.strictEqual(defaults.cache.listModels.ttlMs, 300000, 'cache.listModels.ttlMs must be 300000');

assert.strictEqual(defaults.throttle.patchMinIntervalMs, 200, 'throttle.patchMinIntervalMs must be 200');
assert.strictEqual(defaults.throttle.patchGroupSize, 64, 'throttle.patchGroupSize must be 64 (measured adjustment 2026-09-30 R-50)');
assert.strictEqual(defaults.recovery.contentRetryPerChunk, 1, 'recovery.contentRetryPerChunk must be 1 (2026-09-30 R-51)');
assert.strictEqual(defaults.recovery.contentRetryDelayMs, 800, 'recovery.contentRetryDelayMs must be 800 (2026-09-30 R-51)');
assert.strictEqual(defaults.recovery.splitOnFailure, true, 'recovery.splitOnFailure must be true (2026-09-30 R-51)');
assert.strictEqual(defaults.recovery.splitMaxDepth, 2, 'recovery.splitMaxDepth must be 2 (2026-09-30 R-51)');
assert.strictEqual(defaults.recovery.splitMinItems, 8, 'recovery.splitMinItems must be 8 (2026-09-30 R-51)');
assert.strictEqual(defaults.throttle.debounceMinMs, 200, 'throttle.debounceMinMs must be 200');
assert.strictEqual(defaults.throttle.debounceMaxMs, 300, 'throttle.debounceMaxMs must be 300');
assert.strictEqual(defaults.throttle.maxConcurrentRequests, 2, 'throttle.maxConcurrentRequests must be 2');

// 4. Cross-check defaults.json against direct-interface.md markdown table
const interfaceDocPath = path.join(CONTRACT_DIR, 'direct-interface.md');
const interfaceDoc = fs.readFileSync(interfaceDocPath, 'utf8');

// Helper to access nested property by dot path
function getNestedValue(obj, dotPath) {
  const parts = dotPath.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr == null || typeof curr !== 'object') return undefined;
    curr = curr[part];
  }
  return curr;
}

// Parse markdown table rows: | Parameter | `key` | `value` | Notes |
const tableRegex = /\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|/g;
let match;
let matchedTableRows = 0;

while ((match = tableRegex.exec(interfaceDoc)) !== null) {
  const key = match[2].trim();
  const rawValue = match[3].trim();

  // Only check keys that correspond to properties in defaults
  if (key.includes('.')) {
    matchedTableRows++;
    const expectedValue = isNaN(Number(rawValue)) ? rawValue : Number(rawValue);
    const actualValue = getNestedValue(defaults, key);

    assert(
      actualValue !== undefined,
      `Property '${key}' found in direct-interface.md table but missing in defaults.json`
    );
    assert.strictEqual(
      actualValue,
      expectedValue,
      `Value mismatch for '${key}': defaults.json has ${actualValue}, direct-interface.md table has ${expectedValue}`
    );
  }
}

assert(
  matchedTableRows >= 18,
  `Expected at least 18 table rows matching defaults keys in direct-interface.md, found ${matchedTableRows}`
);

// 5. Verify error code alignment between direct-interface.md and error.schema.json
const schemaErrorCodes = parsedSchemas['error.schema.json'].properties.code.enum;
assert(Array.isArray(schemaErrorCodes), 'error.schema.json enum must be an array');
assert.strictEqual(schemaErrorCodes.length, 20, `error.schema.json must contain exactly 20 error codes, found ${schemaErrorCodes.length}`);

// Extract error codes specifically from section 3 of direct-interface.md
const section3Match = interfaceDoc.match(/## 3\. Complete Typed Error Taxonomy([\s\S]*?)## 4\. Retry Policy/);
assert(section3Match, 'Could not find Section 3 (Error Taxonomy) in direct-interface.md');
const section3Text = section3Match[1];

const errorCodeRegex = /\|\s*`([A-Z0-9_x]+)`\s*\|\s*(?:Config|Security|Lifecycle|Rate|Guard|Consent|Provider|Network|Validation|HTTP)\s*\|/g;
const docErrorCodes = [];
while ((match = errorCodeRegex.exec(section3Text)) !== null) {
  const code = match[1];
  if (!docErrorCodes.includes(code)) {
    docErrorCodes.push(code);
  }
}

assert.strictEqual(
  docErrorCodes.length,
  20,
  `direct-interface.md must document exactly 20 error codes, found ${docErrorCodes.length}: ${docErrorCodes.join(', ')}`
);

for (const code of schemaErrorCodes) {
  assert(
    docErrorCodes.includes(code),
    `Error code '${code}' in error.schema.json is missing in direct-interface.md`
  );
}

// 6. Check that no local / user paths leak into contract files
const allContractFiles = [
  ...EXPECTED_ITEMS.filter((f) => f !== 'schemas'),
  ...SCHEMA_FILES.map((f) => path.join('schemas', f)),
];

const disallowedPatterns = [
  new RegExp('/' + 'Users' + '/'),
  new RegExp('/' + 'home' + '/'),
  new RegExp('/' + 'tmp' + '/'),
];

for (const relPath of allContractFiles) {
  const fullPath = path.join(CONTRACT_DIR, relPath);
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const pattern of disallowedPatterns) {
    assert(
      !pattern.test(content),
      `Disallowed machine/temp path pattern ${pattern} found in ${relPath}`
    );
  }
}

// 7. Verify mandatory interface & schema fields (SOL-1 anti-drift assertions)
const reqSchema = parsedSchemas['translateBatch.request.schema.json'];
const resSchema = parsedSchemas['translateBatch.result.schema.json'];

// Assert translateBatch.request.schema.json requires signal and items with documentId
assert(
  Array.isArray(reqSchema.required) && reqSchema.required.includes('signal'),
  "translateBatch.request.schema.json must require 'signal'"
);
assert(
  reqSchema.properties?.signal !== undefined,
  "translateBatch.request.schema.json must define 'signal' property"
);

const itemRequired = reqSchema.properties?.items?.items?.required;
assert(
  Array.isArray(itemRequired),
  'translateBatch.request.schema.json items must define required fields'
);
for (const field of ['id', 'documentId', 'revision', 'text']) {
  assert(
    itemRequired.includes(field),
    `translateBatch.request.schema.json items[].required must include '${field}'`
  );
}
assert(
  reqSchema.properties?.items?.items?.properties?.documentId !== undefined,
  "translateBatch.request.schema.json items[].properties must define 'documentId'"
);

// Assert translateBatch.result.schema.json requires id, revision, text and NOT translated
const resultRequired = resSchema.properties?.results?.items?.required;
assert(
  Array.isArray(resultRequired),
  'translateBatch.result.schema.json results must define required fields'
);
for (const field of ['id', 'revision', 'text']) {
  assert(
    resultRequired.includes(field),
    `translateBatch.result.schema.json results[].required must include '${field}'`
  );
}
assert(
  !resultRequired.includes('translated'),
  "translateBatch.result.schema.json results[].required must NOT include 'translated'"
);
assert(
  resSchema.properties?.results?.items?.properties?.text !== undefined,
  "translateBatch.result.schema.json results[].properties must define 'text'"
);
assert(
  resSchema.properties?.results?.items?.properties?.translated === undefined,
  "translateBatch.result.schema.json results[].properties must NOT define 'translated'"
);

// Assert direct-interface.md defines documentId, text in result, and mandatory signal
assert(
  interfaceDoc.includes('documentId: string'),
  "direct-interface.md must include 'documentId: string'"
);
assert(
  /export\s+(?:type|interface)\s+TranslationResult[^{]*\{[^}]*text\s*:\s*string/.test(interfaceDoc),
  "direct-interface.md TranslationResult must define 'text: string'"
);
assert(
  !/export\s+(?:type|interface)\s+TranslationResult[^{]*\{[^}]*translated\s*:\s*string/.test(interfaceDoc),
  "direct-interface.md TranslationResult must NOT define 'translated: string'"
);
assert(
  interfaceDoc.includes('signal: AbortSignal'),
  "direct-interface.md must require 'signal: AbortSignal' (mandatory, not optional)"
);

// 8. Cross-check against canonical context/plan.md (if TRANSLATOR_PLAN_PATH is set)
const planPath = process.env.TRANSLATOR_PLAN_PATH;
if (!planPath) {
  console.log('[plan-crosscheck] skipped (TRANSLATOR_PLAN_PATH not set)');
} else if (!fs.existsSync(planPath)) {
  console.warn(`[plan-crosscheck] Warning: ${planPath} not found, skipping plan cross-check`);
} else {
  const planContent = fs.readFileSync(planPath, 'utf8');
  const planMatch = planContent.match(
    /type\s+TranslationItem\s*=\s*\{([\s\S]*?)\};[\s\S]*?type\s+TranslationResult\s*=\s*\{([\s\S]*?)\};[\s\S]*?translateBatch\s*\(\s*input\s*:\s*\{([\s\S]*?)\}\s*\)/
  );

  assert(
    planMatch,
    `${planPath} exists but canonical TS interface block was not found in §Contract và interface cố định`
  );

  function extractFields(block) {
    const fields = { required: [], optional: [] };
    const cleaned = block.replace(/\/\/.*$/gm, '');
    const fieldRegex = /([a-zA-Z0-9_]+)(\?)?\s*:/g;
    let m;
    while ((m = fieldRegex.exec(cleaned)) !== null) {
      if (m[2] === '?') {
        fields.optional.push(m[1]);
      } else {
        fields.required.push(m[1]);
      }
    }
    return fields;
  }

  const planItemFields = extractFields(planMatch[1]);
  const planResultFields = extractFields(planMatch[2]);
  const planInputFields = extractFields(planMatch[3]);

  const sortArr = (arr) => [...arr].sort();

  // Validate items[].required against plan TranslationItem
  assert.deepStrictEqual(
    sortArr(itemRequired),
    sortArr(planItemFields.required),
    `Schema items[].required [${itemRequired}] does not match canonical plan TranslationItem required fields [${planItemFields.required}]`
  );

  // Validate results[].required against plan TranslationResult
  assert.deepStrictEqual(
    sortArr(resultRequired),
    sortArr(planResultFields.required),
    `Schema results[].required [${resultRequired}] does not match canonical plan TranslationResult required fields [${planResultFields.required}]`
  );

  // Validate request.required against plan translateBatch input
  assert.deepStrictEqual(
    sortArr(reqSchema.required),
    sortArr(planInputFields.required),
    `Schema translateBatch.request required [${reqSchema.required}] does not match canonical plan translateBatch input required fields [${planInputFields.required}]`
  );

  console.log(`[plan-crosscheck] Verified contract against canonical plan at ${planPath}`);
}

// 9. Validate contract/index.mjs exports match defaults.json
const contractIndexPath = path.join(CONTRACT_DIR, 'index.mjs');
assert(fs.existsSync(contractIndexPath), 'contract/index.mjs must exist');
const contractModule = await import(new URL('index.mjs', import.meta.url).href);

assert.strictEqual(
  contractModule.CONTRACT_VERSION,
  defaults.version,
  'contract/index.mjs CONTRACT_VERSION must match defaults.json version'
);
assert.deepStrictEqual(
  contractModule.defaults,
  defaults,
  'contract/index.mjs defaults must match defaults.json'
);
assert.strictEqual(
  path.resolve(contractModule.contractDir),
  path.resolve(CONTRACT_DIR),
  'contract/index.mjs contractDir must resolve to contract directory'
);
assert.strictEqual(
  path.resolve(contractModule.schemaDir),
  path.resolve(path.join(CONTRACT_DIR, 'schemas')),
  'contract/index.mjs schemaDir must resolve to contract/schemas directory'
);

const indexContent = fs.readFileSync(contractIndexPath, 'utf8');
for (const pattern of disallowedPatterns) {
  assert(
    !pattern.test(indexContent),
    `Disallowed machine/temp path pattern ${pattern} found in index.mjs`
  );
}

// Success output
console.log('CONTRACT_OK');
process.exit(0);
