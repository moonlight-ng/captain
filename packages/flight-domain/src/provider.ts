/**
 * Captain's built-in web research provider and future approved, official APIs.
 *
 * The `official_` namespace is intentionally reserved for adapters backed by
 * documented partnership or airline access. It must not be used for scrapers.
 */
export type FlightSearchProviderId = "openai_web" | `official_${string}`;
