// WebMCP Translator Kit — Popup Logic
// Contract Version: webmcp-translator-contract/1

export const DEFAULT_MODEL = 'ag/gemini-3.1-pro-low';
export const RECOMMENDED_MODELS = [
  'ag/gemini-3.1-pro-low',
  'do/glm-5.3-flash',
  'do/deepseek-v4.1-flash',
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

  const toggleSiteConsent = document.getElementById('toggle-site-consent');
  const siteOriginBadge = document.getElementById('site-origin-badge');
  const btnOverrideInherit = document.getElementById('btn-override-inherit');
  const btnOverrideOn = document.getElementById('btn-override-on');
  const btnOverrideOff = document.getElementById('btn-override-off');

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
  const keyAccessBanner = document.getElementById('key-access-banner');

  let activeTab = null;
  let hasStoredKey = false;
  let pollInterval = null;

  let currentConsent = {
    siteOrigin: null,
    siteEnabled: false,
    tabOverride: null,
    effective: 'off'
  };

  function showKeyAccessBanner() {
    if (keyAccessBanner) keyAccessBanner.style.display = 'block';
    btnTranslate.disabled = true;
    btnRefreshModels.disabled = true;
    selectModel.disabled = true;
  }

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
      case 'unsupported':
        statusText.textContent = 'Không hỗ trợ';
        statusText.style.color = '#94a3b8';
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

  // Load and validate active tab
  async function resolveActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tab;
      if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        btnTranslate.disabled = true;
        btnRestore.disabled = true;
        btnTranslate.title = 'Trang hệ thống hoặc protocol không hỗ trợ';
        updateStatus('unsupported', 'Trang hệ thống Chrome hoặc URL không phải HTTP(S) không hỗ trợ dịch.');
        if (toggleSiteConsent) toggleSiteConsent.disabled = true;
        if (btnOverrideInherit) btnOverrideInherit.disabled = true;
        if (btnOverrideOn) btnOverrideOn.disabled = true;
        if (btnOverrideOff) btnOverrideOff.disabled = true;
        if (siteOriginBadge) siteOriginBadge.textContent = 'Không hỗ trợ';
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Evaluates button states and hints based on current state matrix
  function evaluateActionReadiness(restorableCount = 0) {
    if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
      btnTranslate.disabled = true;
      btnRestore.disabled = true;
      btnTranslate.title = 'Trang hệ thống hoặc URL không phải HTTP(S) không hỗ trợ dịch';
      return;
    }

    if (!hasStoredKey) {
      btnTranslate.disabled = true;
      btnTranslate.title = 'Vui lòng nhập API key để bắt đầu dịch';
      updateStatus('unconfigured', 'Vui lòng nhập API key trong mục Cấu hình.');
      btnRestore.disabled = restorableCount === 0;
      return;
    }

    const curModel = selectModel.value ? selectModel.value.trim() : '';
    if (!curModel || curModel === '' || curModel.includes('Lỗi')) {
      btnTranslate.disabled = true;
      btnTranslate.title = 'Chưa chọn model hợp lệ';
      updateStatus('error', 'Chưa chọn model hợp lệ. Vui lòng chọn model hoặc làm mới danh sách.');
      btnRestore.disabled = restorableCount === 0;
      return;
    }

    btnTranslate.disabled = false;
    btnTranslate.title = 'Dịch trang này';
    btnRestore.disabled = restorableCount === 0;
    if (statusText.textContent === 'Chưa cấu hình' || statusText.textContent === 'Đang tải...') {
      updateStatus('ready', 'Sẵn sàng dịch trang hiện tại.');
    }
  }

  // Load consent state for current active tab
  async function loadConsent() {
    if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
      if (toggleSiteConsent) toggleSiteConsent.disabled = true;
      if (btnOverrideInherit) btnOverrideInherit.disabled = true;
      if (btnOverrideOn) btnOverrideOn.disabled = true;
      if (btnOverrideOff) btnOverrideOff.disabled = true;
      if (siteOriginBadge) siteOriginBadge.textContent = 'Không hỗ trợ';
      return null;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_CONSENT', tabId: activeTab.id }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          if (resp && resp.error && resp.error.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          if (siteOriginBadge) siteOriginBadge.textContent = '--';
          resolve(null);
          return;
        }

        currentConsent = resp;
        if (siteOriginBadge) siteOriginBadge.textContent = resp.siteOrigin || '--';
        if (toggleSiteConsent) {
          toggleSiteConsent.disabled = !resp.siteOrigin;
          toggleSiteConsent.checked = Boolean(resp.siteEnabled);
        }

        if (btnOverrideInherit && btnOverrideOn && btnOverrideOff) {
          btnOverrideInherit.disabled = !resp.siteOrigin;
          btnOverrideOn.disabled = !resp.siteOrigin;
          btnOverrideOff.disabled = !resp.siteOrigin;

          btnOverrideInherit.classList.toggle('active', resp.tabOverride === null || resp.tabOverride === undefined);
          btnOverrideOn.classList.toggle('active', resp.tabOverride === 'on');
          btnOverrideOff.classList.toggle('active', resp.tabOverride === 'off');
        }

        resolve(resp);
      });
    });
  }

  // Non-optimistic update for tab override buttons
  async function updateTabOverride(val) {
    if (!activeTab || !activeTab.id) return;
    btnOverrideInherit.disabled = true;
    btnOverrideOn.disabled = true;
    btnOverrideOff.disabled = true;

    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'SET_TAB_OVERRIDE',
        tabId: activeTab.id,
        value: val
      }, resolve);
    });

    btnOverrideInherit.disabled = false;
    btnOverrideOn.disabled = false;
    btnOverrideOff.disabled = false;

    if (chrome.runtime.lastError || !resp || resp.error) {
      const err = resp?.error || chrome.runtime.lastError;
      updateStatus('error', `[${err.code || 'ERROR'}] ${err.message || 'Không thể lưu cài đặt tab override'}`);
      return;
    }

    await loadConsent();
    await checkTabStatus();
  }

  // Non-optimistic site toggle event listener with user gesture permission request
  if (toggleSiteConsent) {
    toggleSiteConsent.addEventListener('change', async () => {
      if (!currentConsent.siteOrigin) return;
      const targetChecked = toggleSiteConsent.checked;
      const prevChecked = !targetChecked;
      toggleSiteConsent.disabled = true;

      // When turning ON, request permission in user gesture
      if (targetChecked) {
        const matchPattern = currentConsent.siteOrigin + '/*';
        let granted = false;
        try {
          if (chrome.permissions && typeof chrome.permissions.request === 'function') {
            granted = await chrome.permissions.request({ origins: [matchPattern] });
          } else {
            granted = true;
          }
        } catch {
          granted = false;
        }

        if (!granted) {
          toggleSiteConsent.checked = prevChecked;
          toggleSiteConsent.disabled = false;
          updateStatus('error', '[PERMISSION_REQUIRED] Cần cấp quyền truy cập để bật dịch cho site này.');
          return;
        }
      }

      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'SET_SITE_ENABLED',
          origin: currentConsent.siteOrigin,
          enabled: targetChecked,
          tabId: activeTab?.id
        }, resolve);
      });

      if (chrome.runtime.lastError || !resp || resp.error) {
        toggleSiteConsent.checked = prevChecked;
        toggleSiteConsent.disabled = false;
        const err = resp?.error || chrome.runtime.lastError;
        updateStatus('error', `[${err.code || 'ERROR'}] ${err.message || 'Không thể lưu quyền site'}`);
        return;
      }

      toggleSiteConsent.disabled = false;
      await loadConsent();
      await checkTabStatus();
    });
  }

  // Tab override buttons event listeners
  if (btnOverrideInherit) {
    btnOverrideInherit.addEventListener('click', () => updateTabOverride(null));
  }
  if (btnOverrideOn) {
    btnOverrideOn.addEventListener('click', () => updateTabOverride('on'));
  }
  if (btnOverrideOff) {
    btnOverrideOff.addEventListener('click', () => updateTabOverride('off'));
  }

  // Query background settings
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (resp) => {
        if (resp && resp.error) {
          if (resp.error.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          updateStatus('error', `[${resp.error.code}] ${resp.error.message}`);
          resolve();
          return;
        }
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
    selectModel.disabled = true;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'LIST_MODELS' }, (resp) => {
        selectModel.disabled = false;
        if (resp && resp.error) {
          if (resp.error.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          selectModel.innerHTML = `<option value="">Lỗi tải models (${resp.error.code})</option>`;
          updateStatus('error', `[${resp.error.code}] ${resp.error.message || 'Lỗi tải danh sách model'}`);
          evaluateActionReadiness();
          resolve();
          return;
        }

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
          evaluateActionReadiness();
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
      if (code === 'DROPPED_ON_RESTART') {
        return `[DROPPED_ON_RESTART] Yêu cầu bị mất khi service worker khởi động lại — bấm "Dịch trang này" để chạy lại`;
      }
      if (code === 'TIMEOUT') {
        return `[TIMEOUT] ${msg || 'Quá thời gian chờ'}${metaStr}. Gợi ý: chọn model nhanh hơn hoặc giảm số node.`;
      }
      if (code === 'OPT_IN_REQUIRED') {
        return `[OPT_IN_REQUIRED] Chưa bật quyền dịch cho site này. Vui lòng bật "Bật dịch cho site này" ở trên.`;
      }
      if (code === 'SITE_NOT_ALLOWED') {
        return `[SITE_NOT_ALLOWED] Trang web này không hỗ trợ dịch hoặc URL không hợp lệ.`;
      }
      if (code === 'KEY_ACCESS_UNAVAILABLE') {
        showKeyAccessBanner();
        return `[KEY_ACCESS_UNAVAILABLE] Lỗi bảo mật bộ nhớ extension. Vui lòng thử lại.`;
      }
      if (code === 'CONSENT_STATE_UNAVAILABLE') {
        return `[CONSENT_STATE_UNAVAILABLE] Không thể đọc trạng thái consent.`;
      }
      if (code === 'PERMISSION_REQUIRED') {
        return `[PERMISSION_REQUIRED] Cần cấp quyền để thực hiện thao tác này.`;
      }
      if (code === 'RATE_LIMITED') {
        const scope = err.details?.scope || 'tab';
        const retrySec = Math.ceil((err.details?.retryAfterMs || 0) / 1000);
        return `[RATE_LIMITED] ${scope} · thử lại sau ${retrySec}s`;
      }
      if (code === 'CAP_EXCEEDED') {
        const capType = err.details?.capType || 'kích thước';
        const limit = err.details?.limit;
        const actual = err.details?.actual;
        const limitStr = (limit !== undefined && actual !== undefined) ? ` (${actual} > ${limit})` : '';
        return `[CAP_EXCEEDED] Batch bị loại do vượt cap ${capType}${limitStr}`;
      }
      if (code === 'INVALID_SCHEMA') {
        const schemaErrors = (err.details?.schemaErrors || []).join(', ');
        return `[INVALID_SCHEMA] Dữ liệu không đúng schema${schemaErrors ? ': ' + schemaErrors : ''}`;
      }
      if (code === 'NETWORK') {
        return `[NETWORK] Mất kết nối mạng hoặc không thể kết nối tới Base URL.`;
      }
      if (code.startsWith('HTTP_')) {
        const statusText = err.details?.statusText || msg || '';
        return `[${code}] Lỗi phản hồi từ máy chủ: ${statusText}`;
      }
      if (code === 'RATE_STATE_UNAVAILABLE') {
        return `[RATE_STATE_UNAVAILABLE] Không thể đọc hoặc ghi bộ đếm giới hạn tốc độ.`;
      }
      return `[${code}] ${msg}${metaStr}`;
    }

    return '';
  }

  // Check tab status and queue status
  async function checkTabStatus() {
    if (!activeTab || !activeTab.id) return;
    try {
      chrome.tabs.sendMessage(activeTab.id, { action: 'CONTENT_GET_STATUS' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          stopPolling();
          // Content script not yet injected
          evaluateActionReadiness(0);
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
          evaluateActionReadiness(resp.restorableCount || 0);
        } else if (st.state === 'restored') {
          stopPolling();
          updateStatus('restored', `Đã khôi phục ${st.totalRestored} nodes.`);
          evaluateActionReadiness(0);
        } else if (st.state === 'translating') {
          startPolling();
          // Query queue status from SW
          chrome.runtime.sendMessage({ action: 'GET_QUEUE_STATUS', tabId: activeTab.id }, (qResp) => {
            if (qResp && qResp.queued) {
              const remSec = Math.max(1, Math.ceil((qResp.retryAfterMs || 0) / 1000));
              updateStatus('translating', `Đang chờ quota… sẽ chạy lại sau ~${remSec}s`);
            } else {
              const progressDetail = (typeof st.totalCollected === 'number' && st.totalCollected > 0)
                ? `Đang dịch ${st.totalApplied || 0}/${st.totalCollected} nodes...`
                : 'Đang dịch...';
              updateStatus('translating', progressDetail);
            }
          });
          btnTranslate.disabled = true;
          btnRestore.disabled = true;
        } else if (st.state === 'error') {
          stopPolling();
          updateStatus('error', formatDetail('error', {
            error: st.error,
            elapsedMs: st.elapsedMs,
            model: st.model
          }));
          evaluateActionReadiness(resp.restorableCount || 0);
        } else {
          stopPolling();
          evaluateActionReadiness(resp.restorableCount || 0);
        }
      });
    } catch {
      stopPolling();
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

  // Re-evaluate readiness on model change
  selectModel.addEventListener('change', () => {
    evaluateActionReadiness();
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

    const saveResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: newSettings }, resolve);
    });

    if (chrome.runtime.lastError || !saveResp || saveResp.error) {
      const err = saveResp?.error || chrome.runtime.lastError;
      setConfigMsg('Lỗi lưu cấu hình: ' + (err.message || 'Lỗi không xác định'), true);
      return;
    }

    const keyVal = inputApiKey.value.trim();
    if (keyVal) {
      const keyResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SET_KEY', key: keyVal }, resolve);
      });
      if (chrome.runtime.lastError || !keyResp || keyResp.error) {
        const err = keyResp?.error || chrome.runtime.lastError;
        setConfigMsg('Lỗi lưu API key: ' + (err.message || 'Lỗi không xác định'), true);
        return;
      }
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
    btnDeleteKey.disabled = true;
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'DELETE_KEY' }, resolve);
    });
    btnDeleteKey.disabled = false;

    if (chrome.runtime.lastError || !resp || resp.error) {
      const err = resp?.error || chrome.runtime.lastError;
      setConfigMsg('Lỗi xoá API key: ' + (err.message || ''), true);
      return;
    }

    hasStoredKey = false;
    keyStatusIndicator.textContent = 'Key: Chưa lưu';
    inputApiKey.value = '';
    inputApiKey.placeholder = 'Nhập API key';
    setConfigMsg('Đã xoá API key.');
    evaluateActionReadiness();
    await checkTabStatus();
  });

  // Translate page action
  btnTranslate.addEventListener('click', async () => {
    if (!activeTab || !activeTab.id) return;

    btnTranslate.disabled = true;
    updateStatus('translating', 'Đang chuẩn bị dịch...');
    startPolling();

    try {
      // 1. Delegate content check and single injection to SW
      const ensureResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'ENSURE_CONTENT',
          tabId: activeTab.id
        }, resolve);
      });

      if (ensureResp && ensureResp.error) {
        stopPolling();
        updateStatus('error', formatDetail('error', { error: ensureResp.error }));
        evaluateActionReadiness();
        return;
      }

      // 2. Start translation on content script
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
            updateStatus('error', chrome.runtime.lastError.message || 'Không thể kết nối với content script');
            evaluateActionReadiness();
            return;
          }
          if (resp && resp.error) {
            updateStatus('error', formatDetail('error', {
              error: resp.error,
              elapsedMs: resp.elapsedMs,
              model: resp.model || currentSettings.model
            }));
            evaluateActionReadiness();
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
          evaluateActionReadiness(resp.applied || 0);
        }
      );
    } catch (err) {
      stopPolling();
      updateStatus('error', err?.message || 'Không thể inject content script');
      evaluateActionReadiness();
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
      evaluateActionReadiness(0);
    });
  });

  // Initial sequence
  await loadSettings();
  const tabOk = await resolveActiveTab();
  if (tabOk) {
    await loadConsent();
    if (hasStoredKey) {
      refreshModels().catch(() => {});
    }
    await checkTabStatus();
  }
});
