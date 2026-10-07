// WebMCP Translator Kit — Popup Module: Mascot Picker
// Handles mascot selection, keyboard arrow navigation, size slider display & reset

import { clampFabSize, normalizeFabMascot } from '../../settings.mjs';

export function setupMascotPicker({
  mascotSelectorGrid,
  selectFabMascot,
  inputFabSize,
  fabSizeValue,
  btnResetFabSize,
  onPresentationChange,
  onDirty,
  attachListeners = true
} = {}) {
  function updateFabSizeDisplay(val, options = {}) {
    const clamped = clampFabSize(val);
    if (inputFabSize) inputFabSize.value = String(clamped);
    if (fabSizeValue) fabSizeValue.textContent = `${clamped.toFixed(2)}x`;
    const currentMascot = selectFabMascot?.value || 'default';
    if ((!options || options.broadcast !== false) && typeof onPresentationChange === 'function') {
      onPresentationChange({ fabSize: clamped, fabMascot: currentMascot, isPresentation: true });
    }
  }

  function applyFabMascot(mascot, options = {}) {
    const target = normalizeFabMascot(mascot);
    if (selectFabMascot) selectFabMascot.value = target;
    if (mascotSelectorGrid) {
      const chips = mascotSelectorGrid.querySelectorAll('.mascot-chip');
      chips.forEach((chip) => {
        const isSelected = chip.dataset.mascot === target;
        chip.classList.toggle('active', isSelected);
        chip.setAttribute('aria-checked', String(isSelected));
        chip.setAttribute('tabindex', isSelected ? '0' : '-1');
      });
    }
    const currentSize = parseFloat(inputFabSize?.value) || 1.0;
    if ((!options || options.broadcast !== false) && typeof onPresentationChange === 'function') {
      onPresentationChange({ fabMascot: target, fabSize: currentSize, isPresentation: true });
    }
  }

  if (attachListeners && mascotSelectorGrid) {
    mascotSelectorGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.mascot-chip');
      if (chip && chip.dataset.mascot) {
        applyFabMascot(chip.dataset.mascot);
        if (typeof onDirty === 'function') onDirty();
      }
    });

    mascotSelectorGrid.addEventListener('keydown', (e) => {
      const chips = Array.from(mascotSelectorGrid.querySelectorAll('.mascot-chip'));
      if (chips.length === 0) return;
      const activeIdx = chips.findIndex((c) => c.classList.contains('active'));
      let nextIdx = -1;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIdx = activeIdx >= 0 ? (activeIdx + 1) % chips.length : 0;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIdx = activeIdx >= 0 ? (activeIdx - 1 + chips.length) % chips.length : chips.length - 1;
      } else if (e.key === ' ' || e.key === 'Enter') {
        const chip = e.target.closest('.mascot-chip');
        if (chip && chip.dataset.mascot) {
          e.preventDefault();
          applyFabMascot(chip.dataset.mascot);
          if (typeof onDirty === 'function') onDirty();
        }
      }

      if (nextIdx >= 0) {
        const targetChip = chips[nextIdx];
        if (targetChip && targetChip.dataset.mascot) {
          applyFabMascot(targetChip.dataset.mascot);
          targetChip.focus();
          if (typeof onDirty === 'function') onDirty();
        }
      }
    });
  }

  if (attachListeners && inputFabSize) {
    inputFabSize.addEventListener('input', () => {
      updateFabSizeDisplay(inputFabSize.value);
      if (typeof onDirty === 'function') onDirty();
    });
  }

  if (attachListeners && btnResetFabSize) {
    btnResetFabSize.addEventListener('click', () => {
      updateFabSizeDisplay(1.0);
      if (typeof onDirty === 'function') onDirty();
    });
  }

  return {
    applyFabMascot,
    updateFabSizeDisplay
  };
}
