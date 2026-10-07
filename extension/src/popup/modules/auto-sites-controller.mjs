// WebMCP Translator Kit — Auto-Translate Sites Controller Module
// Provides domain logic for managing per-site translation rules, host permission checks,
// status dot indicators, and draft origin row lifecycle.

import { normalizeOrigin } from '../../consent.mjs';

export function showAutoSiteError(autoSiteError, msg) {
  if (!autoSiteError) return;
  autoSiteError.textContent = msg;
  autoSiteError.style.display = 'block';
}

export function hideAutoSiteError(autoSiteError) {
  if (!autoSiteError) return;
  autoSiteError.textContent = '';
  autoSiteError.style.display = 'none';
}

// Shared: grant host permission + enable site consent for an origin.
// Must run inside a user gesture (button click). Adding an origin to the
// auto list alone is NOT enough — the auto-start gate also requires site
// consent + host permission, otherwise auto-translate silently does nothing.
export async function enableSiteForOrigin(origin, sendMsg) {
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
export async function refreshSiteDots({ autoSitesList, autoTranslateSites = [], currentUiLocale, t }) {
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
      ? t(currentUiLocale, 'site_state_on', { origin })
      : state === 'standby'
        ? t(currentUiLocale, 'site_state_standby', { origin })
        : t(currentUiLocale, 'site_state_off', { origin });
    if (powerBtn) {
      powerBtn.classList.toggle('enabled', granted);
      powerBtn.title = granted
        ? t(currentUiLocale, 'site_btn_enabled', { origin })
        : t(currentUiLocale, 'site_btn_enable', { origin });
    }
  }
}

// Commit a validated origin to the auto list: save + enable consent in the
// same gesture (the auto-start gate needs both, otherwise silent no-op).
export async function commitAutoSite({
  norm,
  settingsLoaded,
  autoTranslateSites = [],
  savedSettings,
  sendMsg,
  enableSiteForOriginFn,
  currentConsent,
  loadConsent,
  renderAutoSites,
  refreshSiteDotsFn,
  showAutoSiteErrorFn,
  getSettingsNotLoadedMsg,
  currentUiLocale,
  t
}) {
  if (!settingsLoaded) {
    showAutoSiteErrorFn(getSettingsNotLoadedMsg());
    return false;
  }
  if (autoTranslateSites.some((s) => (s.origin || s) === norm)) {
    showAutoSiteErrorFn(t(currentUiLocale, 'err_site_exists', { origin: norm }));
    return false;
  }
  if (autoTranslateSites.length >= 200) {
    showAutoSiteErrorFn(t(currentUiLocale, 'err_site_max_reached'));
    return false;
  }
  const newEntry = { origin: norm, mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null };
  const updatedList = [...autoTranslateSites, newEntry];
  const saveResp = await sendMsg({ action: 'SAVE_SETTINGS', settings: { autoTranslateSites: updatedList } });
  if (chrome.runtime.lastError || !saveResp || saveResp.error) {
    const err = (saveResp && saveResp.error) || chrome.runtime.lastError || {};
    showAutoSiteErrorFn(t(currentUiLocale, 'err_add_site_failed', { error: (err && err.message) || t(currentUiLocale, 'err_cannot_save') }));
    return false;
  }
  autoTranslateSites.length = 0;
  autoTranslateSites.push(...updatedList);
  if (savedSettings) {
    savedSettings.autoTranslateSites = JSON.parse(JSON.stringify(updatedList));
  }
  if (typeof renderAutoSites === 'function') renderAutoSites();
  const enableRes = await enableSiteForOriginFn(norm);
  if (!enableRes.ok) {
    showAutoSiteErrorFn(enableRes.reason === 'permission'
      ? t(currentUiLocale, 'msg_site_added_need_perm', { origin: norm })
      : t(currentUiLocale, 'msg_site_added_enable_failed', { origin: norm }));
  }
  if (currentConsent && norm === currentConsent.siteOrigin && typeof loadConsent === 'function') {
    await loadConsent();
  }
  if (typeof refreshSiteDotsFn === 'function') {
    refreshSiteDotsFn();
  }
  return true;
}

