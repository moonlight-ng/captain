# Captain

Captain is a private Moonlight repository for the Telegram-first flight price
tracker, its search worker, and their shared flight platform.

You describe a trip, Captain finds flights, you pick one to watch, and it
checks the price daily until you fly — telling you how it moves and when to buy.

- `apps/captain` owns onboarding, trip planning, authenticated APIs, and the
  traveller dashboard.
- `apps/flight-worker` owns scheduled provider searches, ranking, retention,
  and notifications.
- `packages` contains the flight domain, persistence, provider adapters,
  observability, and Telegram helpers shared by those two deployments.

Captain deploys as `dr-captain`; the worker deploys as `dr-flight-worker`.
They share Captain's Postgres schema but have independent Fly applications and
deployment credentials. Pilot is a separate private product and repository.

Captain tracks fares and nothing else. It does not book travel, take payments,
or hold any traveller identity: there is no passenger record and no stored card.

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
