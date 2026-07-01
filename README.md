# Captain

Captain is Opemipo's private core agent. The first milestone is a single-owner
Telegram bot running continuously on Fly.io, using Vercel AI Gateway and
keeping private Markdown memory on an encrypted Fly Volume.

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

Fill in the Telegram, owner and Vercel AI Gateway values in `.env`. Captain
loads this file automatically. Local memory is created under the ignored
`.captain-memory/` directory.

```sh
pnpm dev
```

Only private messages from `TELEGRAM_OWNER_USER_ID` receive a response.

## 3. Deploy to Fly.io

Install and authenticate `flyctl`, then choose an unused app name if
`opemipo-captain` is unavailable and update `fly.toml`.

```sh
fly apps create opemipo-captain
fly volumes create captain_data --region lhr --size 1 --snapshot-retention 14
fly secrets import < .env
fly deploy
fly scale count 1
```

Fly stores the imported values as encrypted secrets; it does not upload the
`.env` file into the image.

This is a worker process with no public HTTP service. The Machine long-polls
Telegram and remains active until the process exits.

## Private memory

On first start, Captain creates `/data/memory/identity.md`,
`/data/memory/profile.md`, `/data/memory/core.md`, and the `journal/`
directory. Deployments do not replace existing files. Nothing under this path
is copied into or committed to Git.

Inspect the private files through Fly SSH:

```sh
fly ssh console -C "find /data/memory -maxdepth 2 -type f"
```

Fly snapshots reduce recovery risk but are not a replacement for an independent
backup.
