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
  // Shared Top Elements
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const btnTranslate = document.getElementById('btn-translate');
  const btnRestore = document.getElementById('btn-restore');

  const toggleSiteConsent = document.getElementById('toggle-site-consent');
  const siteOriginBadge = document.getElementById('site-origin-badge');
  const btnOverrideInherit = document.getElementById('btn-override-inherit');
  const btnOverrideOn = document.getElementById('btn-override-on');
  const btnOverrideOff = document.getElementById('btn-override-off');

  const keyStatusIndicator = document.getElementById('key-status-indicator');
  const keyAccessBanner = document.getElementById('key-access-banner');

  // Tab Navigation Elements
  const tabList = document.querySelector('.tab-list[role="tablist"]');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn[role="tab"]'));
  const tabPanels = {
    'tab-models': document.getElementById('tabpanel-models'),
    'tab-general': document.getElementById('tabpanel-general')
  };

  // Tab 1 Elements (Model & kết nối)
  const inputBaseUrl = document.getElementById('input-base-url');
  const inputApiKey = document.getElementById('input-api-key');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const selectModel = document.getElementById('select-model');
  const btnToggleFavorite = document.getElementById('btn-toggle-favorite');
  const btnRefreshModels = document.getElementById('btn-refresh-models');
  const selectFallback1 = document.getElementById('select-fallback-1');
  const selectFallback2 = document.getElementById('select-fallback-2');
  const btnSaveConfig = document.getElementById('btn-save-config');
  const btnDeleteKey = document.getElementById('btn-delete-key');
  const configMessage = document.getElementById('config-message');

  // Tab 2 Elements (Ngôn ngữ & chế độ)
  const selectSrcLang = document.getElementById('select-src-lang');
  const selectTgtLang = document.getElementById('select-tgt-lang');
  const modeScroll = document.getElementById('mode-scroll');
  const modeFull = document.getElementById('mode-full');
  const checkboxWidgetVisible = document.getElementById('checkbox-widget-visible');
  const btnSaveGeneral = document.getElementById('btn-save-general');
  const configMessageGeneral = document.getElementById('config-message-general');

  // Application State
  let activeTab = null;
  let hasStoredKey = false;
  let pollInterval = null;

  let currentConsent = {
    siteOrigin: null,
    siteEnabled: false,
    tabOverride: null,
    effective: 'off'
  };

  let savedSettings = {};
  let discoveredModels = [];
  let favoriteModels = [];
  let fallbackModels = [];
  let currentMode = 'scroll-follow';
  let activeTabNav = 'tab-models';

  // Key Access Banner
  function showKeyAccessBanner() {
    if (keyAccessBanner) keyAccessBanner.style.display = 'block';
    if (btnTranslate) btnTranslate.disabled = true;
    if (btnRefreshModels) btnRefreshModels.disabled = true;
    if (selectModel) selectModel.disabled = true;
  }

  // Polling for Status
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

  // UI Status Indicator
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
      case 'watching':
        statusText.textContent = 'Đang theo scroll';
        statusText.style.color = '#0284c7';
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

  // Toast / Status Message Helpers
  function setConfigMsg(msg, isError = false) {
    if (!configMessage) return;
    configMessage.textContent = msg;
    configMessage.className = 'config-message ' + (isError ? 'error' : 'success');
    setTimeout(() => {
      if (configMessage.textContent === msg) configMessage.textContent = '';
    }, 4000);
  }

  function setConfigMsgGeneral(msg, isError = false) {
    if (!configMessageGeneral) return;
    configMessageGeneral.textContent = msg;
    configMessageGeneral.className = 'config-message ' + (isError ? 'error' : 'success');
    setTimeout(() => {
      if (configMessageGeneral.textContent === msg) configMessageGeneral.textContent = '';
    }, 4000);
  }

  // Tab Navigation Controller (with roving tabindex & memory)
  function switchTab(targetTabId) {
    activeTabNav = targetTabId;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('active_translator_tab', targetTabId);
      }
    } catch {}

    for (const btn of tabButtons) {
      const isSelected = btn.id === targetTabId;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
      btn.classList.toggle('active', isSelected);
    }

    for (const [panelId, panelEl] of Object.entries(tabPanels)) {
      if (panelEl) {
        panelEl.classList.toggle('hidden', panelId !== targetTabId);
      }
    }
  }

  if (tabList) {
    tabList.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (btn && btn.id) {
        switchTab(btn.id);
      }
    });

    tabList.addEventListener('keydown', (e) => {
      const currentIdx = tabButtons.findIndex(b => b.id === activeTabNav);
      if (currentIdx === -1) return;

      let nextIdx = -1;
      if (e.key === 'ArrowRight') {
        nextIdx = (currentIdx + 1) % tabButtons.length;
      } else if (e.key === 'ArrowLeft') {
        nextIdx = (currentIdx - 1 + tabButtons.length) % tabButtons.length;
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = tabButtons.length - 1;
      }

      if (nextIdx !== -1) {
        e.preventDefault();
        const nextBtn = tabButtons[nextIdx];
        switchTab(nextBtn.id);
        nextBtn.focus();
      }
    });
  }

  // Restore remembered tab in current popup session
  try {
    const rememberedTab = sessionStorage.getItem('active_translator_tab');
    if (rememberedTab && tabPanels[rememberedTab]) {
      switchTab(rememberedTab);
    }
  } catch {}

  // Active Tab Discovery
  async function resolveActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tab;
      if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        if (btnTranslate) btnTranslate.disabled = true;
        if (btnRestore) btnRestore.disabled = true;
        if (btnTranslate) btnTranslate.title = 'Trang hệ thống hoặc protocol không hỗ trợ';
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

  // Action Readiness Evaluation
  function evaluateActionReadiness(restorableCount = 0) {
    if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
      if (btnTranslate) {
        btnTranslate.disabled = true;
        btnTranslate.title = 'Trang hệ thống hoặc URL không phải HTTP(S) không hỗ trợ dịch';
      }
      if (btnRestore) btnRestore.disabled = true;
      return;
    }

    if (!hasStoredKey) {
      if (btnTranslate) {
        btnTranslate.disabled = true;
        btnTranslate.title = 'Vui lòng nhập API key để bắt đầu dịch';
      }
      updateStatus('unconfigured', 'Vui lòng nhập API key trong mục Cấu hình.');
      if (btnRestore) btnRestore.disabled = restorableCount === 0;
      return;
    }

    const curModel = selectModel?.value ? selectModel.value.trim() : '';
    if (!curModel || curModel === '' || curModel.includes('Lỗi')) {
      if (btnTranslate) {
        btnTranslate.disabled = true;
        btnTranslate.title = 'Chưa chọn model hợp lệ';
      }
      updateStatus('error', 'Chưa chọn model hợp lệ. Vui lòng chọn model hoặc làm mới danh sách.');
      if (btnRestore) btnRestore.disabled = restorableCount === 0;
      return;
    }

    if (btnTranslate) {
      btnTranslate.disabled = false;
      btnTranslate.title = 'Dịch trang này';
    }
    if (btnRestore) btnRestore.disabled = restorableCount === 0;
    if (statusText.textContent === 'Chưa cấu hình' || statusText.textContent === 'Đang tải...') {
      updateStatus('ready', 'Sẵn sàng dịch trang hiện tại.');
    }
  }

  // Consent Management
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

  if (toggleSiteConsent) {
    toggleSiteConsent.addEventListener('change', async () => {
      if (!currentConsent.siteOrigin) return;
      const targetChecked = toggleSiteConsent.checked;
      const prevChecked = !targetChecked;
      toggleSiteConsent.disabled = true;

      // Request host permission in user gesture when turning ON
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

  if (btnOverrideInherit) {
    btnOverrideInherit.addEventListener('click', () => updateTabOverride(null));
  }
  if (btnOverrideOn) {
    btnOverrideOn.addEventListener('click', () => updateTabOverride('on'));
  }
  if (btnOverrideOff) {
    btnOverrideOff.addEventListener('click', () => updateTabOverride('off'));
  }

  // Model Dropdown Builder
  function populateSelect(selectEl, selectedVal, { allowEmpty = false, emptyLabel = '-- Không chọn --', exclude = [] } = {}) {
    if (!selectEl) return;
    selectEl.innerHTML = '';

    if (allowEmpty) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = emptyLabel;
      selectEl.appendChild(emptyOpt);
    }

    const added = new Set(exclude);

    // Group 1: Favorites
    const validFavs = favoriteModels.filter(id => !added.has(id));
    if (validFavs.length > 0) {
      const favGroup = document.createElement('optgroup');
      favGroup.label = '⭐ Yêu thích';
      for (const mId of validFavs) {
        const opt = document.createElement('option');
        opt.value = mId;
        opt.textContent = mId;
        favGroup.appendChild(opt);
        added.add(mId);
      }
      selectEl.appendChild(favGroup);
    }

    // Group 2: Currently Selected (if not in favorites / recommended / discovered)
    if (selectedVal && !added.has(selectedVal)) {
      const curGroup = document.createElement('optgroup');
      curGroup.label = 'Model đang chọn (đã lưu)';
      const opt = document.createElement('option');
      opt.value = selectedVal;
      opt.textContent = `${selectedVal} (đã lưu)`;
      curGroup.appendChild(opt);
      selectEl.appendChild(curGroup);
      added.add(selectedVal);
    }

    // Group 3: Recommended
    const recs = RECOMMENDED_MODELS.filter(id => !added.has(id));
    if (recs.length > 0) {
      const recGroup = document.createElement('optgroup');
      recGroup.label = 'Recommended';
      for (const mId of recs) {
        const opt = document.createElement('option');
        opt.value = mId;
        opt.textContent = mId;
        recGroup.appendChild(opt);
        added.add(mId);
      }
      selectEl.appendChild(recGroup);
    }

    // Group 4: Other models from server / cache
    const serverModelIds = discoveredModels
      .map(m => typeof m === 'string' ? m : m.id)
      .filter(id => id && !added.has(id));

    if (serverModelIds.length > 0) {
      const otherGroup = document.createElement('optgroup');
      otherGroup.label = 'Khác';
      for (const mId of serverModelIds) {
        const opt = document.createElement('option');
        opt.value = mId;
        opt.textContent = mId;
        otherGroup.appendChild(opt);
        added.add(mId);
      }
      selectEl.appendChild(otherGroup);
    }

    // Set selection
    if (selectedVal && Array.from(selectEl.options).some(o => o.value === selectedVal)) {
      selectEl.value = selectedVal;
    } else if (allowEmpty) {
      selectEl.value = '';
    } else {
      selectEl.value = DEFAULT_MODEL;
    }
  }

  function updateStarButton() {
    if (!btnToggleFavorite || !selectModel) return;
    const curVal = selectModel.value;
    const isFav = favoriteModels.includes(curVal);
    btnToggleFavorite.textContent = isFav ? '⭐' : '☆';
    btnToggleFavorite.classList.toggle('favorited', isFav);
    btnToggleFavorite.title = isFav ? 'Bỏ khỏi danh sách yêu thích' : 'Thêm vào danh sách yêu thích';
  }

  function renderAllModelDropdowns(preserveSelections = true) {
    const curPrimary = selectModel?.value || savedSettings.model || DEFAULT_MODEL;
    const curFb1 = selectFallback1?.value !== undefined && selectFallback1.value !== ''
      ? selectFallback1.value
      : (fallbackModels[0] || '');
    const curFb2 = selectFallback2?.value !== undefined && selectFallback2.value !== ''
      ? selectFallback2.value
      : (fallbackModels[1] || '');

    // Render Primary
    populateSelect(selectModel, curPrimary, { allowEmpty: false, exclude: [] });

    // Render Fallback 1 (excludes primary)
    populateSelect(selectFallback1, curFb1, {
      allowEmpty: true,
      emptyLabel: '-- Không chọn --',
      exclude: [selectModel.value].filter(Boolean)
    });

    // Render Fallback 2 (excludes primary and fallback 1)
    populateSelect(selectFallback2, curFb2, {
      allowEmpty: true,
      emptyLabel: '-- Không chọn --',
      exclude: [selectModel.value, selectFallback1.value].filter(Boolean)
    });

    updateStarButton();
  }

  // Favorite Star Toggle Action (Sends partial SAVE_SETTINGS)
  if (btnToggleFavorite) {
    btnToggleFavorite.addEventListener('click', async () => {
      const curVal = selectModel?.value;
      if (!curVal) return;

      const isFav = favoriteModels.includes(curVal);
      const nextFavorites = isFav
        ? favoriteModels.filter(id => id !== curVal)
        : [...favoriteModels, curVal];

      btnToggleFavorite.disabled = true;
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'SAVE_SETTINGS',
          settings: { favoriteModels: nextFavorites }
        }, resolve);
      });
      btnToggleFavorite.disabled = false;

      if (chrome.runtime.lastError || !resp || resp.error) {
        const err = resp?.error || chrome.runtime.lastError;
        setConfigMsg('Lỗi cập nhật yêu thích: ' + (err.message || 'Lỗi không xác định'), true);
        return;
      }

      favoriteModels = nextFavorites;
      savedSettings.favoriteModels = nextFavorites;
      renderAllModelDropdowns();
    });
  }

  // Model Selection Change Handler
  if (selectModel) {
    selectModel.addEventListener('change', () => {
      renderAllModelDropdowns();
      evaluateActionReadiness();
    });
  }

  if (selectFallback1) {
    selectFallback1.addEventListener('change', () => {
      // Re-populate fallback 2 to avoid selecting same as fallback 1
      const curFb2 = selectFallback2.value;
      populateSelect(selectFallback2, curFb2, {
        allowEmpty: true,
        emptyLabel: '-- Không chọn --',
        exclude: [selectModel.value, selectFallback1.value].filter(Boolean)
      });
    });
  }

  // Model Loading via LIST_MODELS (Cache-First)
  async function loadModels({ forceRefresh = false } = {}) {
    if (forceRefresh && btnRefreshModels) {
      btnRefreshModels.disabled = true;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'LIST_MODELS', forceRefresh }, (resp) => {
        if (btnRefreshModels) btnRefreshModels.disabled = false;

        if (chrome.runtime.lastError || !resp || resp.error) {
          const err = resp?.error || chrome.runtime.lastError;
          if (err && err.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          if (forceRefresh) {
            setConfigMsg('Lỗi tải danh sách model: ' + (err?.message || 'Không thể kết nối'), true);
          }
          renderAllModelDropdowns();
          evaluateActionReadiness();
          resolve();
          return;
        }

        if (resp && resp.models && Array.isArray(resp.models)) {
          discoveredModels = resp.models;
        }

        renderAllModelDropdowns();
        evaluateActionReadiness();

        if (forceRefresh) {
          setConfigMsg('Đã làm mới danh sách model thành công!');
        }
        resolve();
      });
    });
  }

  if (btnRefreshModels) {
    btnRefreshModels.addEventListener('click', async () => {
      await loadModels({ forceRefresh: true });
    });
  }

  // Background Push Listener: MODELS_UPDATED
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'MODELS_UPDATED' && Array.isArray(msg.models)) {
      discoveredModels = msg.models;
      // Background update without resetting unsaved selections
      renderAllModelDropdowns();
      evaluateActionReadiness();
    }
  });

  // Settings Loading via GET_SETTINGS
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
          savedSettings = { ...resp.settings };
          if (inputBaseUrl) inputBaseUrl.value = resp.settings.baseURL || 'http://localhost:8080/v1';
          if (selectSrcLang && resp.settings.sourceLanguage) selectSrcLang.value = resp.settings.sourceLanguage;
          if (selectTgtLang && resp.settings.targetLanguage) selectTgtLang.value = resp.settings.targetLanguage;

          if (resp.settings.translationMode) {
            currentMode = resp.settings.translationMode;
            if (currentMode === 'full' && modeFull) {
              modeFull.checked = true;
            } else if (modeScroll) {
              modeScroll.checked = true;
            }
          }

          if (checkboxWidgetVisible && typeof resp.settings.widgetVisible === 'boolean') {
            checkboxWidgetVisible.checked = resp.settings.widgetVisible;
          }

          favoriteModels = Array.isArray(resp.settings.favoriteModels) ? [...resp.settings.favoriteModels] : [];
          fallbackModels = Array.isArray(resp.settings.fallbackModels) ? [...resp.settings.fallbackModels] : [];

          hasStoredKey = Boolean(resp.hasKey);
          if (keyStatusIndicator) {
            keyStatusIndicator.textContent = hasStoredKey ? 'Key: Đã lưu' : 'Key: Chưa lưu';
          }
          if (hasStoredKey && inputApiKey && !inputApiKey.value) {
            inputApiKey.placeholder = '•••••••••••••••• (Đã lưu)';
          }

          renderAllModelDropdowns();
        }
        resolve();
      });
    });
  }

  // Telemetry Formatters
  function formatElapsed(ms) {
    if (typeof ms !== 'number' || ms <= 0) return '';
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatDetail(state, data = {}) {
    const elapsed = formatElapsed(data.elapsedMs);
    let modelStr = '';
    if (data.actualModel) {
      if (typeof data.fallbackIndex === 'number' && data.fallbackIndex >= 0) {
        modelStr = `${data.actualModel} (fallback ${data.fallbackIndex + 1})`;
      } else {
        modelStr = data.actualModel;
      }
    } else {
      modelStr = data.model || selectModel?.value || DEFAULT_MODEL;
    }

    const metaStr = elapsed ? ` (${elapsed} · ${modelStr})` : ` (${modelStr})`;

    if (state === 'watching') {
      const countStr = typeof data.totalCollected === 'number'
        ? `${data.totalApplied || 0}/${data.totalCollected}`
        : `${data.totalApplied || data.applied || 0}`;
      return `Đang theo dõi cuộn trang (${countStr} nodes đã dịch)${metaStr}.`;
    }

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
          evaluateActionReadiness(0);
          return;
        }

        const st = resp.status;
        if (st.watching === true || (st.mode === 'scroll-follow' && (st.state === 'translating' || st.state === 'done'))) {
          // In scroll mode, display 'Đang theo scroll'
          updateStatus('watching', formatDetail('watching', st));
          evaluateActionReadiness(resp.restorableCount || 0);
        } else if (st.state === 'done') {
          stopPolling();
          updateStatus('translated', formatDetail('translated', {
            totalApplied: st.totalApplied,
            totalCollected: st.totalCollected,
            totalFailed: st.totalFailed,
            failed: st.totalFailed,
            elapsedMs: st.elapsedMs,
            model: st.model,
            actualModel: st.actualModel,
            fallbackIndex: st.fallbackIndex
          }));
          evaluateActionReadiness(resp.restorableCount || 0);
        } else if (st.state === 'restored') {
          stopPolling();
          updateStatus('restored', `Đã khôi phục ${st.totalRestored} nodes.`);
          evaluateActionReadiness(0);
        } else if (st.state === 'translating') {
          startPolling();
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
          if (btnTranslate) btnTranslate.disabled = true;
          if (btnRestore) btnRestore.disabled = true;
        } else if (st.state === 'error') {
          stopPolling();
          updateStatus('error', formatDetail('error', {
            error: st.error,
            elapsedMs: st.elapsedMs,
            model: st.model,
            actualModel: st.actualModel,
            fallbackIndex: st.fallbackIndex
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
  if (btnToggleKey && inputApiKey) {
    btnToggleKey.addEventListener('click', () => {
      if (inputApiKey.type === 'password') {
        inputApiKey.type = 'text';
        btnToggleKey.textContent = '🔒';
      } else {
        inputApiKey.type = 'password';
        btnToggleKey.textContent = '👁️';
      }
    });
  }

  // Tab 1 Save Action: Partial Save (Base URL, Primary Model, Fallback Models)
  if (btnSaveConfig) {
    btnSaveConfig.addEventListener('click', async () => {
      const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : '';
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

      const selectedFb = [
        selectFallback1 ? selectFallback1.value : '',
        selectFallback2 ? selectFallback2.value : ''
      ].filter(Boolean);

      const partialSettings = {
        baseURL: rawUrl,
        model: selectModel?.value || DEFAULT_MODEL,
        fallbackModels: selectedFb
      };

      btnSaveConfig.disabled = true;
      const saveResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: partialSettings }, resolve);
      });
      btnSaveConfig.disabled = false;

      if (chrome.runtime.lastError || !saveResp || saveResp.error) {
        const err = saveResp?.error || chrome.runtime.lastError;
        // Non-optimistic revert
        if (inputBaseUrl) inputBaseUrl.value = savedSettings.baseURL || 'http://localhost:8080/v1';
        fallbackModels = Array.isArray(savedSettings.fallbackModels) ? [...savedSettings.fallbackModels] : [];
        renderAllModelDropdowns();
        setConfigMsg('Lỗi lưu cấu hình: ' + (err.message || 'Lỗi không xác định'), true);
        return;
      }

      savedSettings = { ...savedSettings, ...partialSettings };
      fallbackModels = selectedFb;

      const keyVal = inputApiKey ? inputApiKey.value.trim() : '';
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
        if (keyStatusIndicator) keyStatusIndicator.textContent = 'Key: Đã lưu';
        if (inputApiKey) {
          inputApiKey.value = '';
          inputApiKey.placeholder = '•••••••••••••••• (Đã lưu)';
        }
      }

      setConfigMsg('Đã lưu kết nối & model thành công!');
      evaluateActionReadiness();
      await checkTabStatus();
    });
  }

  // Delete API Key
  if (btnDeleteKey) {
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
      if (keyStatusIndicator) keyStatusIndicator.textContent = 'Key: Chưa lưu';
      if (inputApiKey) {
        inputApiKey.value = '';
        inputApiKey.placeholder = 'Nhập API key';
      }
      setConfigMsg('Đã xoá API key.');
      evaluateActionReadiness();
      await checkTabStatus();
    });
  }

  // Tab 2 Save Action: Partial Save (Languages, Mode, Widget Visibility)
  if (btnSaveGeneral) {
    btnSaveGeneral.addEventListener('click', async () => {
      const selectedMode = modeFull && modeFull.checked ? 'full' : 'scroll-follow';
      const partialSettings = {
        sourceLanguage: selectSrcLang ? selectSrcLang.value : 'auto',
        targetLanguage: selectTgtLang ? selectTgtLang.value : 'vi',
        translationMode: selectedMode,
        widgetVisible: Boolean(checkboxWidgetVisible ? checkboxWidgetVisible.checked : true)
      };

      btnSaveGeneral.disabled = true;
      const saveResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: partialSettings }, resolve);
      });
      btnSaveGeneral.disabled = false;

      if (chrome.runtime.lastError || !saveResp || saveResp.error) {
        const err = saveResp?.error || chrome.runtime.lastError;
        // Non-optimistic revert
        if (selectSrcLang) selectSrcLang.value = savedSettings.sourceLanguage || 'auto';
        if (selectTgtLang) selectTgtLang.value = savedSettings.targetLanguage || 'vi';
        if (modeFull && modeScroll) {
          if (savedSettings.translationMode === 'full') {
            modeFull.checked = true;
          } else {
            modeScroll.checked = true;
          }
        }
        if (checkboxWidgetVisible) {
          checkboxWidgetVisible.checked = savedSettings.widgetVisible !== false;
        }
        setConfigMsgGeneral('Lỗi lưu chế độ: ' + (err.message || 'Lỗi không xác định'), true);
        return;
      }

      savedSettings = { ...savedSettings, ...partialSettings };
      currentMode = selectedMode;
      setConfigMsgGeneral('Đã lưu ngôn ngữ & chế độ thành công!');

      // Best-effort: notify active tab content script of new mode if currently active
      if (activeTab && activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, {
          action: 'CONTENT_SET_MODE',
          mode: selectedMode
        }, () => {
          if (chrome.runtime.lastError) {
            // Ignore if content script is not yet injected or tab inactive
          }
        });
      }

      await checkTabStatus();
    });
  }

  // Translate Page Action
  if (btnTranslate) {
    btnTranslate.addEventListener('click', async () => {
      if (!activeTab || !activeTab.id) return;

      btnTranslate.disabled = true;
      updateStatus('translating', 'Đang chuẩn bị dịch...');
      startPolling();

      try {
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

        const currentSettings = {
          baseURL: inputBaseUrl ? inputBaseUrl.value.trim() : (savedSettings.baseURL || 'http://localhost:8080/v1'),
          model: selectModel?.value || savedSettings.model || DEFAULT_MODEL,
          sourceLanguage: selectSrcLang?.value || savedSettings.sourceLanguage || 'auto',
          targetLanguage: selectTgtLang?.value || savedSettings.targetLanguage || 'vi',
          translationMode: currentMode
        };

        chrome.tabs.sendMessage(
          activeTab.id,
          { action: 'CONTENT_START_TRANSLATION', settings: currentSettings, mode: currentMode },
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
                model: resp.model || currentSettings.model,
                actualModel: resp.actualModel,
                fallbackIndex: resp.fallbackIndex
              }));
              evaluateActionReadiness();
              return;
            }

            if (currentMode === 'scroll-follow' || resp?.watching) {
              updateStatus('watching', formatDetail('watching', {
                applied: resp?.applied || 0,
                totalApplied: resp?.applied || 0,
                totalCollected: resp?.collected || 0,
                elapsedMs: resp?.elapsedMs,
                model: resp?.model || currentSettings.model,
                actualModel: resp?.actualModel,
                fallbackIndex: resp?.fallbackIndex
              }));
            } else {
              updateStatus('translated', formatDetail('translated', {
                applied: resp?.applied || 0,
                totalCollected: resp?.collected,
                totalApplied: resp?.applied,
                failed: resp?.failed || 0,
                totalFailed: resp?.failed || 0,
                elapsedMs: resp?.elapsedMs,
                model: resp?.model || currentSettings.model,
                actualModel: resp?.actualModel,
                fallbackIndex: resp?.fallbackIndex
              }));
            }
            evaluateActionReadiness(resp?.applied || 0);
          }
        );
      } catch (err) {
        stopPolling();
        updateStatus('error', err?.message || 'Không thể inject content script');
        evaluateActionReadiness();
      }
    });
  }

  // Restore Page Action
  if (btnRestore) {
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
  }

  // Initial Sequence
  await loadSettings();
  const tabOk = await resolveActiveTab();
  if (tabOk) {
    await loadConsent();
    if (hasStoredKey) {
      // Cache-first: only reads local cache on open, does NOT force refresh from network
      loadModels({ forceRefresh: false }).catch(() => {});
    }
    await checkTabStatus();
  }
});
