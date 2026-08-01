# Captain

Captain is a Telegram-first flight tracker for one traveller profile and up to
three active trips. It researches and tracks fares; it does not place orders.
Traveller names and cards are collected only on Captain’s secure web pages.

## Product contract

- `/start` sets a default currency, ranking mode, and optional preferred or
  avoided airlines.
- A traveller can have up to three active or paused trips. A fourth trip
  requires stopping or completing one of the existing trips.
- Captain currently supports USD and GBP trips. The confirmed display
  currency stays fixed; Duffel and Flysoar USD/GBP results are normalized into it.
- The dashboard has **Flights**, **Airlines**, and **Browse** views. It only
  displays verified provider offers and never describes the set as exhaustive.
- `/trip` and `/preferences` still use deterministic `#access` bearer links.
  `/travellers` and `/payment` use single-use login tokens exchanged for an
  HttpOnly session cookie. Card vault routes stay behind
  `CAPTAIN_PAYMENTS_ENABLED` (default `false`) until Duffel approves cards.
- Archived trips and their evidence are retained for 90 days. `/delete_account`
  removes the traveller, trip, sessions, passengers, payment methods, and
  retained evidence.

## Architecture

`apps/captain` owns Telegram onboarding, trip setup, authenticated profile and
trip APIs, and the dashboard. `apps/flight-worker` owns scheduled searches and
notifications. Both use `@agents/flight-store`.

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
pnpm --filter @agents/captain db:migrate
pnpm --filter @agents/captain dev:agent
```

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
Agent settings.

Production now runs with `CAPTAIN_PUBLIC_BETA_ENABLED=true`, admitting new
travellers up to the capped beta limit. Set it back to `false` to close
onboarding without interrupting existing travellers.

## Public beta limits

- Maximum 25 travellers.
- Checks every 12 hours when departure is over 30 days away, every 6 hours at
  7–30 days, and every 3 hours in the final week.
- Manual refresh once every 6 hours.
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
