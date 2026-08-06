# Captain

Captain is a Telegram-first flight price tracker. You describe a trip, it finds
flights, you pick one to watch, and it tells you how the price moves and when
to buy. It does not book, take payments, or collect any traveller identity.

## Product contract

- `/start` sets a default currency, ranking mode, and optional preferred or
  avoided airlines.
- A traveller can have one active or paused trip at a time. A second trip
  requires stopping or completing the existing one.
- Captain currently supports USD and GBP trips. The confirmed display
  currency stays fixed; Duffel and Flysoar USD/GBP results are normalized into it.
- **One flight is watched at a time.** Captain finds and ranks options; the
  traveller picks which one to track. The watched flight leads the dashboard,
  with its price history, its low and high, and a read on whether to buy now.
  The result tabs below — **Top picks**, **Airlines**, **All flights** — are
  the alternatives to it, and only ever show verified provider offers.
- Prices are checked once a day, and tracking runs until the day the trip
  departs. There is no cadence or duration to choose.
- `/profile` is notification and flight-ranking preferences, and nothing else.
  `/preferences`, `/settings`, `/travellers`, and `/payment` redirect to it.
  Account deletion requires a revocable HttpOnly session cookie (via a
  single-use login token).
- Captain has no booking flow, no card, and no passenger record. When a
  traveller wants to buy, it points them at whoever is selling the fare.
- Archived trips and their evidence are retained for 90 days; price history is
  kept long enough to cover a full tracking run. `/clear` resets preferences to
  defaults. Account deletion removes the traveller, trip, sessions, and
  retained evidence.

## Architecture

`apps/captain` owns Telegram onboarding, trip setup, authenticated profile and
trip APIs, and the dashboard. `apps/flight-worker` owns scheduled searches and
notifications. Both use `@agents/flight-store` and share
`@agents/provider-duffel` for Duffel access.

`summarizePriceHistory` in `@agents/flight-domain` is the single read of the
watched flight's price series. The dashboard card, the flight detail chart, and
the `get_trip` agent tool all render from it, so Captain cannot say one thing on
the web and another in Telegram.

trip setup uses a versioned turn interpreter. It keeps one ordered list of
dated legs, records the pending question and field provenance, and applies
validated draft operations instead of merging extracted fields. GPT-5.6 Luna
handles the schema-constrained semantic pass with reasoning disabled for this
latency-sensitive extraction role. Deterministic airport, calendar, and route
validation either accepts that complete interpretation or replaces it with a
complete deterministic fallback; the two results are never merged field by
field. Terra remains the general Captain agent model. This follows OpenAI's
[tier-aware model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
and [Structured Outputs guidance](https://developers.openai.com/api/docs/guides/structured-outputs).

The worker uses the provider-neutral `FlightSearchProvider` contract with
`official_duffel` as primary and `flysoar_mcp` as its automatic backup after a
primary error or empty result. The direct adapter gives suppliers up to 60
seconds to respond, then retrieves the resulting offers through Duffel's
paginated Offers endpoint until no cursor remains. Offers are deduplicated by
itinerary, ordered across primary marketing airlines, and capped at 60 retained
results per search.

Captain and Pilot are independent. Captain has no Pilot client, route,
principal, secret, tool, or redirect. Future provider adapters use the
reserved `official_*` namespace and require documented access.

## Local development

Install workspace dependencies, copy `.env.example` to the ignored `.env`, and
set Captain's database, Telegram, and Eve settings:

```sh
pnpm install
# Prefer MIGRATION_DATABASE_URL; falls back to DATABASE_URL.
pnpm --filter @agents/captain db:migrate
pnpm --filter @agents/captain dev:agent
```

After pulling schema changes (for example `012_price_tracker_only`), run
`db:migrate` again before starting the agent. Production applies pending
migrations automatically via Fly `release_command` on deploy.

`012_price_tracker_only` is destructive: it drops the passenger and payment
tables and deletes any card token still queued for deletion without sending it
to Duffel. Drain that queue before deploying it.

Build the web dashboard separately with:

```sh
pnpm --filter @agents/captain build:web
```

The flight worker has its own ignored `.env`. It requires:

- `DATABASE_URL`
- `DUFFEL_ACCESS_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `CAPTAIN_PUBLIC_URL`

Optional worker controls include `DUFFEL_BASE_URL`, `FLYSOAR_MCP_URL`,
`TRACKING_KILL_SWITCH`, and the worker scheduling controls.

Captain uses `AI_MODEL=openai/gpt-5.6-terra` for its general agent and
`TRIP_INTERPRETER_MODEL=openai/gpt-5.6-luna` for strict, low-latency trip
interpretation. Relative Telegram dates use the traveller timezone selected in
Profile.

Production now runs with `CAPTAIN_PUBLIC_BETA_ENABLED=true`, admitting new
travellers up to the capped beta limit. Set it back to `false` to close
onboarding without interrupting existing travellers.

## Public beta limits

- Maximum 25 travellers.
- One check a day per trip, until the day the trip departs.
- At most two improvement alerts in a rolling 24-hour period.
- Deferred searches keep the last verified results and show delayed tracking.

Public launch remains gated by the live evaluation corpus against Duffel. It
must demonstrate representative airline coverage and three or more usable
options in at least 80% of cases overall.

## Cloud quality loop

Captain's repository automation does not depend on live traveller
conversations:

- `Captain CI` runs deterministic domain, Telegram, store, and Captain checks
  for every relevant pull request and `main` update.
- `Deploy Captain` runs only after `Captain CI` succeeds on `main`.
- `Captain Hourly Self-Test` runs at 17 minutes past every hour and replays synthetic
  conversations through the real agent models. Every scenario gets its own
  temporary database and Captain process, and receives no production database
  or Telegram credential.
- When the daily run fails, `Captain Self-Improvement` gives Codex the failed
  logs, full synthetic event stream, and repository in a disposable GitHub
  runner. A validated code change is pushed to a dedicated branch and proposed
  as a pull request. Nothing is merged or deployed automatically.

The GitHub repository requires `CAPTAIN_AI_GATEWAY_API_KEY` for Captain's model evals,
`OPENAI_API_KEY` for the Codex repair action, and
`FLY_API_TOKEN_CAPTAIN` for the gated deployment.
