// Unit tests for Consent Core module
// Contract Version: webmcp-translator-contract/1

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOrigin,
  isValidOrigin,
  getEffectivePolicy,
  ConsentError
} from '../extension/src/consent.mjs';

test('normalizeOrigin: valid HTTP/HTTPS URLs and origins', () => {
  assert.equal(normalizeOrigin('https://example.com'), 'https://example.com');
  assert.equal(normalizeOrigin('http://example.com/'), 'http://example.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:8089/fixture.html?q=1#hash'), 'http://127.0.0.1:8089');
  assert.equal(normalizeOrigin('https://sub.domain.co.uk:8443/path'), 'https://sub.domain.co.uk:8443');
  assert.equal(normalizeOrigin('  https://space-padded.com/  '), 'https://space-padded.com');

  assert.equal(isValidOrigin('https://example.com'), true);
  assert.equal(isValidOrigin('http://localhost:3000'), true);
});

test('normalizeOrigin: reject invalid or non-HTTP(S) schemes', () => {
  assert.equal(normalizeOrigin('chrome://extensions'), null);
  assert.equal(normalizeOrigin('chrome-extension://abcdefghijklmnop/popup.html'), null);
  assert.equal(normalizeOrigin('file:///Users/ttcenter/index.html'), null);
  assert.equal(normalizeOrigin('data:text/html,<h1>Hello</h1>'), null);
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
  assert.equal(normalizeOrigin('ftp://ftp.example.com'), null);
  assert.equal(normalizeOrigin('about:blank'), null);
  assert.equal(normalizeOrigin(''), null);
  assert.equal(normalizeOrigin('   '), null);
  assert.equal(normalizeOrigin(null), null);
  assert.equal(normalizeOrigin(undefined), null);
  assert.equal(normalizeOrigin(12345), null);
  assert.equal(normalizeOrigin({}), null);

  assert.equal(isValidOrigin('chrome://flags'), false);
  assert.equal(isValidOrigin('file:///tmp/test'), false);
  assert.equal(isValidOrigin(''), false);
});

test('getEffectivePolicy: default policy is strictly OFF', () => {
  assert.equal(getEffectivePolicy({}), 'off');
  assert.equal(getEffectivePolicy({ tabOverride: null, siteEnabled: false }), 'off');
  assert.equal(getEffectivePolicy({ tabOverride: undefined, siteEnabled: undefined }), 'off');
});

test('getEffectivePolicy: site setting applies when no tab override', () => {
  assert.equal(getEffectivePolicy({ siteEnabled: true }), 'on');
  assert.equal(getEffectivePolicy({ siteEnabled: false }), 'off');
  assert.equal(getEffectivePolicy({ tabOverride: null, siteEnabled: true }), 'on');
  assert.equal(getEffectivePolicy({ tabOverride: undefined, siteEnabled: true }), 'on');
});

test('getEffectivePolicy: tab override "off" overrides site enabled "true"', () => {
  assert.equal(
    getEffectivePolicy({ tabOverride: 'off', siteEnabled: true }),
    'off',
    'Tab override off must strictly override site on'
  );
});

test('getEffectivePolicy: tab override "on" overrides site enabled "false"', () => {
  assert.equal(
    getEffectivePolicy({ tabOverride: 'on', siteEnabled: false }),
    'on',
    'Tab override on must strictly override site off'
  );
  assert.equal(
    getEffectivePolicy({ tabOverride: 'on', siteEnabled: undefined }),
    'on',
    'Tab override on must work even when site is undefined (default off)'
  );
});

test('getEffectivePolicy: fail-closed on state error', () => {
  assert.throws(
    () => getEffectivePolicy({ stateError: new Error('Session storage read failed') }),
    (err) => {
      assert.ok(err instanceof ConsentError);
      assert.equal(err.code, 'CONSENT_STATE_UNAVAILABLE');
      assert.match(err.message, /Session storage read failed/);
      return true;
    }
  );

  assert.throws(
    () => getEffectivePolicy({ stateError: 'Corrupt storage area' }),
    (err) => {
      assert.ok(err instanceof ConsentError);
      assert.equal(err.code, 'CONSENT_STATE_UNAVAILABLE');
      return true;
    }
  );
});

test('getEffectivePolicy: fail-closed on corrupt tabOverride or siteEnabled value', () => {
  assert.throws(
    () => getEffectivePolicy({ tabOverride: 'invalid_status' }),
    (err) => {
      assert.ok(err instanceof ConsentError);
      assert.equal(err.code, 'CONSENT_STATE_UNAVAILABLE');
      return true;
    }
  );

  assert.throws(
    () => getEffectivePolicy({ siteEnabled: 'true_string' }),
    (err) => {
      assert.ok(err instanceof ConsentError);
      assert.equal(err.code, 'CONSENT_STATE_UNAVAILABLE');
      return true;
    }
  );
});
