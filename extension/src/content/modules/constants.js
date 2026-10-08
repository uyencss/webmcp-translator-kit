// WebMCP Translator Kit — Content Script Module: Constants & Scope Bootstrap
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

(function () {
  if (window !== window.top) return;
  if (window.__webMcpTranslatorInjected) return;
  window.__webMcpTranslatorInjected = true;

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1
  };
  const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, article, td, blockquote';
  // Scroll-follow coverage: current viewport + one viewport ahead only.
  // (Previously [-2H, +3H]; whole-page prefetch burned minutes on slow
  // upstreams with frozen progress. Translated nodes stay translated.)
  const SCROLL_BEHIND_H = 0;
  const SCROLL_AHEAD_H = 2;
  const SCROLL_ROOT_MARGIN = '0px 0px 200% 0px';
  const PATCH_MIN_INTERVAL_MS = 200;
  const PATCH_GROUP_SIZE = 64;
  const MAX_BATCH_ITEMS = 64;
  const MAX_BATCH_BYTES = 24576; // 24 KiB
  const MAX_IN_FLIGHT_BATCHES = 2; // ≤2 batch in-flight concurrency limit
  const SCROLL_DEBOUNCE_MS = 250;
  const throttle = {
    maxConcurrentRequests: 2,
    debounceMinMs: 200,
    debounceMaxMs: 300
  };

  // Stale-context guard: after an extension reload/update the old injected
  // script loses its runtime port and every chrome.runtime.sendMessage throws
  // synchronously ("Extension context invalidated"). The stale script must
  // halt timers/sessions silently (no uncaught errors, no retry spam); a page
  // reload injects a fresh script which works normally.
  let __wmtHalted = false;
  let widgetProgressIntervalId = null;
  function __wmtValidContext() {
    try { return !!(chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function'); } catch { return false; }
  }
  function __wmtInvalidatedErr(err) {
    const m = err && err.message ? String(err.message) : String(err || '');
    return /extension context invalidated|context invalidated/i.test(m);
  }
  function __wmtHaltStale() {
    if (__wmtHalted) return;
    __wmtHalted = true;
    autoStarting = false;
    try { if (autoStartTimer) { clearTimeout(autoStartTimer); autoStartTimer = null; } } catch {}
    try {
      if (widgetProgressIntervalId !== null) {
        clearInterval(widgetProgressIntervalId);
        widgetProgressIntervalId = null;
      }
    } catch {}
    try { stopScrollFollowSession(false); } catch {}
    try { isTranslating = false; activeRunToken++; } catch {}
    try { updateFabBusy(); } catch {}
  }
  // Fire-and-forget sender: never throws, never spams after invalidation.
  function __wmtFire(payload) {
    if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
    try {
      chrome.runtime.sendMessage(payload, () => {
        try {
          const le = chrome.runtime && chrome.runtime.lastError ? (chrome.runtime.lastError.message || '') : '';
          if (/extension context invalidated|context invalidated/i.test(le)) __wmtHaltStale();
        } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
      });
    } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
  }

  // Floating-button busy indicator hook (wired up by initFloatingWidget)
  let fabBusySetter = null;
  const WIDGET_FALLBACK_LABELS = {
    widget_title: 'WebMCP Translator',
    widget_close_label: 'Đóng panel',
    widget_hide_label: 'Ẩn biểu tượng nổi',
    widget_status_label: 'Trạng thái:',
    widget_status_on: 'Đang bật',
    widget_status_off: 'Đang tắt',
    widget_toggle_tab_on: 'Tắt dịch tab này',
    widget_toggle_tab_off: 'Bật dịch tab này',
    widget_mode_scroll: 'Dịch đuổi theo scroll',
    widget_mode_full: 'Dịch toàn trang',
    widget_btn_translate: 'Dịch ngay',
    widget_btn_restore: 'Khôi phục',
    widget_model_label: 'Mô hình',
    widget_hint: 'Mở popup để cấu hình key/quyền/model',
    widget_warn_no_perm: 'Thiếu quyền host! Mở popup để cấp quyền.',
    widget_warn_no_key: 'Chưa cấu hình API key! Mở popup để nhập key.',
    fav_empty_hint_dropdown: 'Chưa có model yêu thích (đang hiện tất cả)',
    config_fab_size_label: 'Cỡ icon nổi'
  };
  let widgetTHook = (key, params) => {
    if (typeof window !== 'undefined' && window.__wmtI18n && typeof window.__wmtI18n.t === 'function') {
      return window.__wmtI18n.t('vi', key, params);
    }
    return WIDGET_FALLBACK_LABELS[key] || key;
  };
  function setFabBusy(busy) {
    try {
      if (typeof fabBusySetter === 'function') fabBusySetter(Boolean(busy));
    } catch {}
  }

  // Busy = actual in-flight translation work (not merely "watching"), or
  // initial auto-start scheduling window before first batch is dispatched.
  // This is what stops the spinner from running forever after everything is done.
  function updateFabBusy() {
    setFabBusy(autoStarting || isTranslating || scrollSession.inFlight > 0);
  }

  const documentId = 'doc_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
  let epoch = 0;
  let idCounter = 1;
  let currentMode = 'full'; // 'full' | 'scroll-follow'

  const AUTO_SETTLE_MS = 500;
  const AUTO_QUERY_RETRY_MS = 1200;
  const AUTO_QUERY_MAX_RETRIES = 2;
  let autoStartAttempted = false;
  let autoStarting = false;
  let userRestored = false;
  let autoStartTimer = null;
  let autoStartQueryRetries = 0;
  // Monotonically increasing widget-state request sequence: every queryState()
  // issuance and every pushed WIDGET_STATE_CHANGED advances it. A query reply
  // whose sequence is older than the latest issuance/push is stale (out of
  // order) and must be ignored so a late effective:'on' cannot clobber a
  // newer effective:'off'.
  let widgetQuerySeq = 0;

  const nodeToRec = new WeakMap();
  const idToRec = new Map();
  const restoreKept = new Map();

  // Pending set tracking active in-flight items by key: `${id}:${revision}:${epoch}`
  const pendingSet = new Set();

  let isTranslating = false;
  let activeRunToken = 0;
  let lastTranslateStatus = {
    state: 'idle',
    mode: 'full',
    watching: false,
    totalCollected: 0,
    totalApplied: 0,
    totalFailed: 0,
    totalRestored: 0,
    chunksTotal: 0,
    chunksDone: 0,
    bytesTotal: 0,
    error: null,
    lastError: null,
    progressApplied: 0,
    model: null,
    actualModel: null,
    fallbackIndex: 0,
    elapsedMs: 0
  };
