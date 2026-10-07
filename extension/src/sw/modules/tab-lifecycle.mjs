// WebMCP Translator Kit — Background Module: Tab Lifecycle & Dispatch Policy
// Manages tab closed/navigated cleanup and pre-dispatch policy checks.

import { normalizeOrigin } from '../../consent.mjs';
import { createTypedError } from './security.mjs';
import { CURRENT_DATA_CONSENT_VERSION } from '../../settings.mjs';

export function createTabLifecycleManager({
  activeBatchControllers,
  tabEpochs,
  tabQueues,
  resolveTabPolicy,
  getStoredSites,
  getStoredTabOverrides,
  getStoredSettings,
  checkDataConsentAccepted,
  getEffectivePolicy,
  permissionContains,
  getConfigRevision
}) {
  async function handleTabRemoved(tabId) {
    try {
      const idNum = Number(tabId);
      for (const [reqId, active] of activeBatchControllers.entries()) {
        if (active.tabId === tabId || active.tabId === idNum) {
          try { active.controller.abort('tab_closed'); } catch {}
          activeBatchControllers.delete(reqId);
        }
      }
      tabEpochs.delete(tabId);
      tabEpochs.delete(idNum);
      const queue = tabQueues.get(tabId) || tabQueues.get(idNum);
      if (queue && queue.length > 0) {
        for (const entry of queue) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.resolve(createTypedError('ABORTED', 'Tab was closed', false, { reason: 'tab_closed' }));
        }
        tabQueues.delete(tabId);
        tabQueues.delete(idNum);
      }
      if (!chrome.storage || !chrome.storage.session) return;
      const res = await chrome.storage.session.get(['tab_overrides']);
      const overrides = res.tab_overrides || {};
      const key = String(tabId);
      if (key in overrides) {
        delete overrides[key];
        await chrome.storage.session.set({ tab_overrides: overrides });
      }
      await chrome.storage.session.remove([`rate:tab:${tabId}`, `rate:tab:${idNum}`]);
    } catch {
      // Ignore cleanup error
    }
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    try {
      if (changeInfo && changeInfo.status === 'loading') {
        const idNum = Number(tabId);
        const info = await resolveTabPolicy(idNum);

        if (!info) {
          // Tab closed / gone -> delegate to full removal cleanup
          await handleTabRemoved(idNum);
          return;
        }

        if (info.url === null) {
          // Fail-closed: URL cannot be verified during navigation
          for (const [reqId, active] of activeBatchControllers.entries()) {
            if (active.tabId === idNum || active.tabId === tabId) {
              try { active.controller.abort('navigation'); } catch {}
              activeBatchControllers.delete(reqId);
            }
          }
          const queue = tabQueues.get(idNum) || tabQueues.get(tabId);
          if (queue && queue.length > 0) {
            for (const entry of queue) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'ABORTED',
                'Tab navigated while translation was queued',
                false,
                { reason: 'navigation', tabId: idNum }
              ));
            }
            tabQueues.delete(idNum);
            tabQueues.delete(tabId);
          }
          return;
        }

        const curOrigin = normalizeOrigin(info.url);
        if (!curOrigin) {
          for (const [reqId, active] of activeBatchControllers.entries()) {
            if (active.tabId === idNum || active.tabId === tabId) {
              try { active.controller.abort('navigation'); } catch {}
              activeBatchControllers.delete(reqId);
            }
          }
          const queue = tabQueues.get(idNum) || tabQueues.get(tabId);
          if (queue && queue.length > 0) {
            for (const entry of queue) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'ABORTED',
                'Tab navigated while translation was queued',
                false,
                { reason: 'navigation', tabId: idNum }
              ));
            }
            tabQueues.delete(idNum);
            tabQueues.delete(tabId);
          }
          return;
        }

        // Origin check: abort only controllers and queue entries whose origin does NOT match curOrigin
        for (const [reqId, active] of activeBatchControllers.entries()) {
          if (active.tabId === idNum || active.tabId === tabId) {
            if (!active.origin || active.origin !== curOrigin) {
              try { active.controller.abort('navigation'); } catch {}
              activeBatchControllers.delete(reqId);
            }
          }
        }
        const queue = tabQueues.get(idNum) || tabQueues.get(tabId);
        if (queue && queue.length > 0) {
          const preserved = [];
          for (const entry of queue) {
            if (entry.origin && entry.origin !== curOrigin) {
              if (entry.timer) clearTimeout(entry.timer);
              entry.resolve(createTypedError(
                'ABORTED',
                'Tab navigated while translation was queued',
                false,
                { reason: 'navigation', tabId: idNum, originalOrigin: entry.origin, newOrigin: curOrigin }
              ));
            } else {
              preserved.push(entry);
            }
          }
          if (preserved.length > 0) {
            tabQueues.set(idNum, preserved);
          } else {
            tabQueues.delete(idNum);
            tabQueues.delete(tabId);
          }
        }
      }
    } catch {
      // Ignore navigation update cleanup error
    }
  }

  async function verifyTabDispatchPolicy({ tabId, origin, epoch, expectedConfigRevision }) {
    const curConfigRevision = getConfigRevision();
    if (expectedConfigRevision !== undefined && expectedConfigRevision !== curConfigRevision) {
      return {
        ...createTypedError(
          'ABORTED',
          'Translation batch discarded due to configuration change',
          false,
          { batchConfigRevision: expectedConfigRevision, currentConfigRevision: curConfigRevision }
        ),
        configRevision: expectedConfigRevision,
        currentConfigRevision: curConfigRevision
      };
    }

    if (typeof tabId === 'number') {
      if (epoch !== undefined && tabEpochs.has(tabId)) {
        const curTabEpoch = tabEpochs.get(tabId);
        if (epoch < curTabEpoch) {
          return createTypedError(
            'ABORTED',
            'Pending translation cancelled by new epoch',
            false,
            { reason: 'epoch_changed', tabId, epoch, currentEpoch: curTabEpoch }
          );
        }
        if (epoch > curTabEpoch) {
          tabEpochs.set(tabId, epoch);
        }
      }

      const tabInfo = await resolveTabPolicy(tabId);
      if (!tabInfo) {
        return createTypedError(
          'ABORTED',
          'Tab was closed before dispatch',
          false,
          { reason: 'tab_closed' }
        );
      }

      const curOrigin = tabInfo.url ? normalizeOrigin(tabInfo.url) : null;
      if (!curOrigin) {
        return createTypedError(
          'ABORTED',
          'Tab URL could not be verified before dispatch',
          false,
          { reason: 'tab_url_unverifiable', tabId }
        );
      }

      if (origin && curOrigin !== origin) {
        return createTypedError(
          'ABORTED',
          'Tab navigated before dispatch',
          false,
          { reason: 'navigation', originalOrigin: origin, currentOrigin: curOrigin }
        );
      }

      // Consent check: tab override > site enabled > default OFF (covers N4 race)
      let sites, tabOverrides, settings;
      try {
        sites = await getStoredSites();
        tabOverrides = await getStoredTabOverrides();
        settings = await getStoredSettings();
      } catch (err) {
        return createTypedError('CONSENT_STATE_UNAVAILABLE', 'Consent state unavailable', false, {
          tabId,
          reason: err?.message || 'Storage read error'
        });
      }

      if (!checkDataConsentAccepted(settings)) {
        return createTypedError(
          'DATA_CONSENT_REQUIRED',
          'Data consent is not accepted',
          false,
          { dataConsentVersion: CURRENT_DATA_CONSENT_VERSION }
        );
      }

      const siteEnabled = Boolean(sites[origin || curOrigin]);
      const tabOverride = tabOverrides[String(tabId)] || null;
      const effective = getEffectivePolicy({ tabOverride, siteEnabled });

      if (effective !== 'on') {
        return createTypedError(
          'OPT_IN_REQUIRED',
          'Translation is disabled (tab explicit OFF, site OFF, or default OFF)',
          false,
          {
            tabId,
            origin: origin || curOrigin,
            scope: tabOverride ? 'tab' : 'site',
            effectiveConsent: 'off'
          }
        );
      }

      // Permission check
      const hasPerm = await permissionContains(origin || curOrigin);
      if (!hasPerm) {
        return createTypedError(
          'PERMISSION_REQUIRED',
          'Host permission not granted for site origin',
          false,
          {
            origin: origin || curOrigin,
            permissionType: 'host'
          }
        );
      }
    }

    return { valid: true };
  }

  return {
    handleTabRemoved,
    handleTabUpdated,
    verifyTabDispatchPolicy
  };
}
