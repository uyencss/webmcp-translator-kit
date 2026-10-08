// WebMCP Translator Kit — Content Script Module: Floating Mascot Widget DOM
// Architecture Contract: Compiled into extension/src/content.js via scripts/sync-content.mjs
// Content scripts run in an isolated world; modules share file-level closure scope.

  function initFloatingWidget() {
    // Only inject on HTTP(S) pages
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (document.getElementById('__wmt-widget-host')) return;

    const host = document.createElement('div');
    host.id = '__wmt-widget-host';
    host.setAttribute('data-wmt-ignore', 'true');
    host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;line-height:normal;';

    // Attach open Shadow DOM
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        --wmt-fs-scale: 1;
        --wmt-fab-scale: 1;
        color: #f4f4f5;
        --wmt-panel-bg: #121318;
        --wmt-text-title: #f4f4f5;
        --wmt-text-body: #f4f4f5;
        --wmt-text-secondary: #a1a1aa;
        --wmt-text-muted: #71717a;
        --wmt-border: rgba(255, 255, 255, 0.08);
        --wmt-surface: rgba(255, 255, 255, 0.04);
        --wmt-surface-hover: rgba(255, 255, 255, 0.09);
        --wmt-mode-bg: rgba(255, 255, 255, 0.03);
        --wmt-mode-border: rgba(255, 255, 255, 0.06);
        --wmt-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }
      :host([data-fontscale="sm"]) {
        font-size: 11.5px;
        --wmt-fs-scale: 0.9;
      }
      :host([data-fontscale="sm"]) .wmt-panel {
        font-size: 11.5px;
        padding: 11px;
        gap: 8px;
      }
      :host([data-fontscale="sm"]) .wmt-title {
        font-size: 12.5px;
      }
      :host([data-fontscale="sm"]) .wmt-switch-btn,
      :host([data-fontscale="sm"]) .wmt-action-btn,
      :host([data-fontscale="sm"]) .wmt-model-select {
        font-size: 11px;
        padding: 5px 10px;
      }
      :host([data-fontscale="md"]) {
        font-size: 13px;
        --wmt-fs-scale: 1;
      }
      :host([data-fontscale="lg"]) {
        font-size: 15px;
        --wmt-fs-scale: 1.15;
      }
      :host([data-fontscale="lg"]) .wmt-panel {
        font-size: 15px;
        padding: 16px;
        gap: 12px;
      }
      :host([data-fontscale="lg"]) .wmt-title {
        font-size: 16px;
      }
      :host([data-fontscale="lg"]) .wmt-switch-btn,
      :host([data-fontscale="lg"]) .wmt-action-btn,
      :host([data-fontscale="lg"]) .wmt-model-select {
        font-size: 13.5px;
        padding: 7px 14px;
      }
      :host([data-theme="light"]) {
        color: #0f172a;
        --wmt-panel-bg: #ffffff;
        --wmt-text-title: #0f172a;
        --wmt-text-body: #1e293b;
        --wmt-text-secondary: #475569;
        --wmt-text-muted: #64748b;
        --wmt-border: rgba(0, 0, 0, 0.1);
        --wmt-surface: rgba(0, 0, 0, 0.04);
        --wmt-surface-hover: rgba(0, 0, 0, 0.08);
        --wmt-mode-bg: rgba(0, 0, 0, 0.02);
        --wmt-mode-border: rgba(0, 0, 0, 0.08);
        --wmt-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.8);
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      .wmt-btn {
        width: calc(44px * var(--wmt-fab-scale, 1));
        height: calc(44px * var(--wmt-fab-scale, 1));
        border-radius: 50%;
        background: #3b82f6;
        color: #ffffff;
        border: none;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
        cursor: grab;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        touch-action: none;
        user-select: none;
        transition: transform 0.15s ease, background-color 0.2s;
        outline: none;
      }
      .wmt-btn svg {
        width: calc(22px * var(--wmt-fab-scale, 1));
        height: calc(22px * var(--wmt-fab-scale, 1));
      }
      .wmt-mascot-img {
        width: 100%;
        height: 100%;
        border-radius: 0;
        object-fit: contain;
        pointer-events: none;
        user-select: none;
        transition: transform 0.15s ease;
        filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.28));
      }
      .wmt-btn.has-mascot {
        background: transparent !important;
        box-shadow: none !important;
        border: none !important;
        border-radius: 0 !important;
        width: calc(52px * var(--wmt-fab-scale, 1));
        height: calc(52px * var(--wmt-fab-scale, 1));
      }
      .wmt-btn.has-mascot .wmt-badge {
        display: none !important;
      }
      .wmt-btn.has-mascot:hover {
        background: transparent !important;
      }
      .wmt-btn.has-mascot:hover .wmt-mascot-img {
        transform: scale(1.08);
        filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.38));
      }
      .wmt-btn.has-mascot:focus-visible {
        outline: none !important;
      }
      .wmt-btn.has-mascot:active {
        background: transparent !important;
        box-shadow: none !important;
      }
      .wmt-btn.has-mascot:active .wmt-mascot-img {
        transform: scale(0.95);
      }
      .wmt-btn.busy .wmt-mascot-img,
      .wmt-btn.state-thinking .wmt-mascot-img {
        animation: wmtMascotThinking 1.1s ease-in-out infinite;
      }
      .wmt-btn.state-idle .wmt-mascot-img {
        animation: wmtMascotIdle 3.5s ease-in-out infinite;
      }
      .wmt-btn.state-done .wmt-mascot-img {
        animation: wmtMascotDone 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }

      /* Halo Orbit Ring with Animated Dot */
      .wmt-halo {
        position: absolute;
        top: -8px;
        left: -8px;
        right: -8px;
        bottom: -8px;
        border-radius: 50%;
        pointer-events: none;
        display: none;
        transition: all 0.3s ease;
      }
      .wmt-btn.has-mascot .wmt-halo {
        display: block;
      }
      .wmt-halo-ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 1.5px solid rgba(139, 92, 246, 0.35);
        box-shadow: 0 0 12px rgba(139, 92, 246, 0.2);
        transition: border-color 0.3s, box-shadow 0.3s;
      }
      .wmt-halo-orbit {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        animation: wmtHaloOrbit 3.5s linear infinite;
        transform-origin: center center;
      }
      .wmt-halo-dot {
        position: absolute;
        top: -4px;
        left: 50%;
        transform: translateX(-50%);
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #a78bfa;
        box-shadow: 0 0 8px #a78bfa, 0 0 14px #8b5cf6;
        transition: background 0.3s, box-shadow 0.3s;
      }

      /* Halo State Variations */
      .wmt-btn.has-mascot.state-idle .wmt-halo-ring {
        border-color: rgba(167, 139, 250, 0.4);
        box-shadow: 0 0 10px rgba(167, 139, 250, 0.25);
      }
      .wmt-btn.has-mascot.state-idle .wmt-halo-dot {
        background: #c4b5fd;
        box-shadow: 0 0 8px #c4b5fd, 0 0 14px #a78bfa;
      }
      .wmt-btn.has-mascot.busy .wmt-halo-ring,
      .wmt-btn.has-mascot.state-thinking .wmt-halo-ring {
        border-color: rgba(56, 189, 248, 0.85);
        box-shadow: 0 0 18px rgba(56, 189, 248, 0.5);
      }
      .wmt-btn.has-mascot.busy .wmt-halo-orbit,
      .wmt-btn.has-mascot.state-thinking .wmt-halo-orbit {
        animation-duration: 1.1s;
      }
      .wmt-btn.has-mascot.busy .wmt-halo-dot,
      .wmt-btn.has-mascot.state-thinking .wmt-halo-dot {
        background: #38bdf8;
        box-shadow: 0 0 10px #38bdf8, 0 0 20px #0ea5e9;
      }
      .wmt-btn.has-mascot.state-done .wmt-halo-ring {
        border-color: rgba(16, 185, 129, 0.85);
        box-shadow: 0 0 20px rgba(16, 185, 129, 0.5);
      }
      .wmt-btn.has-mascot.state-done .wmt-halo-orbit {
        animation-duration: 0.8s;
      }
      .wmt-btn.has-mascot.state-done .wmt-halo-dot {
        background: #10b981;
        box-shadow: 0 0 12px #34d399, 0 0 22px #059669;
      }

      /* Floating Animated Zzz for Idle Sleep State */
      .wmt-mascot-zzz {
        display: none;
        position: absolute;
        top: -18px;
        right: -2px;
        pointer-events: none;
        user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-weight: 800;
        color: #c4b5fd;
        text-shadow: 0 0 6px rgba(167, 139, 250, 0.8);
        align-items: flex-end;
        gap: 2px;
      }
      .wmt-btn.has-mascot.state-idle .wmt-mascot-zzz {
        display: flex;
      }
      .wmt-mascot-zzz span {
        display: inline-block;
        opacity: 0;
        animation: wmtFloatZzz 2.6s ease-in-out infinite;
      }
      .wmt-mascot-zzz span:nth-child(1) {
        font-size: 11px;
        animation-delay: 0s;
      }
      .wmt-mascot-zzz span:nth-child(2) {
        font-size: 14px;
        animation-delay: 0.6s;
      }
      .wmt-mascot-zzz span:nth-child(3) {
        font-size: 18px;
        animation-delay: 1.2s;
      }

      @keyframes wmtHaloOrbit {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes wmtFloatZzz {
        0% {
          transform: translate(0, 6px) scale(0.6);
          opacity: 0;
        }
        25% {
          opacity: 0.95;
        }
        70% {
          opacity: 0.85;
        }
        100% {
          transform: translate(8px, -20px) scale(1.15);
          opacity: 0;
        }
      }
      @keyframes wmtMascotPulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.12); }
      }
      @keyframes wmtMascotIdle {
        0%, 100% { transform: translateY(0px) scale(1); }
        50% { transform: translateY(-2px) scale(1.03); }
      }
      @keyframes wmtMascotThinking {
        0%, 100% { transform: scale(1) rotate(0deg); }
        25% { transform: scale(1.08) rotate(-3deg); }
        75% { transform: scale(1.08) rotate(3deg); }
      }
      @keyframes wmtMascotDone {
        0% { transform: scale(0.9); }
        50% { transform: scale(1.18); }
        100% { transform: scale(1); }
      }
      .wmt-btn:hover {
        background: #2563eb;
      }
      .wmt-btn:focus-visible {
        outline: 2px solid #93c5fd;
        outline-offset: 2px;
      }
      .wmt-btn:active {
        cursor: grabbing;
      }
      .wmt-badge {
        position: absolute;
        top: calc(2px * var(--wmt-fab-scale, 1));
        right: calc(2px * var(--wmt-fab-scale, 1));
        width: calc(10px * var(--wmt-fab-scale, 1));
        height: calc(10px * var(--wmt-fab-scale, 1));
        border-radius: 50%;
        border: 2px solid #ffffff;
        background: #9ca3af;
      }
      .wmt-badge.active {
        background: #10b981;
      }
      .wmt-badge.busy {
        background: #f59e0b;
        animation: wmtPulse 1s ease-in-out infinite;
      }
      .wmt-badge.done {
        background: #10b981;
        box-shadow: 0 0 6px rgba(16, 185, 129, 0.8);
      }
      @keyframes wmtPulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
      .wmt-btn.busy svg {
        animation: wmtSpin 1s linear infinite;
      }
      @keyframes wmtSpin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .wmt-fab-anchor {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .wmt-fab-hide {
        position: absolute;
        top: calc(-3px * var(--wmt-fab-scale, 1));
        right: calc(-3px * var(--wmt-fab-scale, 1));
        width: calc(18px * var(--wmt-fab-scale, 1));
        height: calc(18px * var(--wmt-fab-scale, 1));
        border-radius: 50%;
        background: #1e293b;
        color: #94a3b8;
        border: 1.5px solid rgba(255, 255, 255, 0.22);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        z-index: 20;
        outline: none;
        box-sizing: border-box;
        opacity: 0;
        pointer-events: none;
        transform: scale(0.8);
        transition: opacity 0.2s ease, transform 0.15s ease, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      .wmt-fab-anchor:hover .wmt-fab-hide,
      .wmt-fab-hide:focus-visible {
        opacity: 1;
        pointer-events: auto;
        transform: scale(1);
      }
      .wmt-fab-hide svg {
        width: calc(9px * var(--wmt-fab-scale, 1));
        height: calc(9px * var(--wmt-fab-scale, 1));
        pointer-events: none;
      }
      .wmt-fab-hide:hover {
        background: #ef4444;
        color: #ffffff;
        border-color: #f87171;
        transform: scale(1.18);
        box-shadow: 0 3px 8px rgba(239, 68, 68, 0.5);
      }
      .wmt-fab-hide:focus-visible {
        outline: 2px solid #38bdf8;
        outline-offset: 1px;
      }
      .wmt-fab-hide:active {
        transform: scale(0.92);
      }
      :host([data-theme="light"]) .wmt-fab-hide {
        background: #ffffff;
        color: #64748b;
        border: 1.5px solid rgba(0, 0, 0, 0.15);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
      }
      :host([data-theme="light"]) .wmt-fab-hide:hover {
        background: #ef4444;
        color: #ffffff;
        border-color: #dc2626;
        box-shadow: 0 3px 8px rgba(239, 68, 68, 0.4);
      }
      .wmt-panel {
        position: absolute;
        bottom: calc(100% + 10px);
        right: 0;
        width: 280px;
        max-width: calc(100vw - 20px);
        max-height: calc(100vh - 80px);
        overflow-y: auto;
        overscroll-behavior: contain;
        transform: scale(var(--wmt-fs-scale, 1));
        transform-origin: bottom right;
        background: var(--wmt-panel-bg);
        border-radius: 12px;
        box-shadow: var(--wmt-shadow);
        border: 1px solid var(--wmt-border);
        color: var(--wmt-text-body);
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        animation: wmtFadeIn 0.15s ease-out;
        box-sizing: border-box;
      }
      .wmt-panel.placement-below {
        bottom: auto;
        top: calc(100% + 10px);
        transform-origin: top right;
      }
      .wmt-panel.placement-align-left {
        right: auto;
        left: 0;
        transform-origin: bottom left;
      }
      .wmt-panel.placement-below.placement-align-left {
        bottom: auto;
        top: calc(100% + 10px);
        right: auto;
        left: 0;
        transform-origin: top left;
      }
      .wmt-panel::-webkit-scrollbar {
        width: 4px;
      }
      .wmt-panel::-webkit-scrollbar-track {
        background: transparent;
      }
      .wmt-panel::-webkit-scrollbar-thumb {
        background: var(--wmt-border);
        border-radius: 2px;
      }
      .wmt-panel::-webkit-scrollbar-thumb:hover {
        background: var(--wmt-text-muted);
      }
      @keyframes wmtFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .wmt-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--wmt-border);
        padding-bottom: 8px;
      }
      .wmt-title {
        font-weight: 600;
        font-size: 14px;
        color: var(--wmt-text-title);
      }
      .wmt-close {
        background: transparent;
        border: none;
        color: var(--wmt-text-muted);
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
      }
      .wmt-close:hover {
        color: var(--wmt-text-title);
        background: var(--wmt-surface-hover);
      }
      .wmt-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .wmt-status-row {
        gap: 8px;
        align-items: center;
      }
      .wmt-status-left {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .wmt-status-tag {
        font-size: 10.5px;
        font-weight: 600;
        padding: 1px 7px;
        border-radius: 9999px;
        background: var(--wmt-surface);
        color: var(--wmt-text-secondary);
        border: 1px solid var(--wmt-border);
        white-space: nowrap;
      }
      .wmt-status-tag.on {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        border-color: rgba(16, 185, 129, 0.3);
      }
      .wmt-switch-btn {
        width: auto;
        padding: 3px 9px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 550;
        cursor: pointer;
        border: 1px solid var(--wmt-border);
        background: var(--wmt-surface);
        color: var(--wmt-text-secondary);
        transition: all 0.15s ease;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .wmt-switch-btn:hover {
        background: var(--wmt-surface-hover);
        color: var(--wmt-text-title);
        border-color: rgba(56, 189, 248, 0.4);
      }
      .wmt-switch-btn.active {
        background: rgba(239, 68, 68, 0.12);
        color: #f87171;
        border-color: rgba(239, 68, 68, 0.35);
      }
      .wmt-switch-btn.active:hover {
        background: rgba(239, 68, 68, 0.22);
        color: #ffffff;
      }
      :host([data-theme="light"]) .wmt-switch-btn.active {
        background: #fef2f2;
        color: #dc2626;
        border-color: rgba(220, 38, 38, 0.3);
      }
      :host([data-theme="light"]) .wmt-switch-btn.active:hover {
        background: #fee2e2;
        color: #b91c1c;
      }
      .wmt-model-row {
        gap: 8px;
        align-items: center;
      }
      .wmt-model-lbl {
        font-size: 11px;
        font-weight: 500;
        color: var(--wmt-text-secondary);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .wmt-model-select {
        flex: 1;
        min-width: 0;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 11.5px;
        font-family: inherit;
        border: 1px solid var(--wmt-border);
        background: var(--wmt-surface);
        color: var(--wmt-text-title);
        outline: none;
        cursor: pointer;
      }
      .wmt-model-select:focus-visible {
        border-color: #3b82f6;
      }
      .wmt-mode-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--wmt-mode-bg);
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--wmt-mode-border);
      }
      .wmt-mode-label {
        font-size: 11.5px;
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
      }
      .wmt-mode-label input[type="radio"] {
        accent-color: #3b82f6;
        cursor: pointer;
      }
      .wmt-actions {
        display: flex;
        gap: 8px;
      }
      .wmt-action-btn {
        flex: 1;
        height: 32px;
        padding: 0 10px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 550;
        border: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
      }
      .wmt-btn-primary {
        flex: 1.4;
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
      }
      .wmt-btn-primary:hover:not(:disabled) {
        background: linear-gradient(135deg, #60a5fa 0%, #1d4ed8 100%);
        box-shadow: 0 3px 12px rgba(59, 130, 246, 0.45);
      }
      .wmt-btn-secondary {
        background: var(--wmt-surface);
        color: var(--wmt-text-secondary);
        border: 1px solid var(--wmt-border);
      }
      .wmt-btn-secondary:hover:not(:disabled) {
        background: var(--wmt-surface-hover);
        color: var(--wmt-text-title);
      }
      .wmt-action-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .wmt-progress {
        font-size: 11px;
        color: #38bdf8;
        text-align: center;
        line-height: 1.3;
      }
      .wmt-hint {
        font-size: 11px;
        color: var(--wmt-text-muted);
        text-align: center;
        line-height: 1.3;
      }
      .wmt-warning {
        font-size: 11px;
        color: #f87171;
        background: rgba(239, 68, 68, 0.12);
        padding: 6px;
        border-radius: 4px;
        line-height: 1.3;
      }
    `;

    const container = document.createElement('div');
    container.innerHTML = `
      <div class="wmt-fab-anchor" id="wmt-fab-anchor">
        <button class="wmt-btn" id="wmt-fab" aria-label="WebMCP Translator" title="WebMCP Translator" tabindex="0">
          <div class="wmt-halo" id="wmt-halo" aria-hidden="true">
            <div class="wmt-halo-ring"></div>
            <div class="wmt-halo-orbit">
              <div class="wmt-halo-dot"></div>
            </div>
          </div>
          <div class="wmt-mascot-zzz" id="wmt-mascot-zzz" aria-hidden="true">
            <span>z</span><span>z</span><span>Z</span>
          </div>
          <img class="wmt-mascot-img" id="wmt-mascot-img" alt="Mascot" style="display: none;" />
          <svg class="wmt-default-svg" id="wmt-default-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m5 8 6 6"/>
            <path d="m4 14 6-6 2-3"/>
            <path d="M2 5h12"/>
            <path d="M7 2h1"/>
            <path d="m22 22-5-10-5 10"/>
            <path d="M14 18h6"/>
          </svg>
          <span class="wmt-badge" id="wmt-badge"></span>
        </button>
        <button class="wmt-fab-hide" id="wmt-fab-hide" type="button" aria-label="Hide floating icon" title="Hide floating icon">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5"/>
          </svg>
        </button>
      </div>
      <div class="wmt-panel" id="wmt-panel" style="display: none;">
        <div class="wmt-header">
          <span class="wmt-title">WebMCP Translator</span>
          <button class="wmt-close" id="wmt-close" aria-label="Close">✕</button>
        </div>
        <div class="wmt-row wmt-status-row">
          <div class="wmt-status-left">
            <span class="wmt-status-lbl"></span>
            <span class="wmt-status-tag" id="wmt-status-tag"></span>
          </div>
          <button class="wmt-switch-btn" id="wmt-toggle-tab"></button>
        </div>
        <div class="wmt-row wmt-model-row">
          <span class="wmt-model-lbl"></span>
          <select class="wmt-model-select" id="wmt-model-select" aria-label="Model"></select>
        </div>
        <div class="wmt-mode-group">
          <label class="wmt-mode-label">
            <input type="radio" name="wmt-mode" value="scroll-follow" checked />
            <span class="wmt-mode-text-scroll"></span>
          </label>
          <label class="wmt-mode-label">
            <input type="radio" name="wmt-mode" value="full" />
            <span class="wmt-mode-text-full"></span>
          </label>
        </div>
        <div class="wmt-actions">
          <button class="wmt-action-btn wmt-btn-primary" id="wmt-action-translate"></button>
          <button class="wmt-action-btn wmt-btn-secondary" id="wmt-action-restore"></button>
        </div>
        <div id="wmt-progress" class="wmt-progress" style="display:none;"></div>
        <div id="wmt-warn-msg" class="wmt-warning" style="display:none;"></div>
        <div class="wmt-hint"></div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(container);

    let currentMascotState = 'idle'; // 'idle' | 'thinking' | 'done'
    let doneStateTimer = null;
    let prevBusyState = false;

    const MASCOT_MAP = {
      'polyglot-owl': 'icons/mascots/polyglot-owl.png',
      'babel-cat': 'icons/mascots/babel-cat.png',
      'globe-fox': 'icons/mascots/globe-fox.png',
      'lingo-parrot': 'icons/mascots/lingo-parrot.png',
      'robo-babel': 'icons/mascots/robo-babel.png'
    };

    function updateMascotVisual(stateOverride) {
      if (stateOverride) currentMascotState = stateOverride;
      const mascotImg = container.querySelector('#wmt-mascot-img');
      const defaultSvg = container.querySelector('#wmt-default-svg');
      const fabBtn = container.querySelector('#wmt-fab');
      const badgeEl = container.querySelector('#wmt-badge');
      if (!mascotImg || !defaultSvg || !fabBtn) return;

      const mascotTheme = (typeof widgetState.fabMascot === 'string' && widgetState.fabMascot) ? widgetState.fabMascot : 'default';
      const VALID_THEMES = ['polyglot-owl', 'babel-cat', 'globe-fox', 'lingo-parrot', 'robo-babel'];

      fabBtn.classList.remove('state-idle', 'state-thinking', 'state-done');
      fabBtn.classList.add(`state-${currentMascotState}`);

      if (badgeEl) {
        badgeEl.classList.toggle('busy', currentMascotState === 'thinking');
        badgeEl.classList.toggle('done', currentMascotState === 'done');
      }

      if (mascotTheme !== 'default' && VALID_THEMES.includes(mascotTheme)) {
        fabBtn.classList.add('has-mascot');
        const stateName = (currentMascotState === 'thinking') ? 'thinking'
                        : (currentMascotState === 'done') ? 'done'
                        : 'idle';
        const subfolderPath = `icons/mascots/${mascotTheme}/${stateName}.png`;
        const flatPath = (currentMascotState === 'thinking') ? `icons/mascots/${mascotTheme}-thinking.png`
                       : (currentMascotState === 'done') ? `icons/mascots/${mascotTheme}-done.png`
                       : `icons/mascots/${mascotTheme}.png`;

        try {
          const getUrl = (p) => (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
            ? chrome.runtime.getURL(p)
            : p;
          const targetUrl = getUrl(subfolderPath);
          if (mascotImg.src !== targetUrl) {
            mascotImg.src = targetUrl;
          }
          mascotImg.style.display = 'block';
          defaultSvg.style.display = 'none';
          mascotImg.onerror = () => {
            try {
              const flatUrl = getUrl(flatPath);
              if (mascotImg.src !== flatUrl) {
                mascotImg.src = flatUrl;
                return;
              }
              const fallbackUrl = getUrl(`icons/mascots/${mascotTheme}.png`);
              if (mascotImg.src !== fallbackUrl) {
                mascotImg.src = fallbackUrl;
                return;
              }
            } catch {}
            fabBtn.classList.remove('has-mascot');
            mascotImg.style.display = 'none';
            defaultSvg.style.display = 'block';
          };
        } catch {
          fabBtn.classList.remove('has-mascot');
          mascotImg.style.display = 'none';
          defaultSvg.style.display = 'block';
        }
      } else {
        fabBtn.classList.remove('has-mascot');
        mascotImg.style.display = 'none';
        defaultSvg.style.display = 'block';
      }
    }

    fabBusySetter = (busy) => {
      const f = container.querySelector('#wmt-fab');
      const b = container.querySelector('#wmt-badge');
      if (f) f.classList.toggle('busy', busy);
      if (b) b.classList.toggle('busy', busy);

      if (busy) {
        if (doneStateTimer) { clearTimeout(doneStateTimer); doneStateTimer = null; }
        updateMascotVisual('thinking');
      } else if (prevBusyState && !busy) {
        updateMascotVisual('done');
        if (doneStateTimer) clearTimeout(doneStateTimer);
        doneStateTimer = setTimeout(() => {
          updateMascotVisual('idle');
          doneStateTimer = null;
        }, 3000);
      } else if (!doneStateTimer) {
        updateMascotVisual('idle');
      }
      prevBusyState = Boolean(busy);
    };
    updateFabBusy();

    const fab = container.querySelector('#wmt-fab');
    const fabHideBtn = container.querySelector('#wmt-fab-hide');
    const panel = container.querySelector('#wmt-panel');
    const badge = container.querySelector('#wmt-badge');
    const statusTag = container.querySelector('#wmt-status-tag');
    const toggleTabBtn = container.querySelector('#wmt-toggle-tab');
    const closeBtn = container.querySelector('#wmt-close');
    const translateBtn = container.querySelector('#wmt-action-translate');
    const restoreBtn = container.querySelector('#wmt-action-restore');
    const modeRadios = container.querySelectorAll('input[name="wmt-mode"]');
    const warnMsg = container.querySelector('#wmt-warn-msg');
    const progressEl = container.querySelector('#wmt-progress');
    const statusLbl = container.querySelector('.wmt-status-lbl');
    const modelSelect = container.querySelector('#wmt-model-select');
    const modelLbl = container.querySelector('.wmt-model-lbl');
    const modeTextScroll = container.querySelector('.wmt-mode-text-scroll');
    const modeTextFull = container.querySelector('.wmt-mode-text-full');
    const hintEl = container.querySelector('.wmt-hint');

    let currentUiLocale = 'vi';
    let currentTheme = 'dark';
    let currentFontScale = 'md';
    let isPanelOpen = false;
    let widgetState = {
      effective: 'off',
      siteEnabled: false,
      tabOverride: null,
      permission: false,
      mode: 'scroll-follow',
      widgetVisible: true,
      position: null,
      hasKey: false,
      uiLocale: 'vi',
      theme: 'dark',
      uiFontScale: 'md'
    };

    function wmtT(key, params) {
      if (typeof window !== 'undefined' && window.__wmtI18n && typeof window.__wmtI18n.t === 'function') {
        return window.__wmtI18n.t(currentUiLocale, key, params);
      }
      return WIDGET_FALLBACK_LABELS[key] || key;
    }
    widgetTHook = wmtT;

    function renderWidgetI18n() {
      if (closeBtn) closeBtn.setAttribute('aria-label', wmtT('widget_close_label'));
      if (fabHideBtn) {
        fabHideBtn.setAttribute('aria-label', wmtT('widget_hide_label'));
        fabHideBtn.setAttribute('title', wmtT('widget_hide_label'));
      }
      if (statusLbl) statusLbl.textContent = wmtT('widget_status_label');
      if (modelLbl) modelLbl.textContent = wmtT('widget_model_label');
      if (modelSelect) modelSelect.setAttribute('aria-label', wmtT('widget_model_label'));
      if (modeTextScroll) modeTextScroll.textContent = wmtT('widget_mode_scroll');
      if (modeTextFull) modeTextFull.textContent = wmtT('widget_mode_full');
      if (translateBtn) translateBtn.textContent = wmtT('widget_btn_translate');
      if (restoreBtn) restoreBtn.textContent = wmtT('widget_btn_restore');
      if (hintEl) hintEl.textContent = wmtT('widget_hint');
      const isEffectiveOn = widgetState.effective === 'on';
      if (statusTag) statusTag.textContent = isEffectiveOn ? wmtT('widget_status_on') : wmtT('widget_status_off');
      if (toggleTabBtn) toggleTabBtn.textContent = isEffectiveOn ? wmtT('widget_toggle_tab_on') : wmtT('widget_toggle_tab_off');
    }
    renderWidgetI18n();

    function refreshWidgetProgress() {
      if (!progressEl) return;
      const running = isTranslating || scrollSession.watching;
      if (!isPanelOpen || !running) {
        progressEl.style.display = 'none';
        return;
      }
      const st = lastTranslateStatus || {};
      const applied = st.totalApplied || 0;
      const collected = st.totalCollected || 0;
      const failed = st.totalFailed || 0;
      let text = collected > 0
        ? wmtT('detail_translating_nodes', { applied, collected })
        : wmtT('status_translating');
      if (failed > 0) text += ' ' + wmtT('status_failed_count', { count: failed });
      if (st.lastError && st.lastError.code) text += ` [${st.lastError.code}]`;
      progressEl.textContent = text;
      progressEl.style.display = 'block';
    }
    widgetProgressIntervalId = setInterval(refreshWidgetProgress, 800);

    function updatePanelPosition() {
      if (!isPanelOpen || !panel || !fab) return;
      const fabRect = fab.getBoundingClientRect();
      const fsScale = parseFloat(getComputedStyle(host).getPropertyValue('--wmt-fs-scale')) || 1;
      const panelWidth = (panel.offsetWidth || 280) * fsScale;
      const panelHeight = (panel.offsetHeight || 300) * fsScale;

      const spaceAbove = fabRect.top;
      const spaceBelow = window.innerHeight - fabRect.bottom;

      // Drop down if not enough room above and more room below
      const placeDown = (spaceAbove < panelHeight + 15) && (spaceBelow >= spaceAbove);
      panel.classList.toggle('placement-below', placeDown);

      // Align left if placing to the left would overflow the left viewport edge
      const wouldOverflowLeft = (fabRect.right - panelWidth) < 10;
      const canFitRight = (window.innerWidth - fabRect.left) >= panelWidth;
      const alignLeft = wouldOverflowLeft && canFitRight;
      panel.classList.toggle('placement-align-left', alignLeft);
    }

    function setPanelVisibility(open) {
      isPanelOpen = open;
      panel.style.display = isPanelOpen ? 'flex' : 'none';
      if (isPanelOpen) {
        renderWidgetI18n();
        updatePanelPosition();
        requestAnimationFrame(updatePanelPosition);
      }
    }

    let lastPresentationTime = 0;

    function applyState(st) {
      if (!st) return;
      if (st.isPresentation) {
        lastPresentationTime = Date.now();
      }
      const isStaleQuery = (Date.now() - lastPresentationTime < 3000) && !st.isPresentation && (st.fabMascot !== undefined || st.fabSize !== undefined);
      const effectiveSt = isStaleQuery
        ? { ...st, fabMascot: widgetState.fabMascot, fabSize: widgetState.fabSize }
        : st;
      widgetState = { ...widgetState, ...effectiveSt };

      if (modelSelect) {
        const curModel = st.model || widgetState.model || '';
        const list = Array.isArray(st.availableModels) && st.availableModels.length > 0
          ? st.availableModels
          : (Array.isArray(widgetState.availableModels) && widgetState.availableModels.length > 0
              ? widgetState.availableModels
              : [curModel].filter(Boolean));
        if (list.length > 0) {
          modelSelect.innerHTML = '';
          if ((st.showFavoritesOnly || widgetState.showFavoritesOnly) && (st.favoritesHint || widgetState.favoritesHint)) {
            const hintOpt = document.createElement('option');
            hintOpt.disabled = true;
            hintOpt.textContent = `(${wmtT('fav_empty_hint_dropdown')})`;
            modelSelect.appendChild(hintOpt);
          }
          const seen = new Set();
          for (const m of list) {
            const val = typeof m === 'string' ? m : m?.id;
            if (val && !seen.has(val)) {
              seen.add(val);
              const opt = document.createElement('option');
              opt.value = val;
              opt.textContent = val;
              if (val === curModel) opt.selected = true;
              modelSelect.appendChild(opt);
            }
          }
          if (curModel && !seen.has(curModel)) {
            const opt = document.createElement('option');
            opt.value = curModel;
            opt.textContent = curModel;
            opt.selected = true;
            modelSelect.appendChild(opt);
          }
          modelSelect.value = curModel;
        }
      }

      const supportedUiLocales = (typeof window !== 'undefined' && window.__wmtI18n && window.__wmtI18n.SUPPORTED_UI_LOCALES) || ['vi', 'en', 'ja', 'ko', 'zh', 'es', 'ru'];
      if (widgetState.uiLocale && supportedUiLocales.includes(widgetState.uiLocale)) {
        currentUiLocale = widgetState.uiLocale;
        renderWidgetI18n();
      }

      if (widgetState.theme && (widgetState.theme === 'dark' || widgetState.theme === 'light')) {
        currentTheme = widgetState.theme;
        host.setAttribute('data-theme', currentTheme);
      }

      if (widgetState.uiFontScale && (widgetState.uiFontScale === 'sm' || widgetState.uiFontScale === 'md' || widgetState.uiFontScale === 'lg')) {
        currentFontScale = widgetState.uiFontScale;
        host.setAttribute('data-fontscale', currentFontScale);
      }

      if (typeof widgetState.fabSize === 'number' && !Number.isNaN(widgetState.fabSize)) {
        const clampedFabSize = Math.max(0.75, Math.min(1.5, widgetState.fabSize));
        host.setAttribute('data-fabsize', String(clampedFabSize));
        host.style.setProperty('--wmt-fab-scale', String(clampedFabSize));
      }

      // Mascot Icon (WI-52)
      updateMascotVisual();

      // Effective Consent & Auto-Start Gates (only evaluated on non-presentation updates)
      if (!st.isPresentation) {
        const dataConsentAccepted = widgetState.dataConsentAccepted === true;
        const isEffectiveOn = widgetState.effective === 'on' && dataConsentAccepted;
        if (!dataConsentAccepted || !isEffectiveOn || widgetState.permission !== true || widgetState.hasKey !== true) {
          if (autoStartTimer) {
            clearTimeout(autoStartTimer);
            autoStartTimer = null;
          }
          autoStartAttempted = false;
          autoStarting = false;
          updateFabBusy();
          if (isTranslating || scrollSession.active || scrollSession.watching || scrollSession.inFlight > 0) {
            cancelActiveTranslation();
          }
        }

        badge.classList.toggle('active', isEffectiveOn);
        statusTag.textContent = isEffectiveOn ? wmtT('widget_status_on') : wmtT('widget_status_off');
        statusTag.classList.toggle('on', isEffectiveOn);

        toggleTabBtn.textContent = isEffectiveOn ? wmtT('widget_toggle_tab_on') : wmtT('widget_toggle_tab_off');
        toggleTabBtn.classList.toggle('active', isEffectiveOn);

        // Mode
        const activeMode = widgetState.mode || 'scroll-follow';
        currentMode = activeMode;
        modeRadios.forEach((r) => {
          r.checked = r.value === activeMode;
        });
      }

      // Visibility
      if (widgetState.widgetVisible === false) {
        host.style.display = 'none';
        return;
      }
      host.style.display = 'block';

      // Position
      if (widgetState.position && typeof widgetState.position.x === 'number' && typeof widgetState.position.y === 'number') {
        const x = Math.max(0, Math.min(window.innerWidth - 60, widgetState.position.x));
        const y = Math.max(0, Math.min(window.innerHeight - 60, widgetState.position.y));
        host.style.left = x + 'px';
        host.style.top = y + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      }
      if (isPanelOpen) {
        updatePanelPosition();
      }

      // Warnings
      if (!widgetState.permission) {
        warnMsg.textContent = wmtT('widget_warn_no_perm');
        warnMsg.style.display = 'block';
      } else if (!widgetState.hasKey) {
        warnMsg.textContent = wmtT('widget_warn_no_key');
        warnMsg.style.display = 'block';
      } else {
        warnMsg.style.display = 'none';
      }
    }

    function checkAutoStart(st) {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      if (autoStartAttempted) return;

      if (!st || !st.autoStart || userRestored) return;
      // Defensive gates mirror the SW WIDGET_GET_STATE gate: never auto-start
      // when consent is off, permission/key is missing, or context is stale.
      // Effective consent is required (missing field means not enabled).
      if (st.effective !== 'on') return;
      if (st.hasKey !== true) return;
      if (st.permission !== true) return;
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

      // Consume the one-shot attempt only once a valid enabled state is ready
      // to schedule: an initial disabled (no_key/no_permission/site-off)
      // response must not block a later enabled push, because the
      // WIDGET_STATE_CHANGED re-query requires !autoStartAttempted.
      autoStartAttempted = true;
      autoStarting = true;
      updateFabBusy();

      autoStartTimer = setTimeout(() => {
        autoStartTimer = null;
        try {
          if (__wmtHalted || !__wmtValidContext()) {
            autoStarting = false;
            updateFabBusy();
            __wmtHaltStale();
            return;
          }
          if (userRestored) {
            autoStarting = false;
            updateFabBusy();
            return;
          }
          if (isTranslating || scrollSession.watching) {
            autoStarting = false;
            updateFabBusy();
            return;
          }
          if (!lastTranslateStatus) {
            autoStarting = false;
            updateFabBusy();
            return;
          }

          // Re-check the latest state: permission/hasKey/autoStart may have
          // changed during the settle interval while effective stayed on.
          // A failed re-check must not start and must leave auto-start
          // retryable for a later complete positive update.
          const latest = widgetState || st || {};
          if (!latest.autoStart || latest.effective !== 'on' || latest.hasKey !== true || latest.permission !== true) {
            autoStartAttempted = false;
            autoStarting = false;
            updateFabBusy();
            return;
          }
          if (location.protocol !== 'http:' && location.protocol !== 'https:') {
            autoStartAttempted = false;
            autoStarting = false;
            updateFabBusy();
            return;
          }
          const targetMode = latest.mode || 'scroll-follow';
          currentMode = targetMode;
          lastTranslateStatus.mode = targetMode;

          // Auto-start scheduled window elapsed: hand over to in-flight translation
          autoStarting = false;
          updateFabBusy();

          if (targetMode === 'scroll-follow') {
            startScrollFollowSession(latest);
          } else {
            executeTranslation(latest).catch((e) => {
              if (__wmtInvalidatedErr(e)) __wmtHaltStale();
            });
          }
        } catch (err) {
          autoStarting = false;
          updateFabBusy();
          if (__wmtInvalidatedErr(err)) { __wmtHaltStale(); return; }
          try { console.error('[WebMCP Translator] auto-start failed:', err && err.message ? err.message : err); } catch {}
          try {
            if (lastTranslateStatus) {
              lastTranslateStatus.error = { code: 'AUTOSTART_FAILED', message: String((err && err.message) || err) };
            }
          } catch {}
        }
      }, AUTO_SETTLE_MS);
    }

    function queryState() {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      const mySeq = ++widgetQuerySeq;
      try {
        chrome.runtime.sendMessage({ action: 'WIDGET_GET_STATE' }, (resp) => {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              const leMsg = chrome.runtime.lastError.message || '';
              if (/extension context invalidated|context invalidated/i.test(leMsg)) { __wmtHaltStale(); return; }
              // Stale transport failure: a newer query or pushed state already
              // supersedes this reply; the latest request owns bounded retries.
              if (mySeq < widgetQuerySeq) return;
              // Transient SW-side failure (e.g. startup race): retry boundedly
              // so a fresh load still auto-starts without manual interaction.
              if (!autoStartAttempted && autoStartQueryRetries < AUTO_QUERY_MAX_RETRIES && !__wmtHalted && __wmtValidContext()) {
                autoStartQueryRetries++;
                setTimeout(queryState, AUTO_QUERY_RETRY_MS);
              }
              return;
            }
          } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
          // Ignore out-of-order replies older than the latest query or a newer
          // pushed state; only the latest authoritative response may apply.
          if (mySeq < widgetQuerySeq) return;
          if (resp && !resp.error) {
            autoStartQueryRetries = 0;
            applyState(resp);
            checkAutoStart(resp);
          } else if (resp && resp.error && !autoStartAttempted && autoStartQueryRetries < AUTO_QUERY_MAX_RETRIES && !__wmtHalted && __wmtValidContext()) {
            autoStartQueryRetries++;
            setTimeout(queryState, AUTO_QUERY_RETRY_MS);
          }
        });
      } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
    }

    // Drag implementation using Pointer Events
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialHostLeft = 0;
    let initialHostTop = 0;
    let pointerCapturedId = null;

    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      isDragging = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = host.getBoundingClientRect();
      initialHostLeft = rect.left;
      initialHostTop = rect.top;
      pointerCapturedId = e.pointerId;
      try {
        fab.setPointerCapture(e.pointerId);
      } catch {}
    });

    fab.addEventListener('pointermove', (e) => {
      if (pointerCapturedId === null) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (!isDragging && Math.hypot(dx, dy) > 5) {
        isDragging = true;
      }
      if (isDragging) {
        requestAnimationFrame(() => {
          const clampedX = Math.max(0, Math.min(window.innerWidth - 50, initialHostLeft + dx));
          const clampedY = Math.max(0, Math.min(window.innerHeight - 50, initialHostTop + dy));
          host.style.left = clampedX + 'px';
          host.style.top = clampedY + 'px';
          host.style.right = 'auto';
          host.style.bottom = 'auto';
          if (isPanelOpen) {
            updatePanelPosition();
          }
        });
      }
    });

    function finishDrag(e) {
      if (pointerCapturedId === null) return;
      try {
        fab.releasePointerCapture(pointerCapturedId);
      } catch {}
      pointerCapturedId = null;

      if (isDragging) {
        const rect = host.getBoundingClientRect();
        const clampedX = Math.max(0, Math.min(window.innerWidth - 50, rect.left));
        const clampedY = Math.max(0, Math.min(window.innerHeight - 50, rect.top));
        __wmtFire({
          action: 'WIDGET_SET_POSITION',
          x: clampedX,
          y: clampedY
        });
        if (isPanelOpen) {
          updatePanelPosition();
        }
      } else {
        setPanelVisibility(!isPanelOpen);
      }
      isDragging = false;
    }

    fab.addEventListener('pointerup', finishDrag);
    fab.addEventListener('pointercancel', (e) => {
      if (pointerCapturedId !== null) {
        try { fab.releasePointerCapture(pointerCapturedId); } catch {}
        pointerCapturedId = null;
      }
      isDragging = false;
    });

    // Keyboard navigation: Enter/Space toggles panel, Escape closes panel/drag, Arrows move
    fab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setPanelVisibility(!isPanelOpen);
      } else if (e.key === 'Escape') {
        if (isPanelOpen) {
          e.preventDefault();
          setPanelVisibility(false);
        }
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const rect = host.getBoundingClientRect();
        let curX = rect.left;
        let curY = rect.top;
        const step = 10;
        if (e.key === 'ArrowUp') curY -= step;
        if (e.key === 'ArrowDown') curY += step;
        if (e.key === 'ArrowLeft') curX -= step;
        if (e.key === 'ArrowRight') curX += step;
        const clampedX = Math.max(0, Math.min(window.innerWidth - 50, curX));
        const clampedY = Math.max(0, Math.min(window.innerHeight - 50, curY));
        host.style.left = clampedX + 'px';
        host.style.top = clampedY + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        if (isPanelOpen) {
          updatePanelPosition();
        }
      }
    });

    fab.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const rect = host.getBoundingClientRect();
        __wmtFire({
          action: 'WIDGET_SET_POSITION',
          x: Math.round(rect.left),
          y: Math.round(rect.top)
        });
      }
    });

    closeBtn.addEventListener('click', () => setPanelVisibility(false));

    // Floating icon hide button ('X') — immediately hides from page and persists preference
    if (fabHideBtn) {
      fabHideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        setPanelVisibility(false);
        host.style.display = 'none';
        widgetState.widgetVisible = false;
        try {
          __wmtFire({
            action: 'WIDGET_SET_VISIBLE',
            visible: false
          });
        } catch {}
      });
      fabHideBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
    }

    // Keep panel properly dropped down or aligned if window resizes while open
    window.addEventListener('resize', () => {
      if (isPanelOpen) {
        updatePanelPosition();
      }
    });

    // Tab ON/OFF toggle: sends WIDGET_SET_ENABLED (stale-safe)
    toggleTabBtn.addEventListener('click', () => {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      const targetEnabled = widgetState.effective !== 'on';
      try {
        chrome.runtime.sendMessage({
          action: 'WIDGET_SET_ENABLED',
          enabled: targetEnabled
        }, (resp) => {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
              return;
            }
          } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
          if (resp && resp.error) {
          if (resp.error.code === 'PERMISSION_REQUIRED') {
            warnMsg.textContent = wmtT('widget_warn_no_perm');
            warnMsg.style.display = 'block';
          }
          return;
        }
        applyState(resp);
        if (!targetEnabled) {
          // Turning OFF restores the original page text (not just stopping)
          try {
            restore();
          } catch {
            stopScrollFollowSession(true);
            __wmtFire({ action: 'CANCEL_PENDING', epoch });
          }
        } else if (widgetState.effective === 'on') {
          // Turning ON starts translating immediately (scroll-aware), same as translate now
          try {
            if (currentMode === 'scroll-follow' || widgetState.mode === 'scroll-follow') {
              startScrollFollowSession(widgetState);
            } else {
              executeTranslation(widgetState).catch((e) => {
                if (__wmtInvalidatedErr(e)) __wmtHaltStale();
              });
            }
          } catch (err) {
            if (__wmtInvalidatedErr(err)) { __wmtHaltStale(); return; }
            try { console.error('[WebMCP Translator] widget enable-start failed:', err && err.message ? err.message : err); } catch {}
          }
        }
        });
      } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
    });

    // Mode Selector: sends WIDGET_SET_MODE (stale-safe)
    modeRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
        if (r.checked) {
          const selectedMode = r.value;
          try {
            chrome.runtime.sendMessage({
              action: 'WIDGET_SET_MODE',
              mode: selectedMode
            }, (resp) => {
              try {
                if (chrome.runtime && chrome.runtime.lastError) {
                  if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
                  return;
                }
              } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
              if (resp && !resp.error) {
                currentMode = selectedMode;
                lastTranslateStatus.mode = selectedMode;
                if (selectedMode === 'scroll-follow' && widgetState.effective === 'on') {
                  startScrollFollowSession();
                } else if (selectedMode === 'full') {
                  stopScrollFollowSession(true);
                }
              }
            });
          } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
        }
      });
    });

    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
        const selectedModel = modelSelect.value;
        if (!selectedModel) return;
        try {
          chrome.runtime.sendMessage({
            action: 'WIDGET_SET_MODE',
            mode: currentMode,
            model: selectedModel
          }, (resp) => {
            try {
              if (chrome.runtime && chrome.runtime.lastError) {
                if (/extension context invalidated|context invalidated/i.test(chrome.runtime.lastError.message || '')) { __wmtHaltStale(); return; }
                return;
              }
            } catch (e) { if (__wmtInvalidatedErr(e)) { __wmtHaltStale(); return; } return; }
            if (resp && !resp.error) {
              widgetState.model = selectedModel;
            }
          });
        } catch (e) { if (__wmtInvalidatedErr(e)) __wmtHaltStale(); }
      });
    }

    // Translate Now Button
    translateBtn.addEventListener('click', () => {
      if (__wmtHalted || !__wmtValidContext()) { __wmtHaltStale(); return; }
      setPanelVisibility(false);
      if (currentMode === 'scroll-follow') {
        startScrollFollowSession({ ...widgetState, force: true });
      } else {
        executeTranslation({ ...widgetState, force: true }).catch((e) => {
          if (__wmtInvalidatedErr(e)) __wmtHaltStale();
        });
      }
    });

    // Restore Button
    restoreBtn.addEventListener('click', () => {
      setPanelVisibility(false);
      restore();
    });

    // Focus & Visibility re-query
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') queryState();
    });
    window.addEventListener('focus', () => queryState());

    // Window resize viewport clamp
    window.addEventListener('resize', () => {
      const rect = host.getBoundingClientRect();
      const clampedX = Math.max(0, Math.min(window.innerWidth - 50, rect.left));
      const clampedY = Math.max(0, Math.min(window.innerHeight - 50, rect.top));
      if (clampedX !== rect.left || clampedY !== rect.top) {
        host.style.left = clampedX + 'px';
        host.style.top = clampedY + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      }
    });

    // Append to document.documentElement
    document.documentElement.appendChild(host);
    queryState();

    // Listen for push notifications (re-evaluate auto-start when consent /
    // permission arrives after load; queryState bounds retries internally)