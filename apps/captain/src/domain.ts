export type AgentStatus = "queued" | "active" | "paused" | "needs_attention";
export type CheckStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type CheckMode = "fare" | "fare_and_research";
export type CadenceHours = 1 | 6 | 12 | 24;
export type TrackingWindowDays = 7 | 14 | 30 | null;
export type FlightReviewState = "discovered" | "promoted" | "retained" | "dismissed";
export type Cabin = "economy" | "premium_economy" | "business" | "first";
export type BrowseSort = "recommended" | "price" | "duration" | "departure";
export type FlightSource = "duffel" | "codex_web";
export type EvidenceStrength = "direct" | "corroborated" | "tentative";

export interface ItinerarySegment {
  readonly airlineCode: string;
  readonly airline: string;
  readonly flightNumber: string;
  readonly origin: string;
  readonly destination: string;
  readonly departure: string;
  readonly arrival: string;
}

export interface FlightAgentBrief {
  readonly originAirports: string[];
  readonly destinationAirports: string[];
  readonly tripType: "one_way" | "round_trip" | "multi_city";
  readonly departureWindow: { readonly start: string; readonly end: string };
  readonly stayNights: {
    readonly minimum: number;
    readonly preferred: number;
    readonly maximum: number;
  } | null;
  readonly travellers: {
    readonly adults: number;
    readonly childrenAges: number[];
    readonly infants: number;
  };
  readonly cabin: Cabin;
  readonly maxStops: number;
  readonly currency: string;
  readonly maximumPrice: number | null;
  readonly preferredAirlines: string[];
  readonly excludedAirlines: string[];
  readonly context: string;
  readonly legs?: Array<{
    readonly originAirports: string[];
    readonly destinationAirports: string[];
    readonly departureWindow: { readonly start: string; readonly end: string };
  }>;
}

export interface BrowsePreferences {
  readonly sort: BrowseSort;
  readonly stops: number[];
  readonly airlines: string[];
  readonly airports: string[];
  readonly cabins: Cabin[];
  readonly maximumPrice: number | null;
  readonly departurePeriods: Array<"morning" | "afternoon" | "evening">;
}

export interface FlightSnapshot {
  readonly provider: FlightSource;
  readonly sourceName: string;
  readonly sourceUrl: string | null;
  readonly bookingUrl: string | null;
  readonly evidence: EvidenceStrength;
  readonly providerOfferId: string;
  readonly providerSearchId: string;
  readonly observedAt: string;
  readonly origin: string;
  readonly destination: string;
  readonly travelDate: string;
  readonly returnDate: string | null;
  readonly marketingAirlineCode: string;
  readonly marketingAirline: string;
  readonly flightNumber: string;
  readonly route: string;
  readonly departure: string;
  readonly arrival: string;
  readonly durationSeconds: number;
  readonly stops: number;
  readonly cabin: Cabin;
  readonly price: number;
  readonly currency: string;
  readonly rank: number;
  readonly passengerCount: number;
  readonly segments: ItinerarySegment[];
  readonly conditions: Record<string, string>;
}

export interface FlightItem {
  readonly id: string;
  readonly itineraryKey: string;
  readonly destination: string;
  readonly travelDate: string;
  readonly marketingAirlineCode: string;
  readonly marketingAirline: string;
  readonly reviewState: FlightReviewState;
  readonly promotionReason: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly latest: FlightSnapshot;
  readonly previousPrice: number | null;
  readonly changePercent: number | null;
  readonly observationCount: number;
  readonly trackedUntilAt: string | null;
  readonly folderIds: string[];
}

