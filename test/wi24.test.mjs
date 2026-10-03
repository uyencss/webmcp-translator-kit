import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const popupPath = path.resolve(__dirname, '../extension/src/popup.js');
const popupSrc = fs.readFileSync(popupPath, 'utf8');

function makeFakeElement(id, initialAttrs = {}, initialClasses = []) {
  const attrs = { ...initialAttrs };
  const classes = new Set(initialClasses);
  return {
    id,
    dataset: {},
    tabIndex: 0,
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    hasAttribute(name) { return name in attrs; },
    removeAttribute(name) { delete attrs[name]; },
    classList: {
      add(...cls) { cls.forEach(c => classes.add(c)); },
      remove(...cls) { cls.forEach(c => classes.delete(c)); },
      toggle(cls, force) {
        if (force === undefined) {
          if (classes.has(cls)) { classes.delete(cls); return false; }
          classes.add(cls); return true;
        }
        if (force) { classes.add(cls); return true; }
        classes.delete(cls); return false;
      },
      contains(cls) { return classes.has(cls); }
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {}
  };
}

function createMockSessionStorage(initialStore = {}) {
  const store = new Map(Object.entries(initialStore));
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    _store: store
  };
}

// ============================================================================
// WI-24: Static ordering and no silent swallow checks
// ============================================================================

test('WI-24: activeConfigSubtab and switchConfigSubtab are declared BEFORE legacy tab-connect migration block', () => {
  const activeSubtabDeclIdx = popupSrc.indexOf("let activeConfigSubtab = 'connect';");
  const switchConfigSubtabFnIdx = popupSrc.indexOf('function switchConfigSubtab(targetSubtabId)');
  const migrationBlockIdx = popupSrc.indexOf("if (rememberedTab === 'tab-connect')");

  assert.ok(activeSubtabDeclIdx !== -1, 'popup.js must declare activeConfigSubtab with default connect');
  assert.ok(switchConfigSubtabFnIdx !== -1, 'popup.js must declare switchConfigSubtab');
  assert.ok(migrationBlockIdx !== -1, 'popup.js must contain legacy tab-connect migration block');

  assert.ok(
    activeSubtabDeclIdx < migrationBlockIdx,
    `activeConfigSubtab declaration (pos ${activeSubtabDeclIdx}) must come before migration block (pos ${migrationBlockIdx})`
  );
  assert.ok(
    switchConfigSubtabFnIdx < migrationBlockIdx,
    `switchConfigSubtab function definition (pos ${switchConfigSubtabFnIdx}) must come before migration block (pos ${migrationBlockIdx})`
  );
});

test('WI-24: popup.js does not silently swallow errors in tab restoration and migration blocks', () => {
  // Extract migration block and its enclosing try/catch
  const migrationBlockStart = popupSrc.indexOf('// Restore remembered tab in current popup session');
  assert.ok(migrationBlockStart !== -1, 'Must locate restore remembered tab comment');
  const migrationBlockEnd = popupSrc.indexOf('function renderFavoritesSection()', migrationBlockStart);
  assert.ok(migrationBlockEnd !== -1, 'Must locate end of migration section');
  const migrationCode = popupSrc.slice(migrationBlockStart, migrationBlockEnd);

  // Must not have bare catch {}
  assert.ok(
    !migrationCode.includes('catch {}'),
    'Migration block must not have empty catch {} swallowing errors silently'
  );
  assert.ok(
    migrationCode.includes('console.warn('),
    'Migration block must log warning on error instead of silent catch'
  );
});

// ============================================================================
// WI-24: Runtime verification of opening popup with rememberedTab = 'tab-connect'
// ============================================================================

