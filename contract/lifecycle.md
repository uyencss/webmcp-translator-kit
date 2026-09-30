# MV3 Service Worker Lifecycle & State Isolation Contract

- **Contract Version**: `webmcp-translator-contract/1`
- **Component**: `contract/lifecycle.md`
- **Scope**: Manifest V3 service worker lifecycle, storage persistence boundaries, restart reconciliation, and security isolation invariants.

---

## 1. MV3 Service Worker Execution Model

Under Chrome Manifest V3, the background service worker is ephemeral:
- Chrome terminates the worker after approximately 30 seconds of inactivity.
- Any in-memory state (JavaScript heap, object variables, active timers, unpersisted promises) is completely lost upon termination.
- Chrome restarts the service worker on demand when an event (runtime message, action popup click, tab navigation, or external alarm) arrives.

To maintain correctness, privacy, and user consent, the WebMCP Translator Kit partitions state into two tiers:
1. **Session-Persistent Tier** (`chrome.storage.session`): Survives service worker restarts during a browser session.
2. **Ephemeral Memory Tier** (heap): Purposely discarded upon service worker restart.

```
+-------------------------------------------------------------------------+
|                              CHROME BROWSER                             |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |             chrome.storage.session (Survives SW Restart)          |  |
|  |  * Tab Overrides (explicit "on" | "off" per tabId)                |  |
|  |  * Rate Limit Sliding Window Counters (Tab & Site, 60s window)    |  |
|  +-------------------------------------------------------------------+  |
|                                ^                                        |
|                                | read / write                           |
|                                v                                        |
|  +-------------------------------------------------------------------+  |
|  |             MV3 Background Service Worker (Ephemeral Heap)         |  |
|  |                                                                   |  |
|  |  [Startup Invariant]                                              |  |
|  |  * Re-assert storage.local accessLevel: TRUSTED_CONTEXTS          |  |
|  |                                                                   |  |
|  |  [Ephemeral State - Discarded on SW Restart]                      |  |
|  |  * In-memory Request Queue & retryAfterMs Timers                  |  |
|  |  * Translation Memory Cache (TTL 10m / 500 entries / 2 MiB)        |  |
|  |  * listModels Memory Cache (TTL 5m)                               |  |
|  +-------------------------------------------------------------------+  |
|                                |                                        |
|               messages         | (sender metadata verified)             |
|                                v                                        |
|  +-------------------------------------------------------------------+  |
|  |              Content Script (ISOLATED World, Top Frame)           |  |
|  |  * Pending request reconciliation -> DROPPED_ON_RESTART           |  |
|  |  * Never receives or accesses API keys / credentials              |  |
|  +-------------------------------------------------------------------+  |
+-------------------------------------------------------------------------+
```

---

## 2. Session-Persistent Storage (`chrome.storage.session`)

### 2.1 Tab Overrides & Consent Precedence
- **Precedence Hierarchy**:
  $$\text{Tab Override} > \text{Site Setting} > \text{Default (OFF)}$$
- Default policy is strictly **OFF**.
- When a user explicitly toggles translation in the popup for an active tab, the choice is saved to `chrome.storage.session` keyed by `tab_${tabId}`.
- **The Core Invariant**:
  > **A tab explicitly set to OFF NEVER automatically translates after a service worker restart, even if the site is set to ON.**
- Tab overrides are automatically deleted when the tab is closed via `chrome.tabs.onRemoved`.
- All session storage entries are cleared when the browser application exits.

### 2.2 Rate Limit Sliding Window Counters
- Sliding window counters for tabs (`rate_tab_${tabId}`) and sites (`rate_site_${siteOrigin}`) are maintained in `chrome.storage.session`.
- Each record stores timestamped batch counts and Unicode code point counts within the current 60-second window.
- Persisting counters in `chrome.storage.session` prevents quota bypass by deliberately or accidentally letting the service worker restart.

### 2.3 Storage Failure Fail-Closed Rule
- If `chrome.storage.session` encounters an I/O error or becomes unreadable:
  1. The background service worker MUST immediately fail closed.
  2. Consent check failure aborts the batch with typed error `CONSENT_STATE_UNAVAILABLE`.
  3. Rate limiter check failure aborts the batch before network dispatch with typed error `RATE_STATE_UNAVAILABLE`.
  4. Quota counters MUST NOT be reset to 0 upon storage errors.

---

## 3. Ephemeral In-Memory State & SW Restart Reconciliation

### 3.1 Queues and Timers
- The pending batch queue and `retryAfterMs` delay timers reside strictly in service worker memory.
- When the service worker is terminated by Chrome:
  - All queued batches and pending delay timers are destroyed.
  - In-flight HTTP requests are terminated.

### 3.2 Terminal State: `DROPPED_ON_RESTART`
- When a service worker starts up fresh:
  - It does NOT restore or execute pending batches from previous worker lifecycles.
  - Content scripts tracking pending request IDs reconcile with the new worker instance: if an in-flight request ID is unknown to the fresh worker, it is transitioned to the terminal status `DROPPED_ON_RESTART`.
  - Content scripts MUST NOT mark affected nodes as translated, nor may they trigger automatic retry loops.
  - Ghost provider calls are strictly prohibited.
  - Recovery: subsequent user scrolling or user interaction generates fresh batch requests subject to current consent and quota validation.

### 3.3 Cache Ephemerality
- Both the translation cache (TTL 10 min) and `listModels` discovery cache (TTL 5 min) are held purely in memory.
- Service worker termination clears these caches.
- Cache loss upon restart results merely in a cache miss (requiring a network fetch) and does not compromise translation correctness or system invariants.

---

## 4. Security & Isolation Invariants

### 4.1 Storage Access Level: `TRUSTED_CONTEXTS`
- The extension API key is persisted in `chrome.storage.local`.
- **Mandatory Startup Hook**:
  Every time the background service worker starts up—prior to serving any translation request, invoking `listModels()`, or accepting settings updates—it MUST execute:
  ```javascript
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  ```
- **Fail-Closed Gate**:
  If `setAccessLevel` throws an error or is unsupported:
  1. All translation and discovery operations are suspended immediately.
  2. Saving new keys is rejected.
  3. The popup UI reports typed error `KEY_ACCESS_UNAVAILABLE`.
  4. Under no circumstances may content scripts be permitted to access `chrome.storage.local`.

### 4.2 Sender Verification
- The background service worker MUST authenticate all incoming messages using Chrome's native `MessageSender` properties:
  - `sender.tab.id`
  - `sender.frameId` (enforcing top frame `frameId === 0`)
  - `sender.url` (verifying origin matches opted-in site)
- Tab IDs, origins, or URLs provided within the payload body are completely untrusted and MUST be ignored.
- Translation responses are returned strictly to the verified `sender.tab.id`.