// Draft row: opened by the + icon. Input is prefilled with the current
// page origin, or left empty when the current page is already listed
// (or is not a valid HTTP(S) page).
export function openDraftAutoSite({
  autoSitesList,
  activeTab,
  autoTranslateSites = [],
  currentUiLocale,
  SVG_ICONS,
  commitAutoSiteFn,
  showAutoSiteErrorFn,
  hideAutoSiteErrorFn,
  t
}) {
  if (!autoSitesList) return;
  hideAutoSiteErrorFn();
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
  input.setAttribute('aria-label', t(currentUiLocale, 'site_draft_input_aria'));
  input.value = prefill;

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn-icon btn-sm';
  confirmBtn.title = t(currentUiLocale, 'btn_add_site_confirm_title');
  confirmBtn.setAttribute('aria-label', t(currentUiLocale, 'btn_add_site_confirm_title'));
  confirmBtn.innerHTML = SVG_ICONS.check;

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-icon btn-sm';
  cancelBtn.title = t(currentUiLocale, 'btn_cancel_title');
  cancelBtn.setAttribute('aria-label', t(currentUiLocale, 'btn_cancel_title'));
  cancelBtn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>';

  const doConfirm = async () => {
    const val = input.value.trim();
    if (!val) {
      showAutoSiteErrorFn(t(currentUiLocale, 'err_origin_required'));
      return;
    }
    const norm = normalizeOrigin(val);
    if (!norm) {
      showAutoSiteErrorFn(t(currentUiLocale, 'err_origin_invalid'));
      return;
    }
    confirmBtn.disabled = true;
    const ok = await commitAutoSiteFn(norm);
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

export function createAutoSiteCallbacks({
  autoSitesList,
  getAutoTranslateSites = () => [],
  setAutoTranslateSites = () => {},
  savedSettings = {},
  isSettingsLoaded = () => true,
  currentConsent = {},
  getCurrentConsent,
  currentUiLocale = 'vi',
  t,
  enableSiteForOrigin,
  loadConsent,
  refreshSiteDots,
  renderAutoSites,
  showAutoSiteError,
  hideAutoSiteError,
  markDirty,
  getSettingsNotLoadedMsg
} = {}) {
  return {
    onEnable: async (site, enableBtn) => {
      if (typeof hideAutoSiteError === 'function') hideAutoSiteError();
      enableBtn.disabled = true;
      const res = await enableSiteForOrigin(site.origin);
      enableBtn.disabled = false;
      if (!res.ok && typeof showAutoSiteError === 'function') {
        showAutoSiteError(res.reason === 'permission'
          ? t(currentUiLocale, 'err_perm_site_needed', { origin: site.origin })
          : t(currentUiLocale, 'err_enable_site_failed', { origin: site.origin, error: (res.error && res.error.message) || t(currentUiLocale, 'err_cannot_save') }));
      }
      const consent = typeof getCurrentConsent === 'function' ? getCurrentConsent() : currentConsent;
      if (site.origin === consent?.siteOrigin && typeof loadConsent === 'function') {
        await loadConsent();
      }
      if (typeof refreshSiteDots === 'function') refreshSiteDots();
    },
    onModeChange: () => markDirty(),
    onAutoStartChange: () => {
      markDirty();
      if (typeof refreshSiteDots === 'function') refreshSiteDots();
    },
    onDelete: async (site, deleteBtn) => {
      if (typeof hideAutoSiteError === 'function') hideAutoSiteError();
      if (!isSettingsLoaded()) {
        if (typeof showAutoSiteError === 'function') showAutoSiteError(getSettingsNotLoadedMsg());
        return;
      }
      const sites = getAutoTranslateSites();
      const updatedList = sites.filter((s) => (s.origin || s) !== site.origin);
      deleteBtn.disabled = true;

      const saveResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'SAVE_SETTINGS',
          settings: { autoTranslateSites: updatedList }
        }, resolve);
      });

      if (chrome.runtime.lastError || !saveResp || saveResp.error) {
        const err = saveResp?.error || chrome.runtime.lastError;
        if (typeof showAutoSiteError === 'function') {
          showAutoSiteError(t(currentUiLocale, 'err_delete_site_failed', { error: err?.message || t(currentUiLocale, 'err_cannot_save') }));
        }
        deleteBtn.disabled = false;
        return;
      }

      setAutoTranslateSites(updatedList);
      savedSettings.autoTranslateSites = JSON.parse(JSON.stringify(updatedList));
      if (typeof renderAutoSites === 'function') renderAutoSites();
    },
    onSourceLangChange: () => markDirty(),
    onTargetLangChange: () => markDirty(),
    onModelChange: () => markDirty()
  };
}
