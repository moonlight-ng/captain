import type { OfferSnapshot, TripBrief } from "@agents/flight-domain";

export function offerScore(brief: TripBrief, offer: OfferSnapshot): number {
  const snapshot = offer.snapshot;
  const stops = numberField(snapshot, "stops");
  const durationSeconds = numberField(snapshot, "durationSeconds");
  const airlineCodes = Array.isArray(snapshot.airlineCodes)
    ? snapshot.airlineCodes.filter((value): value is string => typeof value === "string")
    : [];
  if (airlineCodes.some((code) => brief.excludedAirlines.includes(code))) return Number.POSITIVE_INFINITY;
  if (brief.maximumPrice !== null && offer.price > brief.maximumPrice) return Number.POSITIVE_INFINITY;
  const preferenceCredit = airlineCodes.some((code) => brief.preferredAirlines.includes(code)) ? 25 : 0;
  return offer.price + stops * 50 + (durationSeconds / 3_600) * 2 - preferenceCredit;
}

export function recommendationSummary(offer: OfferSnapshot): string {
  const snapshot = offer.snapshot;
  const route = typeof snapshot.route === "string" ? snapshot.route : offer.itineraryKey;
  const airlines = Array.isArray(snapshot.airlineCodes) ? snapshot.airlineCodes.join("/") : "airline";
  const flights = Array.isArray(snapshot.flightNumbers)
    ? snapshot.flightNumbers.filter((value): value is string => typeof value === "string" && value.length > 0).join(", ")
    : "";
  const stops = numberField(snapshot, "stops");
  const durationSeconds = numberField(snapshot, "durationSeconds");
  const duration = durationSeconds > 0 ? ` · ${Math.floor(durationSeconds / 3_600)}h ${Math.round((durationSeconds % 3_600) / 60)}m` : "";
  return `${airlines}${flights ? ` ${flights}` : ""} · ${route} · ${stops === 0 ? "nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`}${duration} · ${offer.currency} ${offer.price.toFixed(2)}`;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const candidate = Number(value[key]);
  return Number.isFinite(candidate) ? candidate : 0;
}
