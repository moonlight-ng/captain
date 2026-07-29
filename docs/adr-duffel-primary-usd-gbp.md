# ADR: Duffel-primary inventory (USD/GBP)

## Status

Superseded by [OpenAI-primary flight inventory](adr-openai-primary-flight-inventory.md).

## Decision

1. **`official_duffel` is the primary inventory provider.**
2. **Trip currencies are USD and GBP only.** Duffel amounts convert between those two via open.er-api.com; original Duffel amount/rate is kept on evidence titles.
3. **Any USD/GBP Trip can be tracked**, including domestic routes. When a completed Duffel search returns no offers, Captain sends a one-shot `inventory_gap` notice that coverage is limited for those airlines/routes, and keeps the watch active.
4. `openai_web` remains available behind `FLIGHT_INVENTORY_PROVIDER=openai_web` for experiments, not as the default product path.

## Consequences

- Onboarding offers only USD/GBP.
- Planning no longer refuses same-country routes.
- Empty inventory is a post-search UX concern, not a planning gate.
- International USD Trips (including multi-city watches) use Duffel with FX into Trip currency when needed.
