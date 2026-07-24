import {
  DEFAULT_CADENCE_HOURS,
  EMPTY_TRIP_PLAN_PARTIAL,
  addIsoDays,
  buildSearchSpecs,
  createTripSchema,
  daysBetween,
  resolveTripDateIntent,
  totalTravellers,
  type Trip,
  type TripCreationReceipt,
  type TripPlanDraft,
  type TripPlanPartial,
  type TripPlanResult
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

import type { TripService } from "../trips/service.js";
import {
  createTripFactExtractor,
  type TripFactExtraction,
  type TripFactExtractor
} from "./extractor.js";
import {
  formatActiveTripLocation,
  formatTripCreationReceipt,
  formatTripPlanConfirmation
} from "./format.js";

const CONFIRM_PATTERN = /^(?:yes|y|confirm|confirmed|create(?:\s+it)?|start(?:\s+it)?|looks?\s+good|go\s+ahead)[.! ]*$/iu;
const CANCEL_PATTERN = /^(?:no|cancel|never\s*mind|stop)[.! ]*$/iu;
const WHERE_PATTERN = /^(?:where|where is it|where(?:'s| is) (?:the|my) trip)[?!. ]*$/iu;
const CREATION_SUCCESS_PATTERNS = [
  /\b(?:your|the|that)\b[\s\S]{0,100}\btrip\b[\s\S]{0,200}\b(?:has\s+been|was|is\s+now)\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b/iu,
  /\b(?:your|the|that)\b[\s\S]{0,100}\btrip\b\s+is\s+(?:successfully\s+)?(?:created|saved|set\s+up)\b/iu,
  /\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have))\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b[\s\S]{0,180}\btrip\b/iu,
  /\btrip\b\s+(?:has\s+been|was)\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b/iu
] as const;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const UNGROUNDED_CREATION_MESSAGE = "I couldn’t verify a Trip-creation receipt. Send /trips to check your Trips.";

export class TripPlanningService {
  readonly #store: CaptainPlatformStore;
  readonly #trips: TripService;
  readonly #extract: TripFactExtractor;
  readonly #liveMode: boolean;
  readonly #now: () => Date;
  readonly #dashboardUrlForTrip: (userId: string, tripId: string) => string;

  constructor(options: {
    store: CaptainPlatformStore;
    trips: TripService;
    liveMode: boolean;
    extract?: TripFactExtractor;
    model?: string;
    apiKey?: string | null;
    now?: () => Date;
    dashboardUrlForTrip?: (userId: string, tripId: string) => string;
  }) {
    this.#store = options.store;
    this.#trips = options.trips;
    this.#liveMode = options.liveMode;
    this.#extract = options.extract ?? createTripFactExtractor({
      apiKey: options.apiKey ?? null,
      model: options.model ?? "openai/gpt-5.6-terra"
    });
    this.#now = options.now ?? (() => new Date());
    this.#dashboardUrlForTrip = options.dashboardUrlForTrip
      ?? ((_userId, tripId) => `http://127.0.0.1/trips/${encodeURIComponent(tripId)}`);
  }

  async prepare(
    userId: string,
    request: string,
    sourceMessageId: string | null = null,
    draftId?: string
  ): Promise<TripPlanResult> {
    const now = this.#now();
    let draft = draftId
      ? await this.#store.getTripPlanDraft(userId, draftId, now)
      : await this.#store.findOpenTripPlanDraft(userId, now);
    if (!draft || !["collecting", "awaiting_confirmation"].includes(draft.status)) {
      draft = await this.#store.createTripPlanDraft(userId, request, sourceMessageId, now);
    }
    const conversation = draft.conversation.at(-1) === request.trim()
      ? draft.conversation
      : [...draft.conversation, request.trim()].slice(-40);
    const sourceMessageIds = sourceMessageId && !draft.sourceMessageIds.includes(sourceMessageId)
      ? [...draft.sourceMessageIds, sourceMessageId].slice(-40)
      : draft.sourceMessageIds;
    const facts = await this.#extract({
      request,
      conversation,
      prior: draft.partial,
      now
    });
    const partial = mergePartial(draft.partial, facts);
    const currentDates = resolveTripDateIntent(request, now);
    const combinedDates = !currentDates.issue
      && !currentDates.departureDate
      && !currentDates.returnDate
      ? resolveTripDateIntent(conversation.join("\n"), now)
      : currentDates;
    if (partial.tripType === "multi_city") {
      if (combinedDates.departureDate && partial.legs[0]) {
        partial.legs[0].departureDate = combinedDates.departureDate;
      }
      if (combinedDates.returnDate && partial.legs.at(-1)) {
        partial.legs.at(-1)!.departureDate = combinedDates.returnDate;
      }
      partial.departureDate = partial.legs[0]?.departureDate ?? null;
      partial.returnDate = null;
    } else {
      if (combinedDates.departureDate) partial.departureDate = combinedDates.departureDate;
      if (combinedDates.returnDate) partial.returnDate = combinedDates.returnDate;
      if (partial.returnDate) partial.tripType = "round_trip";
      if (partial.tripType === "one_way") partial.returnDate = null;
    }

    const dateIssue = validateMergedDates(partial, combinedDates.issue, now);
    const inferredFields = inferDefaults(partial, facts, draft.inferredFields);
    applyDefaults(partial);
    const missingFields = missingTripFields(partial, dateIssue);
    const plan = missingFields.length === 0 ? completePlan(partial, draft.id) : null;
    const revised = await this.#store.reviseTripPlanDraft(
      userId,
      draft.id,
      draft.revision,
      {
        status: plan ? "awaiting_confirmation" : "collecting",
        conversation,
        partial,
        plan,
        unresolvedFields: missingFields,
        inferredFields,
        sourceMessageIds
      },
      now
    );
    if (!revised) throw new Error("Trip draft changed while it was being prepared");
    console.info(JSON.stringify({
      event: "captain.trip_plan_prepared",
      draft_id: revised.id,
      revision: revised.revision,
      status: revised.status,
      missing_fields: missingFields,
      date_conflict: Boolean(dateIssue)
    }));
    if (!plan) {
      return {
        status: "needs_input",
        draft: revised,
        prompt: dateIssue ?? clarificationPrompt(missingFields),
        missingFields
      };
    }
    return {
      status: "awaiting_confirmation",
      draft: revised,
      confirmation: formatTripPlanConfirmation(revised)
    };
  }

  async confirm(userId: string, draftId: string, expectedRevision: number): Promise<TripPlanResult> {
    const now = this.#now();
    const draft = await this.#store.getTripPlanDraft(userId, draftId, now);
    if (!draft?.plan) throw new Error("Trip draft is incomplete or expired");
    const specs = buildSearchSpecs(draft.plan.input.brief, this.#liveMode);
    let confirmed;
    try {
      confirmed = await this.#store.confirmTripPlanDraft(
        userId,
        draftId,
        expectedRevision,
        specs,
        now
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "captain.trip_plan_creation_failed",
        draft_id: draftId,
        revision: expectedRevision,
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      throw error;
    }
    if (!confirmed) throw new Error("Trip draft is stale; review the latest confirmation");
    const receipt = buildReceipt(
      confirmed.draft,
      confirmed.result.trip,
      confirmed.result.created,
      this.dashboardUrlForTrip(userId, confirmed.result.trip.id)
    );
    console.info(JSON.stringify({
      event: "captain.trip_plan_confirmed",
      draft_id: confirmed.draft.id,
      trip_id: receipt.tripId,
      created: receipt.created,
      search_combinations: specs.length
    }));
    return {
      status: "started",
      draft: confirmed.draft,
      receipt,
      message: formatTripCreationReceipt(receipt)
    };
  }

  async cancel(userId: string, draftId: string, expectedRevision: number): Promise<TripPlanResult> {
    const draft = await this.#store.cancelTripPlanDraft(
      userId,
      draftId,
      expectedRevision,
      this.#now()
    );
    if (!draft) throw new Error("Trip draft is stale or expired");
    return { status: "cancelled", draft, message: "Okay—the Trip draft was cancelled." };
  }

  async reopen(userId: string, draftId: string, expectedRevision: number): Promise<TripPlanDraft> {
    const draft = await this.#store.reopenTripPlanDraft(
      userId,
      draftId,
      expectedRevision,
      this.#now()
    );
    if (!draft) throw new Error("Trip draft is stale or expired");
    return draft;
  }

  findOpen(userId: string): Promise<TripPlanDraft | null> {
    return this.#store.findOpenTripPlanDraft(userId, this.#now());
  }

  dashboardUrlForTrip(userId: string, tripId: string): string {
    return this.#dashboardUrlForTrip(userId, tripId);
  }

  async activeTripLocation(userId: string): Promise<string | null> {
    const conversation = await this.#store.getConversation(userId, 0);
    if (!conversation.activeTripId) return null;
    const trip = await this.#trips.get(userId, conversation.activeTripId);
    return trip ? formatActiveTripLocation({
      title: trip.title,
      tripId: trip.id,
      originAirports: trip.brief.originAirports,
      destinationAirports: trip.brief.destinationAirports,
      dashboardUrl: this.dashboardUrlForTrip(userId, trip.id)
    }) : null;
  }

  async groundAssistantMessage(userId: string, message: string): Promise<string> {
    if (!CREATION_SUCCESS_PATTERNS.some((pattern) => pattern.test(message))) return message;
    const tripId = UUID_PATTERN.exec(message)?.[0] ?? null;
    const trip = tripId ? await this.#trips.get(userId, tripId) : null;
    if (!trip) return UNGROUNDED_CREATION_MESSAGE;
    const departureDate = trip.brief.departureWindow.start;
    const returnDate = trip.brief.tripType === "round_trip" && trip.brief.stayNights
      ? addIsoDays(departureDate, trip.brief.stayNights.preferred)
      : null;
    const validMessages = [true, false].map((created) =>
      formatTripCreationReceipt(buildReceiptFromTrip(
        trip,
        created,
        departureDate,
        returnDate,
        this.dashboardUrlForTrip(userId, trip.id)
      ))
    );
    return validMessages.includes(message.trim()) ? message : UNGROUNDED_CREATION_MESSAGE;
  }

  async handleOpenDraftText(
    userId: string,
    request: string,
    sourceMessageId: string | null
  ): Promise<TripPlanResult | null> {
    const draft = await this.findOpen(userId);
    if (!draft) return null;
    if (draft.status === "awaiting_confirmation" && CONFIRM_PATTERN.test(request.trim())) {
      return this.confirm(userId, draft.id, draft.revision);
    }
    if (CANCEL_PATTERN.test(request.trim())) {
      return this.cancel(userId, draft.id, draft.revision);
    }
    return this.prepare(userId, request, sourceMessageId, draft.id);
  }

  static isTripPlanningRequest(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    const travel = /\b(?:flight|flights|trip|travel|fly|flying|journey)\b/iu.test(normalized);
    const action = /\b(?:plan|start|create|set\s*up|track|search|find|book|want|need|compare|options?|best|cheapest)\b/iu.test(normalized);
    return travel && action;
  }

  static isWhereQuestion(text: string): boolean {
    return WHERE_PATTERN.test(text.trim());
  }
}

