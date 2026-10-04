// WebMCP Translator Kit — Pure Consent Policy Core
// Contract Version: webmcp-translator-contract/1

export class ConsentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalizes and validates a URL or origin string.
 * Only HTTP and HTTPS protocols are accepted.
 *
 * @param {string} input - URL or origin string
 * @returns {string|null} - Normalized origin (e.g. 'https://example.com') or null if invalid
 */
export function normalizeOrigin(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Checks whether an input string is a valid HTTP(S) origin or URL.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function isValidOrigin(input) {
  return normalizeOrigin(input) !== null;
}

/**
 * Calculates effective consent policy for a tab and site.
 *
 * Precedence hierarchy:
 * 1. Tab override (explicit 'on' | 'off')
 * 2. Site setting (boolean)
 * 3. Default: 'off'
 *
 * Fails closed with CONSENT_STATE_UNAVAILABLE if state is unreadable or corrupt.
 *
 * @param {object} options
 * @param {'on'|'off'|null|undefined} [options.tabOverride]
 * @param {boolean|null|undefined} [options.siteEnabled]
 * @param {any} [options.stateError]
 * @returns {'on'|'off'}
 * @throws {ConsentError} with code 'CONSENT_STATE_UNAVAILABLE'
 */
export function getEffectivePolicy({ tabOverride, siteEnabled, stateError } = {}) {
  if (stateError) {
    const reason = typeof stateError === 'string' ? stateError : (stateError?.message || 'Storage error');
    throw new ConsentError('CONSENT_STATE_UNAVAILABLE', `Consent state unavailable: ${reason}`, { reason });
  }

  // 1. Explicit Tab Override
  if (tabOverride === 'on') return 'on';
  if (tabOverride === 'off') return 'off';

  if (tabOverride !== null && tabOverride !== undefined) {
    throw new ConsentError(
      'CONSENT_STATE_UNAVAILABLE',
      `Corrupt tab override state: ${String(tabOverride)}`,
      { tabOverride }
    );
  }

  // 2. Site Setting
  if (siteEnabled === true) return 'on';
  if (siteEnabled === false) return 'off';

  if (siteEnabled !== null && siteEnabled !== undefined) {
    throw new ConsentError(
      'CONSENT_STATE_UNAVAILABLE',
      `Corrupt site enabled state: ${String(siteEnabled)}`,
      { siteEnabled }
    );
  }

  // 3. Default Policy: OFF
  return 'off';
}

/**
 * Checks whether a given hostname is a local loopback address.
 * Matches: localhost, 127.0.0.1, [::1], ::1, and 127.0.0.0/8 IPv4 range.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1' || clean === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // IPv4 loopback block 127.0.0.0/8
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/.test(clean)) {
    return true;
  }
  return false;
}

/**
 * Checks whether a URL uses HTTPS or loopback HTTP.
 * Remote HTTP is explicitly rejected.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSecureOrLoopbackBaseURL(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url.trim());
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      return isLoopbackHost(u.hostname);
    }
    return false;
  } catch {
    return false;
  }
}
