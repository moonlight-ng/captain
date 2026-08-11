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
  type StructuredTripLeg,
  type TripPlanDraft,
  type TripPlanConfirmationSnapshot,
  type TripPlanResult
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

import type { TripService } from "../trips/service.js";
import type { GatewayGenerationUsageInput } from "../admin/usage.js";
import { applyTripTurnPatch } from "./draft-reducer.js";
import { fallbackTripFactExtraction } from "./extractor.js";
import {
  formatActiveTripList,
  formatActiveTripLocation,
  formatTripCreationReceipt,
  formatTripPlanConfirmation,
  isExplicitPlanConsentPrompt
} from "./format.js";
import { suggestedMaxStops, suggestedTripCurrency } from "./currency.js";
import {
  airportCodeForLocation,
  airportMarket,
  orderedAirportCodesFromText,
  orderedAirportMentionsFromText
} from "./airport-catalog.js";
import {
  createTripDraftReadinessAssessor,
  type TripDraftReadinessAssessor
} from "./draft-readiness.js";
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
  /^Itinerary ready to confirm\./iu,
  /\b(?:your|the|that)\b[\s\S]{0,100}\btrip\b[\s\S]{0,200}\b(?:has\s+been|was|is\s+now)\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b/iu,
  /\b(?:your|the|that)\b[\s\S]{0,100}\btrip\b\s+is\s+(?:successfully\s+)?(?:created|saved|set\s+up)\b/iu,
  /\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have))\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b[\s\S]{0,180}\btrip\b/iu,
  /\btrip\b\s+(?:has\s+been|was)\s+(?:successfully\s+)?(?:created|saved|set\s+up|started)\b/iu
] as const;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const UNGROUNDED_CREATION_MESSAGE = "I couldn’t verify a trip-creation receipt. Send /trip to check your trip.";
const MAX_CLARIFICATION_QUESTIONS = 5;
const ASSUMABLE_DATE_FIELDS = new Set([
  "dates",
  "departureDate",
  "returnDate",
  "itineraryLegs"
]);

export function isTripConfirmationText(text: string): boolean {
  return CONFIRM_PATTERN.test(text.trim());
}

export class TripPlanningService {
  readonly #store: CaptainPlatformStore;
  readonly #trips: TripService;
  readonly #interpret: TripTurnInterpreter;
  readonly #interpretItineraryConstraints: ItineraryConstraintInterpreter;
  readonly #assessReadiness: TripDraftReadinessAssessor;
  readonly #now: () => Date;
  readonly #dashboardUrlForTrip: (userId: string, tripId: string) => string | Promise<string>;

