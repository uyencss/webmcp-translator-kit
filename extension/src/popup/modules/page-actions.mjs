// WebMCP Translator Kit — Popup Module: Page Actions
// Manages manual page translation triggers, prerequisites check, injection, and page restoration.

import { normalizeOrigin } from '../../consent.mjs';
import { isDataConsentAccepted } from '../../settings.mjs';

export async function handleTranslatePage({
  activeTab,
  settingsLoaded,
  savedSettings,
  currentConsent,
  autoTranslateSites,
  currentMode,
  selectModel,
  selectSrcLang,
  selectTgtLang,
  btnTranslate,
  btnRestore,
  configMessageConnect,
  DEFAULT_MODEL,
  currentUiLocale,
  t,
  openModal,
  updateStatus,
  evaluateActionReadiness,
  setTranslateBusy,
  startPolling,
  stopPolling,
  flushAutosave,
  ensureBaseUrlPermission,
  enableSiteForOrigin,
  loadConsent,
  formatDetail,
  getSettingsNotLoadedMsg
}) {
  if (!activeTab || !activeTab.id) return;
  if (!settingsLoaded) {
    updateStatus('error', '[ERROR] ' + (typeof getSettingsNotLoadedMsg === 'function' ? getSettingsNotLoadedMsg() : ''));
    if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
    return;
  }

  if (!isDataConsentAccepted(savedSettings)) {
    if (typeof openModal === 'function') openModal('consent');
    updateStatus('error', t(currentUiLocale, 'err_data_consent_required'));
    if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
    return;
  }

  if (btnTranslate) btnTranslate.disabled = true;
  if (typeof setTranslateBusy === 'function') setTranslateBusy(true);
  updateStatus('translating', t(currentUiLocale, 'status_translating_prep'));
  if (typeof startPolling === 'function') startPolling();

  try {
    if (typeof flushAutosave === 'function') await flushAutosave();

    const basePerm = typeof ensureBaseUrlPermission === 'function' ? await ensureBaseUrlPermission() : { ok: true };
    if (!basePerm.ok) {
      if (typeof stopPolling === 'function') stopPolling();
      if (basePerm.reason === 'insecure') {
        updateStatus('error', t(currentUiLocale, 'privacy_note_insecure'));
        if (configMessageConnect) {
          configMessageConnect.textContent = t(currentUiLocale, 'privacy_note_insecure');
          configMessageConnect.className = 'config-message text-danger';
        }
      } else {
        updateStatus('error', t(currentUiLocale, 'err_perm_required_base'));
        if (configMessageConnect) {
          configMessageConnect.textContent = basePerm.reason === 'invalid'
            ? t(currentUiLocale, 'err_base_url_invalid')
            : t(currentUiLocale, 'err_base_url_perm_needed');
          configMessageConnect.className = 'config-message text-danger';
        }
      }
      if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
      return;
    }

    const pageOrigin = activeTab?.url ? normalizeOrigin(activeTab.url) : null;
    if (pageOrigin && !currentConsent.siteEnabled) {
      updateStatus('translating', t(currentUiLocale, 'status_enabling_site'));
      const enRes = typeof enableSiteForOrigin === 'function' ? await enableSiteForOrigin(pageOrigin) : { ok: false };
      if (!enRes.ok) {
        if (typeof stopPolling === 'function') stopPolling();
        updateStatus('error', enRes.reason === 'permission'
          ? t(currentUiLocale, 'err_perm_required_site')
          : t(currentUiLocale, 'err_enable_site_failed_short'));
        if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
        return;
      }
      currentConsent.siteEnabled = true;
      if (typeof loadConsent === 'function') await loadConsent();
    }

    const ensureResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'ENSURE_CONTENT',
        tabId: activeTab.id
      }, resolve);
    });

    if (ensureResp && ensureResp.error) {
      if (typeof stopPolling === 'function') stopPolling();
      updateStatus('error', typeof formatDetail === 'function' ? formatDetail('error', { error: ensureResp.error }) : ensureResp.error.message);
      if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
      return;
    }

    const curOrigin = activeTab?.url ? normalizeOrigin(activeTab.url) : null;
    const matchingSite = curOrigin ? (autoTranslateSites || []).find((s) => (s.origin || s) === curOrigin) : null;
    const effectiveSiteMode = (matchingSite && matchingSite.mode && matchingSite.mode !== 'inherit')
      ? matchingSite.mode
      : (savedSettings.translationMode || currentMode || 'scroll-follow');
    const effectiveSiteModel = (matchingSite && matchingSite.model)
      ? matchingSite.model
      : (savedSettings.model || selectModel?.value || DEFAULT_MODEL);

    const currentSettings = {
      baseURL: savedSettings.baseURL || 'http://localhost:8080/v1',
      model: effectiveSiteModel,
      sourceLanguage: savedSettings.sourceLanguage || selectSrcLang?.value || 'auto',
      targetLanguage: savedSettings.targetLanguage || selectTgtLang?.value || 'vi',
      translationMode: effectiveSiteMode
    };

    chrome.tabs.sendMessage(
      activeTab.id,
      { action: 'CONTENT_START_TRANSLATION', settings: currentSettings, mode: effectiveSiteMode },
      (resp) => {
        if (typeof stopPolling === 'function') stopPolling();
        if (chrome.runtime.lastError) {
          updateStatus('error', chrome.runtime.lastError.message || t(currentUiLocale, 'err_cannot_connect_content'));
          if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
          return;
        }
        if (resp && resp.error) {
          const errObj = typeof resp.error === 'object' ? resp.error : { code: 'TRANSLATION_ERROR', message: String(resp.error) };
          try {
            chrome.runtime.sendMessage({
              action: 'RECORD_ERROR_LOG',
              error: errObj,
              model: resp.model || currentSettings.model,
              tabId: activeTab.id,
              isTerminal: true
            });
          } catch {}
          updateStatus('error', typeof formatDetail === 'function' ? formatDetail('error', {
            error: resp.error,
            elapsedMs: resp.elapsedMs,
            model: resp.model || currentSettings.model,
            actualModel: resp.actualModel,
            fallbackIndex: resp.fallbackIndex
          }) : (resp.error.message || 'Error'));
          if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
          return;
        }

        if (currentMode === 'scroll-follow' || resp?.watching) {
          if (typeof startPolling === 'function') startPolling();
          updateStatus('watching', typeof formatDetail === 'function' ? formatDetail('watching', {
            applied: resp?.applied || 0,
            totalApplied: resp?.applied || 0,
            totalCollected: resp?.collected || 0,
            elapsedMs: resp?.elapsedMs,
            model: resp?.model || currentSettings.model,
            actualModel: resp?.actualModel,
            fallbackIndex: resp?.fallbackIndex
          }) : '');
        } else {
          updateStatus('translated', typeof formatDetail === 'function' ? formatDetail('translated', {
            applied: resp?.applied || 0,
            totalCollected: resp?.collected,
            totalApplied: resp?.applied,
            failed: resp?.failed || 0,
            totalFailed: resp?.failed || 0,
            elapsedMs: resp?.elapsedMs,
            model: resp?.model || currentSettings.model,
            actualModel: resp?.actualModel,
            fallbackIndex: resp?.fallbackIndex
          }) : '');
        }
        if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness(resp?.applied || 0);
      }
    );
  } catch (err) {
    if (typeof stopPolling === 'function') stopPolling();
    updateStatus('error', err?.message || t(currentUiLocale, 'err_cannot_inject_content'));
    if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
  }
}

export function handleRestorePage({
  activeTab,
  btnRestore,
  currentUiLocale,
  t,
  stopPolling,
  updateStatus,
  evaluateActionReadiness
}) {
  if (!activeTab || !activeTab.id) return;

  if (btnRestore) btnRestore.disabled = true;
  if (typeof stopPolling === 'function') stopPolling();
  chrome.tabs.sendMessage(activeTab.id, { action: 'CONTENT_RESTORE' }, (resp) => {
    if (chrome.runtime.lastError) {
      updateStatus('error', chrome.runtime.lastError.message);
      if (btnRestore) btnRestore.disabled = false;
      return;
    }
    const restored = resp?.restored || 0;
    updateStatus('restored', t(currentUiLocale, 'detail_restored_nodes_original', { count: restored }));
    if (btnRestore) btnRestore.disabled = true;
    if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness(0);
  });
}
