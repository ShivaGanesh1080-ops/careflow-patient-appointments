# Isolated browser regression

CI builds the Angular client, installs Chromium, then runs npm run test:e2e. Local discovery only: npm run test:e2e -- --list. No browser download is required for discovery.

The suite cannot target a configurable/live URL: it starts http://127.0.0.1:4317 with reuseExistingServer disabled. The server wrapper strips inherited configuration, disables dotenv loading, fixes NODE_ENV=test (mail worker disabled), uses only demo accounts and a test-only JWT, and removes its dedicated OS-temporary fixture directory before every run. No production database or real mail configuration is used. Receipts and money are fictional. Seed code uses the server's own installed dependencies.

One worker and no retries avoid accidental inter-test financial repeats. The booking/reschedule, ledger/waiver, no-show/refundable, and eligibility scenarios use distinct fixture records. The temporary database is replaced on the next run; immutable receipts are never deleted through SQL. Failure traces/screenshots are CI artifacts, not deployment output.
