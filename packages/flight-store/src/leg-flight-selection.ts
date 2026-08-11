import type { CanonicalFlight, FlightOfferSnapshot } from "@agents/flight-domain";

/** Who initiated a multi-city leg flight select/unselect checkpoint. */
export type TripLegFlightSelectedBy = "agent" | "person";

/** Compact flight identity stamped into trip_events so the feed can render diffs. */
export type TripLegFlightSelectionSummary = {
  airlineCode: string;
  flightNumber: string;
  departureDate: string;
  stops: number;
  durationMinutes: number;
  priceAmount: string | null;
  currency: string | null;
};

export function tripLegFlightSelectionSummary(
  flight: CanonicalFlight,
  offers: readonly FlightOfferSnapshot[]
): TripLegFlightSelectionSummary {
  const first = flight.segments[0];
  const offer = bestOfferForFlight(flight.key, offers);
  return {
    airlineCode: flight.primaryAirlineCode,
    flightNumber: first?.flightNumber ?? flight.primaryAirlineCode,
    departureDate: flight.departureDate,
    stops: flight.stops,
    durationMinutes: flight.durationMinutes,
    priceAmount: offer?.priceAmount ?? null,
    currency: offer?.currency ?? null
  };
}

export function tripLegFlightSelectionPayload(input: {
  legId: string;
  flightKey: string | null;
  selectedBy: TripLegFlightSelectedBy;
  previousFlightKey: string | null;
  flight: TripLegFlightSelectionSummary | null;
  previousFlight: TripLegFlightSelectionSummary | null;
}): Record<string, unknown> {
  return {
    legId: input.legId,
    flightKey: input.flightKey,
    selectedBy: input.selectedBy,
    previousFlightKey: input.previousFlightKey,
    flight: input.flight,
    previousFlight: input.previousFlight
  };
}

function bestOfferForFlight(
  flightKey: string,
  offers: readonly FlightOfferSnapshot[]
): FlightOfferSnapshot | null {
  const matching = offers.filter((offer) => offer.flightKey === flightKey);
  if (matching.length === 0) return null;
  return matching.reduce((best, offer) =>
    Number(offer.priceAmount) < Number(best.priceAmount) ? offer : best
  );
}
