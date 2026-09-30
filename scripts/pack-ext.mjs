#!/usr/bin/env node
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

const EXPECTED_DEV_EXTENSION_ID = 'feicbphhimmhddfdlahlfmhkhodkdffl';
const CRX_MAGIC = Buffer.from('Cr24', 'utf8');
const CRX_VERSION = 3;
const CRX_SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'utf8');

function printUsageAndExit(code = 2) {
  console.error(`Usage:
  TRANSLATOR_SIGNING_KEY=/path/to/key.pem node scripts/pack-ext.mjs
  node scripts/pack-ext.mjs --key /path/to/key.pem

Environment:
  TRANSLATOR_SIGNING_KEY   Path to private RSA key (.pem) (required unless --key is given)

Options:
  --key <path>             Path to private RSA key (.pem)
  -h, --help               Show this help message
`);
  process.exit(code);
}

// 1. Resolve signing key argument/env
function resolveSigningKey() {
  const args = process.argv.slice(2);
  let keyPath = process.env.TRANSLATOR_SIGNING_KEY;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      printUsageAndExit(0);
    }
    if (args[i] === '--key' && i + 1 < args.length) {
      keyPath = args[i + 1];
      i++;
    } else if (args[i].startsWith('--key=')) {
      keyPath = args[i].slice('--key='.length);
    }
  }

  if (!keyPath || keyPath.trim() === '') {
    console.error('Error: Missing signing key. Must specify TRANSLATOR_SIGNING_KEY or --key <path>.');
    printUsageAndExit(2);
  }

  const resolvedPath = path.resolve(process.cwd(), keyPath.trim());
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Signing key file not found: ${resolvedPath}`);
    printUsageAndExit(2);
  }

  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
  } catch (err) {
    console.error(`Error: Cannot read signing key file: ${resolvedPath} (${err.message})`);
    printUsageAndExit(2);
  }

  return resolvedPath;
}

// 2. Protobuf wire format helpers (zero external dependencies)
function encodeVarint(val) {
  let v = BigInt(val);
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNumber, buf) {
  const tag = (fieldNumber << 3) | 2;
  return Buffer.concat([
    encodeVarint(tag),
    encodeVarint(buf.length),
    buf
  ]);
}

function decodeProtobufFields(buf) {
  let pos = 0;
  const fields = [];
  while (pos < buf.length) {
    let tag = 0n;
    let shift = 0n;
    while (pos < buf.length) {
      const b = BigInt(buf[pos++]);
      tag |= (b & 0x7fn) << shift;
      shift += 7n;
      if (!(b & 0x80n)) break;
    }
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x07n);
    if (wireType === 0) {
      let val = 0n;
      let s = 0n;
      while (pos < buf.length) {
        const b = BigInt(buf[pos++]);
        val |= (b & 0x7fn) << s;
        s += 7n;
        if (!(b & 0x80n)) break;
      }
      fields.push({ fieldNum, wireType, value: val });
    } else if (wireType === 2) {
      let len = 0n;
      let s = 0n;
      while (pos < buf.length) {
        const b = BigInt(buf[pos++]);
        len |= (b & 0x7fn) << s;
        s += 7n;
        if (!(b & 0x80n)) break;
      }
      const length = Number(len);
      const val = buf.subarray(pos, pos + length);
      pos += length;
      fields.push({ fieldNum, wireType, value: val });
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType} at offset ${pos}`);
    }
  }
  return fields;
}

// 3. Extension ID derivation from DER SPKI public key
function computeExtensionId(pubKeyDer) {
  const hash = crypto.createHash('sha256').update(pubKeyDer).digest();
  const rawId16 = hash.subarray(0, 16);
  const idStr = Array.from(rawId16)
    .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0x0f)))
    .join('');
  return { rawId16, idStr };
}

