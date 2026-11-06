# Focused student-project improvement release

Status: full focused release implemented locally; final integration/CI/deployment verification in progress. No live business records have been used for testing.

Baseline: GitHub/deployed commit `93ab4aba82d52e10c18aa1afad0efa1114f5ba66`.

## Policies selected on 6 November 2026

The user approved same-doctor rescheduling and delegated the other policy choices to the assistant. The following conservative defaults are the implementation specification, not claims about existing features.

### No-shows

An admin may manually mark a booked visit as a no-show after its scheduled end, only if the patient was not checked in. Do not automatically classify historical bookings. Waive the consultation charge and display any net money already received as an amount to refund. Recording a no-show never sends money or creates a refund receipt. Require an admin reason and retain the actor/time and visit history.

### Rescheduling

A patient may move their own future, unarrived booked visit; an admin may also move it. For this release, the target must belong to the same doctor and be available in the future. Keep the appointment ID, original fee snapshot, and all ledger references. Record the old/new slots, actor, time, and reason. Reserve the new slot and release the old slot atomically. If target validation or reservation fails, retain the original booking unchanged. Reject completed, cancelled, checked-in, and no-show visits. Do not automatically charge or refund money.

### Refunds

Refunds remain records of money already returned outside CareFlow, tied to their original receipt and payment method. A payment-correction refund reopens the balance without reducing the charge. A goodwill/service-discount refund must record an explicit matching charge reduction so that it does not create new debt. Save the distinction and reason; protect compound financial changes from partial success and duplicate retries.

### Charge waivers

Allow an admin to reduce the charge partially or fully, with a reason and recorded actor/time. Preserve the original charge snapshot and payment entries; append adjustment records instead. If the effective charge falls below net money received, show the excess as refundable rather than a negative debt. No charge increases or waiver reversal in this first release. Do not infer adjustments for historical refunds or silently rewrite financial history.

## Small implementation batches

1. Baseline, documentation, and reproducible source formatting. Correct the refund-race test to retry the actual winning request, not whichever request was listed first.
2. Clinic timezone helpers and day-boundary tests, preserving the meaning of existing clinic-local appointment strings. A bulk UTC data conversion is outside this release.
3. Charge adjustments and report calculations, including estimated versus confirmed charges, refunds, waivers, concurrency, and retry tests.
4. No-show eligibility and history, with non-destructive migration tests on SQLite3 and libSQL.
5. Atomic same-doctor rescheduling and notification/history checks, including collision and rollback tests.
6. Focused browser regression tests and CI build/test automation.
7. Complete regression, build, isolated browser verification, and migration review; only then publish and deploy, followed by read-only live checks.

The lifecycle and financial batches depend on the preceding checks. A failed baseline is investigated, not bypassed. Every batch gets a fresh credit balance check and a recorded delta.

## Data and release safety

- Tests use disposable databases with fictional records and mail delivery disabled or simulated.
- Never exercise payment, cancellation, or migration tests on the live database.
- Preserve appointment IDs, payment references, users, existing statuses, and attendance history.
- Validate migrations from the previous schema and repeated startup on both database adapters.
- Verify the GitHub branch has not changed before publishing.
- Do not deploy partial or unverified functional work.
- No full Angular rewrite, replacement authentication, payment gateway, or claim of healthcare production readiness.

## Credit tracking

| Checkpoint | Available credits | Notes |
|---|---:|---|
| Inspection start | 187.5 | Fresh tool report, 6 November 2026, about 19:15 IST |
| Local cleanup checkpoint | 123.5 | Fresh report about 19:22 IST; observed decrease 64 credits |

Credit deltas are account-wide observed consumption, not an exact invoice for a particular command.

## Local cleanup verification

README corrections, pinned formatting scripts, and the order-independent refund-race test are complete locally. Format checks, 41 top-level backend tests (plus the nested 21-test libSQL suite), and the Angular production build passed. JavaScript/TypeScript structure checks found no application-logic changes. The clinic-timezone batch is now implemented locally; see TIMEZONE-REGRESSION.md and timezone-batch-result.json for checks and limits. Browser end-to-end regression and the financial/lifecycle batches remain pending; nothing was deployed.

## Implemented storage and accounting details

No-shows are additive: no_show_at/reason/by/key are stored on appointments. The old status CHECK and all existing rows, IDs, foreign keys, indexes and triggers are retained; public responses project status no_show. Terminal guards reject further arrival, cancellation, completion, collection and rescheduling. The original slot remains occupied as historical evidence. Never report no-shows by reading raw status alone.

Charge adjustments and appointment history are append-only tables. SQL triggers make goodwill refund plus matching adjustment, no-show plus remaining waiver/history, and reschedule plus history/notification/outbox each statement-atomic. Cancelled effective charge is zero without inventing historical waiver records. Correction refunds remain available for cancelled/no-show receipts; goodwill cannot reduce a zero effective charge. Fee confirmation applies only once to unconfirmed legacy estimates before ledger/adjustment entries.

Rescheduling sends expected_slot_id to reject stale concurrent edits. Failed target validation, occupied slots, patient/doctor overlaps or outbox insertion leave the original reservation intact. Reasons are 5–500 trimmed characters. Existing receipts, fees and appointment IDs are retained.

Backend migrations and focused fixtures run against disposable SQLite3 and local-file libSQL databases, including repeated startup, preservation of custom triggers/indexes, foreign-key integrity, duplicate/race handling and injected atomic rollback failures. Hosted libSQL and production recovery drills remain operational work, not claims from these tests.
