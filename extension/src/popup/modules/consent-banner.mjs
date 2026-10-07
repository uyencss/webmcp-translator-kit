// WebMCP Translator Kit — Popup Module: Consent & Privacy Banners
// Manages privacy indicators for loopback/Tailscale/HTTPS and auto-start warning branches

import { isLoopbackHost, isTailscaleHost, isSecureOrLoopbackBaseURL } from '../../consent.mjs';

export function computePrivacyNoteState(urlToCheck) {
  const isSecure = isSecureOrLoopbackBaseURL(urlToCheck);
  let isLoopbackHttp = false;
  let isTailscaleHttp = false;

  try {
    const parsed = new URL(urlToCheck);
    if (parsed.protocol === 'http:') {
      if (isLoopbackHost(parsed.hostname)) {
        isLoopbackHttp = true;
      } else if (isTailscaleHost(parsed.hostname)) {
        isTailscaleHttp = true;
      }
    }
  } catch {}

  let noteKey = 'privacy_note_insecure';
  let isWarning = true;
  let isMuted = false;

  if (isSecure) {
    if (isLoopbackHttp) {
      noteKey = 'privacy_note_loopback';
      isWarning = true;
      isMuted = false;
    } else if (isTailscaleHttp) {
      noteKey = 'privacy_note_tailscale';
      isWarning = true;
      isMuted = false;
    } else {
      noteKey = 'privacy_note_secure';
      isWarning = false;
      isMuted = true;
    }
  }

  return {
    isSecure,
    isLoopbackHttp,
    isTailscaleHttp,
    noteKey,
    isWarning,
    isMuted
  };
}

export function evaluateAutoConsentWarningBranch(currentConsent, autoTranslateSites = []) {
  if (!currentConsent || currentConsent.authoritative !== true) {
    return { show: false };
  }
  const origin = currentConsent.siteOrigin;
  if (!origin) {
    return { show: false };
  }

  const matchingSite = autoTranslateSites.find((s) => (s && (s.origin || s) === origin));
  const hasAutoEntry = Boolean(matchingSite && (matchingSite.autoStart !== false));
  const effective = currentConsent.effective || 'off';

  if (hasAutoEntry && effective === 'off') {
    if (currentConsent.tabOverride === 'off') {
      return {
        show: true,
        branch: 'tab_override_off',
        origin
      };
    }
    return {
      show: true,
      branch: 'site_off',
      origin
    };
  }

  return { show: false };
}