export interface ResearchResult {
  readonly status: "completed" | "failed";
  readonly searchedAt: string;
  readonly overview: string | null;
  readonly results: Array<{
    readonly rank: number;
    readonly title: string;
    readonly finding: string;
    readonly sourceName: string;
    readonly sourceUrl: string;
    readonly publishedAt: string | null;
    readonly sourceType: "official" | "primary" | "secondary" | "other";
    readonly evidence: EvidenceStrength;
  }>;
  readonly offers: Array<{
    readonly sourceName: string;
    readonly sourceUrl: string;
    readonly bookingUrl: string | null;
    readonly evidence: EvidenceStrength;
    readonly origin: string;
    readonly destination: string;
    readonly travelDate: string;
    readonly returnDate: string | null;
    readonly marketingAirlineCode: string;
    readonly marketingAirline: string;
    readonly flightNumber: string;
    readonly route: string;
    readonly departure: string;
    readonly arrival: string;
    readonly durationSeconds: number;
    readonly stops: number;
    readonly cabin: Cabin;
    readonly price: number;
    readonly currency: string;
    readonly passengerCount: number;
    readonly segments: ItinerarySegment[];
    readonly baggage: string | null;
    readonly fareConditions: string | null;
  }>;
  readonly gaps: string[];
  readonly error: string | null;
  readonly metadata: {
    readonly model: string;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
    readonly durationMs: number;
  } | null;
}

export interface CheckSourceRun {
  readonly source: FlightSource;
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly offersFound: number;
  readonly observationsSaved: number;
  readonly error: string | null;
}

export interface AgentCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly mode: CheckMode;
  readonly trigger: "initial" | "scheduled" | "manual" | "resume" | "retry";
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly matrix: Array<{
    readonly origin: string;
    readonly destination: string;
    readonly departureDate: string;
    readonly returnDate: string | null;
  }>;
  readonly searched: number;
  readonly offersFound: number;
  readonly identitiesMatched: number;
  readonly promotions: number;
  readonly duffelError: string | null;
  readonly sourceRuns: CheckSourceRun[];
  readonly research: ResearchResult | null;
}

