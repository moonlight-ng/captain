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

export const plannedTripSchema = z.object({
  input: createTripSchema,
  departureDate: isoDateSchema,
  returnDate: isoDateSchema.nullable()
}).strict();
export type PlannedTrip = z.infer<typeof plannedTripSchema>;

export const tripPlanPartialSchema = z.object({
  originAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).max(4),
  destinationAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).max(6),
  tripType: z.enum(["one_way", "round_trip", "multi_city"]).nullable(),
  legs: z.array(z.object({
    originAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).max(4),
    destinationAirports: z.array(z.string().regex(/^[A-Z]{3}$/u)).max(6),
    departureDate: isoDateSchema.nullable()
  }).strict()).max(6).default([]),
  departureDate: isoDateSchema.nullable(),
  returnDate: isoDateSchema.nullable(),
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
export type TripPlanPartial = z.infer<typeof tripPlanPartialSchema>;

export const EMPTY_TRIP_PLAN_PARTIAL: TripPlanPartial = {
  originAirports: [],
  destinationAirports: [],
  tripType: null,
  legs: [],
  departureDate: null,
  returnDate: null,
  travellers: null,
  cabin: null,
  maxStops: null,
  currency: null,
  maximumPrice: null,
  preferredAirlines: [],
  excludedAirlines: []
};

export const tripPlanPendingFieldSchema = z.enum([
  "originAirports",
  "destinationAirports",
  "departureDate",
  "returnDate",
  "itineraryLegs",
  "travellers",
  "currency",
  "dates"
]);
export type TripPlanPendingField = z.infer<typeof tripPlanPendingFieldSchema>;

export const tripPlanFieldSourceSchema = z.object({
  kind: z.enum(["explicit", "inferred", "default"]),
  messageIndex: z.number().int().min(0),
  text: z.string().trim().max(500)
}).strict();
export type TripPlanFieldSource = z.infer<typeof tripPlanFieldSourceSchema>;

export const tripPlanTurnOperationSchema = z.object({
  field: z.string().trim().min(1).max(100),
  legIndex: z.number().int().min(0).max(5).nullable(),
  action: z.enum(["set", "clear", "reject"]),
  reason: z.string().trim().min(1).max(200),
  sourceText: z.string().trim().max(500)
}).strict();
export type TripPlanTurnOperation = z.infer<typeof tripPlanTurnOperationSchema>;

export const tripPlanTurnStateSchema = z.object({
  version: z.literal(2),
  pendingFields: z.array(z.object({
    field: tripPlanPendingFieldSchema,
    legIndex: z.number().int().min(0).max(5).nullable()
  }).strict()).max(12),
  lastPrompt: z.string().trim().max(1_000).nullable(),
  repeatedPromptCount: z.number().int().min(0).max(10),
  fieldSources: z.record(z.string(), tripPlanFieldSourceSchema),
  interpreterVersion: z.literal("trip_interpreter_v2").default("trip_interpreter_v2"),
  parser: z.enum(["model", "deterministic", "repair"]).nullable().default(null),
  model: z.string().trim().min(1).max(100).nullable().default(null),
  lastIntent: z.enum([
    "start_trip",
    "answer_question",
    "revise_draft",
    "repair",
    "confirm",
    "cancel",
    "unrelated"
  ]).nullable(),
  lastOperations: z.array(tripPlanTurnOperationSchema).max(40)
}).strict();
export type TripPlanTurnState = z.infer<typeof tripPlanTurnStateSchema>;

export const EMPTY_TRIP_PLAN_TURN_STATE: TripPlanTurnState = {
  version: 2,
  pendingFields: [],
  lastPrompt: null,
  repeatedPromptCount: 0,
  fieldSources: {},
  interpreterVersion: "trip_interpreter_v2",
  parser: null,
  model: null,
  lastIntent: null,
  lastOperations: []
};

export const tripPlanDraftSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  status: tripPlanDraftStatusSchema,
  revision: z.number().int().positive(),
  conversation: z.array(z.string().trim().min(1).max(2_000)).max(40),
  partial: tripPlanPartialSchema,
  plan: plannedTripSchema.nullable(),
  unresolvedFields: z.array(z.string().trim().min(1)).max(24),
  inferredFields: z.record(z.string(), z.string()),
  turnState: tripPlanTurnStateSchema,
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
  accessHint: z.literal("Send /trips to open your Trips.")
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
  partial: TripPlanPartial;
  plan: PlannedTrip | null;
  unresolvedFields: string[];
  inferredFields: Record<string, string>;
  turnState: TripPlanTurnState;
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
