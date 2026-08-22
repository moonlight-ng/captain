# Captain architecture

This document describes the runtime that exists in this repository. It is the
contract for developers and coding agents: when product copy, tests, or a new
feature disagree with it, reconcile the implementation and this document in the
same change.

## Product boundary and invariants

Captain turns conversational travel constraints into one active, editable trip,
searches real inventory, compares verified offers, and can watch a confirmed
plan for price changes. It does not book flights or collect passenger identity,
passport, card, or payment details. A provider offer is an observed, expiring
seller fare—not a booking guarantee.

The hard product limits are:

- one active trip per traveller;
- one to nine adults, with no children or infants;
- USD or GBP fare tracking;
- at most six flight legs and seven departure dates per leg;
- at most 49 Cartesian date combinations in one plan-wide provider search.

The normalized web experience exposes traveller-triggered, per-leg searches.
The compatibility tracker also remains live: it starts only after explicit plan
confirmation and can run daily until departure (bounded by the 400-day retention
ceiling). Migration 017 retired schedules that existed at migration time; it did
not remove the runtime watch APIs or prevent a newly confirmed plan from creating
a Watch.

Pilot is a separate private product. Captain's only Pilot-facing operation is
the signed, one-way `/feedback` notification carrying bounded text and basic
reporter attribution.

## Runtime components

- `apps/captain` owns Telegram, the Eve agent, HTTP API, conversational
  planning, authentication, and manual leg searches.
- `apps/web` is the React UI Captain serves (traveller trip workspace and
  private `/admin`).
- PostgreSQL is the durable source of truth in production. The memory store is a
  behaviorally compatible test/local implementation, not a second product model.
- `apps/flight-worker` leases plan-wide search runs, calls inventory providers,
  evaluates recommendations and price movement, and delivers Telegram updates.
- `packages/flight-domain` owns schemas, airport matching, search expansion, and
  provider contracts. Providers and stores must not invent competing versions of
  those rules.
- `packages/provider-duffel` is the official primary inventory adapter.
  `packages/provider-flysoar` is the worker's fallback adapter.
- `packages/flight-store` owns persistence, ranking, retention, watch scheduling,
  and notification payload facts. The language model does not calculate prices.

The Captain app uses Duffel directly for manual leg searches. The flight worker
uses Duffel first and calls Flysoar only when Duffel errors or returns no offers.
Both adapters expand date windows with the same shared exhaustive-date function.

## Planning pipeline

A planning turn is processed in the traveller's stored time zone:

1. The planner identifies airport/city mentions, route order, date expressions,
   trip type, cabin, stop limit, budget, party, and airline preferences.
2. Narrative requests such as conferences, weddings, or “need to be in London
   before Wednesday” are first represented as temporary city-presence
   constraints. They are compiled into ordered flight legs, departure windows,
   and optional `arriveBy` boundaries.
3. A model may propose structured constraints or patch operations, but airport
   codes and evidence are restricted to locations and verbatim spans in the
   current message. Invalid output, timeout, or ambiguity falls back to the
   deterministic interpreter.
4. The reducer applies the patch to a durable versioned `TripPlanDraft`. It asks
   at most two ambiguity questions. After that limit, safe date assumptions are
   composed into an editable draft rather than starting a search silently.
5. Captain reflects the entire route, every date/window, and defaults before the
   traveller confirms. Confirmation creates a `draft` Trip. A separate explicit
   Track/plan-confirm action starts the compatibility Watch and worker search.

An unqualified ordinal such as “on the 12th” resolves to the current month when
it is still upcoming, otherwise the next month. “Next week” anchors the origin
departure floor to the next Monday. Weekday deadlines resolve in local time.
An undated request for the current price/market range proposes the next seven
local calendar days and shows that assumption in the confirmation.
Same-day departure remains eligible; the returned itinerary is rejected if its
local arrival date is later than `arriveBy`.

Airport parsing uses metropolitan codes where the traveller named a city:
`NYC` → JFK/EWR/LGA, `LON` → LHR/LGW/STN/LCY/LTN, `PAR` → CDG/ORY, and
`TYO` → HND/NRT. Matching is directional: a request for `TYO` accepts HND or
NRT, while an explicit request for NRT does not silently become HND. The same
matcher is used by provider adapters, manual-search canonicalization, and reuse
of earlier snapshots. Lisbon (`LIS`) and Singapore (`SIN`) are first-class
catalog entries.

Event labels are planning evidence only. Weddings, conferences, birthdays, and
similar prose are not copied into the normalized trip graph.

## Trip graph and compatibility brief

The normalized durable model is:

