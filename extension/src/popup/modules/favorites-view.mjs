// WebMCP Translator Kit — Popup Module: Favorites Management View
// Handles rendering favorite models list, model selection options, and add/delete actions.

export function renderFavoritesView({
  favoritesList,
  favoritesCountBadge,
  favoritesSectionTitle,
  favoritesEmptyHint,
  selectAddFavorite,
  btnAddFavorite,
  favoritesAddHint,
  configMessageFavorites,
  scopeKey,
  bucket,
  availableModels,
  recommendedModels,
  currentUiLocale,
  SVG_ICONS,
  t,
  setConfigMsg,
  saveFavoriteToggle,
  onAfterChange
}) {
  if (!favoritesList) return;
  const count = bucket.length;

  if (favoritesCountBadge) {
    favoritesCountBadge.textContent = `${count}/50`;
  }
  if (favoritesSectionTitle) {
    favoritesSectionTitle.textContent = t(currentUiLocale, 'fav_manage_title', { count: String(count) });
  }

  if (selectAddFavorite) {
    selectAddFavorite.setAttribute('aria-label', t(currentUiLocale, 'fav_add_model_aria'));
    selectAddFavorite.innerHTML = '';

    if (availableModels.length === 0) {
      selectAddFavorite.disabled = true;
      if (btnAddFavorite) btnAddFavorite.disabled = true;
      selectAddFavorite.title = t(currentUiLocale, 'fav_no_models_to_add');
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = `(${t(currentUiLocale, 'fav_no_models_to_add')})`;
      selectAddFavorite.appendChild(opt);
      if (favoritesAddHint) {
        favoritesAddHint.textContent = t(currentUiLocale, 'fav_no_models_to_add');
        favoritesAddHint.classList.remove('hidden');
      }
    } else if (count >= 50) {
      selectAddFavorite.disabled = true;
      if (btnAddFavorite) btnAddFavorite.disabled = true;
      selectAddFavorite.title = t(currentUiLocale, 'err_favorite_cap_reached');
      const opt = document.createElement('option');
      opt.value = '';
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = `(${t(currentUiLocale, 'err_favorite_cap_reached')})`;
      selectAddFavorite.appendChild(opt);
      if (favoritesAddHint) {
        favoritesAddHint.textContent = t(currentUiLocale, 'err_favorite_cap_reached');
        favoritesAddHint.classList.remove('hidden');
      }
    } else {
      selectAddFavorite.disabled = false;
      if (btnAddFavorite) btnAddFavorite.disabled = false;
      selectAddFavorite.title = '';
      if (favoritesAddHint) {
        favoritesAddHint.textContent = '';
        favoritesAddHint.classList.add('hidden');
      }

      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.disabled = true;
      placeholderOpt.selected = true;
      placeholderOpt.textContent = t(currentUiLocale, 'fav_select_add_placeholder');
      selectAddFavorite.appendChild(placeholderOpt);

      const recs = availableModels.filter((m) => recommendedModels.includes(m));
      const others = availableModels.filter((m) => !recommendedModels.includes(m));

      if (recs.length > 0 && others.length > 0) {
        const recGroup = document.createElement('optgroup');
        recGroup.label = t(currentUiLocale, 'model_group_recommended');
        for (const mId of recs) {
          const opt = document.createElement('option');
          opt.value = mId;
          opt.textContent = mId;
          recGroup.appendChild(opt);
        }
        selectAddFavorite.appendChild(recGroup);

        const otherGroup = document.createElement('optgroup');
        otherGroup.label = t(currentUiLocale, 'model_group_other');
        for (const mId of others) {
          const opt = document.createElement('option');
          opt.value = mId;
          opt.textContent = mId;
          otherGroup.appendChild(opt);
        }
        selectAddFavorite.appendChild(otherGroup);
      } else {
        for (const mId of availableModels) {
          const opt = document.createElement('option');
          opt.value = mId;
          opt.textContent = mId;
          selectAddFavorite.appendChild(opt);
        }
      }
    }
  }

  favoritesList.innerHTML = '';
  if (count === 0) {
    if (favoritesEmptyHint) favoritesEmptyHint.classList.remove('hidden');
  } else {
    if (favoritesEmptyHint) favoritesEmptyHint.classList.add('hidden');
    for (const modelId of bucket) {
      const itemRow = document.createElement('div');
      itemRow.className = 'favorite-item-row';
      itemRow.setAttribute('role', 'listitem');

      const modelSpan = document.createElement('span');
      modelSpan.className = 'favorite-model-name';
      modelSpan.textContent = modelId;
      itemRow.appendChild(modelSpan);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-icon btn-danger-icon favorite-delete-btn';
      deleteBtn.title = t(currentUiLocale, 'fav_btn_delete_title');
      deleteBtn.setAttribute('aria-label', t(currentUiLocale, 'fav_btn_delete_title'));
      deleteBtn.innerHTML = SVG_ICONS.trash;
      deleteBtn.addEventListener('click', async () => {
        deleteBtn.disabled = true;
        try {
          await saveFavoriteToggle(scopeKey, modelId, false);
          if (typeof onAfterChange === 'function') onAfterChange();
        } catch (err) {
          deleteBtn.disabled = false;
          if (setConfigMsg) {
            setConfigMsg(configMessageFavorites, (err && err.message) || t(currentUiLocale, 'err_unknown'), true);
          }
        }
      });
      itemRow.appendChild(deleteBtn);

      favoritesList.appendChild(itemRow);
    }
  }
}

export async function handleAddFavoriteAction({
  selectAddFavorite,
  btnAddFavorite,
  configMessageFavorites,
  scopeKey,
  bucket,
  t,
  currentUiLocale,
  setConfigMsg,
  saveFavoriteToggle,
  onAfterChange,
  getAvailableModelsToAdd
}) {
  if (!selectAddFavorite) return;
  const modelId = selectAddFavorite.value.trim();
  if (!modelId) {
    setConfigMsg(configMessageFavorites, t(currentUiLocale, 'err_favorite_model_empty'), true);
    selectAddFavorite.focus();
    return;
  }
  if (!scopeKey) {
    setConfigMsg(configMessageFavorites, t(currentUiLocale, 'fav_need_base_url'), true);
    return;
  }
  if (bucket.length >= 50 && !bucket.includes(modelId)) {
    setConfigMsg(configMessageFavorites, t(currentUiLocale, 'err_favorite_cap_reached'), true);
    return;
  }
  if (btnAddFavorite) btnAddFavorite.disabled = true;
  try {
    await saveFavoriteToggle(scopeKey, modelId, true);
    if (typeof onAfterChange === 'function') onAfterChange();
    setConfigMsg(configMessageFavorites, t(currentUiLocale, 'fav_added_success'));
  } catch (err) {
    setConfigMsg(configMessageFavorites, (err && err.message) || t(currentUiLocale, 'err_unknown'), true);
  } finally {
    if (btnAddFavorite && typeof getAvailableModelsToAdd === 'function') {
      const remaining = getAvailableModelsToAdd(scopeKey);
      btnAddFavorite.disabled = (remaining.length === 0 || (bucket.length + 1) >= 50);
    }
  }
}
