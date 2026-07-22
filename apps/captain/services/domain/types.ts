import { z } from "zod";

const iataCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const airlineCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/);
const isoDateSchema = z.iso.date();

export const cadenceHoursSchema = z.union([
  z.literal(1),
  z.literal(6),
  z.literal(12),
  z.literal(24)
]);
export type CadenceHours = z.infer<typeof cadenceHoursSchema>;

export const trackingWindowDaysSchema = z.union([
  z.literal(7),
  z.literal(14),
  z.literal(30),
  z.null()
]);
export type TrackingWindowDays = z.infer<typeof trackingWindowDaysSchema>;

export const agentStatusSchema = z.enum([
  "queued",
  "active",
  "paused",
  "needs_attention"
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const checkStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "partial",
  "failed"
]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const checkModeSchema = z.enum(["fare", "fare_and_research"]);
export type CheckMode = z.infer<typeof checkModeSchema>;

export const flightReviewStateSchema = z.enum([
  "discovered",
  "promoted",
  "retained",
  "dismissed"
]);
export type FlightReviewState = z.infer<typeof flightReviewStateSchema>;

const travellersSchema = z.object({
  adults: z.number().int().min(1).max(9),
  childrenAges: z.array(z.number().int().min(2).max(17)).max(8).default([]),
  infants: z.number().int().min(0).max(4).default(0)
}).strict().superRefine((value, context) => {
  if (value.infants > value.adults) {
    context.addIssue({
      code: "custom",
      path: ["infants"],
      message: "Each infant must travel with an adult"
    });
  }
  if (value.adults + value.childrenAges.length + value.infants > 9) {
    context.addIssue({
      code: "custom",
      message: "Duffel searches support at most nine travellers"
    });
  }
});

const stayNightsSchema = z.object({
  minimum: z.number().int().min(1).max(30),
  preferred: z.number().int().min(1).max(30),
  maximum: z.number().int().min(1).max(30)
}).strict().superRefine((value, context) => {
  if (value.minimum > value.preferred || value.preferred > value.maximum) {
    context.addIssue({
      code: "custom",
      message: "Stay length must be ordered minimum, preferred, maximum"
    });
  }
});

export const flightAgentBriefSchema = z.object({
  originAirports: z.array(iataCodeSchema).min(1).max(4),
  destinationAirports: z.array(iataCodeSchema).min(1).max(6),
  tripType: z.enum(["one_way", "round_trip"]),
  departureWindow: z.object({
    start: isoDateSchema,
    end: isoDateSchema
  }).strict(),
  stayNights: stayNightsSchema.nullable(),
  travellers: travellersSchema,
  cabin: z.enum(["economy", "premium_economy", "business", "first"]),
  maxStops: z.number().int().min(0).max(2),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  maximumPrice: z.number().positive().nullable().default(null),
  preferredAirlines: z.array(airlineCodeSchema).max(12).default([]),
  excludedAirlines: z.array(airlineCodeSchema).max(12).default([]),
  context: z.string().trim().max(1_000).default("")
}).strict().superRefine((brief, context) => {
  const start = Date.parse(`${brief.departureWindow.start}T00:00:00Z`);
  const end = Date.parse(`${brief.departureWindow.end}T00:00:00Z`);
  if (end < start) {
    context.addIssue({
      code: "custom",
      path: ["departureWindow", "end"],
      message: "Departure window end must not precede its start"
    });
  }
  if ((end - start) / 86_400_000 > 30) {
    context.addIssue({
      code: "custom",
      path: ["departureWindow"],
      message: "Departure windows are limited to 31 days"
    });
  }
  if (brief.tripType === "round_trip" && brief.stayNights === null) {
    context.addIssue({
      code: "custom",
      path: ["stayNights"],
      message: "Round trips require a stay length"
    });
  }
  if (brief.tripType === "one_way" && brief.stayNights !== null) {
    context.addIssue({
      code: "custom",
      path: ["stayNights"],
      message: "One-way trips cannot include a stay length"
    });
  }
  if (brief.originAirports.some((airport) => brief.destinationAirports.includes(airport))) {
    context.addIssue({
      code: "custom",
      path: ["destinationAirports"],
      message: "Origin and destination airports must differ"
    });
  }
});
export type FlightAgentBrief = z.infer<typeof flightAgentBriefSchema>;

export const createFlightAgentSchema = z.object({
  brief: flightAgentBriefSchema,
  cadenceHours: cadenceHoursSchema.default(6),
  requestedBy: z.string().trim().min(1).max(120).default("owner")
}).strict();
export type CreateFlightAgentInput = z.infer<typeof createFlightAgentSchema>;

export const browsePreferencesSchema = z.object({
  sort: z.enum(["recommended", "price", "duration", "departure"]).default("recommended"),
  stops: z.array(z.number().int().min(0).max(2)).default([]),
  airlines: z.array(z.string().trim().min(1).max(120)).default([]),
  airports: z.array(iataCodeSchema).default([]),
  cabins: z.array(z.enum(["economy", "premium_economy", "business", "first"])).default([]),
  maximumPrice: z.number().positive().nullable().default(null),
  departurePeriods: z.array(z.enum(["morning", "afternoon", "evening"])).default([])
}).strict();
export type BrowsePreferences = z.infer<typeof browsePreferencesSchema>;

export const agentActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pause"), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("resume"), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("run"), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("research"), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("update_brief"), expectedVersion: z.number().int().positive(), brief: flightAgentBriefSchema }).strict(),
  z.object({ type: z.literal("set_cadence"), expectedVersion: z.number().int().positive(), cadenceHours: cadenceHoursSchema }).strict(),
  z.object({ type: z.literal("set_tracking_window"), expectedVersion: z.number().int().positive(), trackingWindowDays: trackingWindowDaysSchema }).strict(),
  z.object({ type: z.literal("set_browse_preferences"), expectedVersion: z.number().int().positive(), preferences: browsePreferencesSchema }).strict(),
  z.object({ type: z.literal("retain_flight"), expectedVersion: z.number().int().positive(), flightKey: z.string().uuid() }).strict(),
  z.object({ type: z.literal("dismiss_flight"), expectedVersion: z.number().int().positive(), flightKey: z.string().uuid() }).strict()
]);
export type AgentAction = z.infer<typeof agentActionSchema>;

