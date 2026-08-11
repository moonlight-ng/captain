import { z } from "zod";

import { createTripSchema, tripStatusSchema, type CreateTripInput } from "./trip.js";

const isoDateSchema = z.iso.date();

export const tripPlanDraftStatusSchema = z.enum([
  "collecting",
  "awaiting_confirmation",
  "starting",
  "started",
  "cancelled",
  "expired"
]);
export type TripPlanDraftStatus = z.infer<typeof tripPlanDraftStatusSchema>;

export const tripPlanConfirmationSnapshotSchema = z.object({
  input: createTripSchema,
  departureDate: isoDateSchema,
  returnDate: isoDateSchema.nullable()
}).strict();
export type TripPlanConfirmationSnapshot = z.infer<
  typeof tripPlanConfirmationSnapshotSchema
>;

export const tripDraftDateSelectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact"),
    date: isoDateSchema
  }).strict(),
  z.object({
    kind: z.literal("window"),
    start: isoDateSchema,
    end: isoDateSchema,
    source: z.string().trim().min(1).max(500)
  }).strict()
]).superRefine((selection, context) => {
  if (selection.kind === "window" && selection.end < selection.start) {
    context.addIssue({
      code: "custom",
      path: ["end"],
      message: "Date window end must not precede its start"
    });
  }
});
export type TripDraftDateSelection = z.infer<typeof tripDraftDateSelectionSchema>;

export const tripDraftRouteLegSchema = z.object({
  originAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).max(4),
  destinationAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).max(6),
  departure: tripDraftDateSelectionSchema.nullable(),
  arriveBy: isoDateSchema.nullable().optional(),
  /** Hard timing bounds inferred from city presence. Draft-only. */
  feasibleDepartureWindow: z.object({
    start: isoDateSchema,
    end: isoDateSchema
  }).strict().nullable().optional(),
  /** A seven-day search window awaiting explicit traveller approval. Draft-only. */
  proposedDeparture: tripDraftDateSelectionSchema.nullable().optional()
}).strict();
export type TripDraftRouteLeg = z.infer<typeof tripDraftRouteLegSchema>;

export const tripDraftStateSchema = z.object({
  version: z.literal(3),
  /** Clarification questions asked; used only as a loop-safety ceiling. */
  questionsAsked: z.number().int().min(0).max(5).default(0),
  tripType: z.enum(["one_way", "round_trip", "multi_city"]).nullable(),
  legs: z.array(tripDraftRouteLegSchema).max(6),
  travellers: z.object({
    adults: z.number().int().min(1).max(9),
    childrenAges: z.array(z.number().int().min(2).max(17)).max(8),
    infants: z.number().int().min(0).max(4)
  }).strict().nullable(),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]).nullable(),
  maxStops: z.number().int().min(0).max(2).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  maximumPrice: z.number().positive().nullable(),
  preferredAirlines: z.array(z.string().regex(/^[A-Z0-9]{2,3}$/u)).max(12),
  excludedAirlines: z.array(z.string().regex(/^[A-Z0-9]{2,3}$/u)).max(12),
  /**
   * Airports Captain chose because the traveller named a country rather than a
   * city. Recorded so the confirmation can mark the guess; defaulted so drafts
   * persisted before this field parse unchanged.
   */
  assumedAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).max(6).default([])
}).strict();
export type TripDraftState = z.infer<typeof tripDraftStateSchema>;

export const EMPTY_TRIP_DRAFT_STATE: TripDraftState = {
  version: 3,
  questionsAsked: 0,
  tripType: null,
  legs: [],
  travellers: null,
  cabin: null,
  maxStops: null,
  currency: null,
  maximumPrice: null,
  preferredAirlines: [],
  excludedAirlines: [],
  assumedAirports: []
};

export const tripPlanDraftSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  status: tripPlanDraftStatusSchema,
  revision: z.number().int().positive(),
  conversation: z.array(z.string().trim().min(1).max(2_000)).max(40),
  state: tripDraftStateSchema,
  confirmationSnapshot: tripPlanConfirmationSnapshotSchema.nullable(),
  sourceMessageIds: z.array(z.uuid()).max(40),
  tripId: z.uuid().nullable(),
  createIdempotencyKey: z.string().trim().min(1).max(200).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime()
}).strict();
export type TripPlanDraft = z.infer<typeof tripPlanDraftSchema>;

