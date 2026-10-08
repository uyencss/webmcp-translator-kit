// WebMCP Translator Kit — Popup Module: Error Log View
// Renders error log items and handles log clearing.

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
  timeSpan.className = 'log-time log-item-time';
  try {
    const d = new Date(entry.time);
    timeSpan.textContent = isNaN(d.getTime()) ? String(entry.time || '') : d.toLocaleTimeString();
  } catch {
    timeSpan.textContent = String(entry.time || '');
  }

  const codeSpan = document.createElement('span');
  codeSpan.className = 'log-code log-item-code';
  codeSpan.textContent = entry.code || 'ERROR';

  header.appendChild(timeSpan);
  header.appendChild(codeSpan);

  if (entry.model) {
    const modelSpan = document.createElement('span');
    modelSpan.className = 'log-model log-item-model';
    modelSpan.textContent = entry.model;
    header.appendChild(modelSpan);
  }

  if (retryBtn) header.appendChild(retryBtn);

  const msgDiv = document.createElement('div');
  msgDiv.className = 'log-message log-item-msg';
  msgDiv.textContent = entry.message || '';

  item.appendChild(header);
  item.appendChild(msgDiv);
  return item;
}
