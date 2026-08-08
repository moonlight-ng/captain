import {
  EMPTY_TRIP_DRAFT_STATE,
  MAX_ACTIVE_TRIPS_PER_USER,
  SUPPORTED_CURRENCY_MESSAGE,
  addIsoDays,
  createTripSchema,
  daysBetween,
  formatCalendarDate,
  formatTripGoal,
  isSupportedTripCurrency,
  stableJson,
  totalTravellers,
  type RankingMode,
  type Trip,
  type TripCreationReceipt,
  type TripDraftState,
  type TripPlanDraft,
  type TripPlanConfirmationSnapshot,
  type TripPlanResult
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

import type { TripService } from "../trips/service.js";
import { applyTripTurnPatch } from "./draft-reducer.js";
import { fallbackTripFactExtraction } from "./extractor.js";
import {
  formatActiveTripList,
  formatActiveTripLocation,
  formatTripCreationReceipt,
  formatTripPlanConfirmation
} from "./format.js";
import { suggestedMaxStops, suggestedTripCurrency } from "./currency.js";
import { airportMarket, orderedAirportCodesFromText } from "./airport-catalog.js";
import {
  createTripTurnInterpreter,
  type TripPlannerQuestion,
  type TripTurnInterpreter
} from "./turn-interpreter.js";
import {
  compileItineraryConstraints,
  createItineraryConstraintInterpreter,
  isNarrativeItineraryRequest,
  type ItineraryConstraintInterpreter
} from "./itinerary-constraints.js";

const CONFIRM_PATTERN = /^(?:yes|y|confirm|confirmed|create(?:\s+it)?|start(?:\s+it)?|looks?\s+good|go\s+ahead)[.! ]*$/iu;
const CANCEL_PATTERN = /^(?:no|cancel|never\s*mind|stop)[.! ]*$/iu;
const REPLACE_CONSENT_PATTERN = /^(?:(?:yes|y|okay|ok|sure|continue)(?:,?\s+please)?|replace(?:\s+(?:it|the\s+(?:current|existing|old)\s+trip))?)[.! ]*$/iu;
const DECLINE_PROPOSAL_PATTERN = /^(?:no|nope|different dates?|choose dates?)[.! ]*$/iu;
const KEEP_BOTH_PATTERN = /\b(?:keep|want|save|have)\s+(?:them\s+)?both\b|\b(?:two|multiple)\s+(?:active\s+)?trips\b/iu;
const NEW_DRAFT_PATTERN = /\b(?:another|a new|new|different)\s+(?:flight|trip|journey)\b/iu;
const FRESH_TRIP_DIRECTIVE_PATTERN = /^\s*(?:(?:let(?:'|’)s|please)\s+|i\s+(?:want|need|would\s+like)\s+to\s+|(?:can|could|would)\s+you\s+)?(?:track|start|create|plan|set\s*up|find|search(?:\s+for)?)\s+(?:(?:me|us)\s+)?(?:a\s+|the\s+|my\s+)?(?:flight|trip|journey)\b/iu;
const WHERE_PATTERN = /^(?:where|where is it|where(?:'s| is) (?:the|my) trip)[?!. ]*$/iu;
const BARE_ROUTE_PATTERN = /\b(?:from\s+)?[\p{L}][\p{L}.'’()-]*(?:\s+[\p{L}][\p{L}.'’()-]*){0,3}\s+to\s+[\p{L}][\p{L}.'’()-]*(?:\s+[\p{L}][\p{L}.'’()-]*){0,3}\b/iu;
const TRAVEL_DATE_PATTERN = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|tonight|next\s+(?:week|month|weekend)|this\s+(?:week|month|weekend)|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/iu;
const EXPLORATORY_DATE_PLANNING_PATTERNS = [
  /\bpotential\s+itinerar(?:y|ies)\b/iu,
  /\b(?:help\s+(?:me|us)\s+)?(?:figure|work)\s+out\b[\s\S]{0,80}\b(?:date|dates|when|itinerar(?:y|ies))\b/iu,
  /\b(?:date|dates|timing)\s+(?:are|is)\s+(?:still\s+)?flexible\b/iu,
  /\bnot\s+sure\b[\s\S]{0,60}\b(?:date|dates|when)\b/iu,
  /\b(?:what|which)\s+dates?\b[\s\S]{0,60}\b(?:work|best|make\s+sense)\b/iu,
  /\bhelp\s+(?:me|us)\s+plan\b[\s\S]{0,80}\b(?:itinerar(?:y|ies)|dates?|when)\b/iu
] as const;
const CREATION_SUCCESS_PATTERNS = [
  /\b(?:your|the|that)\b[\s\S]{0,100}\btrip\b[\s\S]{0,200}\b(?:has\s+been|was|is\s+now)\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b/iu,
  /\b(?:your|the|that)\b[\s\S]{0,100}\btrip\b\s+is\s+(?:successfully\s+)?(?:created|saved|set\s+up)\b/iu,
  /\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have))\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b[\s\S]{0,180}\btrip\b/iu,
  /\btrip\b\s+(?:has\s+been|was)\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b/iu
] as const;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const UNGROUNDED_CREATION_MESSAGE = "I couldn’t verify a trip-creation receipt. Send /trip to check your trip.";

export class TripPlanningService {
  readonly #store: CaptainPlatformStore;
  readonly #trips: TripService;
  readonly #interpret: TripTurnInterpreter;
  readonly #interpretItineraryConstraints: ItineraryConstraintInterpreter;
  readonly #now: () => Date;
  readonly #dashboardUrlForTrip: (userId: string, tripId: string) => string | Promise<string>;

  constructor(options: {
    store: CaptainPlatformStore;
    trips: TripService;
    interpret?: TripTurnInterpreter;
    interpretItineraryConstraints?: ItineraryConstraintInterpreter;
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
    this.#interpretItineraryConstraints = options.interpretItineraryConstraints
      ?? createItineraryConstraintInterpreter({
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
    const result = await this.#prepareTurn(userId, request, sourceMessageId, draftId, false);
    if (!result) throw new Error("A direct trip-planning request was not handled");
    return result;
  }

  async #prepareTurn(
    userId: string,
    request: string,
    sourceMessageId: string | null,
    draftId: string | undefined,
    allowUnhandled: boolean
  ): Promise<TripPlanResult | null> {
    const now = this.#now();
    const user = await this.#store.getUser(userId);
    const timeZone = user?.timezone ?? "UTC";
    const constraintSet = await this.#interpretItineraryConstraints({ request, now, timeZone });
    const compiledConstraints = constraintSet
      ? compileItineraryConstraints(constraintSet, now, timeZone)
      : null;
    let draft = draftId
      ? await this.#store.getTripPlanDraft(userId, draftId, now)
      : await this.#store.findOpenTripPlanDraft(userId, now);
    if (compiledConstraints && !draftId && draft) {
      await this.cancel(userId, draft.id, draft.revision);
      draft = null;
    }
    if (!draft || !["collecting", "awaiting_confirmation"].includes(draft.status)) {
      draft = await this.#store.createTripPlanDraft(userId, request, sourceMessageId, now);
    }
    const conversation = draft.conversation.at(-1) === request.trim()
      ? draft.conversation
      : [...draft.conversation, request.trim()].slice(-40);
    const sourceMessageIds = sourceMessageId && !draft.sourceMessageIds.includes(sourceMessageId)
      ? [...draft.sourceMessageIds, sourceMessageId].slice(-40)
      : draft.sourceMessageIds;
    const priorMissingFields = missingTripFields(draft.state, null);
    // “Create” in front of proposed windows is consent to them, not a separate
    // instruction: the traveller still reviews the trip before it starts.
    const acceptProposedWindows = !compiledConstraints
      && canAcceptProposedWindows(draft.state)
      && (
        REPLACE_CONSENT_PATTERN.test(request.trim())
        || CONFIRM_PATTERN.test(request.trim())
      );
    const declineProposedWindows = !compiledConstraints
      && canAcceptProposedWindows(draft.state)
      && DECLINE_PROPOSAL_PATTERN.test(request.trim());
    const turn = compiledConstraints || acceptProposedWindows || declineProposedWindows
      ? null
      : await this.#interpret({
        request,
        conversation,
        state: draft.state,
        activeQuestion: draft.revision === 1 && draft.state.legs.length === 0
          ? null
          : activeQuestionFor(priorMissingFields),
        now,
        timeZone
      });
    if (allowUnhandled && turn?.intent === "unrelated" && turn.operations.length === 0) return null;
    const beforeHash = stableJson(draft.state);
    const reduced = compiledConstraints
      ? {
          state: applyNarrativeOptions(compiledConstraints.state, request),
          appliedOperations: [],
          issue: compiledConstraints.prompt
        }
      : acceptProposedWindows
        ? {
            state: acceptProposedSearchWindows(draft.state),
            appliedOperations: [],
            issue: null
          }
        : declineProposedWindows
          ? {
              state: declineProposedSearchWindows(draft.state),
              appliedOperations: [],
              issue: null
            }
      : applyTripTurnPatch({
          state: turn!.intent === "replace_trip"
            ? structuredClone(EMPTY_TRIP_DRAFT_STATE)
            : draft.state,
          patch: turn!,
          now,
          timeZone
        });
    const state = reduced.state;
    const unsupportedParty = Boolean(
      state.travellers
      && (
        state.travellers.adults !== 1
        || state.travellers.childrenAges.length > 0
        || state.travellers.infants !== 0
      )
    );
    const profile = await this.#store.ensureProfile(userId, now);
    const suggestedCurrency = suggestedTripCurrency(state, profile.defaultCurrency);
    const effectiveCurrency = state.currency ?? suggestedCurrency;
    const unsupportedCurrency = Boolean(
      effectiveCurrency && !isSupportedTripCurrency(effectiveCurrency)
    );
    const missingFields = missingTripFields(state, null);
    if (unsupportedParty && !missingFields.includes("travellers")) {
      missingFields.push("travellers");
    }
    const confirmationSnapshot = (
      missingFields.length === 0
      && !unsupportedCurrency
      && !unsupportedParty
      && (!compiledConstraints || !reduced.issue)
    )
      ? completePlan(state, draft.id, suggestedCurrency)
      : null;
    const activeTrips = confirmationSnapshot
      ? (await this.#store.listTrips(userId)).filter((trip) =>
          !["cancelled", "completed", "archived"].includes(trip.status)
        )
      : [];
    const tripLimitReached = Boolean(
      confirmationSnapshot
      && activeTrips.length >= MAX_ACTIVE_TRIPS_PER_USER
      && !activeTrips.some((trip) =>
        stableJson(trip.brief) === stableJson(confirmationSnapshot.input.brief)
      )
    );
    const basePrompt = !confirmationSnapshot || tripLimitReached
      ? tripLimitReached
        ? replacementPrompt(activeTrips[0]!, confirmationSnapshot!)
        : unsupportedParty
          ? "Captain’s beta currently tracks fares for exactly one adult. Reply “just me” to continue, or cancel this trip."
          : unsupportedCurrency
            ? SUPPORTED_CURRENCY_MESSAGE
            : reduced.issue ?? clarificationPrompt(missingFields, state)
      : null;
    const revised = await this.#store.reviseTripPlanDraft(
      userId,
      draft.id,
      draft.revision,
      {
        status: confirmationSnapshot && !tripLimitReached
          ? "awaiting_confirmation"
          : "collecting",
        conversation,
        state,
        // Keep the fully parsed request while waiting for replacement consent.
        // Event language never enters this snapshot; only the inferred route
        // and flight-date windows do.
        confirmationSnapshot,
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
      date_conflict: Boolean(reduced.issue),
      turn_intent: compiledConstraints
        ? "compile_constraints"
        : acceptProposedWindows
          ? "accept_proposed_search_windows"
          : declineProposedWindows
            ? "decline_proposed_search_windows"
          : turn!.intent,
      operation_types: compiledConstraints
        ? ["compile_city_presence_constraints"]
        : acceptProposedWindows
          ? ["accept_proposed_search_windows"]
          : declineProposedWindows
            ? ["decline_proposed_search_windows"]
          : reduced.appliedOperations.map((operation) => operation.type),
      before_hash: beforeHash,
      after_hash: stableJson(state)
    }));
    if (!confirmationSnapshot || tripLimitReached) {
      return {
        status: "needs_input",
        draft: revised,
        prompt: basePrompt!,
        missingFields
      };
    }
    return {
      status: "awaiting_confirmation",
      draft: revised,
      confirmation: reduced.issue
        ? `${reduced.issue}\n\n${formatTripPlanConfirmation(revised)}`
        : formatTripPlanConfirmation(revised)
    };
  }

  async confirm(userId: string, draftId: string, expectedRevision: number): Promise<TripPlanResult> {
    const now = this.#now();
    const draft = await this.#store.getTripPlanDraft(userId, draftId, now);
    if (!draft?.confirmationSnapshot) throw new Error("Trip draft is incomplete or expired");
    let confirmed;
    try {
      confirmed = await this.#store.confirmTripPlanDraft(
        userId,
        draftId,
        expectedRevision,
        [],
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
      await this.dashboardUrlForTrip(userId, confirmed.result.trip.id),
      (await this.#store.ensureProfile(userId, this.#now())).rankingMode
    );
    console.info(JSON.stringify({
      event: "captain.trip_plan_confirmed",
      draft_id: confirmed.draft.id,
      trip_id: receipt.tripId,
      created: receipt.created
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
    return { status: "cancelled", draft, message: "Okay—the trip draft was cancelled." };
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

  async groundAssistantMessage(
    userId: string,
    message: string
  ): Promise<{ message: string; createdTrip: boolean }> {
    if (!CREATION_SUCCESS_PATTERNS.some((pattern) => pattern.test(message))) {
      return { message, createdTrip: false };
    }
    const tripId = UUID_PATTERN.exec(message)?.[0] ?? null;
    const trip = tripId
      ? await this.#trips.get(userId, tripId)
      : await this.#store.getActiveTrip(userId);
    if (!trip) return { message: UNGROUNDED_CREATION_MESSAGE, createdTrip: false };
    const departureDate = trip.brief.departureWindow.start;
    const returnDate = trip.brief.tripType === "round_trip" && trip.brief.stayNights
      ? addIsoDays(departureDate, trip.brief.stayNights.preferred)
      : null;
    const dashboardUrl = await this.dashboardUrlForTrip(userId, trip.id);
    const { rankingMode } = await this.#store.ensureProfile(userId, this.#now());
    const createdMessage = formatTripCreationReceipt(buildReceiptFromTrip(
      trip,
      true,
      departureDate,
      returnDate,
      dashboardUrl,
      rankingMode
    ));
    const reusedMessage = formatTripCreationReceipt(buildReceiptFromTrip(
      trip,
      false,
      departureDate,
      returnDate,
      dashboardUrl,
      rankingMode
    ));
    const trimmed = message.trim();
    if (trimmed === createdMessage) return { message, createdTrip: true };
    if (trimmed === reusedMessage) return { message, createdTrip: false };
    return { message: UNGROUNDED_CREATION_MESSAGE, createdTrip: false };
  }

  async handleOpenDraftText(
    userId: string,
    request: string,
    sourceMessageId: string | null
  ): Promise<TripPlanResult | null> {
    const draft = await this.findOpen(userId);
    if (!draft) return null;
    if (isNarrativeItineraryRequest(request)) {
      await this.cancel(userId, draft.id, draft.revision);
      return this.prepare(userId, request, sourceMessageId);
    }
    if (draft.status === "collecting" && draft.confirmationSnapshot) {
      if (KEEP_BOTH_PATTERN.test(request)) {
        return {
          status: "needs_input",
          draft,
          prompt: "Captain currently supports one active trip. If keeping both would be useful, send that through /feedback. Your current trip is unchanged.",
          missingFields: []
        };
      }
      if (REPLACE_CONSENT_PATTERN.test(request.trim())) {
        const activeTrip = await this.#store.getActiveTrip(userId);
        if (activeTrip) {
          await this.#store.archiveTripForReplacement(userId, activeTrip.id, this.#now());
        }
        return this.#prepareTurn(userId, request, sourceMessageId, draft.id, false);
      }
    }
    if (draft.status === "awaiting_confirmation" && CONFIRM_PATTERN.test(request.trim())) {
      return this.confirm(userId, draft.id, draft.revision);
    }
    if (
      draft.status === "collecting"
      && !draft.confirmationSnapshot
      && canAcceptProposedWindows(draft.state)
      && DECLINE_PROPOSAL_PATTERN.test(request.trim())
    ) {
      return this.#prepareTurn(userId, request, sourceMessageId, draft.id, false);
    }
    if (CANCEL_PATTERN.test(request.trim())) {
      return this.cancel(userId, draft.id, draft.revision);
    }
    // There is nothing to confirm on a draft that is still being collected, and
    // no proposal for a “yes” to land on. Saying so and re-asking beats revising
    // the draft into the identical question the traveller is already looking at.
    if (
      CONFIRM_PATTERN.test(request.trim())
      && !canAcceptProposedWindows(draft.state)
    ) {
      const missingFields = missingTripFields(draft.state, null);
      const missing = missingSummary(missingFields);
      if (missing) {
        return {
          status: "needs_input",
          draft,
          prompt: `I can’t start tracking yet — the trip still needs ${missing}.\n\n`
            + clarificationPrompt(missingFields, draft.state),
          missingFields
        };
      }
    }
    if (
      (NEW_DRAFT_PATTERN.test(request) || FRESH_TRIP_DIRECTIVE_PATTERN.test(request))
      && TripPlanningService.isTripPlanningRequest(request)
    ) {
      await this.cancel(userId, draft.id, draft.revision);
      return this.prepare(userId, request, sourceMessageId);
    }
    return this.#prepareTurn(userId, request, sourceMessageId, draft.id, true);
  }

  static isTripPlanningRequest(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    const orderedPlaces = orderedAirportCodesFromText(normalized);
    const travel = /\b(?:flight|flights|trip|travel|fly|flying|journey|itinerar(?:y|ies)|holiday|vacation|visit)\b/iu.test(normalized);
    const action = /\b(?:plan|start|create|set\s*up|track|search|find|book|want|need|compare|options?|best|cheapest|help|figure|work\s+out)\b/iu.test(normalized);
    const bareDatedRoute = BARE_ROUTE_PATTERN.test(normalized)
      && orderedPlaces.length >= 2
      && TRAVEL_DATE_PATTERN.test(normalized);
    const contextualMultiCityPlan = orderedPlaces.length >= 3
      && TRAVEL_DATE_PATTERN.test(normalized)
      && (action || /\b(?:be|stay|spend|going)\s+(?:in|to)\b/iu.test(normalized));
    return (travel && action) || bareDatedRoute || contextualMultiCityPlan;
  }

  /**
   * Exploratory date planning needs the conversational agent before the
   * durable exact-date draft. Otherwise Telegram's fast path turns a rough
   * voice itinerary into a form-style date question and skips planning.
   */
  static needsItineraryPlanningConversation(text: string): boolean {
    const normalized = text.trim();
    if (isNarrativeItineraryRequest(normalized)) return false;
    return normalized.length > 0
      && (
        EXPLORATORY_DATE_PLANNING_PATTERNS.some((pattern) => pattern.test(normalized))
        || orderedAirportCodesFromText(normalized).length >= 3
        || /\b(?:wedding|birthday|christmas|conference|meeting|event)\b/iu.test(normalized)
        || [...normalized.matchAll(/\b(?:from\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)?\s*\d{1,2}\s*[-–]\s*\d{1,2}\b/giu)].length >= 2
      );
  }

  static isWhereQuestion(text: string): boolean {
    return WHERE_PATTERN.test(text.trim());
  }
}

function replacementPrompt(
  activeTrip: Trip,
  candidate: TripPlanConfirmationSnapshot
): string {
  const legs = candidate.input.brief.legs ?? [];
  const itinerary = legs.length > 0
    ? [
        "I mapped the flights as:",
        ...legs.map((leg) =>
          `• ${leg.originAirports.join("/")} → ${leg.destinationAirports.join("/")}: `
          + formatPlanningWindow(leg.departureWindow)
          + (leg.arriveBy ? ` · arrive by ${formatCalendarDate(leg.arriveBy)}` : "")
        ),
        ""
      ].join("\n")
    : "";
  return `${itinerary}You already have “${activeTrip.title}” as your active trip. Replace it with this one? `
    + "If you want to keep both, use /feedback to let us know.";
}

function formatPlanningWindow(window: { start: string; end: string }): string {
  return window.start === window.end
    ? formatCalendarDate(window.start)
    : `${formatCalendarDate(window.start)} – ${formatCalendarDate(window.end)}`;
}

function applyNarrativeOptions(state: TripDraftState, request: string): TripDraftState {
  const facts = fallbackTripFactExtraction(request, EMPTY_TRIP_DRAFT_STATE);
  return {
    ...state,
    travellers: facts.travellers,
    cabin: facts.cabin,
    maxStops: facts.maxStops,
    currency: facts.currency,
    maximumPrice: facts.maximumPrice,
    preferredAirlines: facts.preferredAirlines,
    excludedAirlines: facts.excludedAirlines
  };
}

function missingTripFields(state: TripDraftState, dateIssue: string | null): string[] {
  const first = state.legs[0];
  const tripType = effectiveTripType(state);
  let missing: string[];
  if (tripType === "multi_city") {
    missing = [
      ...(!first || first.originAirports.length === 0 ? ["originAirports"] : []),
      ...(!state.legs.at(-1) || state.legs.at(-1)!.destinationAirports.length === 0
        ? ["destinationAirports"]
        : []),
      ...(state.legs.length < 2 || state.legs.some((leg) =>
        leg.originAirports.length === 0
        || leg.destinationAirports.length === 0
        || leg.departure === null
      )
        ? ["itineraryLegs"]
        : [])
    ];
  } else {
    missing = [
      ...(!first || first.originAirports.length === 0 ? ["originAirports"] : []),
      ...(!first || first.destinationAirports.length === 0 ? ["destinationAirports"] : []),
      ...(
        tripType === "round_trip"
          ? first?.departure?.kind !== "exact"
            ? ["departureDate"]
            : []
          : !first?.departure
            ? ["departureDate"]
            : []
      ),
      ...(tripType === "round_trip" && state.legs.at(-1)?.departure?.kind !== "exact"
        ? ["returnDate"]
        : [])
    ];
  }
  return dateIssue && missing.length > 0 ? ["dates"] : missing;
}

function completePlan(
  state: TripDraftState,
  _draftId: string,
  suggestedCurrency: string
): TripPlanDraft["confirmationSnapshot"] {
  const first = state.legs[0];
  const last = state.legs.at(-1);
  const tripType = effectiveTripType(state);
  const departureWindow = selectionWindow(first);
  const departureDate = departureWindow?.start ?? null;
  const returnDate = tripType === "round_trip" ? exactDate(last) : null;
  if (!first || !last || !departureDate || (tripType === "round_trip" && !returnDate)) {
    throw new Error("Cannot complete a trip with unresolved fields");
  }
  const travellers = state.travellers ?? { adults: 1 as const, childrenAges: [], infants: 0 as const };
  const cabin = state.cabin ?? "economy";
  const maxStops = state.maxStops ?? suggestedMaxStops(state);
  const currency = state.currency ?? suggestedCurrency;
  const stayNights = tripType === "round_trip" && returnDate
    ? daysBetween(departureDate, returnDate)
    : null;
  const input = createTripSchema.parse({
    title: tripType === "multi_city"
      ? [
          first.originAirports.join("/"),
          ...state.legs.map((leg) => leg.destinationAirports.join("/"))
        ].join(" to ")
      : `${first.originAirports.join("/")} to ${first.destinationAirports.join("/")}`,
    brief: {
      originAirports: first.originAirports,
      destinationAirports: tripType === "multi_city"
        ? last.destinationAirports
        : first.destinationAirports,
      tripType,
      departureWindow,
      stayNights: stayNights
        ? { minimum: stayNights, preferred: stayNights, maximum: stayNights }
        : null,
      legs: tripType === "multi_city"
        ? state.legs.map((leg) => ({
            originAirports: leg.originAirports,
            destinationAirports: leg.destinationAirports,
            departureWindow: selectionWindow(leg)!,
            ...(leg.arriveBy ? { arriveBy: leg.arriveBy } : {})
          }))
        : undefined,
      travellers,
      cabin,
      maxStops,
      currency,
      maximumPrice: state.maximumPrice,
      preferredAirlines: state.preferredAirlines,
      excludedAirlines: state.excludedAirlines,
      context: ""
    }
  });
  return {
    input,
    departureDate,
    returnDate
  };
}

/** Names what a draft is still short of, or null when nothing is. */
function missingSummary(missingFields: string[]): string | null {
  const missing = new Set(missingFields);
  if (missing.has("originAirports")) return "a departure city";
  if (missing.has("destinationAirports")) return "a destination";
  if (missing.has("departureDate")) return "a departure date";
  if (missing.has("returnDate")) return "a return date";
  if (missing.has("itineraryLegs")) return "a date for every flight";
  if (missing.has("travellers")) return "a supported party size";
  return null;
}

function clarificationPrompt(missingFields: string[], state: TripDraftState): string {
  const missing = new Set(missingFields);
  if (missing.has("originAirports")) return "Where are you flying from?";
  if (missing.has("destinationAirports")) return "Where would you like to fly to?";
  if (missing.has("departureDate")) {
    const selection = state.legs[0]?.departure;
    if (selection?.kind === "window") {
      return `Which exact departure date should I use within ${selection.start} to ${selection.end}?`;
    }
    return "What date would you like to depart?";
  }
  if (missing.has("returnDate")) return "What date would you like to return?";
  if (missing.has("itineraryLegs")) {
    const unresolved = state.legs.find((leg) => !leg.departure && !leg.proposedDeparture);
    if (unresolved) {
      const route = formatDraftLegRoute(unresolved);
      if (unresolved.feasibleDepartureWindow) {
        return `What seven-day window should I use for ${route} within ${formatShortWindow(unresolved.feasibleDepartureWindow)}?`;
      }
      return `When can you fly ${route}?${unresolved.arriveBy ? ` You need to arrive by ${formatCalendarDate(unresolved.arriveBy)}.` : ""}`;
    }
    const proposals = state.legs.filter((leg) => !leg.departure && leg.proposedDeparture);
    if (proposals.length > 0) {
      return [
        "The longer gaps are possible travel envelopes, not search dates. I suggest checking:",
        ...proposals.map((leg) => {
          const feasible = leg.feasibleDepartureWindow;
          return `• ${formatDraftLegRoute(leg)}: ${formatDraftSelection(leg.proposedDeparture!)} suggested`
            + (feasible ? ` within ${formatShortWindow(feasible)}` : "");
        }),
        "Use these seven-day search windows?"
      ].join("\n");
    }
    return "What departure window should I use for the next flight leg?";
  }
  return "What should I add to the trip?";
}

function canAcceptProposedWindows(state: TripDraftState): boolean {
  return state.legs.length > 0
    && state.legs.every((leg) =>
      leg.originAirports.length > 0 && leg.destinationAirports.length > 0
    )
    && state.legs.some((leg) => !leg.departure && Boolean(leg.proposedDeparture))
    && state.legs.every((leg) => Boolean(leg.departure || leg.proposedDeparture));
}

function acceptProposedSearchWindows(state: TripDraftState): TripDraftState {
  const accepted = structuredClone(state);
  accepted.legs.forEach((leg) => {
    if (!leg.departure && leg.proposedDeparture) {
      leg.departure = leg.proposedDeparture;
      leg.proposedDeparture = null;
    }
  });
  return accepted;
}

function declineProposedSearchWindows(state: TripDraftState): TripDraftState {
  const declined = structuredClone(state);
  declined.legs.forEach((leg) => {
    if (!leg.departure) leg.proposedDeparture = null;
  });
  return declined;
}

function planningCityLabel(code: string): string {
  return airportMarket(code)?.label ?? code;
}

function formatDraftLegRoute(leg: TripDraftState["legs"][number]): string {
  const origin = leg.originAirports.map(planningCityLabel).join("/") || "your origin";
  const destination = leg.destinationAirports.map(planningCityLabel).join("/") || "your destination";
  return `${origin} → ${destination}`;
}

function formatDraftSelection(selection: NonNullable<TripDraftState["legs"][number]["departure"]>): string {
  return selection.kind === "exact"
    ? formatCalendarDate(selection.date)
    : formatShortWindow(selection);
}

function formatShortWindow(window: { start: string; end: string }): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  });
  const start = formatter.format(new Date(`${window.start}T00:00:00.000Z`));
  const end = formatter.format(new Date(`${window.end}T00:00:00.000Z`));
  return start === end ? start : `${start}–${end}`;
}

function activeQuestionFor(missingFields: string[]): TripPlannerQuestion {
  const first = missingFields[0];
  if (
    first === "originAirports"
    || first === "destinationAirports"
    || first === "departureDate"
    || first === "returnDate"
    || first === "itineraryLegs"
  ) {
    return first;
  }
  return null;
}

function effectiveTripType(state: TripDraftState): "one_way" | "round_trip" | "multi_city" {
  return state.tripType ?? (state.legs.length > 1 ? "multi_city" : "one_way");
}

function exactDate(
  leg: TripDraftState["legs"][number] | undefined
): string | null {
  return leg?.departure?.kind === "exact" ? leg.departure.date : null;
}

function selectionWindow(
  leg: TripDraftState["legs"][number] | undefined
): { start: string; end: string } | null {
  if (!leg?.departure) return null;
  return leg.departure.kind === "exact"
    ? { start: leg.departure.date, end: leg.departure.date }
    : { start: leg.departure.start, end: leg.departure.end };
}

function buildReceipt(
  draft: TripPlanDraft,
  trip: Trip,
  created: boolean,
  dashboardUrl: string,
  rankingMode: RankingMode
): TripCreationReceipt {
  if (!draft.confirmationSnapshot) {
    throw new Error("Started trip is missing its persisted confirmation snapshot");
  }
  return buildReceiptFromTrip(
    trip,
    created,
    draft.confirmationSnapshot.departureDate,
    draft.confirmationSnapshot.returnDate,
    dashboardUrl,
    rankingMode
  );
}

function buildReceiptFromTrip(
  trip: Trip,
  created: boolean,
  departureDate: string,
  returnDate: string | null,
  dashboardUrl: string,
  rankingMode: RankingMode
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
    goal: formatTripGoal({ brief: trip.brief, rankingMode }),
    dashboardUrl,
    accessHint: "Send /trip to open your trip."
  };
}

export function defaultTripDraftState(): TripDraftState {
  return structuredClone(EMPTY_TRIP_DRAFT_STATE);
}
