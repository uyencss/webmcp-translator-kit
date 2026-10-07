// WebMCP Translator Kit — Popup Module: Config I/O
// Handles export configuration generation and import configuration parsing

import { buildExportConfig, parseImportConfig } from '../../settings.mjs';

export function buildExportPayload({
  settings,
  fallbackKeyPresence = {},
  hasStoredKey = false,
  includeKeys = false,
  apiKey = '',
  fallbackApiKeys = {},
  exportedAt
} = {}) {
  const baseConfig = buildExportConfig({
    settings,
    fallbackKeyPresence,
    hasStoredKey,
    exportedAt
  });

  if (!includeKeys) {
    return {
      filename: 'translator-config.json',
      data: baseConfig
    };
  }

  const withKeysData = {
    ...baseConfig,
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    fallbackApiKeys: (fallbackApiKeys && typeof fallbackApiKeys === 'object' && !Array.isArray(fallbackApiKeys))
      ? { ...fallbackApiKeys }
      : {}
  };

  return {
    filename: 'translator-config.with-keys.json',
    data: withKeysData
  };
}

export function downloadJsonFile(filename, jsonData) {
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
