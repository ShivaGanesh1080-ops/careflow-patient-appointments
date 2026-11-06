# CareFlow â€” Patient Appointment Management System

## Current deployed features

CareFlow includes authenticated live updates, patient records, clinic-cancellation reasons and saved notices, slot-count planning, admin arrival/completion tracking, and a manual payment/refund ledger with revenue reports. The email worker supports Gmail HTTPS or SMTP when configured; a saved notice does not prove delivery. See [live updates and email](docs/LIVE-UPDATES-AND-EMAIL.md) and [deployment](docs/FREE-DEPLOYMENT.md).

This README describes the current source, including same-doctor rescheduling, explicit no-shows, append-only charge waivers and correction/goodwill refunds. See [release policies and storage details](docs/IMPROVEMENT-RELEASE.md). Local validation is not evidence of a completed deployment; release status is recorded separately.

To inspect local records safely: `npm --prefix server run db:inspect -- users` (also accepts appointments, notifications, and email_jobs). Password hashes are excluded.

WTMP project â€¢ B38_Team 4 â€¢ Evaluation: 27 November 2026

A mobile-friendly appointment website built with Angular, Bootstrap, Node.js, Express, and SQLite-compatible storage (local SQLite3 or Turso/libSQL for deployment). Angular uses TypeScript; the backend uses JavaScript. All doctor profiles and demo accounts are fictional.

## Requirements

- Node.js 22.12+ or Node.js 24 LTS, with npm. Use an LTS version compatible with Angular 21.
- A browser such as Chrome, Edge, or Strawberry.
- Internet for the initial npm installation only. The app itself uses a local SQLite database and bundled styles.
- Local demonstration needs no cloud database. The Render deployment uses a configured remote Turso database; do not rely on local database files on the free web service.

## Run it on Windows

Open a terminal in this project folder (the folder containing this README).

```powershell
npm install
npm run install:all
npm run build
npm start
```

Open **http://localhost:3000**. Keep the terminal open while using the website. Press Ctrl+C to stop it. After the first setup, only `npm start` is needed, unless you change the Angular code; then run `npm run build` again.

### Development mode

```powershell
npm run dev
```

Open **http://localhost:4200**. Angular proxies `/api` requests to Express on port 3000. This mode refreshes the frontend when you edit it. Do not run the production server and development backend at the same time on port 3000.

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Patient | patient@careflow.demo | Patient123! |
| Administrator | admin@careflow.demo | Admin123! |

You can also register a new patient account. These published credentials are for a local classroom demonstration only.

## Features

Patients can register and sign in, search doctors by name or specialty, choose an available date and slot, book a consultation, cancel an upcoming appointment, and review appointment history. Patients can reschedule their own future, unarrived booked visit to an available same-doctor slot, with a required reason. Admins can manage doctor profiles, generate slots by working hours or count, inspect bookings, cancel with a reason, record arrival, and complete checked-in visits after the patient finishes, including before the scheduled end. Admins can record money already received or refunded outside CareFlow and view date-filtered collections. They can reduce charges with a reason and explicitly mark unarrived visits as no-shows after the scheduled end. Rescheduling and no-shows retain an append-only history; no action moves money automatically.

The database rejects two active bookings for the same slot. The API also rejects overlapping bookings for the same patient, past bookings, unauthorized changes, and invalid inputs. Deactivating a doctor preserves history and requires cancellation of upcoming bookings first.

Six fictional doctor profiles are seeded. Each server startup adds availability for the next 14 days, except Sundays, at 09:00â€“12:00 and 14:00â€“16:00 in 30-minute slots. Newly created doctors need slots added by an administrator. Cancelled slots can be booked again.

## How the parts work

```text
Angular pages (TypeScript + HTML + CSS + Bootstrap)
        â†“ HTTP requests / JSON / Bearer token
Express REST API (JavaScript, Node.js)
        â†“ parameterized SQL
SQLite-compatible database (local SQLite3 or remote Turso/libSQL)
```

