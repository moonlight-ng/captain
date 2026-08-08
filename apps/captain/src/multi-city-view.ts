import type { CanonicalFlight, FlightOfferSnapshot, TripCity, TripCityLeg } from "./domain.js";
import { dateRangeLabel } from "./format.js";

export function tripDateSpan(cities: TripCity[], legs: TripCityLeg[]): string | null {
  const dates = [
    ...cities.flatMap((city) => [
      city.arrivalWindow?.start,
      city.arrivalWindow?.end,
      city.departureWindow?.start,
      city.departureWindow?.end
    ]),
    ...legs.flatMap((leg) => [leg.departureWindow.start, leg.departureWindow.end, leg.arriveBy])
  ].filter((date): date is string => Boolean(date)).sort();
  return dates.length > 0 ? dateRangeLabel(dates[0]!, dates.at(-1)!) : null;
}

export function groupFlightsByDate(flights: CanonicalFlight[]): Array<[string, CanonicalFlight[]]> {
  const groups = new Map<string, CanonicalFlight[]>();
  for (const flight of flights) {
    groups.set(flight.departureDate, [...(groups.get(flight.departureDate) ?? []), flight]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function bestOffer(
  flightKey: string,
  offers: FlightOfferSnapshot[]
): FlightOfferSnapshot | null {
  return offers
    .filter((offer) => offer.flightKey === flightKey)
    .sort((left, right) => Number(left.priceAmount) - Number(right.priceAmount))[0] ?? null;
}

export function priceDateStatus(
  date: string,
  datesCompleted: string[],
  failedDates: Array<{ date: string }>
): "Failed" | "No fares" | "Checking" {
  if (failedDates.some((failure) => failure.date === date)) return "Failed";
  return datesCompleted.includes(date) ? "No fares" : "Checking";
}