export const tripCreationReceiptSchema = z.object({
  tripId: z.uuid(),
  version: z.number().int().positive(),
  created: z.boolean(),
  status: tripStatusSchema,
  title: z.string().trim().min(1).max(120),
  originAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
  destinationAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
  legs: z.array(z.object({
    originAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
    destinationAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
    departureDate: isoDateSchema,
    departureWindow: z.object({
      start: isoDateSchema,
      end: isoDateSchema
    }).strict().optional()
  }).strict()).optional(),
  departureDate: isoDateSchema,
  returnDate: isoDateSchema.nullable(),
  stayNights: z.number().int().positive().nullable(),
  travellers: z.number().int().positive(),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]),
  maxStops: z.number().int().min(0).max(2),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  /** What Captain is now trying to do for this trip, in one sentence. */
  goal: z.string().trim().min(1).max(300),
  dashboardUrl: z.url(),
  accessHint: z.literal("Send /trip to open your trip.")
}).strict();
export type TripCreationReceipt = z.infer<typeof tripCreationReceiptSchema>;

export type TripPlanResult =
  | {
      status: "needs_input";
      draft: TripPlanDraft;
      prompt: string;
      /**
       * The same prompt as the separate turns it is really made of, when it
       * carries more than one. A chat channel sends one message each; anything
       * that needs a single string uses `prompt`, which is these joined.
       */
      promptParts?: readonly string[];
      missingFields: string[];
    }
  | {
      status: "awaiting_confirmation";
      draft: TripPlanDraft;
      confirmation: string;
    }
  | {
      status: "started";
      draft: TripPlanDraft;
      receipt: TripCreationReceipt;
      message: string;
    }
  | {
      status: "cancelled";
      draft: TripPlanDraft;
      message: string;
    }
  /**
   * The turn carried no route or date evidence and a trip already exists, so
   * there was nothing to plan. Distinct from `needs_input`: Captain is not
   * short of an answer, the traveller was asking about the trip they have.
   */
  | {
      status: "no_trip_change";
      trip: import("./trip.js").Trip;
    }
  /**
   * An itinerary handed over as structured legs did not describe a journey.
   * Reported rather than thrown so the caller can fix the named field: an
   * error message is something to work around, a named field is something to
   * correct.
   */
  | {
      status: "invalid_legs";
      errors: ReadonlyArray<{
        /** 1-based, as the traveller counts legs. Null for the whole route. */
        legIndex: number | null;
        field: string;
        message: string;
      }>;
    };

/**
 * An itinerary stated as legs rather than prose. Places are free text and are
 * resolved by the planning service — the caller has no airport catalog, and
 * asking it for IATA codes is how a made-up code reaches a search.
 */
export const structuredTripLegSchema = z.object({
  origin: z.string().trim().min(2).max(60),
  destination: z.string().trim().min(2).max(60),
  departureDate: z.iso.date().optional(),
  departureWindow: z.object({
    start: z.iso.date(),
    end: z.iso.date()
  }).strict().optional(),
  arriveBy: z.iso.date().optional()
}).strict().superRefine((leg, context) => {
  if (Boolean(leg.departureDate) === Boolean(leg.departureWindow)) {
    context.addIssue({
      code: "custom",
      path: ["departureDate"],
      message: "Give a leg either an exact departure date or a departure window"
    });
  }
});
export type StructuredTripLeg = z.infer<typeof structuredTripLegSchema>;

export type TripPlanDraftRevision = {
  status: Extract<TripPlanDraftStatus, "collecting" | "awaiting_confirmation">;
  conversation: string[];
  state: TripDraftState;
  confirmationSnapshot: TripPlanConfirmationSnapshot | null;
  sourceMessageIds: string[];
};

export type TripCreationResult = {
  trip: import("./trip.js").Trip;
  /** Manual-search trips do not create a scheduled Watch. */
  watch: import("./trip.js").Watch | null;
  created: boolean;
};

export type TripPlanConfirmationInput = {
  draftId: string;
  expectedRevision: number;
  input: CreateTripInput;
};

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

export function parseIsoDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addIsoDays(value: string, days: number): string {
  const date = parseIsoDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / 86_400_000);
}

export function weekdayName(value: string): typeof WEEKDAYS[number] {
  return WEEKDAYS[parseIsoDate(value).getUTCDay()]!;
}

export function formatCalendarDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(parseIsoDate(value));
}

export function totalTravellers(input: CreateTripInput["brief"]["travellers"]): number {
  return input.adults + input.childrenAges.length + input.infants;
}