- `client/`: Angular standalone frontend.
- `server/index.js`: Express routes, permissions, validation, static frontend hosting.
- `server/db.js`: schema, additive migrations, SQLite3/libSQL adapters, and fictional seed records.
- `server/payments.js`: manual ledger, legacy estimate confirmation, charge reductions and revenue reports.
- `server/release-schema.js`: additive no-show/history/adjustment migration and atomic financial/lifecycle triggers.
- `server/lifecycle.js`: owned/admin rescheduling, history and explicit admin no-shows.
- `client/src/app/live-updates.service.ts`: authenticated Socket.IO change notices; the component fetches fresh API data.
- `server/test/api.test.js`: automated API tests with a separate temporary database.
- `server/data/careflow.sqlite`: generated database; persists after restarting.
- `server/data/.jwt-secret`: generated local signing key; do not share it.

Scheduling stores timezone-less Asia/Kolkata (IST) wall-time strings. The local source now calculates clinic dates independently of the server/browser timezone and attaches +05:30 to appointment start/end values at the frontend response boundary. Date displays default to IST; UTC audit and payment timestamps retain their meaning. Finance report dates use the same clinic date. Existing scheduling timestamps were not bulk-converted. Known timezone-less UTC audit fields gain Z at the response boundary, and new metadata uses UTC ISO. See [timezone regression checks](docs/TIMEZONE-REGRESSION.md).

New bookings snapshot the fee in integer paise. Older migrated charges are labeled estimates and may be confirmed once before any ledger entry or adjustment. Booking snapshots and confirmed charges are immutable; discounts append charge reductions. Payments and refunds are append-only manual records, not online payment processing. Net collections equal recorded payments minus refunds; completed visits do not imply payment. Effective charge equals the original snapshot minus recorded reductions; cancelled visits have zero effective charge. Outstanding is max(effective charge minus net received, 0), and refundable excess is max(net received minus effective charge, 0). No-show waives the remaining charge but preserves collected money for a manual refund decision. A correction refund retains the charge, while a goodwill refund appends a matching reduction atomically. Cancellation removes a visit from outstanding charges but does not refund money. These balances are not bank-verified receivables. No prescriptions or real medical advice are provided.

## Database design

- **users**: id, name, unique email, password_hash, phone, role, created_at.
- **doctors**: id, name, specialization, qualification, bio, experience, fee, active.
- **slots**: id, doctor_id, start_time, end_time. A doctor cannot have duplicate start times.
- **appointments**: patient/doctor/slot links, reason, booked/cancelled/completed status, cancellation details, checked_in_at/checked_in_by, completed_at, fee_paise, fee_basis, additive no_show_at/reason/by/key, and reschedule actor/time/reason metadata. The API projects status no_show when no_show_at exists; the legacy stored status remains booked so no table rebuild is required.
- **payment_entries**: appointment link, payment/refund kind, integer amount_paise, method, reference, notes, original_payment_id for refunds, recorded_by/recorded_at, and unique idempotency_key. refund_type distinguishes correction/goodwill. Update/delete triggers preserve ledger history.
- **charge_adjustments**: immutable reductions with integer amount, reason, admin actor/time, kind, idempotency key and optional matching goodwill refund link.
- **appointment_history**: immutable reschedule/no-show events with old/new slots and wall times, reason, actor and UTC timestamp.
- **notifications**: user and optional appointment links, message/reason, read_at, and email_status.
- **email_jobs**: unique notification link, recipient, retry schedule, attempts, and sent_at.

Relationships: a doctor has many slots and appointments; a patient has many appointments; a slot has historical cancelled bookings but at most one booked/completed appointment. A partial unique index enforces the last constraint.

## API reference

All endpoints start with `/api`. Protected requests use `Authorization: Bearer <token>`. Errors use `{ "error": "message" }`.

