// WebMCP Translator Kit — Popup Module: Fallback Rows
// Encapsulates dynamic rendering of model fallback rows and controls

export function createFallbackRow({
  fb,
  idx,
  currentUiLocale,
  SVG_ICONS,
  fallbackKeyPresence = {},
  favKeyForFallback,
  getFavoritesForKey,
  updateFallbackStar,
  populateSelect,
  t,
  wireFavButton,
  onRemove,
  onUrlInput,
  onKeyChange,
  onModelChange,
  onFavClick
}) {
  const row = document.createElement('div');
  row.className = 'fallback-row';
  row.id = `fallback-row-${idx}`;

  const rowHeader = document.createElement('div');
  rowHeader.className = 'fallback-row-header';

  const rowTitle = document.createElement('span');
  rowTitle.className = 'fallback-row-title';
  rowTitle.textContent = t(currentUiLocale, 'conn_fallback_row_title', { index: idx + 1, id: fb.id });

  const btnRemove = document.createElement('button');
  btnRemove.type = 'button';
  btnRemove.id = `btn-remove-fallback-${idx}`;
  btnRemove.className = 'btn-icon btn-danger-icon btn-sm';
  btnRemove.title = t(currentUiLocale, 'conn_fallback_remove_title', { index: idx + 1 });
  btnRemove.setAttribute('aria-label', t(currentUiLocale, 'conn_fallback_remove_title', { index: idx + 1 }));
  btnRemove.innerHTML = SVG_ICONS.trash;
  btnRemove.addEventListener('click', () => {
    if (typeof onRemove === 'function') onRemove(fb, idx);
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
  urlInput.placeholder = t(currentUiLocale, 'conn_fallback_url_placeholder');
  urlInput.title = t(currentUiLocale, 'conn_fallback_url_title');
  urlInput.autocomplete = 'off';
  urlInput.value = fb.baseURL || '';
  urlInput.addEventListener('input', () => {
    const previousScope = typeof favKeyForFallback === 'function' ? favKeyForFallback(fb) : '';
    fb.baseURL = urlInput.value.trim();
    const select = document.getElementById(`select-fallback-${idx}`);
    if (typeof favKeyForFallback === 'function' && favKeyForFallback(fb) !== previousScope) {
      if (typeof populateSelect === 'function') {
        populateSelect(select, select?.value || fb.model, {
          favs: typeof getFavoritesForKey === 'function' ? getFavoritesForKey(favKeyForFallback(fb)) : []
        });
      }
    }
    const btnFav = document.getElementById(`btn-fallback-fav-${idx}`);
    if (typeof updateFallbackStar === 'function') {
      updateFallbackStar(btnFav, fb, select);
    }
    if (typeof onUrlInput === 'function') onUrlInput(fb, idx, urlInput.value);
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
  keyInput.placeholder = hasKey ? t(currentUiLocale, 'conn_key_placeholder_saved') : t(currentUiLocale, 'conn_fallback_key_placeholder');
  keyInput.autocomplete = 'off';
  keyInput.addEventListener('change', () => {
    if (typeof onKeyChange === 'function') onKeyChange(fb, idx, keyInput.value);
  });

  const btnToggleRowKey = document.createElement('button');
  btnToggleRowKey.type = 'button';
  btnToggleRowKey.id = `btn-toggle-fallback-key-${idx}`;
  btnToggleRowKey.className = 'btn-icon';
  btnToggleRowKey.title = t(currentUiLocale, 'conn_btn_toggle_key_title');
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

  // Model selector + per-provider favorite star
  const modelGroup = document.createElement('div');
  modelGroup.className = 'form-group';
  const modelWrap = document.createElement('div');
  modelWrap.className = 'input-with-button';
  const modelSelect = document.createElement('select');
  modelSelect.id = `select-fallback-${idx}`;
  modelSelect.setAttribute('data-index', String(idx));
  modelSelect.setAttribute('aria-label', t(currentUiLocale, 'conn_fallback_model_aria', { index: idx + 1 }));
  modelSelect.addEventListener('change', () => {
    fb.model = modelSelect.value;
    if (typeof updateFallbackStar === 'function') {
      updateFallbackStar(btnFallbackFav, fb, modelSelect);
    }
    if (typeof onModelChange === 'function') onModelChange(fb, idx, modelSelect.value);
  });

  const btnFallbackFav = document.createElement('button');
  btnFallbackFav.type = 'button';
  btnFallbackFav.id = `btn-fallback-fav-${idx}`;
  btnFallbackFav.className = 'btn-icon btn-star';
  btnFallbackFav.title = t(currentUiLocale, 'conn_fallback_fav_title');
  btnFallbackFav.setAttribute('aria-label', t(currentUiLocale, 'conn_fallback_fav_aria', { index: idx + 1 }));
  if (typeof wireFavButton === 'function') {
    wireFavButton(btnFallbackFav, fb, idx, modelSelect, modelWrap);
  } else {
    btnFallbackFav.addEventListener('click', () => {
      if (typeof onFavClick === 'function') onFavClick(fb, idx, modelSelect, btnFallbackFav);
    });
    modelWrap.appendChild(modelSelect);
    modelWrap.appendChild(btnFallbackFav);
  }
  modelGroup.appendChild(modelWrap);
  inputsGrid.appendChild(modelGroup);

  row.appendChild(inputsGrid);
  if (typeof updateFallbackStar === 'function') {
    updateFallbackStar(btnFallbackFav, fb, modelSelect);
  }

  return row;
}

export function renderFallbackList({
  container,
  fallbacks = [],
  btnAddFallback = null,
  currentUiLocale,
  SVG_ICONS,
  fallbackKeyPresence = {},
  favKeyForFallback,
  getFavoritesForKey,
  updateFallbackStar,
  populateSelect,
  t,
  wireFavButton,
  callbacks = {}
}) {
  if (!container) return;
  container.innerHTML = '';

  if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'auto-sites-empty';
    emptyEl.textContent = t(currentUiLocale, 'conn_fallback_empty');
    container.appendChild(emptyEl);
    if (btnAddFallback) btnAddFallback.disabled = false;
    return;
  }

  fallbacks.forEach((fb, idx) => {
    const row = createFallbackRow({
      fb,
      idx,
      currentUiLocale,
      SVG_ICONS,
      fallbackKeyPresence,
      favKeyForFallback,
      getFavoritesForKey,
      updateFallbackStar,
      populateSelect,
      t,
      wireFavButton,
      onRemove: callbacks.onRemove,
      onUrlInput: callbacks.onUrlInput,
      onKeyChange: callbacks.onKeyChange,
      onModelChange: callbacks.onModelChange,
      onFavClick: callbacks.onFavClick
    });
    container.appendChild(row);
  });

  if (btnAddFallback) {
    btnAddFallback.disabled = fallbacks.length >= 2;
  }
}
