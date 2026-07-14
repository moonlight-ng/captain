# Captain operations

## Runtime

- Eve is the only production process and serves Telegram, Concierge, durable
  sessions, approvals, schedules, tools, and subagents.
- `@workflow/world-postgres@5.0.0-beta.24` persists Eve runs, events, hooks,
  streams, and queues in Supabase Postgres.
- Deterministic TypeScript services own provider calls, risk checks, database
  writes, and outbound delivery.
- `/data/captain` is the single-writer Markdown memory volume. The Raspberry Pi
  is a read-only cold mirror and never participates in live memory reads.

## Deploy

1. Apply pending Supabase migrations.
2. Confirm the `captain_eve` Workflow role is configured with
   `supabase/workflow-postgres-setup.sql` and hardened with
   `supabase/workflow-postgres-harden.sql`.
3. Run `pnpm test`, `pnpm typecheck`, `pnpm eve:info`, and `pnpm build`.
4. Deploy with `fly deploy` or push to `main` to use GitHub Actions.
5. Check `/health`, the Fly machine health checks, and Workflow queue activity.

The Fly release command runs the pinned Postgres World bootstrap before each
deployment. Keep `WORKFLOW_POSTGRES_URL` on a direct encrypted Supabase
connection owned by the dedicated Workflow role.

## Telegram webhook

Register or refresh the production webhook from a trusted machine with the
production environment loaded:

```sh
pnpm telegram:webhook
```

Remove it before restoring an older Fly image:

```sh
pnpm telegram:webhook -- --delete
```

## Memory and backup

Captain reads and writes Markdown under:

```text
/data/captain/memory/*.md
/data/captain/journals/YYYY/YYYY-MM-DD.md
```

The Fly volume is authoritative. The Pi timer mirrors the code checkout,
Supabase domain data, and the complete memory tree without writing back to
production. Inspect it with:

```sh
systemctl list-timers captain-sync.timer
sudo systemctl status captain-sync.service
sudo journalctl -u captain-sync.service -n 100 --no-pager
```

## Canary mode

Use `CAPTAIN_EVE_MODE=canary` with a distinct
`WORKFLOW_POSTGRES_JOB_PREFIX`. Do not register the Telegram webhook. The
dispatcher and mutable outbound tools fail closed in canary mode.

## Recovery

1. Remove the Telegram webhook.
2. Restore the previous Fly image while keeping the existing volume mounted.
3. Confirm Workflow bootstrap and `/health` succeed.
4. Re-register the webhook after Telegram and Concierge smoke tests pass.

Restoring an image does not roll back Markdown memory. Recover memory from the
Pi mirror or a Fly volume snapshot only when the filesystem itself is damaged.
