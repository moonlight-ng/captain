# Captain

Captain is a Telegram-first flight tracker for one traveller profile and up to
three active Trips. It researches fares but does not book, take payments, or collect
passport data.

## Product contract

- `/start` sets a default currency, ranking mode, and optional preferred or
  avoided airlines.
- A traveller can have up to three active or paused Trips. A fourth Trip
  requires stopping or completing one of the existing Trips.
- Domestic Trips suggest the route country's currency. Other Trips suggest the
  profile default. The confirmed Trip currency is fixed and Captain never
  converts fares.
- The dashboard has **Flights**, **Airlines**, and **Browse** views. It only
  displays offers that pass Captain's two web checks and never describes the
  set as exhaustive.
- During product design, Trip and Agent settings use direct reusable links
  containing an opaque access key. Public-beta session authentication is
  deferred until the interaction design settles.
- Archived Trips and their evidence are retained for 90 days. `/delete_account`
  removes the traveller, Trip, sessions, and retained evidence.

## Architecture

`apps/captain` owns Telegram onboarding, Trip setup, authenticated profile and
Trip APIs, and the dashboard. `apps/flight-worker` owns scheduled searches and
notifications. Both use `@agents/flight-store`.

Trip setup uses a versioned turn interpreter. It keeps one ordered list of
dated legs, records the pending question and field provenance, and applies
validated draft operations instead of merging extracted fields. GPT-5.6 Luna
handles the schema-constrained semantic pass with reasoning disabled for this
latency-sensitive extraction role. Deterministic airport, calendar, and route
validation either accepts that complete interpretation or replaces it with a
complete deterministic fallback; the two results are never merged field by
field. Terra remains the general Captain agent model. This follows OpenAI's
[tier-aware model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)
and [Structured Outputs guidance](https://developers.openai.com/api/docs/guides/structured-outputs).

The worker uses the provider-neutral `FlightSearchProvider` contract. The
initial `openai_web` adapter makes two bounded OpenAI Responses:

1. broad discovery of at most 40 candidates;
2. targeted verification retaining at most 20.

An offer is accepted only when both responses agree on its itinerary, fare,
currency, cabin, and evidence URLs. Every evidence URL must occur in the
response's actual web-search source list and match an approved airline,
metasearch, or OTA domain. Failed candidates are not stored.

Captain and Pilot are independent. Captain has no Pilot client, route,
principal, secret, tool, or redirect. The legacy Flight Agent and Duffel
runtime have been removed.

Future provider adapters use the reserved `official_*` namespace and require
documented airline or partnership access. Captain does not scrape unofficial
Skyscanner endpoints; an official adapter remains blocked on
[approved API access](https://developers.skyscanner.net/docs/getting-started/authentication).

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
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `CAPTAIN_PUBLIC_URL`

Optional worker controls include `OPENAI_FLIGHT_MODEL`,
`FLIGHT_APPROVED_DOMAINS`, `TRACKING_KILL_SWITCH`, and
`DAILY_RESPONSES_CEILING`. The default daily ceiling is 500 Responses.

Captain uses `AI_MODEL=openai/gpt-5.6-terra` for its general agent and
`TRIP_INTERPRETER_MODEL=openai/gpt-5.6-luna` for strict, low-latency Trip
interpretation. Relative Telegram dates use the traveller timezone selected in
Agent settings.

Production keeps `CAPTAIN_PUBLIC_BETA_ENABLED=false` until the live launch
gate below passes. Existing private users continue to work while new
travellers are held back. Set it to `true` only when opening the capped beta.

## Public beta limits

- Maximum 25 travellers.
- Checks every 12 hours when departure is over 30 days away, every 6 hours at
  7–30 days, and every 3 hours in the final week.
- Manual refresh once every 6 hours.
- At most two improvement alerts in a rolling 24-hour period.
- Deferred searches keep the last verified results and show delayed tracking.

Public launch remains gated by the live evaluation corpus. It must demonstrate
route/date/currency/source mismatch rejection, three or more verified options
in at least 80% of cases, at least 90% landing-page agreement in a 50-result
manual sample, and P95 two-pass latency below three minutes.
