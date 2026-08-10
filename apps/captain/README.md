# Captain

Captain is a Telegram-first multi-city trip planner and tracked flight-search
product. You can send a trip by text or voice note. Captain extracts the ordered
cities and timing constraints, saves the itinerary for review, and starts fare
analysis only when the traveller confirms. It also answers general travel
questions using current web research. It does not book, take payments, or collect
traveller identity.

## Product contract

- Itinerary planning is an optional capability for uncertain routes or dates,
  not a required step for every trip. Captain does not use unverified fare or
  availability claims to justify a date suggestion.
- General travel questions use Eve's provider-managed web search and cite current
  sources. Web search is not used for fares, schedules, availability, saved trip
  state, off-topic requests, or as a substitute for verified flight inventory.
- `/start` sets a default currency, ranking mode, and optional preferred or
  avoided airlines.
- A traveller can have one active trip at a time. When a new request is fully
  understood, Captain asks whether to replace the current trip and archives it
  only after explicit consent. `/feedback` captures demand for simultaneous trips.
- Captain currently supports USD and GBP trips. The confirmed display
  currency stays fixed; Duffel and Flysoar USD/GBP results are normalized into it.
- A trip is an ordered list of city occurrences. Every adjacent pair is one
  independently searchable flight leg; the same city may occur more than once.
- Each leg search fans a date window of at most seven days into one exact
  provider request per date with bounded concurrency. Partial failures preserve
  successful dates and prevent exhaustive “cheapest in the range” wording.
- Search snapshots deterministically calculate cheapest, fastest, balanced,
  and cheapest-per-date results. A traveller may select one canonical Flight
  per leg; confirming the overall plan starts tracking.
- Event language such as weddings or birthdays is transient evidence for city
  arrival/departure timing. It is not stored as a product entity or shown in the UI.
- `/profile` is notification and flight-ranking preferences, and nothing else.
  `/preferences`, `/settings`, `/travellers`, and `/payment` redirect to it.
  Account deletion requires a revocable HttpOnly session cookie (via a
  single-use login token).
- Captain has no booking flow, no card, and no passenger record. When a
  traveller wants to buy, it points them at whoever is selling the fare.
- Archived trips and retained legacy evidence follow the existing retention
  policy. `/clear` removes the traveller's trips and conversation history,
  cancels the active owner-agent session, resets preferences to defaults, and
  returns onboarding to its welcome step. Account deletion removes the traveller,
  trip, sessions, and retained evidence.
- `/feedback` opens a session-authenticated text form. A signed, one-way bridge
  sends the bounded submission to Pilot's owner in Telegram without exposing
  Pilot memory or opening a private agent turn.

## Architecture

`apps/captain` owns Telegram onboarding, trip setup, authenticated profile and
trip APIs, multi-day leg search, and the dashboard. `apps/flight-worker` runs
the initial and scheduled checks for confirmed plans and sends their updates.

`TripCity` and `TripLeg` form the durable route graph. `LegSearchSnapshot`
records date coverage, failures, canonical flights, verified seller offers,
and deterministic analysis. `/flight/:flightKey` exposes the canonical flight
schedule without private trip state.

Trip setup has two semantic inputs. Explicit flight routes use the versioned
turn interpreter. Narrative itineraries first become a temporary set of
city-presence constraints; a deterministic compiler then derives exactly one
flight leg per adjacent city pair, including feasible departure and arrive-by
boundaries. Gaps longer than seven days remain feasible envelopes while Captain
proposes a bounded search window for the traveller to approve. Dates can
constrain a leg but can never create one. The temporary constraints and event
labels are discarded before the trip is saved.

GPT-5.6 Luna handles the schema-constrained semantic passes. Deterministic
airport, calendar, graph, and evidence validation accepts a complete result or
uses a complete deterministic fallback; model and fallback fields are never
merged piecemeal. Terra remains the general Captain agent model. This follows OpenAI's
[tier-aware model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
and [Structured Outputs guidance](https://developers.openai.com/api/docs/guides/structured-outputs).

Leg searches use the provider-neutral `FlightSearchProvider` contract. Each
date is independent, and successful results are committed progressively so the
web UI can show exact coverage while a request is running. A saved draft has no
Watch; confirmation atomically creates its Watch and SearchSpec and wakes the
worker.

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

### Private administrator dashboard

`/admin` is a read-only production view of Captain health, user-centric
conversations, and AI spend. Supabase supplies administrator identity only;
the browser never receives production database credentials or queries Captain
storage directly.

Before a production release:

1. Create each administrator in Supabase Auth and disable public user signup.
2. Add `https://dr-captain.fly.dev/admin` to the Supabase Auth redirect URLs
   (and `http://127.0.0.1:4178/admin` when testing locally).
3. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the comma-separated
   `CAPTAIN_ADMIN_EMAILS` as Fly secrets. The email allowlist is checked again
   by Captain after Supabase verifies every access token.

The release migration sets the usage coverage timestamp. Existing transcripts
remain browseable, but no earlier AI spend is estimated or backfilled. Direct
Gateway generations whose exact cost is not immediately available are retried
every five minutes for up to six attempts and remain visibly unresolved.

The retained legacy flight worker has its own ignored `.env`. It requires:

- `DATABASE_URL`
- `DUFFEL_ACCESS_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `CAPTAIN_PUBLIC_URL`

Optional worker controls include `DUFFEL_BASE_URL`, `FLYSOAR_MCP_URL`,
`TRACKING_KILL_SWITCH`, and the worker scheduling controls.

Captain uses `AI_MODEL=openai/gpt-5.6-terra` for its general agent and
`TRIP_INTERPRETER_MODEL=openai/gpt-5.6-luna` for strict, low-latency trip
interpretation. Voice notes use
`TRANSCRIPTION_MODEL=openai/gpt-4o-mini-transcribe`. Relative Telegram dates use
the traveller timezone selected in Profile.

Production now runs with `CAPTAIN_PUBLIC_BETA_ENABLED=true`, admitting new
travellers up to the capped beta limit. Set it back to `false` to close
onboarding without interrupting existing travellers.

`CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED` gates the graph-backed web/API
experience. It defaults on in development and off in production so migration
structure can be verified before the simplified view is enabled.

## Public beta limits

- Maximum 25 travellers.
- One active trip and one adult in USD or GBP.
- Up to seven departure dates per leg search.
- Independent city-pair searches; bundled multi-city fares are not compared.
- Automatic fare watches and material-change alerts after plan confirmation;
  no cards or booking state.

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
