# WebMCP Translator Kit — Frozen Contract Artifact

- **Contract Version**: `webmcp-translator-contract/1`
- **Scope**: Direct Mode runtime interface, JSON schemas, typed error definitions, initial default limits, and MV3 service worker lifecycle rules.
- **Write-Set**: `contract/`
- **Canonical Alignment**: interface khớp plan canonical §contract (đã đối chiếu 2026-09-30).

## 1. Overview & Scope

This contract defines the authoritative, frozen specification for **MVP Direct Mode** of the WebMCP Translator Kit. Under Direct Mode, the translator browser extension communicates directly from its MV3 background service worker to an OpenAI-compatible endpoint via user-configured Base URL and API key.

The interface definitions (`TranslationItem`, `TranslationResult`, `TranslationProvider`) strictly match `context/plan.md §Contract và interface cố định cho DOM core` (interface khớp plan canonical §contract (đã đối chiếu 2026-09-30)).

### Relationship with Gateway Mode

| Dimension | MVP Direct Mode (This Contract) | Gateway Mode (Deferred Milestone) |
| --- | --- | --- |
| **Topology** | Extension background service worker calls OpenAI-compatible HTTP API directly. | Extension connects to local Gateway via WebSocket/reverse RPC. |
| **Credentials** | API key stored locally in extension `chrome.storage.local` (`TRUSTED_CONTEXTS`, background-only). | Ephemeral session token brokered via Vault Kit (`api_token.token`). |
| **Role Binding** | Independent extension; no inter-extension connection or handshake. | Registry binds `(profileId, role)` for automation and translator clients. |
| **waitForStable** | Handled via client-side patch throttling (`patchMinIntervalMs = 200`). | Coordinated via Gate C1 (`commandActive`/`commandIdle` signals). |
| **Quota Governance** | Enforced client-side via sliding window counters in `chrome.storage.session`. | Centralized budget and quota governance managed by Gateway. |
| **Status** | **Canonical MVP Baseline**. | **Deferred Milestone** with separate future contract, plan, and DoD. |

---

## 2. Freeze Note

The numeric parameters and behavioral limits recorded in `defaults.json` and `direct-interface.md` constitute the **frozen initial defaults** established in Phase P0 (sourced from `p0-handoff.md §1.5/§1.8` and `context/plan.md §quyết định/§contract`).

### Initial Defaults & Measurement Lifecycle

1. **Initial Defaults (Phase P0 Freeze)**:
   - Provider HTTP timeout: `20000` ms (20 s).
   - Batch bounds: maximum `32` items per batch, `16384` bytes (16 KiB) UTF-8 source text per batch, `65536` bytes (64 KiB) response size cap.
   - Sliding window duration: `60` seconds.
   - Tab rate limits: `4` batches / 60 s, `12000` Unicode code points / 60 s.
   - Site rate limits: `12` batches / 60 s, `36000` Unicode code points / 60 s.
   - Translation cache: memory-only, TTL `600000` ms (10 minutes), `500` entries, `2097152` bytes (2 MiB).
   - `listModels` cache: memory-only, TTL `300000` ms (5 minutes), keyed by Base URL and API key context.
   - DOM patch throttling: `patchMinIntervalMs = 200` ms.
   - Debounce window: `200`–`300` ms.
   - Concurrency: maximum `2` concurrent provider requests.
   - Retry limits: maximum `2` retries (initial delay `500` ms, max delay `1000` ms, jitter ratio `0.2`).

2. **Phase P1' Verification & Initial Measurements**:
   - Implement the direct OpenAI-compatible adapter, in-memory queue, debounce, and sliding-window rate counters in `chrome.storage.session`.
   - Measure batch count on a reference viewport containing 20 Text nodes.
   - Target: $\le 4$ batches within a 60-second window under default tab settings (ideally 1 batch of $\le 32$ items). If fragmentation causes $> 4$ batches and triggers rate limiting, debounce/batching must be tuned or default limits adjusted with documented cost receipts before passing gate P1'.

3. **Phase P3' Production Hardening & Full Stability Measurements**:
   - Re-measure batch count, throughput, and p50/p95 latency from text viewport entry to DOM patch.
   - Re-measure all 6 implicit-wait stability patterns (`click`, `type`, `readPage`, `clickByRef`, `typeByRef`, `snapshot`/`waitStable`) with throttle `patchMinIntervalMs = 200` ms against the 150 ms poll interval of `waitForStable` (verifying `maxPerPoll = 1` remains strictly below the threshold of 2).
   - Lowering `patchMinIntervalMs` below 200 ms is prohibited without empirical measurement receipts in Phase P3'.

---

## 3. Directory Structure

```
contract/
├── README.md               # Scope, version, freeze note, and lifecycle map (this file)
├── direct-interface.md     # Fixed TypeScript interface, validator, retry policy, error taxonomy
├── defaults.json           # Machine-readable initial defaults and limits
├── lifecycle.md            # MV3 service worker lifecycle, storage isolation, and fail-closed rules
├── schemas/                # Canonical JSON Schemas (Draft-07, additionalProperties: false)
│   ├── translateBatch.request.schema.json
│   ├── translateBatch.result.schema.json
│   ├── listModels.result.schema.json
│   └── error.schema.json
└── check.mjs               # Zero-dependency verification script asserting contract integrity
```
