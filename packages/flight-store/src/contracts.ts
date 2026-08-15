import type {
  CaptainSessionPath,
  CanonicalFlight,
  CreateTripInput,
  FlightOfferSnapshot,
  OfferSnapshot,
  SearchSpec,
  SearchSpecRequest,
  LegSearchSnapshot,
  LegSearchSnapshotRevision,
  TripGraph,
  TripCityLeg,
  TravellerProfile,
  UpdateTravellerProfile,
  Trip,
  TripAction,
  TripCreationResult,
  TripPlanDraft,
  TripPlanDraftRevision,
  UpdateTripBrief,
  UpdateTripTitle,
  Watch
} from "@agents/flight-domain";

export type CaptainUserStatus = "active" | "suspended";

export type CaptainUser = {
  id: string;
  status: CaptainUserStatus;
  timezone: string;
  telegramUserId: number;
  telegramChatId: number;
  displayName: string;
};

export class BetaCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`Captain's public beta is currently limited to ${limit} travellers`);
    this.name = "BetaCapacityError";
  }
}

export class BetaLaunchGateError extends Error {
  constructor() {
    super("Captain's public beta has not opened yet");
    this.name = "BetaLaunchGateError";
  }
}

export type TelegramUserInput = {
  telegramUserId: number;
  telegramChatId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

/**
 * Something durable about the traveller, learned from what they said rather
 * than set in preferences. Distinct from the conversation summary: a summary
 * decays with the chat, a fact outlives the trip it was learned on.
 */
export const TRAVELLER_FACT_KINDS = [
  "home_airport",
  "cabin_preference",
  "airline_affinity",
  "routine_route",
  "constraint",
  "context"
] as const;
export type TravellerFactKind = (typeof TRAVELLER_FACT_KINDS)[number];

export type TravellerFact = {
  id: string;
  kind: TravellerFactKind;
  value: string;
  /** Verbatim span from the traveller's own message that produced this fact. */
  evidence: string;
  sourceMessageId: string | null;
  status: "active" | "dismissed";
  createdAt: string;
  updatedAt: string;
};

export type TravellerFactInput = {
  kind: TravellerFactKind;
  value: string;
  evidence: string;
  sourceMessageId: string | null;
};

export type ConversationContext = {
  conversationId: string;
  summary: string;
  /** Null until a summary has ever been written. */
  summaryUpdatedAt: string | null;
  /** How far the summary consumed, so a turn can summarise only what is new. */
  summaryThroughMessageId: string | null;
  activeTripId: string | null;
  recentMessages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }>;
};

export const ONBOARDING_FOLLOWUP_STAGES = [
  { stage: "capabilities", delayMs: 6 * 60 * 60_000 },
  { stage: "workspace", delayMs: 24 * 60 * 60_000 },
  { stage: "commands", delayMs: 72 * 60 * 60_000 }
] as const;

export type OnboardingFollowupStage = typeof ONBOARDING_FOLLOWUP_STAGES[number]["stage"];

export type OnboardingEngagementReason =
  | "telegram_message"
  | "telegram_command"
  | "telegram_callback"
  | "workspace_opened"
  | "trip_activity";

export type ClaimedOnboardingFollowup = {
  userId: string;
  telegramChatId: number;
  stage: OnboardingFollowupStage;
  attempts: number;
  availableAt: string;
};

export type ClaimedSearchRun = {
  id: string;
  searchSpecId: string;
  request: SearchSpecRequest;
  attempt: number;
  leaseExpiresAt: string;
};

export type CompletedProviderOffer = Omit<OfferSnapshot, "id" | "searchRunId" | "searchSpecId">;

export type TripRecommendation = {
  tripId: string;
  offerId: string | null;
  searchSpecId: string | null;
  itineraryKey: string;
  score: number;
  price: number;
  currency: string;
  summary: string;
  observedAt: string;
  rankingMode: "cheapest" | "balanced" | "fastest";
  snapshot: RecommendationSnapshot;
};

export type RecommendationReasonCode =
  | "initial_verified_result"
  | "lower_price"
  | "shorter_duration"
  | "better_balance";