test('WI-24: rememberedTab="tab-connect" opens popup, restores Config tab and connect subtab without throwing', () => {
  const tabTranslateBtn = makeFakeElement('tab-translate', { 'aria-selected': 'true' }, ['tab-btn', 'active']);
  const tabAutoBtn = makeFakeElement('tab-auto', { 'aria-selected': 'false' }, ['tab-btn']);
  const tabConfigBtn = makeFakeElement('tab-config', { 'aria-selected': 'false' }, ['tab-btn']);
  const tabLogBtn = makeFakeElement('tab-log', { 'aria-selected': 'false' }, ['tab-btn']);
  const tabButtons = [tabTranslateBtn, tabAutoBtn, tabConfigBtn, tabLogBtn];

  const tabPanels = {
    'tab-translate': makeFakeElement('tabpanel-translate', {}, []),
    'tab-auto': makeFakeElement('tabpanel-auto', {}, ['hidden']),
    'tab-config': makeFakeElement('tabpanel-config', {}, ['hidden']),
    'tab-log': makeFakeElement('tabpanel-log', {}, ['hidden'])
  };

  const subtabConnectBtn = makeFakeElement('subtab-connect', { 'aria-selected': 'true', 'data-subtab': 'connect' }, ['subtab-btn', 'active']);
  const subtabAppearanceBtn = makeFakeElement('subtab-appearance', { 'aria-selected': 'false', 'data-subtab': 'appearance' }, ['subtab-btn']);
  const subtabFavoritesBtn = makeFakeElement('subtab-favorites', { 'aria-selected': 'false', 'data-subtab': 'favorites' }, ['subtab-btn']);
  const subtabButtons = [subtabConnectBtn, subtabAppearanceBtn, subtabFavoritesBtn];

  const configSubpanels = {
    connect: makeFakeElement('config-section-connect', {}, []),
    appearance: makeFakeElement('config-section-appearance', {}, ['hidden']),
    favorites: makeFakeElement('config-section-favorites', {}, ['hidden'])
  };

  const sessionStorage = createMockSessionStorage({
    active_translator_tab: 'tab-connect'
  });

  const warnings = [];
  const fakeConsole = {
    warn: (...args) => { warnings.push(args); },
    error: (...args) => { warnings.push(args); },
    log: () => {}
  };

  // Slice switchTab, activeConfigSubtab, switchConfigSubtab, and the migration block
  const switchTabStart = popupSrc.indexOf('function switchTab(targetTabId');
  assert.ok(switchTabStart !== -1, 'Must find switchTab');
  const migrationEnd = popupSrc.indexOf('function renderFavoritesSection()', switchTabStart);
  assert.ok(migrationEnd !== -1, 'Must find renderFavoritesSection');
  const executableSlice = popupSrc.slice(switchTabStart, migrationEnd);

  let activeTabNav = 'tab-translate';
  const context = vm.createContext({
    tabButtons,
    tabPanels,
    subtabButtons,
    configSubpanels,
    sessionStorage,
    console: fakeConsole,
    activeTabNav,
    btnClearLog: null,
    statusStrip: null,
    tabList: makeFakeElement('tab-list'),
    logList: null,
    btnTranslate: null,
    sendMsg: async () => ({ ok: true }),
    loadErrorLog: () => {},
    renderFavoritesSection: () => {},
    currentUiLocale: 'vi',
    t: (_loc, key) => key
  });

  // Execute slice in context: MUST NOT throw
  assert.doesNotThrow(() => {
    vm.runInContext(executableSlice, context);
  }, 'Opening popup with legacy tab-connect must not throw');

  // Verify no console warnings were emitted
  assert.deepEqual(warnings, [], 'Migration must run cleanly without throwing or logging warnings');

  // Verify sessionStorage migrated
  assert.equal(sessionStorage.getItem('active_translator_tab'), 'tab-config', 'sessionStorage active_translator_tab must migrate to tab-config');
  assert.equal(sessionStorage.getItem('active_config_subtab'), 'connect', 'sessionStorage active_config_subtab must be set to connect');

  // Verify tab-config is active and other tabs are inactive
  assert.equal(tabConfigBtn.getAttribute('aria-selected'), 'true', 'tab-config button must have aria-selected="true"');
  assert.ok(tabConfigBtn.classList.contains('active'), 'tab-config button must have active class');
  assert.equal(tabConfigBtn.tabIndex, 0, 'tab-config button must have tabIndex=0');
  assert.equal(tabTranslateBtn.getAttribute('aria-selected'), 'false', 'tab-translate button must have aria-selected="false"');
  assert.ok(!tabTranslateBtn.classList.contains('active'), 'tab-translate button must not have active class');
  assert.equal(tabTranslateBtn.tabIndex, -1, 'tab-translate button must have tabIndex=-1');

  // Verify tab-config panel is visible and other panels are hidden
  assert.ok(!tabPanels['tab-config'].classList.contains('hidden'), 'tabpanel-config must NOT be hidden');
  assert.ok(tabPanels['tab-translate'].classList.contains('hidden'), 'tabpanel-translate must be hidden');
  assert.ok(tabPanels['tab-auto'].classList.contains('hidden'), 'tabpanel-auto must be hidden');
  assert.ok(tabPanels['tab-log'].classList.contains('hidden'), 'tabpanel-log must be hidden');

  // Verify subtab-connect is active and other subtabs are inactive
  assert.equal(subtabConnectBtn.getAttribute('aria-selected'), 'true', 'subtab-connect button must have aria-selected="true"');
  assert.ok(subtabConnectBtn.classList.contains('active'), 'subtab-connect button must have active class');
  assert.equal(subtabConnectBtn.tabIndex, 0, 'subtab-connect button must have tabIndex=0');
  assert.equal(subtabAppearanceBtn.getAttribute('aria-selected'), 'false', 'subtab-appearance button must have aria-selected="false"');
  assert.ok(!subtabAppearanceBtn.classList.contains('active'), 'subtab-appearance button must not have active class');
  assert.equal(subtabAppearanceBtn.tabIndex, -1, 'subtab-appearance button must have tabIndex=-1');

  // Verify config subpanel connect is visible and other subpanels are hidden
  assert.ok(!configSubpanels.connect.classList.contains('hidden'), 'config-section-connect must NOT be hidden');
  assert.ok(configSubpanels.appearance.classList.contains('hidden'), 'config-section-appearance must be hidden');
  assert.ok(configSubpanels.favorites.classList.contains('hidden'), 'config-section-favorites must be hidden');
});

