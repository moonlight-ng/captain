import type {
  OfferSnapshot,
  RankingMode,
  TravellerProfile,
  TripBrief
} from "@agents/flight-domain";

import type { RecommendationReasonCode } from "./contracts.js";

export type RankedOffer = { offer: OfferSnapshot; score: number };

export function rankOffers(
  brief: TripBrief,
  profile: Pick<
    TravellerProfile,
    "rankingMode" | "preferredAirlineCodes" | "excludedAirlineCodes"
  >,
  offers: OfferSnapshot[]
): RankedOffer[] {
  const eligible = offers.filter((offer) => eligibleOffer(brief, profile, offer));
  if (eligible.length === 0) return [];
  const minimumPrice = Math.min(...eligible.map((offer) => offer.price));
  const minimumDuration = Math.min(...eligible.map(durationSeconds).filter((value) => value > 0));
  const maximumStops = Math.max(1, ...eligible.map(stops));
  return eligible
    .map((offer) => ({
      offer,
      score: modeScore(profile.rankingMode, offer, {
        minimumPrice,
        minimumDuration: Number.isFinite(minimumDuration) ? minimumDuration : 1,
        maximumStops,
        preferred: profile.preferredAirlineCodes.includes(offer.primaryAirlineCode)
      })
    }))
    .sort((left, right) => compareRanked(profile.rankingMode, profile.preferredAirlineCodes, left, right));
}

/** Compatibility helper for call sites that have not loaded a profile yet. */
export function offerScore(brief: TripBrief, offer: OfferSnapshot): number {
  return rankOffers(brief, {
    rankingMode: "balanced",
    preferredAirlineCodes: brief.preferredAirlines,
    excludedAirlineCodes: brief.excludedAirlines
  }, [offer])[0]?.score ?? Number.POSITIVE_INFINITY;
}

export function recommendationReasonCodes(
  mode: RankingMode,
  current: OfferSnapshot,
  previous: OfferSnapshot | null
): RecommendationReasonCode[] {
  if (!previous) return ["initial_verified_result"];
  if (mode === "cheapest" && current.price <= previous.price * 0.95) return ["lower_price"];
  if (mode === "fastest" && durationSeconds(current) <= durationSeconds(previous) * 0.9) {
    return ["shorter_duration"];
  }
  if (mode === "balanced") return ["better_balance"];
  return [];
}

export function meetsAlertThreshold(
  mode: RankingMode,
  current: RankedOffer,
  previous: { offer: OfferSnapshot; score: number } | null
): boolean {
  if (!previous) return true;
  if (mode === "cheapest") return current.offer.price <= previous.offer.price * 0.95;
  if (mode === "fastest") return durationSeconds(current.offer) <= durationSeconds(previous.offer) * 0.9;
  return previous.score > 0 && current.score <= previous.score * 0.9;
}

export function recommendationSummary(offer: OfferSnapshot): string {
  const snapshot = offer.snapshot;
  const route = typeof snapshot.route === "string" ? snapshot.route : offer.itineraryKey;
  const airlines = offer.participatingAirlineCodes.join("/") || offer.primaryAirlineCode;
  const flights = Array.isArray(snapshot.flightNumbers)
    ? snapshot.flightNumbers.filter((value): value is string => typeof value === "string" && value.length > 0).join(", ")
    : "";
  const stopCount = stops(offer);
  const duration = durationSeconds(offer);
  const durationLabel = duration > 0
    ? ` · ${Math.floor(duration / 3_600)}h ${Math.round((duration % 3_600) / 60)}m`
    : "";
  return `${airlines}${flights ? ` ${flights}` : ""} · ${route} · ${
    stopCount === 0 ? "nonstop" : `${stopCount} stop${stopCount === 1 ? "" : "s"}`
  }${durationLabel} · ${offer.currency} ${offer.priceAmount}`;
}

function eligibleOffer(
  brief: TripBrief,
  profile: Pick<TravellerProfile, "excludedAirlineCodes">,
  offer: OfferSnapshot
): boolean {
  const expectedFareBasis = brief.travellers.adults === 1
    ? "one_adult_total"
    : "party_total";
  if (offer.currency !== brief.currency || offer.fareBasis !== expectedFareBasis) return false;
  const excluded = new Set([...brief.excludedAirlines, ...profile.excludedAirlineCodes]);
  if (offer.participatingAirlineCodes.some((code) => excluded.has(code))) return false;
  return brief.maximumPrice === null || offer.price <= brief.maximumPrice;
}

function modeScore(
  mode: RankingMode,
  offer: OfferSnapshot,
  context: {
    minimumPrice: number;
    minimumDuration: number;
    maximumStops: number;
    preferred: boolean;
  }
): number {
  if (mode === "cheapest") return offer.price;
  if (mode === "fastest") return durationSeconds(offer);
  const priceRegret = Math.min(1, Math.max(0, offer.price / Math.max(context.minimumPrice, 0.001) - 1));
  const durationRegret = Math.min(
    1,
    Math.max(0, durationSeconds(offer) / Math.max(context.minimumDuration, 1) - 1)
  );
  const stopRatio = stops(offer) / context.maximumStops;
  return Math.max(0, priceRegret * 0.5 + durationRegret * 0.35 + stopRatio * 0.15 - (context.preferred ? 0.05 : 0));
}

function compareRanked(
  mode: RankingMode,
  preferredAirlines: string[],
  left: RankedOffer,
  right: RankedOffer
): number {
  const preferred = (offer: OfferSnapshot) => preferredAirlines.includes(offer.primaryAirlineCode) ? 0 : 1;
  if (mode === "cheapest") {
    return left.offer.price - right.offer.price
      || durationSeconds(left.offer) - durationSeconds(right.offer)
      || stops(left.offer) - stops(right.offer)
      || preferred(left.offer) - preferred(right.offer)
      || left.offer.itineraryKey.localeCompare(right.offer.itineraryKey);
  }
  if (mode === "fastest") {
    return durationSeconds(left.offer) - durationSeconds(right.offer)
      || left.offer.price - right.offer.price
      || stops(left.offer) - stops(right.offer)
      || preferred(left.offer) - preferred(right.offer)
      || left.offer.itineraryKey.localeCompare(right.offer.itineraryKey);
  }
  return left.score - right.score
    || preferred(left.offer) - preferred(right.offer)
    || left.offer.price - right.offer.price
    || durationSeconds(left.offer) - durationSeconds(right.offer)
    || left.offer.itineraryKey.localeCompare(right.offer.itineraryKey);
}

function durationSeconds(offer: OfferSnapshot): number {
  return numberField(offer.snapshot, "durationSeconds");
}

function stops(offer: OfferSnapshot): number {
  return numberField(offer.snapshot, "stops");
}

function numberField(value: Record<string, unknown>, key: string): number {
  const candidate = Number(value[key]);
  return Number.isFinite(candidate) ? candidate : 0;
}
