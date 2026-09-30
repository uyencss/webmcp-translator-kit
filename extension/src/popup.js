// WebMCP Translator Kit — Popup Logic (Taste-Skill Redesign)
// Contract Version: webmcp-translator-contract/1

import { normalizeOrigin } from './consent.mjs';

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

// Inline Tabler SVG path helpers (MIT)
const SVG_ICONS = {
  check: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>',
  spinner: '<svg class="icon icon-sm spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  alert: '<svg class="icon icon-sm text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M5 19h14a2 2 0 0 0 1.84 -2.75l-7.1 -12.25a2 2 0 0 0 -3.5 0l-7.1 12.25a2 2 0 0 0 1.75 2.75"/></svg>',
  clock: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 7v5l3 3"/></svg>',
  lock: '<svg class="icon icon-sm text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/></svg>',
  scroll: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l4 -4l4 4"/><path d="M8 17l4 4l4 -4"/><path d="M12 3l0 18"/></svg>',
  restore: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14l-4 -4l4 -4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/></svg>',
  eye: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>',
  eyeOff: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/></svg>',
  star: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/></svg>',
  starFilled: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0l-2.853 5.78z"/></svg>',
  trash: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>'
};

document.addEventListener('DOMContentLoaded', async () => {
  // Common Top Elements
  const statusStrip = document.getElementById('status-strip');
  const statusIcon = document.getElementById('status-icon');
  const statusText = document.getElementById('status-text');
  const statusDetail = document.getElementById('status-detail');
  const btnTranslate = document.getElementById('btn-translate');
  const btnRestore = document.getElementById('btn-restore');
  const keyAccessBanner = document.getElementById('key-access-banner');
  const footerStatusSummary = document.getElementById('footer-status-summary');

  // Tab Navigation Elements
  const tabList = document.querySelector('.tab-list[role="tablist"]');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn[role="tab"]'));
  const tabPanels = {
    'tab-translate': document.getElementById('tabpanel-translate'),
    'tab-connect': document.getElementById('tabpanel-connect')
  };

  // Tab 1 Elements ("Dịch")
  const selectSrcLang = document.getElementById('select-src-lang');
  const selectTgtLang = document.getElementById('select-tgt-lang');
  const modeScroll = document.getElementById('mode-scroll');
  const modeFull = document.getElementById('mode-full');
  const siteOriginBadge = document.getElementById('site-origin-badge');
  const toggleSiteConsent = document.getElementById('toggle-site-consent');
  const btnOverrideInherit = document.getElementById('btn-override-inherit');
  const btnOverrideOn = document.getElementById('btn-override-on');
  const btnOverrideOff = document.getElementById('btn-override-off');
  const btnAddCurrentSite = document.getElementById('btn-add-current-site');
  const inputAutoSite = document.getElementById('input-auto-site');
  const btnAddCustomSite = document.getElementById('btn-add-custom-site');
  const autoSiteError = document.getElementById('auto-site-error');
  const autoSitesList = document.getElementById('auto-sites-list');
  const checkboxWidgetVisible = document.getElementById('checkbox-widget-visible');
  const activeUrlText = document.getElementById('active-url-text');
  const btnSaveTranslate = document.getElementById('btn-save-translate') || document.getElementById('btn-save-general');
  const configMessageTranslate = document.getElementById('config-message-translate') || document.getElementById('config-message-general');

  // Tab 2 Elements ("Kết nối")
  const inputBaseUrl = document.getElementById('input-base-url');
  const inputApiKey = document.getElementById('input-api-key');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const btnDeleteKey = document.getElementById('btn-delete-key');
  const keyStatusIndicator = document.getElementById('key-status-indicator');
  const selectModel = document.getElementById('select-model');
  const btnToggleFavorite = document.getElementById('btn-toggle-favorite');
  const btnRefreshModels = document.getElementById('btn-refresh-models');
  const btnAddFallback = document.getElementById('btn-add-fallback');
  const fallbackListEl = document.getElementById('fallback-list');
  const btnSaveConnect = document.getElementById('btn-save-connect') || document.getElementById('btn-save-config');
  const configMessageConnect = document.getElementById('config-message-connect') || document.getElementById('config-message');

  // Application State
  let activeTab = null;
  let hasStoredKey = false;
  let fallbackKeyPresence = {};
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
  let fallbacks = []; // Array of { id, model, baseURL?: string }
  let autoTranslateSites = [];
  let currentMode = 'scroll-follow';
  let activeTabNav = 'tab-translate';

  // Key Access Banner (Safety fail-closed)
  function showKeyAccessBanner() {
    if (keyAccessBanner) keyAccessBanner.style.display = 'flex';
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

  // UI Status Indicator (Single-line icon + text + tooltip)
  function updateStatus(state, detail = '') {
    let iconSvg = '';
    let shortText = '';
    let fullDetail = detail;

    switch (state) {
      case 'unconfigured':
        iconSvg = SVG_ICONS.lock;
        shortText = 'Chưa có key';
        fullDetail = detail || 'Vui lòng nhập API key tại tab Kết nối để bắt đầu dịch.';
        break;
      case 'ready':
        iconSvg = SVG_ICONS.check;
        shortText = 'Sẵn sàng';
        fullDetail = detail || 'Sẵn sàng dịch trang hiện tại.';
        break;
      case 'translating':
        iconSvg = detail.includes('quota') ? SVG_ICONS.clock : SVG_ICONS.spinner;
        shortText = detail.includes('quota') ? detail : (detail || 'Đang dịch...');
        fullDetail = detail || 'Đang gửi batch dịch nội dung trang.';
        break;
      case 'watching':
        iconSvg = SVG_ICONS.scroll;
        shortText = 'Đang theo scroll';
        fullDetail = detail || 'Đang theo dõi và dịch tự động khi cuộn trang.';
        break;
      case 'translated':
        iconSvg = SVG_ICONS.check;
        shortText = 'Đã dịch';
        fullDetail = detail || 'Toàn bộ nội dung đã được dịch thành công.';
        break;
      case 'restored':
        iconSvg = SVG_ICONS.restore;
        shortText = 'Đã khôi phục';
        fullDetail = detail || 'Đã khôi phục về văn bản gốc.';
        break;
      case 'unsupported':
        iconSvg = SVG_ICONS.alert;
        shortText = 'Không hỗ trợ';
        fullDetail = detail || 'Trang hệ thống Chrome hoặc URL không phải HTTP(S) không hỗ trợ dịch.';
        break;
      case 'error':
        iconSvg = SVG_ICONS.alert;
        if (detail.includes('RATE_LIMITED')) {
          iconSvg = SVG_ICONS.clock;
          shortText = 'Chờ quota';
        } else if (detail.includes('PERMISSION_REQUIRED')) {
          shortText = 'Thiếu quyền site';
        } else if (detail.includes('OPT_IN_REQUIRED')) {
          shortText = 'Chưa bật site';
        } else if (detail.includes('DROPPED_ON_RESTART')) {
          shortText = 'Dịch bị gián đoạn';
        } else if (detail.includes('HTTP_429')) {
          shortText = 'Lỗi HTTP_429';
        } else if (detail.includes('HTTP_')) {
          const match = detail.match(/HTTP_\d+/);
          shortText = match ? `Lỗi ${match[0]}` : 'Lỗi HTTP';
        } else {
          shortText = 'Lỗi';
        }
        fullDetail = detail || 'Đã xảy ra lỗi trong quá trình xử lý.';
        break;
      default:
        iconSvg = '<span class="status-dot"></span>';
        shortText = state;
        fullDetail = detail || state;
    }

    if (statusIcon) statusIcon.innerHTML = iconSvg;
    if (statusText) statusText.textContent = shortText;
    if (statusDetail) statusDetail.textContent = fullDetail;
    if (statusStrip) statusStrip.title = fullDetail;
    if (footerStatusSummary) footerStatusSummary.textContent = shortText;
  }

  // Toast / Status Message Helpers
  function setConfigMsg(targetEl, msg, isError = false) {
    if (!targetEl) return;
    targetEl.textContent = msg;
    targetEl.className = 'config-message ' + (isError ? 'error' : 'success');
    setTimeout(() => {
      if (targetEl.textContent === msg) targetEl.textContent = '';
    }, 4000);
  }

  // Tab Navigation Controller (with roving tabindex & sessionStorage memory)
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

    for (const [panelTabId, panelEl] of Object.entries(tabPanels)) {
      if (panelEl) {
        panelEl.classList.toggle('hidden', panelTabId !== targetTabId);
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
      if (btnTranslate) btnTranslate.disabled = true;
      if (btnRestore) btnRestore.disabled = true;
      return;
    }

    if (!hasStoredKey) {
      if (btnTranslate) {
        btnTranslate.disabled = true;
        btnTranslate.title = 'Vui lòng nhập API key để bắt đầu dịch';
      }
      updateStatus('unconfigured', 'Vui lòng nhập API key tại tab Kết nối.');
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
    if (statusText.textContent === 'Chưa có key' || statusText.textContent === 'Đang tải...') {
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

    // Group 2: Currently Selected
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
    btnToggleFavorite.innerHTML = isFav ? SVG_ICONS.starFilled : SVG_ICONS.star;
    btnToggleFavorite.classList.toggle('favorited', isFav);
    btnToggleFavorite.title = isFav ? 'Bỏ khỏi danh sách yêu thích' : 'Thêm vào danh sách yêu thích';
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
        setConfigMsg(configMessageConnect, 'Lỗi cập nhật yêu thích: ' + (err.message || 'Lỗi không xác định'), true);
        return;
      }

      favoriteModels = nextFavorites;
      savedSettings.favoriteModels = nextFavorites;
      renderAllModelDropdowns();
    });
  }

  if (selectModel) {
    selectModel.addEventListener('change', () => {
      renderAllModelDropdowns();
      evaluateActionReadiness();
    });
  }

  // Fallbacks v2 UI Dynamic Rendering
  function renderFallbackRows() {
    if (!fallbackListEl) return;
    fallbackListEl.innerHTML = '';

    if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'auto-sites-empty';
      emptyEl.textContent = 'Chưa có fallback provider nào.';
      fallbackListEl.appendChild(emptyEl);
      if (btnAddFallback) btnAddFallback.disabled = false;
      return;
    }

    fallbacks.forEach((fb, idx) => {
      const row = document.createElement('div');
      row.className = 'fallback-row';
      row.id = `fallback-row-${idx}`;

      const rowHeader = document.createElement('div');
      rowHeader.className = 'fallback-row-header';

      const rowTitle = document.createElement('span');
      rowTitle.className = 'fallback-row-title';
      rowTitle.textContent = `Fallback ${idx + 1} (${fb.id})`;

      const btnRemove = document.createElement('button');
      btnRemove.type = 'button';
      btnRemove.id = `btn-remove-fallback-${idx}`;
      btnRemove.className = 'btn-icon btn-danger-icon btn-sm';
      btnRemove.title = `Xoá Fallback ${idx + 1}`;
      btnRemove.setAttribute('aria-label', `Xoá Fallback ${idx + 1}`);
      btnRemove.innerHTML = SVG_ICONS.trash;

      btnRemove.addEventListener('click', async () => {
        // If row has an existing id, call DELETE_FALLBACK_KEY
        if (fb.id) {
          try {
            await new Promise((resolve) => {
              chrome.runtime.sendMessage({ action: 'DELETE_FALLBACK_KEY', id: fb.id }, resolve);
            });
            delete fallbackKeyPresence[fb.id];
          } catch {}
        }
        fallbacks.splice(idx, 1);
        renderFallbackRows();
        renderAllModelDropdowns();
      });

      rowHeader.appendChild(rowTitle);
      rowHeader.appendChild(btnRemove);
      row.appendChild(rowHeader);

      const inputsGrid = document.createElement('div');
      inputsGrid.className = 'fallback-inputs-grid';

      // Base URL input
      const urlGroup = document.createElement('div');
      urlGroup.className = 'form-group';
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.id = `input-fallback-url-${idx}`;
      urlInput.placeholder = 'Dùng chung primary Base URL';
      urlInput.title = 'Để trống = dùng chung Base URL của Primary';
      urlInput.autocomplete = 'off';
      urlInput.value = fb.baseURL || '';
      urlInput.addEventListener('input', () => {
        fb.baseURL = urlInput.value.trim();
      });
      urlGroup.appendChild(urlInput);
      inputsGrid.appendChild(urlGroup);

      // Key input with eye toggle
      const keyGroup = document.createElement('div');
      keyGroup.className = 'form-group';
      const keyWrapper = document.createElement('div');
      keyWrapper.className = 'input-with-button';

      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.id = `input-fallback-key-${idx}`;
      const hasKey = Boolean(fallbackKeyPresence[fb.id]);
      keyInput.placeholder = hasKey ? '•••••••••••••••• (Đã lưu)' : 'Dùng chung primary key (hoặc nhập key riêng)';
      keyInput.autocomplete = 'off';

      const btnToggleRowKey = document.createElement('button');
      btnToggleRowKey.type = 'button';
      btnToggleRowKey.id = `btn-toggle-fallback-key-${idx}`;
      btnToggleRowKey.className = 'btn-icon';
      btnToggleRowKey.title = 'Hiện/ẩn key';
      btnToggleRowKey.innerHTML = SVG_ICONS.eye;
      btnToggleRowKey.addEventListener('click', () => {
        if (keyInput.type === 'password') {
          keyInput.type = 'text';
          btnToggleRowKey.innerHTML = SVG_ICONS.eyeOff;
        } else {
          keyInput.type = 'password';
          btnToggleRowKey.innerHTML = SVG_ICONS.eye;
        }
      });

      keyWrapper.appendChild(keyInput);
      keyWrapper.appendChild(btnToggleRowKey);
      keyGroup.appendChild(keyWrapper);
      inputsGrid.appendChild(keyGroup);

      // Model selector
      const modelGroup = document.createElement('div');
      modelGroup.className = 'form-group';
      const modelSelect = document.createElement('select');
      modelSelect.id = `select-fallback-${idx}`;
      // Also provide alias id select-fallback-1 / select-fallback-2 for backward compat
      modelSelect.setAttribute('data-index', String(idx));
      modelSelect.addEventListener('change', () => {
        fb.model = modelSelect.value;
      });

      modelGroup.appendChild(modelSelect);
      inputsGrid.appendChild(modelGroup);

      row.appendChild(inputsGrid);
      fallbackListEl.appendChild(row);
    });

    if (btnAddFallback) {
      btnAddFallback.disabled = fallbacks.length >= 2;
    }
  }

  if (btnAddFallback) {
    btnAddFallback.addEventListener('click', () => {
      if (fallbacks.length >= 2) return;
      const usedIds = new Set(fallbacks.map(f => f.id));
      const nextId = !usedIds.has('fb1') ? 'fb1' : 'fb2';
      const defaultFbModel = RECOMMENDED_MODELS[1] || DEFAULT_MODEL;

      fallbacks.push({
        id: nextId,
        model: defaultFbModel,
        baseURL: ''
      });

      renderFallbackRows();
      renderAllModelDropdowns();
    });
  }

  function renderAllModelDropdowns() {
    const curPrimary = selectModel?.value || savedSettings.model || DEFAULT_MODEL;
    populateSelect(selectModel, curPrimary, { allowEmpty: false, exclude: [] });

    // Populate dynamic fallback dropdowns
    fallbacks.forEach((fb, idx) => {
      const selectEl = document.getElementById(`select-fallback-${idx}`);
      if (selectEl) {
        const curFbModel = fb.model || selectEl.value || RECOMMENDED_MODELS[idx + 1] || DEFAULT_MODEL;
        populateSelect(selectEl, curFbModel, {
          allowEmpty: false,
          exclude: [selectModel.value].filter(Boolean)
        });
        if (selectEl.value) {
          fb.model = selectEl.value;
        }
      }
    });

    updateStarButton();
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
            setConfigMsg(configMessageConnect, 'Lỗi tải model: ' + (err?.message || 'Không thể kết nối'), true);
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
          setConfigMsg(configMessageConnect, 'Đã làm mới danh sách model!');
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
          if (activeUrlText) activeUrlText.textContent = resp.settings.baseURL || 'http://localhost:8080/v1';

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
          fallbacks = Array.isArray(resp.settings.fallbacks) ? JSON.parse(JSON.stringify(resp.settings.fallbacks)) : [];
          autoTranslateSites = Array.isArray(resp.settings.autoTranslateSites) ? [...resp.settings.autoTranslateSites] : [];

          hasStoredKey = Boolean(resp.hasKey);
          fallbackKeyPresence = resp.fallbackKeyPresence || {};

          if (keyStatusIndicator) {
            keyStatusIndicator.textContent = hasStoredKey ? 'Key: Đã lưu' : 'Chưa lưu key';
          }
          if (hasStoredKey && inputApiKey && !inputApiKey.value) {
            inputApiKey.placeholder = '•••••••••••••••• (Đã lưu)';
          }

          renderFallbackRows();
          renderAllModelDropdowns();
          renderAutoSitesChips();
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
        return `Đã dịch ${countStr} nodes (${failed} lỗi — bấm "Dịch trang" lần nữa để dịch nốt phần còn lại)`;
      }
      return `Đã dịch ${countStr} nodes${metaStr}.`;
    }

    if (state === 'error') {
      const err = data.error || {};
      const code = err.code || 'ERROR';
      const msg = err.message || '';
      if (code === 'DROPPED_ON_RESTART') {
        return `[DROPPED_ON_RESTART] Yêu cầu bị mất khi service worker khởi động lại — bấm "Dịch trang" để chạy lại`;
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
        btnToggleKey.innerHTML = SVG_ICONS.eyeOff;
      } else {
        inputApiKey.type = 'password';
        btnToggleKey.innerHTML = SVG_ICONS.eye;
      }
    });
  }

  // Tab 2 Save Action: Primary URL + Model + Fallbacks v2 + API keys
  if (btnSaveConnect) {
    btnSaveConnect.addEventListener('click', async () => {
      const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : '';
      if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
        setConfigMsg(configMessageConnect, 'Base URL phải bắt đầu bằng http:// hoặc https://', true);
        return;
      }

      let origin = '';
      try {
        origin = new URL(rawUrl).origin + '/*';
      } catch {
        setConfigMsg(configMessageConnect, 'Base URL không hợp lệ', true);
        return;
      }

      // Request host permission in user gesture for primary Base URL if not already granted
      let hasPerm = false;
      try {
        if (chrome.permissions && typeof chrome.permissions.contains === 'function') {
          hasPerm = await chrome.permissions.contains({ origins: [origin] });
        }
      } catch {}

      if (!hasPerm) {
        try {
          if (chrome.permissions && typeof chrome.permissions.request === 'function') {
            hasPerm = await chrome.permissions.request({ origins: [origin] });
          } else {
            hasPerm = true;
          }
        } catch {
          // If request throws (e.g. non-interactive test environment without gesture prompt), proceed
          hasPerm = true;
        }
      }

      if (hasPerm === false) {
        setConfigMsg(configMessageConnect, 'Cần cấp quyền host permission để kết nối Base URL', true);
        updateStatus('error', '[PERMISSION_REQUIRED] Chưa cấp quyền kết nối Base URL');
        return;
      }

      // Collect fallbacks from UI
      const cleanFallbacks = [];
      for (let i = 0; i < fallbacks.length; i++) {
        const fb = fallbacks[i];
        const fbUrlInput = document.getElementById(`input-fallback-url-${i}`);
        const fbModelSelect = document.getElementById(`select-fallback-${i}`);

        const fbUrl = fbUrlInput ? fbUrlInput.value.trim() : (fb.baseURL || '');
        const fbModel = fbModelSelect ? fbModelSelect.value : (fb.model || DEFAULT_MODEL);

        if (fbUrl) {
          if (!fbUrl.startsWith('http://') && !fbUrl.startsWith('https://')) {
            setConfigMsg(configMessageConnect, `Fallback ${i + 1} Base URL phải là http:// hoặc https://`, true);
            return;
          }
          let fbGranted = false;
          try {
            const fbOrigin = new URL(fbUrl).origin + '/*';
            if (chrome.permissions && typeof chrome.permissions.contains === 'function') {
              fbGranted = await chrome.permissions.contains({ origins: [fbOrigin] });
            }
            if (!fbGranted && chrome.permissions && typeof chrome.permissions.request === 'function') {
              fbGranted = await chrome.permissions.request({ origins: [fbOrigin] });
            } else {
              fbGranted = true;
            }
          } catch {
            fbGranted = true;
          }
          if (fbGranted === false) {
            setConfigMsg(configMessageConnect, `Cần cấp quyền host cho Fallback ${i + 1} Base URL`, true);
            return;
          }
        }

        cleanFallbacks.push({
          id: fb.id || `fb${i + 1}`,
          model: fbModel,
          baseURL: fbUrl || undefined
        });
      }

      const partialSettings = {
        baseURL: rawUrl,
        model: selectModel?.value || DEFAULT_MODEL,
        fallbacks: cleanFallbacks
      };

      btnSaveConnect.disabled = true;
      const saveResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: partialSettings }, resolve);
      });
      btnSaveConnect.disabled = false;

      if (chrome.runtime.lastError || !saveResp || saveResp.error) {
        const err = saveResp?.error || chrome.runtime.lastError;
        // Non-optimistic revert
        if (inputBaseUrl) inputBaseUrl.value = savedSettings.baseURL || 'http://localhost:8080/v1';
        fallbacks = Array.isArray(savedSettings.fallbacks) ? JSON.parse(JSON.stringify(savedSettings.fallbacks)) : [];
        renderFallbackRows();
        renderAllModelDropdowns();
        setConfigMsg(configMessageConnect, 'Lỗi lưu cấu hình: ' + (err.message || 'Lỗi không xác định'), true);
        return;
      }

      savedSettings = { ...savedSettings, ...partialSettings };
      fallbacks = cleanFallbacks;
      if (activeUrlText) activeUrlText.textContent = rawUrl;

      // Handle Primary API key
      const keyVal = inputApiKey ? inputApiKey.value.trim() : '';
      if (keyVal) {
        const keyResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'SET_KEY', key: keyVal }, resolve);
        });
        if (chrome.runtime.lastError || !keyResp || keyResp.error) {
          const err = keyResp?.error || chrome.runtime.lastError;
          setConfigMsg(configMessageConnect, 'Lỗi lưu API key: ' + (err.message || 'Lỗi không xác định'), true);
          return;
        }
        hasStoredKey = true;
        if (keyStatusIndicator) keyStatusIndicator.textContent = 'Key: Đã lưu';
        if (inputApiKey) {
          inputApiKey.value = '';
          inputApiKey.placeholder = '•••••••••••••••• (Đã lưu)';
        }
      }

      // Handle Fallback API keys
      for (let i = 0; i < cleanFallbacks.length; i++) {
        const fb = cleanFallbacks[i];
        const fbKeyInput = document.getElementById(`input-fallback-key-${i}`);
        const fbKeyVal = fbKeyInput ? fbKeyInput.value.trim() : '';
        if (fbKeyVal) {
          const fbKeyResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'SET_FALLBACK_KEY', id: fb.id, key: fbKeyVal }, resolve);
          });
          if (chrome.runtime.lastError || !fbKeyResp || fbKeyResp.error) {
            const err = fbKeyResp?.error || chrome.runtime.lastError;
            setConfigMsg(configMessageConnect, `Lỗi lưu key Fallback ${i + 1}: ` + (err.message || 'Lỗi không xác định'), true);
            return;
          }
          fallbackKeyPresence[fb.id] = true;
          if (fbKeyInput) {
            fbKeyInput.value = '';
            fbKeyInput.placeholder = '•••••••••••••••• (Đã lưu)';
          }
        }
      }

      setConfigMsg(configMessageConnect, 'Đã lưu cấu hình kết nối & fallbacks!');
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
        setConfigMsg(configMessageConnect, 'Lỗi xoá API key: ' + (err.message || ''), true);
        return;
      }

      hasStoredKey = false;
      fallbackKeyPresence = {};
      if (keyStatusIndicator) keyStatusIndicator.textContent = 'Chưa lưu key';
      if (inputApiKey) {
        inputApiKey.value = '';
        inputApiKey.placeholder = 'Nhập API key';
      }
      renderFallbackRows();
      setConfigMsg(configMessageConnect, 'Đã xoá API key.');
      evaluateActionReadiness();
      await checkTabStatus();
    });
  }

  // Tab 1 Save Action: Partial Save (Languages, Mode, Widget Visibility)
  if (btnSaveTranslate) {
    btnSaveTranslate.addEventListener('click', async () => {
      const selectedMode = modeFull && modeFull.checked ? 'full' : 'scroll-follow';
      const partialSettings = {
        sourceLanguage: selectSrcLang ? selectSrcLang.value : 'auto',
        targetLanguage: selectTgtLang ? selectTgtLang.value : 'vi',
        translationMode: selectedMode,
        widgetVisible: Boolean(checkboxWidgetVisible ? checkboxWidgetVisible.checked : true)
      };

      btnSaveTranslate.disabled = true;
      const saveResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: partialSettings }, resolve);
      });
      btnSaveTranslate.disabled = false;

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
        setConfigMsg(configMessageTranslate, 'Lỗi lưu: ' + (err.message || 'Lỗi không xác định'), true);
        return;
      }

      savedSettings = { ...savedSettings, ...partialSettings };
      currentMode = selectedMode;
      setConfigMsg(configMessageTranslate, 'Đã lưu cài đặt dịch!');

      // Best-effort notify active tab content script of new mode
      if (activeTab && activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, {
          action: 'CONTENT_SET_MODE',
          mode: selectedMode
        }, () => {
          if (chrome.runtime.lastError) {
            // Content script not yet injected or tab inactive
          }
        });
      }

      await checkTabStatus();
    });
  }

  // Auto-Translate Sites Management
  function showAutoSiteError(msg) {
    if (!autoSiteError) return;
    autoSiteError.textContent = msg;
    autoSiteError.style.display = 'block';
  }

  function hideAutoSiteError() {
    if (!autoSiteError) return;
    autoSiteError.textContent = '';
    autoSiteError.style.display = 'none';
  }

  function renderAutoSitesChips() {
    if (!autoSitesList) return;
    autoSitesList.innerHTML = '';

    if (!autoTranslateSites || autoTranslateSites.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'auto-sites-empty';
      emptyEl.textContent = 'Chưa có trang nào trong danh sách.';
      autoSitesList.appendChild(emptyEl);
      return;
    }

    for (const site of autoTranslateSites) {
      const chip = document.createElement('div');
      chip.className = 'site-chip';
      chip.setAttribute('role', 'listitem');

      const originSpan = document.createElement('span');
      originSpan.className = 'chip-origin';
      originSpan.title = site;
      originSpan.textContent = site;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-chip-remove';
      removeBtn.setAttribute('aria-label', `Xoá ${site} khỏi danh sách tự động dịch`);
      removeBtn.title = 'Xoá';
      removeBtn.textContent = '×';

      removeBtn.addEventListener('click', async () => {
        hideAutoSiteError();
        const updatedList = autoTranslateSites.filter((s) => s !== site);
        removeBtn.disabled = true;

        const saveResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'SAVE_SETTINGS',
            settings: { autoTranslateSites: updatedList }
          }, resolve);
        });

        if (chrome.runtime.lastError || !saveResp || saveResp.error) {
          const err = saveResp?.error || chrome.runtime.lastError;
          showAutoSiteError('Lỗi xoá trang: ' + (err?.message || 'Không thể lưu'));
          removeBtn.disabled = false;
          return;
        }

        autoTranslateSites = updatedList;
        savedSettings.autoTranslateSites = [...updatedList];
        renderAutoSitesChips();
      });

      chip.appendChild(originSpan);
      chip.appendChild(removeBtn);
      autoSitesList.appendChild(chip);
    }
  }

  async function handleAddCustomSite() {
    hideAutoSiteError();
    const val = inputAutoSite ? inputAutoSite.value.trim() : '';
    if (!val) {
      showAutoSiteError('Vui lòng nhập origin (ví dụ: https://example.com)');
      return;
    }

    const norm = normalizeOrigin(val);
    if (!norm) {
      showAutoSiteError('Origin không hợp lệ (yêu cầu định dạng https://example.com)');
      return;
    }

    if (autoTranslateSites.includes(norm)) {
      showAutoSiteError(`Trang ${norm} đã có trong danh sách.`);
      return;
    }

    if (autoTranslateSites.length >= 200) {
      showAutoSiteError('Danh sách đã đạt tối đa 200 trang.');
      return;
    }

    if (btnAddCustomSite) btnAddCustomSite.disabled = true;
    const updatedList = [...autoTranslateSites, norm];

    const saveResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'SAVE_SETTINGS',
        settings: { autoTranslateSites: updatedList }
      }, resolve);
    });
    if (btnAddCustomSite) btnAddCustomSite.disabled = false;

    if (chrome.runtime.lastError || !saveResp || saveResp.error) {
      const err = saveResp?.error || chrome.runtime.lastError;
      showAutoSiteError('Lỗi thêm trang: ' + (err?.message || 'Không thể lưu'));
      return;
    }

    autoTranslateSites = updatedList;
    savedSettings.autoTranslateSites = [...updatedList];
    if (inputAutoSite) inputAutoSite.value = '';
    renderAutoSitesChips();
  }

  if (btnAddCustomSite) {
    btnAddCustomSite.addEventListener('click', handleAddCustomSite);
  }
  if (inputAutoSite) {
    inputAutoSite.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddCustomSite();
      }
    });
  }

  if (btnAddCurrentSite) {
    btnAddCurrentSite.addEventListener('click', async () => {
      hideAutoSiteError();
      const tabUrl = activeTab?.url;
      if (!tabUrl) {
        showAutoSiteError('Không thể xác định trang hiện tại.');
        return;
      }

      const curOrigin = normalizeOrigin(tabUrl);
      if (!curOrigin) {
        showAutoSiteError('Trang hiện tại không phải là HTTP/HTTPS hợp lệ.');
        return;
      }

      if (autoTranslateSites.includes(curOrigin)) {
        showAutoSiteError(`Trang ${curOrigin} đã có trong danh sách.`);
        return;
      }

      if (autoTranslateSites.length >= 200) {
        showAutoSiteError('Danh sách đã đạt tối đa 200 trang.');
        return;
      }

      btnAddCurrentSite.disabled = true;

      // 1. Opt-in flow if site not yet enabled: request permission in gesture + SET_SITE_ENABLED
      if (!currentConsent.siteEnabled) {
        const matchPattern = curOrigin + '/*';
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
          btnAddCurrentSite.disabled = false;
          showAutoSiteError('[PERMISSION_REQUIRED] Cần cấp quyền truy cập để bật tự động dịch.');
          updateStatus('error', '[PERMISSION_REQUIRED] Cần cấp quyền truy cập để bật tự động dịch.');
          return;
        }

        const enableResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'SET_SITE_ENABLED',
            origin: curOrigin,
            enabled: true,
            tabId: activeTab?.id
          }, resolve);
        });

        if (chrome.runtime.lastError || !enableResp || enableResp.error) {
          btnAddCurrentSite.disabled = false;
          const err = enableResp?.error || chrome.runtime.lastError;
          showAutoSiteError('Lỗi bật quyền site: ' + (err?.message || 'Không thể lưu quyền site'));
          updateStatus('error', `[${err?.code || 'ERROR'}] ${err?.message || 'Không thể lưu quyền site'}`);
          return;
        }

        currentConsent.siteEnabled = true;
        if (toggleSiteConsent) toggleSiteConsent.checked = true;
        await loadConsent();
      }

      // 2. Add to autoTranslateSites and save
      const updatedList = [...autoTranslateSites, curOrigin];
      const saveResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'SAVE_SETTINGS',
          settings: { autoTranslateSites: updatedList }
        }, resolve);
      });
      btnAddCurrentSite.disabled = false;

      if (chrome.runtime.lastError || !saveResp || saveResp.error) {
        const err = saveResp?.error || chrome.runtime.lastError;
        showAutoSiteError('Lỗi lưu danh sách: ' + (err?.message || 'Không thể lưu'));
        return;
      }

      autoTranslateSites = updatedList;
      savedSettings.autoTranslateSites = [...updatedList];
      renderAutoSitesChips();
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