function mergePartial(prior: TripPlanPartial, facts: TripFactExtraction): TripPlanPartial {
  const legs = facts.legs.length > 0
    ? facts.legs.map((leg, index) => ({
        ...leg,
        departureDate: prior.legs[index]?.departureDate ?? null
      }))
    : prior.legs;
  return {
    originAirports: facts.originAirports.length > 0 ? facts.originAirports : prior.originAirports,
    destinationAirports: facts.destinationAirports.length > 0 ? facts.destinationAirports : prior.destinationAirports,
    tripType: facts.tripType ?? prior.tripType,
    legs,
    departureDate: prior.departureDate,
    returnDate: prior.returnDate,
    travellers: facts.travellers ?? prior.travellers,
    cabin: facts.cabin ?? prior.cabin,
    maxStops: facts.maxStops ?? prior.maxStops,
    currency: facts.currency ?? prior.currency,
    maximumPrice: facts.maximumPrice ?? prior.maximumPrice,
    preferredAirlines: facts.preferredAirlines.length > 0 ? facts.preferredAirlines : prior.preferredAirlines,
    excludedAirlines: facts.excludedAirlines.length > 0 ? facts.excludedAirlines : prior.excludedAirlines
  };
}

function inferDefaults(
  partial: TripPlanPartial,
  facts: TripFactExtraction,
  previous: Record<string, string>
): Record<string, string> {
  const inferred = { ...previous };
  if (facts.travellers) delete inferred.travellers;
  else if (!partial.travellers) inferred.travellers = "default — one adult";
  if (facts.cabin) delete inferred.cabin;
  else if (!partial.cabin) inferred.cabin = "default — economy";
  if (facts.maxStops !== null) delete inferred.maxStops;
  else if (partial.maxStops === null) inferred.maxStops = "default — at most one stop";
  if (facts.currency) delete inferred.currency;
  else if (!partial.currency && localCurrency(partial.originAirports[0] ?? null)) {
    inferred.currency = `default — local currency for ${partial.originAirports[0]}`;
  }
  inferred.cadenceHours = "default — every six hours";
  if (partial.destinationAirports.includes("NYC")) {
    inferred.destinationAirports = "New York metropolitan area";
  }
  return inferred;
}

