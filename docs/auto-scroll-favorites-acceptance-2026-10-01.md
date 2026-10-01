# Translator auto-scroll and provider favorites — acceptance record

Date: 2026-10-01 (Asia/Ho_Chi_Minh). Owner: `packages/webmcp-translator-kit`. This record covers candidate `translator-c2` and the exact source changes in this candidate worktree. It does not authorize push, release, Chrome Web Store submission, or production rollout.

## User-visible changes

- After extension reload invalidates an old content script, the old script detects dead messaging at the next boundary, stops its scroll session/timers and resolves pending translation as non-retryable `ABORTED`. It does not keep logging/retrying. A new page load can start a fresh script.
- Auto-start is gated by the SW-resolved effective site/tab consent, current site permission and API key. Transient SW startup/permission-state failures retry a bounded number of times. The one-shot flag is not consumed while the site is disabled, so a later consent/permission change can trigger auto-start without a manual scroll/click.
- Scroll-follow progress appears in the popup status/footer while the popup is open and refreshes when reopened. The `watching` state takes precedence over `done` for the current viewport; displayed applied counts are capped to collected counts and failures are shown.
- Favorite model lists are scoped by normalized provider Base URL (scheme/host case normalized, trailing slashes removed, path and port preserved; API keys are never part of the scope). A fresh URL starts with an empty list; returning to the previous URL restores its list. Existing unscoped favorites migrate once into the active URL bucket. Legacy callers that explicitly save only `favoriteModels` still update the active URL bucket. Fallback model stars use their own URL if configured, otherwise the primary URL, and save immediately.

## Changed paths

`extension/src/content.js`, `extension/src/popup.js`, `extension/src/settings.mjs`, `extension/src/sw.js`, `test/auto-scroll-favorites.test.mjs`.

No writer changes to package docs/store assets, package metadata, tests outside the listed new test, credentials, or provider settings. The implementation has not yet been promoted to the owner checkout.

## Baseline and candidate identity

- Owner baseline HEAD: `227e0694a49f9cc0faff5adedada33ef587183bc`
- Owner baseline tree: `fba2855de9d14543a3ba6f877d4f40f9c54c7f67`
- Owner checkout status before promotion: clean `main`
- Candidate: `/Users/ttcenter/Desktop/VIBE_CODE/temp/translator-auto-scroll-favorites-20261001/translator-kit/M2-implementation/translator-c2/source`
- Candidate is currently an uncommitted diff from the exact baseline; the final review must name the post-review commit/tree after the coordinator freezes and commits the reviewed write-set.
- Candidate tracked diff SHA-256: `1cc55a21dce69d451fee5749890ce32266d80f9f6af1f038f12988b43a8a7628`
- Added regression test SHA-256: `6a22dbf531590d424abfb6efd240c7c76aa7a793b255e38ee069e6999c494932`

## Verification evidence

- Baseline before fix: `npm test` 100/100 passed; it did not catch the reported reload failure.
- Candidate focused regression tests: 20/20 passed after final compatibility and smoke-bridge fixes.
- Candidate `npm test`: 120/120 passed.
- Candidate `npm run check:contract`: `CONTRACT_OK`.
- Candidate `npm run check:closure`: `CLOSURE_OK`.
- Candidate `git diff --check`: passed.
- Chrome for Testing integration smoke ran against an isolated snapshot copied from candidate, so the smoke script's generated `docs/measurements/measurement-raw.json` did not modify candidate or owner. Smoke v1/v2 exposed and helped resolve context-bridge and legacy favorite compatibility regressions. Final smoke snapshot v3: T1–T54 passed, exit code 0. Relevant cases: T43 legacy partial favorite save; T44/T44b scroll-follow; T46 floating widget; T48 auto-start and negative gates; T52 fresh navigation + reload; T54 progressive SSE. Harness printed a `MaxListenersExceededWarning` from its socket listeners; no test failed.
- Smoke used local synthetic fixture/fake 9router only; no production endpoint, credentials, real webpage or paid provider were used.

## AI dispatch and review lineage

- Coordinator: Codex in this task.
- Primary writer attempt: WebMCP AI CLI → AGY → `gemini-3.8-flash-high`. The canary returned `ROUTE_OK`, but the implementation session remained in “waiting for background smoke task” for about ten minutes without a source diff; coordinator stopped that process. Its candidate c1 and its out-of-write-set measurement-file change were preserved, not promoted.
- Fallback writer: WebMCP AI CLI → OpenCode → `opencode-go/muse-spark-1.3-contributor`. It returned the scoped implementation and regression tests, then fixed coordinator findings from A→B favorite leakage, attempt consumption before auto-start gates, fallback star debounce persistence, the smoke bridge's missing `runtime.id`, and legacy T43 partial saves. Muse did not commit or self-accept.
- Requested AGY Claude Opus 4.6 Thinking pre-acceptance attempt: wrapper envelope requested `claude-opus-4-6-thinking`, but the response explicitly disclosed it could not fulfill that model route and the session's actual Antigravity model completed the review. This is **not counted** as an AGY Claude Opus 4.6 review receipt.
- User-requested Muse pre-acceptance: WebMCP AI CLI → OpenCode → Muse 1.3 returned `approve`. Since Muse also wrote the implementation, this is advisory hygiene only and not independent acceptance.
- Final independent reviewer required: direct Claude Code CLI → `claude-opus-5-5`, fresh read-only pass on the exact committed final candidate/tree. Its decision and artifact hash will be recorded in the outer candidate ledger; this evidence document is frozen before that review.

## Open gates

- [ ] Final Claude Opus 5.5 read-only review returns `approve` with no medium/high/critical findings for the same source and document tree. Any fix creates a new candidate tree and invalidates that receipt.
- [ ] Coordinator commits only the listed source/test/docs write-set on the candidate; records final commit/tree and reviewer artifact hashes.
- [ ] Recheck owner checkout HEAD/tree/status. If it remains exactly at the baseline, fast-forward the reviewed commit; if it drifted, stop with `RECONCILIATION_BLOCKED_OWNER_DRIFT` and preserve both sides.
- [ ] After promotion, rerun `npm test`, contract, closure and isolated Chrome smoke against the authoritative owner tree.
- [ ] Push and production/Chrome Web Store release remain outside this task.
