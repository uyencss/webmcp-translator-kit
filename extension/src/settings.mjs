// WebMCP Translator Kit — Pure Settings Schema, Versioning & Migration
// Contract Version: webmcp-translator-contract/1

import { normalizeOrigin } from './consent.mjs';

export const SETTINGS_VERSION = 5;

export const VALID_PER_SITE_MODES = Object.freeze(['inherit', 'scroll-follow', 'full']);

/**
 * Normalizes a single per-site auto translate configuration.
 * Accepts either a string origin or an object.
 * Returns { origin, mode, autoStart, sourceLanguage, targetLanguage } or null.
 *
 * @param {unknown} item
 * @returns {{ origin: string, mode: 'inherit'|'scroll-follow'|'full', autoStart: boolean, sourceLanguage: string|null, targetLanguage: string|null, model: string|null }|null}
 */
export function normalizePerSiteConfig(item) {
  if (typeof item === 'string') {
    const norm = normalizeOrigin(item);
    if (!norm) return null;
    return {
      origin: norm,
      mode: 'inherit',
      autoStart: true,
      sourceLanguage: null,
      targetLanguage: null,
      model: null
    };
  }

  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const rawOrigin = typeof item.origin === 'string' ? item.origin : '';
    const norm = normalizeOrigin(rawOrigin);
    if (!norm) return null;

    const mode = VALID_PER_SITE_MODES.includes(item.mode) ? item.mode : 'inherit';
    const autoStart = typeof item.autoStart === 'boolean' ? item.autoStart : true;
    const sourceLanguage = (typeof item.sourceLanguage === 'string' && item.sourceLanguage.trim())
      ? item.sourceLanguage.trim()
      : null;
    const targetLanguage = (typeof item.targetLanguage === 'string' && item.targetLanguage.trim())
      ? item.targetLanguage.trim()
      : null;
    const model = (typeof item.model === 'string' && item.model.trim())
      ? item.model.trim()
      : null;

    return {
      origin: norm,
      mode,
      autoStart,
      sourceLanguage,
      targetLanguage,
      model
    };
  }

  return null;
}

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  baseURL: 'http://localhost:8080/v1',
  model: 'ag/gemini-3.1-pro-low',
  fallbacks: Object.freeze([]),
  favoriteModels: Object.freeze([]),
  favoriteModelsByBaseURL: Object.freeze({}),
  autoTranslateSites: Object.freeze([]),
  translationMode: 'scroll-follow',
  widgetVisible: true,
  sourceLanguage: 'auto',
  targetLanguage: 'vi',
  rateLimits: Object.freeze({
    windowSeconds: 60,
    tab: Object.freeze({
      maxBatches: 4,
      maxSourceCodePoints: 12000
    }),
    site: Object.freeze({
      maxBatches: 12,
      maxSourceCodePoints: 36000
    })
  })
});

/**
 * Normalizes a provider Base URL into a stable favorites-scope key.
 * Lowercases scheme/host, strips query/fragment and trailing slashes, preserves
 * path/non-default port, and normalizes default ports per URL parsing. Never
 * derived from API keys.
 *
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizeBaseURLKey(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = (u.pathname || '').replace(/\/+$/, '');
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${path}`;
  } catch {
    return null;
  }
}

/**
 * Cleans a single favorites list: unique non-empty trimmed strings, max 50.
 *
 * @param {unknown} list
 * @returns {string[]}
 */
