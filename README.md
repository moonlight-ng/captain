# Pilot and Captain

This private monorepo contains two product agents and their shared flight platform:

- `apps/pilot` — Opemipo's private generalist agent.
- `apps/captain` — the multi-user travel concierge and Trip workspace.
- `apps/flight-worker` — shared search scheduling and provider execution.
- `packages` — narrowly scoped code shared across deployment boundaries.

Pilot and Captain deploy independently and never share private data, secrets,
instructions, or database connections. Users create Trips in Captain; provider
searches are deduplicated across compatible Trip watches.

The current release stops at flight discovery. It includes no checkout,
booking, payment, or passenger-document collection.

## System shape

1. Captain receives a private Telegram message and resolves one
   durable traveller conversation.
2. Captain creates or updates a tenant-scoped Trip and its individual Watch.
3. The flight worker wakes due Watches, collapses matching provider requests
   into one shared SearchSpec, and leases work transactionally.
4. Duffel results are stored once, retained as price history, then ranked
   separately against every subscribed Trip’s budget and preferences.
5. Captain queues a deduplicated Telegram alert for first results, a price drop,
   a newly stronger itinerary, or a terminal Watch failure.

Pilot uses Captain’s signed internal Trip API. Each app now has matching
product, deployment, configuration, logging, and runtime identifiers:
`opemipo-pilot`/`PILOT_*` and `opemipo-captain`/`CAPTAIN_*`.

## Commands

```sh
corepack pnpm install
pnpm test
pnpm typecheck
pnpm build
```

See [architecture](docs/architecture.md) and [rollout](docs/rollout.md) for the
runtime boundaries and safe production sequence.