function applyDefaults(partial: TripPlanPartial): void {
  partial.travellers ??= { adults: 1, childrenAges: [], infants: 0 };
  partial.cabin ??= "economy";
  partial.maxStops ??= 1;
  partial.currency ??= localCurrency(partial.originAirports[0] ?? null);
}

function missingTripFields(partial: TripPlanPartial, dateIssue: string | null): string[] {
  if (dateIssue) return ["dates"];
  if (partial.tripType === "multi_city") {
    return [
      ...(partial.originAirports.length === 0 ? ["originAirports"] : []),
      ...(partial.destinationAirports.length === 0 ? ["destinationAirports"] : []),
      ...(partial.legs.length < 2 || partial.legs.some((leg) => !leg.departureDate)
        ? ["itineraryLegs"]
        : []),
      ...(!partial.travellers ? ["travellers"] : []),
      ...(!partial.currency ? ["currency"] : [])
    ];
  }
  return [
    ...(partial.originAirports.length === 0 ? ["originAirports"] : []),
    ...(partial.destinationAirports.length === 0 ? ["destinationAirports"] : []),
    ...(!partial.departureDate ? ["departureDate"] : []),
    ...(!partial.tripType ? ["tripType"] : []),
    ...(partial.tripType === "round_trip" && !partial.returnDate ? ["returnDate"] : []),
    ...(!partial.travellers ? ["travellers"] : []),
    ...(!partial.currency ? ["currency"] : [])
  ];
}

