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
assigned to trips via `captain.trip_passengers`. Tokenised cards (Duffel card
IDs only — never PAN, CVC, or expiry) live in `captain.payment_methods` behind
`CAPTAIN_PAYMENTS_ENABLED` (enabled in production). Captain keeps at most one active card
per user, and a Duffel token backs at most one active card across all users;
retired cards are deleted remotely through a leased Postgres queue processed by
the flight worker. A deletion retries for roughly four days, then parks in a
terminal `failed` state for manual reconciliation and releases the local row so
it cannot consume the per-user cap. The worker also ages out card setup intents
on an interval, so an unused reservation cannot outlive its retention window
just because no further payment traffic arrives.

Confirmed trip currency is immutable; changing the profile default affects
only future trips.

Trip and read-only profile dashboard links still use deterministic `#access` bearer
tokens for backwards compatibility with live beta Telegram history; those
tokens may only call an explicit allowlist of trip/profile routes. New
Telegram profile links target `/profile`, where traveller details, saved
cards, preferences, and trip controls live together. All passenger/payment/account
mutations require a single-use login token in the URL **query string** (`/auth/link?t=…`).
The old `/settings`, `/preferences`, `/travellers`, and `/payment` paths remain
compatibility aliases.

The booking transition is intentionally a prototype boundary. A mock booking is
stored only in browser local storage and drives a post-booking flight activity
screen with simulated seat, baggage, and cancellation actions. It never invokes
Duffel Orders, an airline booking endpoint, or a payment charge. The default
mock card is display-only; a traveller may separately save a real tokenised card
through Duffel Components for future production booking work.
Tokens expire after 15 minutes and exchange for a hashed, revocable, HttpOnly,
SameSite=Lax session cookie lasting 30 days. The authenticated API exposes the
current profile, selected trip, passengers, and (when enabled) payment methods.

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
