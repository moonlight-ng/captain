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
  departure: tripDraftDateSelectionSchema.nullable()
}).strict();
export type TripDraftRouteLeg = z.infer<typeof tripDraftRouteLegSchema>;

export const tripDraftStateSchema = z.object({
  version: z.literal(3),
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
  excludedAirlines: z.array(z.string().regex(/^[A-Z0-9]{2,3}$/u)).max(12)
}).strict();
export type TripDraftState = z.infer<typeof tripDraftStateSchema>;

export const EMPTY_TRIP_DRAFT_STATE: TripDraftState = {
  version: 3,
  tripType: null,
  legs: [],
  travellers: null,
  cabin: null,
  maxStops: null,
  currency: null,
  maximumPrice: null,
  preferredAirlines: [],
  excludedAirlines: []
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
  created: z.boolean(),
  status: tripStatusSchema,
  title: z.string().trim().min(1).max(120),
  originAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
  destinationAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
  legs: z.array(z.object({
    originAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
    destinationAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).min(1),
    departureDate: isoDateSchema
  }).strict()).optional(),
  departureDate: isoDateSchema,
  returnDate: isoDateSchema.nullable(),
  stayNights: z.number().int().positive().nullable(),
  travellers: z.number().int().positive(),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]),
  maxStops: z.number().int().min(0).max(2),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  dashboardUrl: z.url(),
  accessHint: z.literal("Send /trip to open your trip.")
}).strict();
export type TripCreationReceipt = z.infer<typeof tripCreationReceiptSchema>;

export type TripPlanResult =
  | {
      status: "needs_input";
      draft: TripPlanDraft;
      prompt: string;
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
    };

export type TripPlanDraftRevision = {
  status: Extract<TripPlanDraftStatus, "collecting" | "awaiting_confirmation">;
  conversation: string[];
  state: TripDraftState;
  confirmationSnapshot: TripPlanConfirmationSnapshot | null;
  sourceMessageIds: string[];
};

export type TripCreationResult = {
  trip: import("./trip.js").Trip;
  watch: import("./trip.js").Watch;
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