export type RecommendationSnapshot = {
  current: OfferSnapshot;
  previous: OfferSnapshot | null;
  rankingMode: "cheapest" | "balanced" | "fastest";
  reasonCodes: RecommendationReasonCode[];
  createdAt: string;
};

/**
 * The one flight a traveller chose to watch, with every price Captain has
 * observed for it. This is what the dashboard charts and what the agent reads
 * when it decides whether a change is worth mentioning.
 */
export type TrackedFlightPrices = {
  itineraryKey: string;
  currency: string;
  observations: Array<{ price: number; observedAt: string }>;
};

export type TripFlightSelection = {
  tripId: string;
  itineraryKey: string;
  selectedBy: "agent" | "person";
  selectedAt: string;
};

export type TripActivityChannel = "system" | "telegram" | "web";

export type TripActivity = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Rendered text when Captain spoke (Telegram or in-app). */
  body: string | null;
  channel: TripActivityChannel;
  notificationId: string | null;
  sourceMessageId: string | null;
};

export type CaptainNotification = {
  id: string;
  userId: string;
  tripId: string;
  telegramChatId: number;
  preferredLanguage?: string;
  preferredLanguageSource?: TravellerProfile["preferredLanguageSource"];
  kind:
    | "tracking_started"
    | "initial_results"
    | "price_drop"
    | "new_best"
    | "watch_attention"
    | "inventory_gap"
    | "price_rise"
    | "tracking_activation"
    | "tracking_summary"
    | "plan_changed"
    | "tracking_paused"
    | "tracking_resumed"
    | "trip_closed";
  payload: Record<string, unknown>;
  attempts: number;
  telegramMessageId: number | null;
};

export type TrackingMaintenance = {
  activated: number;
  completed: number;
};

export type MultiCityLegSearchRecording = {
  matched: number;
  notified: number;
};

export type ApplyTripActionOptions = {
  /** The Telegram channel already owns the acknowledgement for agent tool calls. */
  notifyCheckpoint?: boolean;
};

export type LoginTokenRecord = {
  userId: string;
  redirectPath: CaptainSessionPath;
};

