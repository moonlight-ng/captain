# ADR: Duffel-primary inventory (USD/GBP)

## Status

Accepted — restored 2026-07-29 and amended 2026-07-30.

## Decision

1. **`official_duffel` is the primary inventory provider.**
2. **trip currencies are USD and GBP only.** Duffel amounts convert between those two via open.er-api.com; original Duffel amount/rate is kept on evidence titles.
3. **Any USD/GBP trip can be tracked**, including domestic routes. When a completed Duffel search returns no offers, Captain sends a one-shot `inventory_gap` notice that coverage is limited for those airlines/routes, and keeps the watch active.
4. Duffel is the primary provider in the live worker. Flysoar MCP is called
   only when direct Duffel fails or returns no offers.
5. Searches use the paginated Offers endpoint. The store retains at most 60
   deduplicated itineraries in airline rounds so one carrier's fare variants
   do not crowd out other carriers.

## Consequences

- New travellers default to USD; currency is changed on `/profile`, and only
  USD/GBP are supported for a trip.
- Planning no longer refuses same-country routes.
- Empty inventory is a post-search UX concern, not a planning gate.
- International USD trips (including multi-city watches) use Duffel with FX into trip currency when needed.
- Flysoar fallback results use the same USD/GBP conversion and are recorded
  under their own provider identifier.