function validateMergedDates(
  partial: TripPlanPartial,
  currentIssue: string | null,
  now: Date
): string | null {
  if (currentIssue) return currentIssue;
  const today = now.toISOString().slice(0, 10);
  if (partial.departureDate && daysBetween(today, partial.departureDate) < 0) {
    return "The departure date is in the past. What future departure date should I use?";
  }
  if (
    partial.departureDate
    && partial.returnDate
    && daysBetween(partial.departureDate, partial.returnDate) <= 0
  ) {
    return "The return date must be after the departure date. Which return date should I use?";
  }
  if (partial.tripType === "multi_city") {
    for (let index = 1; index < partial.legs.length; index += 1) {
      const previous = partial.legs[index - 1]!.departureDate;
      const current = partial.legs[index]!.departureDate;
      if (previous && current && daysBetween(previous, current) < 0) {
        return "Multi-city leg dates must be in order. Which dates should I use?";
      }
    }
  }
  return null;
}

function completePlan(partial: TripPlanPartial, draftId: string): TripPlanDraft["plan"] {
  if (
    !partial.departureDate
    || !partial.tripType
    || !partial.travellers
    || !partial.cabin
    || partial.maxStops === null
    || !partial.currency
  ) {
    throw new Error("Cannot complete a Trip with unresolved fields");
  }
  const stayNights = partial.tripType === "round_trip" && partial.returnDate
    ? daysBetween(partial.departureDate, partial.returnDate)
    : null;
  const input = createTripSchema.parse({
    title: partial.tripType === "multi_city"
      ? [
          partial.legs[0]!.originAirports.join("/"),
          ...partial.legs.map((leg) => leg.destinationAirports.join("/"))
        ].join(" to ")
      : `${partial.originAirports.join("/")} to ${partial.destinationAirports.join("/")}`,
    brief: {
      originAirports: partial.originAirports,
      destinationAirports: partial.destinationAirports,
      tripType: partial.tripType,
      departureWindow: { start: partial.departureDate, end: partial.departureDate },
      stayNights: stayNights
        ? { minimum: stayNights, preferred: stayNights, maximum: stayNights }
        : null,
      legs: partial.tripType === "multi_city"
        ? partial.legs.map((leg) => ({
            originAirports: leg.originAirports,
            destinationAirports: leg.destinationAirports,
            departureWindow: {
              start: leg.departureDate!,
              end: leg.departureDate!
            }
          }))
        : undefined,
      travellers: partial.travellers,
      cabin: partial.cabin,
      maxStops: partial.maxStops,
      currency: partial.currency,
      maximumPrice: partial.maximumPrice,
      preferredAirlines: partial.preferredAirlines,
      excludedAirlines: partial.excludedAirlines,
      context: `Prepared from confirmed Captain Trip draft ${draftId}`
    },
    cadenceHours: DEFAULT_CADENCE_HOURS
  });
  return {
    input,
    departureDate: partial.departureDate,
    returnDate: partial.tripType === "round_trip" ? partial.returnDate : null
  };
}

