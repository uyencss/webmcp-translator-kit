// WebMCP Translator Kit — Popup Module: Models View & Dropdown Builder
// Populates categorized model selection dropdowns (Favorites, Saved, Recommended, Other)

export function populateModelSelect(selectEl, selectedVal, {
  allowEmpty = false,
  emptyLabel = '',
  exclude = [],
  favs = null,
  savedSettings = {},
  primaryFavorites = () => [],
  currentUiLocale = 'vi',
  discoveredModels = [],
  RECOMMENDED_MODELS = [],
  DEFAULT_MODEL = 'ag/gemini-3.1-pro-low',
  t
} = {}) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const scopeFavs = Array.isArray(favs) ? favs : (typeof primaryFavorites === 'function' ? primaryFavorites() : []);
  const showFavsOnly = Boolean(savedSettings && savedSettings.showFavoritesOnly);

  if (allowEmpty) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = emptyLabel;
    selectEl.appendChild(emptyOpt);
  }

  if (showFavsOnly) {
    if (scopeFavs.length > 0) {
      const added = new Set(exclude.filter(id => id !== selectedVal));
      const validFavs = scopeFavs.filter(id => !added.has(id));
      for (const mId of validFavs) {
        const opt = document.createElement('option');
        opt.value = mId;
        opt.textContent = mId;
        selectEl.appendChild(opt);
        added.add(mId);
      }
      if (selectedVal && !added.has(selectedVal) && !allowEmpty) {
        const opt = document.createElement('option');
        opt.value = selectedVal;
        opt.textContent = selectedVal;
        selectEl.appendChild(opt);
        added.add(selectedVal);
      }
      if (selectedVal && Array.from(selectEl.options).some(o => o.value === selectedVal)) {
        selectEl.value = selectedVal;
      } else if (allowEmpty) {
        selectEl.value = '';
      } else if (validFavs.length > 0) {
        selectEl.value = validFavs[0];
      } else {
        selectEl.value = DEFAULT_MODEL;
      }
      return;
    } else {
      const hintOpt = document.createElement('option');
      hintOpt.disabled = true;
      hintOpt.textContent = `(${t(currentUiLocale, 'fav_empty_hint_dropdown')})`;
      selectEl.appendChild(hintOpt);
    }
  }

  const added = new Set(exclude.filter(id => id !== selectedVal));

  // Group 1: Favorites (Base URL scoped)
  const validFavs = scopeFavs.filter(id => !added.has(id));
  if (validFavs.length > 0) {
    const favGroup = document.createElement('optgroup');
    favGroup.label = t(currentUiLocale, 'model_group_favorites');
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
    curGroup.label = t(currentUiLocale, 'model_group_saved');
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
    recGroup.label = t(currentUiLocale, 'model_group_recommended');
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
    otherGroup.label = t(currentUiLocale, 'model_group_other');
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

export function populateAllModelDropdowns({
  selectModel,
  savedSettings = {},
  DEFAULT_MODEL = 'ag/gemini-3.1-pro-low',
  populateSelect,
  fallbacks = [],
  RECOMMENDED_MODELS = [],
  favKeyForFallback,
  getFavoritesForKey,
  updateFallbackStar,
  autoTranslateSites = [],
  currentUiLocale = 'vi',
  t,
  primaryFavorites,
  updateStarButton,
  renderFavoritesSection
} = {}) {
  const curPrimary = selectModel?.value || savedSettings.model || DEFAULT_MODEL;
  if (typeof populateSelect === 'function') {
    populateSelect(selectModel, curPrimary, { allowEmpty: false, exclude: [] });
  }

  fallbacks.forEach((fb, idx) => {
    const selectEl = document.getElementById(`select-fallback-${idx}`);
    if (selectEl && typeof populateSelect === 'function') {
      const curFbModel = fb.model || selectEl.value || RECOMMENDED_MODELS[idx + 1] || DEFAULT_MODEL;
      populateSelect(selectEl, curFbModel, {
        allowEmpty: false,
        exclude: [selectModel?.value].filter(Boolean),
        favs: getFavoritesForKey(favKeyForFallback(fb))
      });
      if (selectEl.value) {
        fb.model = selectEl.value;
      }
      if (typeof updateFallbackStar === 'function') {
        updateFallbackStar(document.getElementById(`btn-fallback-fav-${idx}`), fb, selectEl);
      }
    }
  });

  autoTranslateSites.forEach((site, idx) => {
    const siteModelSelect = document.getElementById(`select-site-model-${idx}`);
    if (siteModelSelect && typeof populateSelect === 'function') {
      const curSiteModel = site.model || siteModelSelect.value || '';
      populateSelect(siteModelSelect, curSiteModel, {
        allowEmpty: true,
        emptyLabel: t(currentUiLocale, 'site_model_inherit'),
        favs: primaryFavorites()
      });
      if (curSiteModel && siteModelSelect.value !== curSiteModel) {
        const opt = document.createElement('option');
        opt.value = curSiteModel;
        opt.textContent = curSiteModel;
        siteModelSelect.appendChild(opt);
        siteModelSelect.value = curSiteModel;
      }
    }
  });

  if (typeof updateStarButton === 'function') updateStarButton();
  if (typeof renderFavoritesSection === 'function') renderFavoritesSection();
}

export function handleListModelsResponse(resp, {
  forceRefresh = false,
  btnRefreshModels,
  currentUiLocale = 'vi',
  t,
  configMessageConnect,
  setConfigMsg,
  showKeyAccessBanner,
  setDiscoveredModels = () => {},
  renderAllModelDropdowns = () => {},
  evaluateActionReadiness = () => {}
} = {}) {
  if (btnRefreshModels) btnRefreshModels.disabled = false;

  if (chrome.runtime.lastError || !resp || resp.error) {
    const err = resp?.error || chrome.runtime.lastError;
    if (err && err.code === 'KEY_ACCESS_UNAVAILABLE' && typeof showKeyAccessBanner === 'function') {
      showKeyAccessBanner();
    }
    if (forceRefresh && typeof setConfigMsg === 'function') {
      setConfigMsg(configMessageConnect, t(currentUiLocale, 'err_load_models', { error: err?.message || t(currentUiLocale, 'err_cannot_connect') }), true);
    }
    renderAllModelDropdowns();
    evaluateActionReadiness();
    return;
  }

  if (resp && resp.models && Array.isArray(resp.models)) {
    setDiscoveredModels(resp.models);
  }

  renderAllModelDropdowns();
  evaluateActionReadiness();

  if (forceRefresh && typeof setConfigMsg === 'function') {
    setConfigMsg(configMessageConnect, t(currentUiLocale, 'msg_models_refreshed'));
  }
}
