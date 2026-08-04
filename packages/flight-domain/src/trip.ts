import { z } from "zod";

import type { FlightSearchProviderId } from "./provider.js";

export const MAX_ACTIVE_TRIPS_PER_USER = 3;
export const MAX_SEARCH_COMBINATIONS = 1;
export const TRACKING_CADENCE_HOURS = 6;
export const DEFAULT_TRACKING_DURATION_HOURS = 72;

const iataCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const airlineCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/);
const dateWindowSchema = z.object({
  start: z.iso.date(),
  end: z.iso.date()
}).strict();

export const tripLegSchema = z.object({
  originAirports: z.array(iataCodeSchema).min(1).max(4),
  destinationAirports: z.array(iataCodeSchema).min(1).max(6),
  departureWindow: dateWindowSchema
}).strict().superRefine((leg, context) => {
  validateDateWindow(leg.departureWindow, context, ["departureWindow"]);
  if (leg.originAirports.some((airport) => leg.destinationAirports.includes(airport))) {
    context.addIssue({
      code: "custom",
      path: ["destinationAirports"],
      message: "A leg's origin and destination airports must differ"
    });
  }
});
export type TripLeg = z.infer<typeof tripLegSchema>;

export const travellersSchema = z.object({
  adults: z.literal(1),
  childrenAges: z.array(z.never()).max(0).default([]),
  infants: z.literal(0).default(0)
}).strict();

const stayNightsSchema = z.object({
  minimum: z.number().int().min(1).max(30),
  preferred: z.number().int().min(1).max(30),
  maximum: z.number().int().min(1).max(30)
}).strict().superRefine((value, context) => {
  if (value.minimum > value.preferred || value.preferred > value.maximum) {
    context.addIssue({ code: "custom", message: "Stay length must be ordered minimum, preferred, maximum" });
  }
});

export const tripBriefSchema = z.object({
  originAirports: z.array(iataCodeSchema).min(1).max(4),
  destinationAirports: z.array(iataCodeSchema).min(1).max(6),
  tripType: z.enum(["one_way", "round_trip", "multi_city"]),
  departureWindow: dateWindowSchema,
  stayNights: stayNightsSchema.nullable(),
  /** Ordered route for multi-city trips. Absent for legacy one-way and round trips. */
  legs: z.array(tripLegSchema).max(6).optional(),
  travellers: travellersSchema,
  cabin: z.enum(["economy", "premium_economy", "business", "first"]),
  maxStops: z.number().int().min(0).max(2),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  maximumPrice: z.number().positive().nullable().default(null),
  preferredAirlines: z.array(airlineCodeSchema).max(12).default([]),
  excludedAirlines: z.array(airlineCodeSchema).max(12).default([]),
  context: z.string().trim().max(1_000).default("")
}).strict().superRefine((brief, context) => {
  validateDateWindow(brief.departureWindow, context, ["departureWindow"]);
  if (brief.tripType === "round_trip" && brief.stayNights === null) {
    context.addIssue({ code: "custom", path: ["stayNights"], message: "Round trips require a stay length" });
  }
  if (brief.tripType !== "round_trip" && brief.stayNights !== null) {
    context.addIssue({ code: "custom", path: ["stayNights"], message: "Only round trips can include a stay length" });
  }
  if (brief.tripType !== "multi_city" && brief.originAirports.some((airport) => brief.destinationAirports.includes(airport))) {
    context.addIssue({ code: "custom", path: ["destinationAirports"], message: "Origin and destination airports must differ" });
  }
  if (brief.tripType !== "multi_city" && (brief.legs?.length ?? 0) > 0) {
    context.addIssue({ code: "custom", path: ["legs"], message: "Only multi-city trips can include itinerary legs" });
  }
  if (brief.tripType === "multi_city") {
    validateMultiCityBrief(brief, context);
  }
});

export type TripBrief = z.infer<typeof tripBriefSchema>;

export const tripStatusSchema = z.enum([
  "draft",
  "tracking",
  "recommended",
  "paused",
  "cancelled",
  "completed",
  "archived"
]);
export type TripStatus = z.infer<typeof tripStatusSchema>;

export const createTripSchema = z.object({
  title: z.string().trim().min(1).max(120),
  brief: tripBriefSchema,
  cadenceHours: z.literal(TRACKING_CADENCE_HOURS).default(TRACKING_CADENCE_HOURS),
  trackingDurationHours: z.literal(DEFAULT_TRACKING_DURATION_HOURS)
    .default(DEFAULT_TRACKING_DURATION_HOURS)
}).strict();
export type CreateTripInput = z.infer<typeof createTripSchema>;

export const tripActionSchema = z.object({
  type: z.enum(["pause", "resume", "refresh", "track", "cancel", "complete"]),
  expectedVersion: z.number().int().positive()
}).strict();
export type TripAction = z.infer<typeof tripActionSchema>;

