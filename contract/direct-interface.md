# Direct Mode Interface Specification

- **Contract Version**: `webmcp-translator-contract/1`
- **Component**: `contract/direct-interface.md`
- **Scope**: Canonical TypeScript interface, batch validator, retry policy, error taxonomy, and initial defaults table.

---

## 1. DirectTranslatorProvider Interface

The Direct Mode adapter runs inside the background service worker of the WebMCP Translator extension. It encapsulates communication with an OpenAI-compatible 9router endpoint via HTTP.

```typescript
export type TranslationItem = {
  id: string;          // Text-node ID chỉ có nghĩa trong document hiện tại
  documentId: string;  // Document or frame identifier
  revision: number;    // Monotonically increasing revision counter (>= 0)
  text: string;        // Source text to translate (Unicode code points counted)
  context?: string;    // Optional surrounding context or element tag hint
};

export type TranslationResult = {
  id: string;          // Must strictly match input item id
  revision: number;    // Must strictly match input item revision
  text: string;        // Translated text output
};

export interface TranslateBatchInput {
  items: TranslationItem[];
  sourceLanguage: string; // BCP-47 tag or 'auto'
  targetLanguage: string; // Target language code (e.g., 'vi')
  model: string;          // Model ID pinned by user (e.g., 'gpt-4o-mini')
  signal: AbortSignal;    // Mandatory cancellation signal (timeout or lifecycle abort)
  baseURL?: string;       // Optional per-call override for fallback attempts
  apiKey?: string;        // Optional per-call override for fallback attempts
}

export interface TranslationProvider {
  /**
   * Discovers available models from provider.
   * Method: GET {baseURL}/models
   * Headers: Authorization: Bearer {apiKey}
   * Cache: In-memory TTL 5 minutes keyed by (baseURL, apiKeyContext).
   * Invalidation: Immediately on baseURL change, apiKey change, or permission change.
   * Fallback: No automatic model fallback when discovery fails or pinned model is missing.
   */
  listModels(): Promise<{ models: { id: string }[] }>;

  /**
   * Translates a batch of text nodes.
   * Method: POST {baseURL}/chat/completions
   * Headers: Authorization: Bearer {apiKey}, Content-Type: application/json
   * Body: { model, messages, stream: false }
   */
  translateBatch(input: {
    items: TranslationItem[];
    sourceLanguage: string;
    targetLanguage: string;
    model: string;
    signal: AbortSignal;
  }): Promise<{ results: TranslationResult[] }>;
}

// Backward-compatible aliases
export type TranslateItem = TranslationItem;
export type TranslationResultItem = TranslationResult;
export type TranslateBatchRequest = TranslateBatchInput;
export type TranslateBatchResponse = { results: TranslationResult[] };
export type DirectTranslatorProvider = TranslationProvider;

export interface ModelInfo {
  id: string;
}

export interface ListModelsResponse {
  models: ModelInfo[];
}
```

---

## 2. Batch Validator Contract

Every translation response received from the 9router provider MUST be validated by the background service worker before passing results to the DOM patcher:

1. **Bijection Guarantee**:
   - The response `results` array MUST have the exact same length as `items`.
   - Each result MUST correspond 1:1 with an input item by matching `id` and `revision`.
   - **No omitted items**: If any input item is missing from `results`, the batch fails with `INVALID_SCHEMA`.
   - **No extra items**: If any unexpected item is present in `results`, the batch fails with `INVALID_SCHEMA`.
   - **No duplicate items**: Each `id` must appear exactly once in `results`.
2. **Byte & Character Bounds Enforcement**:
   - Source text in request must not exceed `batch.maxItems` (64 items) or `batch.maxSourceBytesUtf8` (24,576 bytes). Violations fail pre-dispatch with `CAP_EXCEEDED`.
   - Raw HTTP response body must not exceed `batch.maxResponseBytes` (65,536 bytes). If the Content-Length or stream chunk exceeds this cap, abort immediately with `CAP_EXCEEDED`.
3. **Timeout & Abort**:
   - Requests are bound to an `AbortController` with a hard timeout of `provider.timeoutMs` (60,000 ms; điều chỉnh 2026-09-30 R-49/R-50 theo số đo batch thật).
   - If the timeout expires before response headers and body are fully parsed, abort and throw `TIMEOUT`.
   - If user navigates away, changes settings, turns off translation, closes tab, or the node detaches, abort and throw `ABORTED`.
4. **Per-Chunk Recovery (client-side)**:
   - A single failed chunk MUST NOT abort the whole run. The client retries the chunk once (`recovery.contentRetryPerChunk = 1`, delay `recovery.contentRetryDelayMs = 800` ms, identical payload).
   - If the retry also fails and the chunk has more than `recovery.splitMinItems` (8) items, the client halves the chunk and retries each half (`recovery.splitMaxDepth = 2`), then continues with the remaining chunks.
   - The run reports `{ collected, applied, failed }`. Items that failed remain untranslated; a second user-triggered run re-collects only untranslated nodes (already-applied nodes are skipped) and resumes from there.