export type SearchCombination = {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate: string | null;
};

export type FlightSource = "duffel" | "codex_web";
export type EvidenceStrength = "direct" | "corroborated" | "tentative";

export type ItinerarySegment = {
  airlineCode: string;
  airline: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
};

export type FlightIdentity = {
  id: string;
  itineraryKey: string;
  destination: string;
  travelDate: string;
  marketingAirlineCode: string;
  marketingAirline: string;
};

export type FlightSnapshot = {
  provider: FlightSource;
  sourceName: string;
  sourceUrl: string | null;
  bookingUrl: string | null;
  evidence: EvidenceStrength;
  providerOfferId: string;
  providerSearchId: string;
  observedAt: string;
  origin: string;
  destination: string;
  travelDate: string;
  returnDate: string | null;
  marketingAirlineCode: string;
  marketingAirline: string;
  flightNumber: string;
  route: string;
  departure: string;
  arrival: string;
  durationSeconds: number;
  stops: number;
  cabin: FlightAgentBrief["cabin"];
  price: number;
  currency: string;
  rank: number;
  passengerCount: number;
  segments: ItinerarySegment[];
  conditions: Record<string, string>;
};

export type PriceObservation = FlightSnapshot & {
  id: string;
  checkId: string;
};

export type FlightWorkspaceItem = FlightIdentity & {
  reviewState: FlightReviewState;
  promotionReason: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  latest: FlightSnapshot;
  previousPrice: number | null;
  changePercent: number | null;
  observationCount: number;
  trackedUntilAt: string | null;
  folderIds: string[];
};

export type ResearchResult = {
  status: "completed" | "failed";
  searchedAt: string;
  overview: string | null;
  results: Array<{
    rank: number;
    title: string;
    finding: string;
    sourceName: string;
    sourceUrl: string;
    publishedAt: string | null;
    sourceType: "official" | "primary" | "secondary" | "other";
    evidence: EvidenceStrength;
  }>;
  offers: Array<{
    sourceName: string;
    sourceUrl: string;
    bookingUrl: string | null;
    evidence: EvidenceStrength;
    origin: string;
    destination: string;
    travelDate: string;
    returnDate: string | null;
    marketingAirlineCode: string;
    marketingAirline: string;
    flightNumber: string;
    route: string;
    departure: string;
    arrival: string;
    durationSeconds: number;
    stops: number;
    cabin: FlightAgentBrief["cabin"];
    price: number;
    currency: string;
    passengerCount: number;
    segments: ItinerarySegment[];
    baggage: string | null;
    fareConditions: string | null;
  }>;
  gaps: string[];
  error: string | null;
  metadata: {
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    durationMs: number;
  } | null;
};

export type CheckSourceRun = {
  source: FlightSource;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  offersFound: number;
  observationsSaved: number;
  error: string | null;
};

export type AgentCheck = {
  id: string;
  status: CheckStatus;
  mode: CheckMode;
  trigger: "initial" | "scheduled" | "manual" | "resume" | "retry";
  startedAt: string;
  completedAt: string | null;
  matrix: SearchCombination[];
  searched: number;
  offersFound: number;
  identitiesMatched: number;
  promotions: number;
  duffelError: string | null;
  sourceRuns: CheckSourceRun[];
  research: ResearchResult | null;
};

export type AgentActivity = {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type FlightFolder = {
  id: string;
  name: string;
  createdAt: string;
  flightCount: number;
};

export type FlightAgent = {
  key: string;
  status: AgentStatus;
  version: number;
  brief: FlightAgentBrief;
  cadenceHours: CadenceHours;
  trackingWindowDays: TrackingWindowDays;
  searchCursor: number;
  browsePreferences: BrowsePreferences;
  createdAt: string;
  processingStartedAt: string | null;
  accumulatedProcessingMs: number;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  latestCheck: AgentCheck | null;
};

export type FlightAgentSummary = Pick<
  FlightAgent,
  "key" | "status" | "version" | "brief" | "cadenceHours" | "createdAt" | "lastCheckAt" | "nextCheckAt"
> & {
  reviewCount: number;
  browseCount: number;
  processingTimeMs: number;
};

export type FlightAgentWorkspace = {
  version: 1;
  agent: FlightAgent;
  reviewFlights: FlightWorkspaceItem[];
  browseFlights: FlightWorkspaceItem[];
  recentChecks: AgentCheck[];
  activity: AgentActivity[];
  folders: FlightFolder[];
};

export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("Agent version is stale");
    this.name = "VersionConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}
