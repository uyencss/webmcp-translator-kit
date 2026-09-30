import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const srcDir = path.join(rootDir, 'extension', 'src');
const distDir = path.join(rootDir, 'extension', 'dist');

assert(fs.existsSync(srcDir), `Source directory does not exist: ${srcDir}`);

// 1. Clean extension/dist
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// 2. Copy extension/src/** -> extension/dist
function copyRecursive(src, dst) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      copyRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
copyRecursive(srcDir, distDir);

// 3. Rewrite dist manifest.json: version = package.json version
const srcManifestPath = path.join(srcDir, 'manifest.json');
const distManifestPath = path.join(distDir, 'manifest.json');

const srcManifest = JSON.parse(fs.readFileSync(srcManifestPath, 'utf8'));
const distManifest = JSON.parse(fs.readFileSync(distManifestPath, 'utf8'));

distManifest.version = pkg.version;
fs.writeFileSync(distManifestPath, JSON.stringify(distManifest, null, 2) + '\n');

// 4. Validate dist manifest
assert.strictEqual(distManifest.manifest_version, 3, 'manifest_version must be 3');
assert(
  typeof distManifest.key === 'string' && distManifest.key.length > 0,
  'manifest key must be a non-empty string'
);
assert.strictEqual(
  distManifest.key,
  srcManifest.key,
  'manifest key in dist must match src key exactly'
);
assert.deepStrictEqual(
  distManifest.permissions,
  ['activeTab', 'scripting', 'storage'],
  'manifest permissions must be exactly ["activeTab","scripting","storage"]'
);
assert.strictEqual(
  distManifest.content_scripts,
  undefined,
  'manifest must not have static content_scripts'
);
assert.strictEqual(
  distManifest.background?.type,
  'module',
  'manifest background.type must be "module"'
);
assert.strictEqual(
  distManifest.version,
  pkg.version,
  'manifest version must match package.json version'
);

// 5. Print summary + sha256 of dist manifest
const distManifestRaw = fs.readFileSync(distManifestPath);
const hash = crypto.createHash('sha256').update(distManifestRaw).digest('hex');

console.log(`Built extension to extension/dist (version: ${distManifest.version})`);
console.log(`Dist manifest SHA256: ${hash}`);
