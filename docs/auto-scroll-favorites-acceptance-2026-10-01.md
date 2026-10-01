# Translator auto-scroll and provider favorites — acceptance record

Date: 2026-10-01 (Asia/Ho_Chi_Minh). Owner: `packages/webmcp-translator-kit`. This record covers candidate `translator-c2` and the exact source changes in this candidate worktree. It does not authorize push, release, Chrome Web Store submission, or production rollout.

## User-visible changes

- After extension reload invalidates an old content script, the old script detects dead messaging at the next boundary, stops its scroll session/timers and resolves pending translation as non-retryable `ABORTED`. It does not keep logging/retrying. A new page load can start a fresh script.
- Auto-start is gated by the SW-resolved effective site/tab consent, current site permission and API key. Transient SW startup/permission-state failures retry a bounded number of times. The one-shot flag is not consumed while the site is disabled, so a later consent/permission change can trigger auto-start without a manual scroll/click.
- Scroll-follow progress appears in the popup status/footer while the popup is open and refreshes when reopened. The `watching` state takes precedence over `done` for the current viewport; displayed applied counts are capped to collected counts and failures are shown.
- Favorite model lists are scoped by normalized provider Base URL (scheme/host case normalized, trailing slashes removed, path and port preserved; API keys are never part of the scope). A fresh URL starts with an empty list; returning to the previous URL restores its list. Existing unscoped favorites migrate once into the active URL bucket. Legacy callers that explicitly save only `favoriteModels` still update the active URL bucket. Fallback model stars use their own URL if configured, otherwise the primary URL, and save immediately.
- Favorite changes and debounced form saves are serialized so an overlapping full save cannot restore an older favorite map. The service worker also serializes settings merge writes, so concurrent partial settings updates preserve each other's fields.

## Changed paths

`extension/src/content.js`, `extension/src/popup.js`, `extension/src/settings.mjs`, `extension/src/sw.js`, `test/auto-scroll-favorites.test.mjs`, `test/smoke/run.mjs`.

No writer changes to package docs/store assets, package metadata, tests outside the listed new test, credentials, or provider settings. The implementation has not yet been promoted to the owner checkout.

## Baseline and candidate identity

- Owner baseline HEAD: `227e0694a49f9cc0faff5adedada33ef587183bc`
- Owner baseline tree: `fba2855de9d14543a3ba6f877d4f40f9c54c7f67`
- Owner checkout status before promotion: clean `main`
- Candidate: `/Users/ttcenter/Desktop/VIBE_CODE/temp/translator-auto-scroll-favorites-20261001/translator-kit/M2-implementation/translator-c2/source`
- Candidate implementation commit before the final race fix: `85d9df2e5f8b7d3f38c88e72fe20a0aa568d1fdc`; final frozen candidate commit/tree is recorded in `candidate-ledger.md` after the current tests and reviews.
- Preserve the final exact commit/tree and per-file hashes in `candidate-ledger.md`; do not treat the earlier writer's hashes as current receipts.

## Verification evidence

- Baseline before fix: `npm test` 100/100 passed; it did not catch the reported reload failure.
- Candidate `npm test`: 121/121 passed after adding a concurrent `SAVE_SETTINGS` regression.
- Candidate `npm run check:contract`: `CONTRACT_OK`.
- Candidate `npm run check:closure`: `CLOSURE_OK`.
- Candidate `git diff --check`: passed.
- Chrome for Testing integration smoke ran against isolated snapshots copied from candidate, so generated `docs/measurements/measurement-raw.json` did not modify candidate or owner. Early snapshots exposed context-bridge, legacy favorite compatibility, and stale autosave/favorite-map ordering. Final smoke v12 passed T1–T54 on the final source code. T47 forced overlap between a full settings save and fallback favorite map save, and confirmed old favorites, the new favorite, another provider bucket, fallback key, and an unrelated language update persisted. T48 and T52 verified auto-start after page load/navigation/reload; T44/T44b covered scroll-follow; T54 covered progressive SSE. The harness emits a `MaxListenersExceededWarning`; it is not a failing test.
- Smoke used local synthetic fixture/fake 9router only; no production endpoint, credentials, real webpage or paid provider were used.

## AI dispatch and review lineage

- Coordinator: Codex in this task.
- Primary writer attempt: WebMCP AI CLI → AGY → `gemini-3.8-flash-high`. The canary returned `ROUTE_OK`, but the implementation session remained in “waiting for background smoke task” for about ten minutes without a source diff; coordinator stopped that process. Its candidate c1 and its out-of-write-set measurement-file change were preserved, not promoted.
- Fallback writer: WebMCP AI CLI → OpenCode → `opencode-go/muse-spark-1.3-contributor`. It returned the scoped implementation and regression tests, then fixed coordinator findings from A→B favorite leakage, attempt consumption before auto-start gates, fallback star debounce persistence, the smoke bridge's missing `runtime.id`, and legacy T43 partial saves. Muse did not commit or self-accept.
- AGY Claude Opus 4.6 Thinking now returns the exact model canary through WebMCP AI CLI when `--effort` is omitted; the model does not accept that flag. A prior response that disclosed a model mismatch is not a valid receipt.
- Sonnet 5.5 was used through WebMCP AI CLI for read-only race diagnosis, as authorized. The wrapper rejected both structured outputs (`REVIEW_RESULT_INCOMPLETE`), so neither is counted as a review verdict. Its source-level diagnosis matched the instrumented Chrome trace; the coordinator implemented and tested the fix.
- Pre-acceptance review on the final frozen candidate: pending. Use the user-authorized Muse 1.3 or AGY Claude Opus 4.6 route and record the actual model/response; pre-acceptance is not final acceptance.
- Final independent reviewer required: direct Claude Code CLI → `claude-opus-5-5`, fresh read-only pass on the exact committed final candidate/tree. Its decision and artifact hash will be recorded in the outer candidate ledger; freeze this document before that review.

## Open gates

- [ ] Final pre-acceptance review and Claude Opus 5.5 read-only review pass on the same candidate source/docs tree. Any fix creates a new candidate tree and invalidates those receipts.
- [ ] Coordinator commits only the listed source/test/docs write-set on the candidate; records final commit/tree and reviewer artifact hashes.
- [ ] Recheck owner checkout HEAD/tree/status. If it remains exactly at the baseline, fast-forward the reviewed commit; if it drifted, stop with `RECONCILIATION_BLOCKED_OWNER_DRIFT` and preserve both sides.
- [ ] After promotion, rerun `npm test`, contract, closure and isolated Chrome smoke against the authoritative owner tree.
- [ ] Push and production/Chrome Web Store release remain outside this task.