export interface Activity {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface Folder {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly flightCount: number;
}

export interface FlightAgent {
  readonly key: string;
  readonly status: AgentStatus;
  readonly version: number;
  readonly brief: FlightAgentBrief;
  readonly cadenceHours: CadenceHours;
  readonly trackingWindowDays: TrackingWindowDays;
  readonly searchCursor: number;
  readonly browsePreferences: BrowsePreferences;
  readonly createdAt: string;
  readonly processingStartedAt: string | null;
  readonly accumulatedProcessingMs: number;
  readonly lastCheckAt: string | null;
  readonly nextCheckAt: string | null;
  readonly latestCheck: AgentCheck | null;
}

export interface AgentSummary {
  readonly key: string;
  readonly status: AgentStatus;
  readonly version: number;
  readonly brief: FlightAgentBrief;
  readonly cadenceHours: CadenceHours;
  readonly createdAt: string;
  readonly lastCheckAt: string | null;
  readonly nextCheckAt: string | null;
  readonly reviewCount: number;
  readonly browseCount: number;
  readonly processingTimeMs: number;
}

export interface Workspace {
  readonly version: 1;
  readonly agent: FlightAgent;
  readonly reviewFlights: FlightItem[];
  readonly browseFlights: FlightItem[];
  readonly recentChecks: AgentCheck[];
  readonly activity: Activity[];
  readonly folders: Folder[];
}

export interface FlightDetails {
  readonly flight: FlightItem;
  readonly observations: Array<FlightSnapshot & { readonly id: string; readonly checkId: string }>;
  readonly relatedChecks: AgentCheck[];
  readonly research: ResearchResult[];
}

export interface TripDashboardPayload {
  readonly trip: {
    readonly id: string;
    readonly title: string;
    readonly status: "draft" | "tracking" | "recommended" | "paused" | "cancelled" | "completed";
    readonly version: number;
    readonly brief: FlightAgentBrief;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly watch: {
    readonly status: "active" | "paused" | "completed";
    readonly cadenceHours: number;
    readonly nextCheckAt: string | null;
    readonly lastCheckAt: string | null;
  } | null;
  readonly offers: Array<{
    readonly id: string;
    readonly searchRunId: string;
    readonly itineraryKey: string;
    readonly providerOfferId: string;
    readonly providerSearchId: string;
    readonly price: number;
    readonly currency: string;
    readonly expiresAt: string | null;
    readonly observedAt: string;
    readonly snapshot: Record<string, unknown>;
  }>;
  readonly selections: Array<{
    readonly tripId: string;
    readonly itineraryKey: string;
    readonly selectedBy: "agent" | "person";
    readonly selectedAt: string;
  }>;
}

export const EMPTY_PREFERENCES: BrowsePreferences = {
  sort: "recommended",
  stops: [],
  airlines: [],
  airports: [],
  cabins: [],
  maximumPrice: null,
  departurePeriods: []
};

export function workspaceFromTripDashboard(payload: TripDashboardPayload): Workspace {
  const selections = new Map<string, Set<"agent" | "person">>();
  for (const selection of payload.selections) {
    const selectedBy = selections.get(selection.itineraryKey) ?? new Set<"agent" | "person">();
    selectedBy.add(selection.selectedBy);
    selections.set(selection.itineraryKey, selectedBy);
  }
  const flights = payload.offers.map((offer, index) => flightFromTripOffer(
    payload,
    offer,
    index,
    selections.get(offer.itineraryKey)
  ));
  const watchStatus = payload.watch?.status;
  const status: AgentStatus = watchStatus === "paused"
    ? "paused"
    : watchStatus === "active" && flights.length === 0
      ? "queued"
      : payload.trip.status === "cancelled" || payload.trip.status === "completed"
        ? "needs_attention"
        : "active";
  return {
    version: 1,
    agent: {
      key: payload.trip.id,
      status,
      version: payload.trip.version,
      brief: payload.trip.brief,
      cadenceHours: cadence(payload.watch?.cadenceHours),
      trackingWindowDays: null,
      searchCursor: 0,
      browsePreferences: EMPTY_PREFERENCES,
      createdAt: payload.trip.createdAt,
      processingStartedAt: null,
      accumulatedProcessingMs: 0,
      lastCheckAt: payload.watch?.lastCheckAt ?? null,
      nextCheckAt: payload.watch?.nextCheckAt ?? null,
      latestCheck: null
    },
    reviewFlights: flights.filter((flight) =>
      flight.reviewState === "promoted" || flight.reviewState === "retained"
    ),
    browseFlights: flights,
    recentChecks: [],
    activity: [],
    folders: []
  };
}

export function flightDetailsFromDashboardFlight(flight: FlightItem): FlightDetails {
  return {
    flight,
    observations: [{ ...flight.latest, id: `${flight.id}:latest`, checkId: flight.latest.providerSearchId }],
    relatedChecks: [],
    research: []
  };
}

function flightFromTripOffer(
  payload: TripDashboardPayload,
  offer: TripDashboardPayload["offers"][number],
  rank: number,
  selectedBy: ReadonlySet<"agent" | "person"> | undefined
): FlightItem {
  const rawSegments = Array.isArray(offer.snapshot.segments) ? offer.snapshot.segments : [];
  const segments = rawSegments.flatMap((candidate): ItinerarySegment[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const segment = candidate as Record<string, unknown>;
    return [{
      airlineCode: stringValue(segment.airlineCode),
      airline: stringValue(segment.airline) || stringValue(segment.airlineCode) || "Airline",
      flightNumber: stringValue(segment.flightNumber),
      origin: stringValue(segment.origin),
      destination: stringValue(segment.destination),
      departure: stringValue(segment.departure),
      arrival: stringValue(segment.arrival)
    }];
  });
  const first = segments[0];
  const last = segments.at(-1);
  const departureDate = first?.departure.slice(0, 10)
    || payload.trip.brief.legs?.[0]?.departureWindow.start
    || payload.trip.brief.departureWindow.start;
  const fallbackInstant = `${departureDate}T12:00:00.000Z`;
  const airlineCodes = stringArrayValue(offer.snapshot.airlineCodes);
  const flightNumbers = stringArrayValue(offer.snapshot.flightNumbers);
  const marketingAirlineCode = first?.airlineCode || airlineCodes[0] || "FL";
  const selectedByPerson = selectedBy?.has("person") ?? false;
  const selectedByAgent = selectedBy?.has("agent") ?? false;
  const snapshot: FlightSnapshot = {
    provider: "duffel",
    sourceName: "Duffel",
    sourceUrl: null,
    bookingUrl: null,
    evidence: "direct",
    providerOfferId: offer.providerOfferId,
    providerSearchId: offer.providerSearchId,
    observedAt: offer.observedAt,
    origin: first?.origin || payload.trip.brief.originAirports[0] || "",
    destination: last?.destination || payload.trip.brief.destinationAirports[0] || "",
    travelDate: departureDate,
    returnDate: dashboardReturnDate(payload.trip.brief),
    marketingAirlineCode,
    marketingAirline: first?.airline || marketingAirlineCode,
    flightNumber: flightNumbers.join(", ") || segments.map((segment) => segment.flightNumber).filter(Boolean).join(", "),
    route: stringValue(offer.snapshot.route)
      || [first?.origin, ...segments.map((segment) => segment.destination)].filter(Boolean).join(" → "),
    departure: first?.departure || fallbackInstant,
    arrival: last?.arrival || fallbackInstant,
    durationSeconds: numberValue(offer.snapshot.durationSeconds),
    stops: numberValue(offer.snapshot.stops),
    cabin: payload.trip.brief.cabin,
    price: offer.price,
    currency: offer.currency,
    rank: rank + 1,
    passengerCount: payload.trip.brief.travellers.adults
      + payload.trip.brief.travellers.childrenAges.length
      + payload.trip.brief.travellers.infants,
    segments,
    conditions: stringRecordValue(offer.snapshot.conditions)
  };
  return {
    id: offer.id,
    itineraryKey: offer.itineraryKey,
    destination: payload.trip.brief.destinationAirports.at(-1) ?? snapshot.destination,
    travelDate: departureDate,
    marketingAirlineCode,
    marketingAirline: snapshot.marketingAirline,
    reviewState: selectedByPerson ? "retained" : selectedByAgent ? "promoted" : "discovered",
    promotionReason: selectedByPerson
      ? "Selected by you"
      : selectedByAgent
        ? "Recommended by Captain"
        : null,
    firstSeenAt: offer.observedAt,
    lastSeenAt: offer.observedAt,
    latest: snapshot,
    previousPrice: null,
    changePercent: null,
    observationCount: 1,
    trackedUntilAt: null,
    folderIds: []
  };
}

function cadence(value: number | undefined): CadenceHours {
  return value === 1 || value === 6 || value === 12 || value === 24 ? value : 6;
}

function dashboardReturnDate(brief: FlightAgentBrief): string | null {
  if (brief.tripType !== "round_trip" || !brief.stayNights) return null;
  const date = new Date(`${brief.departureWindow.start}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + brief.stayNights.preferred);
  return date.toISOString().slice(0, 10);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function stringRecordValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function defaultBrief(now = new Date()): FlightAgentBrief {
  const start = addDays(now, 30);
  const end = addDays(now, 34);
  return {
    originAirports: ["LHR"],
    destinationAirports: ["JFK"],
    tripType: "round_trip",
    departureWindow: { start, end },
    stayNights: { minimum: 6, preferred: 7, maximum: 8 },
    travellers: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxStops: 1,
    currency: "GBP",
    maximumPrice: null,
    preferredAirlines: [],
    excludedAirlines: [],
    context: ""
  };
}

export function validateBrief(brief: FlightAgentBrief): string[] {
  const errors: string[] = [];
  const airports = [...brief.originAirports, ...brief.destinationAirports];
  if (brief.originAirports.length === 0) errors.push("Add at least one origin airport.");
  if (brief.destinationAirports.length === 0) errors.push("Add at least one destination airport.");
  if (airports.some((airport) => !/^[A-Z]{3}$/.test(airport))) errors.push("Use three-letter IATA airport codes.");
  const start = Date.parse(`${brief.departureWindow.start}T00:00:00Z`);
  const end = Date.parse(`${brief.departureWindow.end}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) errors.push("Choose a valid departure window.");
  if (end - start > 30 * 86_400_000) errors.push("Departure windows can span at most 31 days.");
  if (brief.tripType === "round_trip" && !brief.stayNights) errors.push("Add a stay length for a round trip.");
  if (brief.stayNights && !(brief.stayNights.minimum <= brief.stayNights.preferred && brief.stayNights.preferred <= brief.stayNights.maximum)) {
    errors.push("Stay length must be ordered minimum, preferred, maximum.");
  }
  if (brief.travellers.infants > brief.travellers.adults) errors.push("Each infant must travel with an adult.");
  return errors;
}

export function briefTitle(brief: FlightAgentBrief): string {
  return brief.destinationAirports.join(" + ");
}

export function briefSubtitle(brief: FlightAgentBrief): string {
  const dates = brief.departureWindow.start === brief.departureWindow.end
    ? formatDate(brief.departureWindow.start)
    : `${formatDate(brief.departureWindow.start)}–${formatDate(brief.departureWindow.end)}`;
  return `${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")} · ${dates}`;
}

export function formatDate(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00Z`)
    : new Date(value);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

export function formatCompactDateRange(start: string, end: string): string {
  const startDate = new Date(`${start}T12:00:00Z`);
  const endDate = new Date(`${end}T12:00:00Z`);
  const month = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  const sameYear = startDate.getUTCFullYear() === endDate.getUTCFullYear();
  const sameMonth = sameYear && startDate.getUTCMonth() === endDate.getUTCMonth();
  if (start === end) return `${month(startDate)} ${startDate.getUTCDate()}`;
  if (sameMonth) return `${month(startDate)} ${startDate.getUTCDate()} – ${endDate.getUTCDate()}`;
  if (sameYear) return `${month(startDate)} ${startDate.getUTCDate()} – ${month(endDate)} ${endDate.getUTCDate()}`;
  return `${month(startDate)} ${startDate.getUTCDate()}, ${startDate.getUTCFullYear()} – ${month(endDate)} ${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function currentProcessingTimeMs(agent: FlightAgent, now = Date.now()): number {
  const processingStartedAt = agent.processingStartedAt ? Date.parse(agent.processingStartedAt) : Number.NaN;
  const running = Number.isFinite(processingStartedAt) ? Math.max(0, now - processingStartedAt) : 0;
  const accumulated = Number.isFinite(agent.accumulatedProcessingMs) ? Math.max(0, agent.accumulatedProcessingMs) : 0;
  return accumulated + running;
}

export function formatProcessingTime(ms: number): string {
  const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const totalMinutes = Math.floor(safeMs / 60_000);
  if (totalMinutes < 1) return `${Math.floor(safeMs / 1_000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function departurePeriod(value: string): "morning" | "afternoon" | "evening" {
  const hour = new Date(value).getHours();
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

export function sortAndFilterFlights(
  flights: readonly FlightItem[],
  preferences: BrowsePreferences
): FlightItem[] {
  const filtered = flights.filter((flight) => {
    if (preferences.stops.length > 0 && !preferences.stops.includes(flight.latest.stops)) return false;
    if (preferences.airlines.length > 0 && !preferences.airlines.includes(flight.marketingAirline)) return false;
    if (preferences.airports.length > 0 && !preferences.airports.some((airport) => airport === flight.latest.origin || airport === flight.destination)) return false;
    if (preferences.cabins.length > 0 && !preferences.cabins.includes(flight.latest.cabin)) return false;
    if (preferences.maximumPrice !== null && flight.latest.price > preferences.maximumPrice) return false;
    if (preferences.departurePeriods.length > 0 && !preferences.departurePeriods.includes(departurePeriod(flight.latest.departure))) return false;
    return true;
  });
  return [...filtered].sort((left, right) => {
    if (preferences.sort === "price") return left.latest.price - right.latest.price || left.latest.rank - right.latest.rank;
    if (preferences.sort === "duration") return left.latest.durationSeconds - right.latest.durationSeconds || left.latest.rank - right.latest.rank;
    if (preferences.sort === "departure") return Date.parse(left.latest.departure) - Date.parse(right.latest.departure) || left.latest.rank - right.latest.rank;
    return left.latest.rank - right.latest.rank || left.latest.price - right.latest.price;
  });
}

function addDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
