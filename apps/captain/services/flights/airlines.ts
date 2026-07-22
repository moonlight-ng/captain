import type { FlightOffer } from "./types.js";

export function normalizeAirlineToken(value: string): string {
  return value.trim().toUpperCase();
}

export function marketingAirlineCode(offer: FlightOffer): string {
  const segmentCode = offer.outbound.segments[0]?.airlineCode;
  if (segmentCode) return normalizeAirlineToken(segmentCode);
  if (offer.ownerAirlineCode) return normalizeAirlineToken(offer.ownerAirlineCode);
  return normalizeAirlineToken(offer.ownerAirline).replace(/[^A-Z0-9]/g, "").slice(0, 3) || "UNK";
}

export function offerMatchesAirlines(
  offer: FlightOffer,
  preferred: readonly string[],
  excluded: readonly string[]
): boolean {
  const tokens = new Set([
    offer.ownerAirline,
    offer.ownerAirlineCode,
    ...offer.airlines,
    ...offer.outbound.segments.flatMap((segment) => [segment.airline, segment.airlineCode])
  ].map(normalizeAirlineToken));
  const excludedMatch = excluded.some((airline) => tokens.has(normalizeAirlineToken(airline)));
  if (excludedMatch) return false;
  if (preferred.length === 0) return true;
  return preferred.some((airline) => tokens.has(normalizeAirlineToken(airline)));
}
