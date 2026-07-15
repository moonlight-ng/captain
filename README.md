# Captain

Captain is Opemipo's private core agent. Production is one Eve application on
Fly.io: Eve owns durable sessions, Telegram webhooks, Concierge HTTP ingress,
approvals, schedules, tools, and subagents. Supabase stores Workflow and
operational state. Private memory is Markdown on an encrypted Fly volume and is
cold-mirrored to a Raspberry Pi.

## Repository layout

- `agent/` — Eve agents, channels, schedules, instructions, and tool adapters.
- `services/app/` — environment loading and the application service container.
- `services/concierge/`, `services/flights/`, and `services/trading/` — product domains and actions.
- `services/memory/`, `services/scheduling/`, and `services/storage/` — shared infrastructure.
- `services/biodata/`, `services/curiosity/`, `services/review/`, and `services/skills/` — background work.
- `services/email/`, `services/telegram/`, and `services/solana/` — external platform integrations.
- `deploy/` — Raspberry Pi mirror package.
- `docs/` — architecture explanation and production runbook.
- `evals/`, `tests/`, and `scripts/` — evaluation, verification, and operations.
- `supabase/` — domain migrations and Workflow role bootstrap SQL.

Start with [`docs/architecture.md`](docs/architecture.md) for the current system
shape. Deployment, backup, and recovery procedures live in
[`docs/runbook.md`](docs/runbook.md).

## 1. Create the Telegram bot

1. Open `@BotFather` in Telegram.
2. Send `/newbot`, choose a name and username, and copy the bot token.
3. Copy the environment template and put the token in the ignored `.env` file:

   ```sh
   cp .env.example .env
   corepack pnpm install
   pnpm telegram:identify
   ```

4. Send `/start` to the new bot. The script prints
   `TELEGRAM_OWNER_USER_ID=...`; add that value to `.env`.

## 2. Run locally

Fill in the Telegram, Supabase, Vercel AI Gateway, and Resend values in `.env`.
Captain's scripts load this file automatically. Eve itself reads environment
variables, so export the file before starting a local Eve process:

```sh
set -a; . ./.env; set +a
pnpm dev
```

Local Markdown defaults to `.memory/`. Only private messages from
`TELEGRAM_OWNER_USER_ID` are accepted. Owner-requested email and trading
enablement changes use Eve's approval flow.

This repo owns the shared Supabase schema (Concierge `concierge_*` tables and
Captain `captain_*` tables). Link the project once, then apply migrations before
starting Captain locally:

```sh
supabase link
supabase db push
```

If an older notes-search schema was already applied, run
`supabase/reset_concierge_clean.sql` in the Supabase SQL editor instead. It
deletes existing Concierge data and recreates the schema without notes or
vector-search tables.

## 3. Deploy Eve to Fly.io

Install and authenticate `flyctl`, then choose an unused app name if
`opemipo-captain` is unavailable and update `fly.toml`.

```sh
fly apps create opemipo-captain
fly volumes create captain_data --region lhr --size 1
fly secrets import < .env
fly deploy
fly scale count 1
```

Set `WORKFLOW_POSTGRES_URL` to a direct Supabase Postgres connection owned by a
dedicated `captain_eve` login. Run `supabase/workflow-postgres-setup.sql` after
creating that role. The Fly release command runs the pinned, idempotent Postgres
World bootstrap before each deployment. Supabase direct URLs should use
`uselibpqcompat=true&sslmode=require`.
After the first successful bootstrap, run
`supabase/workflow-postgres-harden.sql` to revoke temporary `public` schema
and database creation privileges from the Workflow role.

Pushes to `main` deploy automatically through GitHub Actions
(`.github/workflows/fly-deploy.yml`). One-time setup for the repo:

```sh
fly tokens create deploy -a opemipo-captain
```

Add the printed token as the `FLY_API_TOKEN` repository secret in GitHub.
Secrets and env vars already on Fly are reused; CI only builds and deploys
the image.

Fly stores the imported values as encrypted secrets; it does not upload the
`.env` file into the image.

After health and Concierge checks pass, register the webhook from a trusted
machine with the production environment loaded:

```sh
pnpm telegram:webhook
```

Operational deployment, recovery, and backup procedures live in
[`docs/runbook.md`](docs/runbook.md).

The public routes are:

- `GET /health`
- `POST /v1/concierge/chat` — AI chat (Bearer auth, streaming)
- `POST /v1/concierge/conversations` — create conversation
- `GET|POST|DELETE /v1/concierge/escalate` — owner handoff
- `POST /v1/concierge/owner-join` — redeem join token
- `POST /v1/concierge/conversation-mode` — hand back to Concierge
- `POST /v1/concierge/transcribe` — voice input
- `GET /v1/apps` — list flight-selection apps, or read one with `?key=...`
- `POST /v1/apps/actions` — apply a versioned pass, save, select, or undo decision
- `GET /apps` — protected goal app index rendered by Captain
- `GET /apps/:appKey` — protected flight-selection card app
- `POST /v1/events/concierge` — signed inbound escalation events
- `POST /eve/v1/telegram` — Telegram webhook (secret + owner/private-chat checks)
- `/eve/*` — dedicated Basic-credential protected Eve session and inspection routes
- `/.well-known/workflow/*` — Workflow callbacks and hooks

