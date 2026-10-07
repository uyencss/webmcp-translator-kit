// WebMCP Translator Kit — Background Module: Security & Senders
// Handles privileged sender verification, top-frame widget sender checks, and typed errors

import { normalizeOrigin } from '../../consent.mjs';

export function createTypedError(code, message, retryable, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.retryable = Boolean(retryable);
  err.details = details;
  return {
    error: {
      code,
      message,
      retryable: Boolean(retryable),
      details
    }
  };
}

export function isPrivilegedSender(sender) {
  if (!sender) return false;
  const extPrefix = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
    ? `chrome-extension://${chrome.runtime.id}`
    : 'chrome-extension://';
  if (typeof sender.url === 'string' && sender.url.startsWith(extPrefix)) {
    return true;
  }
  if (sender.tab) return false;
  if (sender.id && typeof chrome !== 'undefined' && chrome.runtime && sender.id === chrome.runtime.id && !sender.tab) {
    return true;
  }
  return false;
}

export function verifyWidgetSender(sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== 'number' || sender.frameId !== 0) {
    return {
      ok: false,
      error: createTypedError('PERMISSION_REQUIRED', 'Widget actions require top frame tab sender', false, {
        permissionType: 'host'
      })
    };
  }
  const senderRawUrl = sender.url || (sender.tab && sender.tab.url) || sender.origin;
  const origin = normalizeOrigin(senderRawUrl);
  if (!origin) {
    return {
      ok: false,
      error: createTypedError('SITE_NOT_ALLOWED', 'Invalid HTTP(S) origin for widget', false, {
        origin: senderRawUrl || ''
      })
    };
  }
  return {
    ok: true,
    tabId: sender.tab.id,
    origin,
    url: senderRawUrl
  };
}
