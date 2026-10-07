// WebMCP Translator Kit — Popup Module: Error Log View
// Renders error log items and handles log loading/clearing.

export async function loadErrorLog(
  { highlightFirst = false } = {},
  { logList, sendMsg, t, currentUiLocale, closeModal, switchTab, btnTranslate }
) {
  if (!logList) return;
  try {
    const resp = await sendMsg({ action: 'GET_ERROR_LOG' });
    const entries = (resp && resp.ok && Array.isArray(resp.entries)) ? resp.entries : [];
    logList.innerHTML = '';
    if (entries.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'log-empty';
      emptyDiv.textContent = t(currentUiLocale, 'log_empty');
      logList.appendChild(emptyDiv);
      return;
    }
    entries.forEach((entry, idx) => {
      const item = document.createElement('div');
      item.className = 'log-item' + (idx === 0 && highlightFirst ? ' highlight' : '');

      const header = document.createElement('div');
      header.className = 'log-item-header';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      try {
        const d = new Date(entry.time);
        timeSpan.textContent = isNaN(d.getTime()) ? String(entry.time || '') : d.toLocaleTimeString();
      } catch {
        timeSpan.textContent = String(entry.time || '');
      }

      const codeSpan = document.createElement('span');
      codeSpan.className = 'log-code';
      codeSpan.textContent = entry.code || 'ERROR';

      header.appendChild(timeSpan);
      header.appendChild(codeSpan);

      if (entry.model) {
        const modelSpan = document.createElement('span');
        modelSpan.className = 'log-model';
        modelSpan.textContent = entry.model;
        header.appendChild(modelSpan);
      }

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-xs btn-outline log-retry-btn';
      retryBtn.textContent = t(currentUiLocale, 'log_retry');
      retryBtn.addEventListener('click', () => {
        if (typeof closeModal === 'function') closeModal();
        if (typeof switchTab === 'function') switchTab('tab-translate');
        if (btnTranslate && !btnTranslate.disabled) {
          btnTranslate.click();
        }
      });
      header.appendChild(retryBtn);

      const msgDiv = document.createElement('div');
      msgDiv.className = 'log-message';
      msgDiv.textContent = entry.message || '';

      item.appendChild(header);
      item.appendChild(msgDiv);
      logList.appendChild(item);
    });
  } catch {}
}

export async function clearErrorLogs({ logList, sendMsg, t, currentUiLocale }) {
  await sendMsg({ action: 'CLEAR_ERROR_LOG' });
  if (logList) {
    logList.innerHTML = '';
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'log-empty';
    emptyDiv.textContent = t(currentUiLocale, 'log_empty');
    logList.appendChild(emptyDiv);
  }
}

export function renderLogEntryItem(entry, idx, highlightFirst, retryBtn) {
  const item = document.createElement('div');
  item.className = 'log-item' + (idx === 0 && highlightFirst ? ' highlight' : '');

  const header = document.createElement('div');
  header.className = 'log-item-header';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  try {
    const d = new Date(entry.time);
    timeSpan.textContent = isNaN(d.getTime()) ? String(entry.time || '') : d.toLocaleTimeString();
  } catch {
    timeSpan.textContent = String(entry.time || '');
  }

  const codeSpan = document.createElement('span');
  codeSpan.className = 'log-code';
  codeSpan.textContent = entry.code || 'ERROR';

  header.appendChild(timeSpan);
  header.appendChild(codeSpan);

  if (entry.model) {
    const modelSpan = document.createElement('span');
    modelSpan.className = 'log-model';
    modelSpan.textContent = entry.model;
    header.appendChild(modelSpan);
  }

  if (retryBtn) header.appendChild(retryBtn);

  const msgDiv = document.createElement('div');
  msgDiv.className = 'log-message';
  msgDiv.textContent = entry.message || '';

  item.appendChild(header);
  item.appendChild(msgDiv);
  return item;
}
