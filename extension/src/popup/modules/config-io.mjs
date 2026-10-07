// WebMCP Translator Kit — Popup Module: Config I/O
// Handles export configuration generation and import configuration parsing

import { buildExportConfig, parseImportConfig } from '../../settings.mjs';

export function buildExportPayload({
  settings,
  fallbackKeyPresence = {},
  hasStoredKey = false,
  includeKeys = false,
  apiKey = '',
  fallbackApiKeys = {},
  exportedAt
} = {}) {
  const baseConfig = buildExportConfig({
    settings,
    fallbackKeyPresence,
    hasStoredKey,
    exportedAt
  });

  if (!includeKeys) {
    return {
      filename: 'translator-config.json',
      data: baseConfig
    };
  }

  const withKeysData = {
    ...baseConfig,
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    fallbackApiKeys: (fallbackApiKeys && typeof fallbackApiKeys === 'object' && !Array.isArray(fallbackApiKeys))
      ? { ...fallbackApiKeys }
      : {}
  };

  return {
    filename: 'translator-config.with-keys.json',
    data: withKeysData
  };
}

export function downloadJsonFile(filename, jsonData) {
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

export async function executeExportConfig(options = {}, {
  checkboxExportKeys,
  savedSettings,
  inputApiKey,
  hasStoredKey,
  currentUiLocale,
  t,
  updateStatus
}) {
  let includeKeys = false;
  if (options && typeof options.withKeys === 'boolean') {
    includeKeys = options.withKeys;
  } else if (checkboxExportKeys) {
    includeKeys = Boolean(checkboxExportKeys.checked);
  } else if (typeof savedSettings.exportIncludeKeys === 'boolean') {
    includeKeys = savedSettings.exportIncludeKeys;
  } else {
    includeKeys = true;
  }

  let confirmedWithKeys = false;
  if (includeKeys) {
    const confirmFn = (typeof window !== 'undefined' && typeof window.confirm === 'function')
      ? window.confirm
      : (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function' ? globalThis.confirm : null);
    const warningMessage = t(currentUiLocale, 'export_keys_warning_confirm');
    const userApproved = confirmFn ? Boolean(confirmFn(warningMessage)) : false;
    if (userApproved) {
      confirmedWithKeys = true;
    }
  }

  let fallbackKeyPresence = {};
  let storedFbKeys = {};
  let storedApiKey = '';

  try {
    const res = await chrome.storage.local.get(['fallback_api_keys', 'api_key']);
    storedFbKeys = (res && res.fallback_api_keys && typeof res.fallback_api_keys === 'object')
      ? res.fallback_api_keys
      : {};
    storedApiKey = (res && typeof res.api_key === 'string') ? res.api_key : '';
    for (const id of Object.keys(storedFbKeys)) {
      if (typeof storedFbKeys[id] === 'string' && storedFbKeys[id].trim()) {
        fallbackKeyPresence[id] = true;
      }
    }
  } catch (err) {
    console.warn('[popup] Failed to read keys for export:', err);
  }

  if (!storedApiKey && inputApiKey && inputApiKey.value && inputApiKey.value.trim()) {
    storedApiKey = inputApiKey.value.trim();
  }

  const payload = buildExportPayload({
    settings: savedSettings,
    fallbackKeyPresence,
    hasStoredKey: Boolean(hasStoredKey || storedApiKey),
    includeKeys: confirmedWithKeys,
    apiKey: storedApiKey,
    fallbackApiKeys: storedFbKeys
  });

  try {
    downloadJsonFile(payload.filename, payload.data);
    if (typeof updateStatus === 'function') {
      updateStatus(
        'ready',
        confirmedWithKeys ? t(currentUiLocale, 'export_json_with_keys_success') : t(currentUiLocale, 'export_json_success')
      );
    }
  } catch (err) {
    console.warn('[popup] Export JSON failed:', err);
  }
}

export async function executeImportConfig(file, {
  tabPanels,
  cancelAutosaveTimer,
  waitForAutosaveIdle,
  getFavoriteWriteQueue,
  sendMsg,
  inputApiKey,
  loadSettings,
  setConfigMsg,
  configMessageConnect,
  currentUiLocale,
  t,
  renderFallbackRows,
  renderAllModelDropdowns,
  evaluateActionReadiness,
  inputImportConfigConnect,
  setImportInProgress
}) {
  if (!file) return;
  let settingsSaved = false;
  const lockedControls = [];
  try {
    if (file.size > 1_000_000) throw new Error('Configuration file is too large');
    const imported = parseImportConfig(await file.text());
    const confirmFn = (typeof window !== 'undefined' && typeof window.confirm === 'function')
      ? window.confirm
      : (typeof globalThis !== 'undefined' && typeof globalThis.confirm === 'function' ? globalThis.confirm : null);
    const confirmMessage = t(currentUiLocale, imported.includesKeys ? 'import_json_keys_confirm' : 'import_json_confirm');
    if (!confirmFn || !confirmFn(confirmMessage)) return;

    if (typeof setImportInProgress === 'function') setImportInProgress(true);
    const configPanel = tabPanels ? tabPanels['tab-config'] : null;
    if (configPanel && typeof configPanel.querySelectorAll === 'function') {
      for (const control of configPanel.querySelectorAll('button, input, select, textarea')) {
        lockedControls.push([control, Boolean(control.disabled)]);
        control.disabled = true;
      }
    }
    if (typeof cancelAutosaveTimer === 'function') cancelAutosaveTimer();
    if (typeof getFavoriteWriteQueue === 'function') await getFavoriteWriteQueue();
    if (typeof waitForAutosaveIdle === 'function') await waitForAutosaveIdle();

    const saveResponse = await sendMsg({
      action: 'SAVE_SETTINGS',
      settings: imported.settings,
      replaceFavoriteModelsByBaseURL: true
    });
    if (!saveResponse || saveResponse.error) throw new Error(saveResponse?.error?.message || 'Settings save failed');
    settingsSaved = true;

    if (imported.apiKey) {
      const keyResponse = await sendMsg({ action: 'SET_KEY', key: imported.apiKey });
      if (!keyResponse || keyResponse.error) throw new Error(keyResponse?.error?.message || 'API key save failed');
    }
    for (const [id, key] of Object.entries(imported.fallbackApiKeys || {})) {
      const keyResponse = await sendMsg({ action: 'SET_FALLBACK_KEY', id, key });
      if (!keyResponse || keyResponse.error) throw new Error(keyResponse?.error?.message || 'Fallback API key save failed');
    }

    if (inputApiKey) inputApiKey.value = '';
    if (typeof loadSettings === 'function') await loadSettings();
    if (typeof setConfigMsg === 'function') setConfigMsg(configMessageConnect, t(currentUiLocale, 'import_json_success'));
  } catch (err) {
    console.warn('[popup] Import JSON failed:', err);
    if (settingsSaved) {
      if (inputApiKey) inputApiKey.value = '';
      if (typeof loadSettings === 'function') await loadSettings();
      if (typeof setConfigMsg === 'function') setConfigMsg(configMessageConnect, t(currentUiLocale, 'import_json_partial'), true);
    } else {
      if (typeof setConfigMsg === 'function') setConfigMsg(configMessageConnect, t(currentUiLocale, 'import_json_failed'), true);
    }
  } finally {
    if (typeof setImportInProgress === 'function') setImportInProgress(false);
    for (const [control, wasDisabled] of lockedControls) control.disabled = wasDisabled;
    if (settingsSaved) {
      if (typeof renderFallbackRows === 'function') { try { renderFallbackRows(); } catch {} }
      if (typeof renderAllModelDropdowns === 'function') { try { renderAllModelDropdowns(); } catch {} }
      if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
    }
    if (inputImportConfigConnect) inputImportConfigConnect.value = '';
  }
}

export async function saveKeysFromInputs({
  inputApiKey,
  fallbacks = [],
  sendMsg,
  fallbackKeyPresence = {},
  currentUiLocale = 'vi',
  t,
  keyStatusIndicator,
  onPrimaryStored = () => {}
} = {}) {
  const keyVal = inputApiKey ? inputApiKey.value.trim() : '';
  if (keyVal) {
    const keyResp = await sendMsg({ action: 'SET_KEY', key: keyVal });
    if (chrome.runtime.lastError || !keyResp || keyResp.error) {
      const err = (keyResp && keyResp.error) || chrome.runtime.lastError || {};
      throw new Error(t(currentUiLocale, 'err_save_key_failed', { error: (err && err.message) || t(currentUiLocale, 'err_unknown') }));
    }
    onPrimaryStored();
    if (keyStatusIndicator) keyStatusIndicator.textContent = t(currentUiLocale, 'conn_key_stored');
    if (inputApiKey) {
      inputApiKey.value = '';
      inputApiKey.placeholder = t(currentUiLocale, 'conn_key_placeholder_saved');
    }
  }

  for (let i = 0; i < fallbacks.length; i++) {
    const fb = fallbacks[i];
    const fbKeyInput = document.getElementById(`input-fallback-key-${i}`);
    const fbKeyVal = fbKeyInput ? fbKeyInput.value.trim() : '';
    if (fbKeyVal) {
      const fbKeyResp = await sendMsg({ action: 'SET_FALLBACK_KEY', id: fb.id, key: fbKeyVal });
      if (chrome.runtime.lastError || !fbKeyResp || fbKeyResp.error) {
        const err = (fbKeyResp && fbKeyResp.error) || chrome.runtime.lastError || {};
        throw new Error(t(currentUiLocale, 'err_save_fallback_key_failed', { index: i + 1, error: (err && err.message) || t(currentUiLocale, 'err_unknown') }));
      }
      fallbackKeyPresence[fb.id] = true;
      if (fbKeyInput) {
        fbKeyInput.value = '';
        fbKeyInput.placeholder = t(currentUiLocale, 'conn_key_placeholder_saved');
      }
    }
  }
}

export async function handleDeleteApiKey({
  btnDeleteKey,
  inputApiKey,
  keyStatusIndicator,
  currentUiLocale = 'vi',
  t,
  configMessageConnect,
  setConfigMsg,
  renderFallbackRows,
  evaluateActionReadiness,
  checkTabStatus,
  onKeyDeleted = () => {}
} = {}) {
  if (btnDeleteKey) btnDeleteKey.disabled = true;
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'DELETE_KEY' }, resolve);
  });
  if (btnDeleteKey) btnDeleteKey.disabled = false;

  if (chrome.runtime.lastError || !resp || resp.error) {
    const err = resp?.error || chrome.runtime.lastError;
    if (typeof setConfigMsg === 'function') {
      setConfigMsg(configMessageConnect, t(currentUiLocale, 'err_delete_key_failed', { error: err?.message || '' }), true);
    }
    return;
  }

  onKeyDeleted();
  if (keyStatusIndicator) keyStatusIndicator.textContent = t(currentUiLocale, 'conn_key_not_stored');
  if (inputApiKey) {
    inputApiKey.value = '';
    inputApiKey.placeholder = t(currentUiLocale, 'conn_api_key_placeholder');
  }
  if (typeof renderFallbackRows === 'function') renderFallbackRows();
  if (typeof setConfigMsg === 'function') setConfigMsg(configMessageConnect, t(currentUiLocale, 'msg_key_deleted'));
  if (typeof evaluateActionReadiness === 'function') evaluateActionReadiness();
  if (typeof checkTabStatus === 'function') await checkTabStatus();
}
