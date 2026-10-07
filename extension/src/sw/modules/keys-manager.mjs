// WebMCP Translator Kit — Keys & Credential Management Module
// Handles secure storage, retrieval, lifecycle invalidation, and queue abortion
// for primary and fallback API credentials.

import { createTypedError, isPrivilegedSender } from './security.mjs';

/**
 * Aborts active batch translations and queued requests across all tabs
 * when credentials change or are deleted, clearing L1 and L2 caches.
 */
export async function abortActiveWorkOnCredentialChange({
  activeBatchControllers,
  tabQueues,
  translationCache,
  clearL2Cache,
  reason = 'Credential changed'
}) {
  if (translationCache && typeof translationCache.clear === 'function') {
    translationCache.clear();
  }
  if (activeBatchControllers) {
    for (const [reqId, active] of activeBatchControllers.entries()) {
      try { active.controller.abort('credential_changed'); } catch {}
    }
    activeBatchControllers.clear();
  }
  if (tabQueues) {
    for (const [tabId, queue] of tabQueues.entries()) {
      for (const entry of queue) {
        if (entry.timer) clearTimeout(entry.timer);
        const actionNoun = reason.toLowerCase().includes('remov') ? 'removal' : 'change';
        entry.resolve(createTypedError(
          'ABORTED',
          `Translation request aborted due to credential ${actionNoun}`,
          false,
          { reason }
        ));
      }
    }
    tabQueues.clear();
  }
  if (typeof clearL2Cache === 'function') {
    await clearL2Cache();
  }
}

export async function handleSetKeyAction({
  message,
  sender,
  ensureStorageAccess,
  abortContext,
  bumpConfigRevision,
  notifyAllWidgetStateChanged
}) {
  if (!isPrivilegedSender(sender)) {
    return createTypedError('PERMISSION_REQUIRED', 'SET_KEY is only permitted from extension UI', false, {
      permissionType: 'host'
    });
  }
  await ensureStorageAccess();
  const nextRev = bumpConfigRevision();
  await abortActiveWorkOnCredentialChange({
    ...abortContext,
    reason: 'Credential changed'
  });
  // Invalidate model list cache on key change (best-effort)
  try {
    await chrome.storage.local.remove(['modelListCache']);
  } catch {}
  if (typeof message.key === 'string') {
    await chrome.storage.local.set({ api_key: message.key });
  }
  if (typeof notifyAllWidgetStateChanged === 'function') {
    notifyAllWidgetStateChanged();
  }
  return { ok: true, configRevision: nextRev };
}

export async function handleSetFallbackKeyAction({
  message,
  sender,
  ensureStorageAccess,
  getStoredSettings,
  abortContext,
  bumpConfigRevision,
  notifyAllWidgetStateChanged
}) {
  if (!isPrivilegedSender(sender)) {
    return createTypedError('PERMISSION_REQUIRED', 'SET_FALLBACK_KEY is only permitted from extension UI', false, {
      permissionType: 'host'
    });
  }
  const fbId = typeof message.id === 'string' ? message.id.trim() : '';
  if (!fbId) {
    return createTypedError('INVALID_SCHEMA', 'Fallback id is required', false, { id: message.id });
  }
  const key = typeof message.key === 'string' ? message.key.trim() : '';
  if (!key) {
    return createTypedError('INVALID_SCHEMA', 'Fallback key must be a non-empty string', false);
  }

  await ensureStorageAccess();
  const settings = await getStoredSettings();
  const exists = Array.isArray(settings.fallbacks) && settings.fallbacks.some((fb) => fb && fb.id === fbId);
  if (!exists) {
    return createTypedError('INVALID_SCHEMA', `Fallback id "${fbId}" does not exist in settings`, false, { id: fbId });
  }

  const nextRev = bumpConfigRevision();
  await abortActiveWorkOnCredentialChange({
    ...abortContext,
    reason: 'Credential changed'
  });

  const res = await chrome.storage.local.get(['fallback_api_keys']);
  const fbKeys = res.fallback_api_keys || {};
  fbKeys[fbId] = key;
  await chrome.storage.local.set({ fallback_api_keys: fbKeys });

  if (typeof notifyAllWidgetStateChanged === 'function') {
    notifyAllWidgetStateChanged();
  }
  return { ok: true, configRevision: nextRev };
}

export async function handleDeleteFallbackKeyAction({
  message,
  sender,
  ensureStorageAccess,
  abortContext,
  bumpConfigRevision,
  notifyAllWidgetStateChanged
}) {
  if (!isPrivilegedSender(sender)) {
    return createTypedError('PERMISSION_REQUIRED', 'DELETE_FALLBACK_KEY is only permitted from extension UI', false, {
      permissionType: 'host'
    });
  }
  const fbId = typeof message.id === 'string' ? message.id.trim() : '';
  if (!fbId) {
    return createTypedError('INVALID_SCHEMA', 'Fallback id is required', false, { id: message.id });
  }

  await ensureStorageAccess();
  const nextRev = bumpConfigRevision();
  await abortActiveWorkOnCredentialChange({
    ...abortContext,
    reason: 'Credential removed'
  });

  const res = await chrome.storage.local.get(['fallback_api_keys']);
  const fbKeys = res.fallback_api_keys || {};
  if (fbId in fbKeys) {
    delete fbKeys[fbId];
    await chrome.storage.local.set({ fallback_api_keys: fbKeys });
  }

  if (typeof notifyAllWidgetStateChanged === 'function') {
    notifyAllWidgetStateChanged();
  }
  return { ok: true, configRevision: nextRev };
}

export async function handleDeleteKeyAction({
  sender,
  ensureStorageAccess,
  abortContext,
  bumpConfigRevision,
  notifyAllWidgetStateChanged
}) {
  if (!isPrivilegedSender(sender)) {
    return createTypedError('PERMISSION_REQUIRED', 'DELETE_KEY is only permitted from extension UI', false, {
      permissionType: 'host'
    });
  }
  await ensureStorageAccess();
  const nextRev = bumpConfigRevision();
  await abortActiveWorkOnCredentialChange({
    ...abortContext,
    reason: 'Credential removed'
  });

  // Invalidate model list cache on key removal, and remove all fallback keys
  await chrome.storage.local.remove(['modelListCache', 'api_key', 'fallback_api_keys']);
  if (typeof notifyAllWidgetStateChanged === 'function') {
    notifyAllWidgetStateChanged();
  }
  return { ok: true, configRevision: nextRev };
}

export async function handleHasKeyAction({ sender, getStoredApiKey }) {
  if (!isPrivilegedSender(sender)) {
    return createTypedError('PERMISSION_REQUIRED', 'HAS_KEY is only permitted from extension UI', false, {
      permissionType: 'host'
    });
  }
  const key = await getStoredApiKey();
  return { hasKey: Boolean(key) };
}
