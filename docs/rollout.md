# Production rollout

## Where the new Captain credentials go

Captain and its worker use the same Captain PostgreSQL database and the same
public Telegram bot token. They never use Pilot's Supabase project or Pilot bot
token.

For local setup, create ignored files from the examples:

```sh
cp apps/captain/.env.example apps/captain/.env
cp apps/flight-worker/.env.example apps/flight-worker/.env
```

Put the new bot token in `TELEGRAM_BOT_TOKEN` in both files. Put the Captain
Supabase Postgres connection string—not the project URL, anon key, or service
role key—in `DATABASE_URL` in both files. Captain also needs
`WORKFLOW_POSTGRES_URL` pointed at the Captain database, plus a random
`TELEGRAM_WEBHOOK_SECRET_TOKEN` and `CAPTAIN_SESSION_SECRET`; the worker does
not. The `.env` files are ignored by Git.

In production, install the same values as Fly secrets on their owning apps:

```sh
fly secrets set -a opemipo-flight-agent \
  TELEGRAM_BOT_TOKEN='…' TELEGRAM_WEBHOOK_SECRET_TOKEN='…' \
  DATABASE_URL='postgresql://…' WORKFLOW_POSTGRES_URL='postgresql://…' \
  CAPTAIN_SESSION_SECRET='…'

fly secrets set -a opemipo-flight-worker \
  TELEGRAM_BOT_TOKEN='…' DATABASE_URL='postgresql://…' \
  DUFFEL_ACCESS_TOKEN='…'
```

Do not put the token or database password in `fly.toml`, a committed file, or
this repository's GitHub settings as plain text. The existing private Pilot
credentials stay on `opemipo-captain`.

## Sequence

1. Build and deploy the monorepo without changing the existing Fly app names,
   Pilot volume, Telegram webhook, or database secrets.
2. Point Captain and the flight worker at Captain’s separate production
   database. Run `pnpm --filter @agents/captain db:migrate`; stop if migration
   reconciliation reports different legacy Trip or price-observation counts.
3. Configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`,
   `CAPTAIN_SESSION_SECRET`, and both directional HMAC secrets. Captain is
   public: every new private Telegram user is active unless explicitly
   suspended.
4. Deploy Captain, verify `/health` and `/ready`, and register the Captain bot
   webhook at `/eve/v1/telegram`.
5. Deploy one always-on worker with the same Captain `DATABASE_URL`, Duffel
   token, and Telegram token. Verify `/ready` only after its first successful
   orchestration tick.
6. Switch Pilot to the Trip bridge and exercise one migrated legacy alias and
   one newly created Trip.
7. Open the public bot. Monitor due-work lag, provider call
   deduplication, search retries, offer age, duplicate-Trip count, per-user
   provider cost, and notification delivery.

Do not remove the old repositories, legacy schema, aliases, or compatibility
routes until two successful production releases and sampled price histories
have reconciled. Checkout and live booking are explicitly deferred.
