# Captain archive runbook

This revision defines Captain's reversible archived state as of 2026-08-28.
It becomes the operational source of truth after the approved production
deploy. It does not cover the separate public website project.

## Archive contract

After both Fly apps are deployed from this revision:

- Telegram text, voice notes, commands, and old trip buttons receive one short
  closure response. They do not create a traveller, write a message, start an
  Eve turn, call a model, or change a trip.
- Traveller web routes render a no-cache closure page. Authenticated read APIs
  remain available for controlled recovery and data inspection, while every
  traveller mutation returns HTTP `410` with `captain_archived`.
- The unauthenticated canonical-flight API also returns `410`, so a retained
  offer cannot be mistaken for a current fare.
- `/health`, `/ready`, the private `/admin` UI, and its read-only APIs remain
  available. Their status identifies the app as archived.
- The flight worker reports ready/archived but does not start its timer, listen
  for database wakeups, prune data, maintain watches, schedule or claim search
  runs, call Duffel/Flysoar, or deliver queued Telegram notifications.
- Existing trips, conversations, workflow records, watches, search runs,
  notifications, observations, admin records, and logs stay in place. Their
  active/scheduled status is retained evidence, not evidence that an archived
  worker is executing them.

`CAPTAIN_ARCHIVED_MODE=true` is the reversible application switch. Production
also closes the public beta and daily conversation review. The worker carries
both `CAPTAIN_ARCHIVED_MODE=true` and `TRACKING_KILL_SWITCH=true` as independent
guards. Its manual provider scripts also refuse to run unless an operator sets
the conspicuous one-command `CAPTAIN_ARCHIVE_OVERRIDE=true` escape hatch.

## Production inventory audited on 2026-08-28

### Runtime and public entry points

- Fly app `dr-captain`, region `lhr`, public host
  `https://dr-captain.fly.dev`, was running one healthy machine (version 155).
  Fly runs `node scripts/release.mjs` before each release.
- Fly app `dr-flight-worker`, region `lhr`, public host
  `https://dr-flight-worker.fly.dev`, was running one healthy machine (version
  78). Its live configuration had `TRACKING_KILL_SWITCH=false` before this
  archive change.
- Captain exposes the Telegram webhook at `/eve/v1/telegram`; traveller pages
  at `/` and under `/trips`, `/trip`, `/flight`, `/profile`, and `/feedback`; authenticated
  `/api/me/*` routes; the public `/api/flights/:flightKey`; private `/admin` and
  `/api/admin/*`; and `/health` plus `/ready`.
- The worker exposes only `/health` and `/ready` over HTTP. PostgreSQL
  notifications normally wake the same scheduler between polling ticks.
- Neither Fly app has a persistent Fly volume.

### Durable data

- PostgreSQL is the source of truth for Captain. `DATABASE_URL` is shared by
  Captain and the worker. The `captain.project_meta` sentinel protects the
  product schema.
- Migrations use the separate `MIGRATION_DATABASE_URL` role.
- Eve/Workflow uses `WORKFLOW_POSTGRES_URL`, the `captain_eve` job prefix, and
  the `captain_worker` Graphile Worker schema. Its login is deliberately
  isolated from the Captain runtime role.
- Supabase provides private administrator identity. The application database
  remains server-side and is not stored in Supabase by this repository.
- No SQL migration is part of archiving. No table, row, schema, database,
  account, app, machine, secret, or log is deleted.

The live `/ready` endpoint confirmed PostgreSQL-backed storage during the
audit. A count-only query from a one-off Fly SSH process did not establish a
database connection within the audit window, so no row counts or traveller
content were retrieved. Capture counts and a verified backup from the database
provider console before considering any destructive action.

The hostname/provider behind the PostgreSQL URLs cannot be derived without
revealing secret values. Confirm its vendor, backup policy, billing owner, and
retention window in the password manager/provider console before any later
database action.

### External services and credentials

Only names and purpose are inventoried here; values must never be copied into
Git, tickets, logs, or shutdown notes.

`dr-captain` had these deployed Fly secret names:

- `AI_GATEWAY_API_KEY`
- `DATABASE_URL`
- `MIGRATION_DATABASE_URL`
- `WORKFLOW_POSTGRES_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET_TOKEN`
- `DUFFEL_ACCESS_TOKEN`
- `FEEDBACK_BRIDGE_URL`
- `FEEDBACK_BRIDGE_SECRET`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `CAPTAIN_ADMIN_EMAILS`
- `CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED`
- retained legacy `CAPTAIN_PII_ENCRYPTION_KEY`

`dr-flight-worker` had these deployed Fly secret names:

- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `DUFFEL_ACCESS_TOKEN`
- `AI_GATEWAY_API_KEY`
- retained `OPENAI_API_KEY`

GitHub Actions had `CAPTAIN_AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`,
`FLY_API_TOKEN_CAPTAIN`, and `FLY_API_TOKEN_FLIGHT_WORKER`.

The integrations are Telegram Bot API, Duffel inventory, the public Flysoar
MCP fallback, AI Gateway/model providers, Supabase Auth, and Captain's signed
one-way Pilot feedback/review bridge. Direct Resend review delivery is supported
by code but no `RESEND_API_KEY` Fly secret was present in the audit.

## Recurring work inventory

- The flight worker normally polls every 60 seconds, backs off to five minutes,
  and also wakes from PostgreSQL notifications. Archive mode prevents the
  scheduler and wake listener from starting at all.
- `onboarding-followups` normally runs every five minutes. It returns before
  claiming or sending work in archive mode.
- `reconcile-usage` normally runs every five minutes. It returns before
  reconciliation in archive mode.
- `conversation-daily-review` normally runs at 06:15 UTC (07:15 Lagos). It is
  disabled in Fly configuration and also returns early in archive mode.
- Fare digests and price watches are durable database schedules consumed by the
  flight worker. Their rows are preserved, but no archived worker schedules or
  claims them.
- GitHub's hourly synthetic self-test is now manual-only. The self-improvement
  repair workflow retains its implementation but has no automatic trigger and
  its job is hard-disabled. Both workflows were also already marked
  `disabled_manually` in GitHub when audited.
- CI and the two gated deployment workflows remain active so this archive can
  be tested and shipped normally.

## Deployment and verification

No production mutation has been performed by preparing this change. After an
approved commit, deploy the worker first so searches and notification delivery
stop before the public Captain change lands. Then deploy Captain. The Captain
deployment workflow enforces this order by waiting until the worker reports
ready, archived, and tracking-disabled.

Verify:

1. `dr-flight-worker` `/ready` returns `mode: "archived"` and
   `trackingEnabled: false`.
2. `dr-captain` `/ready` returns `mode: "archived"`.
3. A Telegram text and an old inline trip button both receive the closure copy;
   no new conversation, message, trip, or model-usage row appears.
4. `/trips` renders the closure page, a traveller mutation returns `410`, and
   `/api/flights/:flightKey` returns `410`.
5. `/admin` still authenticates and historical conversations, trips,
   automations, and costs remain readable.
6. No new provider search, search-run claim, onboarding follow-up, daily review,
   usage reconciliation, or Telegram notification delivery appears after the
   deploy timestamp.
7. Fly stops the idle worker machine under `auto_stop_machines="stop"` and
   `min_machines_running=0`. A later health request may auto-start the archived
   machine, but it still performs no work.

## External actions that require owner approval

Do not perform any item below as part of a routine archive deploy:

- Scaling either Fly app to zero is reversible and does not delete PostgreSQL
  data, but scaling Captain to zero also removes the Telegram closure response.
  Recovery is a scale-up followed by health checks.
- Removing the Telegram webhook stops all replies. Revoking the bot token also
  breaks recovery until BotFather issues a replacement and the webhook is
  configured again.
- Removing Fly secrets preserves database rows but loses the deployed
  applications' ability to reconnect. Recovery requires the original values or
  newly issued credentials.
- Revoking Duffel, AI Gateway/OpenAI, Supabase, Pilot bridge, or Fly deployment
  credentials reduces future exposure but requires provider-side reissue and
  reconfiguration for a restore.
- Deleting either Fly app removes its machines, release history, and app-level
  configuration. It does not by itself delete the external PostgreSQL database,
  but recovery requires recreating the app and every secret/config value.
- Deleting the PostgreSQL database or its Captain/Workflow schemas removes
  trips, conversations, logs, watch/search history, queued notifications, auth
  sessions, and admin evidence. Recovery is possible only from a verified
  provider backup and should never be attempted without an exact backup and
  restore drill.
- Deleting Supabase users/projects removes administrator sign-in; deleting the
  Telegram bot removes the public identity. Both require separate provider
  recovery plans.

## Restore procedure

Before restoring, inspect retained search runs and notification rows. Simply
restarting the worker can process old searches or deliver queued messages.
Decide explicitly whether to expire, retain, or replay each queue; that decision
may require a data migration and is not part of this archive.

Then revert the archive configuration and code guards, choose whether to reopen
the beta and daily review, restore the worker's machine policy, re-enable the
GitHub schedules, and deploy the worker before Captain. Verify the live provider
corpus and Telegram in a controlled account before admitting travellers.
