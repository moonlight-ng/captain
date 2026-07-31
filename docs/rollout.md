# Captain 1.0 production rollout

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

1. Keep `CAPTAIN_PUBLIC_BETA_ENABLED=false` and
   `TRACKING_KILL_SWITCH=true`.
2. Run `pnpm check`.
3. Back up Captain's database, then run
   `pnpm --filter @agents/captain db:migrate`. The Captain 1.0 migration is a
   deliberate destructive cutover from the private prototype.
4. Deploy Captain and verify `/health`, `/ready`, one-time login exchange,
   profile editing, and account deletion.
5. Deploy one worker. Leave tracking disabled while checking readiness and
   logs.
6. Run the live Duffel evaluation corpus.
7. Force one harmless primary failure or use an empty test market and confirm
   the worker records a successful Flysoar result as `flysoar_mcp`.
8. Continue only if overall coverage reaches 80%, domestic and international
   subsets each reach 75% with three usable offers, representative carrier
   coverage is acceptable, and P95 search latency is below three minutes.
9. Turn off `TRACKING_KILL_SWITCH` for private users and observe at least one
   full adaptive cycle.
10. Set `CAPTAIN_PUBLIC_BETA_ENABLED=true` to admit new users, capped by
   `CAPTAIN_BETA_USER_LIMIT=25`.

If any launch gate fails, leave the beta closed and improve source coverage.
Do not display unverified fares or add unofficial Skyscanner scraping.
