# Free CareFlow demonstration deployment

## Implemented

CareFlow can use its original local sqlite3 database or a Turso/libSQL database. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` on the backend to select hosted storage. An actual fresh Turso database was initialized successfully during setup on 5 November 2026; foreign keys were enabled, and the initial admin, fictional doctors, and slots were present. This is a connection/schema check, not a complete cloud end-to-end test.

The Render blueprint serves compiled Angular and the Express/Socket.IO backend on one origin. A separate Vercel frontend is unnecessary for this route. Frontend-only hosting would not run the API, database, realtime server, or email worker.

The full local suite passed 37 test entries, including a nested run of the original 19-test API suite through the libSQL file adapter. Gmail HTTPS tests use fake responses; they do not prove real email delivery.

## Free-service limits

Render Free has no persistent disk, sleeps after 15 minutes without inbound traffic, and can take about one minute to wake. Its standard SMTP ports are blocked. A remote database preserves records, but the sleeping application cannot continuously process email retries. The public app is a student demonstration, not production medical software. Do not use real clinical records.

Turso offers a free plan, subject to its current quotas. The database token created for this demonstration has a 30-day expiry; rotate it in Turso and update the backend secret before it expires. Do not post it in an issue or chat.

## Render configuration

Use the repository's `render.yaml` blueprint. Choose the Free service, keep the database region close to the backend (Singapore in this setup), and do not enable paid resources or overages.

Required secrets:

- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from your CareFlow database.
- `JWT_SECRET`: a persistent cryptographically random value. Changing it invalidates current login tokens.
- `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`: create the first administrator only. Password length is 12–100 characters. They never reset an existing account's password. The blueprint can generate a random password; store it privately.

Keep `NODE_ENV=production`, `HOST=0.0.0.0`, `TZ=Asia/Kolkata`, and `SEED_DEMO_USERS=false`. The host supplies `PORT`. Public classroom demo accounts are not created in a fresh production database. The login page's local demo shortcuts do not grant access to a production database without those accounts.

The deployment remains single-instance. Database notifications and mail-outbox records are durable, but realtime delivery is best effort. Local-time date strings assume one clinic timezone; this is not a multi-timezone appointment system.

## Gmail over HTTPS

Use `MAIL_PROVIDER=gmail_api`, not SMTP, on Render Free. The backend needs:

- `GMAIL_USER`: the authorized sender address.
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` from your own Google OAuth client.
- `MAIL_ALLOWED_RECIPIENTS`: comma-separated, explicitly approved test recipient addresses. Production mail fails closed without this allowlist.

Enable the Gmail API in a Google Cloud project, configure Google Auth Platform/consent and an OAuth client, authorize only `https://www.googleapis.com/auth/gmail.send`, and request offline access for a refresh token. Save credentials directly in backend environment secrets. Do not put them in Angular, the repository, a screenshot, or chat. This repository does not yet include a browser OAuth setup flow; use an approved OAuth client workflow and keep the resulting credentials private.

Google Cloud can require two-step verification. A university administrator can block OAuth authorization. External OAuth apps in Testing status generally receive refresh tokens expiring after seven days when requesting Gmail scope, so a test setup may need reauthorization before a later demonstration. Do not assume a token obtained today will work on evaluation day.

Without OAuth configuration, email remains `not_configured`; in-app notices still work. Fictional `.demo` and `.invalid` recipients are never sent to real email providers. Only run one real fictional-content cancellation test after sender authorization and recipient approval. Provider acceptance is not proof of inbox arrival.

## Check after deployment

1. Check `/api/health` reports the libSQL adapter.
2. Sign in as the privately configured administrator; use a separate browser session to register a fictional patient.
3. Verify the administrator patient list updates automatically.
4. Book a future slot, cancel it with a reason as admin, and check the patient popup.
5. Dismiss without acknowledging, sign out/in, and verify the unread popup returns. Acknowledge it and repeat login; it should not return.
6. Inspect notification/outbox status. Test real email only with authorized sender credentials and approved recipient.
7. Redeploy/restart and verify accounts/appointments persist. A successful build alone is not this persistence check.

References:
- https://render.com/docs/free
- https://render.com/docs/websocket
- https://render.com/docs/disks
- https://turso.tech/pricing
- https://docs.turso.tech/sdk/ts/reference
- https://developers.google.com/workspace/gmail/api/guides/sending
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2#expiration