function cleanFavoriteList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Migrates any raw settings object to the canonical SETTINGS_VERSION.
 * Invariants:
 * 1. api_key, apiKey, fallback_api_keys is NEVER stored in settings (purged if found).
 * 2. Missing fields are filled with sensible frozen defaults.
 * 3. Unknown user fields are preserved intact.
 * 4. Idempotent: migrateSettings(migrateSettings(x)) equals migrateSettings(x).
 * 5. Safe: undefined/null/empty/primitive input will not throw.
 *
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
export function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  // Clone to avoid mutating caller object
  const res = { ...raw };

  // INVARIANT: credentials must NEVER be in settings
  delete res.api_key;
  delete res.apiKey;
  delete res.fallback_api_keys;
  delete res.fallbackApiKeys;

  // Record the current schema version after normalizing older settings.
  res.version = SETTINGS_VERSION;

  // Ensure default string values if missing or empty
  if (typeof res.baseURL !== 'string' || !res.baseURL.trim()) {
    res.baseURL = DEFAULT_SETTINGS.baseURL;
  }
  if (typeof res.model !== 'string' || !res.model.trim()) {
    res.model = DEFAULT_SETTINGS.model;
  }
  if (typeof res.sourceLanguage !== 'string' || !res.sourceLanguage.trim()) {
    res.sourceLanguage = DEFAULT_SETTINGS.sourceLanguage;
  }
  if (typeof res.targetLanguage !== 'string' || !res.targetLanguage.trim()) {
    res.targetLanguage = DEFAULT_SETTINGS.targetLanguage;
  }

  // v2: translationMode ('scroll-follow' | 'full')
  if (res.translationMode !== 'scroll-follow' && res.translationMode !== 'full') {
    res.translationMode = DEFAULT_SETTINGS.translationMode;
  }

  // v2: widgetVisible (boolean)
  if (typeof res.widgetVisible !== 'boolean') {
    res.widgetVisible = DEFAULT_SETTINGS.widgetVisible;
  }

  // v3: fallbacks (0-2 items, unique non-empty id, non-empty model, optional baseURL)
  if (Array.isArray(res.fallbacks)) {
    const cleaned = [];
    const seenIds = new Set();
    let fbCounter = 1;
    for (const item of res.fallbacks) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        // Strip any credentials accidentally placed inside fallback items
        delete item.apiKey;
        delete item.key;
        delete item.api_key;

        const model = typeof item.model === 'string' ? item.model.trim() : '';
        if (!model) continue;

        let id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id || seenIds.has(id)) {
          while (seenIds.has(`fb${fbCounter}`)) {
            fbCounter++;
          }
          id = `fb${fbCounter}`;
          fbCounter++;
        }
        seenIds.add(id);

        const fbObj = { id, model };
        if (typeof item.baseURL === 'string' && item.baseURL.trim()) {
          fbObj.baseURL = item.baseURL.trim();
        }
        cleaned.push(fbObj);
      }
    }
    res.fallbacks = cleaned.slice(0, 2);
    delete res.fallbackModels;
  } else if (Array.isArray(res.fallbackModels)) {
    // Migration v2 -> v3: fallbackModels [m1, m2] -> fallbacks [{id:'fb1', model:m1}, ...]
    const cleaned = [];
    const seen = new Set();
    let fbIdx = 1;
    for (const item of res.fallbackModels) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed && trimmed !== res.model && !seen.has(trimmed)) {
          seen.add(trimmed);
          cleaned.push({
            id: `fb${fbIdx}`,
            model: trimmed
          });
          fbIdx++;
        }
      }
    }
    res.fallbacks = cleaned.slice(0, 2);
    delete res.fallbackModels;
  } else {
    res.fallbacks = [];
    delete res.fallbackModels;
  }

  // v2: favoriteModels (unique IDs, max 50)
  if (Array.isArray(res.favoriteModels)) {
    const cleaned = [];
    const seen = new Set();
    for (const item of res.favoriteModels) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          cleaned.push(trimmed);
        }
      }
    }
    res.favoriteModels = cleaned.slice(0, 50);
  } else {
    res.favoriteModels = [];
  }

  // v5: favoriteModelsByBaseURL (per provider Base URL scope).
  // Keys are normalized via normalizeBaseURLKey (scheme/host case-insensitive,
  // trailing slashes stripped; path and port preserved so distinct providers
  // never merge). Values are cleaned favorite lists (max 50 each). Legacy
  // global favoriteModels migrates into the currently configured Base URL
  // bucket exactly once (when no scoped buckets exist yet); afterwards the
  // scoped map is authoritative and the legacy list is never merged again so
  // unrelated Base URLs cannot pollute each other. Never keyed by API key.
  {
    const rawMap = (res.favoriteModelsByBaseURL && typeof res.favoriteModelsByBaseURL === 'object' && !Array.isArray(res.favoriteModelsByBaseURL))
      ? res.favoriteModelsByBaseURL
      : {};
    const map = {};
    for (const k of Object.keys(rawMap)) {
      const nk = normalizeBaseURLKey(k);
      if (!nk) continue;
      const cleaned = cleanFavoriteList(rawMap[k]);
      if (map[nk]) {
        const seen = new Set(map[nk]);
        for (const m of cleaned) {
          if (!seen.has(m) && map[nk].length < 50) {
            seen.add(m);
            map[nk].push(m);
          }
        }
      } else {
        map[nk] = cleaned;
      }
    }
    const curKey = normalizeBaseURLKey(res.baseURL);
    const legacy = cleanFavoriteList(res.favoriteModels);
    if (curKey && legacy.length > 0 && Object.keys(map).length === 0) {
      map[curKey] = [...legacy];
    }
    if (curKey && map[curKey]) {
      res.favoriteModels = [...map[curKey]];
    } else if (!curKey || Object.keys(map).length === 0) {
      res.favoriteModels = legacy;
    } else {
      // Scoped map is authoritative: a new Base URL with no bucket starts
      // empty — never fall back to another provider's legacy/global list.
      res.favoriteModels = [];
    }
    res.favoriteModelsByBaseURL = map;
  }

  // v4: autoTranslateSites (unique normalized origins, max 200, per-site config object)
  if (Array.isArray(res.autoTranslateSites)) {
    const cleaned = [];
    const seen = new Set();
    for (const item of res.autoTranslateSites) {
      const normalized = normalizePerSiteConfig(item);
      if (normalized && !seen.has(normalized.origin)) {
        seen.add(normalized.origin);
        cleaned.push(normalized);
      }
    }
    res.autoTranslateSites = cleaned.slice(0, 200);
  } else {
    res.autoTranslateSites = [];
  }

  // Ensure rateLimits structure is populated with defaults
  const rawRL = (res.rateLimits && typeof res.rateLimits === 'object' && !Array.isArray(res.rateLimits))
    ? res.rateLimits
    : {};

  res.rateLimits = {
    windowSeconds: typeof rawRL.windowSeconds === 'number' && rawRL.windowSeconds > 0
      ? rawRL.windowSeconds
      : DEFAULT_SETTINGS.rateLimits.windowSeconds,
    tab: {
      maxBatches: typeof rawRL.tab?.maxBatches === 'number' && rawRL.tab.maxBatches > 0
        ? rawRL.tab.maxBatches
        : DEFAULT_SETTINGS.rateLimits.tab.maxBatches,
      maxSourceCodePoints: typeof rawRL.tab?.maxSourceCodePoints === 'number' && rawRL.tab.maxSourceCodePoints > 0
        ? rawRL.tab.maxSourceCodePoints
        : DEFAULT_SETTINGS.rateLimits.tab.maxSourceCodePoints
    },
    site: {
      maxBatches: typeof rawRL.site?.maxBatches === 'number' && rawRL.site.maxBatches > 0
        ? rawRL.site.maxBatches
        : DEFAULT_SETTINGS.rateLimits.site.maxBatches,
      maxSourceCodePoints: typeof rawRL.site?.maxSourceCodePoints === 'number' && rawRL.site.maxSourceCodePoints > 0
        ? rawRL.site.maxSourceCodePoints
        : DEFAULT_SETTINGS.rateLimits.site.maxSourceCodePoints
    }
  };

  return res;
}

