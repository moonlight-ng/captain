# ADR: Duffel-primary inventory (USD/GBP)

## Status

Accepted — restored 2026-07-29.

## Decision

1. **`official_duffel` is the primary inventory provider.**
2. **Trip currencies are USD and GBP only.** Duffel amounts convert between those two via open.er-api.com; original Duffel amount/rate is kept on evidence titles.
3. **Any USD/GBP Trip can be tracked**, including domestic routes. When a completed Duffel search returns no offers, Captain sends a one-shot `inventory_gap` notice that coverage is limited for those airlines/routes, and keeps the watch active.
4. Duffel is the only provider in the live worker.
5. Searches use the paginated Offers endpoint and retain every deduplicated
   itinerary. Airline-round ordering prevents one carrier's fare variants
   from crowding out other carriers.

## Consequences

- Onboarding offers only USD/GBP.
- Planning no longer refuses same-country routes.
- Empty inventory is a post-search UX concern, not a planning gate.
- International USD Trips (including multi-city watches) use Duffel with FX into Trip currency when needed.
