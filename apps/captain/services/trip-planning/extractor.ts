import { z } from "zod";

import {
  EMPTY_TRIP_DRAFT_STATE,
  type TripDraftState
} from "@agents/flight-domain";

import {
  airportCodeAtStart,
  airportCodeForLocation,
  allowedModelAirportCodes,
  orderedAirportCodesFromText
} from "./airport-catalog.js";

const iata = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u);
const legSchema = z.object({
  originAirports: z.array(iata).min(1).max(4),
  destinationAirports: z.array(iata).min(1).max(6)
}).strict();
const extractionSchema = z.object({
  originAirports: z.array(iata).max(4),
  destinationAirports: z.array(iata).max(6),
  tripType: z.enum(["one_way", "round_trip", "multi_city"]).nullable(),
  legs: z.array(legSchema).max(6),
  travellers: z.object({
    adults: z.number().int().min(1).max(9),
    childrenAges: z.array(z.number().int().min(2).max(17)).max(8),
    infants: z.number().int().min(0).max(4)
  }).strict().nullable(),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]).nullable(),
  maxStops: z.number().int().min(0).max(2).nullable(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u).nullable(),
  maximumPrice: z.number().positive().nullable(),
  preferredAirlines: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/u)).max(12),
  excludedAirlines: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/u)).max(12)
}).strict();

export type TripFactExtraction = z.infer<typeof extractionSchema>;

/**
 * "back", "return" and "returning" only mean a return flight in particular
 * shapes. A bare match reads "No return." and "I'll be back in Lagos for
 * Christmas" as round trips, which then collapses a four-city itinerary to its
 * first leg and appends a flight home nobody asked for.
 */
const RETURN_INTENT_PATTERN =
  /\bround[ -]?trip\b|\breturn(?:ing)?\s+(?:on|to|by|the|home|flight)\b|\bcoming\s+back\b|\bback\s+(?:on|by|to)\b|\band\s+back\b|\bthere\s+and\s+back\b|\breturn\s+leg\b/iu;
/** Wins outright: an explicit refusal is stronger evidence than any hint. */
const NO_RETURN_PATTERN =
  /\bone[ -]?way\b|\bno\s+return\b|\bnot\s+return(?:ing)?\b|\bwithout\s+a\s+return\b|\bno\s+need\s+to\s+(?:come|fly|go)\s+back\b|\bdon'?t\s+need\s+a\s+return\b/iu;

/**
 * Whether the traveller asked to come back. `false` for silence and for an
 * explicit refusal alike — a caller wanting the difference tests
 * {@link refusesReturnFlight} too.
 */
export function requestsReturnFlight(request: string): boolean {
  if (NO_RETURN_PATTERN.test(request)) return false;
  return RETURN_INTENT_PATTERN.test(request);
}

export function refusesReturnFlight(request: string): boolean {
  return NO_RETURN_PATTERN.test(request);
}

/**
 * Whether a date in this message belongs to the return leg rather than the
 * departure. Looser than {@link requestsReturnFlight} — "Return August 10"
 * names no preposition — but narrower in one way that matters: "round trip"
 * says a return exists without saying this date is it, and reading it as one
 * put the outbound date on the flight home.
 */
export function datesTheReturnLeg(request: string): boolean {
  if (NO_RETURN_PATTERN.test(request)) return false;
  return /\b(?:return|returning|back)\b/iu.test(request);
}

