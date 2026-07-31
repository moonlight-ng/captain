import type { TripDraftState } from "@agents/flight-domain";
import { isSupportedTripCurrency } from "@agents/flight-domain";

import { airportMarket } from "./airport-catalog.js";

export function isDomesticRoute(
  state: Pick<TripDraftState, "tripType" | "legs">
): boolean {
  const routes = state.legs;
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
  state: Pick<TripDraftState, "tripType" | "legs">,
  defaultCurrency: string
): string {
  if (isSupportedTripCurrency(defaultCurrency)) return defaultCurrency.toUpperCase();
  const routeCurrencies = [
    ...state.legs.toReversed().flatMap((leg) =>
      leg.destinationAirports.map((airport) => airportMarket(airport)?.currency)
    ),
    ...state.legs.flatMap((leg) =>
      leg.originAirports.map((airport) => airportMarket(airport)?.currency)
    )
  ];
  return routeCurrencies.find((currency): currency is string =>
    Boolean(currency && isSupportedTripCurrency(currency))
  ) ?? "USD";
}

/** Domestic routes default to 1 stop; cross-border routes default to 2. */
export function suggestedMaxStops(
  state: Pick<TripDraftState, "tripType" | "legs">
): 1 | 2 {
  return isDomesticRoute(state) ? 1 : 2;
}
