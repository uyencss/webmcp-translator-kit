# Translator auto-scroll and provider favorites — acceptance record

Date: 2026-10-01 (Asia/Ho_Chi_Minh). Owner: `packages/webmcp-translator-kit`. This record covers candidate `translator-c2` and the exact source changes in this candidate worktree. It does not authorize push, release, Chrome Web Store submission, or production rollout.

## User-visible changes

- After extension reload invalidates an old content script, the old script detects dead messaging at the next boundary, stops its scroll session/timers and resolves pending translation as non-retryable `ABORTED`. It does not keep logging/retrying. A new page load can start a fresh script.
- Auto-start is gated by the SW-resolved effective site/tab consent, current site permission and API key. Transient SW startup/permission-state failures retry a bounded number of times. The one-shot flag is not consumed while the site is disabled, so a later consent/permission change can trigger auto-start without a manual scroll/click.
- Scroll-follow progress appears in the popup status/footer while the popup is open and refreshes when reopened. The `watching` state takes precedence over `done` for the current viewport; displayed applied counts are capped to collected counts and failures remain visible even when all scroll batches fail.
- Favorite model lists are scoped by normalized provider Base URL (scheme/host case normalized, trailing slashes removed, path and port preserved; API keys are never part of the scope). A fresh URL starts with an empty list; returning to the previous URL restores its list. Existing unscoped favorites migrate into the active URL bucket when upgrading settings v4→v5 and are persisted on first read. Legacy callers that explicitly save only `favoriteModels` still update the active URL bucket. Fallback model stars use their own URL if configured, otherwise the displayed primary URL, and save immediately.
- Favorite changes and debounced form saves are serialized so an overlapping full save cannot restore an older favorite map. Full form saves omit favorite fields; star writes send only the changed provider bucket, which the service worker merges into the latest map while serializing `SAVE_SETTINGS`, widget mode changes, and schema migration writes. Separate popups can update different provider buckets without erasing each other's changes.
- Popup keeps polling after the initial scroll-follow acknowledgment, so the applied/collected/failed footer updates while watching and recovers when the popup is reopened. A failed favorite save restores the previous star state and shows the error.

## Changed paths

`extension/src/content.js`, `extension/src/popup.js`, `extension/src/settings.mjs`, `extension/src/sw.js`, `test/auto-scroll-favorites.test.mjs`, `test/settings.test.mjs`, `test/smoke/run.mjs`, `test/sw-progress.test.mjs`.

No changes to package metadata, credentials, or provider settings. The implementation has not yet been promoted to the owner checkout. Current owner-side Store documentation/assets edits are unrelated and preserved; their exact paths and hashes are recorded in the outer candidate ledger.

## Baseline and candidate identity

- Owner baseline HEAD: `227e0694a49f9cc0faff5adedada33ef587183bc`
- Owner baseline tree: `fba2855de9d14543a3ba6f877d4f40f9c54c7f67`
- Owner checkout at baseline was clean `main`; it now contains separate uncommitted Store documentation/assets edits, preserved without modification. Owner HEAD/tree remain at the baseline.
- Candidate: `/Users/ttcenter/Desktop/VIBE_CODE/temp/translator-auto-scroll-favorites-20261001/translator-kit/M2-implementation/translator-c2/source`
- Prior reviewed code commit: `3dbceab45801b4e3b4181c9ac810a2a73cdb91e1`, tree `e5f7a9f8ee471b1d5a4a5a82f66d2fa3e54cc83c`. Three low review findings were fixed afterward; the new candidate commit/tree must be re-reviewed before promotion.
- Preserve the final exact commit/tree and per-file hashes in `candidate-ledger.md`; do not treat the earlier writer's hashes as current receipts.

## Verification evidence

