// WebMCP Translator Kit — Background Module: Storage Access & Settings
// Encapsulates TRUSTED_CONTEXTS storage initialization, settings migration, and entity getters.

export function createStorageManager({
  SETTINGS_VERSION,
  migrateSettings,
  updateProviderConcurrency,
  createTypedError,
  serializeSettingsWrite,
  isTestMode = () => false
}) {
  let storageAccessInitialized = false;
  let storageAccessFailed = false;
  let currentAccessLevel = 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  let _forceStorageAccessFailure = false;

  function resetStorageAccessStateForTest() {
    storageAccessInitialized = false;
    storageAccessFailed = false;
  }

  function setTestStorageAccessFailure(enabled) {
    if (!isTestMode()) return;
    _forceStorageAccessFailure = Boolean(enabled);
  }

  async function ensureStorageAccess() {
    if (storageAccessInitialized && !storageAccessFailed) return;

    if (isTestMode() && _forceStorageAccessFailure) {
      currentAccessLevel = 'UNAVAILABLE';
      storageAccessInitialized = false;
      storageAccessFailed = true;
      throw createTypedError(
        'KEY_ACCESS_UNAVAILABLE',
        'Test-injected storage access failure',
        false,
        { reason: 'test hook' }
      );
    }

    if (
      typeof chrome === 'undefined' ||
      !chrome.storage ||
      !chrome.storage.local ||
      typeof chrome.storage.local.setAccessLevel !== 'function'
    ) {
      currentAccessLevel = 'UNAVAILABLE';
      storageAccessInitialized = false;
      storageAccessFailed = true;
      throw createTypedError(
        'KEY_ACCESS_UNAVAILABLE',
        'chrome.storage.local.setAccessLevel is not available',
        false,
        { reason: 'setAccessLevel method missing' }
      );
    }

    try {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      currentAccessLevel = 'TRUSTED_CONTEXTS';
      storageAccessInitialized = true;
      storageAccessFailed = false;
    } catch (err) {
      if (err && typeof err.message === 'string' && /already/i.test(err.message)) {
        currentAccessLevel = 'TRUSTED_CONTEXTS';
        storageAccessInitialized = true;
        storageAccessFailed = false;
        return;
      }
      currentAccessLevel = 'UNAVAILABLE';
      storageAccessInitialized = false;
      storageAccessFailed = true;
      throw createTypedError(
        'KEY_ACCESS_UNAVAILABLE',
        'Could not establish TRUSTED_CONTEXTS access level on storage',
        false,
        { reason: err && err.message ? String(err.message) : 'setAccessLevel failed' }
      );
    }
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.getAccessLevel !== 'function') {
    chrome.storage.local.getAccessLevel = async () => currentAccessLevel;
  }

  async function getStoredSettings({ persistMigration = true } = {}) {
    await ensureStorageAccess();
    const res = await chrome.storage.local.get(['settings']);
    const raw = res.settings;
    const migrated = migrateSettings(raw);
    if (migrated.providerConcurrency) {
      updateProviderConcurrency(migrated.providerConcurrency);
    }
    if ((!raw || raw.version !== SETTINGS_VERSION) && persistMigration) {
      return serializeSettingsWrite(async () => {
        await ensureStorageAccess();
        const latestRaw = (await chrome.storage.local.get(['settings'])).settings;
        const latestMigrated = migrateSettings(latestRaw);
        if (latestMigrated.providerConcurrency) {
          updateProviderConcurrency(latestMigrated.providerConcurrency);
        }
        if (!latestRaw || latestRaw.version !== SETTINGS_VERSION) {
          await chrome.storage.local.set({ settings: latestMigrated });
        }
        return latestMigrated;
      });
    }
    return migrated;
  }

  async function getStoredApiKey() {
    await ensureStorageAccess();
    const res = await chrome.storage.local.get(['api_key']);
    return res.api_key || '';
  }

  async function getStoredSites() {
    await ensureStorageAccess();
    const res = await chrome.storage.local.get(['sites']);
    return res.sites || {};
  }

  async function getStoredRegistrations() {
    await ensureStorageAccess();
    const res = await chrome.storage.local.get(['registrations']);
    return res.registrations || {};
  }

  async function getStoredTabOverrides() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
      throw createTypedError('CONSENT_STATE_UNAVAILABLE', 'chrome.storage.session unavailable', false);
    }
    const res = await chrome.storage.session.get(['tab_overrides']);
    return res.tab_overrides || {};
  }

  return {
    ensureStorageAccess,
    getStoredSettings,
    getStoredApiKey,
    getStoredSites,
    getStoredRegistrations,
    getStoredTabOverrides,
    resetStorageAccessStateForTest,
    setTestStorageAccessFailure,
    getCurrentAccessLevel: () => currentAccessLevel
  };
}
