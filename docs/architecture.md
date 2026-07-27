# Captain 1.0 architecture

## Product and deployment boundaries

`apps/captain` and `apps/flight-worker` are independently deployable and share
Captain's PostgreSQL database and public Telegram bot token. Captain owns
onboarding, the one-active-Trip flow, secure web sessions, and the dashboard.
The worker owns scheduled fare research and Telegram alerts.

Pilot is a separate private product. It has no Captain client, flight tools,
shared credentials, redirects, or access to Captain profiles and Trips.

## Profile, Trip, and authentication flow

Each Telegram traveller has one `TravellerProfile` and up to three active or
paused Trips. A fourth Trip requires stopping or completing an existing Trip.
Confirmed Trip currency is immutable; changing the profile default affects
only future Trips.

Dashboard links contain a single-use login token in the URL fragment. Tokens
expire after 15 minutes and exchange for a hashed, revocable, HttpOnly,
SameSite session lasting 30 days. The authenticated API exposes only the
current profile and the traveller’s selected Trip.

## Search and verification flow

Each Trip has one canonical `SearchSpec`. Matching Watches may share fresh
results. The initial `openai_web` provider performs exactly two bounded OpenAI
Responses:

1. broad discovery of at most 40 candidates;
2. independent verification retaining at most 20 candidates.

Both Responses must use web search. A candidate is accepted only when the two
passes agree on route, dates, every segment, marketing airline and flight
number, cabin, exact one-adult fare, Trip currency, and evidence URLs. Evidence
must appear in the API's retrieved source list and use an approved airline,
metasearch, or OTA domain. Rejected candidates are reduced to aggregate reason
counts and are never stored or shown.

The provider contract reserves `official_*` identifiers for future documented
airline or partnership APIs. It does not permit unofficial scraping.

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

Production starts with `CAPTAIN_PUBLIC_BETA_ENABLED=false`. Existing private
users continue to work, but new users are admitted only after the live launch
evaluation passes and the flag is deliberately enabled. Capacity is capped at
25 travellers. The worker has a global tracking kill switch, a 500-Responses
daily ceiling, adaptive 12/6/3-hour checks, and six-hour manual refresh limits.