| Method | Path | Access / purpose |
|---|---|---|
| GET | /health | API status |
| POST | /auth/register | Create patient: name, email, password, optional phone |
| POST | /auth/login | Sign in with email and password |
| GET | /auth/me | Current signed-in user |
| GET | /doctors | Search: `search`, `specialization`; admin can use `includeInactive=true` |
| GET | /specializations | Active specializations |
| GET | /doctors/:id/slots?date=YYYY-MM-DD | Slots and availability |
| GET | /appointments | Signed-in patient's history |
| POST | /appointments | Patient: slotId, optional reason |
| PATCH | /appointments/:id/cancel | Owning patient; future booked appointments only |
| PATCH | /appointments/:id/reschedule | Owner or admin: numeric slotId, expected_slot_id and reason (5–500 chars) |
| GET | /appointments/:id/history | Owner or admin: immutable visit-change history |
| GET | /admin/stats | Admin counts |
| GET | /admin/appointments | All appointments |
| POST | /admin/doctors | Add doctor |
| PUT | /admin/doctors/:id | Edit doctor |
| DELETE | /admin/doctors/:id | Deactivate doctor; keep history |
| POST | /admin/slots | doctorId, date, startTime, intervalMinutes; use endTime or slotCount (1â€“96) |
| PATCH | /admin/appointments/:id/status | Admin: complete a checked-in booked visit, or cancel with reason |
| PATCH | /admin/appointments/:id/arrival | Admin: arrived boolean; booked visits only |
| PATCH | /admin/appointments/:id/no-show | Admin: reason; booked, unarrived, strictly after end; waive remaining charge, no automatic refund |
| POST | /admin/appointments/:id/waivers | Admin: amount_paise, reason, UUID idempotency_key; append reduction |
| GET | /admin/patients | Admin patient list without password hashes |
| GET | /notifications | Signed-in user notices (up to 200) |
| PATCH | /notifications/:id/read | Mark own notice read |
| PATCH | /notifications/read-all | Mark own notices read |
| GET | /admin/appointments/:id/payments | Admin ledger and charge details |
| PATCH | /admin/appointments/:id/fee | fee_paise; one legacy_estimate confirmation before any ledger entry/adjustment |
| POST | /admin/appointments/:id/payments | payment/refund, integer amount_paise, method, UUID idempotency_key; refunds require original_payment_id and notes; refund_type correction (default) or goodwill |
| GET | /admin/revenue?from=YYYY-MM-DD&to=YYYY-MM-DD | Admin report; max 366 inclusive days, IST entry dates |

Completion requires a recorded arrival and a booked status; it does not require waiting until the scheduled end. Slots use intervals of 15, 20, 30, 45, or 60 minutes. Count mode calculates the end time; schedules reaching/crossing midnight are rejected, and overlapping existing slots are skipped without changing bookings.

## Test and demonstrate

```powershell
npm test
```

Tests use a temporary database and do not erase your demonstration records.

Suggested viva demonstration:

1. Sign in as a patient, browse doctor profiles, and choose a date with available slots. Booking opens on today in IST; seeded availability usually starts tomorrow and excludes Sundays.
2. Book a time slot and show it in appointment history.
3. Use another patient account to show that the same slot cannot be booked twice.
4. Cancel the appointment and show that the slot becomes available again.
5. Sign in as admin, add a doctor, and generate that doctor's availability.
6. Show the SQLite tables and explain primary keys, foreign keys, the unique booking index, and parameterized queries.
7. Explain a REST request from the Angular page through Express to SQLite.

## Troubleshooting

- **Port already in use:** stop the other app using port 3000 or 4200. For a different production port, use `$env:PORT=3001; npm start` in PowerShell, then open localhost:3001. The development proxy still expects port 3000 unless edited.
- **Empty availability:** choose one of the seeded upcoming dates, or add slots through admin. Sundays have no seeded slots.
- **Session expired:** sign out and sign in again. Tokens expire after eight hours.
- **Frontend not visible on port 3000:** run `npm run build`, then restart the server.
- **Native SQLite installation fails:** use a supported Node LTS release and reinstall server dependencies. Some environments need local build tools if npm cannot download a compatible prebuilt sqlite3 binary.
- **Reset demo data:** stop the server and back up `server/data` before deleting it. Deleting that folder permanently removes all local users/bookings and resets demo data on restart.

## Security and scope

This is a classroom prototype, not a production healthcare system. It hashes passwords with bcrypt, uses signed expiring JWTs, checks roles on the server, rate-limits authentication, and uses parameterized SQL. It binds to localhost by default. Tokens are held in browser local storage for this demo. Production deployment would require HTTPS, stricter content security policy, a secure-cookie/session design, account recovery, audit logging, backups, privacy review, and removal of public demo accounts. Do not enter real patient or sensitive medical data.

## Team

| Roll number | Name |
|---|---|
| 2503A51107 | NEERUDU GIFTY TANIKSHA |
| 2503A51108 | CHANDUPATLA NAVEEN REDDY |
| 2503A51109 | KARRE SHIVA SAKETH |
| 2503A51110 | AKKU SHIVA GANESH |
| 2503A51111 | VELDANDI SAI CHARAN |

Confirm name spellings against the official class list before submitting the report. This README explains the implementation; it is not a faculty-formatted project report.