test('WI-24: TDZ regression test - if activeConfigSubtab was placed after migration, switchConfigSubtab throws ReferenceError', () => {
  // Simulate the round-8 buggy ordering: calling switchConfigSubtab before activeConfigSubtab is initialized
  const buggyCode = `
    function switchConfigSubtab(targetSubtabId) {
      activeConfigSubtab = targetSubtabId;
    }
    let errorCaught = null;
    try {
      switchConfigSubtab('connect');
    } catch (e) {
      errorCaught = e;
    }
    let activeConfigSubtab = 'connect';
    return { errorCaught, initialized: activeConfigSubtab };
  `;

  const result = new Function(buggyCode)();
  assert.ok(result.errorCaught instanceof ReferenceError, 'Calling switchConfigSubtab before activeConfigSubtab declaration MUST throw ReferenceError');
  assert.ok(
    result.errorCaught.message.includes('activeConfigSubtab') || result.errorCaught.message.includes('before initialization'),
    `Error message must indicate TDZ error: ${result.errorCaught.message}`
  );
});

test('WI-24: warning log is emitted if sessionStorage restore encounters an exception', () => {
  const tabTranslateBtn = makeFakeElement('tab-translate', { 'aria-selected': 'true' }, ['tab-btn', 'active']);
  const tabConfigBtn = makeFakeElement('tab-config', { 'aria-selected': 'false' }, ['tab-btn']);
  const tabPanels = {
    'tab-translate': makeFakeElement('tabpanel-translate', {}, []),
    'tab-config': makeFakeElement('tabpanel-config', {}, ['hidden'])
  };
  const subtabButtons = [makeFakeElement('subtab-connect', { 'aria-selected': 'true', 'data-subtab': 'connect' }, ['subtab-btn', 'active'])];
  const configSubpanels = { connect: makeFakeElement('config-section-connect', {}, []) };

  const throwingSessionStorage = {
    getItem() { throw new Error('Simulated sessionStorage security error'); },
    setItem() {}
  };

  const warnings = [];
  const fakeConsole = {
    warn: (...args) => { warnings.push(args); },
    error: () => {},
    log: () => {}
  };

  const switchTabStart = popupSrc.indexOf('function switchTab(targetTabId');
  const migrationEnd = popupSrc.indexOf('function renderFavoritesSection()', switchTabStart);
  const executableSlice = popupSrc.slice(switchTabStart, migrationEnd);

  const context = vm.createContext({
    tabButtons: [tabTranslateBtn, tabConfigBtn],
    tabPanels,
    subtabButtons,
    configSubpanels,
    sessionStorage: throwingSessionStorage,
    console: fakeConsole,
    activeTabNav: 'tab-translate',
    btnClearLog: null,
    statusStrip: null,
    tabList: makeFakeElement('tab-list'),
    logList: null,
    btnTranslate: null,
    sendMsg: async () => ({ ok: true }),
    loadErrorLog: () => {},
    renderFavoritesSection: () => {},
    currentUiLocale: 'vi',
    t: (_loc, key) => key
  });

  // Must not crash completely, but MUST log warning
  assert.doesNotThrow(() => {
    vm.runInContext(executableSlice, context);
  });

  assert.equal(warnings.length, 1, 'Exactly one warning should be logged on restore error');
  assert.ok(warnings[0][0].includes('[popup] Failed to restore remembered tab:'), 'Warning message must identify failed tab restore');
  assert.equal(warnings[0][1].message, 'Simulated sessionStorage security error');
});

