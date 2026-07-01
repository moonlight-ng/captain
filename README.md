# Captain

Captain is Opemipo's private core agent. The first milestone is a single-owner
Telegram bot running continuously on Fly.io, with Markdown memory committed to
this private repository.

## 1. Create the Telegram bot

1. Open `@BotFather` in Telegram.
2. Send `/newbot`, choose a name and username, and copy the bot token.
3. In a local shell, expose the token without committing it:

   ```sh
   export TELEGRAM_BOT_TOKEN='...'
   corepack pnpm install
   pnpm telegram:identify
   ```

4. Send `/start` to the new bot. The script prints
   `TELEGRAM_OWNER_USER_ID=...`.

## 2. Create a repository deploy key

Generate a dedicated key with no passphrase:

```sh
ssh-keygen -t ed25519 -C captain@opemipo.com -f captain_deploy_key -N ''
```

In GitHub, open this repository's **Settings → Deploy keys**, add the contents
of `captain_deploy_key.pub`, and enable write access. Encode the private key for
Fly:

```sh
base64 < captain_deploy_key | tr -d '\n'
```

Delete the local private-key files after the Fly secret is configured.

## 3. Test locally

Copy `.env.example` to `.env`, fill in the Telegram, owner and OpenAI values,
then export them into your shell. Captain does not automatically load `.env`.
Git synchronization is disabled by default locally.

```sh
set -a
. ./.env
set +a
pnpm dev
```

Only private messages from `TELEGRAM_OWNER_USER_ID` receive a response.

## 4. Deploy to Fly.io

Install and authenticate `flyctl`, then choose an unused app name if
`fathermerry-captain` is unavailable and update `fly.toml`.

```sh
fly apps create fathermerry-captain
fly volumes create captain_data --region lhr --size 1 --snapshot-retention 14
fly secrets set \
  TELEGRAM_BOT_TOKEN='...' \
  TELEGRAM_OWNER_USER_ID='...' \
  OPENAI_API_KEY='...' \
  GIT_SSH_PRIVATE_KEY_B64='...'
fly deploy
fly scale count 1
```

This is a worker process with no public HTTP service. The Machine long-polls
Telegram and remains active until the process exits.

## Memory and Git safety

Captain reads `memory/identity.md`, `memory/profile.md`, `memory/core.md`, and
the current UTC journal. It only stages and commits the `memory/` path.
Failed pushes remain committed on the Fly Volume and are retried at startup or
after the next exchange. Non-memory working-tree changes prevent startup.

Fly snapshots reduce recovery risk but are not a replacement for an independent
backup. The Git remote is the durable copy of successfully pushed memory.