- Baseline before fix: `npm test` 100/100 passed; it did not catch the reported reload failure.
- Candidate `npm test`: 125/125 passed, including concurrent `SAVE_SETTINGS`/`WIDGET_SET_MODE`, concurrent provider-bucket updates, settings v4→v5 migration persistence, full-autosave favorite isolation, per-provider favorites, and auto-start gate tests.
- Candidate `npm run check:contract`: `CONTRACT_OK`.
- Candidate `npm run check:closure`: `CLOSURE_OK`.
- Candidate `git diff --check`: passed.
- Chrome for Testing integration smoke ran against isolated snapshots copied from candidate, so generated `docs/measurements/measurement-raw.json` did not modify candidate or owner. Final smoke v23 passed T1–T54 after the cross-popup bucket-merge and error-footer fixes. T47 behaviorally checked footer progress in an open and reopened popup, forced a full settings/favorite overlap, verified form autosave omits favorite fields, and injected a failed favorite save to verify rollback/error display. T48 and T52 verified auto-start after page load/navigation/reload; T44/T44b covered scroll-follow; T54 covered progressive SSE. The harness emits a `MaxListenersExceededWarning`; it is not a failing test.
- Smoke used local synthetic fixture/fake 9router only; no production endpoint, credentials, real webpage or paid provider were used.

## AI dispatch and review lineage

- Coordinator: Codex in this task.
- Primary writer attempt: WebMCP AI CLI → AGY → `gemini-3.8-flash-high`. The canary returned `ROUTE_OK`, but the implementation session remained in “waiting for background smoke task” for about ten minutes without a source diff; coordinator stopped that process. Its candidate c1 and its out-of-write-set measurement-file change were preserved, not promoted.
- Fallback writer: WebMCP AI CLI → OpenCode → `opencode-go/muse-spark-1.3-contributor`. It returned the scoped implementation and regression tests, then fixed coordinator findings from A→B favorite leakage, attempt consumption before auto-start gates, fallback star debounce persistence, the smoke bridge's missing `runtime.id`, and legacy T43 partial saves. Muse did not commit or self-accept.
- AGY Claude Opus 4.6 Thinking passed an exact-model canary through WebMCP AI CLI when `--effort` was omitted; the model does not accept that flag. A plan-mode pre-accept attempt on a read-only copy then timed out after 300 seconds (`PROVIDER_TIMEOUT`) and is not a review verdict. The copy's before/after SHA-256 manifests match.
- Sonnet 5.5 was used through WebMCP AI CLI for read-only race diagnosis, as authorized. The wrapper rejected both structured outputs (`REVIEW_RESULT_INCOMPLETE`), so neither is counted as a review verdict. Its source-level diagnosis matched the instrumented Chrome trace; the coordinator implemented and tested the fix.
- Claude Opus 5.5 approved commit `3dbceab` with three low findings and an informational note, then approved `7461868` with two more low findings, then approved `30962ed` with two more low findings: favorite stars sent the full map, and all-failed scroll status dropped failure counts from the footer. All seven low findings across those reviews have now been addressed; their receipts are stale. The informational stale-widget note is outside the fresh-page reload acceptance scope.
- User-authorized Muse 1.3 pre-acceptance on commit `2b3f205` returned `approve`, but is stale after the provider-bucket merge and failure-footer fixes. Muse authored the initial c2 implementation, so its hygiene pass is advisory for its own changes.
- Run fresh Muse pre-acceptance and independent Claude Opus 5.5 final review on the newly frozen source+doc tree. Record actual model/route and artifact hashes in `candidate-ledger.md`; do not edit this record after the final review.

## Open gates

- [ ] Run user-authorized pre-acceptance review on the updated candidate source; previous Muse receipt is stale and AGY Opus route timed out.
- [ ] Run fresh direct Claude Opus 5.5 read-only review on the final candidate commit/tree recorded in `candidate-ledger.md`. Any source/doc fix creates a new candidate tree and invalidates that receipt.
- [ ] Recheck owner checkout HEAD/tree/status. If it remains exactly at the baseline, fast-forward the reviewed commit and rerun package checks; if it drifted, stop with `RECONCILIATION_BLOCKED_OWNER_DRIFT` and preserve both sides.
- [ ] After promotion, rerun `npm test`, contract, closure and isolated Chrome smoke against the authoritative owner tree.
- [ ] Push and production/Chrome Web Store release remain outside this task.
