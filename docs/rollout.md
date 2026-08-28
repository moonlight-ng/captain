# Captain 1.0 production rollout

This is the historical activation procedure. This revision archives Captain;
use [the archive runbook](archive-runbook.md) for its deployment order and do
not follow the beta-opening steps below unless an explicit restore has been
approved.

## Credentials and ownership

Captain and its worker use the same Captain PostgreSQL database and public
Telegram bot. They never receive Pilot credentials or access Pilot's database.

Create ignored local environment files from the checked-in examples:

```sh
cp apps/captain/.env.example apps/captain/.env
cp apps/flight-worker/.env.example apps/flight-worker/.env
```

Captain requires `DATABASE_URL`, `WORKFLOW_POSTGRES_URL`,
`TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET_TOKEN`. The worker requires
`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `CAPTAIN_PUBLIC_URL`, and
`DUFFEL_ACCESS_TOKEN`. `FLYSOAR_MCP_URL` is optional and defaults to the
public Flysoar MCP transport.

Install the equivalent Fly secrets without putting their values in
`fly.toml`, Git, or GitHub variables stored as plain text:

```sh
fly secrets set -a dr-captain \
  TELEGRAM_BOT_TOKEN='…' TELEGRAM_WEBHOOK_SECRET_TOKEN='…' \
  DATABASE_URL='postgresql://…' WORKFLOW_POSTGRES_URL='postgresql://…'

fly secrets set -a dr-flight-worker \
  TELEGRAM_BOT_TOKEN='…' DATABASE_URL='postgresql://…' \
  CAPTAIN_PUBLIC_URL='https://dr-captain.fly.dev' DUFFEL_ACCESS_TOKEN='…'
```

## Safe sequence

For changes that add notification kinds or payload contracts shared by Captain
and the flight worker, deploy the worker consumer first. Verify its `/ready`
endpoint before deploying the Captain producer or its database migration. The
two GitHub deployment workflows are independent, so do not rely on their
completion order for a cross-service contract change.

1. Keep `CAPTAIN_PUBLIC_BETA_ENABLED=false` and
   `TRACKING_KILL_SWITCH=true`.
2. Run `pnpm check`.
3. Back up Captain's database, then run
   `pnpm --filter @agents/captain db:migrate`. The Captain 1.0 migration is a
   deliberate destructive cutover from the private prototype.
4. Deploy Captain with `CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED=false` and verify
   `/health`, `/ready`, one-time login exchange, profile editing, and account deletion.
5. Keep the legacy worker tracking kill switch enabled. New trips must not
   create watches or wake the worker.
6. Run the live Duffel evaluation corpus.
7. Force one harmless primary failure or use an empty test market and confirm
   the worker records a successful Flysoar result as `flysoar_mcp`.
8. Continue only if overall coverage reaches 80%, domestic and international
   subsets each reach 75% with three usable offers, representative carrier
   coverage is acceptable, and P95 search latency is below three minutes.
9. Enable `CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED=true` for the rollout cohort.
   Create a multi-city trip, run a partial and a complete manual leg search,
   select a flight, and verify the public canonical flight link leaks no trip data.
10. Set `CAPTAIN_PUBLIC_BETA_ENABLED=true` to admit new users, capped by
   `CAPTAIN_BETA_USER_LIMIT=25`.

If any launch gate fails, leave the beta closed and improve source coverage.
Do not display unverified fares or add unofficial Skyscanner scraping.
