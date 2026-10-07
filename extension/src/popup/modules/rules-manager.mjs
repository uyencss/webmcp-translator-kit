// WebMCP Translator Kit — Popup Module: Rules Manager
// Encapsulates per-site automation rules rendering and site card creation

export function createAutoSiteCard({
  site,
  idx,
  currentUiLocale,
  SVG_ICONS,
  SOURCE_LANGS,
  TARGET_LANGS,
  getLanguageLabel,
  populateSelect,
  primaryFavorites,
  t,
  onEnable,
  onModeChange,
  onAutoStartChange,
  onDelete,
  onSourceLangChange,
  onTargetLangChange,
  onModelChange
}) {
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
  statusDot.title = t(currentUiLocale, 'site_checking_perm');
  statusDot.setAttribute('aria-hidden', 'true');

  const originSpan = document.createElement('span');
  originSpan.className = 'chip-origin';
  originSpan.title = site.origin;
  originSpan.textContent = site.origin;

  const controlsDiv = document.createElement('div');
  controlsDiv.className = 'auto-site-controls';

  // Enable button: grants host permission + enables site consent in one gesture
  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = 'btn-icon btn-sm btn-site-enable';
  enableBtn.id = `btn-enable-site-${idx}`;
  enableBtn.title = t(currentUiLocale, 'site_btn_enable', { origin: site.origin });
  enableBtn.setAttribute('aria-label', t(currentUiLocale, 'site_btn_enable', { origin: site.origin }));
  enableBtn.innerHTML = SVG_ICONS.power;
  enableBtn.addEventListener('click', () => {
    if (typeof onEnable === 'function') onEnable(site, enableBtn);
  });

  // Mini Mode Select
  const modeSelect = document.createElement('select');
  modeSelect.className = 'select-mini auto-site-mode';
  modeSelect.id = `select-site-mode-${idx}`;
  modeSelect.setAttribute('aria-label', t(currentUiLocale, 'site_mode_aria', { origin: site.origin }));
  modeSelect.title = t(currentUiLocale, 'site_mode_title');
  modeSelect.innerHTML = `
    <option value="inherit">${t(currentUiLocale, 'auto_site_inherit')}</option>
    <option value="scroll-follow">${t(currentUiLocale, 'mode_scroll')}</option>
    <option value="full">${t(currentUiLocale, 'mode_full')}</option>
  `;
  modeSelect.value = site.mode || 'inherit';
  modeSelect.addEventListener('change', () => {
    site.mode = modeSelect.value;
    if (typeof onModeChange === 'function') onModeChange(site, modeSelect.value);
  });

  // AutoStart Toggle
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'mini-toggle';
  toggleLabel.title = t(currentUiLocale, 'site_autostart_title');
  toggleLabel.setAttribute('aria-label', t(currentUiLocale, 'site_autostart_aria', { origin: site.origin }));

  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.id = `toggle-site-autostart-${idx}`;
  toggleInput.checked = site.autoStart !== false;
  toggleInput.addEventListener('change', () => {
    site.autoStart = toggleInput.checked;
    if (typeof onAutoStartChange === 'function') onAutoStartChange(site, toggleInput.checked);
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
  deleteBtn.title = t(currentUiLocale, 'site_delete_title', { origin: site.origin });
  deleteBtn.setAttribute('aria-label', t(currentUiLocale, 'site_delete_aria', { origin: site.origin }));
  deleteBtn.innerHTML = SVG_ICONS.trash;
  deleteBtn.addEventListener('click', () => {
    if (typeof onDelete === 'function') onDelete(site, deleteBtn);
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
  langIcon.title = t(currentUiLocale, 'site_lang_icon_title');
  langIcon.setAttribute('aria-hidden', 'true');
  langIcon.innerHTML = '<svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7M9 3v2c0 4.418 -2.239 8 -5 8"/><path d="M5 9c0 2.144 2.952 3.908 6.7 4"/><path d="M12 20l4 -9l4 9"/><path d="M19.1 18h-6.2"/></svg>';

  const srcSelect = document.createElement('select');
  srcSelect.className = 'select-mini auto-site-lang-src';
  srcSelect.id = `select-site-src-${idx}`;
  srcSelect.setAttribute('aria-label', t(currentUiLocale, 'site_src_aria', { origin: site.origin }));
  const inheritText = t(currentUiLocale, 'auto_site_inherit');
  srcSelect.innerHTML = `<option value="">${inheritText}</option>` +
    SOURCE_LANGS.map(l => `<option value="${l.code}">${getLanguageLabel(l, currentUiLocale)}</option>`).join('');
  srcSelect.value = site.sourceLanguage || '';
  srcSelect.addEventListener('change', () => {
    site.sourceLanguage = srcSelect.value || null;
    if (typeof onSourceLangChange === 'function') onSourceLangChange(site, srcSelect.value);
  });

  const arrowSpan = document.createElement('span');
  arrowSpan.textContent = '→';

  const tgtSelect = document.createElement('select');
  tgtSelect.className = 'select-mini auto-site-lang-tgt';
  tgtSelect.id = `select-site-tgt-${idx}`;
  tgtSelect.setAttribute('aria-label', t(currentUiLocale, 'site_tgt_aria', { origin: site.origin }));
  tgtSelect.title = t(currentUiLocale, 'tgt_lang_label');
  tgtSelect.innerHTML = `<option value="">${inheritText}</option>` +
    TARGET_LANGS.map(l => `<option value="${l.code}">${getLanguageLabel(l, currentUiLocale)}</option>`).join('');
  tgtSelect.value = site.targetLanguage || '';
  tgtSelect.addEventListener('change', () => {
    site.targetLanguage = tgtSelect.value || null;
    if (typeof onTargetLangChange === 'function') onTargetLangChange(site, tgtSelect.value);
  });

  const modelSelect = document.createElement('select');
  modelSelect.className = 'select-mini auto-site-model';
  modelSelect.id = `select-site-model-${idx}`;
  modelSelect.setAttribute('aria-label', t(currentUiLocale, 'site_model_aria', { origin: site.origin }));
  modelSelect.title = t(currentUiLocale, 'site_model_title');
  populateSelect(modelSelect, site.model || '', {
    allowEmpty: true,
    emptyLabel: t(currentUiLocale, 'site_model_inherit'),
    favs: typeof primaryFavorites === 'function' ? primaryFavorites() : []
  });

  if (site.model && modelSelect.value !== site.model) {
    const opt = document.createElement('option');
    opt.value = site.model;
    opt.textContent = site.model;
    modelSelect.appendChild(opt);
    modelSelect.value = site.model;
  }
  modelSelect.addEventListener('change', () => {
    site.model = modelSelect.value || null;
    if (typeof onModelChange === 'function') onModelChange(site, modelSelect.value);
  });

  subRow.appendChild(langIcon);
  subRow.appendChild(srcSelect);
  subRow.appendChild(arrowSpan);
  subRow.appendChild(tgtSelect);
  subRow.appendChild(modelSelect);

  card.appendChild(mainRow);
  card.appendChild(subRow);

  return card;
}

export function renderAutoSitesList({
  container,
  autoTranslateSites = [],
  currentUiLocale,
  SVG_ICONS,
  SOURCE_LANGS,
  TARGET_LANGS,
  getLanguageLabel,
  populateSelect,
  primaryFavorites,
  t,
  refreshSiteDots,
  callbacks = {}
}) {
  if (!container) return;
  container.innerHTML = '';

  if (!autoTranslateSites || autoTranslateSites.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'auto-sites-empty';
    emptyEl.textContent = t(currentUiLocale, 'auto_site_empty');
    container.appendChild(emptyEl);
    return;
  }

  autoTranslateSites.forEach((siteObj, idx) => {
    const site = typeof siteObj === 'string'
      ? { origin: siteObj, mode: 'inherit', autoStart: true, sourceLanguage: null, targetLanguage: null }
      : siteObj;

    const card = createAutoSiteCard({
      site,
      idx,
      currentUiLocale,
      SVG_ICONS,
      SOURCE_LANGS,
      TARGET_LANGS,
      getLanguageLabel,
      populateSelect,
      primaryFavorites,
      t,
      onEnable: callbacks.onEnable,
      onModeChange: callbacks.onModeChange,
      onAutoStartChange: callbacks.onAutoStartChange,
      onDelete: callbacks.onDelete,
      onSourceLangChange: callbacks.onSourceLangChange,
      onTargetLangChange: callbacks.onTargetLangChange,
      onModelChange: callbacks.onModelChange
    });

    container.appendChild(card);
  });

  if (typeof refreshSiteDots === 'function') {
    refreshSiteDots();
  }
}
