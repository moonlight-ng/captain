import type { SearchSpecRequest } from "./search-spec.js";
import type { VerifiedOfferCandidate } from "./verified-offer.js";

/** Captain inventory providers. `official_*` is reserved for documented APIs. */
export type FlightSearchProviderId = "flysoar_mcp" | `official_${string}`;

export type FlightSearchProviderErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "offer_expired"
  | "fx_unavailable";

export class FlightSearchProviderError extends Error {
  constructor(
    readonly provider: FlightSearchProviderId,
    readonly code: FlightSearchProviderErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "FlightSearchProviderError";
  }
}

export type FlightSearchResult = {
  provider: FlightSearchProviderId;
  requestId: string;
  discoveryResponseId: string;
  verificationResponseId: string;
  model: string;
  promptVersion: string;
  offers: VerifiedOfferCandidate[];
  rejectionCounts: Partial<Record<string, number>>;
};

export interface FlightSearchProvider {
  readonly provider: FlightSearchProviderId;
  search(request: SearchSpecRequest): Promise<FlightSearchResult>;
}

export const DUFFEL_BILLING_CURRENCY_DEFAULT = "GBP";
export const PRIMARY_FLIGHT_INVENTORY_PROVIDER: FlightSearchProviderId = "official_duffel";
export const SUPPORTED_TRIP_CURRENCIES = ["USD", "GBP"] as const;
export type SupportedTripCurrency = (typeof SUPPORTED_TRIP_CURRENCIES)[number];

export function isSupportedTripCurrency(currency: string): currency is SupportedTripCurrency {
  return (SUPPORTED_TRIP_CURRENCIES as readonly string[]).includes(currency.trim().toUpperCase());
}

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
  "No fares yet for this Trip — Captain’s current inventory sources don’t cover these airlines/routes right now. Tracking stays on and will update if options appear.";

export const SUPPORTED_CURRENCY_MESSAGE =
  "Captain currently tracks fares in USD or GBP only.";
