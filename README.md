# Captain

> **Archived revision:** this revision puts Captain into a reversible shutdown
> state when deployed. It preserves historical data and admin access while
> closing traveller flows and stopping recurring work. See
> [the archive runbook](docs/archive-runbook.md).

Captain is a private Moonlight repository for a Telegram-first multi-city trip
planner and real-time flight search product.

You describe the cities and timing constraints. Captain turns each adjacent
city pair into a flight leg and checks every date in its window against live
inventory after the traveller confirms the plan. Captain then rechecks fares
and reports a useful initial cost picture or a material change.

- `apps/captain` owns onboarding, trip planning, and authenticated APIs.
- `apps/web` is the React UI Captain serves (traveller trip workspace and private `/admin`).
  Trips start in Telegram; `/trips` is the workspace home.
- `apps/flight-worker` runs initial and scheduled fare checks for confirmed plans.
- `packages` contains the flight domain, persistence, provider adapters,
  observability, and Telegram helpers shared by those two deployments.

Captain deploys as `dr-captain`; its worker is independently deployed as
`dr-flight-worker`. Pilot is a separate private product and repository.

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