The browser connects to Captain at `/v1/concierge/*` (see opemipo.com `_data/concierge.yml`).
Site knowledge is fetched from `SITE_KNOWLEDGE_URL` and `NOTES_CATALOG_URL` (published
`agents.md` and `notes.json` on opemipo.com). Notes search calls
`NOTES_SEARCH_URL` (`POST /api/notes/search` on opemipo.com) with Captain HMAC signing.

Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
`CONCIERGE_EMAIL_FROM`, `OWNER_EMAIL`, the three scoped Captain secrets, and Concierge env vars
in `.env.example` on Captain. Concierge escalation emails use `CONCIERGE_EMAIL_FROM`;
Telegram-initiated email uses `CAPTAIN_EMAIL_FROM` when set.

Use independent values for `CAPTAIN_EVE_BASIC_PASSWORD`,
`CAPTAIN_CONCIERGE_EVENT_SECRET`, and `CAPTAIN_NOTES_SEARCH_SECRET`. Rotating one
integration must not grant or invalidate credentials for the others.
For deployment continuity, the Eve/app password falls back to the legacy
`CAPTAIN_SHARED_SECRET` until the scoped password is configured.

Captain stores memory under `/data/captain/memory/*.md` and journals under
`/data/captain/journals/YYYY/YYYY-MM-DD.md`. Telegram mirrors, scheduled jobs,
job runs, flights, trades, event delivery, Workflow state, and Concierge data
remain in Supabase.

### Flight discovery

Captain uses Duffel for the immediate, bookable response. Configure a live-mode
`DUFFEL_ACCESS_TOKEN`; interactive searches and fare watches remain pinned to
Duffel.

When the owner asks Captain to plan or select flights, Captain creates a
durable flight-selection goal, runs the initial Duffel search, and returns one
stable app link under Captain's own `CAPTAIN_EVE_PUBLIC_URL`, at
`/apps/:appKey`. The opaque app key identifies the goal but
does not authorize access. The internal browser and its API calls use the same
`CAPTAIN_EVE_BASIC_PASSWORD` owner credential as Captain's Eve interface.
Programmatic API clients may instead use a valid Supabase bearer session.
When `CAPTAIN_APP_LINKS_PUBLIC=true`, individual opaque app links and their
card actions are passwordless; the `/apps` index remains owner-only.
Configure the immutable Supabase user ID in
`CAPTAIN_APP_OWNER_USER_ID`; until configured, access falls back to a
session whose email matches `OWNER_EMAIL`.

The selection app supports ordered multi-city routes. Pass, save,
select, and undo are explicit optimistic-concurrency actions recorded in an
append-only history. The browser renders agent-curated journeys as a swipeable
card deck, but every swipe maps to one of those explicit actions. Back/forward
navigation and history inspection are read-only. Selecting performs another
live Duffel search and only completes the goal when the itinerary and price
still match. Selection does not create a booking intent or purchase a ticket.

See [the flight app contract](docs/flight-apps.md) for the browser
view model and action protocol.

Codex is exposed to Eve as the owner-only `research_web` provider. Eve supplies
a closed JSON request containing a topic, objective, explicit questions,
freshness, preferred domains, and result limit. Codex uses live web search and
returns validated provider-style JSON containing ranked findings, direct source
URLs, evidence strength, gaps, and search metadata. Eve receives that object in
the active turn and decides how to present it, just as it does with Duffel data.
There is no free-form `ask_codex` tool, `/codex` shortcut, autonomous queue, or
direct Codex-to-Telegram delivery.

The Codex provider runs read-only in an empty temporary directory with shell,
apps, subagents, hooks, goals, and memory disabled. It receives no Captain
service secrets or traveller identities and cannot execute bookings or other
side effects.
The CLI reuses ChatGPT-managed authentication from `CAPTAIN_CODEX_HOME`; no
Codex API key is required. The runtime image supplies the system CA bundle to
the otherwise isolated CLI environment so ChatGPT HTTPS and WebSocket
connections can be verified without forwarding Captain's service environment.
Production keeps the reusable login at `/data/codex`, outside the
`/data/captain` tree mirrored to the Pi. The feature defaults off so the tool is
unavailable before the one-time CLI login is complete. See the
[runbook](docs/runbook.md#codex-cli-authentication), then set
`CAPTAIN_CODEX_ENABLED=true`.

## 4. Keep a cold mirror on a Raspberry Pi

The optional [Pi sync package](deploy/pi-sync/README.md) keeps an hourly copy of
the repository, a local Supabase mirror, API snapshots, and an atomic one-way
copy of the Fly memory volume. It does not run Captain or write to production.
