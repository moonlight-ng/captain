# Captain

Captain is a Telegram-first multi-city trip planner and manual real-time flight
search product. You can send a trip by text or voice note. Captain extracts the
ordered cities and the timing constraints that determine when each flight can
leave, then searches an individual city pair when the traveller asks. It does
not book, take payments, collect traveller identity, or recheck prices in the
background.

## Product contract

- Itinerary planning is an optional capability for uncertain routes or dates,
  not a required step for every trip. Captain does not use unverified fare or
  availability claims to justify a date suggestion.
- `/start` sets a default currency, ranking mode, and optional preferred or
  avoided airlines.
- A traveller can have one active trip at a time. When a new request is fully
  understood, Captain asks whether to replace the current trip and archives it
  only after explicit consent. `/feedback` captures demand for simultaneous trips.
- Captain currently supports USD and GBP trips. The confirmed display
  currency stays fixed; Duffel and Flysoar USD/GBP results are normalized into it.
- A trip is an ordered list of city occurrences. Every adjacent pair is one
  independently searchable flight leg; the same city may occur more than once.
- A manual leg search fans a date window of at most seven days into one exact
  provider request per date with bounded concurrency. Partial failures preserve
  successful dates and prevent exhaustive “cheapest in the range” wording.
- Search snapshots deterministically calculate cheapest, fastest, balanced,
  and cheapest-per-date results. A traveller may select one canonical Flight
  per leg without starting tracking.
- Event language such as weddings or birthdays is transient evidence for city
  arrival/departure timing. It is not stored as a product entity or shown in the UI.
- `/profile` is notification and flight-ranking preferences, and nothing else.
  `/preferences`, `/settings`, `/travellers`, and `/payment` redirect to it.
  Account deletion requires a revocable HttpOnly session cookie (via a
  single-use login token).
- Captain has no booking flow, no card, and no passenger record. When a
  traveller wants to buy, it points them at whoever is selling the fare.
- Archived trips and retained legacy evidence follow the existing retention
  policy. `/clear` resets preferences to
  defaults. Account deletion removes the traveller, trip, sessions, and
  retained evidence.
- `/feedback` opens a session-authenticated text form. A signed, one-way bridge
  sends the bounded submission to Pilot's owner in Telegram without exposing
  Pilot memory or opening a private agent turn.

## Architecture

`apps/captain` owns Telegram onboarding, trip setup, authenticated profile and
trip APIs, manual multi-day search, and the dashboard. `apps/flight-worker`
retains legacy history behavior but receives no scheduled work from new trips.

`TripCity` and `TripLeg` form the durable route graph. `LegSearchSnapshot`
records date coverage, failures, canonical flights, verified seller offers,
and deterministic analysis. `/flight/:flightKey` exposes the canonical flight
schedule without private trip state.

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

Manual searches use the provider-neutral `FlightSearchProvider` contract. Each
date is independent, and successful results are committed progressively so the
web UI can show exact coverage while a request is running. New trips create no
Watch, SearchSpec schedule, notification, or worker wake-up.

Captain and Pilot remain independent flight and agent products. The only
cross-product connection is the notification-only feedback ingress described
above: it cannot read Pilot or Captain data, invoke Pilot tools, or enter a
Pilot model session. Future provider adapters use the reserved `official_*`
namespace and require documented access.

## Local development

Install workspace dependencies, copy `.env.example` to the ignored `.env`, and
set Captain's database, Telegram, and Eve settings:

```sh
pnpm install
# Prefer MIGRATION_DATABASE_URL; falls back to DATABASE_URL.
pnpm --filter @agents/captain db:migrate
pnpm --filter @agents/captain dev:agent
```

After pulling schema changes (including `017_simplified_multi_city`), run
`db:migrate` again before starting the agent. Production applies pending
migrations automatically via Fly `release_command` on deploy.

`012_price_tracker_only` is destructive: it drops the passenger and payment
tables and deletes any card token still queued for deletion without sending it
to Duffel. Drain that queue before deploying it.

Build the web dashboard separately with:

```sh
pnpm --filter @agents/captain build:web
```

The retained legacy flight worker has its own ignored `.env`. It requires:

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

`CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED` gates the graph-backed web/API
experience. It defaults on in development and off in production so migration
structure can be verified before the simplified view is enabled.

## Public beta limits

- Maximum 25 travellers.
- One active trip and one adult in USD or GBP.
- Up to seven departure dates per manual leg search.
- Independent city-pair searches; bundled multi-city fares are not compared.
- No watches, automatic alerts, scheduled refreshes, cards, or booking state.

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