/**
 * Validates a settings object against expected schema types and safety rules.
 *
 * @param {unknown} settings
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { valid: false, errors: ['Settings must be a non-null object'] };
  }

  const errors = [];

  // Check version if provided
  if (settings.version !== undefined && (typeof settings.version !== 'number' || settings.version < 1)) {
    errors.push('version must be a positive number');
  }

  // Check baseURL
  if (typeof settings.baseURL !== 'string' || !/^https?:\/\/.+/i.test(settings.baseURL.trim())) {
    errors.push('baseURL must be a valid HTTP(S) URL');
  }

  // Check model
  if (typeof settings.model !== 'string' || !settings.model.trim()) {
    errors.push('model must be a non-empty string');
  }

  // Check sourceLanguage & targetLanguage
  if (typeof settings.sourceLanguage !== 'string' || !settings.sourceLanguage.trim()) {
    errors.push('sourceLanguage must be a non-empty string');
  }
  if (typeof settings.targetLanguage !== 'string' || !settings.targetLanguage.trim()) {
    errors.push('targetLanguage must be a non-empty string');
  }

  // INVARIANT: credentials must never be passed in settings
  if ('api_key' in settings || 'apiKey' in settings || 'fallback_api_keys' in settings || 'fallbackApiKeys' in settings) {
    errors.push('api_key and fallback_api_keys must not be stored inside settings');
  }

  // Check translationMode
  if (settings.translationMode !== undefined) {
    if (settings.translationMode !== 'scroll-follow' && settings.translationMode !== 'full') {
      errors.push("translationMode must be 'scroll-follow' or 'full'");
    }
  }

  // Check widgetVisible
  if (settings.widgetVisible !== undefined && typeof settings.widgetVisible !== 'boolean') {
    errors.push('widgetVisible must be a boolean');
  }

  // Check fallbacks
  if (settings.fallbacks !== undefined) {
    if (!Array.isArray(settings.fallbacks)) {
      errors.push('fallbacks must be an array');
    } else if (settings.fallbacks.length > 2) {
      errors.push('fallbacks cannot have more than 2 items');
    } else {
      const seenIds = new Set();
      for (let i = 0; i < settings.fallbacks.length; i++) {
        const fb = settings.fallbacks[i];
        if (!fb || typeof fb !== 'object' || Array.isArray(fb)) {
          errors.push(`fallbacks[${i}] must be an object`);
          continue;
        }
        if (typeof fb.id !== 'string' || !fb.id.trim()) {
          errors.push(`fallbacks[${i}].id must be a non-empty string`);
        } else if (seenIds.has(fb.id.trim())) {
          errors.push(`fallbacks[${i}].id must be unique`);
        } else {
          seenIds.add(fb.id.trim());
        }
        if (typeof fb.model !== 'string' || !fb.model.trim()) {
          errors.push(`fallbacks[${i}].model must be a non-empty string`);
        }
        if (fb.baseURL !== undefined && fb.baseURL !== null && fb.baseURL !== '') {
          if (typeof fb.baseURL !== 'string' || !/^https?:\/\/.+/i.test(fb.baseURL.trim())) {
            errors.push(`fallbacks[${i}].baseURL must be a valid HTTP(S) URL`);
          }
        }
        if ('api_key' in fb || 'apiKey' in fb || 'key' in fb) {
          errors.push(`fallbacks[${i}] must not contain api key`);
        }
      }
    }
  }

  // Disallow obsolete fallbackModels in v3
  if (settings.fallbackModels !== undefined) {
    errors.push('fallbackModels has been replaced by fallbacks in settings schema v3');
  }

  // Check favoriteModels
  if (settings.favoriteModels !== undefined) {
    if (!Array.isArray(settings.favoriteModels)) {
      errors.push('favoriteModels must be an array of strings');
    } else if (settings.favoriteModels.length > 50) {
      errors.push('favoriteModels cannot have more than 50 models');
    } else {
      const seen = new Set();
      for (const fav of settings.favoriteModels) {
        if (typeof fav !== 'string' || !fav.trim()) {
          errors.push('favoriteModels elements must be non-empty strings');
          break;
        }
        if (seen.has(fav)) {
          errors.push('favoriteModels cannot contain duplicate models');
        }
        seen.add(fav);
      }
    }
  }

  // Check favoriteModelsByBaseURL (v5: per provider Base URL scope)
  if (settings.favoriteModelsByBaseURL !== undefined) {
    const map = settings.favoriteModelsByBaseURL;
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      errors.push('favoriteModelsByBaseURL must be an object');
    } else {
      for (const k of Object.keys(map)) {
        if (!k || typeof k !== 'string') {
          errors.push('favoriteModelsByBaseURL keys must be non-empty strings');
          break;
        }
        const list = map[k];
        if (!Array.isArray(list)) {
          errors.push('favoriteModelsByBaseURL values must be arrays of strings');
          break;
        }
        if (list.length > 50) {
          errors.push('favoriteModelsByBaseURL lists cannot have more than 50 models');
          break;
        }
        const seen = new Set();
        let bad = false;
        for (const fav of list) {
          if (typeof fav !== 'string' || !fav.trim()) {
            errors.push('favoriteModelsByBaseURL elements must be non-empty strings');
            bad = true;
            break;
          }
          if (seen.has(fav)) {
            errors.push('favoriteModelsByBaseURL cannot contain duplicate models');
            bad = true;
            break;
          }
          seen.add(fav);
        }
        if (bad) break;
      }
    }
  }

  // Check autoTranslateSites
  if (settings.autoTranslateSites !== undefined) {
    if (!Array.isArray(settings.autoTranslateSites)) {
      errors.push('autoTranslateSites must be an array');
    } else if (settings.autoTranslateSites.length > 200) {
      errors.push('autoTranslateSites cannot have more than 200 sites');
    } else {
      const seen = new Set();
      for (let i = 0; i < settings.autoTranslateSites.length; i++) {
        const site = settings.autoTranslateSites[i];
        if (typeof site === 'string') {
          if (!site.trim()) {
            errors.push('autoTranslateSites elements must be non-empty strings or objects');
            break;
          }
          const norm = normalizeOrigin(site);
          if (!norm || norm !== site.trim()) {
            errors.push(`autoTranslateSites element "${site}" must be a valid normalized HTTP(S) origin`);
            break;
          }
          if (seen.has(norm)) {
            errors.push('autoTranslateSites cannot contain duplicate origins');
            break;
          }
          seen.add(norm);
        } else if (site && typeof site === 'object' && !Array.isArray(site)) {
          if (typeof site.origin !== 'string' || !site.origin.trim()) {
            errors.push(`autoTranslateSites[${i}].origin must be a non-empty string`);
            break;
          }
          const norm = normalizeOrigin(site.origin);
          if (!norm || norm !== site.origin.trim()) {
            errors.push(`autoTranslateSites element "${site.origin}" must be a valid normalized HTTP(S) origin`);
            break;
          }
          if (seen.has(norm)) {
            errors.push('autoTranslateSites cannot contain duplicate origins');
            break;
          }
          seen.add(norm);

          if (site.mode !== undefined && !VALID_PER_SITE_MODES.includes(site.mode)) {
            errors.push(`autoTranslateSites[${i}].mode must be 'inherit', 'scroll-follow', or 'full'`);
            break;
          }
          if (site.autoStart !== undefined && typeof site.autoStart !== 'boolean') {
            errors.push(`autoTranslateSites[${i}].autoStart must be a boolean`);
            break;
          }
          if (site.sourceLanguage !== undefined && site.sourceLanguage !== null && typeof site.sourceLanguage !== 'string') {
            errors.push(`autoTranslateSites[${i}].sourceLanguage must be a string or null`);
            break;
          }
          if (site.targetLanguage !== undefined && site.targetLanguage !== null && typeof site.targetLanguage !== 'string') {
            errors.push(`autoTranslateSites[${i}].targetLanguage must be a string or null`);
            break;
          }
          if (site.model !== undefined && site.model !== null && (typeof site.model !== 'string' || !site.model.trim())) {
            errors.push(`autoTranslateSites[${i}].model must be a non-empty string or null`);
            break;
          }
        } else {
          errors.push(`autoTranslateSites elements must be non-empty strings or objects`);
          break;
        }
      }
    }
  }

  // Validate rateLimits if present
  if (settings.rateLimits !== undefined) {
    if (typeof settings.rateLimits !== 'object' || settings.rateLimits === null || Array.isArray(settings.rateLimits)) {
      errors.push('rateLimits must be an object');
    } else {
      const rl = settings.rateLimits;
      if (rl.windowSeconds !== undefined && (typeof rl.windowSeconds !== 'number' || rl.windowSeconds <= 0)) {
        errors.push('rateLimits.windowSeconds must be a positive number');
      }
      if (rl.tab !== undefined) {
        if (typeof rl.tab !== 'object' || rl.tab === null) {
          errors.push('rateLimits.tab must be an object');
        } else {
          if (rl.tab.maxBatches !== undefined && (typeof rl.tab.maxBatches !== 'number' || rl.tab.maxBatches <= 0)) {
            errors.push('rateLimits.tab.maxBatches must be a positive number');
          }
          if (rl.tab.maxSourceCodePoints !== undefined && (typeof rl.tab.maxSourceCodePoints !== 'number' || rl.tab.maxSourceCodePoints <= 0)) {
            errors.push('rateLimits.tab.maxSourceCodePoints must be a positive number');
          }
        }
      }
      if (rl.site !== undefined) {
        if (typeof rl.site !== 'object' || rl.site === null) {
          errors.push('rateLimits.site must be an object');
        } else {
          if (rl.site.maxBatches !== undefined && (typeof rl.site.maxBatches !== 'number' || rl.site.maxBatches <= 0)) {
            errors.push('rateLimits.site.maxBatches must be a positive number');
          }
          if (rl.site.maxSourceCodePoints !== undefined && (typeof rl.site.maxSourceCodePoints !== 'number' || rl.site.maxSourceCodePoints <= 0)) {
            errors.push('rateLimits.site.maxSourceCodePoints must be a positive number');
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined
  };
}
