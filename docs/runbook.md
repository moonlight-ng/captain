# Captain runbook

This document covers deployment, health checks, backup, and recovery. See
[`architecture.md`](architecture.md) for how the system is assembled.

## Deploy

1. Apply pending Supabase migrations.
2. Confirm the `captain_eve` Workflow role is configured with
   `supabase/workflow-postgres-setup.sql` and hardened with
   `supabase/workflow-postgres-harden.sql`.
3. Run `pnpm test`, `pnpm typecheck`, `pnpm eve:info`, and `pnpm build`.
4. Deploy with `fly deploy` or push to `main` to use GitHub Actions.
5. Check `/health`, `/ready`, the Fly machine checks, and Workflow queue
   activity.

For Codex follow-ups, leave `CAPTAIN_CODEX_ENABLED=false` on the first
deployment, complete the one-time CLI login below, then enable the worker and
deploy again. Confirm
the `codex` scheduled job plus `captain_codex_jobs` queue afterwards. Duffel
searches continue to work while Codex is disabled.

`/health` reports process liveness. Fly checks `/ready`, which also validates
service initialization, the Markdown volume, and Supabase access.

The Fly release command runs the pinned Postgres World bootstrap before each
deployment. Keep `WORKFLOW_POSTGRES_URL` on a direct encrypted Supabase
connection owned by the dedicated Workflow role.

### Codex CLI authentication

The production worker uses ChatGPT-managed Codex CLI authentication stored on
the Fly volume. Deploy the image once with the worker disabled, then open an
interactive console:

```sh
fly ssh console
export CODEX_HOME=/data/codex
mkdir -p "$CODEX_HOME"
chmod 700 "$CODEX_HOME"
/app/node_modules/.bin/codex -c 'cli_auth_credentials_store="file"' login --device-auth
/app/node_modules/.bin/codex -c 'cli_auth_credentials_store="file"' login status
```

Follow the displayed URL and code in a browser where the intended ChatGPT
account is already signed in. A successful login creates
`/data/codex/auth.json`. Treat that file like a password: do not commit it,
place it under `/data/captain`, or copy it to the Pi mirror.

If device authorization is blocked from Fly's egress, seed `auth.json` from an
already authenticated, trusted workstation using `fly ssh sftp shell`, then
set its remote mode to `0600`. Never print the file or pass it through command
arguments. Confirm the result with the absolute-path `login status` command
above.

After login succeeds, change `CAPTAIN_CODEX_ENABLED` to `true` in `fly.toml`,
deploy again, and run a Telegram flight search or explicitly ask Captain for a
Codex second opinion. Duffel should answer in the original flight turn; Codex
should arrive later as a second message. Re-run `login status` over SSH when
diagnosing authentication, and repeat `login --device-auth` if the session has
been revoked.

For local development, the worker defaults to `CODEX_HOME` when set and then
to `~/.codex`, and reuses a file-backed login there. Check it with the same
`login status` command above; if needed, repeat `login --device-auth` locally
with the `cli_auth_credentials_store="file"` override. The production path
remains explicitly pinned by `CAPTAIN_CODEX_HOME=/data/codex`.

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
3. Confirm Workflow bootstrap, `/health`, and `/ready` succeed.
4. Re-register the webhook after Telegram and Concierge smoke tests pass.

Restoring an image does not roll back Markdown memory. Recover memory from the
Pi mirror or a Fly volume snapshot only when the filesystem itself is damaged.
