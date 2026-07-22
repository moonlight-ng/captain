# Production rollout

1. Build and deploy the monorepo without changing the existing Fly app names,
   Pilot volume, Telegram webhook, or database secrets.
2. Point Captain and the flight worker at Captain’s separate production
   database. Run `pnpm --filter @agents/captain db:migrate`; stop if migration
   reconciliation reports different legacy Trip or price-observation counts.
3. Configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`,
   `CAPTAIN_SESSION_SECRET`, `CAPTAIN_ALLOWLIST_TELEGRAM_USER_IDS`, and both
   directional HMAC secrets. Keep `CAPTAIN_AUTO_ALLOWLIST=false`.
4. Deploy Captain, verify `/health` and `/ready`, and register the Captain bot
   webhook at `/eve/v1/telegram`.
5. Deploy one always-on worker with the same Captain `DATABASE_URL`, Duffel
   token, and Telegram token. Verify `/ready` only after its first successful
   orchestration tick.
6. Switch Pilot to the Trip bridge and exercise one migrated legacy alias and
   one newly created Trip.
7. Admit the allowlisted beta gradually. Monitor due-work lag, provider call
   deduplication, search retries, offer age, duplicate-Trip count, per-user
   provider cost, and notification delivery.

Do not remove the old repositories, legacy schema, aliases, or compatibility
routes until two successful production releases and sampled price histories
have reconciled. Checkout and live booking are explicitly deferred.