`Trip → TripCity → TripLeg → TripCity → …`

- `Trip` owns the title, owner, lifecycle status, preferences, and compatibility
  `TripBrief`.
- `TripCity` is one ordered occurrence of a city. Repeated cities are separate
  nodes, so LOS → NYC → LON → NYC keeps both New York visits.
- `TripLeg` joins consecutive city occurrences and stores its feasible departure
  window, optional arrival deadline, latest manual search id, and selected
  canonical flight key.
- `CanonicalFlight` is a dated segment chain. Its identity contains no trip,
  traveller, seller, or price state.
- `FlightOfferSnapshot` is one verified seller fare for a canonical flight,
  including evidence, observation time, currency, and optional expiry.
- `LegSearchSnapshot` is a versioned manual comparison containing coverage,
  failures, retained flights/offers, and deterministic analysis.

`TripBrief` and legacy Watch/offer tables remain because the Telegram tracker,
worker, older payload fields, and historical price views still consume them.
Do not treat those tables as read-only while the Track action remains enabled.

## Trip progress journal (`trip_events`)

`captain.trip_events` is the trip-scoped **progress journal**: checkpoints that
signal movement toward finding and watching the right flights (plan confirmed,
initial overview, watching a flight, price movement, material plan change,
pause/resume, tracking finished, trip closed). The traveller feed shows
lifecycle trip events only; spoken Telegram deliveries and non-checkpoint audit
noise (`trip_created`, renames, manual refresh, freeform chat) are not shown
even if older rows exist.

**Event → optional Telegram → Feed.** Checkpoint writes enqueue a
`notifications` row where applicable; delivery records a spoken
`captain_update` (exact outbound text + `notification_id`) for chat history.
The traveller feed shows lifecycle trip events only — not the Telegram message
bodies. Immediate checkpoint acknowledgements wake the worker through the shared
PostgreSQL notification channel and are delivered **before** the worker starts
provider search work in the same tick, so the traveller gets content as soon as
a job begins rather than after the first search finishes. Conversational tool
turns keep ownership of their own Telegram reply and therefore skip the second
outbox acknowledgement. When Captain needs to go do work, it leaves a response
first so the traveller is never staring at silence while a job runs.
`messages` remains the conversation
transcript and is never mirrored wholesale into `trip_events`. Material brief
changes write `trip_plan_changed` (not every cosmetic patch). Ops kinds such as
`inventory_gap` / `watch_attention` do not become feed checkpoints.

The web Feed and Trip Settings Activity card both read `listTripActivity` and
render through `feedPostsFromActivity` (lifecycle events only). Authorship
defaults to Captain; explicit traveller checkpoint mutations (plan change,
pause/resume, cancel/complete) render as “You”. Flight select/unselect posts
read `payload.selectedBy`: traveller/person → “You”, agent → Captain.

The conversational `get_trip` tool reads the same normalized leg graph and
latest per-leg search snapshots as the web trip screen. Its compact
`legSearches` payload includes coverage, failures, selected flights, current
snapshot fares, and cheapest/fastest/balanced picks. That per-leg state is
authoritative for new trips even when the legacy whole-trip offer and
recommendation tables are empty, so Telegram answers and the web feed cannot
disagree about whether verified options have been found.

## One-active-trip replacement

A traveller may keep one active trip. A complete second request is preserved in
its own planning draft while Captain asks for replacement consent. “Keep both”
leaves the current trip unchanged and points to `/feedback`. Explicit replacement
archives the current trip with `archive_reason = 'replaced'`, then resumes the
preserved draft. Ownership checks apply to every trip, leg, search, and selection.

## Manual per-leg search

Manual search is enabled through the normalized multi-city rollout flag and is
scoped to one `TripLeg`. “Manual” distinguishes it from a recurring Watch; the
confirmed Flights screen starts a missing leg search automatically when opened,
so the traveller does not press a Search button:

1. `POST /api/me/trip/legs/:legId/searches` validates that the trip is current
   and the requested range stays inside the leg's window and contains no more
   than seven dates.
2. The API persists a running snapshot and returns HTTP 202 immediately.
3. The service issues one exact-date provider search for each date, with at most
   three requests in flight.
4. Each completion is serialized into an optimistic snapshot revision. The
   browser polls `GET /api/me/trip/legs/:legId/searches/:searchId` and can display
   progress without waiting for the full range.
5. One date failing does not discard successful dates or the previous good
   snapshot. Unexpired results from the previous snapshot may be reused only
   when date, route, currency, and airport matching still agree.