export function fallbackTripFactExtraction(
  request: string,
  prior: TripDraftState = EMPTY_TRIP_DRAFT_STATE
): TripFactExtraction {
  const normalized = request.trim();
  const lower = normalized.toLowerCase();
  const explicitCodes = [...normalized.matchAll(/\b[A-Z]{3}\b/gu)].map((match) => match[0]);
  const fromCode = explicitIataAfter(normalized, "from");
  const toCode = explicitIataAfter(normalized, "to");
  const fromPlace = placeAfter(normalized, "from");
  const toPlace = placeAfter(normalized, "to");
  const routeCodes = orderedKnownPlaces(normalized);
  const route = routeCodes.slice(0, 6);
  const hasOrderedRoute = (
    /\bfrom\b/iu.test(normalized)
    && [...normalized.matchAll(/\bto\b/giu)].length >= 2
  ) || /\bmulti[ -]?city\b/iu.test(normalized);
  const legs = hasOrderedRoute && route.length >= 3
    ? route.slice(0, -1).map((origin, index) => ({
        originAirports: [origin],
        destinationAirports: [route[index + 1]!]
      }))
    : [];

  let originAirports = legs.length > 0
    ? legs[0]!.originAirports
    : unique(fromCode ? [fromCode] : fromPlace ? [fromPlace] : route.length >= 2 ? [route[0]!] : []);
  let destinationAirports = legs.length > 0
    ? legs.at(-1)!.destinationAirports
    : unique(toCode ? [toCode] : toPlace ? [toPlace] : route.length >= 2 ? [route.at(-1)!] : []);
  if (originAirports.length === 0 && destinationAirports.length === 0 && explicitCodes.length >= 2) {
    originAirports = [explicitCodes[0]!];
    destinationAirports = [explicitCodes[1]!];
  }
  if (
    originAirports.length === 0
    && (prior.legs[0]?.originAirports.length ?? 0) === 0
    && !/\bto\b/iu.test(normalized)
  ) {
    const bare = locationCode(normalized.replace(/\b(?:just\s+me|only\s+me|one\s+adult|for\s+me)\b/giu, "").trim());
    if (bare) originAirports = [bare];
  }
  if (
    destinationAirports.length === 0
    && (prior.legs[0]?.destinationAirports.length ?? 0) === 0
    && !/\bfrom\s+new york\b/iu.test(lower)
    && /\bnew york\b/iu.test(lower)
  ) {
    destinationAirports = ["NYC"];
  }

  const travellers = /\b(?:just|only)\s+me\b|\bsolo\b|\bmyself\b/iu.test(lower)
    ? { adults: 1, childrenAges: [], infants: 0 }
    : travellerCount(normalized);
  // A chain of cities outranks any return hint: "London to Paris to Lagos and
  // back to work on Monday" is still a multi-city trip. Three named places
  // that do not end where they began is such a chain even when the sentence
  // never says "from" — which is how most people write an itinerary.
  const namesAChain = route.length >= 3 && route[0] !== route.at(-1);
  const tripType = legs.length > 0 || namesAChain
    ? "multi_city" as const
    : refusesReturnFlight(normalized)
      ? "one_way" as const
      : requestsReturnFlight(normalized)
        ? "round_trip" as const
        : null;
  const cabin = /\bpremium economy\b/iu.test(lower)
    ? "premium_economy" as const
    : /\bbusiness\b/iu.test(lower)
      ? "business" as const
      : /\bfirst class\b/iu.test(lower)
        ? "first" as const
        : /\beconomy\b/iu.test(lower)
          ? "economy" as const
          : null;
  // Stop constraints arrive hyphenated at least as often as spaced — “max
  // one-stop”, or “non‑stop” carrying a non-breaking hyphen from a phone
  // keyboard. Folding every dash to a space first keeps one readable pattern
  // per constraint instead of a dash class repeated in each. The class covers
  // U+2010–U+2015, U+2212, and the ASCII hyphen.
  const dashless = lower.replace(/[‐-―−-]+/gu, " ");
  const maxStops = /\bnon[ -]?stop\b|\bdirect\b/iu.test(dashless)
    ? 0
    : /\b(?:at most|maximum|max)\s+(?:one|1)\s+stops?\b/iu.test(dashless)
      ? 1
      : /\b(?:at most|maximum|max)\s+(?:two|2)\s+stops?\b/iu.test(dashless)
        ? 2
        : null;
  const currency = /\b(?:in|currency)\s+(NGN|USD|GBP|EUR|KES)\b/iu.exec(normalized)?.[1]?.toUpperCase() ?? null;
  const maximumPriceMatch = /\b(?:under|max(?:imum)?|budget)\s*(?:of\s*)?(?:NGN|USD|GBP|EUR|KES|₦|£|€|\$)?\s*([\d,]+(?:\.\d+)?)\b/iu.exec(normalized);

  return extractionSchema.parse({
    originAirports,
    destinationAirports,
    tripType,
    legs,
    travellers,
    cabin,
    maxStops,
    currency,
    maximumPrice: maximumPriceMatch ? Number(maximumPriceMatch[1]!.replaceAll(",", "")) : null,
    preferredAirlines: [],
    excludedAirlines: []
  });
}

function placeAfter(request: string, preposition: "from" | "to"): string | null {
  const tail = new RegExp(String.raw`\b${preposition}\s+(.+)$`, "iu").exec(request)?.[1] ?? "";
  return airportCodeAtStart(tail);
}

function explicitIataAfter(request: string, preposition: "from" | "to"): string | null {
  const candidate = new RegExp(String.raw`\b${preposition}\s+([A-Za-z]{3})\b`, "u").exec(request)?.[1];
  return candidate && candidate === candidate.toUpperCase() ? candidate : null;
}

function locationCode(value: string): string | null {
  return airportCodeForLocation(value);
}

function travellerCount(request: string): TripFactExtraction["travellers"] {
  const match = /\b(\d)\s+(?:adult|person|people|traveller|traveler|passenger)s?\b/iu.exec(request)
    ?? /\b(one|two|three|four|five|six|seven|eight|nine)\s+(?:adult|person|people|traveller|traveler|passenger)s?\b/iu.exec(request);
  if (!match) return null;
  const words: Readonly<Record<string, number>> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9
  };
  const adults = Number(match[1]) || words[match[1]!.toLowerCase()]!;
  return { adults, childrenAges: [], infants: 0 };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function orderedKnownPlaces(request: string): string[] {
  return orderedAirportCodesFromText(request);
}

export function sanitizeModelAirportExtraction(
  request: string,
  extraction: TripFactExtraction
): TripFactExtraction {
  const allowed = allowedModelAirportCodes(request);
  const safeCodes = (codes: string[]): string[] =>
    unique(codes.filter((code) => allowed.has(code)));
  return extractionSchema.parse({
    ...extraction,
    originAirports: safeCodes(extraction.originAirports),
    destinationAirports: safeCodes(extraction.destinationAirports),
    legs: extraction.legs.map((leg) => ({
      originAirports: safeCodes(leg.originAirports),
      destinationAirports: safeCodes(leg.destinationAirports)
    })).filter((leg) => leg.originAirports.length > 0 && leg.destinationAirports.length > 0)
  });
}
