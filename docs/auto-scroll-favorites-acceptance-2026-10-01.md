# Translator auto-scroll and provider favorites — acceptance record

Date: 2026-10-01 (Asia/Ho_Chi_Minh). Owner: `packages/webmcp-translator-kit`. This record covers candidate `translator-c2` and the exact source changes in this candidate worktree. It does not authorize push, release, Chrome Web Store submission, or production rollout.

## User-visible changes

- After extension reload invalidates an old content script, the old script detects dead messaging at the next boundary, stops its scroll session/timers and resolves pending translation as non-retryable `ABORTED`. It does not keep logging/retrying. A new page load can start a fresh script.
- Auto-start is gated by the SW-resolved effective site/tab consent, current site permission and API key. The content script requires `effective === 'on'`, `permission === true`, and `hasKey === true`; missing fields fail closed. The 500 ms settle timer rechecks the latest state; permission/key/consent changes cancel or block startup and leave a later positive update retryable. Transient SW startup/permission-state failures retry a bounded number of times.
- Scroll-follow progress appears in the popup status/footer while the popup is open and refreshes when reopened. The `watching` state takes precedence over `done` for the current viewport; displayed applied counts are capped to collected counts and failures remain visible even when all scroll batches fail.
- Favorite model lists are scoped by normalized provider Base URL (scheme/host case normalized, query/fragment and trailing slashes removed, path and non-default port preserved; URL parsing normalizes explicit default ports; API keys are never part of the scope). Two URLs differing only by query/fragment or an explicit default port share favorites. A fresh scope starts with an empty list; returning to the previous scope restores its list. Existing unscoped favorites migrate into the active URL bucket when upgrading settings v4→v5 and are persisted on first read. Legacy callers that explicitly save only `favoriteModels` still update the active URL bucket. Fallback model stars use their own URL if configured, otherwise the displayed primary URL, and save immediately.
- Favorite changes and debounced form saves are serialized so an overlapping full save cannot restore an older favorite map. Full form saves omit favorite fields. A star click sends `{scopeKey, model, favorite}` with the state shown in that popup; the service worker applies the add/remove idempotently against the latest saved bucket inside its serialized settings write and returns the canonical bucket. Concurrent stale popups cannot undo an add just because their displayed list was old. A provider bucket holds at most 50 favorites; a new add at the limit returns a typed error and leaves storage and the star unchanged, while removals still work. `SAVE_SETTINGS`, widget mode changes, and schema migration writes share the serialized write path.
- Popup keeps polling after the initial scroll-follow acknowledgment, so the applied/collected/failed footer updates while watching and recovers when the popup is reopened. A failed favorite save restores the previous star state and shows the error.

## Changed paths

`extension/src/content.js`, `extension/src/popup.js`, `extension/src/settings.mjs`, `extension/src/sw.js`, `test/auto-scroll-favorites.test.mjs`, `test/settings.test.mjs`, `test/smoke/run.mjs`, `test/sw-progress.test.mjs`.

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
- Candidate `npm test`: 134/134 passed, including URL scope normalization, concurrent `SAVE_SETTINGS`/`WIDGET_SET_MODE`, concurrent provider-bucket updates, idempotent same-bucket favorite adds, favorite-cap rejection/removal and field-specific schema diagnostics, settings v4→v5 migration persistence, full-autosave favorite isolation, per-provider favorites, fail-closed missing-field gates, and permission/key/consent changes during the auto-start settle window.
- Candidate `npm run check:contract`: `CONTRACT_OK`.
- Candidate `npm run check:closure`: `CLOSURE_OK`.
- Candidate `git diff --check`: passed.
- Chrome for Testing `150.0.7871.24` integration smoke ran in isolated snapshot `translator-kit/M3-integration/smoke-c2-v27/source`; T1–T54 passed (exit 0), manifest SHA-256 `0bd188f57961a032cc93c098a2799a6ff0ea033894ee14b1cd23971b60bd8e45`. Generated `docs/measurements/measurement-raw.json` and build output were confined to that snapshot. T47 checked popup progress while open and after reopening, autosave/favorite overlap, form autosave exclusion, and failed-save rollback; it exercises a single popup session, not two stale popup pages or the 50-favorite UI limit. Node tests cover atomic stale adds and the limit response. T48/T52 verified auto-start after load/navigation/reload; T44/T44b covered scroll-follow; T54 covered progressive SSE. The harness emits a `MaxListenersExceededWarning`; all tests still passed.
- Smoke used local synthetic fixture/fake 9router only; no production endpoint, credentials, real webpage or paid provider were used.