  constructor(options: {
    store: CaptainPlatformStore;
    trips: TripService;
    interpret?: TripTurnInterpreter;
    interpretItineraryConstraints?: ItineraryConstraintInterpreter;
    assessReadiness?: TripDraftReadinessAssessor;
    model?: string;
    apiKey?: string | null;
    recordUsage?: (input: GatewayGenerationUsageInput) => Promise<void>;
    now?: () => Date;
    dashboardUrlForTrip?: (userId: string, tripId: string) => string | Promise<string>;
  }) {
    this.#store = options.store;
    this.#trips = options.trips;
    this.#interpret = options.interpret ?? createTripTurnInterpreter({
      apiKey: options.apiKey ?? null,
      model: options.model ?? "openai/gpt-5.6-luna",
      ...(options.recordUsage ? { recordUsage: options.recordUsage } : {})
    });
    this.#interpretItineraryConstraints = options.interpretItineraryConstraints
      ?? createItineraryConstraintInterpreter({
        apiKey: options.apiKey ?? null,
        model: options.model ?? "openai/gpt-5.6-luna",
        ...(options.recordUsage ? { recordUsage: options.recordUsage } : {})
      });
    this.#assessReadiness = options.assessReadiness
      ?? createTripDraftReadinessAssessor({
        apiKey: options.apiKey ?? null,
        model: options.model ?? "openai/gpt-5.6-luna",
        ...(options.recordUsage ? { recordUsage: options.recordUsage } : {})
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

  /**
   * Plans from an itinerary that is already an itinerary.
   *
   * The prose path exists because a traveller writes prose. A caller that has
   * already agreed a dated schedule has no reason to write it back out as a
   * sentence for a parser to take apart again — that round trip is where a
   * city goes missing. Structured legs skip all three interpretation passes
   * and rejoin the same validation, confirmation and storage the prose path
   * ends in, so both produce the same trip.
   */
  async prepareStructured(
    userId: string,
    input: { request: string; legs: readonly StructuredTripLeg[]; tripType?: TripDraftState["tripType"] },
    sourceMessageId: string | null = null,
    draftId?: string
  ): Promise<TripPlanResult> {
    const now = this.#now();
    const user = await this.#store.getUser(userId);
    const timeZone = user?.timezone ?? "UTC";
    const resolved = resolveStructuredLegs(input.legs, localIsoDate(now, timeZone));
    if ("errors" in resolved) return { status: "invalid_legs", errors: resolved.errors };
    const facts = fallbackTripFactExtraction(input.request);
    const state: TripDraftState = {
      ...structuredClone(EMPTY_TRIP_DRAFT_STATE),
      tripType: input.tripType
        ?? (resolved.legs.length > 1 ? "multi_city" : facts.tripType ?? "one_way"),
      legs: resolved.legs,
      travellers: facts.travellers,
      cabin: facts.cabin,
      maxStops: facts.maxStops,
      currency: facts.currency,
      maximumPrice: facts.maximumPrice,
      preferredAirlines: facts.preferredAirlines,
      excludedAirlines: facts.excludedAirlines
    };
    const result = await this.#prepareTurn(
      userId,
      input.request,
      sourceMessageId,
      draftId,
      false,
      state
    );
    if (!result) throw new Error("A structured trip-planning request was not handled");
    return result;
  }

  async #prepareTurn(
    userId: string,
    request: string,
    sourceMessageId: string | null,
    draftId: string | undefined,
    allowUnhandled: boolean,
    structuredState?: TripDraftState
  ): Promise<TripPlanResult | null> {
    const now = this.#now();
    const user = await this.#store.getUser(userId);
    const timeZone = user?.timezone ?? "UTC";
    const constraintSet = structuredState
      ? null
      : await this.#interpretItineraryConstraints({ userId, request, now, timeZone });
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
    const turn = structuredState || compiledConstraints || acceptProposedWindows || declineProposedWindows
      ? null
      : await this.#interpret({
        userId,
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
    // A question about a trip that already exists is not a request for a new
    // one. Without this, a turn carrying no route or date opens an empty
    // draft, the reducer finds nothing to set, and the traveller is asked
    // where they are flying from — about a route Captain is already holding.
    // The freshly created draft is cancelled too: left open it would own the
    // next turn and ask the same question again.
    if (turn && turn.operations.length === 0 && isUncollectedDraft(draft)) {
      const activeTrip = await this.#store.getActiveTrip(userId);
      if (activeTrip) {
        await this.cancel(userId, draft.id, draft.revision);
        console.info(JSON.stringify({
          event: "captain.trip_plan_no_change",
          trip_id: activeTrip.id,
          turn_intent: turn.intent
        }));
        return { status: "no_trip_change", trip: activeTrip };
      }
    }
    const beforeHash = stableJson(draft.state);
    const reduced = structuredState
      ? { state: structuredClone(structuredState), appliedOperations: [], issue: null }
      : compiledConstraints
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
    // A country resolves to its primary airport, which is Captain's pick, not
    // the traveller's. Carry those codes on the draft so the confirmation can
    // mark them — an unmarked guess is how a whole leg goes to the wrong city.
    reduced.state = withAssumedAirports(reduced.state, request);
    // A place Captain could not place stops the turn here. Everything below
    // reads the route as settled, and a route missing one of its cities is
    // not a shorter trip — it is a different one that looks finished.
    const unresolvedPlaces = turn?.unresolvedPlaces ?? [];
    if (unresolvedPlaces.length > 0) {
      const revised = await this.#store.reviseTripPlanDraft(
        userId,
        draft.id,
        draft.revision,
        {
          status: "collecting",
          conversation,
          state: {
            ...reduced.state,
            questionsAsked: Math.min(
              MAX_CLARIFICATION_QUESTIONS,
              reduced.state.questionsAsked + 1
            )
          },
          confirmationSnapshot: null,
          sourceMessageIds
        },
        now
      );
      if (!revised) throw new Error("Trip draft changed while it was being prepared");
      return {
        status: "needs_input",
        draft: revised,
        prompt: unresolvedPlacePrompt(unresolvedPlaces),
        missingFields: ["destinationAirports"]
      };
    }
    const unresolvedFields = missingTripFields(reduced.state, null);
    const canReviewWithDateAssumptions = unresolvedFields.length > 0
      && unresolvedFields.every((field) => ASSUMABLE_DATE_FIELDS.has(field));
    const clarificationCeilingReached =
      reduced.state.questionsAsked >= MAX_CLARIFICATION_QUESTIONS;
    const readinessApproved = canReviewWithDateAssumptions
      && (
        clarificationCeilingReached
        || (
          !reduced.issue
          && !compiledConstraints
          && await this.#assessReadiness({
            userId,
            request,
            conversation,
            state: reduced.state,
            missingFields: unresolvedFields
          })
        )
      );
    // Readiness is the primary gate. The question count remains only as a
    // safety ceiling so a traveller cannot get trapped in clarification.
    let state = readinessApproved
      ? fillDateAssumptions(reduced.state, now, timeZone)
      : reduced.state;
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
    const missingFields = missingTripFields(state, null, readinessApproved);
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
    // Only the replacement prompt is more than one turn; everything else is a
    // single message that happens to be a one-element list.
    const needsTripClarification = Boolean(
      !confirmationSnapshot
      && !tripLimitReached
      && !unsupportedParty
      && !unsupportedCurrency
    );
    const questionLimitReached = needsTripClarification
      && state.questionsAsked >= MAX_CLARIFICATION_QUESTIONS;
    const basePromptParts = !confirmationSnapshot || tripLimitReached
      ? tripLimitReached
        ? replacementPrompt(activeTrips[0]!, confirmationSnapshot!)
        : [unsupportedParty
            ? "Captain’s beta currently tracks fares for exactly one adult. Reply “just me” to continue, or cancel this trip."
            : unsupportedCurrency
              ? SUPPORTED_CURRENCY_MESSAGE
              : questionLimitReached
                ? ambiguityLimitPrompt(missingFields)
                : reduced.issue ?? clarificationPrompt(missingFields, state)]
      : null;
    if (needsTripClarification && !questionLimitReached) {
      state = {
        ...state,
        questionsAsked: Math.min(
          MAX_CLARIFICATION_QUESTIONS,
          state.questionsAsked + 1
        )
      };
    }
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
      readiness_approved: readinessApproved,
      clarification_ceiling_reached: clarificationCeilingReached,
      date_conflict: Boolean(reduced.issue),
      turn_intent: structuredState
        ? "structured_legs"
        : compiledConstraints
        ? "compile_constraints"
        : acceptProposedWindows
          ? "accept_proposed_search_windows"
          : declineProposedWindows
            ? "decline_proposed_search_windows"
          : turn!.intent,
      operation_types: structuredState
        ? ["set_structured_legs"]
        : compiledConstraints
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
        prompt: basePromptParts!.join("\n\n"),
        ...(basePromptParts!.length > 1 ? { promptParts: basePromptParts! } : {}),
        missingFields
      };
    }
    // A clarification answer is enough consent to save the reviewable draft;
    // a fully specified one-turn request still exposes the confirmation
    // snapshot to non-chat callers. Telegram turns that snapshot into the same
    // saved Review / Confirm checkpoint before it posts anything.
    if (state.questionsAsked > 0) {
      const started = await this.confirm(userId, revised.id, revised.revision);
      if (started.status !== "started" || !reduced.issue) return started;
      return {
        ...started,
        message: `${reduced.issue}\n\n${started.message}`
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
    // Exact receipt copy matches CREATION_SUCCESS_PATTERNS. Wrapped or lightly
    // edited receipts still start from "Itinerary ready to confirm." somewhere
    // in the body and name the trip id in the dashboard URL.
    const itineraryReceipt = /(?:^|\n)Itinerary ready to confirm\./iu.test(message);
    if (
      !CREATION_SUCCESS_PATTERNS.some((pattern) => pattern.test(message))
      && !itineraryReceipt
    ) {
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
    if (itineraryReceipt && trimmed.includes(trip.id)) {
      return { message: createdMessage, createdTrip: true };
    }
    return { message: UNGROUNDED_CREATION_MESSAGE, createdTrip: false };
  }

  /**
   * The planning service owns the confirmation wording and the instructions
   * ask the model to return it verbatim, but nothing enforced that — so a
   * paraphrase reached a traveller with the “(default)” markers stripped off
   * the values Captain had assumed rather than been told. They confirmed a
   * plan whose guesses were invisible.
   *
   * A bulleted restatement of a pending plan is replaced with the canonical
   * text. Prose is left alone: the model still owns the conversation around
   * the plan, just not the plan itself.
   */
  async enforceVerbatimPlanText(userId: string, message: string): Promise<string> {
    const draft = await this.findOpen(userId);
    if (draft?.status !== "awaiting_confirmation" || !draft.confirmationSnapshot) {
      return message;
    }
    const canonical = formatTripPlanConfirmation(draft);
    if (message.trim() === canonical.trim()) return message;
    // Soft schedule proposals while Create/Cancel is pending are restatements
    // of the plan. Leaving them through is how “Does that schedule work?” then
    // “Yes” created a partial trip instead of showing the confirmation card.
    if (
      countBulletLines(message) < MIN_PLAN_RESTATEMENT_BULLETS
      && !looksLikeScheduleProposal(message)
    ) {
      return message;
    }
    console.info(JSON.stringify({
      event: "captain.trip_plan_paraphrase_replaced",
      draft_id: draft.id,
      revision: draft.revision
    }));
    return canonical;
  }

  async lastAssistantAskedForPlanConsent(userId: string): Promise<boolean> {
    const conversation = await this.#store.getConversation(userId, 8);
    const lastAssistant = [...conversation.recentMessages]
      .reverse()
      .find((entry) => entry.role === "assistant");
    // Channel button delivery and unit tests may confirm without a stored
    // assistant turn. Only block when the latest spoken turn was a soft ask.
    if (!lastAssistant) return true;
    return isExplicitPlanConsentPrompt(lastAssistant.content);
  }

  /**
   * The decisions a traveller makes *about* an open draft — confirm, cancel,
   * decline Captain's dates, consent to a replacement, keep both. These are
   * unambiguous words with one meaning each, so the channel answers them
   * directly and instantly.
   *
   * Everything else about a draft is interpretation and belongs to the agent.
   * The channel used to own that too, which is how “what's the best day to
   * fly that week” became a request to plan a new trip.
   */
  async handleDraftDecision(
    userId: string,
    request: string,
    sourceMessageId: string | null
  ): Promise<TripPlanResult | null> {
    const draft = await this.findOpen(userId);
    if (!draft) return null;
    return this.#draftDecision(draft, userId, request, sourceMessageId);
  }

  async #draftDecision(
    draft: TripPlanDraft,
    userId: string,
    request: string,
    sourceMessageId: string | null
  ): Promise<TripPlanResult | null> {
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
        // Same trap as Create/Cancel: “Yes” to a soft schedule must not archive
        // the active trip. Only an explicit replace-consent prompt counts.
        if (!(await this.lastAssistantAskedForPlanConsent(userId))) {
          return null;
        }
        const activeTrip = await this.#store.getActiveTrip(userId);
        if (activeTrip) {
          await this.#store.archiveTripForReplacement(userId, activeTrip.id, this.#now());
        }
        return this.#prepareTurn(userId, request, sourceMessageId, draft.id, false);
      }
    }
    if (draft.status === "awaiting_confirmation" && isTripConfirmationText(request)) {
      if (!(await this.lastAssistantAskedForPlanConsent(userId))) {
        return null;
      }
      return this.confirm(userId, draft.id, draft.revision);
    }
    // Captain's own date guesses are declinable wherever they appear, now that
    // they are composed straight into the plan rather than asked about first.
    // “No” to a window Captain chose means those dates, not the whole trip.
    if (
      canAcceptProposedWindows(draft.state)
      && DECLINE_PROPOSAL_PATTERN.test(request.trim())
    ) {
      return this.#prepareTurn(userId, request, sourceMessageId, draft.id, false);
    }
    if (CANCEL_PATTERN.test(request.trim())) {
      return this.cancel(userId, draft.id, draft.revision);
    }
    return null;
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
    const decision = await this.#draftDecision(draft, userId, request, sourceMessageId);
    if (decision) return decision;
    // Soft “Yes” after a schedule proposal must not revise or create against the
    // open draft here — Telegram hands that turn to the agent so prepare_trip
    // can receive the full grounded itinerary.
    if (
      (
        (draft.status === "awaiting_confirmation" && isTripConfirmationText(request))
        || (
          draft.status === "collecting"
          && draft.confirmationSnapshot
          && REPLACE_CONSENT_PATTERN.test(request.trim())
        )
      )
      && !(await this.lastAssistantAskedForPlanConsent(userId))
    ) {
      return null;
    }
    // There is nothing to confirm on a draft that is still being collected, and
    // no proposal for a “yes” to land on. Saying so and re-asking beats revising
    // the draft into the identical question the traveller is already looking at.
    if (
      isTripConfirmationText(request)
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

/**
 * Two turns, not one: a recap of the itinerary Captain read, then the question
 * about the trip that is already there. Bundled into a single message the
 * question arrives buried under a dozen dated bullets, which is where it is
 * least likely to be read and answered.
 */
function replacementPrompt(
  activeTrip: Trip,
  candidate: TripPlanConfirmationSnapshot
): string[] {
  const legs = candidate.input.brief.legs ?? [];
  // Captain's own limit, said in Captain's own voice. Pointing the traveller
  // at /feedback to ask for a second trip read like an internal note that
  // escaped, because that is what it was.
  const question = `You’re already tracking “${activeTrip.title}”. `
    + "I can only follow one trip at a time — should I swap it for this one?";
  if (legs.length === 0) return [question];
  return [
    [
      "I mapped the flights as:",
      ...legs.map((leg) =>
        `• ${leg.originAirports.join("/")} → ${leg.destinationAirports.join("/")}: `
        + formatPlanningWindow(leg.departureWindow)
        + (leg.arriveBy ? ` · arrive by ${formatCalendarDate(leg.arriveBy)}` : "")
      )
    ].join("\n"),
    question
  ];
}

function formatPlanningWindow(window: { start: string; end: string }): string {
  return window.start === window.end
    ? formatCalendarDate(window.start)
    : `${formatCalendarDate(window.start)} – ${formatCalendarDate(window.end)}`;
}

/** A draft that has collected nothing yet, so abandoning it loses nothing. */
function isUncollectedDraft(draft: TripPlanDraft): boolean {
  return draft.revision === 1 && draft.state.legs.length === 0;
}

/**
 * Enough bullets that the message is restating the plan rather than talking
 * about it. A conversational reply does not carry three of them; every
 * rendering of the plan carries far more.
 */
const MIN_PLAN_RESTATEMENT_BULLETS = 3;

function countBulletLines(message: string): number {
  return message
    .split("\n")
    .filter((line) => /^\s*[•*-]\s+\S/u.test(line))
    .length;
}

function looksLikeScheduleProposal(message: string): boolean {
  const text = message.trim();
  if (/does that schedule work/iu.test(text)) return true;
  if (/before I (?:price|search|book)/iu.test(text)) return true;
  const numberedLegs = text.match(/^\s*\d+\.\s+.+/gmu) ?? [];
  return numberedLegs.length >= 2
    && /(?:→|->|\bto\b)/iu.test(text);
}

/**
 * Records which of the draft's airports Captain inferred from a country name.
 * Codes accumulate across turns, because the country may have been named
 * several messages before the leg it produced reaches the confirmation, and
 * are kept only while they are still routed somewhere.
 */
function withAssumedAirports(state: TripDraftState, request: string): TripDraftState {
  const routed = new Set(state.legs.flatMap((leg) =>
    [...leg.originAirports, ...leg.destinationAirports]
  ));
  const assumed = new Set([
    ...state.assumedAirports,
    ...orderedAirportMentionsFromText(request)
      .filter((mention) => mention.assumed)
      .map((mention) => mention.code)
  ]);
  return {
    ...state,
    assumedAirports: [...assumed].filter((code) => routed.has(code)).slice(0, 6)
  };
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

function missingTripFields(
  state: TripDraftState,
  dateIssue: string | null,
  allowProposedDates = false
): string[] {
  const first = state.legs[0];
  const tripType = effectiveTripType(state);
  let missing: string[];
  if (tripType === "multi_city") {
    missing = [
      ...(!first || first.originAirports.length === 0 ? ["originAirports"] : []),
      ...(!state.legs.at(-1) || state.legs.at(-1)!.destinationAirports.length === 0
        ? ["destinationAirports"]
        : []),
      // Later wide gaps can use best-fit windows, but the first flight is a
      // high-value ambiguity worth a direct clarification before review.
      ...(state.legs.length < 2 || state.legs.some((leg, index) =>
        leg.originAirports.length === 0
        || leg.destinationAirports.length === 0
        || (leg.departure === null && leg.proposedDeparture === null)
        || (
          index === 0
          && leg.departure === null
          && Boolean(leg.proposedDeparture)
          && !allowProposedDates
        )
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
            && !(
              allowProposedDates
              && first?.proposedDeparture
            )
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
  // Below, only a multi-city brief carries `legs`. Reaching here with a
  // several-leg itinerary typed as anything else silently kept leg one and
  // dropped the rest, which is how a Marseille stop disappeared into a
  // London–Paris trip. `effectiveTripType` guarantees it; this says so.
  if (state.legs.length > 1 && tripType !== "multi_city" && !isReturnPair(state.legs)) {
    throw new Error("Cannot complete a multi-leg trip as a single-leg brief");
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
  if (missing.has("originAirports") && missing.has("destinationAirports")) {
    return "Where are you flying from and to?";
  }
  if (missing.has("originAirports")) return "Where are you flying from?";
  if (missing.has("destinationAirports")) return "Where would you like to fly to?";
  if (missing.has("departureDate")) {
    const first = state.legs[0];
    if (first?.proposedDeparture) {
      return `When can you fly ${formatDraftLegRoute(first)}?${first.arriveBy ? ` You need to arrive by ${formatCalendarDate(first.arriveBy)}.` : ""}`;
    }
    const selection = state.legs[0]?.departure;
    if (selection?.kind === "window") {
      return `Which exact departure date should I use within ${selection.start} to ${selection.end}?`;
    }
    return "What date would you like to depart?";
  }
  if (missing.has("returnDate")) return "What date would you like to return?";
  if (missing.has("itineraryLegs")) {
    const unresolved = state.legs.find((leg, index) =>
      !leg.departure
      && (
        !leg.proposedDeparture
        || index === 0
      )
    );
    if (unresolved) {
      const route = formatDraftLegRoute(unresolved);
      if (unresolved.proposedDeparture) {
        return `When can you fly ${route}?${unresolved.arriveBy ? ` You need to arrive by ${formatCalendarDate(unresolved.arriveBy)}.` : ""}`;
      }
      if (unresolved.feasibleDepartureWindow) {
        return `What seven-day window should I use for ${route} within ${formatShortWindow(unresolved.feasibleDepartureWindow)}?`;
      }
      return `When can you fly ${route}?${unresolved.arriveBy ? ` You need to arrive by ${formatCalendarDate(unresolved.arriveBy)}.` : ""}`;
    }
    // A leg Captain proposed a window for is never asked about: it is composed
    // into the plan and reviewed there.
    return "What departure window should I use for the next flight leg?";
  }
  return "What should I add to the trip?";
}

type StructuredLegError = { legIndex: number | null; field: string; message: string };

/**
 * Turns stated legs into draft legs, or says exactly what is wrong with them.
 *
 * Every message here is written for a caller to act on rather than to report:
 * a place that resolves to nothing says to go and find its airport, because
 * asking the traveller to name a city they already named is the behaviour
 * this replaced.
 */
function resolveStructuredLegs(
  legs: readonly StructuredTripLeg[],
  today: string
): { legs: TripDraftState["legs"] } | { errors: StructuredLegError[] } {
  const errors: StructuredLegError[] = [];
  const resolved = legs.map((leg, index) => {
    const legIndex = index + 1;
    const place = (value: string, field: "origin" | "destination"): string | null => {
      const code = airportCodeForLocation(value) ?? airportCodeForLocation(value.toUpperCase());
      if (!code) {
        errors.push({
          legIndex,
          field,
          message: `Leg ${legIndex} ${field} “${value}” resolved to no airport. `
            + "Search for the airport serving it and call again with the IATA code; "
            + "ask the traveller only if the search is inconclusive."
        });
      }
      return code;
    };
    const origin = place(leg.origin, "origin");
    const destination = place(leg.destination, "destination");
    if (origin && destination && origin === destination) {
      errors.push({
        legIndex,
        field: "destination",
        message: `Leg ${legIndex} departs and arrives at ${origin}. Give the city it actually flies to.`
      });
    }
    const window = leg.departureDate
      ? { start: leg.departureDate, end: leg.departureDate }
      : leg.departureWindow!;
    if (daysBetween(window.start, window.end) < 0) {
      errors.push({
        legIndex,
        field: "departureWindow",
        message: `Leg ${legIndex} has a departure window that ends before it starts.`
      });
    }
    if (daysBetween(today, window.start) < 0) {
      errors.push({
        legIndex,
        field: "departureDate",
        message: `Leg ${legIndex} departs ${window.start}, which is in the past. Today is ${today}.`
      });
    }
    if (leg.arriveBy && daysBetween(window.end, leg.arriveBy) < 0) {
      errors.push({
        legIndex,
        field: "arriveBy",
        message: `Leg ${legIndex} must arrive by ${leg.arriveBy} but cannot depart until ${window.end}.`
      });
    }
    return {
      originAirports: origin ? [origin] : [],
      destinationAirports: destination ? [destination] : [],
      departure: leg.departureDate
        ? { kind: "exact" as const, date: leg.departureDate }
        : {
            kind: "window" as const,
            start: window.start,
            end: window.end,
            source: "the window you agreed"
          },
      ...(leg.arriveBy ? { arriveBy: leg.arriveBy } : {})
    };
  });

  resolved.forEach((leg, index) => {
    const next = resolved[index + 1];
    if (!next || leg.destinationAirports.length === 0 || next.originAirports.length === 0) return;
    if (!next.originAirports.some((code) => leg.destinationAirports.includes(code))) {
      errors.push({
        legIndex: index + 2,
        field: "origin",
        message: `Leg ${index + 2} departs from ${next.originAirports.join("/")} but leg ${index + 1} `
          + `lands at ${leg.destinationAirports.join("/")}. Add the leg in between, or fix the city.`
      });
    }
    const previousStart = legStart(leg);
    const nextStart = legStart(next);
    if (previousStart && nextStart && daysBetween(previousStart, nextStart) < 0) {
      errors.push({
        legIndex: index + 2,
        field: "departureDate",
        message: `Leg ${index + 2} departs before leg ${index + 1}. Put the legs in the order they are flown.`
      });
    }
  });

  return errors.length > 0 ? { errors } : { legs: resolved };
}

function legStart(leg: TripDraftState["legs"][number]): string | null {
  const selection = leg.departure;
  if (!selection) return null;
  return selection.kind === "exact" ? selection.date : selection.start;
}

/**
 * Asks about a place Captain could not place — with the answer already looked
 * for. A near-miss is usually a typo, and naming the city it probably meant
 * costs the traveller one word instead of an explanation.
 */
function unresolvedPlacePrompt(
  places: ReadonlyArray<{ text: string; suggestions: ReadonlyArray<{ code: string; label: string }> }>
): string {
  const [first] = places;
  if (!first) return "Which city should I add?";
  const others = places.slice(1).map((place) => place.text);
  const tail = others.length > 0
    ? ` I couldn’t place ${formatList(others)} either.`
    : "";
  if (first.suggestions.length === 1) {
    const [only] = first.suggestions;
    return `I don’t have an airport under “${first.text}” — did you mean ${only!.label} (${only!.code})?${tail}`;
  }
  if (first.suggestions.length > 1) {
    const options = first.suggestions.map((hit) => `${hit.label} (${hit.code})`);
    return `“${first.text}” could be ${formatList(options)}. Which one?${tail}`;
  }
  return `I can’t find an airport for “${first.text}”. What’s the nearest city you’d fly into, or its airport code?${tail}`;
}

function formatList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

function ambiguityLimitPrompt(missingFields: string[]): string {
  const missing = new Set(missingFields);
  if (missing.has("originAirports") && missing.has("destinationAirports")) {
    return "I still need a route before I can save a usable draft. Send it as “Lagos to Nairobi” and I’ll make the rest editable.";
  }
  if (missing.has("originAirports")) {
    return "I still need a departure city before I can save a usable draft. Send the city name and I’ll make the rest editable.";
  }
  if (missing.has("destinationAirports")) {
    return "I still need a destination before I can save a usable draft. Send the city name and I’ll make the rest editable.";
  }
  return "I couldn’t make a usable draft from those details. Send the route in one line and I’ll fill the remaining dates for you to edit.";
}

/** Fill date-only gaps once the draft is useful enough to review. */
function fillDateAssumptions(
  input: TripDraftState,
  now: Date,
  timeZone: string
): TripDraftState {
  const state = structuredClone(input);
  if (state.legs.length === 0) return state;
  const tripType = effectiveTripType(state);
  const today = localIsoDate(now, timeZone);

  if (tripType === "round_trip") {
    const first = state.legs[0]!;
    if (!first.departure) {
      first.departure = first.proposedDeparture ?? { kind: "exact", date: today };
      first.proposedDeparture = null;
    }
    const departure = selectionWindow(first)?.start ?? today;
    // Only a trip the traveller actually typed as a return gets a flight home
    // invented for it. `effectiveTripType` can read round_trip off a genuine
    // there-and-back pair, and that pair already has both legs.
    if (
      state.tripType === "round_trip"
      && state.legs.length < 2
      && first.originAirports.length
      && first.destinationAirports.length
    ) {
      state.legs.push({
        originAirports: [...first.destinationAirports],
        destinationAirports: [...first.originAirports],
        departure: { kind: "exact", date: addIsoDays(departure, 7) }
      });
    } else if (state.legs.at(-1) && !state.legs.at(-1)!.departure) {
      state.legs.at(-1)!.departure = {
        kind: "exact",
        date: addIsoDays(departure, 7)
      };
    }
    return state;
  }

  let cursor = today;
  state.legs.forEach((leg) => {
    const existing = selectionWindow(leg);
    if (existing) {
      cursor = existing.end;
      return;
    }
    const feasible = leg.feasibleDepartureWindow;
    const deadlineEnd = leg.arriveBy ? addIsoDays(leg.arriveBy, -1) : null;
    const end = feasible?.end ?? deadlineEnd ?? addIsoDays(cursor, 6);
    const candidateStart = feasible?.start ?? cursor;
    const start = daysBetween(candidateStart, end) > 6
      ? addIsoDays(end, -6)
      : candidateStart;
    if (daysBetween(start, end) < 0) return;
    leg.proposedDeparture = {
      kind: "window",
      start,
      end,
      source: "Captain’s best-fit draft window"
    };
    cursor = end;
  });
  return state;
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

/**
 * The legs are the itinerary; a stated trip type is a hint about them. A
 * `round_trip` inferred from one stray word used to outrank four legs and
 * collapse the trip to its first flight, so a stated type only survives when
 * the legs actually agree with it: two legs, the second reversing the first.
 */
function effectiveTripType(state: TripDraftState): "one_way" | "round_trip" | "multi_city" {
  if (state.legs.length > 1) {
    return state.tripType === "round_trip" && isReturnPair(state.legs)
      ? "round_trip"
      : "multi_city";
  }
  return state.tripType === "multi_city" ? "one_way" : state.tripType ?? "one_way";
}

/**
 * Two legs that are the same flight in both directions. A draft is still being
 * filled in while this runs, so a side nobody has named yet is unknown rather
 * than contradictory — the return leg of "Lagos to New York, back on the 24th"
 * has no destination until the origin city arrives.
 */
function isReturnPair(legs: TripDraftState["legs"]): boolean {
  if (legs.length !== 2) return false;
  const [outbound, inbound] = legs as [typeof legs[number], typeof legs[number]];
  return mirrors(outbound.originAirports, inbound.destinationAirports)
    && mirrors(outbound.destinationAirports, inbound.originAirports);
}

function mirrors(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  return left.length === right.length && left.every((code) => right.includes(code));
}

function exactDate(
  leg: TripDraftState["legs"][number] | undefined
): string | null {
  return leg?.departure?.kind === "exact" ? leg.departure.date : null;
}

function selectionWindow(
  leg: TripDraftState["legs"][number] | undefined
): { start: string; end: string } | null {
  const selection = leg?.departure ?? leg?.proposedDeparture ?? null;
  if (!selection) return null;
  return selection.kind === "exact"
    ? { start: selection.date, end: selection.date }
    : { start: selection.start, end: selection.end };
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
    version: trip.version,
    created,
    status: trip.status,
    title: trip.title,
    originAirports: trip.brief.originAirports,
    destinationAirports: trip.brief.destinationAirports,
    legs: trip.brief.legs?.map((leg) => ({
      originAirports: leg.originAirports,
      destinationAirports: leg.destinationAirports,
      departureDate: leg.departureWindow.start,
      departureWindow: leg.departureWindow
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
