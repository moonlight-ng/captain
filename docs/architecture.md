# Captain 1.0 architecture

## Product and deployment boundaries

`apps/captain` and `apps/flight-worker` are independently deployable and share
Captain's PostgreSQL database and public Telegram bot token. Captain owns
onboarding, the one-active-trip flow, secure web sessions, and the dashboard.
The worker owns scheduled fare research and Telegram alerts.

Pilot is a separate private product. It has no Captain flight tools, redirects,
or access to Captain profiles and trips. Captain's only Pilot-facing operation
is a signed, one-way `/feedback` notification carrying bounded text and basic
reporter attribution to Telegram; it never enters Pilot's agent session.

## Profile, trip, and authentication flow

Each Telegram traveller has one `TravellerProfile` (preferences) and one active
or paused trip at a time (`MAX_ACTIVE_TRIPS_PER_USER`); a new trip needs the
current one stopped or completed.

Captain holds no traveller identity and no payment instrument. There is no
passenger record, no card, and no booking: migration 012 dropped the tables
that once supported a prototype purchase, and the only personal data Captain
keeps is a Telegram ID, a timezone, and preferences.

Confirmed trip currency is immutable; changing the profile default affects
only future trips.

The web app home is `/trips`, listing the traveller's trips (`/` is Eve's landing
page). `/trip/:id` is the trip dashboard and `/trip/:id/settings` holds everything
scoped to that one search — tracking controls, the trip brief, and its activity
log. What that screen offers is driven by the trip's stage (`src/trip-stage.ts`).
`/profile` is the account surface and is never scoped to a trip: notifications
and flight ranking, on one page with no tabs. Nothing inside a trip links to it.

The trip dashboard leads with the watched flight. A traveller watches one
itinerary at a time; that flight gets a card above the result tabs carrying its
price series, its low and high, and Captain's read on whether to buy. It is
deliberately absent from the picks below, which are the alternatives to it.

Trip and read-only profile dashboard links still use deterministic `#access` bearer
tokens for backwards compatibility with live beta Telegram history; those
tokens may only call an explicit allowlist of trip/profile routes. Account
deletion requires a single-use login token in the URL **query string**
(`/auth/link?t=…`). Tokens expire after 15 minutes and exchange for a hashed,
revocable, HttpOnly, SameSite=Lax session cookie lasting 30 days. The old
`/settings`, `/preferences`, `/travellers`, and `/payment` paths remain
compatibility aliases that redirect to `/profile`.

## Search flow

Each trip has one canonical `SearchSpec`. Matching Watches may share fresh
results. `official_duffel` is primary. If its request fails or returns no
offers, the worker calls Flysoar's public `soar_search_flights` MCP tool and
records successful fallback inventory as `flysoar_mcp`. The direct adapter
creates an offer request with a 60-second supplier window and retrieves all
associated offers from Duffel's cursor-paginated Offers endpoint. Offers are
deduplicated by itinerary, ordered in airline rounds, and capped at 60 retained
results so one carrier's fare variants do not crowd out the market.

Flysoar currently reports Duffel as the underlying source, so the fallback is
transport redundancy rather than independent supplier coverage. The provider
contract reserves other `official_*` identifiers for future documented airline
or partnership APIs. It does not permit unofficial scraping.

## Ranking and notifications

Eligible offers are ranked deterministically as Cheapest, Balanced, or
Fastest. Any itinerary using an excluded carrier is removed. Journey duration
is the sum of each leg's elapsed flight time, excluding destination stays.

Captain speaks only when something has changed. There is no digest and no
cadence to configure: `notification_mode` is `changes_only` or `off`. The one
exception is a trip's first search, which always sends an overview — the
route's price range, the trip's goal, and an invitation to adjust it — because
a traveller who has just described a journey needs to know what Captain
understood.

Improvement alerts require a 5% price reduction, 10% journey-time reduction,
or 10% Balanced-score improvement, with at most one improvement alert per
traveller in a rolling 24 hours. That cap is the default; a traveller can raise
it to two in Profile, which is the ceiling. It counts change alerts only: the
opening overview is never superseded by a later one. Each sent Telegram message
ID points to an immutable recommendation snapshot so a quoted reply explains
that exact historical comparison.

Every trip has a goal, derived by `formatTripGoal` from its route, departure
date, ranking mode, and any maximum fare. It is never stored or authored, so
it cannot drift from the trip. The creation receipt, the dashboard, the
`get_trip` tool, and every automatic message render from it, which is what
lets an alert say what its news means rather than just quoting a number.

`summarizePriceHistory` in `@agents/flight-domain` turns the watched flight's
observations into the current price, its range, and a verdict. The dashboard,
the `get_trip` agent tool, and anything else that speaks about timing all read
it, so the card and the conversation cannot disagree. It refuses to call a
trend from a single day and stops advising anyone to wait once departure is
close enough that waiting cannot pay off.

## Public beta controls

Production originally started with `CAPTAIN_PUBLIC_BETA_ENABLED=false`.
The capped public beta now runs with the gate enabled; switching it back to
`false` closes onboarding without interrupting existing travellers. Capacity
is capped at 25 travellers. The worker has a global tracking kill switch.

Tracking runs one search a day until the end of the departure day
(`trackingRunEndsAt`), bounded by `MAX_TRACKING_RUN_MS` for a departure that
never arrives. Fares move day to day, and a trip booked months out is exactly
the one worth watching that long — which is why the former inactivity check-in
and its auto-pause are gone.