export const updateTripBriefSchema = z.object({
  expectedVersion: z.number().int().positive(),
  brief: tripBriefSchema
}).strict();
export type UpdateTripBrief = z.infer<typeof updateTripBriefSchema>;

export type Trip = {
  id: string;
  userId: string;
  title: string;
  status: TripStatus;
  version: number;
  brief: TripBrief;
  archivedAt: string | null;
  archiveReason: "replaced" | "user" | null;
  createdAt: string;
  updatedAt: string;
};

export type Watch = {
  id: string;
  tripId: string;
  status: "active" | "scheduled" | "paused" | "completed";
  cadenceHours: number;
  trackingDurationHours: 72;
  runStartedAt: string;
  runEndsAt: string;
  completedAt: string | null;
  checksCompleted: number;
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  lastManualRefreshAt: string | null;
  trackingStartsAt: string | null;
  baselineCompletedAt: string | null;
  activatedAt: string | null;
  lastUserActivityAt: string;
  checkInSentAt: string | null;
  autoPauseAt: string | null;
  priceRiseItineraryKey: string | null;
  priceRiseArmed: boolean;
  delayedAt: string | null;
  delayReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OfferSnapshot = {
  id: string;
  searchRunId: string;
  searchSpecId: string;
  itineraryKey: string;
  provider: FlightSearchProviderId;
  providerOfferId: string;
  providerSearchId: string;
  price: number;
  priceAmount: string;
  currency: string;
  fareBasis: "one_adult_total";
  primaryAirlineCode: string;
  participatingAirlineCodes: string[];
  evidence: Array<{ url: string; title: string; domain: string }>;
  discoveryResponseId: string;
  verificationResponseId: string;
  promptVersion: string;
  model: string;
  verifiedAt: string;
  expiresAt: string | null;
  observedAt: string;
  snapshot: Record<string, unknown>;
};

export class TripNotFoundError extends Error {
  constructor() {
    super("Trip not found");
    this.name = "TripNotFoundError";
  }
}

export class TripVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("Trip version is stale");
    this.name = "TripVersionConflictError";
  }
}

export class TripLimitError extends Error {
  constructor() {
    super(`A user may have at most ${MAX_ACTIVE_TRIPS_PER_USER} active trips`);
    this.name = "TripLimitError";
  }
}

function validateDateWindow(
  window: { start: string; end: string },
  context: z.RefinementCtx,
  path: PropertyKey[]
): void {
  const start = Date.parse(`${window.start}T00:00:00Z`);
  const end = Date.parse(`${window.end}T00:00:00Z`);
  if (end < start) {
    context.addIssue({
      code: "custom",
      path: [...path, "end"],
      message: "Departure window end must not precede its start"
    });
  }
  if ((end - start) / 86_400_000 > 30) {
    context.addIssue({
      code: "custom",
      path,
      message: "Departure windows are limited to 31 days"
    });
  }
}

function validateMultiCityBrief(
  brief: z.infer<typeof tripBriefSchema>,
  context: z.RefinementCtx
): void {
  const legs = brief.legs ?? [];
  if (legs.length < 2) {
    context.addIssue({
      code: "custom",
      path: ["legs"],
      message: "Multi-city trips require at least two legs"
    });
    return;
  }
  const first = legs[0]!;
  const last = legs.at(-1)!;
  if (!hasOverlap(brief.originAirports, first.originAirports)) {
    context.addIssue({
      code: "custom",
      path: ["originAirports"],
      message: "Trip origin must match the first multi-city leg"
    });
  }
  if (!hasOverlap(brief.destinationAirports, last.destinationAirports)) {
    context.addIssue({
      code: "custom",
      path: ["destinationAirports"],
      message: "Trip destination must match the final multi-city leg"
    });
  }
  if (
    brief.departureWindow.start !== first.departureWindow.start
    || brief.departureWindow.end !== first.departureWindow.end
  ) {
    context.addIssue({
      code: "custom",
      path: ["departureWindow"],
      message: "Trip departure window must match the first multi-city leg"
    });
  }
  for (let index = 1; index < legs.length; index += 1) {
    const previous = legs[index - 1]!;
    const current = legs[index]!;
    if (!hasOverlap(previous.destinationAirports, current.originAirports)) {
      context.addIssue({
        code: "custom",
        path: ["legs", index, "originAirports"],
        message: "Each multi-city leg must continue from the preceding destination"
      });
    }
    if (current.departureWindow.end < previous.departureWindow.start) {
      context.addIssue({
        code: "custom",
        path: ["legs", index, "departureWindow"],
        message: "Multi-city legs must be in chronological order"
      });
    }
  }
}

function hasOverlap(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}
