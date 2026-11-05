# CareFlow: Patient Appointment Management System

A student demonstration built with Angular, Bootstrap, Express, Node.js, Socket.IO, and SQLite. Use fictional data only. This is not a production healthcare system.

## Features

Patients can register, sign in, browse doctors, book available slots, cancel upcoming visits, and view history. Administrators manage doctors and availability, view registered patients, and cancel bookings with a required reason.

Authenticated live events refresh connected screens. Clinic cancellations create durable patient notifications and email-outbox jobs. Unread cancellations appear after login; closing a popup leaves it unread until the patient acknowledges it. Appointments confirm immediately, without an approval queue.

Live updates are best effort. There is no 20 ms delivery guarantee. SMTP acceptance does not prove inbox delivery.

## Run locally

Use a supported Node LTS release compatible with Angular 21 (Node 22.12+ or Node 24).

```sh
npm install
npm --prefix server install
npm --prefix client install --include=dev
npm run build
npm start
```

Open http://localhost:3000 and keep the terminal running. To use development mode, run `npm run dev` and open http://localhost:4200.

### Fictional demo accounts

| Role | Email | Password |
|---|---|---|
| Patient | patient@careflow.demo | Patient123! |
| Administrator | admin@careflow.demo | Admin123! |

These are intentional, public classroom credentials. Remove demo accounts and seed behaviour before any real deployment.

## Tests

```sh
npm test
```

On 5 November 2026, the recovered version passed 37 test entries (plus the nested 19-test API suite through libSQL) and an Angular production build. Browser checks covered new-patient live registration, booking, required clinic cancellation reason, immediate patient popup, unread popup persistence after login, and acknowledgement persistence.

The frontend runtime audit reported no known advisories at that check. Angular development tools retained 16 moderate advisories; npm proposed a major Angular CLI upgrade, which was not forced. Audits are time-sensitive and do not prove security.

## Database

The server creates `server/data/careflow.sqlite` locally. Users, doctors, slots, appointments, notifications, and email jobs are stored there. A partial unique index prevents two active bookings for one slot. The cancellation trigger creates the notification and email job within the appointment update transaction.

To inspect records without showing password hashes:

```sh
npm --prefix server run db:inspect -- users
npm --prefix server run db:inspect -- appointments
npm --prefix server run db:inspect -- notifications
npm --prefix server run db:inspect -- email_jobs
```

## Optional Gmail SMTP

Copy `server/.env.example` to `server/.env` locally and fill the sender configuration there. Never commit the real file, passwords, JWT secrets, or databases. Google app passwords require 2-Step Verification and may be unavailable for school/work accounts. Do not use your regular Gmail password.

Without configuration, in-app notices still work and email remains not configured. Automated tests use fake email transports; they send no real mail. The worker skips fictional `.demo` and `.invalid` recipients.

## Deployment status

This repository is a local application, not a completed cloud deployment. Hosting its Angular frontend alone does not host its API, database, live-update server, or email worker.

The simplest deployment for the unchanged application is one Node service serving both the compiled Angular frontend and API, with persistent SQLite storage. Before deploying, configure public host binding, persistent secrets, HTTPS, database backups, and non-demo account provisioning.

Free-demo adapters are now implemented: optional Turso/libSQL storage, a Render blueprint, first-admin bootstrap, persistent production JWT configuration, and Gmail HTTPS API transport. Local sqlite3 and SMTP remain available. An actual fresh Turso database passed connection/schema initialization. Local regression tests passed; deployed-browser verification and real Gmail authorization are still pending.

See [the free deployment guide](docs/FREE-DEPLOYMENT.md) for environment settings and limitations. Render Free sleeps when idle, has no persistent disk, and blocks SMTP. Email requires server-side OAuth credentials and a recipient allowlist; no real email has been sent.

References:
- Render Free: https://render.com/docs/free
- Render persistent disks: https://render.com/docs/disks
- Turso pricing: https://turso.tech/pricing
- Vercel SQLite guidance: https://vercel.com/kb/guide/is-sqlite-supported-in-vercel
- Google app passwords: https://support.google.com/accounts/answer/185833

Do not enter real patient information. This prototype still needs production security, privacy, accessibility, load, recovery, and deployment reviews.
