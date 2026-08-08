# Captain architecture

## Product boundary

Captain plans one active multi-city trip and performs traveller-requested,
real-time flight searches. It does not book, collect passenger or payment data,
create automatic watches, schedule refreshes, or send fare alerts for new trips.
The retained flight worker and historical watch tables are legacy read-only
infrastructure; migration 017 completes their pending schedules.

Pilot remains a separate private product. Captain's only Pilot-facing operation
is the signed, one-way `/feedback` notification carrying bounded text and basic
reporter attribution.

## Trip graph

The durable model is:

`Trip → TripCity → TripLeg → TripCity → …`

- `Trip` owns title, owner, status, cabin, currency, and the compatibility brief.
- `TripCity` is one ordered occurrence of a city, with its airport set and the
  arrival/departure windows relevant to neighbouring flights.
- `TripLeg` joins consecutive cities, stores its feasible departure range,
  optional arrive-by boundary, latest search id, and selected canonical flight.
- `CanonicalFlight` is a dated segment chain whose identity contains no trip,
  traveller, seller, or price state.
- `FlightOfferSnapshot` is one verified seller fare observed for a canonical
  flight, including evidence, observation time, and expiry.
- `LegSearchSnapshot` is one manual comparison: requested/completed dates,
  failures, flights, offers, and deterministic analysis.

Event language such as weddings, birthdays, meetings, and Christmas is used by
the conversational planner only to infer city order and timing. It is not copied
into the trip graph or compatibility brief.

## Planning and replacement

The Telegram planner reflects the inferred city order and date windows before a
trip is saved. It asks one question only when a route or boundary is genuinely
ambiguous. A traveller can keep one active trip. A complete second request is
preserved while Captain asks for replacement consent; explicit consent archives
the active trip with `archive_reason = 'replaced'`, then resumes the preserved
draft. Requests for simultaneous trips point to `/feedback`.

## Manual search

A leg window is limited to seven days per search. Captain expands it to one
exact provider request per departure date and runs at most three concurrently.
Every date completion is committed through an optimistic snapshot revision, so
the browser can poll `GET /api/me/trip/legs/:legId/searches/:searchId` and show
coverage while the request runs. A failed date does not discard successful dates
or the previous good snapshot.

The aggregation service—not the model—calculates:

- cheapest verified flight across completed dates;
- cheapest flight for each completed date;
- fastest and balanced picks;
- requested, completed, and failed dates;
- verified option count, observation time, and expiry.

Only complete coverage permits “cheapest across the requested dates.” Partial
coverage must be described as the lowest fare found across the dates completed.
Unexpired results from the previous snapshot for the same leg may be reused.

## Web and API

`/trip/:tripId` is the chronological city/flight composition.
`/trip/:tripId/leg/:legId` is the date comparison and flight result view.
`/flight/:flightKey` is the public canonical schedule and current seller offers;
it never includes a private trip title, selection, or history.

The authenticated API exposes the active trip graph, starts/polls leg searches,
and selects one flight per leg. Legacy trip/offers fields remain in the payload
during rollout so older data can render read-only.

Authentication continues to use short-lived login links exchanged for hashed,
revocable HttpOnly SameSite cookies. Legacy bearer links retain their explicit
read-only allowlist.

## Migration and retention

Migration 017 materializes one-way trips as two cities/one leg, round trips as
origin/destination/origin with two legs, and existing multi-city routes in their
stored order. It retires every pending Watch and changes legacy active tracking
statuses to `draft`. Historical offers and price history remain readable under
the existing retention policy but are never scheduled again.
