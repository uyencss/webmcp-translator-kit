// WebMCP Translator Kit — Popup Telemetry & Detail Formatter Module
// Provides pure formatting helpers for elapsed times, batch progress, and categorized error codes.

export function formatElapsed(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDetail(state, data = {}, {
  currentUiLocale,
  t,
  showKeyAccessBanner,
  selectModel,
  DEFAULT_MODEL = 'ag/gemini-3.1-pro-low'
} = {}) {
  const elapsed = formatElapsed(data.elapsedMs);
  let modelStr = '';
  if (data.actualModel) {
    if (typeof data.fallbackIndex === 'number' && data.fallbackIndex >= 0) {
      modelStr = `${data.actualModel} (fallback ${data.fallbackIndex + 1})`;
    } else {
      modelStr = data.actualModel;
    }
  } else {
    modelStr = data.model || selectModel?.value || DEFAULT_MODEL;
  }

  const metaStr = elapsed ? ` (${elapsed} · ${modelStr})` : ` (${modelStr})`;

  if (state === 'watching') {
    const effApplied = typeof data.totalCollected === 'number'
      ? Math.min(data.totalApplied || 0, data.totalCollected)
      : (data.totalApplied || data.applied || 0);
    const countStr = typeof data.totalCollected === 'number'
      ? `${effApplied}/${data.totalCollected}`
      : `${effApplied}`;
    const failed = typeof data.totalFailed === 'number' ? data.totalFailed : 0;
    const failStr = failed > 0 ? ' ' + t(currentUiLocale, 'status_failed_count', { count: failed }) : '';
    const errSuffix = data.lastError && data.lastError.code ? t(currentUiLocale, 'detail_last_error_retry', { code: data.lastError.code }) : '';
    return t(currentUiLocale, 'detail_watching_progress', { count: countStr, fail: failStr, meta: metaStr, errSuffix });
  }

  if (state === 'translated') {
    const effTranslated = typeof data.totalCollected === 'number'
      ? Math.min(data.totalApplied || 0, data.totalCollected)
      : (data.applied || 0);
    const countStr = typeof data.totalCollected === 'number'
      ? `${effTranslated}/${data.totalCollected}`
      : `${effTranslated}`;
    const failed = typeof data.totalFailed === 'number' ? data.totalFailed : (data.failed || 0);
    if (failed > 0) {
      return t(currentUiLocale, 'detail_translated_with_errors', { count: countStr, failed });
    }
    return t(currentUiLocale, 'detail_translated_success', { count: countStr, meta: metaStr });
  }

  if (state === 'error') {
    const err = data.error || {};
    const code = err.code || 'ERROR';
    const msg = err.message || '';
    if (code === 'DROPPED_ON_RESTART') {
      return t(currentUiLocale, 'err_dropped_on_restart');
    }
    if (code === 'TIMEOUT') {
      return t(currentUiLocale, 'err_timeout', { msg: msg || t(currentUiLocale, 'status_timeout_default'), meta: metaStr });
    }
    if (code === 'OPT_IN_REQUIRED') {
      return t(currentUiLocale, 'err_opt_in_required');
    }
    if (code === 'SITE_NOT_ALLOWED') {
      return t(currentUiLocale, 'err_site_not_allowed');
    }
    if (code === 'KEY_ACCESS_UNAVAILABLE') {
      if (typeof showKeyAccessBanner === 'function') showKeyAccessBanner();
      return t(currentUiLocale, 'err_key_access_unavailable');
    }
    if (code === 'CONSENT_STATE_UNAVAILABLE') {
      return t(currentUiLocale, 'err_consent_state_unavailable');
    }
    if (code === 'PERMISSION_REQUIRED') {
      return t(currentUiLocale, 'err_permission_required');
    }
    if (code === 'RATE_LIMITED') {
      const scope = err.details?.scope || 'tab';
      const retrySec = Math.ceil((err.details?.retryAfterMs || 0) / 1000);
      return t(currentUiLocale, 'err_rate_limited', { scope, sec: retrySec });
    }
    if (code === 'CAP_EXCEEDED') {
      const capType = err.details?.capType || t(currentUiLocale, 'cap_type_size');
      const limit = err.details?.limit;
      const actual = err.details?.actual;
      const limitStr = (limit !== undefined && actual !== undefined) ? ` (${actual} > ${limit})` : '';
      return t(currentUiLocale, 'err_cap_exceeded', { type: capType, limit: limitStr });
    }
    if (code === 'INVALID_SCHEMA') {
      const schemaErrors = (err.details?.schemaErrors || []).join(', ');
      return t(currentUiLocale, 'err_invalid_schema', { errors: schemaErrors ? ': ' + schemaErrors : '' });
    }
    if (code === 'NETWORK') {
      return t(currentUiLocale, 'err_network');
    }
    if (code.startsWith('HTTP_')) {
      const statusText = err.details?.statusText || msg || '';
      return t(currentUiLocale, 'err_server_response', { code, statusText });
    }
    if (code === 'RATE_STATE_UNAVAILABLE') {
      return t(currentUiLocale, 'err_rate_state_unavailable');
    }
    return `[${code}] ${msg}${metaStr}`;
  }

  return '';
}
