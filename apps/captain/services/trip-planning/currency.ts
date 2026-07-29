import type { TripPlanPartial } from "@agents/flight-domain";

import { airportMarket } from "./airport-catalog.js";

export function isDomesticRoute(
  partial: Pick<
    TripPlanPartial,
    "originAirports" | "destinationAirports" | "tripType" | "legs"
  >
): boolean {
  const routes = partial.tripType === "multi_city" && partial.legs.length > 0
    ? partial.legs
    : [{
        originAirports: partial.originAirports,
        destinationAirports: partial.destinationAirports
      }];
  if (routes.some((route) =>
    route.originAirports.length === 0 || route.destinationAirports.length === 0
  )) {
    return false;
  }
  const markets = routes.flatMap((route) =>
    [...route.originAirports, ...route.destinationAirports].map(airportMarket)
  );
  if (markets.length === 0 || markets.some((market) => !market)) return false;
  return new Set(markets.map((market) => market!.country)).size === 1;
}

export function suggestedTripCurrency(
  partial: Pick<
    TripPlanPartial,
    "originAirports" | "destinationAirports" | "tripType" | "legs"
  >,
  defaultCurrency: string
): string {
  const routes = partial.tripType === "multi_city" && partial.legs.length > 0
    ? partial.legs
    : [{
        originAirports: partial.originAirports,
        destinationAirports: partial.destinationAirports
      }];
  const markets = routes.flatMap((route) =>
    [...route.originAirports, ...route.destinationAirports].map(airportMarket)
  );
  if (markets.length === 0 || markets.some((market) => !market)) return defaultCurrency;
  const countries = new Set(markets.map((market) => market!.country));
  return countries.size === 1 ? markets[0]!.currency : defaultCurrency;
}

/** Domestic routes default to 1 stop; cross-border routes default to 2. */
export function suggestedMaxStops(
  partial: Pick<
    TripPlanPartial,
    "originAirports" | "destinationAirports" | "tripType" | "legs"
  >
): 1 | 2 {
  return isDomesticRoute(partial) ? 1 : 2;
}
