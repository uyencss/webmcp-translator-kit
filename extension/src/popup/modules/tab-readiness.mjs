// WebMCP Translator Kit — Popup Module: Tab Readiness & Active Tab Resolution
// Evaluates readiness states for translation actions and resolves active HTTP(S) tabs.

import { isSecureOrLoopbackBaseURL } from '../../consent.mjs';
import { isDataConsentAccepted } from '../../settings.mjs';

export async function resolveActiveTab({
  getActiveTab,
  setActiveTab,
  btnTranslate,
  btnRestore,
  updateStatus,
  toggleSiteConsent,
  btnOverrideInherit,
  btnOverrideOn,
  btnOverrideOff,
  siteOriginBadge,
  currentUiLocale,
  t
}) {
  try {
    if (typeof window !== 'undefined' && window.__testActiveTab) {
      if (typeof setActiveTab === 'function') setActiveTab(window.__testActiveTab);
      return true;
    }
    if (typeof chrome === 'undefined' || !chrome?.tabs?.query) {
      return false;
    }
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
      const allHttpTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      const activeHttp = allHttpTabs.find((t) => t.active) || allHttpTabs[0];
      if (activeHttp) {
        tab = activeHttp;
      }
    }
    if (typeof setActiveTab === 'function') setActiveTab(tab);
    if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
      if (btnTranslate) btnTranslate.disabled = true;
      if (btnRestore) btnRestore.disabled = true;
      if (typeof updateStatus === 'function') updateStatus('unsupported', t(currentUiLocale, 'status_unsupported_detail'));
      if (toggleSiteConsent) toggleSiteConsent.disabled = true;
      if (btnOverrideInherit) btnOverrideInherit.disabled = true;
      if (btnOverrideOn) btnOverrideOn.disabled = true;
      if (btnOverrideOff) btnOverrideOff.disabled = true;
      if (siteOriginBadge) { siteOriginBadge.textContent = '--'; siteOriginBadge.classList.add('unsupported'); }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function evaluateActionReadinessHelper(restorableCount = 0, {
  activeTab,
  hasStoredKey,
  savedSettings,
  inputBaseUrl,
  selectModel,
  btnTranslate,
  btnRestore,
  statusText,
  currentUiLocale,
  t,
  setTranslateBusy,
  updateStatus
}) {
  if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
    if (btnTranslate) btnTranslate.disabled = true;
    if (btnRestore) btnRestore.disabled = true;
    if (typeof setTranslateBusy === 'function') setTranslateBusy(false);
    return;
  }

  if (!hasStoredKey) {
    if (btnTranslate) {
      btnTranslate.disabled = true;
      btnTranslate.title = t(currentUiLocale, 'btn_translate_need_key');
    }
    if (typeof setTranslateBusy === 'function') setTranslateBusy(false);
    if (typeof updateStatus === 'function') updateStatus('unconfigured', t(currentUiLocale, 'status_no_key_detail'));
    if (btnRestore) btnRestore.disabled = restorableCount === 0;
    return;
  }

  if (!isDataConsentAccepted(savedSettings)) {
    if (btnTranslate) {
      btnTranslate.disabled = false;
      btnTranslate.title = t(currentUiLocale, 'err_data_consent_required');
    }
    if (typeof setTranslateBusy === 'function') setTranslateBusy(false);
    if (typeof updateStatus === 'function') updateStatus('unconfigured', t(currentUiLocale, 'err_data_consent_required'));
    if (btnRestore) btnRestore.disabled = restorableCount === 0;
    return;
  }

  const curBaseUrl = (inputBaseUrl ? inputBaseUrl.value.trim() : '') || savedSettings?.baseURL || '';
  if (curBaseUrl && !isSecureOrLoopbackBaseURL(curBaseUrl)) {
    if (btnTranslate) {
      btnTranslate.disabled = false;
      btnTranslate.title = t(currentUiLocale, 'privacy_note_insecure');
    }
    if (typeof setTranslateBusy === 'function') setTranslateBusy(false);
    if (typeof updateStatus === 'function') updateStatus('error', t(currentUiLocale, 'privacy_note_insecure'));
    if (btnRestore) btnRestore.disabled = restorableCount === 0;
    return;
  }

  const curModel = selectModel?.value ? selectModel.value.trim() : '';
  if (!curModel || curModel === '' || curModel.includes(t(currentUiLocale, 'status_error')) || curModel.toLowerCase().includes('error')) {
    if (btnTranslate) {
      btnTranslate.disabled = true;
      btnTranslate.title = t(currentUiLocale, 'btn_translate_invalid_model');
    }
    if (typeof setTranslateBusy === 'function') setTranslateBusy(false);
    if (typeof updateStatus === 'function') updateStatus('error', t(currentUiLocale, 'err_select_valid_model'));
    if (btnRestore) btnRestore.disabled = restorableCount === 0;
    return;
  }

  if (btnTranslate) {
    btnTranslate.disabled = false;
    btnTranslate.title = t(currentUiLocale, 'btn_translate_title');
    if (typeof setTranslateBusy === 'function') setTranslateBusy(false);
  }
  if (btnRestore) btnRestore.disabled = restorableCount === 0;
  if (statusText && (statusText.textContent === t(currentUiLocale, 'status_no_key') || statusText.textContent === t(currentUiLocale, 'status_loading'))) {
    if (typeof updateStatus === 'function') updateStatus('ready', t(currentUiLocale, 'status_ready_detail'));
  }
}
