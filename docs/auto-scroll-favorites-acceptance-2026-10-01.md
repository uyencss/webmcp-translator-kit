# Translator auto-scroll and provider favorites — acceptance record

Date: 2026-10-02 (Asia/Ho_Chi_Minh). Owner: `packages/webmcp-translator-kit`. This record covers candidate `translator-c2` and the exact source changes in this candidate worktree. It does not authorize push, release, Chrome Web Store submission, or production rollout.

## User-visible changes

- After extension reload invalidates an old content script, subsequent sends detect dead messaging, resolve as non-retryable `ABORTED`, and stop its timers/session—including the floating-widget progress interval—without uncaught errors. An already in-flight browser callback may never return; a fresh page load starts a new script.
- Auto-start is gated by the SW-resolved effective site/tab consent, current site permission and API key. The content script requires `effective === 'on'`, `permission === true`, and `hasKey === true`; missing fields fail closed. The 500 ms settle timer rechecks the latest state; permission/key/consent changes cancel or block startup and leave a later positive update retryable. State-change broadcasts also trigger a fresh authoritative query while a full or scroll-follow translation is active. If consent, permission, or key becomes unavailable, the content script cancels the active epoch and worker batch, stops translation, and waits for a later allowed state before auto-starting again. Transient SW startup/permission-state failures retry a bounded number of times.
- The auto-start query retry budget resets after a successful authoritative response and when a new pushed-state query cycle begins; stale out-of-order replies cannot reset it.
- Scroll-follow progress appears in the popup status/footer while open, refreshes when reopened, and retains final applied/collected counts after completion. The `watching` state takes precedence over `done` for the current viewport; displayed applied counts are capped to collected counts in both watching and completed states, and failure counts remain visible while watching, on errors, and after partial completion.
- Fatal scroll batches stop the watcher and cancel sibling in-flight work instead of scheduling the same unauthorized/configuration-blocked nodes again. `RATE_LIMITED` retains its single bounded delayed retry path.
- Favorite model lists are scoped by normalized provider Base URL (scheme/host case normalized, query/fragment and trailing slashes removed, path and non-default port preserved; URL parsing normalizes explicit default ports; API keys are never part of the scope). Two URLs differing only by query/fragment or an explicit default port share favorites. A fresh scope starts with an empty list; returning to the previous scope restores its list. Existing unscoped favorites migrate into the active URL bucket when upgrading settings v4→v5 and are persisted on first read; invalid legacy stored scope keys are dropped during migration, while explicit saves reject invalid or duplicate normalized scope keys before storage. Legacy callers that explicitly save only `favoriteModels` still update the active URL bucket. Fallback model stars use their own URL if configured, otherwise the displayed primary URL, and save immediately.
- Favorite changes and debounced form saves are serialized so an overlapping full save cannot restore an older favorite map. Full form saves omit favorite fields. A star click sends `{scopeKey, model, favorite}` with the state shown in that popup; the service worker applies the add/remove idempotently against the latest saved bucket inside its serialized settings write and returns the canonical bucket. The primary star reads the current Base URL input directly; changing favorites does not persist or alter the configured Base URL. Concurrent stale popups cannot undo an add just because their displayed list was old. A provider bucket holds at most 50 favorites; a new add at the limit returns a typed error and leaves storage and the star unchanged, while removals still work. `SAVE_SETTINGS`, widget mode changes, and schema migration writes share the serialized write path.
- Popup keeps polling after the initial scroll-follow acknowledgment, so the applied/collected/failed footer updates while watching and recovers when the popup is reopened. A failed favorite save restores the previous star state and shows the error.

## Changed paths

`extension/src/content.js`, `extension/src/popup.js`, `extension/src/settings.mjs`, `extension/src/sw.js`, `test/adapter.test.mjs`, `test/adapter.f8.test.mjs`, `test/auto-scroll-favorites.test.mjs`, `test/settings.test.mjs`, `test/smoke/run.mjs`, `test/sw-progress.test.mjs`.

No changes to package metadata, credentials, or provider settings. The implementation has not yet been promoted to the owner checkout. Current owner-side Store documentation/assets edits are unrelated and preserved; their exact paths and hashes are recorded in the outer candidate ledger.

## Baseline and candidate identity

- Owner baseline HEAD: `227e0694a49f9cc0faff5adedada33ef587183bc`
- Owner baseline tree: `fba2855de9d14543a3ba6f877d4f40f9c54c7f67`
- Owner checkout at baseline was clean `main`; it now contains separate uncommitted Store documentation/assets edits, preserved without modification. Owner HEAD/tree remain at the baseline.
- Candidate: `/Users/ttcenter/Desktop/VIBE_CODE/temp/translator-auto-scroll-favorites-20261001/translator-kit/M2-implementation/translator-c2/source`
- Prior reviewed commit: `55e22a5ae688b7dad94ec280911b38dd4555dc66`, tree `cf41016ffe0095bcb376533d49b39b80aaccd323`. Opus approved with three low findings: silent add at the 50-model cap, stale popup blind-toggle intent, and extra auto-start gate reads on empty broadcasts. The first two are fixed in the candidate snapshot documented here; the optional broadcast-performance note remains outside this bug scope. The new exact candidate commit/tree must be re-reviewed before promotion.
- Preserve the final exact commit/tree and per-file hashes in `candidate-ledger.md`; do not treat the earlier writer's hashes as current receipts.

