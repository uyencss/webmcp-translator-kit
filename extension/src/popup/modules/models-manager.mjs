// WebMCP Translator Kit — Popup Module: Models & Favorites Manager
// Handles BaseURL-scoped favorites lookup, model lists, and favorite limits (50-cap)

import { normalizeBaseURLKey } from '../../settings.mjs';

export const MAX_FAVORITES_PER_SCOPE = 50;

export function resolveFavKey(baseURL) {
  return normalizeBaseURLKey(typeof baseURL === 'string' ? baseURL : '');
}

export function getScopedFavorites(favoriteModelsByBaseURL, key) {
  const list = key ? favoriteModelsByBaseURL[key] : null;
  return Array.isArray(list) ? [...list] : [];
}

export function filterAvailableModelsToAdd({
  scopeKey,
  favoriteModelsByBaseURL = {},
  recommendedModels = [],
  discoveredModels = []
} = {}) {
  const currentFavs = new Set(getScopedFavorites(favoriteModelsByBaseURL, scopeKey));
  const seen = new Set();
  const allModels = [];

  for (const mId of recommendedModels) {
    if (mId && !seen.has(mId)) {
      seen.add(mId);
      allModels.push(mId);
    }
  }

  for (const m of discoveredModels) {
    const mId = typeof m === 'string' ? m : m?.id;
    if (mId && !seen.has(mId)) {
      seen.add(mId);
      allModels.push(mId);
    }
  }

  return allModels.filter((mId) => !currentFavs.has(mId));
}

export function isFavoriteCapReached(favoriteModelsByBaseURL, key) {
  return getScopedFavorites(favoriteModelsByBaseURL, key).length >= MAX_FAVORITES_PER_SCOPE;
}
