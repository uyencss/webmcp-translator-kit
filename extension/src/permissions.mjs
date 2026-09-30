// WebMCP Translator Kit — Dynamic Permissions & Script Registration Helpers
// Contract Version: webmcp-translator-contract/1

import { normalizeOrigin } from './consent.mjs';

/**
 * Generates a fast, deterministic 64-bit hash as 16 hexadecimal characters.
 * Pure synchronous implementation that runs in both Service Worker and Node.js.
 *
 * @param {string} str
 * @returns {string} 16-character hex string
 */
function hashString(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c64e6d ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hexH1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hexH2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${hexH1}${hexH2}`;
}

/**
 * Generates a stable, unique, and valid Chrome script ID for an origin.
 * Format: 'translator-' + 16-hex-hash
 *
 * @param {string} origin
 * @returns {string|null}
 */
export function originToScriptId(origin) {
  const norm = normalizeOrigin(origin);
  if (!norm) return null;
  return `translator-${hashString(norm)}`;
}

/**
 * Returns the match pattern corresponding to an origin.
 * Format: origin + '/*'
 *
 * @param {string} origin
 * @returns {string|null}
 */
export function originToMatchPattern(origin) {
  const norm = normalizeOrigin(origin);
  if (!norm) return null;
  return `${norm}/*`;
}

/**
 * Pure diff calculation for dynamic content script registrations and storage reconciliation.
 *
 * @param {object} params
 * @param {Record<string, any>} params.sites - Stored site configurations
 * @param {Record<string, string>} params.registrations - Stored origin -> scriptId mappings
 * @param {Iterable<string>} params.existingRegisteredScriptIds - Current script IDs from chrome.scripting
 * @param {Iterable<string>|((origin: string) => boolean)} params.grantedOrigins - Granted origins or checker
 * @returns {{
 *   toRegister: Array<{ origin: string, scriptId: string, matches: string[] }>,
 *   toUnregister: string[],
 *   updatedRegistrations: Record<string, string>,
 *   updatedSites: Record<string, any>
 * }}
 */
export function calculateReconcileDiff({
  sites = {},
  registrations = {},
  existingRegisteredScriptIds = [],
  grantedOrigins = []
} = {}) {
  const hasGranted = typeof grantedOrigins === 'function'
    ? grantedOrigins
    : (orig) => {
        if (grantedOrigins instanceof Set) return grantedOrigins.has(orig);
        if (Array.isArray(grantedOrigins)) return grantedOrigins.includes(orig);
        return false;
      };

  const existingSet = existingRegisteredScriptIds instanceof Set
    ? existingRegisteredScriptIds
    : new Set(existingRegisteredScriptIds || []);

  const toRegister = [];
  const toUnregisterSet = new Set();
  const updatedRegistrations = {};
  const updatedSites = {};

  // 1. Process all currently stored sites
  for (const [rawOrigin, siteData] of Object.entries(sites || {})) {
    const norm = normalizeOrigin(rawOrigin);
    if (!norm || !siteData) {
      // Stale or invalid site entry -> unregister if previously mapped
      const prevId = registrations[rawOrigin] || (norm ? originToScriptId(norm) : null);
      if (prevId) toUnregisterSet.add(prevId);
      continue;
    }

    const scriptId = originToScriptId(norm);
    const isGranted = hasGranted(norm);

    if (isGranted) {
      updatedSites[norm] = siteData;
      updatedRegistrations[norm] = scriptId;

      if (!existingSet.has(scriptId)) {
        toRegister.push({
          origin: norm,
          scriptId,
          matches: [originToMatchPattern(norm)]
        });
      }
    } else {
      // Permission missing or revoked -> unregister and purge from sites & registrations
      toUnregisterSet.add(scriptId);
      const prevId = registrations[norm] || registrations[rawOrigin];
      if (prevId) toUnregisterSet.add(prevId);
    }
  }

  // 2. Identify stale/orphan registrations in existingRegisteredScriptIds
  const validScriptIds = new Set(Object.values(updatedRegistrations));
  for (const scriptId of existingSet) {
    if (typeof scriptId === 'string' && scriptId.startsWith('translator-')) {
      if (!validScriptIds.has(scriptId)) {
        toUnregisterSet.add(scriptId);
      }
    }
  }

  return {
    toRegister,
    toUnregister: Array.from(toUnregisterSet),
    updatedRegistrations,
    updatedSites
  };
}
