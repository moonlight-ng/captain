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
  const tripType = legs.length > 0
    ? "multi_city" as const
    : /\bone[ -]?way\b/iu.test(lower)
    ? "one_way" as const
    : /\bround[ -]?trip\b|\breturn(?:ing)?\b|\bback\b/iu.test(lower)
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
