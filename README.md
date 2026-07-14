# Captain

Captain is Opemipo's private core agent. The first milestone is a single-owner
Telegram bot running continuously on Fly.io, using Vercel AI Gateway with
memory, events, and email stored in the shared Supabase project.

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

## 2. Test locally

Fill in the Telegram, Supabase, Vercel AI Gateway, and Resend values in `.env`.
Captain loads this file automatically.

```sh
pnpm dev
```

Only private messages from `TELEGRAM_OWNER_USER_ID` receive a response.
Captain can send email to the owner through Resend when asked in Telegram.

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

## 3. Deploy to Fly.io

Install and authenticate `flyctl`, then choose an unused app name if
`opemipo-captain` is unavailable and update `fly.toml`.

```sh
fly apps create opemipo-captain
fly secrets import < .env
fly deploy
fly scale count 1
```

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

This is a single always-on service. The Machine long-polls Telegram, receives
signed Concierge events over HTTPS, and remains active until the process exits.

The public routes are:

- `GET /health`
- `POST /v1/concierge/chat` — AI chat (Bearer auth, streaming)
- `POST /v1/concierge/conversations` — create conversation
- `GET|POST|DELETE /v1/concierge/escalate` — owner handoff
- `POST /v1/concierge/owner-join` — redeem join token
- `POST /v1/concierge/conversation-mode` — hand back to Concierge
- `POST /v1/concierge/transcribe` — voice input
- `POST /v1/events/concierge` — legacy inbound escalation events (HMAC; kept for rollback)

The browser connects to Captain at `/v1/concierge/*` (see opemipo.com `_data/concierge.yml`).
Site knowledge is fetched from `SITE_KNOWLEDGE_URL` and `NOTES_CATALOG_URL` (published
`agents.md` and `notes.json` on opemipo.com). Notes search calls
`NOTES_SEARCH_URL` (`POST /api/notes/search` on opemipo.com) with Captain HMAC signing.

Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
`CONCIERGE_EMAIL_FROM`, `OWNER_EMAIL`, `CAPTAIN_SHARED_SECRET`, and Concierge env vars
in `.env.example` on Captain. Concierge escalation emails use `CONCIERGE_EMAIL_FROM`;
Telegram-initiated email uses `CAPTAIN_EMAIL_FROM` when set.

Captain stores private memory in `captain_memory_documents`, Telegram
conversation turns in `captain_telegram_messages`, and event delivery
in `captain_events`. Concierge chat data lives in `concierge_*` tables in the
same Supabase project.

### Flight providers and comparison runs

Captain can search through LetsFG, Duffel, or both. Set the relevant credentials
in `.env` and choose the production default with `FLIGHT_SEARCH_PROVIDER`.
Searches and watches can also select a provider explicitly; a watch remains pinned
to the provider it started with.

For a one-shot Duffel-versus-LetsFG comparison, use the standalone runner with a
JSON config of one or more flights (and optional multi-leg trips). Schedule
repeated runs externally if you want a longitudinal series:

```sh
pnpm flights:compare -- --config scripts/flight-comparison.config.example.json
```

Each flight can be a single origin/destination query or a `legs[]` array that is
expanded into separate per-leg searches. Shared defaults apply to every flight/leg
unless overridden. Ad-hoc single-route CLI flags (`--origin`, `--destination`,
`--departure-date`, …) still work when `--config` is omitted.

The runner compares both providers concurrently per job, runs jobs sequentially,
and writes paired JSON/Markdown under `results/` after each job. By default it
refuses Duffel test tokens because Duffel Airways does not provide realistic
schedules or prices; `--allow-test-mode` is available only for integration checks.
Price gaps are calculated only when both providers return the same currency.

## 4. Keep a cold mirror on a Raspberry Pi

The optional [Pi sync package](deploy/pi-sync/README.md) keeps an hourly copy of
the repository, a local Supabase mirror, and Data API snapshots under
`/srv/captain/{code,data/supabase}`. It does not run Captain on the Pi. Its
persistent systemd timer runs after boot and hourly while the Pi is on.
