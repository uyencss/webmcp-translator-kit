// WebMCP Translator Kit — Popup Logic
// Contract Version: webmcp-translator-contract/1

export const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';
export const RECOMMENDED_MODELS = [
  'ag/gemini-3.1-pro-low',
  'do/glm-5.3-flash',
  'do/deepseek-v4.1-flash',
  'ag/gemini-3.1-pro-low',
  'ag/gemini-3.8-flash'
];

if (typeof window !== 'undefined') {
  window.DEFAULT_MODEL = DEFAULT_MODEL;
  window.RECOMMENDED_MODELS = RECOMMENDED_MODELS;
}

document.addEventListener('DOMContentLoaded', async () => {
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const btnTranslate = document.getElementById('btn-translate');
  const btnRestore = document.getElementById('btn-restore');

  const inputBaseUrl = document.getElementById('input-base-url');
  const inputApiKey = document.getElementById('input-api-key');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const selectModel = document.getElementById('select-model');
  const btnRefreshModels = document.getElementById('btn-refresh-models');
  const selectSrcLang = document.getElementById('select-src-lang');
  const selectTgtLang = document.getElementById('select-tgt-lang');

  const btnSaveConfig = document.getElementById('btn-save-config');
  const btnDeleteKey = document.getElementById('btn-delete-key');
  const configMessage = document.getElementById('config-message');
  const keyStatusIndicator = document.getElementById('key-status-indicator');

  let activeTab = null;
  let hasStoredKey = false;
  let pollInterval = null;

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(() => {
      checkTabStatus();
    }, 600);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function updateStatus(state, detail = '') {
    switch (state) {
      case 'unconfigured':
        statusText.textContent = 'Chưa cấu hình';
        statusText.style.color = '#ef4444';
        break;
      case 'ready':
        statusText.textContent = 'Sẵn sàng';
        statusText.style.color = '#16a34a';
        break;
      case 'translating':
        statusText.textContent = 'Đang dịch...';
        statusText.style.color = '#2563eb';
        break;
      case 'translated':
        statusText.textContent = 'Đã dịch';
        statusText.style.color = '#16a34a';
        break;
      case 'restored':
        statusText.textContent = 'Đã khôi phục';
        statusText.style.color = '#64748b';
        break;
      case 'error':
        statusText.textContent = 'Lỗi';
        statusText.style.color = '#dc2626';
        break;
      default:
        statusText.textContent = state;
        statusText.style.color = 'inherit';
    }
    statusDetail.textContent = detail;
  }

  function setConfigMsg(msg, isError = false) {
    configMessage.textContent = msg;
    configMessage.className = 'config-message ' + (isError ? 'error' : 'success');
    setTimeout(() => {
      if (configMessage.textContent === msg) configMessage.textContent = '';
    }, 4000);
  }

  // Load active tab
  async function resolveActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tab;
      if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        btnTranslate.disabled = true;
        btnRestore.disabled = true;
        updateStatus('unsupported', 'Trang hệ thống Chrome không hỗ trợ dịch.');
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Query background settings
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (resp) => {
        if (resp && resp.settings) {
          inputBaseUrl.value = resp.settings.baseURL || 'http://localhost:8080/v1';
          if (resp.settings.sourceLanguage) selectSrcLang.value = resp.settings.sourceLanguage;
          if (resp.settings.targetLanguage) selectTgtLang.value = resp.settings.targetLanguage;
          hasStoredKey = Boolean(resp.hasKey);
          keyStatusIndicator.textContent = hasStoredKey ? 'Key: Đã lưu' : 'Key: Chưa lưu';
          if (hasStoredKey && !inputApiKey.value) {
            inputApiKey.placeholder = '•••••••••••••••• (Đã lưu)';
          }
        }
        resolve();
      });
    });
  }

  // Populate models
  async function refreshModels() {
    selectModel.innerHTML = '<option value="">Đang tải models...</option>';
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'LIST_MODELS' }, (resp) => {
        selectModel.innerHTML = '';

        // Group 1: Recommended models at the top
        const recGroup = document.createElement('optgroup');
        recGroup.label = 'Recommended';
        for (const mId of RECOMMENDED_MODELS) {
          const opt = document.createElement('option');
          opt.value = mId;
          opt.textContent = mId;
          recGroup.appendChild(opt);
        }
        selectModel.appendChild(recGroup);

        // Group 2: Other models from endpoint
        const serverModels = (resp && resp.models && Array.isArray(resp.models)) ? resp.models : [];
        const otherModels = serverModels.filter((m) => !RECOMMENDED_MODELS.includes(m.id));
        if (otherModels.length > 0) {
          const otherGroup = document.createElement('optgroup');
          otherGroup.label = 'Other Models';
          for (const m of otherModels) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.id;
            otherGroup.appendChild(opt);
          }
          selectModel.appendChild(otherGroup);
        }

        chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (sResp) => {
          if (sResp && sResp.settings && sResp.settings.model) {
            selectModel.value = sResp.settings.model;
          } else {
            selectModel.value = DEFAULT_MODEL;
          }
        });
        resolve();
      });
    });
  }

  function formatElapsed(ms) {
    if (typeof ms !== 'number' || ms <= 0) return '';
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatDetail(state, data = {}) {
    const elapsed = formatElapsed(data.elapsedMs);
    const model = data.model || selectModel.value || DEFAULT_MODEL;
    const metaStr = elapsed ? ` (${elapsed} · ${model})` : ` (${model})`;

    if (state === 'translated') {
      const countStr = typeof data.totalCollected === 'number'
        ? `${data.totalApplied || 0}/${data.totalCollected}`
        : `${data.applied || 0}`;
      const failed = typeof data.totalFailed === 'number' ? data.totalFailed : (data.failed || 0);
      if (failed > 0) {
        return `Đã dịch ${countStr} nodes (${failed} lỗi — bấm "Dịch trang này" lần nữa để dịch nốt phần còn lại)`;
      }
      return `Đã dịch ${countStr} nodes${metaStr}.`;
    }

    if (state === 'error') {
      const err = data.error || {};
      const code = err.code || 'ERROR';
      const msg = err.message || '';
      if (code === 'TIMEOUT') {
        return `[TIMEOUT] ${msg || 'Quá thời gian chờ'}${metaStr}. Gợi ý: chọn model nhanh hơn (do/glm-5.3-flash) hoặc giảm số node.`;
      }
      return `[${code}] ${msg}${metaStr}`;
    }

    return '';
  }

  // Check tab status
  async function checkTabStatus() {
    if (!activeTab || !activeTab.id) return;
    try {
      chrome.tabs.sendMessage(activeTab.id, { action: 'CONTENT_GET_STATUS' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          stopPolling();
          // Content script not yet injected
          if (hasStoredKey && inputBaseUrl.value) {
            updateStatus('ready', 'Sẵn sàng dịch trang hiện tại.');
            btnTranslate.disabled = false;
          } else {
            updateStatus('unconfigured', 'Vui lòng cấu hình Base URL và API key.');
            btnTranslate.disabled = true;
          }
          btnRestore.disabled = true;
          return;
        }

        const st = resp.status;
        if (st.state === 'done') {
          stopPolling();
          updateStatus('translated', formatDetail('translated', {
            totalApplied: st.totalApplied,
            totalCollected: st.totalCollected,
            totalFailed: st.totalFailed,
            failed: st.totalFailed,
            elapsedMs: st.elapsedMs,
            model: st.model
          }));
          btnRestore.disabled = resp.restorableCount === 0;
          btnTranslate.disabled = false;
        } else if (st.state === 'restored') {
          stopPolling();
          updateStatus('restored', `Đã khôi phục ${st.totalRestored} nodes.`);
          btnRestore.disabled = true;
          btnTranslate.disabled = false;
        } else if (st.state === 'translating') {
          startPolling();
          const progressDetail = (typeof st.totalCollected === 'number' && st.totalCollected > 0)
            ? `Đang dịch ${st.totalApplied || 0}/${st.totalCollected} nodes...`
            : 'Đang dịch...';
          updateStatus('translating', progressDetail);
          btnTranslate.disabled = true;
          btnRestore.disabled = true;
        } else if (st.state === 'error') {
          stopPolling();
          updateStatus('error', formatDetail('error', {
            error: st.error,
            elapsedMs: st.elapsedMs,
            model: st.model
          }));
          btnTranslate.disabled = false;
          btnRestore.disabled = resp.restorableCount === 0;
        } else {
          stopPolling();
          updateStatus('ready', 'Sẵn sàng dịch.');
          btnTranslate.disabled = false;
          btnRestore.disabled = resp.restorableCount === 0;
        }
      });
    } catch {
      stopPolling();
      // Content script message failed
    }
  }

  // Toggle API key mask
  btnToggleKey.addEventListener('click', () => {
    if (inputApiKey.type === 'password') {
      inputApiKey.type = 'text';
      btnToggleKey.textContent = '🔒';
    } else {
      inputApiKey.type = 'password';
      btnToggleKey.textContent = '👁️';
    }
  });

  // Refresh models button
  btnRefreshModels.addEventListener('click', async () => {
    btnRefreshModels.disabled = true;
    await refreshModels();
    btnRefreshModels.disabled = false;
  });

  // Save configuration with permission request
  btnSaveConfig.addEventListener('click', async () => {
    const rawUrl = inputBaseUrl.value.trim();
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      setConfigMsg('Base URL phải bắt đầu bằng http:// hoặc https://', true);
      return;
    }

    let origin = '';
    try {
      origin = new URL(rawUrl).origin + '/*';
    } catch {
      setConfigMsg('Base URL không hợp lệ', true);
      return;
    }

    // Request host permission in user gesture
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        setConfigMsg('Cần cấp quyền host permission để kết nối Base URL', true);
        updateStatus('error', '[PERMISSION_REQUIRED] Chưa cấp quyền kết nối Base URL');
        return;
      }
    } catch (err) {
      setConfigMsg('Không thể xin quyền host: ' + (err?.message || ''), true);
      return;
    }

    const newSettings = {
      baseURL: rawUrl,
      model: selectModel.value || DEFAULT_MODEL,
      sourceLanguage: selectSrcLang.value || 'auto',
      targetLanguage: selectTgtLang.value || 'vi'
    };

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: newSettings }, resolve);
    });

    const keyVal = inputApiKey.value.trim();
    if (keyVal) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SET_KEY', key: keyVal }, resolve);
      });
      hasStoredKey = true;
      keyStatusIndicator.textContent = 'Key: Đã lưu';
      inputApiKey.value = '';
      inputApiKey.placeholder = '•••••••••••••••• (Đã lưu)';
    }

    setConfigMsg('Đã lưu cấu hình thành công!');
    await refreshModels();
    await checkTabStatus();
  });

  // Delete API key
  btnDeleteKey.addEventListener('click', async () => {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'DELETE_KEY' }, resolve);
    });
    hasStoredKey = false;
    keyStatusIndicator.textContent = 'Key: Chưa lưu';
    inputApiKey.value = '';
    inputApiKey.placeholder = 'Nhập API key';
    setConfigMsg('Đã xoá API key.');
    await checkTabStatus();
  });

  // Translate page action
  btnTranslate.addEventListener('click', async () => {
    if (!activeTab || !activeTab.id) return;

    btnTranslate.disabled = true;
    updateStatus('translating', 'Đang quét toàn bộ DOM và dịch...');
    startPolling();

    try {
      // Inject content.js if not yet injected
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['content.js']
      });

      const currentSettings = {
        baseURL: inputBaseUrl.value.trim(),
        model: selectModel.value || DEFAULT_MODEL,
        sourceLanguage: selectSrcLang.value || 'auto',
        targetLanguage: selectTgtLang.value || 'vi'
      };

      chrome.tabs.sendMessage(
        activeTab.id,
        { action: 'CONTENT_START_TRANSLATION', settings: currentSettings },
        (resp) => {
          stopPolling();
          if (chrome.runtime.lastError) {
            updateStatus('error', chrome.runtime.lastError.message);
            btnTranslate.disabled = false;
            return;
          }
          if (resp && resp.error) {
            updateStatus('error', formatDetail('error', {
              error: resp.error,
              elapsedMs: resp.elapsedMs,
              model: resp.model || currentSettings.model
            }));
            btnTranslate.disabled = false;
            return;
          }
          updateStatus('translated', formatDetail('translated', {
            applied: resp.applied || 0,
            totalCollected: resp.collected,
            totalApplied: resp.applied,
            failed: resp.failed || 0,
            totalFailed: resp.failed || 0,
            elapsedMs: resp.elapsedMs,
            model: resp.model || currentSettings.model
          }));
          btnTranslate.disabled = false;
          btnRestore.disabled = false;
        }
      );
    } catch (err) {
      stopPolling();
      updateStatus('error', err?.message || 'Không thể inject content script');
      btnTranslate.disabled = false;
    }
  });

  // Restore page action
  btnRestore.addEventListener('click', async () => {
    if (!activeTab || !activeTab.id) return;

    btnRestore.disabled = true;
    stopPolling();
    chrome.tabs.sendMessage(activeTab.id, { action: 'CONTENT_RESTORE' }, (resp) => {
      if (chrome.runtime.lastError) {
        updateStatus('error', chrome.runtime.lastError.message);
        btnRestore.disabled = false;
        return;
      }
      const restored = resp?.restored || 0;
      updateStatus('restored', `Đã khôi phục ${restored} nodes về bản gốc.`);
      btnRestore.disabled = true;
      btnTranslate.disabled = false;
    });
  });

  // Initial sequence
  await loadSettings();
  const tabOk = await resolveActiveTab();
  if (tabOk) {
    if (hasStoredKey) {
      refreshModels().catch(() => {});
    }
    await checkTabStatus();
  }
});
