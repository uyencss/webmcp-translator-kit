// WebMCP Translator Kit — Popup Module: Tab Consent & Override Controller
// Handles per-tab translation consent override and site permissions toggle.

export function setupTabConsentControls({
  getActiveTab,
  getCurrentConsent,
  toggleSiteConsent,
  btnOverrideInherit,
  btnOverrideOn,
  btnOverrideOff,
  currentUiLocale,
  t,
  updateStatus,
  loadConsent,
  checkTabStatus
}) {
  async function updateTabOverride(val) {
    const activeTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
    if (!activeTab || !activeTab.id) return;
    if (btnOverrideInherit) btnOverrideInherit.disabled = true;
    if (btnOverrideOn) btnOverrideOn.disabled = true;
    if (btnOverrideOff) btnOverrideOff.disabled = true;

    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'SET_TAB_OVERRIDE',
        tabId: activeTab.id,
        value: val
      }, resolve);
    });

    if (btnOverrideInherit) btnOverrideInherit.disabled = false;
    if (btnOverrideOn) btnOverrideOn.disabled = false;
    if (btnOverrideOff) btnOverrideOff.disabled = false;

    if (chrome.runtime.lastError || !resp || resp.error) {
      const err = resp?.error || chrome.runtime.lastError;
      if (typeof updateStatus === 'function') {
        updateStatus('error', `[${err.code || 'ERROR'}] ${err.message || t(currentUiLocale, 'err_save_tab_override_failed')}`);
      }
      return;
    }

    if (typeof loadConsent === 'function') await loadConsent();
    if (typeof checkTabStatus === 'function') await checkTabStatus();
  }

  if (toggleSiteConsent) {
    toggleSiteConsent.addEventListener('change', async () => {
      const currentConsent = typeof getCurrentConsent === 'function' ? getCurrentConsent() : {};
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
          if (typeof updateStatus === 'function') updateStatus('error', t(currentUiLocale, 'status_missing_perm'));
          return;
        }
      }

      const activeTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
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
        if (typeof updateStatus === 'function') {
          updateStatus('error', `[${err.code || 'ERROR'}] ${err.message || t(currentUiLocale, 'err_save_site_perm_failed')}`);
        }
        return;
      }

      toggleSiteConsent.disabled = false;
      if (typeof loadConsent === 'function') await loadConsent();
      if (typeof checkTabStatus === 'function') await checkTabStatus();
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

  return { updateTabOverride };
}
