# Eve cutover runbook

## Architecture

- Eve is the only production process and serves Telegram, Concierge, durable
  sessions, approvals, schedules, and subagents.
- `@workflow/world-postgres@5.0.0-beta.24` persists Eve runs, events, hooks,
  streams, and queues in Supabase Postgres.
- Existing deterministic TypeScript modules own provider calls, risk checks,
  writes, and outbound delivery.
- `/data/captain` is a single-writer Fly volume. The Pi is a read-only cold
  mirror and never participates in live memory reads.
- The legacy runtime remains buildable with `pnpm build:legacy` and can run with
  `CAPTAIN_LEGACY_MODE=active` during rollback.

## Prepare

1. Create a Supabase login named `captain_eve` with a strong generated password.
2. Run `supabase/workflow-postgres-setup.sql` as an administrator.
3. Set `WORKFLOW_POSTGRES_URL` to that role's direct connection URL. Its role
   owns Workflow's fixed schemas and has no privileges on Captain domain tables.
   Use `uselibpqcompat=true&sslmode=require` for Supabase's encrypted connection.
4. Create `captain_data` in `lhr` and mount it at `/data`.
5. Set `TELEGRAM_WEBHOOK_SECRET_TOKEN` to a high-entropy random secret.
6. Apply Supabase migrations, including scheduler leases and Eve mirror columns.
7. After the first successful Workflow bootstrap, run
   `supabase/workflow-postgres-harden.sql` to remove the temporary ability to
   create compatibility types in `public`.

## Canary

1. Deploy a separate Fly app and volume with `CAPTAIN_EVE_MODE=canary` and a
   distinct `WORKFLOW_POSTGRES_JOB_PREFIX`.
2. Do not register its Telegram webhook. The dispatcher and outbound email,
   trading changes, and mutable flight tools fail closed in canary mode.
3. Verify `/health`, protected `/eve/` routes, Workflow persistence across a
   restart, Concierge contract tests, filesystem memory, tools, and subagents.

## Cut over

1. Deploy the compatibility image with the volume mounted and legacy still
   active.
2. Run
   `node --experimental-strip-types scripts/export-memory.ts --root /data/captain --dry-run`
   in the Fly machine.
3. Pause legacy memory writes, rerun with `--overwrite`, and inspect only the
   reported paths/counts.
4. Set `CAPTAIN_MEMORY_DRIVER=filesystem`, `CAPTAIN_LEGACY_MODE=quiesced`, and
   `CAPTAIN_EVE_MODE=production`.
5. Deploy. The release command bootstraps Postgres World idempotently.
6. Run `pnpm telegram:webhook` from a trusted machine.
7. Enable and test the Pi timer after its `FLY_API_TOKEN` is installed.

## Monitor

For 48 hours, monitor Workflow failures, queue depth, schedule lateness,
database leases, memory write failures, approval requests, Telegram delivery,
and Concierge streaming. Keep the previous Fly image and
`captain_memory_documents` unchanged for at least 14 days.

## Roll back

1. Run `pnpm telegram:webhook -- --delete`.
2. Restore the previous Fly image.
3. Set `CAPTAIN_LEGACY_MODE=active` and retain
   `CAPTAIN_MEMORY_DRIVER=filesystem` so writes made after cutover are preserved.
4. Re-enable legacy polling and scheduling only after Eve is quiesced.
