// WebMCP Translator Kit — Popup Module: Rate Limits Controller
// Manages rate limit input setup, clamping, validation, and user hints.

export function createRateLimitsController({ rateLimitsHint, t, getCurrentUiLocale, markDirty }) {
  let rateLimitsHintTimer = null;

  function showRateLimitsHint(msg) {
    if (!rateLimitsHint) return;
    rateLimitsHint.textContent = msg;
    rateLimitsHint.style.display = 'block';
    if (rateLimitsHintTimer) clearTimeout(rateLimitsHintTimer);
    rateLimitsHintTimer = setTimeout(() => {
      if (rateLimitsHint) rateLimitsHint.style.display = 'none';
      rateLimitsHintTimer = null;
    }, 4000);
  }

  function setupRateLimitInput(inputEl, min, max, defaultVal) {
    if (!inputEl) return;
    const validateAndClamp = (triggerAutosave = false) => {
      const raw = inputEl.value.trim();
      const num = parseInt(raw, 10);
      const locale = typeof getCurrentUiLocale === 'function' ? getCurrentUiLocale() : 'vi';
      if (raw === '' || isNaN(num)) {
        inputEl.value = defaultVal;
        showRateLimitsHint(t(locale, 'conn_rate_clamp_hint', { min, max }));
        if (triggerAutosave && typeof markDirty === 'function') markDirty();
        return;
      }
      if (num < min || num > max) {
        const clamped = Math.max(min, Math.min(max, num));
        inputEl.value = clamped;
        showRateLimitsHint(t(locale, 'conn_rate_clamp_hint', { min, max }));
        if (triggerAutosave && typeof markDirty === 'function') markDirty();
      } else {
        if (num !== Number(raw)) {
          inputEl.value = num;
        }
        if (triggerAutosave && typeof markDirty === 'function') markDirty();
      }
    };

    inputEl.addEventListener('input', () => {
      validateAndClamp(true);
    });
    inputEl.addEventListener('change', () => {
      validateAndClamp(true);
    });
    inputEl.addEventListener('blur', () => {
      validateAndClamp(true);
    });
  }

  return {
    showRateLimitsHint,
    setupRateLimitInput
  };
}
