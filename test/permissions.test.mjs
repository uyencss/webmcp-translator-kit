// Unit tests for Permissions & Dynamic Registration Helpers
// Contract Version: webmcp-translator-contract/1

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  originToScriptId,
  originToMatchPattern,
  calculateReconcileDiff
} from '../extension/src/permissions.mjs';

test('originToScriptId: stable, unique, and valid syntax', () => {
  const id1 = originToScriptId('https://example.com');
  const id2 = originToScriptId('https://example.com/');
  const id3 = originToScriptId('https://example.com/some/path?query=1');

  assert.ok(id1, 'Script ID must be non-null');
  assert.equal(id1, id2, 'Normalizes trailing slash to identical script ID');
  assert.equal(id1, id3, 'Normalizes path and query to identical origin script ID');

  assert.match(id1, /^translator-[0-9a-f]{16}$/, 'Script ID format must be translator- followed by 16 hex chars');

  const diffOriginId = originToScriptId('http://127.0.0.1:8089');
  assert.notEqual(id1, diffOriginId, 'Different origins must produce different script IDs');
  assert.match(diffOriginId, /^translator-[0-9a-f]{16}$/);

  // Invalid origins return null
  assert.equal(originToScriptId('chrome://extensions'), null);
  assert.equal(originToScriptId('not-a-url'), null);
  assert.equal(originToScriptId(''), null);
  assert.equal(originToScriptId(null), null);
});

test('originToMatchPattern: produces origin + "/*"', () => {
  assert.equal(originToMatchPattern('http://127.0.0.1:8089'), 'http://127.0.0.1:8089/*');
  assert.equal(originToMatchPattern('https://news.ycombinator.com/item?id=1'), 'https://news.ycombinator.com/*');
  assert.equal(originToMatchPattern('ftp://ftp.example.com'), null);
  assert.equal(originToMatchPattern(''), null);
});

test('calculateReconcileDiff: missing registration is added to toRegister', () => {
  const sites = {
    'http://127.0.0.1:8089': { createdAt: 1000 }
  };
  const registrations = {};
  const existingRegisteredScriptIds = [];
  const grantedOrigins = new Set(['http://127.0.0.1:8089']);

  const diff = calculateReconcileDiff({
    sites,
    registrations,
    existingRegisteredScriptIds,
    grantedOrigins
  });

  const expectedId = originToScriptId('http://127.0.0.1:8089');
  assert.equal(diff.toRegister.length, 1);
  assert.equal(diff.toRegister[0].scriptId, expectedId);
  assert.deepEqual(diff.toRegister[0].matches, ['http://127.0.0.1:8089/*']);
  assert.equal(diff.toUnregister.length, 0);
  assert.equal(diff.updatedRegistrations['http://127.0.0.1:8089'], expectedId);
  assert.ok(diff.updatedSites['http://127.0.0.1:8089']);
});

test('calculateReconcileDiff: stale registration is unregisterd', () => {
  const staleScriptId = 'translator-deadbeef12345678';
  const sites = {};
  const registrations = {
    'https://removed-site.com': staleScriptId
  };
  const existingRegisteredScriptIds = [staleScriptId];
  const grantedOrigins = new Set();

  const diff = calculateReconcileDiff({
    sites,
    registrations,
    existingRegisteredScriptIds,
    grantedOrigins
  });

  assert.equal(diff.toRegister.length, 0);
  assert.ok(diff.toUnregister.includes(staleScriptId));
  assert.deepEqual(diff.updatedRegistrations, {});
  assert.deepEqual(diff.updatedSites, {});
});

test('calculateReconcileDiff: revoked permission purges site and unregisters script', () => {
  const scriptId = originToScriptId('https://revoked.com');
  const sites = {
    'https://revoked.com': { createdAt: 2000 }
  };
  const registrations = {
    'https://revoked.com': scriptId
  };
  const existingRegisteredScriptIds = [scriptId];
  // Permission has been removed / not in grantedOrigins
  const grantedOrigins = new Set();

  const diff = calculateReconcileDiff({
    sites,
    registrations,
    existingRegisteredScriptIds,
    grantedOrigins
  });

  assert.equal(diff.toRegister.length, 0);
  assert.ok(diff.toUnregister.includes(scriptId));
  assert.equal(diff.updatedSites['https://revoked.com'], undefined, 'Revoked site must be purged from sites');
  assert.equal(diff.updatedRegistrations['https://revoked.com'], undefined);
});

test('calculateReconcileDiff: synchronized state is a noop', () => {
  const scriptId = originToScriptId('http://127.0.0.1:8089');
  const sites = {
    'http://127.0.0.1:8089': { createdAt: 3000 }
  };
  const registrations = {
    'http://127.0.0.1:8089': scriptId
  };
  const existingRegisteredScriptIds = [scriptId];
  const grantedOrigins = new Set(['http://127.0.0.1:8089']);

  const diff = calculateReconcileDiff({
    sites,
    registrations,
    existingRegisteredScriptIds,
    grantedOrigins
  });

  assert.equal(diff.toRegister.length, 0, 'No scripts to register when already synchronized');
  assert.equal(diff.toUnregister.length, 0, 'No scripts to unregister when active and permitted');
  assert.equal(diff.updatedRegistrations['http://127.0.0.1:8089'], scriptId);
  assert.ok(diff.updatedSites['http://127.0.0.1:8089']);
});
