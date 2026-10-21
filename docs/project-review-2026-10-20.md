# Project review — October 20, 2026

Reviewed the current working tree, including the substantial pre-existing changes. Those changes were preserved. The review covered the builder UI, site selection, capability generation, installation, verification polling, live testing, HTTP request handling, scanner safety, and configuration/session boundaries. This is a focused review, not a complete security audit.

## Implemented improvements

- **Capability edits after generation:** the server now compares enabled draft capabilities against the latest generated configuration. Turning a capability on or off exposes the regeneration action even without another scan. Reverting the choices removes the prompt when the generated settings match again.
- **Wrong-site refreshes:** the provider checks both selection epoch and response site identity. A repair/background refresh explicitly requested for an old site can no longer replace the current site.
- **Verification cancellation:** each check has its own attempt identity. Cancelling and immediately restarting cannot revive an earlier polling loop. Unmounting or changing sites invalidates pending checks and prevents late popup opening. Verification panel state resets on site changes.
- **Live-test connection recovery:** a pending connection survives an initial disconnected poll. The UI offers a manual opening link and cancellation while waiting. Failed stop requests produce an inline error; stale start, stop, and polling responses are ignored after a new attempt or site switch.
- **Expected action failures:** capability, generation, and re-scan buttons consume rejected action promises after the provider has displayed their inline errors. Agent callers still receive rejected promises.
- **Clipboard feedback:** the fallback copy path checks whether copying actually succeeded and always removes its temporary text area.
- **Accessibility and instructions:** mobile step links have accessible names even when visible labels are hidden; the transcript no longer nests a div directly inside an ordered list; repair instructions explicitly require updating the snippet and publishing before verification.

## Larger decisions left unimplemented

### High priority: isolate builder visitors and live-test sessions

`requireOwnedSiteFor` in `src/lib/session.ts` deliberately does not enforce ownership. `site-service.ts` assigns one shared site per origin; drafts live on that site. `live-test-service.ts` selects, closes, and dispatches to sessions by site ID rather than the initiating builder session. Consequently, different visitors working on the same website can interfere with drafts and live tests. Another visitor can potentially route allowed commands to an already-connected target browser.

Pinned immutable configuration versions protect an already-installed website from silently adopting another visitor's new configuration. They do not provide isolation for drafts or the live-test relay. Contact submission remains blocked from natural-language dispatch.

Recommended decision: retain public scanning, but scope drafts and live-test control to the initiating session; consider domain verification/accounts for durable owner-only management. This requires coordinated schema, service, API, and integration-test changes. No ownership changes were made during this review.

### Medium priority: make concurrent edits and quotas atomic

Capability updates in `config-service.ts` read the entire settings object, change one key, and write it back. Concurrent visitors or agent calls can lose one another's changes. Scan and AI quota enforcement also use count-then-act patterns that can race under simultaneous requests. UI button disabling cannot enforce these server-side guarantees.

Recommended decision: add transactional quota reservations and revision-based conflict detection or atomic capability updates. Decide first whether drafts are shared or session-scoped, since that determines the correct conflict boundary. No database migrations or quota policy changes were made.

## Verification and limits

- Existing baseline: 515 passing tests. Final run: 527 passing tests, 78 skipped database tests; lint and TypeScript passed.
- Added mounted React regression tests against the actual provider and verification panel, plus service tests for capability-driven regeneration. These cover stale responses, action chaining, cancelled checks, unmounting, live connection recovery, and late startup cancellation.
- Production build passed, including runtime bundling and Prisma client generation.
- Inspected the landing/empty builder at desktop and 375-pixel mobile width, including the scan anchor, disabled prerequisites, labels, and navigation. No application console errors were observed; development Fast Refresh emitted a reload warning.
- Database integration suites were skipped because no dedicated `TEST_DATABASE_URL` was configured. The complete real scan → install on an external website → live callback flow was not exercised. Production database records and external websites were not modified for testing.
- Existing visual styling and the five-step workflow were retained. No dependency upgrades, deployments, schema migrations, or commits were performed.
