import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_VERSION, defaults } from '../contract/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('contract index exports CONTRACT_VERSION matching defaults.json', () => {
  const defaultsPath = path.join(rootDir, 'contract', 'defaults.json');
  const defaultsJson = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  assert.strictEqual(CONTRACT_VERSION, defaultsJson.version);
  assert.deepStrictEqual(defaults, defaultsJson);
});

test('package.json name and version match frozen decisions', () => {
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(pkg.name, '@gyga-browser/webmcp-translator-kit');
  assert.strictEqual(pkg.version, '0.1.4');
});