function clarificationPrompt(missingFields: string[]): string {
  const missing = new Set(missingFields);
  if (missing.has("originAirports") && missing.has("travellers")) {
    return "Where are you flying from, and how many people will be travelling?";
  }
  if (missing.has("originAirports")) return "Where are you flying from?";
  if (missing.has("destinationAirports")) return "Where would you like to fly to?";
  if (missing.has("departureDate")) return "What date would you like to depart?";
  if (missing.has("tripType")) return "Is this one-way or a return Trip?";
  if (missing.has("returnDate")) return "What date would you like to return?";
  if (missing.has("itineraryLegs")) {
    return "What city and departure date should I use for each leg of the trip?";
  }
  if (missing.has("travellers")) return "How many people will be travelling?";
  if (missing.has("currency")) return "Which currency should I use for prices?";
  return "What should I add to the Trip?";
}

function localCurrency(origin: string | null): string | null {
  if (origin === "LOS" || origin === "ABV") return "NGN";
  if (origin === "LHR" || origin === "LGW" || origin === "LON") return "GBP";
  if (origin === "NYC" || origin === "JFK" || origin === "EWR" || origin === "LGA") return "USD";
  if (origin === "NBO") return "KES";
  return null;
}

function buildReceipt(
  draft: TripPlanDraft,
  trip: Trip,
  created: boolean,
  dashboardUrl: string
): TripCreationReceipt {
  if (!draft.plan) throw new Error("Started Trip is missing its persisted plan");
  return buildReceiptFromTrip(
    trip,
    created,
    draft.plan.departureDate,
    draft.plan.returnDate,
    dashboardUrl
  );
}

function buildReceiptFromTrip(
  trip: Trip,
  created: boolean,
  departureDate: string,
  returnDate: string | null,
  dashboardUrl: string
): TripCreationReceipt {
  return {
    tripId: trip.id,
    created,
    status: trip.status,
    title: trip.title,
    originAirports: trip.brief.originAirports,
    destinationAirports: trip.brief.destinationAirports,
    legs: trip.brief.legs?.map((leg) => ({
      originAirports: leg.originAirports,
      destinationAirports: leg.destinationAirports,
      departureDate: leg.departureWindow.start
    })),
    departureDate,
    returnDate,
    stayNights: trip.brief.stayNights?.preferred ?? null,
    travellers: totalTravellers(trip.brief.travellers),
    cabin: trip.brief.cabin,
    maxStops: trip.brief.maxStops,
    currency: trip.brief.currency,
    dashboardUrl,
    accessHint: "Send /trips to view your saved Trips."
  };
}

export function defaultTripPlanPartial(): TripPlanPartial {
  return structuredClone(EMPTY_TRIP_PLAN_PARTIAL);
}
