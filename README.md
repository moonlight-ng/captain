# Flight Agent

A private, independent Eve service for live flight exploration. Each trip is a
durable Flight Agent that searches Duffel, builds a transparent working set,
tracks price observations against stable destination/date/airline identities,
and promotes notable options for review.

Captain no longer owns Duffel. It starts and retrieves Flight Agents through a
signed bridge. Checks are fare-only unless the owner explicitly requests
fare-plus-research, in which case Flight Agent calls Captain's isolated Codex
bridge after preserving the Duffel result. Conversation remains external to
this interface.

## Local development

Requires Node.js 24+ and pnpm 11.

```sh
pnpm install
pnpm dev:api     # local API on 127.0.0.1:8080
pnpm dev:agent   # optional full Eve dev runtime
pnpm dev         # Vite UI on 127.0.0.1:4178
```

Vite proxies `/v1` to Eve. Without `DATABASE_URL`, local Eve uses an in-memory
server store. Without `DUFFEL_ACCESS_TOKEN`, checks fail visibly and schedule a
retry; the rest of the workspace remains operable. Copy `.env.example` for the
full local bridge and provider configuration.

## Production

The Fly app runs Vite and Eve from one origin. Configure these secrets before
deploying:

- `DATABASE_URL`
- `DUFFEL_ACCESS_TOKEN`
- `FLIGHT_AGENT_BASIC_PASSWORD`
- `CAPTAIN_TO_FLIGHT_AGENT_SECRET`
- `FLIGHT_AGENT_TO_CAPTAIN_SECRET`
- the AI gateway variables required by Eve

The Fly machine scales to zero with `auto_stop_machines="stop"` and wakes on
HTTP requests. There is no cron wake-up. Due checks are attempted
opportunistically by readiness traffic while the process is already awake.
`POST /internal/v1/flight-agents/:agentKey/checks` requires timestamped HMAC
authentication and an idempotency key; `{ "mode": "fare" }` refreshes fares,
while `{ "mode": "fare_and_research" }` refreshes fares and then calls Captain.

`pnpm db:migrate` owns the dedicated `flight_agent` schema. After deploying the
schema and before switching Captain redirects, run `pnpm db:import-captain` once
with the shared database URL. The importer is idempotent and preserves legacy
selection app keys. Normalized checks, activities, research runs, and price
observations are append-only; `agent_states` remains the operational snapshot
during this rollout.

Production uses a dedicated `flight_agent_runtime` Postgres login for both
`DATABASE_URL` and `WORKFLOW_POSTGRES_URL`. The Fly release command verifies the
domain migration ledger before a machine starts. Apply domain migrations and
bootstrap the isolated `flight_agent_eve` Workflow namespace separately with an
administrator connection whenever their schemas change; the runtime login does
not receive database-level creation privileges.

## Commands

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm eve:info
pnpm db:migrate
pnpm db:import-captain
```

The original generated visual prototype remains under
`prototype/voice-first-flight-exploration/` and is not part of the runtime.