## AI dispatch and review lineage

- Coordinator: Codex in this task.
- Primary writer attempt: WebMCP AI CLI → AGY → `gemini-3.8-flash-high`. The canary returned `ROUTE_OK`, but the implementation session remained in “waiting for background smoke task” for about ten minutes without a source diff; coordinator stopped that process. Its candidate c1 and its out-of-write-set measurement-file change were preserved, not promoted.
- Fallback writer: WebMCP AI CLI → OpenCode → `opencode-go/muse-spark-1.3-contributor`. It returned the scoped implementation and regression tests, then fixed coordinator findings from A→B favorite leakage, attempt consumption before auto-start gates, fallback star debounce persistence, the smoke bridge's missing `runtime.id`, and legacy T43 partial saves. Muse did not commit or self-accept.
- AGY Claude Opus 4.6 Thinking passed an exact-model canary through WebMCP AI CLI when `--effort` was omitted; the model does not accept that flag. A plan-mode pre-accept attempt on a read-only copy then timed out after 300 seconds (`PROVIDER_TIMEOUT`) and is not a review verdict. The copy's before/after SHA-256 manifests match.
- Sonnet 5.5 was used through WebMCP AI CLI for read-only race diagnosis, as authorized. The wrapper rejected both structured outputs (`REVIEW_RESULT_INCOMPLETE`), so neither is counted as a review verdict. Its source-level diagnosis matched the instrumented Chrome trace; the coordinator implemented and tested the fix.
- Claude Opus 5.5 approved commit `3dbceab` with three low findings and an informational note, then approved `7461868` with two more low findings, then approved `30962ed` with two more low findings: favorite stars sent the full map, and all-failed scroll status dropped failure counts from the footer. All seven low findings across those reviews have now been addressed; their receipts are stale. The informational stale-widget note is outside the fresh-page reload acceptance scope.
- User-authorized Muse 1.3 pre-acceptance on code commit `e90cb56` returned `approve`, no findings, `review-readonly`; result artifact SHA-256 `ffefaaf31698cb1703ce0e2a8e14a12ab1d524b616867d501578b8e9f51b28cf`, prompt SHA-256 `0f7c97f936e4c1273d5028b21c8ebea135260f5e628618de8d5a4959ca3e4b72`. The read-only copy manifest matched before/after. Muse authored the initial c2 implementation, so this is advisory for its own changes.
- Muse 1.3 pre-acceptance on commit `55e22a5` returned `approve`, no findings, `review-readonly`; prompt/result hashes and route are in the outer ledger. Opus 5.5 then approved that same commit with the three low findings described above. The scoped Muse follow-up fixed the favorite-cap and stale-intent findings without a writer commit; coordinator tests and Chrome smoke verified the result.
- Muse 1.3 pre-acceptance on commit `1fbed61` returned `approve` with three low notes: the unused helper, fail-open missing fields, and lack of two-popup/limit browser smoke. The first two are fixed in the source snapshot documented here. Final review is pending on the exact commit/tree in the outer ledger.
- Muse 1.3 pre-acceptance on `ce0c5a6` returned `approve` with three low notes: empty-broadcast re-query cost, no two-popup browser smoke, and query/default-port normalization. Query/fragment stripping and default-port equivalence are now explicitly documented and covered by normalization assertions; the other two are recorded as scoped performance/test-coverage notes.
- Direct Claude Opus 5.5 approved `d4250e1` with two low findings: recheck auto-start state at the settle timer and make malformed favorite-toggle schema details field-specific. Both are addressed in this candidate, with regression tests. The current exact commit/tree and fresh review receipts are recorded in the outer ledger.
- This record is frozen into the candidate before independent reviews. Final review outcomes and the exact reviewed commit/tree are recorded in the outer `candidate-ledger.md`; do not edit this record after those reviews.

## Open gates

- [x] User-authorized Muse 1.3 pre-acceptance on current code commit `e90cb56` returned `approve`; same-lineage advisory status is recorded above.
- [ ] Run fresh read-only pre-acceptance and final reviews on the exact commit/tree recorded in `candidate-ledger.md`. Any source/doc fix creates a new candidate tree and invalidates those receipts.
- [ ] Owner reconciliation: the owner checkout contains unrelated dirty Chrome Web Store docs/assets with no candidate path overlap. Keep them untouched and follow `candidate-ledger.md` reconciliation status before any promotion.
- [ ] After promotion, rerun `npm test`, contract, closure and isolated Chrome smoke against the authoritative owner tree.
- [ ] Push and production/Chrome Web Store release remain outside this task.
