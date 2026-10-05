#!/usr/bin/env node
/**
 * pack-store.mjs — Packages a clean Chrome Web Store submission ZIP.
 *
 * Requirements for CWS upload:
 * 1. Clean ZIP archive containing extension/dist contents at root.
 * 2. manifest.json must NOT contain the dev "key" field (Chrome Web Store assigns and manages keys).
 * 3. Verified with unzip -l and unzip -t.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function main() {
  console.log('--- Step 1: Building extension from source ---');
  const buildScript = path.join(rootDir, 'scripts', 'build.mjs');
  const buildProc = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
  if (buildProc.status !== 0) {
    console.error('Error: Build failed');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = pkg.version;
  assert(version, 'Missing package.json version');

  const distDir = path.join(rootDir, 'extension', 'dist');
  assert(fs.existsSync(distDir), `Missing dist directory: ${distDir}`);

  const artifactsDir = path.join(rootDir, 'dist-artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const storeZipFilename = `webmcp-translator-kit-${version}-store.zip`;
  const storeZipPath = path.join(artifactsDir, storeZipFilename);

  // Remove existing artifact if any
  fs.rmSync(storeZipPath, { force: true });

  // Create staging directory for store package
  const tmpStaging = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-store-staging-'));

  try {
    // Copy all files from extension/dist
    function copyDir(src, dst) {
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(dstPath, { recursive: true });
          copyDir(srcPath, dstPath);
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    }
    copyDir(distDir, tmpStaging);

    // Strip "key" from manifest.json for CWS submission
    const manifestPath = path.join(tmpStaging, 'manifest.json');
    assert(fs.existsSync(manifestPath), 'manifest.json missing in dist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.key;
    manifest.version = version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    console.log(`--- Step 2: Creating Store ZIP archive (${storeZipFilename}) ---`);
    const zipBin = fs.existsSync('/usr/bin/zip') ? '/usr/bin/zip' : 'zip';
    const zipProc = spawnSync(zipBin, ['-q', '-r', '-FS', storeZipPath, '.', '-x', '*.DS_Store*'], {
      cwd: tmpStaging,
      stdio: 'pipe'
    });
    if (zipProc.status !== 0) {
      console.error(`Error: Failed to create store ZIP archive: ${zipProc.stderr.toString()}`);
      process.exit(1);
    }

    // Step 3: Self-verify ZIP contents
    console.log('--- Step 3: Verifying Store ZIP archive ---');
    const unzipBin = fs.existsSync('/usr/bin/unzip') ? '/usr/bin/unzip' : 'unzip';
    const unzipListProc = spawnSync(unzipBin, ['-l', storeZipPath], { stdio: 'pipe' });
    assert.strictEqual(unzipListProc.status, 0, `unzip -l failed: ${unzipListProc.stderr.toString()}`);

    const unzipOutput = unzipListProc.stdout.toString();
    const hasRootManifest = /(^|\s)manifest\.json(\s|$)/m.test(unzipOutput);
    assert(hasRootManifest, 'Store ZIP does not contain manifest.json at root level');

    const unzipTestProc = spawnSync(unzipBin, ['-t', storeZipPath], { stdio: 'pipe' });
    assert.strictEqual(unzipTestProc.status, 0, `unzip -t failed: ${unzipTestProc.stderr.toString()}`);

    // Verify manifest in zip does NOT have key
    const unzipCatProc = spawnSync(unzipBin, ['-p', storeZipPath, 'manifest.json'], { stdio: 'pipe' });
    assert.strictEqual(unzipCatProc.status, 0);
    const zippedManifest = JSON.parse(unzipCatProc.stdout.toString());
    assert.strictEqual(zippedManifest.key, undefined, 'Store ZIP manifest.json must NOT contain "key" field');
    assert.strictEqual(zippedManifest.version, version, `Store ZIP version must be ${version}`);

    const zipBuffer = fs.readFileSync(storeZipPath);
    const zipSha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');

    console.log('\n================ Store Package Summary ================');
    console.log(`Store ZIP: ${storeZipPath}`);
    console.log(`Size:      ${zipBuffer.length} bytes`);
    console.log(`SHA256:    ${zipSha256}`);
    console.log(`Version:   ${version}`);
    console.log('Manifest:  manifest.json at root, "key" stripped for CWS');
    console.log('Status:    STORE_PACK_OK');
    console.log('=======================================================\n');
  } finally {
    fs.rmSync(tmpStaging, { recursive: true, force: true });
  }
}

main();