The aggregation service—not a model—calculates cheapest overall, cheapest for
each completed date, fastest, balanced, requested/completed/failed dates, option
count, observation time, and expiry. It retains the cheapest/fastest/balanced
picks and every per-date cheapest pick before applying snapshot caps.

Only `analysis.complete === true` permits “cheapest across the requested dates.”
Partial coverage must say the lowest fare found across completed dates. No-offer
dates are successful completions; provider failures are failed dates.

## Plan-wide worker search and conversational results

An explicitly tracked Trip produces one search specification. For multi-city
trips, each leg becomes a provider slice with its own departure window and
optional `arriveBy`. For a round trip, the outbound window is expanded and the
return uses the preferred stay length.

Before calling Duffel or Flysoar, the provider adapter expands all slice windows
into exact-date Cartesian combinations in stable order. It runs at most three
requests concurrently and rejects plans above 49 combinations instead of
claiming incomplete coverage as exhaustive. The whole provider batch succeeds
only after every exact request succeeds; the worker-level fallback then applies
the same exhaustive expansion if Duffel cannot serve the batch.

Returned offers are accepted only when route/metro airports, departure dates,
arrival deadlines, cabin, connection limit, currency, maximum price, excluded
airlines, and expiry constraints agree with the Trip. The worker stores slice
departure dates in each compact offer. Retention reserves the cheapest offer for
every date combination before filling the remaining 60 slots with airline-diverse
representatives.
The database compaction trigger uses the same snapshot allowlist, including
`departureDates`; migration 020 brings existing installations onto that
contract. Older rows are intentionally left untouched and are replaced by the
next verified search rather than being assigned inferred dates.

Initial Telegram results are composed from deterministic date summaries:

- a one-way window reports the range of per-date lows and the cheapest date;
- a multi-city window reports the cheapest departure-date combination and the
  number of combinations checked;
- a round trip reports its best outbound and return dates;
- an exact-date search reports the grounded fare for that date.

The raw highest offer is not presented as the useful “price range”; comparisons
use each date combination's lowest verified fare. Later notifications speak only
when the configured recommendation or watched fare changes enough to qualify.
The worker can be stopped with `TRACKING_KILL_SWITCH` without disabling pending
notification delivery or the manual leg-search API.

## Web, API, and authentication

`/trips` is the traveller home. With no active trip it tells the traveller to
send the plan by text or voice note in Telegram; the web workspace does not
create trips.
`/trip/:tripId` is the chronological city/flight composition.
`/trip/:tripId/leg/:legId` is the date comparison and flight result view.
`/flight/:flightKey` is the public canonical schedule/current-offer view; it must
never expose a private trip title, selection, or history.

An unconfirmed trip routes Flights back to its read-only Plan. Plan links to
Settings for title/itinerary edits; after confirmation, Flights auto-populates
per-leg results and permits canonical-flight drill-down and filtering.

Normal web authentication uses a short-lived, single-use login token that is
exchanged for a hashed, revocable, HttpOnly SameSite session cookie. Cookie and
legacy-bearer mutations require a same-origin `Origin` header, JSON bodies, no
CORS permission, and no state-changing GET route.

Legacy `#access` bearer links are compatibility credentials, not read-only
credentials. Their exact method/path allowlist includes session status, profile
read/update, trip read/update/actions, legacy selections, manual leg-search
start/poll, and per-leg selection. Feedback and account deletion require a full
cookie session. Any route absent from the allowlist fails closed with
`session_required`.

## Migration, rollout, and operational rules

Migration 017 materializes one-way trips as two cities/one leg, round trips as
origin/destination/origin with two legs, and multi-city routes in stored order.
It marks then-pending Watches completed and resets legacy tracking statuses to
`draft` without deleting historical offers or price observations. Later runtime
actions may create new Watches as described above.

`CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED` controls normalized graph fields and
manual-search endpoints; it defaults on outside production and must be explicitly
enabled during production rollout. `DUFFEL_ACCESS_TOKEN` is required for live
manual searches. The worker additionally requires its Duffel token, Flysoar URL,
Telegram token, and PostgreSQL connection.

Source-of-truth map for implementation work:

- planning: `apps/captain/services/trip-planning/`;
- manual comparisons: `apps/captain/services/flights/leg-search.ts`;
- HTTP/auth: `apps/captain/agent/channels/api.ts` and
  `apps/captain/services/auth/`;
- graph, watch, retention, and notifications: `packages/flight-store/src/`;
- shared schemas/search expansion: `packages/flight-domain/src/`;
- inventory adapters: `packages/provider-duffel/` and
  `packages/provider-flysoar/`;
- worker scheduling and messaging: `apps/flight-worker/src/`;
- schema history: `apps/captain/database/migrations/`.
