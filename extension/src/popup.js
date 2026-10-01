// WebMCP Translator Kit — Popup Logic (Taste-Skill Redesign)
// Contract Version: webmcp-translator-contract/1

import { normalizeOrigin } from './consent.mjs';
import { normalizeBaseURLKey } from './settings.mjs';

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
  trash: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>',
  power: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>'
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
    'tab-auto': document.getElementById('tabpanel-auto'),
    'tab-connect': document.getElementById('tabpanel-connect')
  };

  // Tab 1 Elements ("Dịch")
  const selectSrcLang = document.getElementById('select-src-lang');
  const selectTgtLang = document.getElementById('select-tgt-lang');
  const siteOriginBadge = document.getElementById('site-origin-badge');
  const toggleSiteConsent = document.getElementById('toggle-site-consent');
  const btnOverrideInherit = document.getElementById('btn-override-inherit');
  const btnOverrideOn = document.getElementById('btn-override-on');
  const btnOverrideOff = document.getElementById('btn-override-off');
  const checkboxWidgetVisible = document.getElementById('checkbox-widget-visible');

  // Autosave indicator (header)
  const saveStateEl = document.getElementById('save-state');
  const saveDotEl = document.getElementById('save-dot');

  // Tab 2 Elements ("Tự động")
  const btnAddCurrentSite = document.getElementById('btn-add-current-site');
  const autoSiteError = document.getElementById('auto-site-error');
  const autoSitesList = document.getElementById('auto-sites-list');

  // Tab 3 Elements ("Kết nối")
  const inputBaseUrl = document.getElementById('input-base-url');
  const btnBasePerm = document.getElementById('btn-base-perm');
  const inputApiKey = document.getElementById('input-api-key');
  const btnToggleKey = document.getElementById('btn-toggle-key');
  const btnDeleteKey = document.getElementById('btn-delete-key');
  const keyStatusIndicator = document.getElementById('key-status-indicator');
  const selectModel = document.getElementById('select-model');
  const btnToggleFavorite = document.getElementById('btn-toggle-favorite');
  const btnRefreshModels = document.getElementById('btn-refresh-models');
  const btnAddFallback = document.getElementById('btn-add-fallback');
  const fallbackListEl = document.getElementById('fallback-list');
  const configMessageConnect = document.getElementById('config-message-connect');

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
  // Favorites are scoped per provider Base URL (normalized scheme/host,
  // preserved path+port; never keyed by API key). The map is the single
  // source of truth; the primary list is always read from its bucket.
  let favoriteModelsByBaseURL = {};
  let lastFavKey = null; // displayed primary scope; null = Base URL invalid
  let fallbacks = []; // Array of { id, model, baseURL?: string }
  let autoTranslateSites = [];
  let currentMode = 'scroll-follow';
  let activeTabNav = 'tab-translate';

  function currentFavKey() {
    return normalizeBaseURLKey(inputBaseUrl ? inputBaseUrl.value : (savedSettings.baseURL || ''));
  }

  function getFavoritesForKey(key) {
    const list = key ? favoriteModelsByBaseURL[key] : null;
    return Array.isArray(list) ? [...list] : [];
  }

  function primaryFavorites() {
    return getFavoritesForKey(lastFavKey);
  }

  function setFavoritesForKey(key, list) {
    favoriteModelsByBaseURL[key] = [...list].slice(0, 50);
  }

  // Base URL scope for a fallback row: its own Base URL, else the displayed primary.
  // Returns null when the effective URL is invalid (star disabled).
  function favKeyForFallback(fb) {
    const own = (fb && typeof fb.baseURL === 'string') ? fb.baseURL.trim() : '';
    return own ? normalizeBaseURLKey(own) : lastFavKey;
  }

  // Autosave state (no save buttons — every change persists to storage)
  let settingsLoaded = false;
  let autosaveTimer = null;
  let autosaveInFlight = false;
  let autosaveQueued = false;
  let favoriteWriteInFlight = false;
  let favoriteWriteQueue = Promise.resolve();
  const autosaveIdleWaiters = [];

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

  // UI Status Indicator (Single-line icon + text + tooltip).
  // Watching/translating states embed live applied/collected (+ failed) counts
  // in the visible footer text so progress is readable without tooltips.
  function updateStatus(state, detail = '', data = null) {
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
        shortText = '';
        fullDetail = detail || 'Sẵn sàng dịch trang hiện tại.';
        break;
      case 'translating':
        iconSvg = detail.includes('quota') ? SVG_ICONS.clock : SVG_ICONS.spinner;
        shortText = detail.includes('quota') ? detail : (detail || 'Đang dịch...');
        fullDetail = detail || 'Đang gửi batch dịch nội dung trang.';
        break;
      case 'watching': {
        iconSvg = SVG_ICONS.scroll;
        const wApplied = data && typeof data.totalApplied === 'number'
          ? Math.min(data.totalApplied, typeof data.totalCollected === 'number' ? data.totalCollected : data.totalApplied)
          : (data && typeof data.applied === 'number' ? data.applied : null);
        const wCollected = data && typeof data.totalCollected === 'number' ? data.totalCollected : null;
        const wFailed = data && typeof data.totalFailed === 'number' ? data.totalFailed : 0;
        shortText = (wApplied !== null && wCollected !== null && wCollected > 0)
          ? `Đang theo scroll ${wApplied}/${wCollected}`
          : 'Đang theo scroll';
        if (wFailed > 0) shortText += ` (${wFailed} lỗi)`;
        fullDetail = detail || 'Đang theo dõi và dịch tự động khi cuộn trang.';
        break;
      }
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
    // Footer slot mirrors live scroll progress (applied/collected + failed);
    // version string otherwise. Never shows a completed state while watching —
    // callers keep the watching branch ahead of the done branch.
    if (footerStatusSummary) {
      if (state === 'watching' && data && typeof data.totalCollected === 'number' && data.totalCollected > 0) {
        const fApplied = Math.min(data.totalApplied || 0, data.totalCollected);
        const fFailed = (typeof data.totalFailed === 'number' && data.totalFailed > 0) ? ` (${data.totalFailed} lỗi)` : '';
        footerStatusSummary.textContent = `v0.1.0 · ${fApplied}/${data.totalCollected}${fFailed}`;
      } else {
        footerStatusSummary.textContent = 'v0.1.0';
      }
    }
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

  // Promise wrapper for runtime messages
  function sendMsg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, resolve);
      } catch (err) {
        resolve({ error: { code: 'ERROR', message: String((err && err.message) || err) } });
      }
    });
  }

  // Autosave indicator state
  function setSaveState(state, title) {
    if (saveStateEl) {
      saveStateEl.dataset.state = state;
      if (title) saveStateEl.title = title;
      else if (state === 'saved') saveStateEl.title = 'Mọi thay đổi đã được lưu tự động';
      else if (state === 'saving') saveStateEl.title = 'Đang lưu...';
      else if (state === 'error') saveStateEl.title = 'Lưu thất bại — xem chi tiết lỗi bên dưới';
      else saveStateEl.title = 'Mọi thay đổi được lưu tự động';
    }
  }

  // Collect fallback rows from UI (no permission requests here — autosave has
  // no user gesture; host permissions are granted via explicit buttons/Dịch)
  function collectCleanFallbacks() {
    const out = [];
    for (let i = 0; i < fallbacks.length; i++) {
      const fb = fallbacks[i];
      const fbUrlInput = document.getElementById(`input-fallback-url-${i}`);
      const fbModelSelect = document.getElementById(`select-fallback-${i}`);
      const fbUrl = fbUrlInput ? fbUrlInput.value.trim() : (fb.baseURL || '');
      const fbModel = fbModelSelect ? fbModelSelect.value : (fb.model || DEFAULT_MODEL);
      if (fbUrl && !/^https?:\/\/.+/i.test(fbUrl)) {
        return { fallbacks: null, error: `Fallback ${i + 1} Base URL phải là http:// hoặc https://` };
      }
      out.push({ id: fb.id || `fb${i + 1}`, model: fbModel, baseURL: fbUrl || undefined });
    }
    return { fallbacks: out, error: null };
  }

  function collectSettingsPatch() {
    const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : '';
    if (rawUrl && !/^https?:\/\/.+/i.test(rawUrl)) {
      return { patch: null, error: 'Base URL phải bắt đầu bằng http:// hoặc https://' };
    }
    const fbRes = collectCleanFallbacks();
    if (fbRes.error) return { patch: null, error: fbRes.error };
    // Favorites are saved only by their star controls. A full form patch must
    // not echo a stale popup map over changes made in another open popup.
    const patch = {
      sourceLanguage: selectSrcLang ? selectSrcLang.value : 'auto',
      targetLanguage: selectTgtLang ? selectTgtLang.value : 'vi',
      widgetVisible: checkboxWidgetVisible ? Boolean(checkboxWidgetVisible.checked) : true,
      model: selectModel && selectModel.value ? selectModel.value : (savedSettings.model || DEFAULT_MODEL),
      fallbacks: fbRes.fallbacks,
      autoTranslateSites: JSON.parse(JSON.stringify(autoTranslateSites))
    };
    if (rawUrl) patch.baseURL = rawUrl;
    return { patch, error: null };
  }

  // Autosave: persist every UI change to storage (debounced for typing).
  // Host permission requests NEVER happen here (no gesture) — they live in
  // explicit buttons (site toggle, + Trang này, base shield, Dịch).
  const SETTINGS_NOT_LOADED_MSG = 'Cấu hình chưa tải xong — đợi giây lát rồi thử lại (không ghi gì để tránh mất cấu hình cũ)';

  function waitForAutosaveIdle() {
    if (!autosaveInFlight) return Promise.resolve();
    return new Promise(resolve => autosaveIdleWaiters.push(resolve));
  }

  function notifyAutosaveIdleWaiters() {
    if (autosaveInFlight) return;
    autosaveIdleWaiters.splice(0).forEach(resolve => resolve());
  }

  function saveFavoriteToggle(scopeKey, model) {
    const operation = favoriteWriteQueue.then(async () => {
      if (!settingsLoaded) throw new Error(SETTINGS_NOT_LOADED_MSG);

      let saveFormAfter = Boolean(autosaveTimer);
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      await waitForAutosaveIdle();
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
        saveFormAfter = true;
      }

      favoriteWriteInFlight = true;
      const previousMap = JSON.parse(JSON.stringify(favoriteModelsByBaseURL));
      const isPrimaryScope = scopeKey === lastFavKey;
      const bucket = Array.isArray(previousMap[scopeKey]) ? previousMap[scopeKey] : [];
      const nextFavorites = bucket.includes(model)
        ? bucket.filter(id => id !== model)
        : [...bucket, model].slice(0, 50);
      const nextMap = { ...previousMap, [scopeKey]: nextFavorites };

      // Publish the new map before any async save/queued autosave can snapshot it.
      favoriteModelsByBaseURL = nextMap;
      savedSettings.favoriteModelsByBaseURL = JSON.parse(JSON.stringify(nextMap));
      savedSettings.favoriteModels = primaryFavorites();

      try {
        const settings = { favoriteModelsByBaseURL: nextMap };
        if (isPrimaryScope) settings.favoriteModels = nextFavorites;
        const response = await new Promise(resolve => {
          try {
            chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings }, value => {
              const lastError = chrome.runtime.lastError;
              resolve(lastError ? { error: { message: lastError.message } } : value);
            });
          } catch (err) {
            resolve({ error: { message: String((err && err.message) || err) } });
          }
        });
        if (!response || response.error) {
          throw new Error(response?.error?.message || 'Không thể lưu danh sách yêu thích');
        }
        return nextFavorites;
      } catch (err) {
        favoriteModelsByBaseURL = previousMap;
        savedSettings.favoriteModelsByBaseURL = JSON.parse(JSON.stringify(previousMap));
        savedSettings.favoriteModels = primaryFavorites();
        throw err;
      } finally {
        favoriteWriteInFlight = false;
        if (saveFormAfter) autosaveQueued = true;
        if (autosaveQueued) {
          autosaveQueued = false;
          flushAutosave();
        }
      }
    });
    favoriteWriteQueue = operation.catch(() => {});
    return operation;
  }

  async function flushAutosave() {
    if (!settingsLoaded) return;
    if (favoriteWriteInFlight) {
      autosaveQueued = true;
      return;
    }
    if (autosaveInFlight) {
      autosaveQueued = true;
      return;
    }
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    autosaveInFlight = true;
    setSaveState('saving');
    try {
      const { patch, error } = collectSettingsPatch();
      if (error) {
        setSaveState('error', error);
        setConfigMsg(configMessageConnect, error, true);
        return;
      }
      const saveResp = await sendMsg({ action: 'SAVE_SETTINGS', settings: patch });
      if (chrome.runtime.lastError || !saveResp || saveResp.error) {
        const err = (saveResp && saveResp.error) || chrome.runtime.lastError || {};
        throw new Error((err && err.message) || 'Không thể lưu cấu hình');
      }
      savedSettings = { ...savedSettings, ...patch };
      fallbacks = JSON.parse(JSON.stringify(patch.fallbacks));

      // Primary API key (saved on change/blur, then masked)
      const keyVal = inputApiKey ? inputApiKey.value.trim() : '';
      if (keyVal) {
        const keyResp = await sendMsg({ action: 'SET_KEY', key: keyVal });
        if (chrome.runtime.lastError || !keyResp || keyResp.error) {
          const err = (keyResp && keyResp.error) || chrome.runtime.lastError || {};
          throw new Error('Lỗi lưu API key: ' + ((err && err.message) || 'Lỗi không xác định'));
        }
        hasStoredKey = true;
        if (keyStatusIndicator) keyStatusIndicator.textContent = 'Key: Đã lưu';
        if (inputApiKey) {
          inputApiKey.value = '';
          inputApiKey.placeholder = '•••••••••••••••• (Đã lưu)';
        }
      }

      // Fallback API keys (saved on change, then masked)
      for (let i = 0; i < fallbacks.length; i++) {
        const fb = fallbacks[i];
        const fbKeyInput = document.getElementById(`input-fallback-key-${i}`);
        const fbKeyVal = fbKeyInput ? fbKeyInput.value.trim() : '';
        if (fbKeyVal) {
          const fbKeyResp = await sendMsg({ action: 'SET_FALLBACK_KEY', id: fb.id, key: fbKeyVal });
          if (chrome.runtime.lastError || !fbKeyResp || fbKeyResp.error) {
            const err = (fbKeyResp && fbKeyResp.error) || chrome.runtime.lastError || {};
            throw new Error(`Lỗi lưu key Fallback ${i + 1}: ` + ((err && err.message) || 'Lỗi không xác định'));
          }
          fallbackKeyPresence[fb.id] = true;
          if (fbKeyInput) {
            fbKeyInput.value = '';
            fbKeyInput.placeholder = '•••••••••••••••• (Đã lưu)';
          }
        }
      }

      setSaveState('saved');
      evaluateActionReadiness();
      if (inputBaseUrl) refreshBasePermState();
    } catch (err) {
      const msg = (err && err.message) || 'Không thể lưu cấu hình';
      setSaveState('error', msg);
      setConfigMsg(configMessageConnect, msg, true);
    } finally {
      autosaveInFlight = false;
      if (autosaveQueued && !favoriteWriteInFlight) {
        autosaveQueued = false;
        flushAutosave();
      }
      notifyAutosaveIdleWaiters();
    }
  }

  function markDirty() {
    if (!settingsLoaded) return;
    setSaveState('saving');
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      flushAutosave();
    }, 600);
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
      if (typeof window !== 'undefined' && window.__testActiveTab) {
        activeTab = window.__testActiveTab;
        return true;
      }
      let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        const allHttpTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        const activeHttp = allHttpTabs.find((t) => t.active) || allHttpTabs[0];
        if (activeHttp) {
          tab = activeHttp;
        }
      }
      activeTab = tab;
      if (!tab || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
        if (btnTranslate) btnTranslate.disabled = true;
        if (btnRestore) btnRestore.disabled = true;
        updateStatus('unsupported', 'Trang hệ thống Chrome hoặc URL không phải HTTP(S) không hỗ trợ dịch.');
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

  if (typeof window !== 'undefined') {
    window.__setTestActiveTab = async (tab) => {
      activeTab = tab;
      await loadConsent();
      checkTabStatus();
      evaluateActionReadiness();
    };
  }

  // Dịch button busy state (spinner while a run is in flight; cleared
  // whenever the button becomes enabled again or an early return hits)
  function setTranslateBusy(busy) {
    if (!btnTranslate) return;
    btnTranslate.classList.toggle('is-loading', Boolean(busy));
  }

  // Action Readiness Evaluation
  function evaluateActionReadiness(restorableCount = 0) {
    if (!activeTab || !activeTab.id || !activeTab.url || (!activeTab.url.startsWith('http://') && !activeTab.url.startsWith('https://'))) {
      if (btnTranslate) btnTranslate.disabled = true;
      if (btnRestore) btnRestore.disabled = true;
      setTranslateBusy(false);
      return;
    }

    if (!hasStoredKey) {
      if (btnTranslate) {
        btnTranslate.disabled = true;
        btnTranslate.title = 'Vui lòng nhập API key để bắt đầu dịch';
      }
      setTranslateBusy(false);
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
      setTranslateBusy(false);
      updateStatus('error', 'Chưa chọn model hợp lệ. Vui lòng chọn model hoặc làm mới danh sách.');
      if (btnRestore) btnRestore.disabled = restorableCount === 0;
      return;
    }

    if (btnTranslate) {
      btnTranslate.disabled = false;
      btnTranslate.title = 'Dịch trang này';
      setTranslateBusy(false);
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
      if (siteOriginBadge) { siteOriginBadge.textContent = '--'; siteOriginBadge.classList.add('unsupported'); }
      return null;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GET_CONSENT', tabId: activeTab.id }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          if (resp && resp.error && resp.error.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          if (siteOriginBadge) { siteOriginBadge.textContent = '--'; siteOriginBadge.classList.add('unsupported'); }
          resolve(null);
          return;
        }

        currentConsent = resp;
        if (siteOriginBadge) { siteOriginBadge.textContent = resp.siteOrigin || '--'; siteOriginBadge.classList.remove('unsupported'); }
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

  // Model Dropdown Builder (favorites group is Base URL scoped via `favs`)
  function populateSelect(selectEl, selectedVal, { allowEmpty = false, emptyLabel = '-- Không chọn --', exclude = [], favs = null } = {}) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    const scopeFavs = Array.isArray(favs) ? favs : primaryFavorites();

    if (allowEmpty) {
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = emptyLabel;
      selectEl.appendChild(emptyOpt);
    }

    const added = new Set(exclude);

    // Group 1: Favorites (Base URL scoped)
    const validFavs = scopeFavs.filter(id => !added.has(id));
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
      curGroup.label = 'Đã lưu ★';
      const opt = document.createElement('option');
      opt.value = selectedVal;
      opt.textContent = selectedVal;
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
    const isFav = primaryFavorites().includes(curVal);
    btnToggleFavorite.innerHTML = isFav ? SVG_ICONS.starFilled : SVG_ICONS.star;
    btnToggleFavorite.classList.toggle('favorited', isFav);
    btnToggleFavorite.disabled = !lastFavKey;
    btnToggleFavorite.title = !lastFavKey
      ? 'Nhập Base URL hợp lệ (http/https) để dùng yêu thích'
      : (isFav ? 'Bỏ khỏi danh sách yêu thích' : 'Thêm vào danh sách yêu thích');
  }

  // Fallback row star reflects the row's own Base URL scope (own URL else primary)
  function updateFallbackStar(btn, fb, modelSelect) {
    if (!btn) return;
    const scopeKey = favKeyForFallback(fb);
    const bucket = getFavoritesForKey(scopeKey);
    const curVal = (modelSelect && modelSelect.value) || (fb && fb.model) || '';
    const isFav = curVal ? bucket.includes(curVal) : false;
    btn.innerHTML = isFav ? SVG_ICONS.starFilled : SVG_ICONS.star;
    btn.classList.toggle('favorited', isFav);
    btn.disabled = !scopeKey;
    btn.title = !scopeKey
      ? 'Nhập Base URL hợp lệ (http/https) để dùng yêu thích'
      : (isFav ? 'Bỏ khỏi danh sách yêu thích' : 'Thêm vào danh sách yêu thích');
  }

  // Favorite Star Toggle Action (Sends partial SAVE_SETTINGS)
  if (btnToggleFavorite) {
    btnToggleFavorite.addEventListener('click', async () => {
      const curVal = selectModel?.value;
      if (!curVal) return;
      if (!settingsLoaded) {
        setConfigMsg(configMessageConnect, SETTINGS_NOT_LOADED_MSG, true);
        return;
      }

      const scopeKey = lastFavKey;
      if (!scopeKey) return;
      btnToggleFavorite.disabled = true;
      try {
        await saveFavoriteToggle(scopeKey, curVal);
        renderAllModelDropdowns();
        setConfigMsg(configMessageConnect, 'Đã lưu danh sách yêu thích.');
      } catch (err) {
        renderAllModelDropdowns();
        setConfigMsg(configMessageConnect, 'Lỗi cập nhật yêu thích: ' + ((err && err.message) || 'Lỗi không xác định'), true);
      } finally {
        btnToggleFavorite.disabled = !lastFavKey;
      }
    });
  }

  if (selectModel) {
    selectModel.addEventListener('change', () => {
      renderAllModelDropdowns();
      evaluateActionReadiness();
      markDirty();
    });
  }

  // Fallbacks v2 UI Dynamic Rendering
  function renderFallbackRows() {
    if (!fallbackListEl) return;
    fallbackListEl.innerHTML = '';

    if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'auto-sites-empty';
      emptyEl.textContent = 'Chưa có dự phòng nào.';
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
        if (!settingsLoaded) {
          setConfigMsg(configMessageConnect, SETTINGS_NOT_LOADED_MSG, true);
          return;
        }
        fallbacks.splice(idx, 1);
        renderFallbackRows();
        renderAllModelDropdowns();
        flushAutosave();
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
        updateFallbackStar(document.getElementById(`btn-fallback-fav-${idx}`), fb, document.getElementById(`select-fallback-${idx}`));
        markDirty();
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
      keyInput.addEventListener('change', () => {
        markDirty();
      });

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

      // Model selector + per-provider favorite star (scoped to this row's
      // Base URL, else primary — same scope rule as favKeyForFallback)
      const modelGroup = document.createElement('div');
      modelGroup.className = 'form-group';
      const modelWrap = document.createElement('div');
      modelWrap.className = 'input-with-button';
      const modelSelect = document.createElement('select');
      modelSelect.id = `select-fallback-${idx}`;
      // Also provide alias id select-fallback-1 / select-fallback-2 for backward compat
      modelSelect.setAttribute('data-index', String(idx));
      modelSelect.setAttribute('aria-label', `Model dự phòng ${idx + 1}`);
      modelSelect.addEventListener('change', () => {
        fb.model = modelSelect.value;
        updateFallbackStar(btnFallbackFav, fb, modelSelect);
        markDirty();
      });

      const btnFallbackFav = document.createElement('button');
      btnFallbackFav.type = 'button';
      btnFallbackFav.id = `btn-fallback-fav-${idx}`;
      btnFallbackFav.className = 'btn-icon btn-star';
      btnFallbackFav.title = 'Thêm/bỏ yêu thích model dự phòng này';
      btnFallbackFav.setAttribute('aria-label', `Thêm hoặc bỏ model dự phòng ${idx + 1} khỏi danh sách yêu thích`);
      btnFallbackFav.innerHTML = SVG_ICONS.star;
      btnFallbackFav.addEventListener('click', async () => {
        if (!settingsLoaded) {
          setConfigMsg(configMessageConnect, SETTINGS_NOT_LOADED_MSG, true);
          return;
        }
        const curModel = modelSelect.value || fb.model;
        if (!curModel) return;
        const scopeKey = favKeyForFallback({ baseURL: (document.getElementById(`input-fallback-url-${idx}`)?.value || fb.baseURL || '') });
        if (!scopeKey) return;
        btnFallbackFav.disabled = true;
        try {
          await saveFavoriteToggle(scopeKey, curModel);
          renderAllModelDropdowns();
          setConfigMsg(configMessageConnect, 'Đã lưu danh sách yêu thích.');
        } catch (err) {
          renderAllModelDropdowns();
          setConfigMsg(configMessageConnect, 'Lỗi cập nhật yêu thích: ' + ((err && err.message) || 'Không thể lưu'), true);
        } finally {
          btnFallbackFav.disabled = !favKeyForFallback({ baseURL: (document.getElementById(`input-fallback-url-${idx}`)?.value || fb.baseURL || '') });
        }
      });

      modelWrap.appendChild(modelSelect);
      modelWrap.appendChild(btnFallbackFav);
      modelGroup.appendChild(modelWrap);
      inputsGrid.appendChild(modelGroup);

      row.appendChild(inputsGrid);
      fallbackListEl.appendChild(row);
      updateFallbackStar(btnFallbackFav, fb, modelSelect);
    });

    if (btnAddFallback) {
      btnAddFallback.disabled = fallbacks.length >= 2;
    }
  }

  if (btnAddFallback) {
    btnAddFallback.addEventListener('click', () => {
      if (fallbacks.length >= 2) return;
      if (!settingsLoaded) {
        setConfigMsg(configMessageConnect, SETTINGS_NOT_LOADED_MSG, true);
        return;
      }
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
      flushAutosave();
    });
  }

  function renderAllModelDropdowns() {
    const curPrimary = selectModel?.value || savedSettings.model || DEFAULT_MODEL;
    populateSelect(selectModel, curPrimary, { allowEmpty: false, exclude: [] });

    // Populate dynamic fallback dropdowns (favorites scoped per row URL)
    fallbacks.forEach((fb, idx) => {
      const selectEl = document.getElementById(`select-fallback-${idx}`);
      if (selectEl) {
        const curFbModel = fb.model || selectEl.value || RECOMMENDED_MODELS[idx + 1] || DEFAULT_MODEL;
        populateSelect(selectEl, curFbModel, {
          allowEmpty: false,
          exclude: [selectModel.value].filter(Boolean),
          favs: getFavoritesForKey(favKeyForFallback(fb))
        });
        if (selectEl.value) {
          fb.model = selectEl.value;
        }
        updateFallbackStar(document.getElementById(`btn-fallback-fav-${idx}`), fb, selectEl);
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
      // Host permission needs a user gesture — ensure it here before fetch.
      const perm = await ensureBaseUrlPermission();
      if (!perm.ok) {
        setConfigMsg(configMessageConnect, perm.reason === 'invalid' ? 'Base URL không hợp lệ' : 'Cần cấp quyền host permission để kết nối Base URL', true);
        updateStatus('error', '[PERMISSION_REQUIRED] Chưa cấp quyền kết nối Base URL');
        return;
      }
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
        if (chrome.runtime.lastError || !resp || resp.error) {
          const err = (resp && resp.error) || chrome.runtime.lastError || {};
          if (err.code === 'KEY_ACCESS_UNAVAILABLE') {
            showKeyAccessBanner();
          }
          updateStatus('error', `[${err.code || 'ERROR'}] ${err.message || 'Không tải được cấu hình'}`);
          resolve(false);
          return;
        }
        if (resp && resp.settings) {
          savedSettings = { ...resp.settings };
          if (inputBaseUrl) inputBaseUrl.value = resp.settings.baseURL || 'http://localhost:8080/v1';

          if (selectSrcLang && resp.settings.sourceLanguage) selectSrcLang.value = resp.settings.sourceLanguage;
          if (selectTgtLang && resp.settings.targetLanguage) selectTgtLang.value = resp.settings.targetLanguage;

          if (resp.settings.translationMode) {
            currentMode = resp.settings.translationMode;
          }

          if (checkboxWidgetVisible && typeof resp.settings.widgetVisible === 'boolean') {
            checkboxWidgetVisible.checked = resp.settings.widgetVisible;
          }

          favoriteModelsByBaseURL = (resp.settings.favoriteModelsByBaseURL && typeof resp.settings.favoriteModelsByBaseURL === 'object' && !Array.isArray(resp.settings.favoriteModelsByBaseURL))
            ? JSON.parse(JSON.stringify(resp.settings.favoriteModelsByBaseURL))
            : {};
          lastFavKey = normalizeBaseURLKey(resp.settings.baseURL || '');
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

          try { renderFallbackRows(); } catch (e) { try { console.error('[popup] renderFallbackRows failed:', e && e.message); } catch {} }
          try { renderAllModelDropdowns(); } catch (e) { try { console.error('[popup] renderAllModelDropdowns failed:', e && e.message); } catch {} }
          try { renderAutoSites(); } catch (e) { try { console.error('[popup] renderAutoSites failed:', e && e.message); } catch {} }
          resolve(true);
          return;
        }
        updateStatus('error', '[ERROR] Không tải được cấu hình đã lưu');
        resolve(false);
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
      const effApplied = typeof data.totalCollected === 'number'
        ? Math.min(data.totalApplied || 0, data.totalCollected)
        : (data.totalApplied || data.applied || 0);
      const countStr = typeof data.totalCollected === 'number'
        ? `${effApplied}/${data.totalCollected}`
        : `${effApplied}`;
      const failed = typeof data.totalFailed === 'number' ? data.totalFailed : 0;
      const failStr = failed > 0 ? ` (${failed} lỗi)` : '';
      const errSuffix = data.lastError && data.lastError.code ? ` — lỗi gần nhất: [${data.lastError.code}] đang thử lại` : '';
      return `Đang theo dõi cuộn trang (${countStr} nodes đã dịch${failStr})${metaStr}.${errSuffix}`;
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
        // Scroll batches that only fail must surface the provider error
        // instead of pretending to watch forever. Keep polling (no
        // stopPolling) so a later recovery updates the strip.
        if (st.lastError && (st.totalFailed || 0) > 0 && (st.totalApplied || 0) === 0) {
          if (st.watching === false) stopPolling(); else startPolling();
          updateStatus('error', formatDetail('error', {
            error: st.lastError,
            elapsedMs: st.elapsedMs,
            model: st.model,
            actualModel: st.actualModel,
            fallbackIndex: st.fallbackIndex
          }));
          evaluateActionReadiness(resp.restorableCount || 0);
        } else if (st.watching === true || (st.watching !== false && st.mode === 'scroll-follow' && (st.state === 'translating' || st.state === 'done'))) {
          // Still watching (even with state done for the current viewport):
          // keep polling so the footer refreshes live and reopen recovers.
          startPolling();
          updateStatus('watching', formatDetail('watching', { ...st, lastError: st.lastError }), st);
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
              const tApplied = (typeof st.totalCollected === 'number' && (st.totalApplied || 0) > st.totalCollected)
                ? st.totalCollected
                : (st.totalApplied || 0);
              const progressDetail = (typeof st.totalCollected === 'number' && st.totalCollected > 0)
                ? `Đang dịch ${tApplied}/${st.totalCollected} nodes...`
                : 'Đang dịch...';
              const retrySuffix = st.lastError && st.lastError.code ? ` (lỗi gần nhất: [${st.lastError.code}] đang thử lại)` : '';
              updateStatus('translating', progressDetail + retrySuffix);
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

  // Connect tab: autosave (no save button). Typing/changing any field persists
  // to storage automatically. Host permission needs a user gesture, so it is
  // granted via the shield button or at Dịch time — never inside autosave.
  if (inputBaseUrl) {
    inputBaseUrl.addEventListener('input', () => {
      markDirty();
    });
    inputBaseUrl.addEventListener('change', () => {
      // Switching Base URL only swaps which map bucket is displayed.
      try {
        const nextKey = currentFavKey();
        if (nextKey !== lastFavKey) {
          lastFavKey = nextKey;
          savedSettings.favoriteModels = primaryFavorites();
          renderAllModelDropdowns();
          evaluateActionReadiness();
        }
      } catch {}
      refreshBasePermState();
    });
  }

  if (inputApiKey) {
    inputApiKey.addEventListener('change', () => {
      markDirty();
    });
  }

  async function getBaseOrigin() {
    const rawUrl = inputBaseUrl ? inputBaseUrl.value.trim() : (savedSettings.baseURL || '');
    if (!rawUrl) return null;
    try {
      return new URL(rawUrl).origin;
    } catch {
      return null;
    }
  }

  // SW fetch to Base URL needs its host permission; request it inside a user
  // gesture (autosave/refresh-without-gesture cannot). Shared by Dịch,
  // refresh-models and the shield button.
  async function ensureBaseUrlPermission() {
    const origin = await getBaseOrigin();
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
    await refreshBasePermState();
    return granted ? { ok: true } : { ok: false, reason: 'denied' };
  }

  async function refreshBasePermState() {
    if (!btnBasePerm) return;
    const origin = await getBaseOrigin();
    let granted = false;
    if (origin && chrome.permissions && typeof chrome.permissions.contains === 'function') {
      try {
        granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
      } catch {}
    }
    btnBasePerm.classList.toggle('granted', granted);
    btnBasePerm.title = granted
      ? `Đã cấp quyền kết nối (${origin})`
      : `Cấp quyền kết nối Base URL (${origin || 'URL chưa hợp lệ'})`;
    btnBasePerm.setAttribute('aria-label', btnBasePerm.title);
  }

  if (btnBasePerm) {
    btnBasePerm.addEventListener('click', async () => {
      const origin = await getBaseOrigin();
      if (!origin) {
        setConfigMsg(configMessageConnect, 'Base URL không hợp lệ', true);
        return;
      }
      let granted = false;
      try {
        if (chrome.permissions && typeof chrome.permissions.request === 'function') {
          granted = await chrome.permissions.request({ origins: [origin + '/*'] });
        } else {
          granted = true;
        }
      } catch {
        granted = false;
      }
      if (!granted) {
        setConfigMsg(configMessageConnect, 'Cần cấp quyền host permission để kết nối Base URL', true);
        updateStatus('error', '[PERMISSION_REQUIRED] Chưa cấp quyền kết nối Base URL');
      }
      await refreshBasePermState();
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

  // Tab 1: autosave (no save button). Language + widget changes persist
  // immediately; failures revert to last saved values.
  if (selectSrcLang) {
    selectSrcLang.addEventListener('change', () => {
      markDirty();
    });
  }
  if (selectTgtLang) {
    selectTgtLang.addEventListener('change', () => {
      markDirty();
    });
  }
  if (checkboxWidgetVisible) {
    checkboxWidgetVisible.addEventListener('change', () => {
      markDirty();
    });
  }


  // Tab 2 Auto-Translate Sites Management
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

  // Shared: grant host permission + enable site consent for an origin.
  // Must run inside a user gesture (button click). Adding an origin to the
  // auto list alone is NOT enough — the auto-start gate also requires site
  // consent + host permission, otherwise auto-translate silently does nothing.
  async function enableSiteForOrigin(origin) {
    let granted = false;
    try {
      if (chrome.permissions && typeof chrome.permissions.contains === 'function') {
        granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
      }
      if (!granted && chrome.permissions && typeof chrome.permissions.request === 'function') {
        granted = await chrome.permissions.request({ origins: [origin + '/*'] });
      } else if (!chrome.permissions) {
        granted = true;
      }
    } catch {
      granted = false;
    }
    if (!granted) return { ok: false, reason: 'permission' };
    const resp = await sendMsg({ action: 'SET_SITE_ENABLED', origin, enabled: true });
    if (chrome.runtime.lastError || !resp || resp.error) {
      return { ok: false, reason: 'save', error: (resp && resp.error) || chrome.runtime.lastError };
    }
    return { ok: true };
  }

  // Per-row status dots: green = permission granted + autoStart on (auto will
  // run); amber = in list but missing permission/consent (auto silent);
  // grey = autoStart off.
  async function refreshSiteDots() {
    if (!autoSitesList) return;
    const cards = autoSitesList.querySelectorAll('.auto-site-card');
    for (const card of cards) {
      const origin = card.dataset ? card.dataset.origin : null;
      const dot = card.querySelector('.site-dot');
      const powerBtn = card.querySelector('.btn-site-enable');
      if (!dot || !origin) continue;
      let granted = false;
      try {
        if (chrome.permissions && typeof chrome.permissions.contains === 'function') {
          granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
        }
      } catch {}
      const site = autoTranslateSites.find((s) => (s.origin || s) === origin);
      const autoOn = site && site.autoStart !== false;
      const state = !autoOn ? 'off' : (granted ? 'on' : 'standby');
      dot.dataset.state = state;
      dot.title = state === 'on'
        ? `${origin}: sẽ tự dịch khi mở trang`
        : state === 'standby'
          ? `${origin}: chưa cấp quyền/bật dịch — bấm nút nguồn để bật`
          : `${origin}: đã tắt tự dịch`;
      if (powerBtn) {
        powerBtn.classList.toggle('enabled', granted);
        powerBtn.title = granted ? `Đã bật dịch cho ${origin}` : `Bật dịch cho ${origin}`;
      }
    }
  }

  function renderAutoSites() {
    if (!autoSitesList) return;
    autoSitesList.innerHTML = '';

    if (!autoTranslateSites || autoTranslateSites.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'auto-sites-empty';
      emptyEl.textContent = 'Chưa có trang nào trong danh sách.';
      autoSitesList.appendChild(emptyEl);
      return;
    }

    autoTranslateSites.forEach((siteObj, idx) => {
      const site = typeof siteObj === 'string'
        ? { origin: siteObj, mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null }
        : siteObj;

      const card = document.createElement('div');
      card.className = 'auto-site-card';
      card.setAttribute('role', 'listitem');
      card.dataset.origin = site.origin;

      // Row 1: Status dot + origin + controls (enable, mode, autostart, delete)
      const mainRow = document.createElement('div');
      mainRow.className = 'auto-site-row-main';

      const statusDot = document.createElement('span');
      statusDot.className = 'site-dot';
      statusDot.dataset.state = 'off';
      statusDot.title = 'Đang kiểm tra quyền...';
      statusDot.setAttribute('aria-hidden', 'true');

      const originSpan = document.createElement('span');
      originSpan.className = 'chip-origin';
      originSpan.title = site.origin;
      originSpan.textContent = site.origin;

      const controlsDiv = document.createElement('div');
      controlsDiv.className = 'auto-site-controls';

      // Enable button: grants host permission + enables site consent in one
      // gesture (required for auto-translate gate: list alone is not enough)
      const enableBtn = document.createElement('button');
      enableBtn.type = 'button';
      enableBtn.className = 'btn-icon btn-sm btn-site-enable';
      enableBtn.id = `btn-enable-site-${idx}`;
      enableBtn.title = `Bật dịch cho ${site.origin}`;
      enableBtn.setAttribute('aria-label', `Bật dịch cho ${site.origin}`);
      enableBtn.innerHTML = SVG_ICONS.power;
      enableBtn.addEventListener('click', async () => {
        hideAutoSiteError();
        enableBtn.disabled = true;
        const res = await enableSiteForOrigin(site.origin);
        enableBtn.disabled = false;
        if (!res.ok) {
          showAutoSiteError(res.reason === 'permission'
            ? `Cần cấp quyền truy cập cho ${site.origin} để tự động dịch.`
            : `Lỗi bật dịch cho ${site.origin}: ` + ((res.error && res.error.message) || 'Không thể lưu'));
        }
        if (site.origin === currentConsent.siteOrigin) {
          await loadConsent();
        }
        refreshSiteDots();
      });

      // Mini Mode Select
      const modeSelect = document.createElement('select');
      modeSelect.className = 'select-mini auto-site-mode';
      modeSelect.id = `select-site-mode-${idx}`;
      modeSelect.setAttribute('aria-label', `Chế độ dịch cho ${site.origin}`);
      modeSelect.title = 'Chế độ dịch';
      modeSelect.innerHTML = `
        <option value="inherit">Theo chung</option>
        <option value="scroll-follow">Đuổi scroll</option>
        <option value="full">Toàn trang</option>
      `;
      modeSelect.value = site.mode || 'inherit';
      modeSelect.addEventListener('change', () => {
        site.mode = modeSelect.value;
        markDirty();
      });

      // AutoStart Toggle
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'mini-toggle';
      toggleLabel.title = 'Tự động dịch khi mở trang';
      toggleLabel.setAttribute('aria-label', `Tự động dịch khi mở ${site.origin}`);

      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.id = `toggle-site-autostart-${idx}`;
      toggleInput.checked = site.autoStart !== false;
      toggleInput.addEventListener('change', () => {
        site.autoStart = toggleInput.checked;
        markDirty();
        refreshSiteDots();
      });

      const toggleSlider = document.createElement('span');
      toggleSlider.className = 'mini-toggle-slider';
      toggleLabel.appendChild(toggleInput);
      toggleLabel.appendChild(toggleSlider);

      // Delete Button
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-site-delete';
      deleteBtn.id = `btn-delete-site-${idx}`;
      deleteBtn.title = `Xoá ${site.origin}`;
      deleteBtn.setAttribute('aria-label', `Xoá ${site.origin}`);
      deleteBtn.innerHTML = SVG_ICONS.trash;

      deleteBtn.addEventListener('click', async () => {
        hideAutoSiteError();
        if (!settingsLoaded) {
          showAutoSiteError(SETTINGS_NOT_LOADED_MSG);
          return;
        }
        const updatedList = autoTranslateSites.filter((s) => (s.origin || s) !== site.origin);
        deleteBtn.disabled = true;

        const saveResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'SAVE_SETTINGS',
            settings: { autoTranslateSites: updatedList }
          }, resolve);
        });

        if (chrome.runtime.lastError || !saveResp || saveResp.error) {
          const err = saveResp?.error || chrome.runtime.lastError;
          showAutoSiteError('Lỗi xoá trang: ' + (err?.message || 'Không thể lưu'));
          deleteBtn.disabled = false;
          return;
        }

        autoTranslateSites = updatedList;
        savedSettings.autoTranslateSites = JSON.parse(JSON.stringify(updatedList));
        renderAutoSites();
      });

      controlsDiv.appendChild(modeSelect);
      controlsDiv.appendChild(toggleLabel);
      controlsDiv.appendChild(enableBtn);
      controlsDiv.appendChild(deleteBtn);

      mainRow.appendChild(statusDot);
      mainRow.appendChild(originSpan);
      mainRow.appendChild(controlsDiv);

      // Row 2: Per-site language override
      const subRow = document.createElement('div');
      subRow.className = 'auto-site-row-sub';

      const langIcon = document.createElement('span');
      langIcon.className = 'field-icon field-icon-xs';
      langIcon.title = 'Ngôn ngữ riêng cho trang này (mặc định: theo chung)';
      langIcon.setAttribute('aria-hidden', 'true');
      langIcon.innerHTML = '<svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7M9 3v2c0 4.418 -2.239 8 -5 8"/><path d="M5 9c0 2.144 2.952 3.908 6.7 4"/><path d="M12 20l4 -9l4 9"/><path d="M19.1 18h-6.2"/></svg>';

      const srcSelect = document.createElement('select');
      srcSelect.className = 'select-mini auto-site-lang-src';
      srcSelect.id = `select-site-src-${idx}`;
      srcSelect.setAttribute('aria-label', `Ngôn ngữ nguồn cho ${site.origin}`);
      srcSelect.title = 'Ngôn ngữ nguồn';
      srcSelect.innerHTML = `
        <option value="">Theo chung</option>
        <option value="auto">Tự động (auto)</option>
        <option value="zh">Tiếng Trung (zh)</option>
        <option value="en">Tiếng Anh (en)</option>
        <option value="ja">Tiếng Nhật (ja)</option>
        <option value="ko">Tiếng Hàn (ko)</option>
      `;
      srcSelect.value = site.sourceLanguage || '';
      srcSelect.addEventListener('change', () => {
        site.sourceLanguage = srcSelect.value || null;
        markDirty();
      });

      const arrowSpan = document.createElement('span');
      arrowSpan.textContent = '→';

      const tgtSelect = document.createElement('select');
      tgtSelect.className = 'select-mini auto-site-lang-tgt';
      tgtSelect.id = `select-site-tgt-${idx}`;
      tgtSelect.setAttribute('aria-label', `Ngôn ngữ đích cho ${site.origin}`);
      tgtSelect.title = 'Ngôn ngữ đích';
      tgtSelect.innerHTML = `
        <option value="">Theo chung</option>
        <option value="vi">Tiếng Việt (vi)</option>
        <option value="en">Tiếng Anh (en)</option>
        <option value="zh">Tiếng Trung (zh)</option>
      `;
      tgtSelect.value = site.targetLanguage || '';
      tgtSelect.addEventListener('change', () => {
        site.targetLanguage = tgtSelect.value || null;
        markDirty();
      });

      const modelSelect = document.createElement('select');
      modelSelect.className = 'select-mini auto-site-model';
      modelSelect.id = `select-site-model-${idx}`;
      modelSelect.setAttribute('aria-label', `Model dịch riêng cho ${site.origin}`);
      modelSelect.title = 'Model dịch riêng (mặc định: theo chung)';
      {
        const seen = new Set();
        const opts = [{ value: '', label: 'Model: theo chung' }];
        const pushOpt = (v) => {
          const val = (v || '').trim();
          if (val && !seen.has(val)) { seen.add(val); opts.push({ value: val, label: val }); }
        };
        pushOpt(savedSettings.model || DEFAULT_MODEL);
        primaryFavorites().forEach(pushOpt);
        (typeof RECOMMENDED_MODELS !== 'undefined' ? RECOMMENDED_MODELS : []).forEach(pushOpt);
        (discoveredModels || []).map((m) => (typeof m === 'string' ? m : m && m.id)).forEach(pushOpt);
        for (const o of opts) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          modelSelect.appendChild(opt);
        }
      }
      modelSelect.value = site.model || '';
      // Unknown stored model (renamed upstream): keep visible, don't silently drop
      if (site.model && modelSelect.value !== site.model) {
        const opt = document.createElement('option');
        opt.value = site.model;
        opt.textContent = site.model;
        modelSelect.appendChild(opt);
        modelSelect.value = site.model;
      }
      modelSelect.addEventListener('change', () => {
        site.model = modelSelect.value || null;
        markDirty();
      });

      subRow.appendChild(langIcon);
      subRow.appendChild(srcSelect);
      subRow.appendChild(arrowSpan);
      subRow.appendChild(tgtSelect);
      subRow.appendChild(modelSelect);

      card.appendChild(mainRow);
      card.appendChild(subRow);

      autoSitesList.appendChild(card);
    });

    refreshSiteDots();
  }

  // Tab 2: no save button — every row control autosaves via markDirty();
  // delete/add flows persist immediately in their own handlers below.


  // Commit a validated origin to the auto list: save + enable consent in the
  // same gesture (the auto-start gate needs both, otherwise silent no-op).
  async function commitAutoSite(norm) {
    if (!settingsLoaded) {
      showAutoSiteError(SETTINGS_NOT_LOADED_MSG);
      return false;
    }
    if (autoTranslateSites.some((s) => (s.origin || s) === norm)) {
      showAutoSiteError(`Trang ${norm} đã có trong danh sách.`);
      return false;
    }
    if (autoTranslateSites.length >= 200) {
      showAutoSiteError('Danh sách đã đạt tối đa 200 trang.');
      return false;
    }
    const newEntry = { origin: norm, mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null };
    const updatedList = [...autoTranslateSites, newEntry];
    const saveResp = await sendMsg({ action: 'SAVE_SETTINGS', settings: { autoTranslateSites: updatedList } });
    if (chrome.runtime.lastError || !saveResp || saveResp.error) {
      const err = (saveResp && saveResp.error) || chrome.runtime.lastError || {};
      showAutoSiteError('Lỗi thêm trang: ' + ((err && err.message) || 'Không thể lưu'));
      return false;
    }
    autoTranslateSites = updatedList;
    savedSettings.autoTranslateSites = JSON.parse(JSON.stringify(updatedList));
    renderAutoSites();
    const enableRes = await enableSiteForOrigin(norm);
    if (!enableRes.ok) {
      showAutoSiteError(enableRes.reason === 'permission'
        ? `Đã thêm ${norm}, nhưng chưa cấp quyền truy cập — bấm nút nguồn trên dòng đó để bật.`
        : `Đã thêm ${norm}, nhưng bật dịch thất bại — bấm nút nguồn trên dòng đó để thử lại.`);
    }
    if (norm === currentConsent.siteOrigin) {
      await loadConsent();
    }
    refreshSiteDots();
    return true;
  }

  // Draft row: opened by the + icon. Input is prefilled with the current
  // page origin, or left empty when the current page is already listed
  // (or is not a valid HTTP(S) page).
  function openDraftAutoSite() {
    if (!autoSitesList) return;
    hideAutoSiteError();
    if (autoSitesList.querySelector('.auto-site-draft')) {
      const existing = autoSitesList.querySelector('.auto-site-draft input');
      if (existing) existing.focus();
      return;
    }
    let prefill = '';
    const tabUrl = activeTab && activeTab.url ? activeTab.url : '';
    const curOrigin = tabUrl ? normalizeOrigin(tabUrl) : null;
    if (curOrigin && !autoTranslateSites.some((s) => (s.origin || s) === curOrigin)) {
      prefill = curOrigin;
    }

    const draft = document.createElement('div');
    draft.className = 'auto-site-card auto-site-draft';
    draft.setAttribute('role', 'listitem');

    const row = document.createElement('div');
    row.className = 'input-with-button';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'input-auto-site-draft';
    input.placeholder = 'https://example.com';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Nhập origin trang web để tự động dịch');
    input.value = prefill;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-icon btn-sm';
    confirmBtn.title = 'Thêm trang này';
    confirmBtn.setAttribute('aria-label', 'Thêm trang này');
    confirmBtn.innerHTML = SVG_ICONS.check;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-icon btn-sm';
    cancelBtn.title = 'Huỷ';
    cancelBtn.setAttribute('aria-label', 'Huỷ thêm trang');
    cancelBtn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>';

    const doConfirm = async () => {
      const val = input.value.trim();
      if (!val) {
        showAutoSiteError('Vui lòng nhập origin (ví dụ: https://example.com)');
        return;
      }
      const norm = normalizeOrigin(val);
      if (!norm) {
        showAutoSiteError('Origin không hợp lệ (yêu cầu định dạng https://example.com)');
        return;
      }
      confirmBtn.disabled = true;
      const ok = await commitAutoSite(norm);
      confirmBtn.disabled = false;
      if (ok && draft.isConnected) draft.remove();
    };
    confirmBtn.addEventListener('click', doConfirm);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doConfirm();
      } else if (e.key === 'Escape') {
        draft.remove();
      }
    });
    cancelBtn.addEventListener('click', () => draft.remove());

    row.appendChild(input);
    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);
    draft.appendChild(row);
    autoSitesList.prepend(draft);
    input.focus();
    if (prefill) input.select();
  }

  if (btnAddCurrentSite) {
    btnAddCurrentSite.addEventListener('click', () => {
      openDraftAutoSite();
    });
  }


  // Translate Page Action
  if (btnTranslate) {
    btnTranslate.addEventListener('click', async () => {
      if (!activeTab || !activeTab.id) return;
      if (!settingsLoaded) {
        updateStatus('error', '[ERROR] ' + SETTINGS_NOT_LOADED_MSG);
        evaluateActionReadiness();
        return;
      }

      btnTranslate.disabled = true;
      setTranslateBusy(true);
      updateStatus('translating', 'Đang chuẩn bị dịch...');
      startPolling();

      try {
        // Flush pending autosave first so the stored config (not stale field
        // values) is the single source of truth for this run.
        await flushAutosave();

        // SW fetch to Base URL needs its host permission; request it here in
        // the click gesture if not granted yet (autosave cannot request it).
        const basePerm = await ensureBaseUrlPermission();
        if (!basePerm.ok) {
          stopPolling();
          updateStatus('error', '[PERMISSION_REQUIRED] Chưa cấp quyền kết nối Base URL');
          setConfigMsg(configMessageConnect, basePerm.reason === 'invalid' ? 'Base URL không hợp lệ' : 'Cần cấp quyền host permission để kết nối Base URL', true);
          evaluateActionReadiness();
          return;
        }

        // Site consent: Tab 1 has no toggle — enable automatically in this
        // click gesture so one Dịch press does everything.
        const pageOrigin = activeTab?.url ? normalizeOrigin(activeTab.url) : null;
        if (pageOrigin && !currentConsent.siteEnabled) {
          updateStatus('translating', 'Đang bật dịch cho trang này...');
          const enRes = await enableSiteForOrigin(pageOrigin);
          if (!enRes.ok) {
            stopPolling();
            updateStatus('error', enRes.reason === 'permission'
              ? '[PERMISSION_REQUIRED] Cần cấp quyền truy cập cho trang này'
              : '[ERROR] Không thể bật dịch cho trang này');
            evaluateActionReadiness();
            return;
          }
          currentConsent.siteEnabled = true;
          await loadConsent();
        }

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

        const curOrigin = activeTab?.url ? normalizeOrigin(activeTab.url) : null;
        const matchingSite = curOrigin ? autoTranslateSites.find((s) => (s.origin || s) === curOrigin) : null;
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
              startPolling();
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

  // Initial Sequence (writes stay blocked until settings load succeeds)
  settingsLoaded = await loadSettings();
  setSaveState('saved');
  await refreshBasePermState();
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
