# Captain

Captain is the public, Telegram-first travel agent. A traveller creates a
durable **Trip**; Captain tracks its flight combinations, discovers the
strongest current option, and sends useful updates when the first results
arrive, a price drops materially, a better itinerary appears, or tracking
needs attention.

There is deliberately no checkout or booking flow in this release. Captain
does not collect payment, passport, identity-document, or complete passenger
details in Telegram.

## Runtime split

- This app owns Telegram conversations, tenant authorization, Trip APIs, the
  compatibility UI, and the new `captain` database schema.
- `../flight-worker` is the only new runtime that schedules or executes Trip
  searches. Health and readiness endpoints never run searches.
- `../../packages/flight-domain` normalizes Trips and hashes provider requests.
- `../../packages/flight-store` leases shared runs, stores price history,
  evaluates each Trip separately, and queues idempotent notifications.
- The legacy `/internal/v1/flight-agents` API remains available for one
  compatibility release. Pilot now uses `/internal/v1/trips`.

Each Telegram identity resolves from its 64-bit Telegram user ID. Any traveller
can message Captain and create Trips; suspended accounts remain blocked. Every
Trip query and mutation is scoped to the authenticated Captain user; public API
calls use a signed short-lived session token, while Pilot uses timestamped HMAC
requests with replay protection and idempotency keys.

## Local development

From the monorepo root:

```sh
corepack pnpm install
pnpm --filter @agents/captain dev:agent
pnpm --filter @agents/flight-worker start
```

Without `DATABASE_URL`, Captain uses an in-memory platform store. The worker
requires PostgreSQL because it is an independent process. Copy `.env.example`
and set a separate Captain database, Telegram bot token and webhook secret,
Duffel token, signed bridge secrets, and a long random session secret. Set
`WORKFLOW_POSTGRES_URL` to Captain's database as well so its Eve conversations
never enter Pilot's database.

Register Captain's Telegram webhook after its public app URL and secrets are
configured (or pass `--delete` to remove it without discarding pending updates):

```sh
pnpm --filter @agents/captain telegram:webhook
```

Apply domain migrations from this directory:

```sh
pnpm db:migrate
```

Migration `006_captain_platform.sql` creates the tenant, Trip, Watch, shared
search, offer, history, notification, and audit tables. The migration command
also builds SearchSpecs for imported legacy Trips and refuses to finish unless
legacy Trip and price-history counts reconcile. Migration
`007_public_captain_access.sql` activates existing waitlisted users while
preserving explicitly suspended accounts.

## Production defaults

- Maximum three active Trips per traveller.
- Maximum 24 provider combinations per Trip.
- Six-hour default tracking cadence; one-hour minimum.
- Worker orchestration every 60 seconds.
- Shared-result freshness of 15 minutes.
- 180-second leases, three attempts, four globally active runs, and one Duffel
  request at a time per worker.
- Quiet hours from 22:00 to 07:00 in the traveller’s timezone for non-critical
  notifications.

Captain deploys as `dr-captain` and uses only `CAPTAIN_*` settings for its
own runtime. `PILOT_BASE_URL`, `PILOT_TO_CAPTAIN_SECRET`, and
`CAPTAIN_TO_PILOT_SECRET` describe the explicit bridge to Pilot.
