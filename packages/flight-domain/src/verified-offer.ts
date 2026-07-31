import { z } from "zod";

import { airlineCodeSchema, currencyCodeSchema } from "./profile.js";

const iataCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u);
const decimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u);

export const verifiedSegmentSchema = z.object({
  origin: iataCodeSchema,
  destination: iataCodeSchema,
  departure: z.iso.datetime({ offset: true }),
  arrival: z.iso.datetime({ offset: true }),
  marketingAirlineCode: airlineCodeSchema,
  marketingAirline: z.string().trim().min(1).max(120),
  flightNumber: z.string().trim().min(2).max(16)
}).strict();
export type VerifiedSegment = z.infer<typeof verifiedSegmentSchema>;

export const verifiedSliceSchema = z.object({
  origin: iataCodeSchema,
  destination: iataCodeSchema,
  departureDate: z.iso.date(),
  segments: z.array(verifiedSegmentSchema).min(1).max(6)
}).strict();
export type VerifiedSlice = z.infer<typeof verifiedSliceSchema>;

export const fareEvidenceSchema = z.object({
  url: z.url({ protocol: /^https$/u }),
  title: z.string().trim().min(1).max(240),
  domain: z.string().trim().toLowerCase().min(3).max(253)
}).strict();
export type FareEvidence = z.infer<typeof fareEvidenceSchema>;

export const verifiedOfferCandidateSchema = z.object({
  itineraryKey: z.string().trim().min(8).max(500),
  providerOfferId: z.string().trim().min(1).max(200).optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  priceAmount: decimalAmountSchema,
  currency: currencyCodeSchema,
  fareBasis: z.literal("one_adult_total"),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]),
  slices: z.array(verifiedSliceSchema).min(1).max(6),
  primaryAirlineCode: airlineCodeSchema,
  participatingAirlineCodes: z.array(airlineCodeSchema).min(1).max(12),
  evidence: z.array(fareEvidenceSchema).min(1).max(8)
}).strict();
export type VerifiedOfferCandidate = z.infer<typeof verifiedOfferCandidateSchema>;

export const webSearchBatchSchema = z.object({
  offers: z.array(verifiedOfferCandidateSchema).max(40)
}).strict();
export type WebSearchBatch = z.infer<typeof webSearchBatchSchema>;

export function deriveOfferMetrics(slices: VerifiedSlice[]): {
  durationSeconds: number;
  stops: number;
  route: string;
  flightNumbers: string[];
  airlineCodes: string[];
  segments: Array<Record<string, string>>;
} {
  let durationSeconds = 0;
  let stops = 0;
  const flightNumbers: string[] = [];
  const airlineCodes: string[] = [];
  const segments: Array<Record<string, string>> = [];
  for (const slice of slices) {
    const first = slice.segments[0]!;
    const last = slice.segments.at(-1)!;
    const elapsed = Date.parse(last.arrival) - Date.parse(first.departure);
    if (elapsed > 0) durationSeconds += Math.round(elapsed / 1_000);
    stops += Math.max(0, slice.segments.length - 1);
    for (const segment of slice.segments) {
      flightNumbers.push(segment.flightNumber);
      airlineCodes.push(segment.marketingAirlineCode);
      segments.push({
        airlineCode: segment.marketingAirlineCode,
        airline: segment.marketingAirline,
        flightNumber: segment.flightNumber,
        origin: segment.origin,
        destination: segment.destination,
        departure: segment.departure,
        arrival: segment.arrival
      });
    }
  }
  return {
    durationSeconds,
    stops,
    route: slices.map((slice) => `${slice.origin} → ${slice.destination}`).join(" · "),
    flightNumbers,
    airlineCodes: [...new Set(airlineCodes)],
    segments
  };
}
