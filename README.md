# Captain

Captain is a private Moonlight repository for the Telegram-first travel agent,
its flight-search worker, and their shared flight platform.

- `apps/captain` owns onboarding, trip planning, authenticated APIs, and the
  traveller dashboard.
- `apps/flight-worker` owns scheduled provider searches, ranking, retention,
  and notifications.
- `packages` contains the flight domain, persistence, provider adapters,
  observability, and Telegram helpers shared by those two deployments.

Captain deploys as `dr-captain`; the worker deploys as `dr-flight-worker`.
They share Captain's Postgres schema but have independent Fly applications and
deployment credentials. Pilot is a separate private product and repository.

The current release stops at flight discovery. It does not book travel, take
payments, or collect passenger documents. Booking uses a fixed display-only test card.

## Commands

```sh
corepack pnpm install
pnpm check
pnpm eve:info
```

See [Captain's product contract](apps/captain/README.md),
[architecture](docs/architecture.md), and [rollout](docs/rollout.md).
