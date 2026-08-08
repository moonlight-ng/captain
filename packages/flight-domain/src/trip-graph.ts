import { z } from "zod";

import { fareEvidenceSchema, verifiedSegmentSchema } from "./verified-offer.js";

const iataCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u);
const isoDateSchema = z.iso.date();
const dateWindowSchema = z.object({
  start: isoDateSchema,
  end: isoDateSchema
}).strict().superRefine((window, context) => {
  if (window.end < window.start) {
    context.addIssue({
      code: "custom",
      path: ["end"],
      message: "Date window end must not precede its start"
    });
  }
});

/** One occurrence of a city in a trip's ordered route. */
export const tripCitySchema = z.object({
  id: z.uuid(),
  tripId: z.uuid(),
  position: z.number().int().min(0).max(6),
  label: z.string().trim().min(1).max(120),
  airportCodes: z.array(iataCodeSchema).min(1).max(6),
  arrivalWindow: dateWindowSchema.nullable(),
  departureWindow: dateWindowSchema.nullable()
}).strict();
export type TripCity = z.infer<typeof tripCitySchema>;

/** The searchable flight edge between two adjacent TripCity records. */
export const tripCityLegSchema = z.object({
  id: z.uuid(),
  tripId: z.uuid(),
  position: z.number().int().min(0).max(5),
  originCityId: z.uuid(),
  destinationCityId: z.uuid(),
  departureWindow: dateWindowSchema,
  arriveBy: isoDateSchema.nullable(),
  selectedFlightKey: z.string().trim().min(8).max(500).nullable(),
  latestSearchId: z.uuid().nullable()
}).strict();
export type TripCityLeg = z.infer<typeof tripCityLegSchema>;

/** A dated segment chain. Prices and private trip state are deliberately absent. */
export const canonicalFlightSchema = z.object({
  key: z.string().trim().min(8).max(500),
  origin: iataCodeSchema,
  destination: iataCodeSchema,
  departureDate: isoDateSchema,
  segments: z.array(verifiedSegmentSchema).min(1).max(6),
  primaryAirlineCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/u),
  participatingAirlineCodes: z.array(
    z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/u)
  ).min(1).max(12),
  stops: z.number().int().min(0),
  durationMinutes: z.number().int().min(1)
}).strict();
export type CanonicalFlight = z.infer<typeof canonicalFlightSchema>;

export const flightOfferSnapshotSchema = z.object({
  offerId: z.string().trim().min(1).max(200),
  flightKey: z.string().trim().min(8).max(500),
  provider: z.union([z.literal("flysoar_mcp"), z.string().regex(/^official_[a-z0-9_]+$/u)]),
  priceAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u),
  evidence: z.array(fareEvidenceSchema).min(1).max(8),
  observedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable()
}).strict();
export type FlightOfferSnapshot = z.infer<typeof flightOfferSnapshotSchema>;

export const legSearchPickSchema = z.object({
  flightKey: z.string().trim().min(8).max(500),
  departureDate: isoDateSchema,
  priceAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u),
  durationMinutes: z.number().int().min(1),
  stops: z.number().int().min(0)
}).strict();
export type LegSearchPick = z.infer<typeof legSearchPickSchema>;

export const legSearchAnalysisSchema = z.object({
  complete: z.boolean(),
  datesRequested: z.array(isoDateSchema).min(1).max(7),
  datesCompleted: z.array(isoDateSchema).max(7),
  failedDates: z.array(z.object({
    date: isoDateSchema,
    code: z.string().trim().min(1).max(100)
  }).strict()).max(7),
  optionsChecked: z.number().int().min(0),
  cheapest: legSearchPickSchema.nullable(),
  fastest: legSearchPickSchema.nullable(),
  balanced: legSearchPickSchema.nullable(),
  cheapestByDate: z.array(legSearchPickSchema).max(7),
  observedAt: z.iso.datetime({ offset: true }).nullable()
}).strict();
export type LegSearchAnalysis = z.infer<typeof legSearchAnalysisSchema>;

export const legSearchSnapshotSchema = z.object({
  id: z.uuid(),
  tripId: z.uuid(),
  legId: z.uuid(),
  revision: z.number().int().positive(),
  status: z.enum(["queued", "running", "completed", "partial", "failed"]),
  requestedWindow: dateWindowSchema,
  analysis: legSearchAnalysisSchema,
  flights: z.array(canonicalFlightSchema).max(120),
  offers: z.array(flightOfferSnapshotSchema).max(240),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable()
}).strict();
export type LegSearchSnapshot = z.infer<typeof legSearchSnapshotSchema>;

export type LegSearchSnapshotRevision = Pick<
  LegSearchSnapshot,
  "status" | "analysis" | "flights" | "offers" | "completedAt"
>;

export type TripGraph = {
  cities: TripCity[];
  legs: TripCityLeg[];
};

export const MAX_MANUAL_SEARCH_DAYS = 7;

const AIRPORT_CITY_LABELS: Readonly<Record<string, string>> = {
  LOS: "Lagos",
  ABV: "Abuja",
  ACC: "Accra",
  ABJ: "Abidjan",
  DSS: "Dakar",
  NBO: "Nairobi",
  EBB: "Entebbe",
  KGL: "Kigali",
  ADD: "Addis Ababa",
  JNB: "Johannesburg",
  CPT: "Cape Town",
  LON: "London",
  LHR: "London",
  LGW: "London",
  LCY: "London",
  STN: "London",
  NYC: "New York",
  JFK: "New York",
  EWR: "New York",
  LGA: "New York",
  PAR: "Paris",
  CDG: "Paris",
  ORY: "Paris",
  AMS: "Amsterdam",
  BER: "Berlin",
  MAD: "Madrid",
  BCN: "Barcelona",
  FCO: "Rome",
  TYO: "Tokyo",
  HND: "Tokyo",
  NRT: "Tokyo"
};

/** Human city label for a resolved airport set, falling back to IATA codes. */
export function cityLabelForAirportCodes(airportCodes: readonly string[]): string {
  const labels = [...new Set(airportCodes.map((code) =>
    AIRPORT_CITY_LABELS[code.trim().toUpperCase()] ?? code.trim().toUpperCase()
  ))];
  return labels.join("/");
}
