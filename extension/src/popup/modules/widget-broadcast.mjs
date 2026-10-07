// WebMCP Translator Kit — Popup Module: Widget Presentation Broadcast
// Broadcasts mascot, size, theme, and locale changes to all open tabs with content widgets.

export function broadcastWidgetPresentationState({
  selectFabMascot,
  inputFabSize,
  selectTheme,
  currentUiLocale,
  patch = {}
} = {}) {
  const currentMascot = selectFabMascot?.value || 'default';
  const currentSize = parseFloat(inputFabSize?.value) || 1.0;
  const fullPatch = {
    isPresentation: true,
    fabMascot: currentMascot,
    fabSize: currentSize,
    theme: selectTheme?.value || 'dark',
    uiLocale: currentUiLocale,
    ...patch
  };
  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.query === 'function') {
    try {
      chrome.tabs.query({}, (tabs) => {
        if (Array.isArray(tabs)) {
          for (const tab of tabs) {
            if (tab && typeof tab.id === 'number') {
              try {
                chrome.tabs.sendMessage(tab.id, {
                  action: 'WIDGET_STATE_CHANGED',
                  ...fullPatch
                }).catch(() => {});
              } catch {}
            }
          }
        }
      });
    } catch {}
  }
}
