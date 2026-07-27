import type { TripPlanPartial } from "@agents/flight-domain";

import { airportMarket } from "./airport-catalog.js";

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
