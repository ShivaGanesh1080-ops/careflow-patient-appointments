# Focused CareFlow release verification

6 November 2026. Release candidate, not a claim of production healthcare readiness.

## Implemented

Clinic-local IST scheduling and UTC audit parsing; source formatting and current documentation; append-only charge waivers; correction versus goodwill refunds; manual no-shows; same-doctor owner/admin rescheduling; immutable visit-change history; automated build/test workflow and four isolated browser journeys.

## Verification completed locally

- Prettier check: passed across application, tests and E2E harness.
- Backend: 43 top-level tests passed, zero failures; nested 21-test libSQL API suite passed. Ledger and full release scenario runners execute both sqlite3 and libSQL file adapters.
- Timezone: four process-timezone groups passed (UTC, Asia/Kolkata, America/Los_Angeles, Pacific/Kiritimati), using actual production helpers and Angular DatePipe. Includes historical SQLite UTC audit strings.
- Frontend: 12 mocked-injection contract checks passed. These are not browser tests.
- Angular production build: passed.
- Playwright: four tests discovered/configured. Real Chromium execution must be confirmed by CI; discovery alone is not a pass.
- Local browser: patient rescheduled fictional visit #1 from 7 to 8 November 2099, preserving its ID and original charge. Admin recorded a fictional ₹100 receipt and ₹50 waiver on ended visit #2; explicit no-show appended the remaining ₹450 reduction. UI displayed original ₹500, effective ₹0, outstanding ₹0 and refundable ₹100, preserving one original receipt and two adjustments. No automatic refund occurred.

All local fixture data was fictional and separate from the live database. A temporary demo server stopped cleanly during the first browser session; it was restarted before admin checks. No real mail or financial operation was performed.

## Database and rollout notes

The migration is additive: existing appointment status CHECK, rows, IDs, links, indexes and triggers remain. no_show_at marks an irreversible outcome while raw status remains booked; API responses and reports project no_show. Any direct reporting integration must use the outcome field too. Tests verify repeated initialization, full fixture-row preservation, foreign_key_check, custom trigger/index retention, concurrency and injected failure rollback.

The original booking snapshot is immutable. Only an unconfirmed legacy_estimate can be confirmed once before ledger/adjustment entries. Cancelled effective charge is zero, without inventing retrospective waiver records. No historical visit becomes a no-show automatically. UTC normalization applies to response/new metadata, not bulk conversion of stored scheduling strings.

Do not roll back blindly to the old application after no-shows have been recorded: old code does not understand the additive terminal outcome and could expose invalid actions. A rollback must keep the no-show guards, or restore a coordinated pre-release database backup with an approved data-reconciliation plan. Provider backup/restore configuration and drills remain outside this student-project scope.

## Remaining release verification

Confirm the branch still descends from deployed baseline 93ab4aba82d52e10c18aa1afad0efa1114f5ba66, obtain a green remote workflow including Chromium journeys, merge only the verified candidate, and verify the hosted deployment using read-only live checks. Do not exercise financial/lifecycle test mutations on the live database.
