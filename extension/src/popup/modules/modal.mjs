// WebMCP Translator Kit — Popup Module: Modal & Focus Management
// Manages accessible dialog focus trapping, background inert toggling, and subtab keyboard navigation

export function setBackgroundInertState(inert, elements = []) {
  for (const el of elements) {
    if (!el) continue;
    if (inert) {
      el.setAttribute('inert', '');
      if ('inert' in el) el.inert = true;
    } else {
      el.removeAttribute('inert');
      if ('inert' in el) el.inert = false;
    }
  }
}

export function isElementVisibleAndInteractable(el, overlayElements = []) {
  if (!el || typeof el.focus !== 'function') return false;
  if (typeof document !== 'undefined' && document.body && typeof document.body.contains === 'function' && !document.body.contains(el)) {
    return false;
  }
  if (el.disabled) return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  if (typeof el.closest === 'function') {
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.closest('.hidden')) return false;
  }

  for (const overlay of overlayElements) {
    if (overlay && (el === overlay || (typeof overlay.contains === 'function' && overlay.contains(el)))) {
      return false;
    }
  }

  let cur = el;
  while (cur && cur !== (typeof document !== 'undefined' ? document.body : null)) {
    if (cur.style && cur.style.display === 'none') return false;
    for (const overlay of overlayElements) {
      if (cur === overlay) return false;
    }
    if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
    if (cur.classList && cur.classList.contains && cur.classList.contains('hidden')) return false;
    cur = cur.parentElement || cur.parentNode;
  }

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    } catch {}
  }

  return true;
}

export function getFocusableElementsWithin(container) {
  if (!container) return [];
  const focusableSelectors = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  const nodes = Array.from(container.querySelectorAll(focusableSelectors));
  return nodes.filter((el) => {
    if (el.disabled) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('.hidden')) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.style.display === 'none') return false;
    return true;
  });
}

export function trapFocusInModal(e, modalOverlay, closeBtn) {
  if (!modalOverlay || modalOverlay.style.display === 'none') return;
  if (e.key !== 'Tab') return;

  const focusables = getFocusableElementsWithin(modalOverlay);
  if (focusables.length === 0) {
    e.preventDefault();
    if (closeBtn) closeBtn.focus();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (e.shiftKey) {
    if (active === first || !modalOverlay.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !modalOverlay.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
}

export function configureModalPanels(modalType, { tabPanels, modalTitle, currentUiLocale, t, loadErrorLog, options, closeModal } = {}) {
  if (modalType === 'config') {
    if (modalTitle) modalTitle.textContent = t(currentUiLocale, 'tab_config');
    if (tabPanels['tab-config']) tabPanels['tab-config'].classList.remove('hidden');
    if (tabPanels['tab-log']) tabPanels['tab-log'].classList.add('hidden');
    if (tabPanels['tab-consent']) tabPanels['tab-consent'].classList.add('hidden');
  } else if (modalType === 'log') {
    if (modalTitle) modalTitle.textContent = t(currentUiLocale, 'tab_log');
    if (tabPanels['tab-log']) tabPanels['tab-log'].classList.remove('hidden');
    if (tabPanels['tab-config']) tabPanels['tab-config'].classList.add('hidden');
    if (tabPanels['tab-consent']) tabPanels['tab-consent'].classList.add('hidden');
    if (typeof loadErrorLog === 'function') loadErrorLog(options);
  } else if (modalType === 'consent') {
    if (modalTitle) modalTitle.textContent = t(currentUiLocale, 'consent_modal_title');
    if (tabPanels['tab-consent']) tabPanels['tab-consent'].classList.remove('hidden');
    if (tabPanels['tab-config']) tabPanels['tab-config'].classList.add('hidden');
    if (tabPanels['tab-log']) tabPanels['tab-log'].classList.add('hidden');
  } else {
    if (typeof closeModal === 'function') closeModal();
    return false;
  }
  return true;
}

export function setupModalAndMenuTriggers({
  btnHeaderMenu,
  menuBackdrop,
  menuItemConfig,
  menuItemLog,
  menuItemImport,
  inputImportConfig,
  menuItemExport,
  modalBackdrop,
  modalCloseBtn,
  btnExportConfigConnect,
  btnImportConfigConnect,
  inputImportConfigConnect,
  toggleMenu,
  closeMenu,
  openModal,
  triggerExportConfig,
  triggerImportConfig,
  isModalOpen,
  closeModal,
  menuOverlay,
  handleModalFocusTrap
} = {}) {
  if (btnHeaderMenu) {
    btnHeaderMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });
  }
  if (menuBackdrop) menuBackdrop.addEventListener('click', closeMenu);
  if (menuItemConfig) menuItemConfig.addEventListener('click', () => openModal('config', { opener: btnHeaderMenu }));
  if (menuItemLog) menuItemLog.addEventListener('click', () => openModal('log', { opener: btnHeaderMenu }));
  if (menuItemImport && inputImportConfig) {
    menuItemImport.addEventListener('click', () => {
      closeMenu();
      inputImportConfig.click();
    });
    inputImportConfig.addEventListener('change', () => triggerImportConfig(inputImportConfig.files?.[0]));
  }
  if (menuItemExport) {
    menuItemExport.addEventListener('click', () => {
      closeMenu();
      triggerExportConfig();
    });
  }
  if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
  if (btnExportConfigConnect) btnExportConfigConnect.addEventListener('click', triggerExportConfig);
  if (btnImportConfigConnect && inputImportConfigConnect) {
    btnImportConfigConnect.addEventListener('click', () => inputImportConfigConnect.click());
    inputImportConfigConnect.addEventListener('change', () => triggerImportConfig(inputImportConfigConnect.files?.[0]));
  }
}
