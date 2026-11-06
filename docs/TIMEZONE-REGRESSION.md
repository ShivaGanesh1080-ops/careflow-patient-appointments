# Clinic timezone regression batch

This is a local source change, not a deployment. Stored scheduling strings keep their existing Asia/Kolkata wall-time meaning; there is no UTC conversion or data migration. Payment/refund calculations, schema, lifecycle rules and the policy proposals in IMPROVEMENT-RELEASE.md are unchanged.

## What changed

The server uses pure clinic-date helpers rather than host-local getters. Availability date validation and demo-calendar day selection are host-independent. Revenue defaults use that same clinic date, without parsing a locale-formatted string.

The frontend normalizes only response fields named `start_time` and `end_time`: timezone-less historical strings gain `+05:30`; explicit UTC/offset timestamps remain unchanged. Known UTC audit fields (created_at, read_at, checked_in_at, completed_at, recorded_at) also gain Z when returned without a timezone; explicit offsets are preserved. This boundary copies values without mutating requests or stored records. Angular date displays default to `+0530`, including UTC audit timestamps. Comparisons use the clinic helper even if called with an unnormalized scheduling value.

Booking now starts on today in IST, with one normal availability request and no Sunday-skipping/search loop. An empty day stays empty until the user chooses another date. The minimum selectable date is calculated fresh; the displayed clock updates at each minute boundary and its timer is cleared on component destruction. A stale selected slot is rechecked before booking. The planner keeps the user's chosen date after midnight, but its fresh minimum disables a past-day submission. Finance date-range defaults use the same clinic-day calculation.

## Run locally

Use Node 24 and install the locked dependencies with `npm ci`, `npm ci --prefix server`, and `npm ci --prefix client`. Then run:

```powershell
npm run format:check
npm test
npm run test:timezone
npm run build
```

The backend suite uses disposable fictional databases; the timezone suite never opens a database. The timezone command executes the actual backend helpers and transpiles the actual frontend helper with the existing TypeScript dependency. It also runs Angular's actual DatePipe with the bootstrap's shared default options. Fixed instants cover IST midnight, year/leap-day changes, US DST, finance offsets, historical strings, explicit offsets, immutable/idempotent response normalization, strict future-time and adjacent-slot boundaries. Each group runs under UTC, Asia/Kolkata, America/Los_Angeles and Pacific/Kiritimati.

`.github/workflows/ci.yml` defines clean installs, formatting, the backend suite, timezone regressions and the Angular production build on push/pull request. This workflow has not been pushed or run remotely. Branch protection and required status checks have not been verified or configured.

## Limits

These are helper/formatter and backend regressions, not a browser end-to-end suite. Timer cleanup and rollover wiring were reviewed in source; suspended tabs refresh on resumed change detection/timers and server validation remains authoritative. No live records, credentials or deployment were used. The fixed offset is correct for this clinic's modern Asia/Kolkata scheduling, not a general historical timezone engine or a multi-clinic timezone feature.

## Recovery verification, 6 November 2026

Recovered into the current account. Fixed SQLite UTC audit timestamp parsing and added real DatePipe regressions for timezone-less UTC values. Formatting, 41 top-level backend tests plus nested 21-test libSQL suite, four timezone groups, and Angular production build passed again. Isolated local browser smoke check verified patient demo login, dashboard, doctor search, booking opens on clinic today (2026-11-06), empty day remains selected, IST label, and disabled confirmation without a slot. No real booking/payment/live data modified. This was not a full E2E or browser timezone-emulation suite. No deployment or remote CI run.
