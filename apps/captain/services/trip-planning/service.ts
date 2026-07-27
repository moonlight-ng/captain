import {
  DEFAULT_CADENCE_HOURS,
  EMPTY_TRIP_PLAN_PARTIAL,
  EMPTY_TRIP_PLAN_TURN_STATE,
  MAX_ACTIVE_TRIPS_PER_USER,
  addIsoDays,
  buildSearchSpecs,
  createTripSchema,
  daysBetween,
  formatCalendarDate,
  stableJson,
  totalTravellers,
  type Trip,
  type TripCreationReceipt,
  type TripPlanDraft,
  type TripPlanPartial,
  type TripPlanPendingField,
  type TripPlanResult
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

import type { TripService } from "../trips/service.js";
import {
  canonicalizeTripPartial,
  reduceTripDraft,
  synchronizeDerivedFields
} from "./draft-reducer.js";
import {
  formatActiveTripList,
  formatActiveTripLocation,
  formatTripCreationReceipt,
  formatTripPlanConfirmation
} from "./format.js";
import { suggestedTripCurrency } from "./currency.js";
import { orderedAirportCodesFromText } from "./airport-catalog.js";
import {
  createTripTurnInterpreter,
  type InterpretedTripTurn,
  type TripTurnInterpreter
} from "./turn-interpreter.js";

const CONFIRM_PATTERN = /^(?:yes|y|confirm|confirmed|create(?:\s+it)?|start(?:\s+it)?|looks?\s+good|go\s+ahead)[.! ]*$/iu;
const CANCEL_PATTERN = /^(?:no|cancel|never\s*mind|stop)[.! ]*$/iu;
const NEW_DRAFT_PATTERN = /\b(?:another|a new|new|different)\s+(?:flight|trip|journey)\b/iu;
const FRESH_TRIP_DIRECTIVE_PATTERN = /^\s*(?:(?:let(?:'|’)s|please)\s+|i\s+(?:want|need|would\s+like)\s+to\s+|(?:can|could|would)\s+you\s+)?(?:track|start|create|plan|set\s*up|find|search(?:\s+for)?)\s+(?:(?:me|us)\s+)?(?:a\s+|the\s+|my\s+)?(?:flight|trip|journey)\b/iu;
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
  readonly #interpret: TripTurnInterpreter;
  readonly #now: () => Date;
  readonly #dashboardUrlForTrip: (userId: string, tripId: string) => string | Promise<string>;

  constructor(options: {
    store: CaptainPlatformStore;
    trips: TripService;
    interpret?: TripTurnInterpreter;
    model?: string;
    apiKey?: string | null;
    now?: () => Date;
    dashboardUrlForTrip?: (userId: string, tripId: string) => string | Promise<string>;
  }) {
    this.#store = options.store;
    this.#trips = options.trips;
    this.#interpret = options.interpret ?? createTripTurnInterpreter({
      apiKey: options.apiKey ?? null,
      model: options.model ?? "openai/gpt-5.6-luna"
    });
    this.#now = options.now ?? (() => new Date());
    this.#dashboardUrlForTrip = options.dashboardUrlForTrip
      ?? (async (_userId, tripId) => `http://127.0.0.1/#trip/${encodeURIComponent(tripId)}`);
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
    const priorTurnState = draft.turnState.pendingFields.length === 0
      && draft.unresolvedFields.length > 0
      ? {
          ...draft.turnState,
          pendingFields: pendingFieldsFor(draft.partial, draft.unresolvedFields)
        }
      : draft.turnState;
    const user = await this.#store.getUser(userId);
    const timeZone = user?.timezone ?? "UTC";
    const initialTurn = await this.#interpret({
      request,
      conversation,
      prior: canonicalizeTripPartial(draft.partial),
      turnState: priorTurnState,
      now,
      timeZone
    });
    const turn = initialTurn.intent === "repair"
      ? await this.#repairTurn({
          request: repairSource(conversation),
          conversation,
          prior: canonicalizeTripPartial(draft.partial),
          now,
          timeZone
        })
      : initialTurn;
    const unsupportedParty = Boolean(
      turn.travellers
      && (
        turn.travellers.adults !== 1
        || turn.travellers.childrenAges.length > 0
        || turn.travellers.infants !== 0
      )
    );
    const beforeHash = stableJson(canonicalizeTripPartial(draft.partial));
    const reduced = reduceTripDraft({
      prior: draft.partial,
      turnState: priorTurnState,
      turn,
      messageIndex: conversation.length - 1
    });
    const partial = reduced.partial;
    const dateIssue = validateMergedDates(partial, turn.dateIssue, now, timeZone);
    const profile = await this.#store.ensureProfile(userId, now);
    const suggestedCurrency = suggestedTripCurrency(partial, profile.defaultCurrency);
    const inferredFields = inferDefaults(partial, turn, draft.inferredFields, suggestedCurrency);
    applyDefaults(partial, suggestedCurrency);
    synchronizeDerivedFields(partial);
    const fieldSources = { ...reduced.fieldSources };
    for (const [field, description] of Object.entries(inferredFields)) {
      fieldSources[field] ??= {
        kind: field === "currency" || field === "destinationAirports" ? "inferred" : "default",
        messageIndex: conversation.length - 1,
        text: description.slice(0, 500)
      };
    }
    if (unsupportedParty) partial.travellers = null;
    const missingFields = missingTripFields(partial, dateIssue);
    const plan = missingFields.length === 0 ? completePlan(partial, draft.id) : null;
    const activeTrips = plan
      ? (await this.#store.listTrips(userId)).filter((trip) =>
          !["cancelled", "completed", "archived"].includes(trip.status)
        )
      : [];
    const tripLimitReached = Boolean(
      plan
      && activeTrips.length >= MAX_ACTIVE_TRIPS_PER_USER
      && !activeTrips.some((trip) => stableJson(trip.brief) === stableJson(plan.input.brief))
    );
    const basePrompt = !plan || tripLimitReached
      ? tripLimitReached
        ? "You’re already tracking three Trips. Open /preferences, stop tracking one Trip, then reply “continue” here."
        : unsupportedParty
          ? "Captain’s beta currently tracks fares for exactly one adult. Reply “just me” to continue, or cancel this Trip."
          : dateIssue ?? clarificationPrompt(missingFields)
      : null;
    const repeatedPromptCount = basePrompt && priorTurnState.lastPrompt === basePrompt
      ? priorTurnState.repeatedPromptCount + 1
      : 0;
    const responsePrompt = basePrompt && repeatedPromptCount > 0
      ? repairClarification(partial, missingFields, basePrompt, repeatedPromptCount)
      : basePrompt;
    const turnState = {
      version: 2 as const,
      pendingFields: plan && !tripLimitReached ? [] : pendingFieldsFor(partial, missingFields),
      lastPrompt: basePrompt,
      repeatedPromptCount,
      fieldSources,
      interpreterVersion: "trip_interpreter_v2" as const,
      parser: turn.parser,
      model: turn.model,
      lastIntent: turn.intent,
      lastOperations: reduced.operations
    };
    const revised = await this.#store.reviseTripPlanDraft(
      userId,
      draft.id,
      draft.revision,
      {
        status: plan && !tripLimitReached ? "awaiting_confirmation" : "collecting",
        conversation,
        partial,
        plan,
        unresolvedFields: missingFields,
        inferredFields,
        turnState,
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
      date_conflict: Boolean(dateIssue),
      parser: turn.parser,
      interpreter_model: turn.model,
      turn_intent: turn.intent,
      accepted_operations: reduced.operations.filter((operation) => operation.action !== "reject").length,
      rejected_operations: reduced.operations.filter((operation) => operation.action === "reject").length,
      before_hash: beforeHash,
      after_hash: stableJson(partial),
      repeated_prompt_count: repeatedPromptCount
    }));
    if (!plan || tripLimitReached) {
      return {
        status: "needs_input",
        draft: revised,
        prompt: responsePrompt!,
        missingFields
      };
    }
    return {
      status: "awaiting_confirmation",
      draft: revised,
      confirmation: formatTripPlanConfirmation(revised)
    };
  }

  async #repairTurn(input: {
    request: string;
    conversation: string[];
    prior: TripPlanPartial;
    now: Date;
    timeZone: string;
  }): Promise<InterpretedTripTurn> {
    const repaired = await this.#interpret({
      request: input.request,
      conversation: input.conversation,
      prior: input.prior,
      turnState: structuredClone(EMPTY_TRIP_PLAN_TURN_STATE),
      now: input.now,
      timeZone: input.timeZone
    });
    return { ...repaired, intent: "repair", parser: "repair" };
  }

  async confirm(userId: string, draftId: string, expectedRevision: number): Promise<TripPlanResult> {
    const now = this.#now();
    const draft = await this.#store.getTripPlanDraft(userId, draftId, now);
    if (!draft?.plan) throw new Error("Trip draft is incomplete or expired");
    const specs = buildSearchSpecs(draft.plan.input.brief);
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
      await this.dashboardUrlForTrip(userId, confirmed.result.trip.id)
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

  dashboardUrlForTrip(userId: string, tripId: string): Promise<string> {
    return Promise.resolve(this.#dashboardUrlForTrip(userId, tripId));
  }

  async activeTripLocation(userId: string): Promise<string | null> {
    const conversation = await this.#store.getConversation(userId, 0);
    const selected = conversation.activeTripId
      ? await this.#trips.get(userId, conversation.activeTripId)
      : null;
    const trip = selected && !["cancelled", "completed", "archived"].includes(selected.status)
      ? selected
      : (await this.#trips.list(userId)).find((candidate) =>
          !["cancelled", "completed", "archived"].includes(candidate.status)
        ) ?? null;
    if (!trip) return null;
    const departureDate = trip.brief.departureWindow.start;
    const returnDate = trip.brief.tripType === "round_trip" && trip.brief.stayNights
      ? addIsoDays(departureDate, trip.brief.stayNights.preferred)
      : null;
    return formatActiveTripLocation({
      originAirports: trip.brief.originAirports,
      destinationAirports: trip.brief.destinationAirports,
      ...(trip.brief.legs ? {
        legs: trip.brief.legs.map((leg) => ({
          originAirports: leg.originAirports,
          destinationAirports: leg.destinationAirports,
          departureDate: leg.departureWindow.start
        }))
      } : {}),
      departureDate,
      returnDate,
      stayNights: trip.brief.stayNights?.preferred ?? null,
      travellers: totalTravellers(trip.brief.travellers),
      cabin: trip.brief.cabin,
      maxStops: trip.brief.maxStops,
      currency: trip.brief.currency,
      status: trip.status,
      dashboardUrl: await this.dashboardUrlForTrip(userId, trip.id)
    });
  }

  async activeTripsLocation(userId: string): Promise<string | null> {
    const trips = (await this.#trips.list(userId)).filter((trip) =>
      !["cancelled", "completed", "archived"].includes(trip.status)
    );
    if (trips.length === 0) return null;
    if (trips.length === 1) return this.activeTripLocation(userId);
    const inputs = await Promise.all(trips.map(async (trip) => {
      const departureDate = trip.brief.departureWindow.start;
      return {
        originAirports: trip.brief.originAirports,
        destinationAirports: trip.brief.destinationAirports,
        ...(trip.brief.legs ? {
          legs: trip.brief.legs.map((leg) => ({
            originAirports: leg.originAirports,
            destinationAirports: leg.destinationAirports,
            departureDate: leg.departureWindow.start
          }))
        } : {}),
        departureDate,
        returnDate: trip.brief.tripType === "round_trip" && trip.brief.stayNights
          ? addIsoDays(departureDate, trip.brief.stayNights.preferred)
          : null,
        stayNights: trip.brief.stayNights?.preferred ?? null,
        travellers: totalTravellers(trip.brief.travellers),
        cabin: trip.brief.cabin,
        maxStops: trip.brief.maxStops,
        currency: trip.brief.currency,
        status: trip.status,
        dashboardUrl: await this.dashboardUrlForTrip(userId, trip.id)
      };
    }));
    return formatActiveTripList(inputs);
  }

  async groundAssistantMessage(userId: string, message: string): Promise<string> {
    if (!CREATION_SUCCESS_PATTERNS.some((pattern) => pattern.test(message))) return message;
    const tripId = UUID_PATTERN.exec(message)?.[0] ?? null;
    const trip = tripId
      ? await this.#trips.get(userId, tripId)
      : await this.#store.getActiveTrip(userId);
    if (!trip) return UNGROUNDED_CREATION_MESSAGE;
    const departureDate = trip.brief.departureWindow.start;
    const returnDate = trip.brief.tripType === "round_trip" && trip.brief.stayNights
      ? addIsoDays(departureDate, trip.brief.stayNights.preferred)
      : null;
    const dashboardUrl = await this.dashboardUrlForTrip(userId, trip.id);
    const validMessages = [true, false].map((created) =>
      formatTripCreationReceipt(buildReceiptFromTrip(
        trip,
        created,
        departureDate,
        returnDate,
        dashboardUrl
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
    if (
      (NEW_DRAFT_PATTERN.test(request) || FRESH_TRIP_DIRECTIVE_PATTERN.test(request))
      && TripPlanningService.isTripPlanningRequest(request)
    ) {
      await this.cancel(userId, draft.id, draft.revision);
      return this.prepare(userId, request, sourceMessageId);
    }
    if (
      !TripPlanningService.isTripPlanningRequest(request)
      && !looksLikeDraftContinuation(draft, request)
    ) {
      return null;
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

function inferDefaults(
  partial: TripPlanPartial,
  facts: InterpretedTripTurn,
  previous: Record<string, string>,
  suggestedCurrency: string
): Record<string, string> {
  const inferred = { ...previous };
  if (facts.travellers) delete inferred.travellers;
  else if (!partial.travellers) inferred.travellers = "default — one adult";
  if (facts.cabin) delete inferred.cabin;
  else if (!partial.cabin) inferred.cabin = "default — economy";
  if (facts.maxStops !== null) delete inferred.maxStops;
  else if (partial.maxStops === null) inferred.maxStops = "default — at most one stop";
  if (/\bone[ -]?way\b/iu.test(facts.sourceText)) delete inferred.tripType;
  else if (partial.tripType === "one_way" && partial.legs.length <= 1) {
    inferred.tripType = "default — one-way";
  } else delete inferred.tripType;
  if (facts.currency) delete inferred.currency;
  else if (!partial.currency) {
    inferred.currency = `suggested for this route — ${suggestedCurrency}`;
  }
  inferred.cadenceHours = "adaptive — every 3, 6, or 12 hours";
  if (partial.destinationAirports.includes("NYC")) {
    inferred.destinationAirports = "New York metropolitan area";
  } else delete inferred.destinationAirports;
  return inferred;
}

function applyDefaults(partial: TripPlanPartial, suggestedCurrency: string): void {
  partial.tripType ??= "one_way";
  partial.travellers ??= { adults: 1, childrenAges: [], infants: 0 };
  partial.cabin ??= "economy";
  partial.maxStops ??= 1;
  partial.currency ??= suggestedCurrency;
}

function missingTripFields(partial: TripPlanPartial, dateIssue: string | null): string[] {
  if (dateIssue) return ["dates"];
  if (partial.tripType === "multi_city") {
    return [
      ...(partial.originAirports.length === 0 ? ["originAirports"] : []),
      ...(partial.destinationAirports.length === 0 ? ["destinationAirports"] : []),
      ...(partial.legs.length < 2 || partial.legs.some((leg) =>
        leg.originAirports.length === 0
        || leg.destinationAirports.length === 0
        || !leg.departureDate
      )
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
  now: Date,
  timeZone: string
): string | null {
  if (currentIssue) return currentIssue;
  const today = localIsoDate(now, timeZone);
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

function localIsoDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
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
      context: ""
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

function pendingFieldsFor(
  partial: TripPlanPartial,
  missingFields: string[]
): Array<{ field: TripPlanPendingField; legIndex: number | null }> {
  return missingFields.flatMap((field) => {
    if (!isPendingField(field)) return [];
    const legIndex = field === "originAirports"
      || field === "destinationAirports"
      || field === "departureDate"
      ? 0
      : field === "returnDate"
        ? Math.max(1, partial.legs.length - 1)
        : null;
    return [{ field, legIndex }];
  });
}

function isPendingField(value: string): value is TripPlanPendingField {
  return [
    "originAirports",
    "destinationAirports",
    "departureDate",
    "returnDate",
    "itineraryLegs",
    "travellers",
    "currency",
    "dates"
  ].includes(value);
}

function repairClarification(
  partial: TripPlanPartial,
  missingFields: string[],
  basePrompt: string,
  repeatedPromptCount: number
): string {
  const route = partial.legs.length > 0
    ? [
        partial.legs[0]!.originAirports.join("/") || "?",
        ...partial.legs.map((leg) => leg.destinationAirports.join("/") || "?")
      ].join(" → ")
    : `${partial.originAirports.join("/") || "?"} → ${partial.destinationAirports.join("/") || "?"}`;
  const dates = partial.legs
    .map((leg, index) =>
      leg.departureDate ? `• Leg ${index + 1}: ${formatCalendarDate(leg.departureDate)}` : null
    )
    .filter((line): line is string => Boolean(line));
  return [
    repeatedPromptCount === 1
      ? "I reread the Trip instead of asking the same question again."
      : `I’ve reread the draft ${repeatedPromptCount} times and won’t guess the missing detail.`,
    "",
    `• Route: ${route}`,
    ...dates,
    "",
    missingFields.length > 0 ? basePrompt : "Tell me which part I should correct."
  ].join("\n");
}

function repairSource(conversation: string[]): string {
  const messages = conversation.filter((message) =>
    !/\b(?:already told|in (?:the|my) message|read (?:it|that|the message) again|reread|(?:i|we)\s+(?:already\s+)?(?:said|told you)|as i said)\b/iu.test(message)
  );
  const bounded = messages.length <= 8
    ? messages
    : [messages[0]!, ...messages.slice(-7)];
  return bounded.join("\nThen: ").slice(0, 4_000) || conversation[0] || "";
}

function looksLikeDraftContinuation(draft: TripPlanDraft, request: string): boolean {
  const text = request.trim();
  if (!text) return false;
  if (
    /\b(?:already told|in (?:the|my) message|read (?:it|that|the message) again|reread|actually|change|instead|make it|correction|rather)\b/iu.test(text)
  ) {
    return true;
  }
  if (
    /\b(?:economy|premium economy|business|first class|non[ -]?stop|direct|stops?|currency|NGN|USD|GBP|EUR|KES)\b/iu.test(text)
  ) {
    return true;
  }
  const missing = new Set(draft.unresolvedFields);
  if (
    (missing.has("originAirports")
      || missing.has("destinationAirports")
      || missing.has("itineraryLegs"))
    && orderedAirportCodesFromText(text).length > 0
  ) {
    return true;
  }
  if (
    missing.has("departureDate")
    || missing.has("returnDate")
    || missing.has("dates")
    || missing.has("itineraryLegs")
  ) {
    if (
      /\b(?:today|tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2})\b/iu.test(text)
    ) {
      return true;
    }
  }
  if (
    missing.has("travellers")
    && /\b(?:just|only)\s+me\b|\bsolo\b|\bmyself\b|\b\d+\s+(?:adult|person|people|traveller|traveler|passenger)s?\b/iu.test(text)
  ) {
    return true;
  }
  return draft.status === "awaiting_confirmation" && (
    orderedAirportCodesFromText(text).length > 0
    || /\b(?:return|depart|one[ -]?way|round[ -]?trip|airline|prefer|avoid)\b/iu.test(text)
  );
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
    accessHint: "Send /trips to open your Trips."
  };
}

export function defaultTripPlanPartial(): TripPlanPartial {
  return structuredClone(EMPTY_TRIP_PLAN_PARTIAL);
}