// 4. Main packaging logic
function main() {
  const signingKeyPath = resolveSigningKey();

  // Step 1: Run build first
  console.log('--- Step 1: Running build (scripts/build.mjs) ---');
  const buildScript = path.join(rootDir, 'scripts', 'build.mjs');
  const buildProc = spawnSync(process.execPath, [buildScript], {
    cwd: rootDir,
    stdio: 'inherit'
  });
  if (buildProc.status !== 0) {
    console.error('Error: Build failed.');
    process.exit(1);
  }

  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;

  const distDir = path.join(rootDir, 'extension', 'dist');
  assert(fs.existsSync(distDir), `Dist directory does not exist: ${distDir}`);

  const artifactsDir = path.join(rootDir, 'dist-artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const zipFilename = `webmcp-translator-kit-${version}.zip`;
  const crxFilename = `webmcp-translator-kit-${version}.crx`;
  const zipPath = path.join(artifactsDir, zipFilename);
  const crxPath = path.join(artifactsDir, crxFilename);

  // Remove existing artifacts if any
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(crxPath, { force: true });

  // Step 2: ZIP packaging (contents of extension/dist at root)
  console.log(`--- Step 2: Creating ZIP archive (${zipFilename}) ---`);
  const zipBin = fs.existsSync('/usr/bin/zip') ? '/usr/bin/zip' : 'zip';
  const zipProc = spawnSync(zipBin, ['-q', '-r', '-FS', zipPath, '.', '-x', '*.DS_Store*'], {
    cwd: distDir,
    stdio: 'pipe'
  });
  if (zipProc.status !== 0) {
    console.error(`Error: Failed to create ZIP archive: ${zipProc.stderr.toString()}`);
    process.exit(1);
  }
  const zipBuffer = fs.readFileSync(zipPath);
  console.log(`ZIP created: ${zipPath} (${zipBuffer.length} bytes)`);

  // Step 3: CRX3 creation
  console.log(`--- Step 3: Creating signed CRX3 container (${crxFilename}) ---`);

  // Extract public key in DER format using openssl CLI
  const pubDerProc = spawnSync('openssl', ['pkey', '-in', signingKeyPath, '-pubout', '-outform', 'DER'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (pubDerProc.status !== 0) {
    console.error(`Error: Failed to extract DER public key using openssl: ${pubDerProc.stderr.toString()}`);
    process.exit(1);
  }
  const pubKeyDer = pubDerProc.stdout;

  // Verify extension ID matches expected fixed dev ID
  const { rawId16, idStr } = computeExtensionId(pubKeyDer);
  if (idStr !== EXPECTED_DEV_EXTENSION_ID) {
    console.error(`Error: Key does not match expected dev Extension ID!`);
    console.error(`Expected: ${EXPECTED_DEV_EXTENSION_ID}`);
    console.error(`Actual:   ${idStr}`);
    process.exit(1);
  }

  // Verify manifest.key matches base64 DER public key
  const distManifestPath = path.join(distDir, 'manifest.json');
  const distManifest = JSON.parse(fs.readFileSync(distManifestPath, 'utf8'));
  const pubKeyBase64 = pubKeyDer.toString('base64');
  if (distManifest.key !== pubKeyBase64) {
    console.error('Error: Public key DER base64 does not match manifest.key in extension/dist/manifest.json');
    process.exit(1);
  }

  // Construct signed_header_data (SignedData protobuf: field 1 = crx_id [16 bytes])
  const signedHeaderData = encodeLengthDelimited(1, rawId16);
  const signedHeaderSizeOctets = Buffer.alloc(4);
  signedHeaderSizeOctets.writeUInt32LE(signedHeaderData.length, 0);

  // Construct data to sign:
  // "CRX3 SignedData\0" (16 bytes) + signed_header_size (4 bytes LE) + signed_header_data + zipBuffer
  const toSign = Buffer.concat([
    CRX_SIGNATURE_CONTEXT,
    signedHeaderSizeOctets,
    signedHeaderData,
    zipBuffer
  ]);

  // Sign with openssl CLI: RSA/SHA-256
  const signProc = spawnSync('openssl', ['dgst', '-sha256', '-sign', signingKeyPath], {
    input: toSign,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (signProc.status !== 0) {
    console.error(`Error: openssl dgst signing failed: ${signProc.stderr.toString()}`);
    process.exit(1);
  }
  const signature = signProc.stdout;

  // AsymmetricKeyProof protobuf:
  // field 1 = public_key (bytes)
  // field 2 = signature (bytes)
  const proof = Buffer.concat([
    encodeLengthDelimited(1, pubKeyDer),
    encodeLengthDelimited(2, signature)
  ]);

  // CrxFileHeader protobuf:
  // field 2 = sha256_with_rsa (repeated AsymmetricKeyProof)
  // field 10000 = signed_header_data (bytes)
  const crxHeader = Buffer.concat([
    encodeLengthDelimited(2, proof),
    encodeLengthDelimited(10000, signedHeaderData)
  ]);

  // CRX3 file container:
  // [4 bytes] magic: "Cr24"
  // [4 bytes] version: 3 (uint32 LE)
  // [4 bytes] header_size: N (uint32 LE)
  // [N bytes] CrxFileHeader
  // [M bytes] zip archive
  const headerSizeOctets = Buffer.alloc(4);
  headerSizeOctets.writeUInt32LE(crxHeader.length, 0);

  const versionOctets = Buffer.alloc(4);
  versionOctets.writeUInt32LE(CRX_VERSION, 0);

  const crxBuffer = Buffer.concat([
    CRX_MAGIC,
    versionOctets,
    headerSizeOctets,
    crxHeader,
    zipBuffer
  ]);

  fs.writeFileSync(crxPath, crxBuffer);
  console.log(`CRX created: ${crxPath} (${crxBuffer.length} bytes)`);

  // Step 4: Self-verify
  console.log('--- Step 4: Self-verifying generated artifacts ---');
  try {
    selfVerify({
      crxPath,
      zipPath,
      pubKeyDer,
      expectedId: EXPECTED_DEV_EXTENSION_ID,
      manifestKey: distManifest.key
    });
  } catch (err) {
    console.error(`Verification FAILED: ${err.message}`);
    process.exit(1);
  }

  // Step 5: Summary output
  const crxHash = crypto.createHash('sha256').update(crxBuffer).digest('hex');
  const zipHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');

  console.log('\n================ Packaging Summary ================');
  console.log(`CRX: ${crxPath}`);
  console.log(`     Size:   ${crxBuffer.length} bytes`);
  console.log(`     SHA256: ${crxHash}`);
  console.log(`ZIP: ${zipPath}`);
  console.log(`     Size:   ${zipBuffer.length} bytes`);
  console.log(`     SHA256: ${zipHash}`);
  console.log(`Extension ID: ${idStr}`);
  console.log('Signature:    RSA-SHA256 (Verified OK)');
  console.log('PACK_OK');
  console.log('===================================================');
}

// 5. Self-verification routine
function selfVerify({ crxPath, zipPath, pubKeyDer, expectedId, manifestKey }) {
  const crxData = fs.readFileSync(crxPath);

  // 1. Magic check
  assert(crxData.length >= 12, 'CRX file is too small');
  const magic = crxData.subarray(0, 4);
  assert(magic.equals(CRX_MAGIC), `Invalid CRX magic: ${magic.toString('utf8')} (expected Cr24)`);

  // 2. Version check
  const version = crxData.readUInt32LE(4);
  assert.strictEqual(version, CRX_VERSION, `Invalid CRX version: ${version} (expected 3)`);

  // 3. Header size and slicing
  const headerSize = crxData.readUInt32LE(8);
  assert(crxData.length >= 12 + headerSize, 'CRX file truncated before header end');
  const headerBytes = crxData.subarray(12, 12 + headerSize);
  const zipBytesFromCrx = crxData.subarray(12 + headerSize);

  // Compare zip payload in CRX with standalone zip
  const standaloneZip = fs.readFileSync(zipPath);
  assert(
    zipBytesFromCrx.equals(standaloneZip),
    'Zip payload embedded inside CRX does not match standalone ZIP file byte-for-byte'
  );

  // 4. Protobuf header parsing
  const headerFields = decodeProtobufFields(headerBytes);
  const signedHeaderField = headerFields.find(f => f.fieldNum === 10000 && f.wireType === 2);
  assert(signedHeaderField, 'Missing signed_header_data (tag 10000) in CrxFileHeader');

  const signedDataFields = decodeProtobufFields(signedHeaderField.value);
  const crxIdField = signedDataFields.find(f => f.fieldNum === 1 && f.wireType === 2);
  assert(crxIdField, 'Missing crx_id (tag 1) in SignedData');
  assert.strictEqual(crxIdField.value.length, 16, 'crx_id must be exactly 16 bytes');

  const rsaProofField = headerFields.find(f => f.fieldNum === 2 && f.wireType === 2);
  assert(rsaProofField, 'Missing sha256_with_rsa (tag 2) in CrxFileHeader');

  const proofFields = decodeProtobufFields(rsaProofField.value);
  const pubKeyField = proofFields.find(f => f.fieldNum === 1 && f.wireType === 2);
  const sigField = proofFields.find(f => f.fieldNum === 2 && f.wireType === 2);
  assert(pubKeyField, 'Missing public_key (tag 1) in AsymmetricKeyProof');
  assert(sigField, 'Missing signature (tag 2) in AsymmetricKeyProof');

  assert(pubKeyField.value.equals(pubKeyDer), 'Public key in CRX header does not match derived public key');

  // 5. Check extension ID
  const { rawId16, idStr } = computeExtensionId(pubKeyField.value);
  assert.strictEqual(idStr, expectedId, `Derived Extension ID mismatch: ${idStr} !== ${expectedId}`);
  assert(crxIdField.value.equals(rawId16), 'crx_id in SignedData does not match first 16 bytes of SHA256(pubKey)');
  assert.strictEqual(
    pubKeyField.value.toString('base64'),
    manifestKey,
    'Derived public key base64 does not match manifest.key'
  );

  // 6. Test ZIP contents using unzip -l and unzip -t
  const unzipBin = fs.existsSync('/usr/bin/unzip') ? '/usr/bin/unzip' : 'unzip';
  const unzipListProc = spawnSync(unzipBin, ['-l', zipPath], { stdio: 'pipe' });
  assert.strictEqual(unzipListProc.status, 0, `unzip -l failed: ${unzipListProc.stderr.toString()}`);

  const unzipOutput = unzipListProc.stdout.toString();
  // Ensure manifest.json is at root of zip (not inside a subfolder)
  const hasRootManifest = /(^|\s)manifest\.json(\s|$)/m.test(unzipOutput);
  assert(hasRootManifest, 'ZIP does not contain manifest.json at root level');

  const unzipTestProc = spawnSync(unzipBin, ['-t', zipPath], { stdio: 'pipe' });
  assert.strictEqual(unzipTestProc.status, 0, `unzip -t failed: ${unzipTestProc.stderr.toString()}`);

  // 7. Verify signature using openssl CLI
  const signedHeaderSizeOctets = Buffer.alloc(4);
  signedHeaderSizeOctets.writeUInt32LE(signedHeaderField.value.length, 0);

  const envelopeToVerify = Buffer.concat([
    CRX_SIGNATURE_CONTEXT,
    signedHeaderSizeOctets,
    signedHeaderField.value,
    zipBytesFromCrx
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-verify-'));
  const tmpPubPath = path.join(tmpDir, 'pubkey.der');
  const tmpSigPath = path.join(tmpDir, 'sig.bin');

  try {
    fs.writeFileSync(tmpPubPath, pubKeyField.value);
    fs.writeFileSync(tmpSigPath, sigField.value);

    const opensslVerifyProc = spawnSync(
      'openssl',
      ['dgst', '-sha256', '-keyform', 'DER', '-verify', tmpPubPath, '-signature', tmpSigPath],
      {
        input: envelopeToVerify,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    assert.strictEqual(
      opensslVerifyProc.status,
      0,
      `openssl dgst -verify returned code ${opensslVerifyProc.status}: ${opensslVerifyProc.stderr.toString()}`
    );
    const verifyOutput = opensslVerifyProc.stdout.toString().trim();
    assert(
      verifyOutput.includes('Verified OK'),
      `openssl dgst -verify output does not contain "Verified OK": ${verifyOutput}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Node crypto verification as dual check
  const nodeVerify = crypto.createVerify('SHA256');
  nodeVerify.update(envelopeToVerify);
  const nodeVerifyOk = nodeVerify.verify(
    { key: pubKeyField.value, format: 'der', type: 'spki' },
    sigField.value
  );
  assert(nodeVerifyOk, 'node:crypto verification failed on CRX envelope');
}

main();
