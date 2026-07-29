/**
 * Captain's built-in web research provider and future approved, official APIs.
 *
 * The `official_` namespace is intentionally reserved for adapters backed by
 * documented partnership or airline access. It must not be used for scrapers.
 */
export type FlightSearchProviderId = "openai_web" | `official_${string}`;

export const PRIMARY_FLIGHT_INVENTORY_PROVIDER: FlightSearchProviderId = "openai_web";

export function primaryFlightInventoryProvider(_input?: {
  tripCurrency: string;
  billingCurrency?: string;
  domesticRoute?: boolean;
}): FlightSearchProviderId {
  void _input;
  return PRIMARY_FLIGHT_INVENTORY_PROVIDER;
}

export const INVENTORY_GAP_MESSAGE =
  "No verified fares yet for this Trip. Tracking stays on and will update when options pass both web checks.";
