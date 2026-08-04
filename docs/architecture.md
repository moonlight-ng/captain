# Captain 1.0 architecture

## Product and deployment boundaries

`apps/captain` and `apps/flight-worker` are independently deployable and share
Captain's PostgreSQL database and public Telegram bot token. Captain owns
onboarding, the one-active-trip flow, secure web sessions, and the dashboard.
The worker owns scheduled fare research and Telegram alerts.

Pilot is a separate private product. It has no Captain client, flight tools,
shared credentials, redirects, or access to Captain profiles and trips.

## Profile, trip, and authentication flow

Each Telegram traveller has one `TravellerProfile` (preferences) and up to three
active or paused trips. Passenger identity lives in `captain.passengers` and is
assigned to trips via `captain.trip_passengers`. Payment processing is outside
the prototype boundary: the UI always uses one display-only test-card fixture,
the service reports payments disabled, and environment configuration cannot
enable card capture. Legacy payment tables and the worker deletion queue remain
only to clean up tokenised cards created before this boundary was adopted.

Confirmed trip currency is immutable; changing the profile default affects
only future trips.

The web app is rooted at `/`, a home screen listing the traveller's trips. `/trip/:id` is the trip dashboard and
`/trip/:id/settings` holds everything scoped to that one search — tracking controls,
the trip brief, the traveller assigned to it, and its activity log. What that screen
offers is driven by the trip's stage (`src/trip-stage.ts`); once a mock booking exists
it drops tracking and the brief and shows the booking instead. `/profile` is the
account surface and is never scoped to a trip: Preferences, Travellers, and
a Test card tab. `?tab=` selects the active tab; the test card keeps the legacy
`payment` value for compatibility. Nothing inside a trip links to the profile.

Trip and read-only profile dashboard links still use deterministic `#access` bearer
tokens for backwards compatibility with live beta Telegram history; those
tokens may only call an explicit allowlist of trip/profile routes. New
Telegram profile links target `/profile`, deep-linking a tab where it helps
(`?tab=payment` from `/payment`). All passenger and account mutations require a
single-use login token in the URL **query string** (`/auth/link?t=…`). The old
`/settings`, `/preferences`, `/travellers`, and `/payment` paths remain compatibility
aliases and redirect to the profile tab each one used to mean.

The booking transition is intentionally a prototype boundary. A mock booking is
stored only in browser local storage and drives a post-booking flight activity
screen with simulated seat, baggage, and cancellation actions. It never invokes
Duffel Orders, an airline booking endpoint, or a payment charge. The default
test card is display-only and Captain never collects or charges a real card.
Tokens expire after 15 minutes and exchange for a hashed, revocable, HttpOnly,
SameSite=Lax session cookie lasting 30 days. The authenticated API exposes the
current profile, selected trip, and passengers.

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

Improvement alerts require a 5% price reduction, 10% journey-time reduction,
or 10% Balanced-score improvement, with at most two improvement alerts per
traveller in a rolling 24 hours. Each sent Telegram message ID points to an
immutable recommendation snapshot so a quoted reply explains that exact
historical comparison.

## Public beta controls

Production originally started with `CAPTAIN_PUBLIC_BETA_ENABLED=false`.
The capped public beta now runs with the gate enabled; switching it back to
`false` closes onboarding without interrupting existing travellers. Capacity
is capped at 25 travellers. The worker has a global tracking kill switch, adaptive
12/6/3-hour checks, and six-hour manual refresh limits.
