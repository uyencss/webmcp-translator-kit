// WebMCP Translator Kit — Popup Module: Host Permission & Privacy Manager
// Manages Base URL origin checks, dynamic host permission requests, privacy notes, and auto-start warning banner.

import { isSecureOrLoopbackBaseURL } from '../../settings.mjs';
import { computePrivacyNoteState, evaluateAutoConsentWarningBranch } from './consent-banner.mjs';

export async function getBaseOrigin(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

export async function ensureBaseUrlPermission(rawUrl, { refreshBasePermState }) {
  if (!rawUrl) return { ok: false, reason: 'invalid' };
  if (!isSecureOrLoopbackBaseURL(rawUrl)) {
    return { ok: false, reason: 'insecure' };
  }
  const origin = await getBaseOrigin(rawUrl);
  if (!origin) return { ok: false, reason: 'invalid' };
  if (!chrome.permissions || typeof chrome.permissions.contains !== 'function') {
    return { ok: true };
  }
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
    if (!granted && typeof chrome.permissions.request === 'function') {
      granted = await chrome.permissions.request({ origins: [origin + '/*'] });
    }
  } catch {
    granted = false;
  }
  if (typeof refreshBasePermState === 'function') {
    await refreshBasePermState();
  }
  return granted ? { ok: true } : { ok: false, reason: 'denied' };
}

export async function refreshBasePermState({
  btnBasePerm,
  rawUrl,
  currentUiLocale,
  t
}) {
  if (!btnBasePerm) return;
  const origin = await getBaseOrigin(rawUrl);
  let granted = false;
  if (origin && typeof chrome !== 'undefined' && chrome.permissions && typeof chrome.permissions.contains === 'function') {
    try {
      granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
    } catch {}
  }
  btnBasePerm.classList.toggle('granted', granted);
  btnBasePerm.title = granted
    ? t(currentUiLocale, 'perm_granted_origin', { origin })
    : t(currentUiLocale, 'perm_request_origin', { origin: origin || t(currentUiLocale, 'err_url_invalid') });
  btnBasePerm.setAttribute('aria-label', btnBasePerm.title);
}

export function updatePrivacyNote({
  privacyNote,
  urlToCheck,
  baseURL,
  rawUrl,
  savedBaseUrl,
  currentUiLocale,
  t
}) {
  if (!privacyNote) return;
  const targetUrl = urlToCheck || (baseURL ? String(baseURL).trim() : '') || (rawUrl ? String(rawUrl).trim() : '') || savedBaseUrl || 'http://localhost:8080/v1';
  const state = computePrivacyNoteState(targetUrl);
  const msg = t(currentUiLocale, state.noteKey);
  privacyNote.title = msg;
  privacyNote.setAttribute('aria-label', msg);
  const svgIcon = privacyNote.querySelector('svg');
  if (svgIcon) {
    svgIcon.classList.remove('text-warning', 'text-danger');
    svgIcon.classList.toggle('text-muted', state.isMuted);
    svgIcon.classList.toggle('text-warning', state.isWarning);
  }
}

export function updateAutoConsentWarningBanner({
  bannerAutoConsentWarning,
  bannerAutoWarningText,
  btnBannerEnableSite,
  btnBannerEnableSiteText,
  currentConsent,
  autoTranslateSites,
  currentUiLocale,
  t
}) {
  if (!bannerAutoConsentWarning) return;
  const branchInfo = evaluateAutoConsentWarningBranch(currentConsent, autoTranslateSites);
  if (!branchInfo.show) {
    bannerAutoConsentWarning.classList.add('hidden');
    return;
  }

  bannerAutoConsentWarning.classList.remove('hidden');
  if (branchInfo.branch === 'tab_override_off') {
    if (bannerAutoWarningText) {
      bannerAutoWarningText.textContent = t(currentUiLocale, 'banner_auto_tab_override_off');
    }
    if (btnBannerEnableSite) {
      btnBannerEnableSite.classList.add('hidden');
    }
  } else {
    if (bannerAutoWarningText) {
      bannerAutoWarningText.textContent = t(currentUiLocale, 'banner_auto_site_off');
    }
    if (btnBannerEnableSite) {
      btnBannerEnableSite.classList.remove('hidden');
      if (btnBannerEnableSiteText) {
        btnBannerEnableSiteText.textContent = t(currentUiLocale, 'btn_enable_site_format', { origin: branchInfo.origin });
      }
    }
  }
}