5. **Model Pinning, Fallback Chain & Logging Hygiene**:
   - The adapter MUST request the exact model requested for that call. Automatic silent fallback within the adapter itself is prohibited (pinned 1 ID/call).
   - The background service worker coordinates sequential fallback strictly according to the user-configured fallback chain (`[primary, ...fallbacks]`, max 3 attempts) upon `NETWORK`, `TIMEOUT`, or `HTTP_5xx` errors. Each fallback may define a custom `baseURL` and distinct API key; missing fields inherit from the primary configuration, with API key inheritance strictly restricted to fallbacks sharing the exact same origin as the primary configuration (fallbacks with different origins lacking a distinct key are skipped; skipped fallbacks are surfaced in error envelope `details.skippedFallbacks` and in `GET_SETTINGS.fallbackWarnings`).
   - Stop-list errors (`HTTP_401`, `HTTP_403`, `HTTP_404`, `HTTP_429`, policy, consent, rate, schema, abort) terminate immediately without fallback.
   - Provider responses, receipts, and internal envelopes record `requestedModel`, `actualModel`, `fallbackIndex`, and `actualBaseURLHost`.
   - **Privacy Invariant**: NEVER log page text, source snippets, translated snippets, or API keys in browser consoles, receipts, or error payloads.

---

## 3. Complete Typed Error Taxonomy

Every error produced by the Direct Mode pipeline MUST map to a typed error object conforming to `schemas/error.schema.json`.

| Error Code | Category | Meaning & Trigger Condition | Scope / Payload Fields |
| --- | --- | --- | --- |
| `MISSING_CONFIG` | Config | Base URL, API key, or target model has not been set by user. | `missing: ("baseURL" \| "apiKey" \| "model")[]` |
| `PERMISSION_REQUIRED` | Security | Origin host permission for Base URL or site has not been granted or was revoked. | `origin: string, permissionType: "host" \| "site"` |
| `KEY_ACCESS_UNAVAILABLE` | Security | `TRUSTED_CONTEXTS` storage access level could not be established on service worker start. | `reason: string` |
| `CONSENT_STATE_UNAVAILABLE` | Lifecycle | Tab override or opt-in state could not be read from `chrome.storage.session`. Fails closed. | `tabId: number, reason: string` |
| `RATE_STATE_UNAVAILABLE` | Lifecycle | Sliding window rate counters in `chrome.storage.session` could not be read or written. Fails closed. | `scope: "tab" \| "site", targetId: string, reason: string` |
| `RATE_LIMITED` | Rate | Local 60 s sliding window quota exceeded for tab or site (batches or code points). | `scope: "tab" \| "site", limit: number, used: number, retryAfterMs: number, metric: "batches" \| "code_points"` |
| `CAP_EXCEEDED` | Guard | Hard request/response cap exceeded (`items`, `requestBytes`, or `responseBytes`). | `capType: "items" \| "requestBytes" \| "responseBytes", limit: number, actual: number` |
| `SITE_NOT_ALLOWED` | Consent | Current site origin is not opted in or protocol is not HTTP(S). | `origin: string` |
| `OPT_IN_REQUIRED` | Consent | Translation is disabled (tab explicit OFF, site OFF, or default OFF). | `tabId: number, effectiveConsent: "off"` |
| `MODEL_NOT_ALLOWED` | Provider | Selected model is rejected by configuration policy or validation. | `model: string, reason?: string` |
| `NETWORK` | Network | Transient network failure, DNS resolution failure, or TCP connection reset. | `message: string` |
| `TIMEOUT` | Network | Provider request did not complete within `provider.timeoutMs` (60 s). | `timeoutMs: number` |
| `ABORTED` | Lifecycle | Operation cancelled via AbortSignal (navigation, config change, or SW shutdown). | `reason: string` |
| `INVALID_SCHEMA` | Validation | Provider returned malformed JSON, invalid schema, or mismatched item IDs/revisions. | `schemaErrors: string[]` |
| `DROPPED_ON_RESTART` | Lifecycle | Pending queued or in-flight request was dropped because the service worker restarted. | `batchId: string` |
| `HTTP_401` | HTTP | Provider returned 401 Unauthorized (invalid API key). | `status: 401, statusText: string` |
| `HTTP_403` | HTTP | Provider returned 403 Forbidden (spend cap reached, forbidden origin, or model blocked). | `status: 403, statusText: string` |
| `HTTP_404` | HTTP | Provider returned 404 Not Found (invalid endpoint path or model name). | `status: 404, statusText: string` |
| `HTTP_429` | HTTP | Remote 9router rate limit exceeded (remote 429). | `status: 429, retryAfterMs?: number` |
| `HTTP_5xx` | HTTP | Provider returned a server error (HTTP 500–599). | `status: number, statusText: string` |

