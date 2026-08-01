import type {
  CaptainSessionPath,
  CreatePassengerInput,
  CreateTripInput,
  OfferSnapshot,
  Passenger,
  PaymentCardDeletion,
  PaymentCardSetupIntent,
  PaymentMethod,
  SavePaymentMethodInput,
  SearchSpec,
  SearchSpecRequest,
  TravellerProfile,
  UpdatePassengerInput,
  UpdateTravellerProfile,
  Trip,
  TripAction,
  TripCreationResult,
  TripPlanDraft,
  TripPlanDraftRevision,
  UpdateTripBrief,
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

export class PaymentSetupInProgressError extends Error {
  constructor() {
    super("A payment card setup is already in progress");
    this.name = "PaymentSetupInProgressError";
  }
}

export class PaymentMethodLimitError extends Error {
  constructor(readonly limit = 20) {
    super(`A traveller may have at most ${limit} payment method records`);
    this.name = "PaymentMethodLimitError";
  }
}

export class PaymentSetupConflictError extends Error {
  constructor(readonly code: "setup_intent_mismatch" | "card_pending_deletion" | "setup_intent_invalid") {
    super(code);
    this.name = "PaymentSetupConflictError";
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
  pendingDigestChange?: {
    current: OfferSnapshot;
    previous: OfferSnapshot;
    rankingMode: "cheapest" | "balanced" | "fastest";
    reasonCodes: RecommendationReasonCode[];
    createdAt: string;
  } | null;
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
    | "daily_digest"
    | "price_rise"
    | "tracking_activation"
    | "tracking_checkin"
    | "tracking_paused";
  payload: Record<string, unknown>;
  attempts: number;
  telegramMessageId: number | null;
};

export type TrackingMaintenance = {
  activated: number;
  checkInsQueued: number;
  autoPaused: number;
};

export type LoginTokenRecord = {
  userId: string;
  redirectPath: CaptainSessionPath;
};

export type TripPassengerAssignment = {
  passengerId: string;
  ordinal: number;
};

export interface CaptainPlatformStore {
  ensureTelegramUser(input: TelegramUserInput, now: Date): Promise<CaptainUser>;
  getUser(userId: string): Promise<CaptainUser | null>;
  updateUserTimezone(userId: string, timeZone: string, now: Date): Promise<CaptainUser>;
  countUsers(): Promise<number>;
  deleteUser(userId: string): Promise<void>;
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
  markTravellerSetupPrompted(userId: string, now: Date): Promise<boolean>;
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
  listPassengers(userId: string): Promise<Passenger[]>;
  getPassenger(userId: string, passengerId: string): Promise<Passenger | null>;
  createPassenger(userId: string, input: CreatePassengerInput, now: Date): Promise<Passenger>;
  updatePassenger(
    userId: string,
    passengerId: string,
    input: UpdatePassengerInput,
    now: Date
  ): Promise<Passenger>;
  deletePassenger(userId: string, passengerId: string): Promise<void>;
  setDefaultPassenger(userId: string, passengerId: string, now: Date): Promise<Passenger>;
  listTripPassengers(userId: string, tripId: string): Promise<Passenger[]>;
  setTripPassengers(userId: string, tripId: string, passengerIds: string[]): Promise<void>;
  listPaymentMethods(userId: string): Promise<PaymentMethod[]>;
  reservePaymentCardSetupIntent(
    userId: string,
    setupIntentId: string,
    now: Date
  ): Promise<PaymentCardSetupIntent>;
  finalizePaymentMethod(
    userId: string,
    input: SavePaymentMethodInput,
    now: Date
  ): Promise<PaymentMethod>;
  removePaymentMethod(userId: string, paymentMethodId: string, now: Date): Promise<void>;
  claimCardDeletions(
    workerId: string,
    now: Date,
    leaseMs: number,
    limit: number
  ): Promise<PaymentCardDeletion[]>;
  completeCardDeletion(workerId: string, deletionId: string, now: Date): Promise<boolean>;
  failCardDeletion(
    workerId: string,
    deletionId: string,
    errorCode: string,
    retryAfterMs: number | null,
    now: Date
  ): Promise<boolean>;
  countPendingCardDeletions(): Promise<{
    queued: number;
    running: number;
    highAttempts: number;
    oldestQueuedAgeMs: number | null;
  }>;
  cleanupPaymentCardSetupIntents(now: Date): Promise<number>;
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
  getWatch(userId: string, tripId: string): Promise<Watch | null>;
  createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<TripCreationResult>;
  updateTripBrief(userId: string, tripId: string, input: UpdateTripBrief, specs: SearchSpec[], now: Date): Promise<Trip>;
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
  respondToTrackingCheckIn(
    userId: string,
    tripId: string,
    action: "keep" | "pause",
    now: Date
  ): Promise<Trip>;
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
  enqueueDueDigests(now: Date): Promise<number>;
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
  close(): Promise<void>;
}
