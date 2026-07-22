# Pilot and Captain

This private monorepo contains two product agents and their shared flight platform:

- `apps/pilot` — Opemipo's private generalist agent.
- `apps/captain` — the multi-user travel concierge and Trip workspace.
- `apps/flight-worker` — shared search scheduling and provider execution.
- `packages` — narrowly scoped code shared across deployment boundaries.

Pilot and Captain deploy independently and never share private data, secrets, instructions, or database connections. Users create Trips in Captain; provider searches are deduplicated across compatible Trip watches.

## Commands

```sh
corepack pnpm install
pnpm test
pnpm typecheck
pnpm build
```

