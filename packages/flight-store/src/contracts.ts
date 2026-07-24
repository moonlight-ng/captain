import type {
  CreateTripInput,
  OfferSnapshot,
  SearchSpec,
  SearchSpecRequest,
  Trip,
  TripAction,
  TripCreationResult,
  TripPlanDraft,
  TripPlanDraftRevision,
  UpdateTripInput,
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
};

export type TripFlightSelection = {
  tripId: string;
  itineraryKey: string;
  selectedBy: "agent" | "person";
  selectedAt: string;
};

export type CaptainNotification = {
  id: string;
  userId: string;
  tripId: string;
  telegramChatId: number;
  kind: "initial_results" | "price_drop" | "new_best" | "watch_attention";
  payload: Record<string, unknown>;
  attempts: number;
};

export interface CaptainPlatformStore {
  ensureTelegramUser(input: TelegramUserInput, now: Date): Promise<CaptainUser>;
  getUser(userId: string): Promise<CaptainUser | null>;
  claimTelegramUpdate(updateKey: string, userId: string, now: Date): Promise<boolean>;
  getConversation(userId: string, limit?: number): Promise<ConversationContext>;
  appendMessage(userId: string, role: "user" | "assistant", content: string, now: Date): Promise<string>;
  setActiveTrip(userId: string, tripId: string | null, now: Date): Promise<void>;
  listTrips(userId: string): Promise<Trip[]>;
  getTrip(userId: string, tripId: string): Promise<Trip | null>;
  getTripById(tripId: string): Promise<Trip | null>;
  getWatch(userId: string, tripId: string): Promise<Watch | null>;
  getTripByLegacyKey(userId: string, legacyAgentKey: string): Promise<Trip | null>;
  createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<TripCreationResult>;
  updateTrip(userId: string, tripId: string, input: UpdateTripInput, specs: SearchSpec[] | null, now: Date): Promise<Trip>;
  applyTripAction(userId: string, tripId: string, action: TripAction, now: Date): Promise<Trip>;
  listTripOffers(userId: string, tripId: string, now: Date): Promise<OfferSnapshot[]>;
  listTripFlightSelections(userId: string, tripId: string): Promise<TripFlightSelection[]>;
  setTripFlightSelection(
    userId: string,
    tripId: string,
    itineraryKey: string,
    selected: boolean,
    now: Date
  ): Promise<void>;
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
  failSearchRun(workerId: string, runId: string, error: string, retryAfterMs: number | null, now: Date): Promise<void>;
  pruneWatchData(now: Date): Promise<void>;
  evaluateTripsForSearchSpec(searchSpecId: string, now: Date): Promise<number>;
  listPendingNotifications(now: Date, limit: number): Promise<CaptainNotification[]>;
  markNotificationSent(notificationId: string, now: Date): Promise<void>;
  markNotificationFailed(notificationId: string, error: string, now: Date): Promise<void>;
  close(): Promise<void>;
}
