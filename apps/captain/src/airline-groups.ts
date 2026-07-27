import type { VerifiedOffer } from "./domain.js";

export type AirlineGroup = {
  airline: string;
  offers: VerifiedOffer[];
  cheapest: VerifiedOffer;
  fastest: VerifiedOffer;
  mixed: boolean;
  stopMix: string;
  latestVerified: string;
};

export function airlineGroups(offers: VerifiedOffer[]): AirlineGroup[] {
  const groups = new Map<string, VerifiedOffer[]>();
  for (const offer of offers) {
    groups.set(
      offer.primaryAirlineCode,
      [...(groups.get(offer.primaryAirlineCode) ?? []), offer]
    );
  }
  return [...groups.entries()].map(([airline, values]) => ({
    airline,
    offers: values,
    cheapest: [...values].sort((left, right) => left.price - right.price)[0]!,
    fastest: [...values].sort(
      (left, right) => durationSeconds(left) - durationSeconds(right)
    )[0]!,
    mixed: values.some((offer) => offer.participatingAirlineCodes.length > 1),
    stopMix: [...new Set(values.map(stopLabel))].join(", "),
    latestVerified: values.map((offer) => offer.verifiedAt).sort().at(-1)!
  })).sort((left, right) =>
    left.cheapest.price - right.cheapest.price
    || left.airline.localeCompare(right.airline)
  );
}

function durationSeconds(offer: VerifiedOffer): number {
  return Number(offer.snapshot.durationSeconds) || 0;
}

function stopLabel(offer: VerifiedOffer): string {
  const count = Number(offer.snapshot.stops) || 0;
  return count === 0 ? "Nonstop" : `${count} stop${count === 1 ? "" : "s"}`;
}
