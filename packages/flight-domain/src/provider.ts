/**
 * Captain inventory providers.
 *
 * `official_*` is reserved for documented partnership/airline APIs (not scrapers).
 * Duffel (`official_duffel`) is primary. Trip currencies are limited to USD and GBP;
 * Duffel amounts convert between those two. Empty inventory is handled after search
 * (routes/airlines Duffel does not cover), not by refusing routes at planning time.
 */
export type FlightSearchProviderId = "openai_web" | `official_${string}`;

export const DUFFEL_BILLING_CURRENCY_DEFAULT = "GBP";
export const PRIMARY_FLIGHT_INVENTORY_PROVIDER: FlightSearchProviderId = "official_duffel";
export const SUPPORTED_TRIP_CURRENCIES = ["USD", "GBP"] as const;
export type SupportedTripCurrency = (typeof SUPPORTED_TRIP_CURRENCIES)[number];

export function isSupportedTripCurrency(currency: string): currency is SupportedTripCurrency {
  return (SUPPORTED_TRIP_CURRENCIES as readonly string[]).includes(currency.trim().toUpperCase());
}

/**
 * Duffel inventory accepts any Trip in USD or GBP. Coverage gaps (including some
 * domestic markets) surface as empty search results, not planning refusals.
 */
export function duffelInventoryEligible(input: {
  tripCurrency: string;
  billingCurrency?: string;
  domesticRoute?: boolean;
}): boolean {
  void input.billingCurrency;
  void input.domesticRoute;
  return isSupportedTripCurrency(input.tripCurrency);
}

export function primaryFlightInventoryProvider(_input?: {
  tripCurrency: string;
  billingCurrency?: string;
  domesticRoute?: boolean;
}): FlightSearchProviderId {
  void _input;
  return PRIMARY_FLIGHT_INVENTORY_PROVIDER;
}

export const INVENTORY_GAP_MESSAGE =
  "No fares yet for this Trip — Captain’s inventory doesn’t cover these airlines/routes right now. Tracking stays on and will update if options appear.";

export const SUPPORTED_CURRENCY_MESSAGE =
  "Captain currently tracks fares in USD or GBP only. Duffel quotes are converted between those two when needed.";