---

## 4. Retry Policy

The background service worker applies strict, bounded retry rules:

1. **Eligible Errors**:
   - Only transient network failures (`NETWORK`), remote HTTP 429 (`HTTP_429`), and remote server errors (`HTTP_5xx`) are eligible for retry.
2. **Retry Ceiling**:
   - Maximum **2 retry attempts** beyond the initial call (total 3 attempts).
3. **Backoff & Jitter**:
   - Attempt 1: Initial call.
   - Attempt 2 (Retry 1): Delay `provider.retryInitialDelayMs` (500 ms) $\times (1 \pm \text{jitter})$.
   - Attempt 3 (Retry 2): Delay `provider.retryMaxDelayMs` (1,000 ms) $\times (1 \pm \text{jitter})$.
   - Randomized jitter: $\pm 20\%$ (`provider.retryJitterRatio = 0.2`).
4. **Remote Retry-After**:
   - If the provider response includes an HTTP `Retry-After` header (in seconds or timestamp), and the requested delay is longer than the scheduled backoff delay, the client MUST respect the `Retry-After` value up to a hard ceiling of 10,000 ms. If `Retry-After` exceeds 10,000 ms, the request fails immediately with `HTTP_429`.
5. **Strictly Non-Retryable Errors**:
   - NEVER retry client validation errors (`INVALID_SCHEMA`, `CAP_EXCEEDED`).
   - NEVER retry permission or configuration errors (`MISSING_CONFIG`, `PERMISSION_REQUIRED`, `KEY_ACCESS_UNAVAILABLE`, `SITE_NOT_ALLOWED`, `OPT_IN_REQUIRED`, `MODEL_NOT_ALLOWED`).
   - NEVER retry local client-side rate limits (`RATE_LIMITED`). When a batch triggers local `RATE_LIMITED`, it is NOT immediately retried over HTTP; it is retained in the in-memory bounded queue and rescheduled after `retryAfterMs`.

---

## 5. Frozen Initial Defaults

The table below defines the initial default values frozen for Phase P0. These values match `defaults.json` exactly.

| Parameter | JSON Key | Value | Unit / Description |
| --- | --- | --- | --- |
| Provider Timeout | `provider.timeoutMs` | `60000` | ms (60 s; điều chỉnh 2026-09-30 R-50) |
| listModels Timeout | `provider.listModelsTimeoutMs` | `15000` | ms (15 s) |
| Retry on TIMEOUT | `provider.retryOnTimeout` | `1` | lần (payload idempotent) |
| Max Retries | `provider.maxRetries` | `2` | Additional retries (total 3 attempts) |
| Retry Initial Delay | `provider.retryInitialDelayMs` | `500` | ms |
| Retry Max Delay | `provider.retryMaxDelayMs` | `1000` | ms (1 s) |
| Retry Jitter Ratio | `provider.retryJitterRatio` | `0.2` | +/- 20% randomized jitter |
| Max Items Per Batch | `batch.maxItems` | `64` | items (điều chỉnh 2026-09-30 R-50) |
| Max Source UTF-8 Bytes | `batch.maxSourceBytesUtf8` | `24576` | bytes (24 KiB; điều chỉnh 2026-09-30 R-50) |
| Max Response Bytes | `batch.maxResponseBytes` | `65536` | bytes (64 KiB) |
| Rate Limit Window | `rateLimits.windowSeconds` | `60` | seconds (sliding window) |
| Tab Max Batches | `rateLimits.tab.maxBatches` | `4` | batches / 60 s |
| Tab Max Source Code Points | `rateLimits.tab.maxSourceCodePoints` | `12000` | Unicode code points / 60 s |
| Site Max Batches | `rateLimits.site.maxBatches` | `12` | batches / 60 s |
| Site Max Source Code Points | `rateLimits.site.maxSourceCodePoints` | `36000` | Unicode code points / 60 s |
| Translation Cache TTL | `cache.translation.ttlMs` | `600000` | ms (10 minutes) |
| Translation Cache Max Entries | `cache.translation.maxEntries` | `500` | entries |
| Translation Cache Max Bytes | `cache.translation.maxSizeBytes` | `2097152` | bytes (2 MiB) |
| listModels Cache TTL | `cache.listModels.ttlMs` | `300000` | ms (5 minutes) |
| Patch Min Interval | `throttle.patchMinIntervalMs` | `200` | ms (giữa các nhóm patch, không phải mỗi node) |
| Patch Group Size | `throttle.patchGroupSize` | `64` | nodes/nhóm (điều chỉnh 2026-09-30 R-50) |
| Debounce Min Delay | `throttle.debounceMinMs` | `200` | ms |
| Debounce Max Delay | `throttle.debounceMaxMs` | `300` | ms |
| Max Concurrent Requests | `throttle.maxConcurrentRequests` | `2` | simultaneous provider requests |