## Verification evidence

- Baseline before fix: `npm test` 100/100 passed; it did not catch the reported reload failure.
- Candidate `npm test`: 140/140 passed, including URL scope normalization and duplicate-scope rejection, concurrent `SAVE_SETTINGS`/`WIDGET_SET_MODE`, concurrent provider-bucket updates, idempotent same-bucket favorite adds, favorite-cap rejection/removal and field-specific schema diagnostics, settings v4→v5 migration persistence, full-autosave favorite isolation, per-provider favorites, fail-closed widget defaults, stale-context shutdown including the progress interval, live Base URL favorite scope, completed-footer progress/failure counts, bounded retry-budget reset, active-session consent/key/permission revocation, fatal-batch shutdown, permission-removal broadcasts, and out-of-order replies during auto-start settle.
- Candidate `npm run check:contract`: `CONTRACT_OK`.
- Candidate `npm run check:closure`: `CLOSURE_OK`.
- Candidate `git diff --check`: passed.
- Adapter tests keep the dedicated 60 ms timeout case; the shared local `listModels` fixture timeout is 500 ms to avoid false timeouts under parallel test load. Both abort tests wait until their local fake server receives the request before aborting, rather than relying on a fixed startup delay.
- Chrome for Testing `150.0.7871.24` integration smoke v39 passed T1–T54 (exit 0) from isolated snapshot `translator-kit/M3-integration/smoke-c2-v39/source`; manifest SHA-256 `0bd188f57961a032cc93c098a2799a6ff0ea033894ee14b1cd23971b60bd8e45`. The smoke snapshot's content script, service worker, focused regression test and smoke runner match the tested candidate files. T47 covers popup progress/autosave/favorite behavior; T48/T52 cover auto-start after load/navigation/reload; T44/T44b cover scroll-follow; T54 covers progressive SSE. The harness emits a `MaxListenersExceededWarning`; the run still exited 0.
- Smoke used local synthetic fixture/fake 9router only; no production endpoint, credentials, real webpage or paid provider were used.

## AI dispatch and review lineage

- Coordinator: Codex in this task. User-specified primary writer was AGY gemini-3.8-flash-high; its implementation session stalled without a diff, so the authorized fallback was WebMCP AI CLI → OpenCode → opencode-go/muse-spark-1.3-contributor. Writers did not commit.
- Claude Sonnet 5.5 was invoked through the AI CLI for bounded debugging; the wrapper rejected its two structured responses as REVIEW_RESULT_INCOMPLETE, so they are diagnostic only.
- AGY Claude Opus 4.6 Thinking passed its exact-model canary, but the plan-mode pre-accept attempt timed out after 300 seconds (PROVIDER_TIMEOUT); it produced no verdict.
- Muse 1.3 pre-acceptance on commit 9924427 returned approve (review-readonly) with low notes about the transient action field and invalid explicit favorite scope keys. Those are corrected in this snapshot; same-lineage review is advisory.
- Direct Claude Opus 5.5 approved commit 9924427 with low findings about default gate values, final footer counts, documentation wording, and callback-error coverage. Those items are corrected in this snapshot. Earlier approved receipts on older commits are historical only.
- Disclosed residual coverage: Chrome T47 opens one popup; concurrent stale-popup and 50-item UI cases are covered by service-worker Node tests. Empty state broadcasts can trigger extra state reads; this is a low-cost performance note. No correctness issue is known.
- The exact final review receipts and candidate identity are stored in the outer candidate-ledger.md. This package record is frozen before final review; reviewers must inspect the exact commit/tree in the prompt.

## Gates at source freeze

The checklist below records gates that were pending when this source record was frozen. Final review receipts and owner reconciliation status are kept in the outer candidate ledger, because those receipts do not change the reviewed package tree.

- [ ] Fresh Muse 1.3 review-readonly pre-acceptance on the final exact commit/tree; this remains a hygiene review because Muse wrote the implementation.
- [ ] Final direct Claude Opus 5.5 review and native Codex Sol (`gpt-5.6-sol`) review on that same commit/tree, per the user-selected route and pinned workspace policy.
- [ ] Owner reconciliation: packages/webmcp-translator-kit remains at baseline 227e0694a49f9cc0faff5adedada33ef587183bc / tree fba2855de9d14543a3ba6f877d4f40f9c54c7f67 with separate dirty Store docs/assets. Record RECONCILIATION_BLOCKED_OWNER_DRIFT; do not promote until the owner is re-pinned after reconciliation.
- [ ] Push and Chrome Web Store release remain outside this task.
