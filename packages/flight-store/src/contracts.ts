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

export type ConversationContext = {
  conversationId: string;
  summary: string;
  activeTripId: string | null;
  recentMessages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string }>;
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

export type TripActivity = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type CaptainNotification = {
  id: string;
  userId: string;
  tripId: string;
  telegramChatId: number;
  kind:
    | "initial_results"
    | "price_drop"
    | "new_best"
    | "watch_attention"
    | "inventory_gap"
    | "price_rise"
    | "tracking_activation"
    | "tracking_summary";
  payload: Record<string, unknown>;
  attempts: number;
  telegramMessageId: number | null;
};

export type TrackingMaintenance = {
  activated: number;
  completed: number;
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
  /**
   * Advances a traveller past the welcome step, returning true only for the
   * caller that won. Two updates arriving together must not both greet.
   */
  claimOnboardingWelcome(userId: string, now: Date): Promise<boolean>;
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
  appendMessage(userId: string, role: "user" | "assistant", content: string, now: Date): Promise<string>;
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
  applyTripAction(userId: string, tripId: string, action: TripAction, now: Date): Promise<Trip>;
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
  deferSearchRun(workerId: string, runId: string, until: Date, reason: string, now: Date): Promise<void>;
  failSearchRun(workerId: string, runId: string, error: string, retryAfterMs: number | null, now: Date): Promise<void>;
  maintainTracking(now: Date): Promise<TrackingMaintenance>;
  finalizeFarFutureBaseline(searchSpecId: string, now: Date): Promise<void>;
  pruneWatchData(now: Date): Promise<void>;
  evaluateTripsForSearchSpec(searchSpecId: string, now: Date): Promise<number>;
  enqueueInventoryGapForSearchSpec(searchSpecId: string, now: Date): Promise<number>;
  listPendingNotifications(now: Date, limit: number): Promise<CaptainNotification[]>;
  markNotificationSent(notificationId: string, telegramMessageId: number, now: Date): Promise<void>;
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
