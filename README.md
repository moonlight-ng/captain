# Captain

Captain is a private Moonlight repository for a Telegram-first multi-city trip
planner and real-time flight search product.

You describe the cities and timing constraints. Captain turns each adjacent
city pair into a flight leg and, when asked, checks every date in a window of up
to seven days against live inventory. Results are a point-in-time snapshot;
Captain does not automatically recheck them.

- `apps/captain` owns onboarding, trip planning, authenticated APIs, and the
  traveller dashboard.
- `apps/flight-worker` retains the read-only legacy tracking runtime. New trips
  never create its watches or scheduled work.
- `packages` contains the flight domain, persistence, provider adapters,
  observability, and Telegram helpers shared by those two deployments.

Captain deploys as `dr-captain`. The retained worker is independently deployed
and disabled for new trip work. Pilot is a separate private product and
repository.

Captain plans cities and searches flights. It does not book travel, take
payments, or hold any traveller identity: there is no passenger record and no
stored card.

`/feedback` is the sole cross-product integration: Captain sends a signed,
bounded notification to Pilot for Telegram delivery, without sharing trip data
or opening a Pilot agent turn.

## Commands

```sh
corepack pnpm install
pnpm check
pnpm eve:info
```

See [Captain's product contract](apps/captain/README.md),
[architecture](docs/architecture.md), and [rollout](docs/rollout.md).