export interface CaptainPlatformStore {
  ensureTelegramUser(input: TelegramUserInput, now: Date): Promise<CaptainUser>;
  getUser(userId: string): Promise<CaptainUser | null>;
  updateUserTimezone(userId: string, timeZone: string, now: Date): Promise<CaptainUser>;
  countUsers(): Promise<number>;
  deleteUser(userId: string): Promise<void>;
  clearTravellerData(userId: string, now: Date): Promise<void>;
  getProfile(userId: string): Promise<TravellerProfile | null>;
  ensureProfile(userId: string, now: Date): Promise<TravellerProfile>;
  updateProfile(
    userId: string,
    input: UpdateTravellerProfile & {
      onboardingStep?: TravellerProfile["onboardingStep"];
      onboardingCompletedAt?: string | null;
    },
    now: Date
  ): Promise<TravellerProfile>;
  claimDetectedLanguage(
    userId: string,
    language: string,
    now: Date
  ): Promise<{ claimed: boolean; profile: TravellerProfile }>;
  /**
   * Advances a traveller past the welcome step, returning true only for the
   * caller that won. Two updates arriving together must not both greet.
   */
  claimOnboardingWelcome(userId: string, now: Date): Promise<boolean>;
  /** Permanently suppresses every unsent onboarding follow-up in this cycle. */
  disableOnboardingFollowups(
    userId: string,
    reason: OnboardingEngagementReason,
    now: Date
  ): Promise<void>;
  /** Atomically leases at most one due follow-up per still-inactive traveller. */
  claimDueOnboardingFollowups(
    now: Date,
    leaseMs: number,
    limit: number
  ): Promise<ClaimedOnboardingFollowup[]>;
  /** Rechecks durable activity immediately before an external Telegram send. */
  revalidateOnboardingFollowup(
    userId: string,
    stage: OnboardingFollowupStage,
    now: Date
  ): Promise<boolean>;
  markOnboardingFollowupSent(
    userId: string,
    stage: OnboardingFollowupStage,
    telegramMessageId: number,
    body: string,
    now: Date
  ): Promise<void>;
  markOnboardingFollowupFailed(
    userId: string,
    stage: OnboardingFollowupStage,
    error: string,
    now: Date
  ): Promise<void>;
  createLoginToken(
    userId: string,
    tokenHash: string,
    redirectPath: LoginTokenRecord["redirectPath"],
    expiresAt: Date,
    now: Date
  ): Promise<void>;
  consumeLoginToken(tokenHash: string, now: Date): Promise<LoginTokenRecord | null>;
  createWebSession(userId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<void>;
  resolveWebSession(tokenHash: string, now: Date): Promise<string | null>;
  revokeWebSession(tokenHash: string, now: Date): Promise<void>;
  revokeUserSessions(userId: string, now: Date): Promise<void>;
  reserveDailyResponseBudget(now: Date, amount: number, limit: number): Promise<boolean>;
  recordWebSearchCalls(now: Date, count: number): Promise<void>;
  claimTelegramUpdate(updateKey: string, userId: string, now: Date): Promise<boolean>;
  getConversation(userId: string, limit?: number): Promise<ConversationContext>;
  /**
   * Replaces the rolling summary of everything older than the messages still
   * carried in context. `throughMessageId` records how far it consumed.
   */
  setConversationSummary(
    userId: string,
    summary: string,
    throughMessageId: string | null,
    now: Date
  ): Promise<void>;
  /** Active facts only, for injection into agent context. */
  listTravellerFacts(userId: string): Promise<TravellerFact[]>;
  /**
   * Upserts learned facts. A fact the traveller has dismissed is never
   * revived: dismissing it is a correction, and re-learning it from the same
   * words would make the correction impossible to make stick.
   */
  recordTravellerFacts(
    userId: string,
    facts: TravellerFactInput[],
    now: Date
  ): Promise<TravellerFact[]>;
  dismissTravellerFact(userId: string, factId: string, now: Date): Promise<boolean>;
  appendMessage(userId: string, role: "user" | "assistant", content: string, now: Date): Promise<string>;
  /**
   * Marks a notification delivered and appends the exact Telegram text to the
   * trip feed so outbound alerts are auditable beside lifecycle events.
   */
  markNotificationSent(
    notificationId: string,
    telegramMessageId: number,
    body: string,
    now: Date
  ): Promise<void>;
  setActiveTrip(userId: string, tripId: string | null, now: Date): Promise<void>;
  listTrips(userId: string): Promise<Trip[]>;
  getActiveTrip(userId: string): Promise<Trip | null>;
  getTrip(userId: string, tripId: string): Promise<Trip | null>;
  getTripById(tripId: string): Promise<Trip | null>;
  getTripGraph(userId: string, tripId: string): Promise<TripGraph>;
  getTripLeg(userId: string, tripId: string, legId: string): Promise<TripCityLeg | null>;
  createLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string,
    requestedWindow: { start: string; end: string },
    datesRequested: string[],
    now: Date
  ): Promise<LegSearchSnapshot>;
  reviseLegSearchSnapshot(
    userId: string,
    searchId: string,
    expectedRevision: number,
    revision: LegSearchSnapshotRevision,
    now: Date
  ): Promise<LegSearchSnapshot | null>;
  getLegSearchSnapshot(userId: string, searchId: string): Promise<LegSearchSnapshot | null>;
  getLatestLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string
  ): Promise<LegSearchSnapshot | null>;
  getCanonicalFlight(
    flightKey: string,
    now: Date
  ): Promise<{ flight: CanonicalFlight; offers: FlightOfferSnapshot[] } | null>;
  setTripLegFlight(
    userId: string,
    tripId: string,
    legId: string,
    flightKey: string | null,
    selectedBy: "agent" | "person",
    now: Date
  ): Promise<TripCityLeg>;
  getWatch(userId: string, tripId: string): Promise<Watch | null>;
  createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<TripCreationResult>;
  startTripTracking(
    userId: string,
    tripId: string,
    expectedVersion: number,
    specs: SearchSpec[],
    now: Date
  ): Promise<{ trip: Trip; watch: Watch }>;
  updateTripBrief(userId: string, tripId: string, input: UpdateTripBrief, specs: SearchSpec[], now: Date): Promise<Trip>;
  updateTripTitle(userId: string, tripId: string, input: UpdateTripTitle, now: Date): Promise<Trip>;
  archiveTripForReplacement(userId: string, tripId: string, now: Date): Promise<Trip>;
  applyTripAction(
    userId: string,
    tripId: string,
    action: TripAction,
    now: Date,
    options?: ApplyTripActionOptions
  ): Promise<Trip>;
  listTripActivity(userId: string, tripId: string): Promise<TripActivity[]>;
  listTripOffers(userId: string, tripId: string, now: Date): Promise<OfferSnapshot[]>;
  listTripFlightSelections(userId: string, tripId: string): Promise<TripFlightSelection[]>;
  setTripFlightSelection(
    userId: string,
    tripId: string,
    itineraryKey: string,
    selected: boolean,
    now: Date
  ): Promise<void>;
  markTripActivity(userId: string, tripId: string, now: Date): Promise<void>;
  hasDueWorkerWork(now: Date): Promise<boolean>;
  createTripPlanDraft(userId: string, request: string, sourceMessageId: string | null, now: Date): Promise<TripPlanDraft>;
  getTripPlanDraft(userId: string, draftId: string, now: Date): Promise<TripPlanDraft | null>;
  findOpenTripPlanDraft(userId: string, now: Date): Promise<TripPlanDraft | null>;
  reviseTripPlanDraft(userId: string, draftId: string, expectedRevision: number, revision: TripPlanDraftRevision, now: Date): Promise<TripPlanDraft | null>;
  cancelTripPlanDraft(userId: string, draftId: string, expectedRevision: number, now: Date): Promise<TripPlanDraft | null>;
  reopenTripPlanDraft(userId: string, draftId: string, expectedRevision: number, now: Date): Promise<TripPlanDraft | null>;
  confirmTripPlanDraft(userId: string, draftId: string, expectedRevision: number, specs: SearchSpec[], now: Date): Promise<{ draft: TripPlanDraft; result: TripCreationResult } | null>;
  scheduleDueSearchRuns(now: Date, freshnessMs: number, limit: number): Promise<number>;
  claimSearchRuns(workerId: string, now: Date, leaseMs: number, limit: number): Promise<ClaimedSearchRun[]>;
  completeSearchRun(workerId: string, runId: string, providerRequestId: string, offers: CompletedProviderOffer[], now: Date): Promise<void>;
  recordMultiCityLegSearchResult(
    searchSpecId: string,
    offers: CompletedProviderOffer[] | null,
    errorCode: string | null,
    now: Date
  ): Promise<MultiCityLegSearchRecording>;
  deferSearchRun(workerId: string, runId: string, until: Date, reason: string, now: Date): Promise<void>;
  failSearchRun(
    workerId: string,
    runId: string,
    error: string,
    retryAfterMs: number | null,
    retryable: boolean,
    now: Date
  ): Promise<boolean>;
  maintainTracking(now: Date): Promise<TrackingMaintenance>;
  finalizeFarFutureBaseline(searchSpecId: string, now: Date): Promise<void>;
  pruneWatchData(now: Date): Promise<void>;
  evaluateTripsForSearchSpec(searchSpecId: string, now: Date): Promise<number>;
  enqueueInventoryGapForSearchSpec(searchSpecId: string, now: Date): Promise<number>;
  listPendingNotifications(now: Date, limit: number): Promise<CaptainNotification[]>;
  markNotificationFailed(notificationId: string, error: string, now: Date): Promise<void>;
  getNotificationByTelegramMessage(
    userId: string,
    telegramMessageId: number
  ): Promise<CaptainNotification | null>;
  getRecommendation(userId: string, tripId: string): Promise<TripRecommendation | null>;
  /**
   * Price history for the watched flight, oldest first. Null when the
   * traveller has not picked one yet — there is nothing to chart until then.
   */
  getTrackedFlightPrices(userId: string, tripId: string): Promise<TrackedFlightPrices | null>;
  close(): Promise<void>;
}
