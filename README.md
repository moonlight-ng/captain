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

Apply the Concierge Supabase migrations (including
`202607021000_concierge_namespace_and_captain_state.sql` and
`202607021100_captain_telegram_messages.sql`) before starting
Captain locally.

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
- `POST /v1/events/concierge` (timestamped HMAC signature required)

Set the same `CAPTAIN_SHARED_SECRET` value in Captain on Fly and Concierge on
Vercel. Captain calls Concierge capabilities (such as `website.search`) through
the signed bridge endpoint at `POST /api/captain-bridge` (override with
`CONCIERGE_BRIDGE_URL` if needed). The request/response envelope and signature
scheme live in `src/bridge-protocol.ts`, which is kept identical to
`server/concierge/bridge-protocol.ts` in the opemipo.com repo. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
`CONCIERGE_EMAIL_FROM`, and `OWNER_EMAIL` on Captain. Concierge escalation
emails use `CONCIERGE_EMAIL_FROM`; Telegram-initiated email uses
`CAPTAIN_EMAIL_FROM` when set.

Captain stores private memory in `captain_memory_documents`, Telegram
conversation turns in `captain_telegram_messages`, and event delivery
in `captain_events`. Concierge chat data lives in `concierge_*` tables in the
same Supabase project.
