import { randomUUID } from "node:crypto";

import {
  DEFAULT_PROFILE,
  checkpointNotificationKindForAction,
  cityLabelForAirportCodes,
  formatTripGoal,
  formatTripRoute,
  isCheckpointNotificationKind,
  isMaterialTripPlanChange,
  legSearchSnapshotSchema,
  MAX_MANUAL_SEARCH_DAYS,
  MAX_ACTIVE_TRIPS_PER_USER,
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  EMPTY_TRIP_DRAFT_STATE,
  type CanonicalFlight,
  type CheckpointNotificationKind,
  type CreateTripInput,
  type FlightOfferSnapshot,
  type LegSearchSnapshot,
  type LegSearchSnapshotRevision,
  type OfferSnapshot,
  type TripCreationResult,
  type TripPlanDraft,
  type TripPlanDraftRevision,
  type TravellerProfile,
  type UpdateTravellerProfile,
  type UpdateTripBrief,
  type UpdateTripTitle,
  type SearchSpec,
  type Trip,
  type TripAction,
  type TripBrief,
  type TripCity,
  type TripCityLeg,
  type Watch,
  type TripGraph,
  type CaptainSessionPath
} from "@agents/flight-domain";

import type {
  ApplyTripActionOptions,
  CaptainNotification,
  CaptainPlatformStore,
  CaptainUser,
  ClaimedOnboardingFollowup,
  ClaimedSearchRun,
  CompletedProviderOffer,
  ConversationContext,
  TravellerFact,
  TravellerFactInput,
  TelegramUserInput,
  TrackingMaintenance,
  MultiCityLegSearchRecording,
  TripFlightSelection,
  TrackedFlightPrices,
  TripActivity,
  TripRecommendation
} from "./contracts.js";
import {
  BetaCapacityError,
  BetaLaunchGateError,
  ONBOARDING_FOLLOWUP_STAGES,
  type OnboardingEngagementReason,
  type OnboardingFollowupStage
} from "./contracts.js";
import { matchingMultiCityLegs, multiCityLegRevision } from "./multi-city-results.js";
import {
  notificationGoalPayload,
  offerDateSummary,
  offerRangeSummary,
  type OfferDateSummary,
  type OfferRangeSummary
} from "./notification-payload.js";
import {
  meetsAlertThreshold,
  rankOffers,
  recommendationReasonCodes,
  recommendationSummary
} from "./ranking.js";
import {
  CURRENT_OFFER_RETENTION_MS,
  DISCOVERY_SEARCH_SPEC_LIMIT,
  retainSearchOffers,
  TRACKING_SEARCH_SPEC_LIMIT,
  TRACKING_CHECK_INTERVAL_MS,
  trackingRunEndsAt
} from "./watch-policy.js";

function truncateErrorDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.slice(0, 500);
}

type MemoryConversation = ConversationContext & { userId: string };
type MemoryRun = ClaimedSearchRun & {
  status: "queued" | "running" | "completed" | "failed" | "deferred";
  claimedBy: string | null;
  scheduledAt: string;
  completedAt: string | null;
  error: string | null;
};
type StoredNotification = CaptainNotification & {
  status: "pending" | "sent" | "failed" | "superseded";
  availableAt: string;
  createdAt: string;
  dedupKey: string;
  error: string | null;
};
type StoredLoginToken = {
  userId: string;
  redirectPath: CaptainSessionPath;
  expiresAt: string;
  consumedAt: string | null;
};
type StoredWebSession = {
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
};
type StoredOnboardingFollowup = {
  userId: string;
  stage: OnboardingFollowupStage;
  position: number;
  sequenceStartedAt: string;
  availableAt: string;
  status: "pending" | "sending" | "sent" | "cancelled" | "failed";
  attempts: number;
  leaseExpiresAt: string | null;
  telegramMessageId: number | null;
  deliveredAt: string | null;
  disabledAt: string | null;
  disabledReason: OnboardingEngagementReason | null;
  error: string | null;
};

export class MemoryCaptainPlatformStore implements CaptainPlatformStore {
  readonly #usersByTelegram = new Map<number, CaptainUser>();
  readonly #profiles = new Map<string, TravellerProfile>();
  readonly #loginTokens = new Map<string, StoredLoginToken>();
  readonly #webSessions = new Map<string, StoredWebSession>();
  readonly #onboardingFollowups = new Map<string, StoredOnboardingFollowup>();
  readonly #apiUsage = new Map<string, { responses: number; webSearchCalls: number }>();
  readonly #updates = new Map<string, string>();
  readonly #conversations = new Map<string, MemoryConversation>();
  readonly #travellerFacts = new Map<string, TravellerFact[]>();
  readonly #trips = new Map<string, Trip>();
  readonly #tripGraphs = new Map<string, TripGraph>();
  readonly #legSearchSnapshots = new Map<string, LegSearchSnapshot>();
  readonly #watches = new Map<string, Watch>();
  readonly #specs = new Map<string, SearchSpec>();
  readonly #watchSpecs = new Map<string, Set<string>>();
  readonly #runs = new Map<string, MemoryRun>();
  readonly #offers = new Map<string, OfferSnapshot>();
  readonly #priceHistory: Array<{
    itineraryKey: string;
    price: number;
    currency: string;
    observedAt: string;
  }> = [];
  readonly #recommendations = new Map<string, TripRecommendation>();
  readonly #personSelections = new Map<string, Map<string, string>>();
  readonly #notifications = new Map<string, StoredNotification>();
  readonly #tripActivity = new Map<string, TripActivity[]>();
  readonly #tripPlanDrafts = new Map<string, TripPlanDraft>();
  readonly #tripPlanConfirmations = new Map<
    string,
    Promise<{ draft: TripPlanDraft; result: TripCreationResult } | null>
  >();
  async ensureTelegramUser(input: TelegramUserInput, now: Date): Promise<CaptainUser> {
    const existing = this.#usersByTelegram.get(input.telegramUserId);
    if (existing) {
      const updated = {
        ...existing,
        telegramChatId: input.telegramChatId,
        displayName: displayName(input)
      };
      this.#usersByTelegram.set(input.telegramUserId, updated);
      return clone(updated);
    }
    if (!publicBetaEnabled()) throw new BetaLaunchGateError();
    const betaLimit = positiveInteger(process.env.CAPTAIN_BETA_USER_LIMIT, 25);
    if (this.#usersByTelegram.size >= betaLimit) throw new BetaCapacityError(betaLimit);
    const user: CaptainUser = {
      id: randomUUID(),
      status: "active",
      timezone: "UTC",
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
      displayName: displayName(input)
    };
    this.#usersByTelegram.set(input.telegramUserId, user);
    this.#conversations.set(user.id, {
      userId: user.id,
      conversationId: randomUUID(),
      summary: "",
      summaryUpdatedAt: null,
      summaryThroughMessageId: null,
      activeTripId: null,
      recentMessages: []
    });
    void now;
    return clone(user);
  }

  async getUser(userId: string): Promise<CaptainUser | null> {
    return clone([...this.#usersByTelegram.values()].find((user) => user.id === userId) ?? null);
  }

  async updateUserTimezone(userId: string, timeZone: string, _now: Date): Promise<CaptainUser> {
    const entry = [...this.#usersByTelegram.entries()]
      .find(([, user]) => user.id === userId);
    if (!entry) throw new Error("User not found");
    const updated = { ...entry[1], timezone: timeZone };
    this.#usersByTelegram.set(entry[0], updated);
    return clone(updated);
  }

  async countUsers(): Promise<number> {
    return this.#usersByTelegram.size;
  }

  async deleteUser(userId: string): Promise<void> {
    for (const [telegramId, user] of this.#usersByTelegram) {
      if (user.id === userId) this.#usersByTelegram.delete(telegramId);
    }
    this.#profiles.delete(userId);
    for (const [key, followup] of this.#onboardingFollowups) {
      if (followup.userId === userId) this.#onboardingFollowups.delete(key);
    }
    this.#conversations.delete(userId);
    for (const [updateKey, ownerId] of this.#updates) {
      if (ownerId === userId) this.#updates.delete(updateKey);
    }
    for (const [hash, token] of this.#loginTokens) if (token.userId === userId) this.#loginTokens.delete(hash);
    for (const [hash, session] of this.#webSessions) if (session.userId === userId) this.#webSessions.delete(hash);
    // The conversation is already gone, so this leaves nothing to point at a
    // trip that no longer exists.
    this.#clearTrips(userId);
  }

  async clearTravellerData(userId: string, now: Date): Promise<void> {
    const current = await this.ensureProfile(userId, now);
    this.#profiles.set(userId, {
      ...current,
      ...DEFAULT_PROFILE,
      preferredAirlineCodes: [],
      excludedAirlineCodes: [],
      onboardingStep: "welcome",
      onboardingCompletedAt: null,
      updatedAt: now.toISOString()
    });
    this.#clearTrips(userId);
    for (const [key, followup] of this.#onboardingFollowups) {
      if (followup.userId === userId) this.#onboardingFollowups.delete(key);
    }
    this.#travellerFacts.delete(userId);
    const conversation = this.#conversations.get(userId);
    if (conversation) {
      this.#conversations.set(userId, {
        ...conversation,
        summary: "",
        summaryUpdatedAt: null,
        summaryThroughMessageId: null,
        activeTripId: null,
        recentMessages: []
      });
    }
  }

  /**
   * Every trip a traveller owns, and everything hanging off it. Shared search
   * data—specs, runs, offers, price history—is not one traveller's to delete,
   * so it stays. The account and profile survive too: only the traveller's
   * own trips go.
   */
  #clearTrips(userId: string): void {
    const tripIds = new Set(
      [...this.#trips.values()].filter((trip) => trip.userId === userId).map((trip) => trip.id)
    );
    for (const tripId of tripIds) {
      this.#trips.delete(tripId);
      this.#tripGraphs.delete(tripId);
      for (const [searchId, snapshot] of this.#legSearchSnapshots) {
        if (snapshot.tripId === tripId) this.#legSearchSnapshots.delete(searchId);
      }
      this.#recommendations.delete(tripId);
      this.#personSelections.delete(tripId);
      this.#tripActivity.delete(tripId);
    }
    for (const [watchId, watch] of this.#watches) {
      if (tripIds.has(watch.tripId)) {
        this.#watches.delete(watchId);
        this.#watchSpecs.delete(watchId);
      }
    }
    for (const [id, notification] of this.#notifications) if (notification.userId === userId) this.#notifications.delete(id);
    for (const [id, draft] of this.#tripPlanDrafts) {
      if (draft.userId === userId) {
        this.#tripPlanDrafts.delete(id);
        this.#tripPlanConfirmations.delete(id);
      }
    }
    const conversation = this.#conversations.get(userId);
    if (conversation) this.#conversations.set(userId, { ...conversation, activeTripId: null });
  }

  async getProfile(userId: string): Promise<TravellerProfile | null> {
    return clone(this.#profiles.get(userId) ?? null);
  }

  async ensureProfile(userId: string, now: Date): Promise<TravellerProfile> {
    const existing = this.#profiles.get(userId);
    if (existing) return clone(existing);
    if (!await this.getUser(userId)) throw new Error("User not found");
    const timestamp = now.toISOString();
    const profile: TravellerProfile = {
      userId,
      ...DEFAULT_PROFILE,
      preferredAirlineCodes: [],
      excludedAirlineCodes: [],
      onboardingCompletedAt: null,
      onboardingStep: "welcome",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.#profiles.set(userId, profile);
    return clone(profile);
  }

  async updateProfile(
    userId: string,
    input: UpdateTravellerProfile & {
      onboardingStep?: TravellerProfile["onboardingStep"];
      onboardingCompletedAt?: string | null;
    },
    now: Date
  ): Promise<TravellerProfile> {
    const current = await this.ensureProfile(userId, now);
    const updated: TravellerProfile = {
      ...current,
      ...(input.defaultCurrency !== undefined ? { defaultCurrency: input.defaultCurrency } : {}),
      ...(input.rankingMode !== undefined ? { rankingMode: input.rankingMode } : {}),
      ...(input.preferredAirlineCodes !== undefined
        ? { preferredAirlineCodes: clone(input.preferredAirlineCodes) }
        : {}),
      ...(input.excludedAirlineCodes !== undefined
        ? { excludedAirlineCodes: clone(input.excludedAirlineCodes) }
        : {}),
      ...(input.alertsEnabled !== undefined ? { alertsEnabled: input.alertsEnabled } : {}),
      ...(input.notificationMode !== undefined ? { notificationMode: input.notificationMode } : {}),
      ...(input.notificationMode !== undefined
        ? { alertsEnabled: input.notificationMode !== "off" }
        : input.alertsEnabled !== undefined
          ? { notificationMode: input.alertsEnabled ? "changes_only" as const : "off" as const }
        : {}),
      ...(input.priceRiseAlertsEnabled !== undefined
        ? { priceRiseAlertsEnabled: input.priceRiseAlertsEnabled }
        : {}),
      ...(input.betterOptionAlertsEnabled !== undefined
        ? { betterOptionAlertsEnabled: input.betterOptionAlertsEnabled }
        : {}),
      ...(input.maxAlertsPerDay !== undefined ? { maxAlertsPerDay: input.maxAlertsPerDay } : {}),
      ...(input.quietHoursEnabled !== undefined
        ? { quietHoursEnabled: input.quietHoursEnabled }
        : {}),
      ...(input.quietHoursStart !== undefined ? { quietHoursStart: input.quietHoursStart } : {}),
      ...(input.quietHoursEnd !== undefined ? { quietHoursEnd: input.quietHoursEnd } : {}),
      ...(input.onboardingStep !== undefined ? { onboardingStep: input.onboardingStep } : {}),
      ...(input.onboardingCompletedAt !== undefined
        ? { onboardingCompletedAt: input.onboardingCompletedAt }
        : {}),
      updatedAt: now.toISOString()
    };
    this.#profiles.set(userId, updated);
    // Turning notifications off retires anything already queued for delivery.
    if (updated.notificationMode === "off") {
      for (const [notificationId, notification] of this.#notifications) {
        if (notification.userId === userId && notification.status === "pending") {
          this.#notifications.set(notificationId, { ...notification, status: "superseded" });
        }
      }
    }
    const activeTrips = [...this.#trips.values()]
      .filter((trip) => trip.userId === userId && isActiveTripStatus(trip.status));
    for (const active of activeTrips) {
      const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === active.id);
      if (watch) {
        for (const specId of this.#watchSpecs.get(watch.id) ?? []) {
          await this.evaluateTripsForSearchSpec(specId, now);
        }
      }
    }
    return clone(updated);
  }

  async createLoginToken(
    userId: string,
    tokenHash: string,
    redirectPath: CaptainSessionPath,
    expiresAt: Date,
    now: Date
  ): Promise<void> {
    if (!await this.getUser(userId)) throw new Error("User not found");
    this.#loginTokens.set(tokenHash, {
      userId,
      redirectPath,
      expiresAt: expiresAt.toISOString(),
      consumedAt: null
    });
    void now;
  }

  async consumeLoginToken(tokenHash: string, now: Date) {
    const token = this.#loginTokens.get(tokenHash);
    if (!token || token.consumedAt || token.expiresAt <= now.toISOString()) return null;
    token.consumedAt = now.toISOString();
    return { userId: token.userId, redirectPath: token.redirectPath };
  }

  async createWebSession(userId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<void> {
    if (!await this.getUser(userId)) throw new Error("User not found");
    this.#webSessions.set(tokenHash, { userId, expiresAt: expiresAt.toISOString(), revokedAt: null });
    void now;
  }

  async resolveWebSession(tokenHash: string, now: Date): Promise<string | null> {
    const session = this.#webSessions.get(tokenHash);
    return session && !session.revokedAt && session.expiresAt > now.toISOString() ? session.userId : null;
  }

  async revokeWebSession(tokenHash: string, now: Date): Promise<void> {
    const session = this.#webSessions.get(tokenHash);
    if (session) session.revokedAt = now.toISOString();
  }

  async revokeUserSessions(userId: string, now: Date): Promise<void> {
    for (const session of this.#webSessions.values()) {
      if (session.userId === userId) session.revokedAt = now.toISOString();
    }
  }

  async claimOnboardingWelcome(userId: string, now: Date): Promise<boolean> {
    await this.ensureProfile(userId, now);
    const profile = this.#profiles.get(userId);
    if (!profile || profile.onboardingCompletedAt || profile.onboardingStep !== "welcome") {
      return false;
    }
    profile.onboardingStep = "complete";
    profile.onboardingCompletedAt = now.toISOString();
    profile.updatedAt = now.toISOString();
    const user = await this.getUser(userId);
    if (!user) throw new Error("User not found");
    for (const [index, followup] of ONBOARDING_FOLLOWUP_STAGES.entries()) {
      const baseDue = new Date(now.getTime() + followup.delayMs);
      const availableAt = deliveryTime(baseDue, user.timezone, profile);
      this.#onboardingFollowups.set(onboardingFollowupKey(userId, followup.stage), {
        userId,
        stage: followup.stage,
        position: index + 1,
        sequenceStartedAt: now.toISOString(),
        availableAt: availableAt.toISOString(),
        status: "pending",
        attempts: 0,
        leaseExpiresAt: null,
        telegramMessageId: null,
        deliveredAt: null,
        disabledAt: null,
        disabledReason: null,
        error: null
      });
    }
    return true;
  }

  async disableOnboardingFollowups(
    userId: string,
    reason: OnboardingEngagementReason,
    now: Date
  ): Promise<void> {
    for (const [key, followup] of this.#onboardingFollowups) {
      if (followup.userId !== userId || !["pending", "sending"].includes(followup.status)) continue;
      this.#onboardingFollowups.set(key, {
        ...followup,
        status: "cancelled",
        leaseExpiresAt: null,
        disabledAt: now.toISOString(),
        disabledReason: reason,
        error: null
      });
    }
  }

  async claimDueOnboardingFollowups(
    now: Date,
    leaseMs: number,
    limit: number
  ): Promise<ClaimedOnboardingFollowup[]> {
    const nowIso = now.toISOString();
    for (const [key, followup] of this.#onboardingFollowups) {
      if (
        followup.status === "sending"
        && followup.leaseExpiresAt !== null
        && followup.leaseExpiresAt <= nowIso
      ) {
        this.#onboardingFollowups.set(key, {
          ...followup,
          status: followup.attempts >= 3 ? "failed" : "pending",
          leaseExpiresAt: null
        });
      }
    }
    for (const userId of new Set([...this.#onboardingFollowups.values()].map((item) => item.userId))) {
      const reason = this.#onboardingActivityReason(userId);
      if (reason) {
        await this.disableOnboardingFollowups(userId, reason, now);
      }
    }
    const firstDueByUser = new Map<string, StoredOnboardingFollowup>();
    for (const followup of [...this.#onboardingFollowups.values()]
      .filter((item) =>
        item.status === "pending"
        && item.availableAt <= nowIso
        && ![...this.#onboardingFollowups.values()].some((earlier) =>
          earlier.userId === item.userId
          && earlier.position < item.position
          && ["pending", "sending"].includes(earlier.status)
        )
      )
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.position - right.position)) {
      if (!firstDueByUser.has(followup.userId)) firstDueByUser.set(followup.userId, followup);
    }
    const claimed: ClaimedOnboardingFollowup[] = [];
    for (const followup of [...firstDueByUser.values()].slice(0, Math.max(0, limit))) {
      const next = {
        ...followup,
        status: "sending" as const,
        attempts: followup.attempts + 1,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString()
      };
      this.#onboardingFollowups.set(onboardingFollowupKey(followup.userId, followup.stage), next);
      const user = await this.getUser(followup.userId);
      if (!user) continue;
      claimed.push({
        userId: followup.userId,
        telegramChatId: user.telegramChatId,
        stage: followup.stage,
        attempts: next.attempts,
        availableAt: followup.availableAt
      });
    }
    return claimed;
  }

  async revalidateOnboardingFollowup(
    userId: string,
    stage: OnboardingFollowupStage,
    now: Date
  ): Promise<boolean> {
    const reason = this.#onboardingActivityReason(userId);
    if (reason) {
      await this.disableOnboardingFollowups(userId, reason, now);
      return false;
    }
    return this.#onboardingFollowups.get(onboardingFollowupKey(userId, stage))?.status === "sending";
  }

  async markOnboardingFollowupSent(
    userId: string,
    stage: OnboardingFollowupStage,
    telegramMessageId: number,
    body: string,
    now: Date
  ): Promise<void> {
    const key = onboardingFollowupKey(userId, stage);
    const followup = this.#onboardingFollowups.get(key);
    if (!followup || followup.status !== "sending") return;
    this.#onboardingFollowups.set(key, {
      ...followup,
      status: "sent",
      leaseExpiresAt: null,
      telegramMessageId,
      deliveredAt: now.toISOString(),
      error: null
    });
    await this.appendMessage(userId, "assistant", body, now);
  }

  async markOnboardingFollowupFailed(
    userId: string,
    stage: OnboardingFollowupStage,
    error: string,
    now: Date
  ): Promise<void> {
    const key = onboardingFollowupKey(userId, stage);
    const followup = this.#onboardingFollowups.get(key);
    if (!followup || followup.status !== "sending") return;
    this.#onboardingFollowups.set(key, {
      ...followup,
      status: followup.attempts >= 3 ? "failed" : "pending",
      availableAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      leaseExpiresAt: null,
      error: error.slice(0, 500)
    });
  }

  async reserveDailyResponseBudget(now: Date, amount: number, limit: number): Promise<boolean> {
    const date = now.toISOString().slice(0, 10);
    const usage = this.#apiUsage.get(date) ?? { responses: 0, webSearchCalls: 0 };
    if (usage.responses + amount > limit) return false;
    usage.responses += amount;
    this.#apiUsage.set(date, usage);
    return true;
  }

  async recordWebSearchCalls(now: Date, count: number): Promise<void> {
    const date = now.toISOString().slice(0, 10);
    const usage = this.#apiUsage.get(date) ?? { responses: 0, webSearchCalls: 0 };
    usage.webSearchCalls += Math.max(0, count);
    this.#apiUsage.set(date, usage);
  }

  async claimTelegramUpdate(updateKey: string, userId: string, now: Date): Promise<boolean> {
    if (this.#updates.has(updateKey)) return false;
    this.#updates.set(updateKey, userId);
    void now;
    return true;
  }

  async getConversation(userId: string, limit = 20): Promise<ConversationContext> {
    const conversation = this.#conversations.get(userId);
    if (!conversation) throw new Error("Conversation not found");
    return clone({
      ...conversation,
      recentMessages: limit === 0 ? [] : conversation.recentMessages.slice(-limit)
    });
  }

  async listTravellerFacts(userId: string): Promise<TravellerFact[]> {
    return clone((this.#travellerFacts.get(userId) ?? [])
      .filter((fact) => fact.status === "active")
      .sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.createdAt.localeCompare(right.createdAt)
      ));
  }

  async recordTravellerFacts(
    userId: string,
    facts: TravellerFactInput[],
    now: Date
  ): Promise<TravellerFact[]> {
    const existing = this.#travellerFacts.get(userId) ?? [];
    const recorded: TravellerFact[] = [];
    for (const fact of facts) {
      const match = existing.find((candidate) =>
        candidate.kind === fact.kind && candidate.value === fact.value
      );
      // A dismissed fact stays dismissed — the traveller's correction outranks
      // Captain hearing the same sentence a second time.
      if (match?.status === "dismissed") continue;
      if (match) {
        match.evidence = fact.evidence;
        match.sourceMessageId = fact.sourceMessageId;
        match.updatedAt = now.toISOString();
        recorded.push(clone(match));
        continue;
      }
      const created: TravellerFact = {
        id: randomUUID(),
        kind: fact.kind,
        value: fact.value,
        evidence: fact.evidence,
        sourceMessageId: fact.sourceMessageId,
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      existing.push(created);
      recorded.push(clone(created));
    }
    this.#travellerFacts.set(userId, existing);
    return recorded;
  }

  async dismissTravellerFact(userId: string, factId: string, now: Date): Promise<boolean> {
    const fact = (this.#travellerFacts.get(userId) ?? [])
      .find((candidate) => candidate.id === factId && candidate.status === "active");
    if (!fact) return false;
    fact.status = "dismissed";
    fact.updatedAt = now.toISOString();
    return true;
  }

  async setConversationSummary(
    userId: string,
    summary: string,
    throughMessageId: string | null,
    now: Date
  ): Promise<void> {
    const conversation = this.#conversations.get(userId);
    if (!conversation) throw new Error("Conversation not found");
    conversation.summary = summary;
    conversation.summaryUpdatedAt = now.toISOString();
    conversation.summaryThroughMessageId = throughMessageId;
  }

  async appendMessage(userId: string, role: "user" | "assistant", content: string, now: Date): Promise<string> {
    const conversation = this.#conversations.get(userId);
    if (!conversation) throw new Error("Conversation not found");
    const id = randomUUID();
    const trimmed = content.trim();
    conversation.recentMessages.push({ id, role, content: trimmed, createdAt: now.toISOString() });
    void now;
    // Chat stays in messages — freeform assistant replies are not trip checkpoints.
    return id;
  }

  async setActiveTrip(userId: string, tripId: string | null, now: Date): Promise<void> {
    const conversation = this.#conversations.get(userId);
    if (!conversation) throw new Error("Conversation not found");
    if (tripId && this.#trips.get(tripId)?.userId !== userId) throw new TripNotFoundError();
    conversation.activeTripId = tripId;
    void now;
  }

  async archiveTripForReplacement(userId: string, tripId: string, now: Date): Promise<Trip> {
    const trip = this.#requiredTrip(userId, tripId);
    const timestamp = now.toISOString();
    const archived: Trip = {
      ...trip,
      status: "archived",
      version: trip.version + 1,
      archivedAt: timestamp,
      archiveReason: "replaced",
      updatedAt: timestamp
    };
    this.#trips.set(tripId, archived);
    const conversation = this.#conversations.get(userId);
    if (conversation?.activeTripId === tripId) conversation.activeTripId = null;
    const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === tripId);
    if (watch) {
      this.#watches.set(watch.id, {
        ...watch,
        status: "completed",
        nextCheckAt: null,
        completedAt: watch.completedAt ?? timestamp,
        updatedAt: timestamp
      });
    }
    this.#recordTripActivity(tripId, "trip_replaced", {}, now);
    return clone(archived);
  }

  async listTrips(userId: string): Promise<Trip[]> {
    return [...this.#trips.values()].filter((trip) => trip.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(clone);
  }

  async getActiveTrip(userId: string): Promise<Trip | null> {
    const conversation = this.#conversations.get(userId);
    const selected = conversation?.activeTripId
      ? this.#trips.get(conversation.activeTripId)
      : null;
    if (selected?.userId === userId && isActiveTripStatus(selected.status)) {
      return clone(selected);
    }
    return clone([...this.#trips.values()]
      .filter((trip) => trip.userId === userId && isActiveTripStatus(trip.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null);
  }

  async getTrip(userId: string, tripId: string): Promise<Trip | null> {
    const trip = this.#trips.get(tripId);
    return trip?.userId === userId ? clone(trip) : null;
  }

  async getTripById(tripId: string): Promise<Trip | null> {
    return clone(this.#trips.get(tripId) ?? null);
  }

  async getTripGraph(userId: string, tripId: string): Promise<TripGraph> {
    this.#requiredTrip(userId, tripId);
    return clone(this.#tripGraphs.get(tripId) ?? { cities: [], legs: [] });
  }

  async getTripLeg(
    userId: string,
    tripId: string,
    legId: string
  ): Promise<TripCityLeg | null> {
    if (this.#trips.get(tripId)?.userId !== userId) return null;
    return clone(this.#tripGraphs.get(tripId)?.legs.find((leg) => leg.id === legId) ?? null);
  }

  async createLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string,
    requestedWindow: { start: string; end: string },
    datesRequested: string[],
    now: Date
  ): Promise<LegSearchSnapshot> {
    this.#requiredTrip(userId, tripId);
    const graph = this.#tripGraphs.get(tripId);
    const leg = graph?.legs.find((candidate) => candidate.id === legId);
    if (!graph || !leg) throw new TripNotFoundError();
    assertLegSearchRequest(leg, requestedWindow, datesRequested);
    const timestamp = now.toISOString();
    const snapshot: LegSearchSnapshot = {
      id: randomUUID(),
      tripId,
      legId,
      revision: 1,
      status: "queued",
      requestedWindow: clone(requestedWindow),
      analysis: {
        complete: false,
        datesRequested: clone(datesRequested),
        datesCompleted: [],
        failedDates: [],
        optionsChecked: 0,
        cheapest: null,
        fastest: null,
        balanced: null,
        cheapestByDate: [],
        observedAt: null
      },
      flights: [],
      offers: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    };
    this.#legSearchSnapshots.set(snapshot.id, snapshot);
    leg.latestSearchId = snapshot.id;
    return clone(snapshot);
  }

  async reviseLegSearchSnapshot(
    userId: string,
    searchId: string,
    expectedRevision: number,
    revision: LegSearchSnapshotRevision,
    now: Date
  ): Promise<LegSearchSnapshot | null> {
    const current = this.#legSearchSnapshots.get(searchId);
    if (!current || current.revision !== expectedRevision) return null;
    const trip = this.#trips.get(current.tripId);
    if (!trip || trip.userId !== userId) return null;
    assertLegSearchRevision(revision);
    const updated: LegSearchSnapshot = {
      ...current,
      ...clone(revision),
      revision: current.revision + 1,
      updatedAt: now.toISOString()
    };
    const parsed = legSearchSnapshotSchema.parse(updated);
    this.#legSearchSnapshots.set(searchId, parsed);
    return clone(parsed);
  }

  async getLegSearchSnapshot(
    userId: string,
    searchId: string
  ): Promise<LegSearchSnapshot | null> {
    const snapshot = this.#legSearchSnapshots.get(searchId);
    return clone(snapshot && this.#trips.get(snapshot.tripId)?.userId === userId ? snapshot : null);
  }

  async getLatestLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string
  ): Promise<LegSearchSnapshot | null> {
    const leg = await this.getTripLeg(userId, tripId, legId);
    return leg?.latestSearchId
      ? this.getLegSearchSnapshot(userId, leg.latestSearchId)
      : null;
  }

  async setTripLegFlight(
    userId: string,
    tripId: string,
    legId: string,
    flightKey: string | null,
    now: Date
  ): Promise<TripCityLeg> {
    const trip = this.#requiredTrip(userId, tripId);
    const graph = this.#tripGraphs.get(tripId);
    const leg = graph?.legs.find((candidate) => candidate.id === legId);
    if (!graph || !leg) throw new TripNotFoundError();
    if (flightKey && ![...this.#legSearchSnapshots.values()].some((snapshot) =>
      snapshot.tripId === tripId
      && snapshot.legId === legId
      && snapshot.flights.some((flight) => flight.key === flightKey)
    )) {
      throw new Error("Flight not found for Trip leg");
    }
    leg.selectedFlightKey = flightKey;
    this.#trips.set(tripId, {
      ...trip,
      version: trip.version + 1,
      updatedAt: now.toISOString()
    });
    this.#recordTripActivity(
      tripId,
      flightKey ? "trip_leg_flight_selected" : "trip_leg_flight_unselected",
      { legId, flightKey },
      now
    );
    return clone(leg);
  }

  async getCanonicalFlight(
    flightKey: string,
    now: Date
  ): Promise<{ flight: CanonicalFlight; offers: FlightOfferSnapshot[] } | null> {
    const snapshots = [...this.#legSearchSnapshots.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const flight = snapshots
      .flatMap((snapshot) => snapshot.flights)
      .find((candidate) => candidate.key === flightKey);
    if (!flight) return null;
    const current = snapshots
      .flatMap((snapshot) => snapshot.offers)
      .filter((offer) =>
        offer.flightKey === flightKey
        && (!offer.expiresAt || Date.parse(offer.expiresAt) > now.getTime())
      );
    return {
      flight: clone(flight),
      offers: clone(dedupeFlightOffers(current))
    };
  }

  async getWatch(userId: string, tripId: string): Promise<Watch | null> {
    if (this.#trips.get(tripId)?.userId !== userId) return null;
    return clone([...this.#watches.values()].find((watch) => watch.tripId === tripId) ?? null);
  }

  async createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<TripCreationResult> {
    if (!await this.getUser(userId)) throw new Error("User not found");
    const duplicate = [...this.#trips.values()].find((trip) =>
      trip.userId === userId
      && isActiveTripStatus(trip.status)
      && JSON.stringify(trip.brief) === JSON.stringify(input.brief)
    );
    if (duplicate) {
      await this.setActiveTrip(userId, duplicate.id, now);
      return clone({
        trip: duplicate,
        watch: [...this.#watches.values()].find((watch) => watch.tripId === duplicate.id) ?? null,
        created: false
      });
    }
    const active = [...this.#trips.values()].filter((trip) => trip.userId === userId && isActiveTripStatus(trip.status));
    if (active.length >= MAX_ACTIVE_TRIPS_PER_USER) throw new TripLimitError();
    const timestamp = now.toISOString();
    const trip: Trip = {
      id: randomUUID(), userId, title: input.title, status: "draft", version: 1,
      brief: clone(input.brief), archivedAt: null, archiveReason: null,
      createdAt: timestamp, updatedAt: timestamp
    };
    this.#trips.set(trip.id, trip);
    this.#tripGraphs.set(trip.id, materializeTripGraph(trip.id, input.brief));
    this.#recordTripActivity(trip.id, "trip_created", clone(input), now);
    await this.setActiveTrip(userId, trip.id, now);
    void specs;
    return clone({
      trip,
      watch: null,
      created: true
    });
  }

  async startTripTracking(
    userId: string,
    tripId: string,
    expectedVersion: number,
    specs: SearchSpec[],
    now: Date
  ): Promise<{ trip: Trip; watch: Watch }> {
    const trip = this.#requiredTrip(userId, tripId);
    const existingWatch = [...this.#watches.values()].find((watch) => watch.tripId === tripId);
    if (
      ["tracking", "recommended"].includes(trip.status)
      && existingWatch
      && ["active", "scheduled"].includes(existingWatch.status)
    ) {
      return clone({ trip, watch: existingWatch });
    }
    if (trip.version !== expectedVersion) throw new TripVersionConflictError(trip.version);
    if (trip.status !== "draft") throw new Error("Only a reviewed draft can start tracking");
    if (specs.length === 0) throw new Error("Tracking needs at least one flight search specification");

    const timestamp = now.toISOString();
    const updated: Trip = {
      ...trip,
      status: "tracking",
      version: trip.version + 1,
      updatedAt: timestamp
    };
    const watch: Watch = existingWatch
      ? {
          ...existingWatch,
          status: "active",
          runStartedAt: timestamp,
          runEndsAt: trackingRunEndsAt(now, trip.brief.departureWindow.start).toISOString(),
          completedAt: null,
          checksCompleted: 0,
          nextCheckAt: timestamp,
          trackingStartsAt: null,
          baselineCompletedAt: null,
          activatedAt: timestamp,
          lastUserActivityAt: timestamp,
          priceRiseItineraryKey: null,
          priceRiseArmed: true,
          delayedAt: null,
          delayReason: null,
          updatedAt: timestamp
        }
      : {
          id: randomUUID(),
          tripId,
          status: "active",
          runStartedAt: timestamp,
          runEndsAt: trackingRunEndsAt(now, trip.brief.departureWindow.start).toISOString(),
          completedAt: null,
          checksCompleted: 0,
          nextCheckAt: timestamp,
          lastCheckAt: null,
          lastManualRefreshAt: null,
          trackingStartsAt: null,
          baselineCompletedAt: null,
          activatedAt: timestamp,
          lastUserActivityAt: timestamp,
          priceRiseItineraryKey: null,
          priceRiseArmed: true,
          delayedAt: null,
          delayReason: null,
          createdAt: timestamp,
          updatedAt: timestamp
        };
    this.#trips.set(tripId, updated);
    this.#watches.set(watch.id, watch);
    this.#setSpecs(watch.id, specs);
    const checkpointKey = `${tripId}:tracking_started:${updated.version}`;
    this.#recordTripActivity(tripId, "trip_tracking_started", {
      tripVersion: updated.version,
      checkpointKey
    }, now);
    this.#enqueueTrackingStartedNotification(updated, checkpointKey, now);
    return clone({ trip: updated, watch });
  }

  async updateTripBrief(
    userId: string,
    tripId: string,
    input: UpdateTripBrief,
    specs: SearchSpec[],
    now: Date
  ): Promise<Trip> {
    const trip = this.#requiredTrip(userId, tripId);
    if (trip.version !== input.expectedVersion) throw new TripVersionConflictError(trip.version);
    const material = isMaterialTripPlanChange(trip.brief, input.brief);
    const updated: Trip = {
      ...trip,
      brief: clone(input.brief),
      status: "draft",
      version: trip.version + 1,
      updatedAt: now.toISOString()
    };
    this.#trips.set(tripId, updated);
    this.#tripGraphs.set(tripId, materializeTripGraph(tripId, input.brief));
    for (const [searchId, snapshot] of this.#legSearchSnapshots) {
      if (snapshot.tripId === tripId) this.#legSearchSnapshots.delete(searchId);
    }
    this.#recommendations.delete(tripId);
    const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === tripId);
    if (watch) {
      this.#watches.set(watch.id, {
        ...watch,
        status: "completed",
        completedAt: now.toISOString(),
        nextCheckAt: null,
        lastUserActivityAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
    }
    void specs;
    if (material) {
      const checkpointKey = `${tripId}:plan_changed:${updated.version}`;
      this.#recordTripActivity(tripId, "trip_plan_changed", {
        ...clone(input.brief),
        tripVersion: updated.version,
        checkpointKey
      }, now);
      this.#enqueueCheckpointAck(updated, checkpointNotificationKindForAction("plan_changed"), {
        eventType: "trip_plan_changed",
        tripTitle: updated.title,
        tripRoute: formatTripRoute(updated.brief),
        tripVersion: updated.version,
        checkpointKey
      }, now, checkpointKey);
    }
    return clone(updated);
  }

  async updateTripTitle(
    userId: string,
    tripId: string,
    input: UpdateTripTitle,
    now: Date
  ): Promise<Trip> {
    const trip = this.#requiredTrip(userId, tripId);
    if (trip.version !== input.expectedVersion) throw new TripVersionConflictError(trip.version);
    const updated: Trip = {
      ...trip,
      title: input.title,
      version: trip.version + 1,
      updatedAt: now.toISOString()
    };
    this.#trips.set(tripId, updated);
    this.#recordTripActivity(tripId, "trip_title_updated", { title: input.title }, now);
    return clone(updated);
  }

  async createTripPlanDraft(
    userId: string,
    request: string,
    sourceMessageId: string | null,
    now: Date
  ): Promise<TripPlanDraft> {
    const existing = await this.findOpenTripPlanDraft(userId, now);
    if (existing) return existing;
    const concurrentlyCreated = [...this.#tripPlanDrafts.values()]
      .filter((draft) => draft.userId === userId)
      .map((draft) => this.#expireDraft(draft, now))
      .find((draft) => ["collecting", "awaiting_confirmation", "starting"].includes(draft.status));
    if (concurrentlyCreated) return clone(concurrentlyCreated);
    const timestamp = now.toISOString();
    const draft: TripPlanDraft = {
      id: randomUUID(),
      userId,
      status: "collecting",
      revision: 1,
      conversation: [request.trim()],
      state: clone(EMPTY_TRIP_DRAFT_STATE),
      confirmationSnapshot: null,
      sourceMessageIds: sourceMessageId ? [sourceMessageId] : [],
      tripId: null,
      createIdempotencyKey: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString()
    };
    this.#tripPlanDrafts.set(draft.id, draft);
    return clone(draft);
  }

  async getTripPlanDraft(userId: string, draftId: string, now: Date): Promise<TripPlanDraft | null> {
    const draft = this.#tripPlanDrafts.get(draftId);
    if (!draft || draft.userId !== userId) return null;
    return clone(this.#expireDraft(draft, now));
  }

  async findOpenTripPlanDraft(userId: string, now: Date): Promise<TripPlanDraft | null> {
    const open = [...this.#tripPlanDrafts.values()]
      .filter((draft) => draft.userId === userId)
      .map((draft) => this.#expireDraft(draft, now))
      .filter((draft) => ["collecting", "awaiting_confirmation", "starting"].includes(draft.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return clone(open ?? null);
  }

  async reviseTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    revision: TripPlanDraftRevision,
    now: Date
  ): Promise<TripPlanDraft | null> {
    return this.#updateTripPlanDraft(userId, draftId, expectedRevision, revision, now, ["collecting", "awaiting_confirmation"]);
  }

  async cancelTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    now: Date
  ): Promise<TripPlanDraft | null> {
    return this.#updateTripPlanDraft(userId, draftId, expectedRevision, { status: "cancelled" }, now, ["collecting", "awaiting_confirmation"]);
  }

  async reopenTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    now: Date
  ): Promise<TripPlanDraft | null> {
    return this.#updateTripPlanDraft(userId, draftId, expectedRevision, { status: "collecting" }, now, ["awaiting_confirmation"]);
  }

  async confirmTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    specs: SearchSpec[],
    now: Date
  ): Promise<{ draft: TripPlanDraft; result: TripCreationResult } | null> {
    const pending = this.#tripPlanConfirmations.get(draftId);
    if (pending) return reusedConfirmation(await pending);
    const current = await this.getTripPlanDraft(userId, draftId, now);
    if (!current) return null;
    const concurrentlyStarted = this.#tripPlanConfirmations.get(draftId);
    if (concurrentlyStarted) return reusedConfirmation(await concurrentlyStarted);
    if (current.status === "started" && current.tripId) {
      const trip = await this.getTrip(userId, current.tripId);
      const watch = trip ? await this.getWatch(userId, trip.id) : null;
      return trip ? { draft: current, result: { trip, watch, created: false } } : null;
    }
    if (
      current.status !== "awaiting_confirmation"
      || current.revision !== expectedRevision
      || !current.confirmationSnapshot
    ) return null;
    const starting = this.#updateTripPlanDraft(
      userId,
      draftId,
      expectedRevision,
      {
        status: "starting",
        createIdempotencyKey: `trip-plan:${draftId}:${expectedRevision}`
      },
      now,
      ["awaiting_confirmation"]
    );
    if (!starting) return null;
    const confirmation = (async () => {
      try {
        const result = await this.createTrip(
          userId,
          current.confirmationSnapshot!.input,
          specs,
          now
        );
        const started = this.#updateTripPlanDraft(
          userId,
          draftId,
          starting.revision,
          { status: "started", tripId: result.trip.id },
          now,
          ["starting"]
        );
        return started ? { draft: started, result } : null;
      } catch (error) {
        const failed = this.#tripPlanDrafts.get(draftId);
        if (
          failed?.userId === userId
          && failed.status === "starting"
          && failed.revision === starting.revision
        ) {
          this.#tripPlanDrafts.set(draftId, clone(current));
        }
        throw error;
      }
    })();
    this.#tripPlanConfirmations.set(draftId, confirmation);
    try {
      return await confirmation;
    } finally {
      if (this.#tripPlanConfirmations.get(draftId) === confirmation) {
        this.#tripPlanConfirmations.delete(draftId);
      }
    }
  }

  async applyTripAction(
    userId: string,
    tripId: string,
    action: TripAction,
    now: Date,
    options: ApplyTripActionOptions = {}
  ): Promise<Trip> {
    const trip = this.#requiredTrip(userId, tripId);
    if (trip.version !== action.expectedVersion) throw new TripVersionConflictError(trip.version);
    const watch = [...this.#watches.values()].find((item) => item.tripId === tripId);
    let status = trip.status;
    if (action.type === "pause") status = "paused";
    if (["resume", "refresh", "track"].includes(action.type)) {
      status = trip.status === "draft" && action.type !== "track" ? "draft" : "tracking";
    }
    if (action.type === "cancel") status = "cancelled";
    if (action.type === "complete") status = "completed";
    const updated = { ...trip, status, version: trip.version + 1, updatedAt: now.toISOString() };
    this.#trips.set(tripId, updated);
    if (watch) {
      const watchStatus = status === "paused"
        ? "paused"
        : ["cancelled", "completed"].includes(status)
          ? "completed"
          : "active";
      this.#watches.set(watch.id, {
        ...watch,
        status: watchStatus,
        ...(action.type === "track"
          ? {
              runStartedAt: now.toISOString(),
              runEndsAt: trackingRunEndsAt(now, updated.brief.departureWindow.start).toISOString(),
              completedAt: null,
              checksCompleted: 0,
              nextCheckAt: now.toISOString(),
              activatedAt: now.toISOString(),
              delayedAt: null,
              delayReason: null
            }
          : action.type === "refresh" || action.type === "resume"
            ? { nextCheckAt: now.toISOString() }
            : ["cancel", "complete"].includes(action.type)
              ? { completedAt: watch.completedAt ?? now.toISOString(), nextCheckAt: null }
              : {}),
        ...(action.type === "refresh" ? { lastManualRefreshAt: now.toISOString() } : {}),
        lastUserActivityAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
    }
    const checkpointKey = action.type === "cancel" || action.type === "complete"
      ? `${tripId}:trip_closed:${updated.version}`
      : `${tripId}:trip_${action.type}:${updated.version}`;
    this.#recordTripActivity(tripId, `trip_${action.type}`, {
      ...clone(action),
      tripVersion: updated.version,
      checkpointKey
    }, now);
    if (
      options.notifyCheckpoint !== false
      && (action.type === "pause" || action.type === "resume")
    ) {
      this.#enqueueCheckpointAck(updated, checkpointNotificationKindForAction(action.type), {
        eventType: `trip_${action.type}`,
        tripTitle: updated.title,
        tripRoute: formatTripRoute(updated.brief),
        tripVersion: updated.version,
        checkpointKey
      }, now, checkpointKey);
    } else if (
      options.notifyCheckpoint !== false
      && (action.type === "cancel" || action.type === "complete")
    ) {
      this.#enqueueCheckpointAck(updated, checkpointNotificationKindForAction(action.type), {
        eventType: `trip_${action.type}`,
        tripTitle: updated.title,
        tripRoute: formatTripRoute(updated.brief),
        tripVersion: updated.version,
        reason: action.type,
        checkpointKey
      }, now, checkpointKey);
    }
    return clone(updated);
  }

  async listTripActivity(userId: string, tripId: string): Promise<TripActivity[]> {
    this.#requiredTrip(userId, tripId);
    return clone(this.#tripActivity.get(tripId) ?? []);
  }

  async listTripOffers(userId: string, tripId: string, now: Date): Promise<OfferSnapshot[]> {
    this.#requiredTrip(userId, tripId);
    const watch = [...this.#watches.values()].find((item) => item.tripId === tripId);
    const specIds = watch ? this.#watchSpecs.get(watch.id) ?? new Set<string>() : new Set<string>();
    return [...this.#offers.values()]
      .filter((offer) => specIds.has(offer.searchSpecId) && (!offer.expiresAt || offer.expiresAt > now.toISOString()))
      .sort((a, b) => a.price - b.price)
      .map(clone);
  }

  async getTrackedFlightPrices(userId: string, tripId: string): Promise<TrackedFlightPrices | null> {
    this.#requiredTrip(userId, tripId);
    const watched = [...(this.#personSelections.get(tripId) ?? new Map<string, string>())]
      .sort((left, right) => right[1].localeCompare(left[1]))[0]?.[0];
    if (!watched) return null;
    const observations = this.#priceHistory
      .filter((observation) => observation.itineraryKey === watched)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    const currency = observations.at(-1)?.currency
      ?? this.#recommendations.get(tripId)?.currency
      ?? "USD";
    return {
      itineraryKey: watched,
      currency,
      observations: observations
        .filter((observation) => observation.currency === currency)
        .map((observation) => ({ price: observation.price, observedAt: observation.observedAt }))
    };
  }

  async listTripFlightSelections(userId: string, tripId: string): Promise<TripFlightSelection[]> {
    this.#requiredTrip(userId, tripId);
    const recommendation = this.#recommendations.get(tripId);
    const agentSelections: TripFlightSelection[] = recommendation ? [{
      tripId,
      itineraryKey: recommendation.itineraryKey,
      selectedBy: "agent",
      selectedAt: recommendation.observedAt
    }] : [];
    const personSelections = [...(this.#personSelections.get(tripId) ?? new Map<string, string>())]
      .map(([itineraryKey, selectedAt]): TripFlightSelection => ({
        tripId,
        itineraryKey,
        selectedBy: "person",
        selectedAt
      }));
    // Newest first, matching the Postgres ordering, with a deterministic
    // tiebreak so an agent and a person selection made in the same instant
    // cannot swap between reads.
    const selections = [...agentSelections, ...personSelections].sort((left, right) =>
      right.selectedAt.localeCompare(left.selectedAt)
      || left.selectedBy.localeCompare(right.selectedBy)
      || left.itineraryKey.localeCompare(right.itineraryKey));
    return clone(selections);
  }

  async setTripFlightSelection(
    userId: string,
    tripId: string,
    itineraryKey: string,
    selected: boolean,
    now: Date
  ): Promise<void> {
    this.#requiredTrip(userId, tripId);
    if (selected) {
      const offers = await this.listTripOffers(userId, tripId, now);
      if (!offers.some((offer) => offer.itineraryKey === itineraryKey)) {
        throw new Error("Flight offer not found");
      }
    }
    const selections = this.#personSelections.get(tripId) ?? new Map<string, string>();
    if (selected) selections.set(itineraryKey, now.toISOString());
    else selections.delete(itineraryKey);
    if (selections.size > 0) this.#personSelections.set(tripId, selections);
    else this.#personSelections.delete(tripId);
    await this.markTripActivity(userId, tripId, now);
  }

  async markTripActivity(userId: string, tripId: string, now: Date): Promise<void> {
    const trip = this.#requiredTrip(userId, tripId);
    const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === tripId);
    if (watch) {
      this.#watches.set(watch.id, {
        ...watch,
        lastUserActivityAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
    } else {
      this.#trips.set(tripId, { ...trip, updatedAt: now.toISOString() });
    }
  }

  async hasDueWorkerWork(now: Date): Promise<boolean> {
    const nowMs = now.getTime();
    for (const watch of this.#watches.values()) {
      const trip = this.#trips.get(watch.tripId);
      if (!trip || ["cancelled", "completed", "archived"].includes(trip.status)) continue;
      if (
        watch.status === "active"
        && watch.nextCheckAt
        && Date.parse(watch.nextCheckAt) <= nowMs
      ) return true;
      if (watch.status === "active" && Date.parse(watch.runEndsAt) <= nowMs) return true;
      if (
        watch.status === "scheduled"
        && watch.trackingStartsAt
        && Date.parse(watch.trackingStartsAt) <= nowMs
      ) return true;
    }
    for (const run of this.#runs.values()) {
      if (run.attempt >= 3 || Date.parse(run.scheduledAt) > nowMs) continue;
      if (["queued", "deferred"].includes(run.status)) return true;
      if (
        run.status === "running"
        && run.leaseExpiresAt
        && Date.parse(run.leaseExpiresAt) <= nowMs
      ) return true;
    }
    if ([...this.#notifications.values()].some((notification) =>
      notification.status === "pending" && Date.parse(notification.availableAt) <= nowMs
    )) return true;
    return false;
  }

  async maintainTracking(now: Date): Promise<TrackingMaintenance> {
    let activated = 0;
    let completed = 0;
    for (const [watchId, watch] of this.#watches) {
      const trip = this.#trips.get(watch.tripId);
      if (!trip) continue;
      const profile = this.#profiles.get(trip.userId) ?? await this.ensureProfile(trip.userId, now);
      const runEnded = watch.status === "active" && Date.parse(watch.runEndsAt) <= now.getTime();
      const watchSpecIds = this.#watchSpecs.get(watch.id) ?? new Set<string>();
      const hasPendingCheck = [...this.#runs.values()].some((run) =>
        watchSpecIds.has(run.searchSpecId) && ["queued", "running", "deferred"].includes(run.status)
      );
      if (runEnded && !hasPendingCheck) {
        const timestamp = now.toISOString();
        const checkpointKey = `${trip.id}:tracking_summary:${watch.runStartedAt}`;
        this.#watches.set(watchId, {
          ...watch,
          status: "completed",
          nextCheckAt: null,
          completedAt: timestamp,
          updatedAt: timestamp
        });
        this.#trips.set(trip.id, {
          ...trip,
          status: "recommended",
          version: trip.version + 1,
          updatedAt: timestamp
        });
        const recommendation = this.#recommendations.get(trip.id);
        this.#recordTripActivity(trip.id, "tracking_completed", {
          checksCompleted: watch.checksCompleted,
          recommendationSummary: recommendation?.summary ?? null,
          checkpointKey
        }, now);
        if (profile.notificationMode !== "off") {
          this.#enqueueSimpleNotification(
            trip,
            "tracking_summary",
            checkpointKey,
            {
              tripTitle: trip.title,
              tripRoute: formatTripRoute(trip.brief),
              checksCompleted: watch.checksCompleted,
              summary: recommendation?.summary ?? "The latest verified options are ready to review.",
              checkpointKey
            },
            now
          );
        }
        completed += 1;
        continue;
      }
      if (runEnded) continue;
      if (
        watch.status === "scheduled"
        && watch.trackingStartsAt
        && Date.parse(watch.trackingStartsAt) <= now.getTime()
      ) {
        this.#watches.set(watchId, {
          ...watch,
          status: "active",
          nextCheckAt: now.toISOString(),
          activatedAt: now.toISOString(),
          lastUserActivityAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
        if (profile.notificationMode !== "off") {
          this.#enqueueSimpleNotification(
            trip,
            "tracking_activation",
            `${trip.id}:tracking_activation:${watch.trackingStartsAt}`,
            { tripTitle: trip.title, trackingStartsAt: watch.trackingStartsAt },
            now
          );
        }
        activated += 1;
      }
    }
    return { activated, completed };
  }

  async finalizeFarFutureBaseline(searchSpecId: string, now: Date): Promise<void> {
    for (const watch of this.#watchesForSpec(searchSpecId)) {
      if (
        watch.status !== "active"
        || !watch.trackingStartsAt
        || Date.parse(watch.trackingStartsAt) <= now.getTime()
      ) continue;
      this.#watches.set(watch.id, {
        ...watch,
        status: "scheduled",
        nextCheckAt: watch.trackingStartsAt,
        baselineCompletedAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
    }
  }

  async scheduleDueSearchRuns(now: Date, freshnessMs: number, limit: number): Promise<number> {
    const due = [...this.#watches.values()]
      .filter((watch) =>
        watch.status === "active"
        && watch.nextCheckAt !== null
        && watch.nextCheckAt <= now.toISOString()
        && watch.runEndsAt > now.toISOString()
      )
      .slice(0, limit);
    const scheduled = new Set<string>();
    for (const watch of due) {
      const recommendation = this.#recommendations.get(watch.tripId);
      const specIds = [...(this.#watchSpecs.get(watch.id) ?? [])]
        .sort((left, right) => {
          if (left === recommendation?.searchSpecId) return -1;
          if (right === recommendation?.searchSpecId) return 1;
          return this.#latestCompletedAt(left).localeCompare(this.#latestCompletedAt(right))
            || left.localeCompare(right);
        })
        .slice(0, recommendation ? TRACKING_SEARCH_SPEC_LIMIT : DISCOVERY_SEARCH_SPEC_LIMIT);
      for (const specId of specIds) {
        const pending = [...this.#runs.values()].some((run) => run.searchSpecId === specId && ["queued", "running"].includes(run.status));
        const latest = [...this.#runs.values()].filter((run) => run.searchSpecId === specId && run.status === "completed")
          .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
        const fresh = latest?.completedAt && Date.parse(latest.completedAt) >= now.getTime() - freshnessMs;
        if (!pending && !fresh && !scheduled.has(specId)) {
          const spec = this.#specs.get(specId)!;
          const id = randomUUID();
          this.#runs.set(id, {
            id, searchSpecId: specId, request: clone(spec.request), attempt: 0,
            leaseExpiresAt: "", status: "queued", claimedBy: null,
            scheduledAt: now.toISOString(), completedAt: null, error: null
          });
          scheduled.add(specId);
        }
      }
      const trip = this.#trips.get(watch.tripId);
      this.#watches.set(watch.id, {
        ...watch,
        nextCheckAt: new Date(Math.min(
          Date.parse(watch.runEndsAt),
          now.getTime() + TRACKING_CHECK_INTERVAL_MS
        )).toISOString(),
        updatedAt: now.toISOString()
      });
    }
    return scheduled.size;
  }

  async claimSearchRuns(workerId: string, now: Date, leaseMs: number, limit: number): Promise<ClaimedSearchRun[]> {
    const active = [...this.#runs.values()].filter((run) => run.status === "running" && run.leaseExpiresAt > now.toISOString()).length;
    const available = Math.max(0, 4 - active);
    const candidates = [...this.#runs.values()]
      .filter((run) =>
        (["queued", "deferred"].includes(run.status) && run.scheduledAt <= now.toISOString())
        || (run.status === "running" && run.leaseExpiresAt <= now.toISOString())
      )
      .filter((run) => run.attempt < 3)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .slice(0, Math.min(limit, available));
    return candidates.map((run) => {
      const claimed = {
        ...run, status: "running" as const, claimedBy: workerId, attempt: run.attempt + 1,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString()
      };
      this.#runs.set(run.id, claimed);
      return clone({ id: claimed.id, searchSpecId: claimed.searchSpecId, request: claimed.request, attempt: claimed.attempt, leaseExpiresAt: claimed.leaseExpiresAt });
    });
  }

  async completeSearchRun(workerId: string, runId: string, providerRequestId: string, offers: CompletedProviderOffer[], now: Date): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run || run.claimedBy !== workerId || run.status !== "running") throw new Error("Search run lease is not owned by this worker");
    this.#runs.set(runId, { ...run, status: "completed", completedAt: now.toISOString(), leaseExpiresAt: "", error: null });
    const retained = retainSearchOffers(offers);
    if (retained.length === 0) {
      for (const watch of this.#watchesForSpec(run.searchSpecId)) {
        this.#watches.set(watch.id, {
          ...watch,
          lastCheckAt: now.toISOString(),
          checksCompleted: watch.checksCompleted + 1,
          delayedAt: now.toISOString(),
          delayReason: "No fares were found in the latest check.",
          updatedAt: now.toISOString()
        });
      }
      void providerRequestId;
      return;
    }
    for (const [offerId, offer] of this.#offers) {
      if (offer.searchSpecId === run.searchSpecId) this.#offers.delete(offerId);
    }
    for (const offer of retained) {
      const stored: OfferSnapshot = {
        ...clone(offer),
        id: randomUUID(),
        searchRunId: runId,
        searchSpecId: run.searchSpecId,
        observedAt: isoTimestamp(offer.observedAt),
        verifiedAt: isoTimestamp(offer.verifiedAt),
        expiresAt: offer.expiresAt === null ? null : isoTimestamp(offer.expiresAt)
      };
      this.#offers.set(stored.id, stored);
      this.#priceHistory.push({
        itineraryKey: stored.itineraryKey,
        price: stored.price,
        currency: stored.currency,
        observedAt: stored.observedAt
      });
    }
    for (const watch of this.#watchesForSpec(run.searchSpecId)) {
      this.#watches.set(watch.id, {
        ...watch,
        lastCheckAt: now.toISOString(),
        checksCompleted: watch.checksCompleted + 1,
        delayedAt: null,
        delayReason: null,
        updatedAt: now.toISOString()
      });
    }
    void providerRequestId;
  }

  async recordMultiCityLegSearchResult(
    searchSpecId: string,
    offers: CompletedProviderOffer[] | null,
    errorCode: string | null,
    now: Date
  ): Promise<MultiCityLegSearchRecording> {
    const spec = this.#specs.get(searchSpecId);
    if (!spec) return { matched: 0, notified: 0 };
    let matched = 0;
    let notified = 0;
    for (const watch of this.#watchesForSpec(searchSpecId)) {
      const trip = this.#trips.get(watch.tripId);
      const graph = trip ? this.#tripGraphs.get(trip.id) : null;
      if (!trip || !graph) continue;
      for (const match of matchingMultiCityLegs(trip, graph, spec.request)) {
        const snapshot = await this.createLegSearchSnapshot(
          trip.userId,
          trip.id,
          match.leg.id,
          match.leg.departureWindow,
          enumerateIsoDates(match.leg.departureWindow.start, match.leg.departureWindow.end),
          now
        );
        const revision = multiCityLegRevision(match, trip, offers, errorCode, now);
        const completed = await this.reviseLegSearchSnapshot(
          trip.userId,
          snapshot.id,
          snapshot.revision,
          revision,
          now
        );
        matched += 1;
        if (!completed || completed.analysis.optionsChecked === 0) continue;
        const remainingLegs = graph.legs.filter((leg) => {
          const current = leg.latestSearchId
            ? this.#legSearchSnapshots.get(leg.latestSearchId)
            : null;
          return !current || ["queued", "running"].includes(current.status);
        }).length;
        if (this.#enqueueSimpleNotification(
          trip,
          "initial_results",
          `${trip.id}:initial_results:multi_city`,
          {
            tripTitle: trip.title,
            multiCityProgress: {
              legRoute: `${match.origin.airportCodes[0]} → ${match.destination.airportCodes[0]}`,
              legsTotal: graph.legs.length,
              remainingLegs
            }
          },
          now
        )) {
          notified += 1;
          if (trip.status === "tracking") {
            this.#trips.set(trip.id, {
              ...trip,
              status: "recommended",
              version: trip.version + 1,
              updatedAt: now.toISOString()
            });
          }
        }
      }
    }
    return { matched, notified };
  }

  async pruneWatchData(now: Date): Promise<void> {
    const staleBefore = now.getTime() - CURRENT_OFFER_RETENTION_MS;
    const staleHistoryBefore = now.getTime() - 90 * 86_400_000;
    for (let index = this.#priceHistory.length - 1; index >= 0; index -= 1) {
      if (Date.parse(this.#priceHistory[index]!.observedAt) < staleHistoryBefore) {
        this.#priceHistory.splice(index, 1);
      }
    }
    const removedOfferIds = new Set<string>();
    for (const [offerId, offer] of this.#offers) {
      const expired = offer.expiresAt !== null && Date.parse(offer.expiresAt) <= now.getTime();
      if (expired || Date.parse(offer.observedAt) < staleBefore) {
        this.#offers.delete(offerId);
        removedOfferIds.add(offerId);
      }
    }
    for (const [tripId, recommendation] of this.#recommendations) {
      if (recommendation.offerId && removedOfferIds.has(recommendation.offerId)) {
        this.#recommendations.set(tripId, { ...recommendation, offerId: null });
      }
    }
    for (const [runId, run] of this.#runs) {
      const completedAt = run.completedAt ? Date.parse(run.completedAt) : Number.POSITIVE_INFINITY;
      if (["completed", "failed"].includes(run.status) && completedAt < staleBefore) {
        this.#runs.delete(runId);
      }
    }
    const archivedBefore = now.getTime() - 90 * 86_400_000;
    for (const [tripId, trip] of this.#trips) {
      if (trip.status !== "archived" || !trip.archivedAt || Date.parse(trip.archivedAt) >= archivedBefore) {
        continue;
      }
      this.#trips.delete(tripId);
      this.#tripGraphs.delete(tripId);
      for (const [searchId, snapshot] of this.#legSearchSnapshots) {
        if (snapshot.tripId === tripId) this.#legSearchSnapshots.delete(searchId);
      }
      this.#recommendations.delete(tripId);
      this.#personSelections.delete(tripId);
      for (const [watchId, watch] of this.#watches) {
        if (watch.tripId !== tripId) continue;
        this.#watches.delete(watchId);
        this.#watchSpecs.delete(watchId);
      }
      for (const [notificationId, notification] of this.#notifications) {
        if (notification.tripId === tripId) this.#notifications.delete(notificationId);
      }
    }
  }

  async failSearchRun(
    workerId: string,
    runId: string,
    error: string,
    retryAfterMs: number | null,
    retryable: boolean,
    now: Date
  ): Promise<boolean> {
    const run = this.#runs.get(runId);
    if (!run || run.claimedBy !== workerId || run.status !== "running") throw new Error("Search run lease is not owned by this worker");
    const retry = retryable && run.attempt < 3;
    this.#runs.set(runId, {
      ...run,
      status: retry ? "queued" : "failed",
      claimedBy: null,
      leaseExpiresAt: "",
      scheduledAt: retry ? new Date(now.getTime() + (retryAfterMs ?? [300_000, 900_000, 3_600_000][run.attempt - 1]!)).toISOString() : run.scheduledAt,
      completedAt: retry ? null : now.toISOString(),
      error
    });
    if (!retry) {
      for (const watch of this.#watchesForSpec(run.searchSpecId)) {
        this.#watches.set(watch.id, {
          ...watch,
          delayedAt: now.toISOString(),
          delayReason: "A scheduled check was delayed; keeping last results.",
          updatedAt: now.toISOString()
        });
      }
    }
    return !retry;
  }

  async deferSearchRun(workerId: string, runId: string, until: Date, reason: string, now: Date): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run || run.claimedBy !== workerId || run.status !== "running") {
      throw new Error("Search run lease is not owned by this worker");
    }
    this.#runs.set(runId, {
      ...run,
      status: "deferred",
      attempt: Math.max(0, run.attempt - 1),
      claimedBy: null,
      leaseExpiresAt: "",
      scheduledAt: until.toISOString(),
      completedAt: null,
      error: reason
    });
    for (const watch of this.#watchesForSpec(run.searchSpecId)) {
      this.#watches.set(watch.id, {
        ...watch,
        delayedAt: now.toISOString(),
        delayReason: reason,
        updatedAt: now.toISOString()
      });
    }
    void now;
  }

  async enqueueInventoryGapForSearchSpec(searchSpecId: string, now: Date): Promise<number> {
    let queued = 0;
    for (const watch of this.#watchesForSpec(searchSpecId)) {
      const trip = this.#trips.get(watch.tripId);
      if (!trip) continue;
      const specIds = this.#watchSpecs.get(watch.id) ?? new Set<string>();
      const allFinished = [...specIds].every((specId) => {
        const latest = [...this.#runs.values()]
          .filter((run) => run.searchSpecId === specId)
          .sort((left, right) => (right.completedAt ?? right.scheduledAt)
            .localeCompare(left.completedAt ?? left.scheduledAt))[0];
        return latest && ["completed", "failed"].includes(latest.status);
      });
      const hasInitialResults = [...this.#notifications.values()].some((notification) =>
        notification.tripId === trip.id
        && notification.kind === "initial_results"
        && notification.status !== "superseded"
      );
      if (!allFinished || hasInitialResults) continue;
      if (this.#enqueueSimpleNotification(
        trip,
        "inventory_gap",
        `${trip.id}:initial_search_failed`,
        {
          tripTitle: trip.title,
          multiCity: trip.brief.tripType === "multi_city",
          initialSearchFailure: true
        },
        now
      )) queued += 1;
    }
    return queued;
  }

  async evaluateTripsForSearchSpec(searchSpecId: string, now: Date): Promise<number> {
    const tripIds = new Set(this.#watchesForSpec(searchSpecId).map((watch) => watch.tripId));
    let changed = 0;
    for (const tripId of tripIds) {
      const trip = this.#trips.get(tripId)!;
      const offers = await this.listTripOffers(trip.userId, trip.id, now);
      const profile = await this.ensureProfile(trip.userId, now);
      const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === trip.id);
      const ranked = rankOffers(trip.brief, profile, offers);
      const best = ranked[0];
      if (!best) {
        this.#recommendations.delete(trip.id);
        continue;
      }
      const previous = this.#recommendations.get(trip.id);
      const comparison = previous
        ? rankOffers(trip.brief, profile, [...offers, previous.snapshot.current])
        : [];
      const previousRanked = previous
        ? comparison.find((candidate) => candidate.offer.id === previous.snapshot.current.id) ?? {
            offer: previous.snapshot.current,
            score: previous.score
          }
        : null;
      const comparableBest = comparison.find((candidate) => candidate.offer.id === best.offer.id) ?? best;
      const qualifies = meetsAlertThreshold(profile.rankingMode, comparableBest, previousRanked);
      const reasonCodes = previous && !qualifies
        ? []
        : recommendationReasonCodes(
            profile.rankingMode,
            best.offer,
            previous?.snapshot.current ?? null
          );
      const recommendation: TripRecommendation = {
        tripId: trip.id, offerId: best.offer.id, searchSpecId: best.offer.searchSpecId,
        itineraryKey: best.offer.itineraryKey,
        score: best.score, price: best.offer.price, currency: best.offer.currency,
        summary: recommendationSummary(best.offer), observedAt: best.offer.observedAt,
        rankingMode: profile.rankingMode,
        snapshot: {
          current: clone(best.offer),
          previous: previous?.snapshot.current ? clone(previous.snapshot.current) : null,
          rankingMode: profile.rankingMode,
          reasonCodes,
          createdAt: now.toISOString()
        }
      };
      this.#recommendations.set(trip.id, recommendation);
      // The first search always earns a message: it tells the traveller what
      // Captain found and what to do next. After that, only a change worth the
      // interruption speaks.
      const kind = profile.notificationMode === "off"
        ? null
        : !previous
          ? "initial_results"
          : qualifies && profile.betterOptionAlertsEnabled
            ? profile.rankingMode === "cheapest" ? "price_drop" : "new_best"
            : null;
      if (kind) {
        const context = {
          tripGoal: formatTripGoal({ brief: trip.brief, rankingMode: profile.rankingMode }),
          range: offerRangeSummary(offers),
          dateSummary: offerDateSummary(offers, trip)
        };
        if (this.#enqueueNotification(trip, kind, recommendation, previous, context, now)) {
          changed += 1;
        }
      }
      if (watch && this.#evaluatePriceRise(trip, watch, profile, offers, best.offer, now)) {
        changed += 1;
      }
      if (trip.status === "tracking") {
        this.#trips.set(trip.id, { ...trip, status: "recommended", version: trip.version + 1, updatedAt: now.toISOString() });
      }
    }
    return changed;
  }

  async listPendingNotifications(now: Date, limit: number): Promise<CaptainNotification[]> {
    const due = [...this.#notifications.values()]
      .filter((notification) => notification.status === "pending" && notification.availableAt <= now.toISOString());
    for (const notification of due) {
      if (
        notification.kind === "watch_attention"
        || (
          notification.kind === "inventory_gap"
          && notification.payload.initialSearchFailure !== true
        )
      ) {
        this.#notifications.set(notification.id, { ...notification, status: "superseded" });
      }
    }
    // A stale "better option" is worth dropping for a fresher one. The opening
    // overview is not one of those, so it always gets delivered.
    const resultKinds = new Set<CaptainNotification["kind"]>(["price_drop", "new_best"]);
    const resultGroups = new Map<string, StoredNotification[]>();
    for (const notification of [...this.#notifications.values()].filter((candidate) =>
      candidate.status === "pending" && resultKinds.has(candidate.kind)
    )) {
      const group = resultGroups.get(notification.tripId) ?? [];
      group.push(notification);
      resultGroups.set(notification.tripId, group);
    }
    for (const group of resultGroups.values()) {
      const newest = [...group].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      for (const notification of group) {
        if (notification.id !== newest?.id) {
          this.#notifications.set(notification.id, { ...notification, status: "superseded" });
        }
      }
    }
    return [...this.#notifications.values()]
      .filter((notification) => notification.status === "pending" && notification.availableAt <= now.toISOString())
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))
      .slice(0, limit)
      .map(clone);
  }

  async markNotificationSent(
    notificationId: string,
    telegramMessageId: number,
    body: string,
    now: Date
  ): Promise<void> {
    const notification = this.#notifications.get(notificationId);
    if (!notification) return;
    this.#notifications.set(notificationId, {
      ...notification,
      status: "sent",
      telegramMessageId
    });
    const trimmed = body.trim();
    if (trimmed && isCheckpointNotificationKind(notification.kind)) {
      this.#recordTripActivity(notification.tripId, "captain_update", {
        kind: notification.kind,
        ...checkpointCorrelationPayload(notification.payload)
      }, now, {
        body: trimmed,
        channel: "telegram",
        notificationId
      });
    }
  }

  async markNotificationFailed(notificationId: string, error: string, now: Date): Promise<void> {
    const notification = this.#notifications.get(notificationId);
    if (!notification) return;
    const attempts = notification.attempts + 1;
    this.#notifications.set(notificationId, {
      ...notification, attempts, error,
      status: attempts >= 3 ? "failed" : "pending",
      availableAt: new Date(now.getTime() + attempts * 300_000).toISOString()
    });
  }

  async getNotificationByTelegramMessage(
    userId: string,
    telegramMessageId: number
  ): Promise<CaptainNotification | null> {
    return clone([...this.#notifications.values()].find((notification) =>
      notification.userId === userId && notification.telegramMessageId === telegramMessageId
    ) ?? null);
  }

  async getRecommendation(userId: string, tripId: string): Promise<TripRecommendation | null> {
    if (this.#trips.get(tripId)?.userId !== userId) return null;
    return clone(this.#recommendations.get(tripId) ?? null);
  }

  async close(): Promise<void> {}

  #onboardingActivityReason(userId: string): OnboardingEngagementReason | null {
    const startedAt = [...this.#onboardingFollowups.values()]
      .find((followup) => followup.userId === userId)?.sequenceStartedAt;
    if (!startedAt) return null;
    const conversation = this.#conversations.get(userId);
    if (conversation?.recentMessages.some((message) =>
      message.role === "user" && message.createdAt > startedAt
    )) return "telegram_message";
    if ([...this.#trips.values()].some((trip) =>
      trip.userId === userId && trip.createdAt >= startedAt
    )) return "trip_activity";
    if ([...this.#tripPlanDrafts.values()].some((draft) =>
      draft.userId === userId && draft.createdAt >= startedAt
    )) return "trip_activity";
    return null;
  }

  #expireDraft(draft: TripPlanDraft, now: Date): TripPlanDraft {
    if (
      draft.expiresAt <= now.toISOString()
      && ["collecting", "awaiting_confirmation", "starting"].includes(draft.status)
    ) {
      const expired = { ...draft, status: "expired" as const, updatedAt: now.toISOString() };
      this.#tripPlanDrafts.set(draft.id, expired);
      return expired;
    }
    return draft;
  }

  #updateTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    values: Partial<TripPlanDraft> | TripPlanDraftRevision,
    now: Date,
    expectedStatuses: TripPlanDraft["status"][]
  ): TripPlanDraft | null {
    const current = this.#tripPlanDrafts.get(draftId);
    if (
      !current
      || current.userId !== userId
      || current.revision !== expectedRevision
      || !expectedStatuses.includes(current.status)
      || current.expiresAt <= now.toISOString()
    ) {
      return null;
    }
    const updated: TripPlanDraft = {
      ...current,
      ...values,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString()
    };
    this.#tripPlanDrafts.set(draftId, updated);
    return clone(updated);
  }

  #requiredTrip(userId: string, tripId: string): Trip {
    const trip = this.#trips.get(tripId);
    if (!trip || trip.userId !== userId) throw new TripNotFoundError();
    return trip;
  }

  #setSpecs(watchId: string, specs: SearchSpec[]): void {
    const ids = new Set<string>();
    for (const spec of specs) {
      this.#specs.set(spec.id, clone(spec));
      ids.add(spec.id);
    }
    this.#watchSpecs.set(watchId, ids);
  }

  #recordTripActivity(
    tripId: string,
    eventType: string,
    payload: Record<string, unknown>,
    now: Date,
    extras?: {
      body?: string | null;
      channel?: TripActivity["channel"];
      notificationId?: string | null;
      sourceMessageId?: string | null;
    }
  ): void {
    const activity = this.#tripActivity.get(tripId) ?? [];
    activity.unshift({
      id: randomUUID(),
      eventType,
      payload,
      createdAt: now.toISOString(),
      body: extras?.body ?? null,
      channel: extras?.channel ?? "system",
      notificationId: extras?.notificationId ?? null,
      sourceMessageId: extras?.sourceMessageId ?? null
    });
    this.#tripActivity.set(tripId, activity.slice(0, 50));
  }

  #enqueueTrackingStartedNotification(
    trip: Trip,
    checkpointKey: string,
    now: Date
  ): boolean {
    return this.#enqueueCheckpointAck(trip, "tracking_started", {
      eventType: "trip_tracking_started",
      tripTitle: trip.title,
      tripVersion: trip.version,
      checkpointKey
    }, now, checkpointKey);
  }

  /** Immediate Telegram ack for a progress checkpoint (event → outbox). */
  #enqueueCheckpointAck(
    trip: Trip,
    kind: CheckpointNotificationKind,
    payload: Record<string, unknown>,
    now: Date,
    dedupKey = `${trip.id}:${kind}:${trip.version}`
  ): boolean {
    const user = [...this.#usersByTelegram.values()].find((item) => item.id === trip.userId);
    if (!user) return false;
    if ([...this.#notifications.values()].some((item) => item.dedupKey === dedupKey)) return false;
    const id = randomUUID();
    this.#notifications.set(id, {
      id,
      userId: trip.userId,
      tripId: trip.id,
      telegramChatId: user.telegramChatId,
      kind,
      payload: {
        tripTitle: trip.title,
        tripRoute: formatTripRoute(trip.brief),
        ...payload
      },
      attempts: 0,
      telegramMessageId: null,
      status: "pending",
      availableAt: now.toISOString(),
      createdAt: now.toISOString(),
      dedupKey,
      error: null
    });
    return true;
  }

  #watchesForSpec(specId: string): Watch[] {
    return [...this.#watches.values()].filter((watch) => this.#watchSpecs.get(watch.id)?.has(specId));
  }

  #latestCompletedAt(specId: string): string {
    return [...this.#runs.values()]
      .filter((run) => run.searchSpecId === specId && run.status === "completed")
      .map((run) => run.completedAt ?? "")
      .sort()
      .at(-1) ?? "";
  }

  #enqueueNotification(
    trip: Trip,
    kind: "initial_results" | "price_drop" | "new_best",
    recommendation: TripRecommendation,
    previous: TripRecommendation | undefined,
    /** What Captain is chasing, and the market it found. */
    context: {
      tripGoal: string;
      range: OfferRangeSummary | null;
      dateSummary: OfferDateSummary | null;
    },
    now: Date
  ): boolean {
    const user = [...this.#usersByTelegram.values()].find((item) => item.id === trip.userId);
    const profile = this.#profiles.get(trip.userId);
    if (!user || !profile || profile.notificationMode === "off") return false;
    if (
      kind !== "initial_results"
      && [...this.#notifications.values()].filter((notification) =>
        notification.userId === trip.userId
        && ["price_rise", "price_drop", "new_best"].includes(notification.kind)
        && Date.parse(notification.createdAt) >= now.getTime() - 86_400_000
        && notification.status !== "superseded"
      ).length >= profile.maxAlertsPerDay
    ) return false;
    const dedupKey = `${trip.id}:${kind}:${recommendation.itineraryKey}:${recommendation.price}`;
    if ([...this.#notifications.values()].some((item) => item.dedupKey === dedupKey)) return false;
    const id = randomUUID();
    this.#notifications.set(id, {
      id, userId: trip.userId, tripId: trip.id, telegramChatId: user.telegramChatId,
      kind,
      payload: {
        tripTitle: trip.title,
        tripGoal: context.tripGoal,
        ...recommendation,
        ...(kind === "initial_results"
          ? { range: context.range, dateSummary: context.dateSummary }
          : {}),
        ...(kind === "initial_results"
          && [...this.#watches.values()].find((watch) => watch.tripId === trip.id)?.trackingStartsAt
          ? {
              trackingStartsAt: [...this.#watches.values()]
                .find((watch) => watch.tripId === trip.id)!.trackingStartsAt
            }
          : {}),
        ...(previous ? {
          previousPrice: previous.price,
          dropPercent: previous.price > 0 ? Math.round((1 - recommendation.price / previous.price) * 100) : 0
        } : {})
      },
      attempts: 0, telegramMessageId: null,
      status: "pending",
      availableAt: deliveryTime(now, user.timezone, profile).toISOString(),
      createdAt: now.toISOString(), dedupKey, error: null
    });
    return true;
  }

  #evaluatePriceRise(
    trip: Trip,
    watch: Watch,
    profile: TravellerProfile,
    offers: OfferSnapshot[],
    recommended: OfferSnapshot,
    now: Date
  ): boolean {
    const selectedKey = [...(this.#personSelections.get(trip.id) ?? new Map<string, string>())]
      .sort((left, right) => right[1].localeCompare(left[1]))[0]?.[0];
    const monitored = offers.find((offer) => offer.itineraryKey === selectedKey) ?? recommended;
    const low = this.#priceHistory
      .filter((observation) =>
        observation.itineraryKey === monitored.itineraryKey
        && observation.currency === monitored.currency
        && Date.parse(observation.observedAt) >= now.getTime() - 7 * 86_400_000
      )
      .reduce((minimum, observation) => Math.min(minimum, observation.price), monitored.price);
    const increase = monitored.price - low;
    const percent = low > 0 ? increase / low : 0;
    const sameItinerary = watch.priceRiseItineraryKey === monitored.itineraryKey;
    const armed = sameItinerary ? watch.priceRiseArmed : true;
    const thresholdReached = percent >= 0.05 && increase >= 20;
    const queued = thresholdReached && armed && profile.priceRiseAlertsEnabled
      ? this.#enqueueSimpleNotification(
          trip,
          "price_rise",
          `${trip.id}:price_rise:${monitored.itineraryKey}:${low}:${monitored.price}`,
          {
            tripTitle: trip.title,
            current: monitored,
            sevenDayLow: low,
            increase,
            percent: Math.round(percent * 100)
          },
          now
        )
      : false;
    this.#watches.set(watch.id, {
      ...watch,
      priceRiseItineraryKey: monitored.itineraryKey,
      priceRiseArmed: thresholdReached ? !queued && armed : true,
      updatedAt: now.toISOString()
    });
    return queued;
  }

  #enqueueSimpleNotification(
    trip: Trip,
    kind: CaptainNotification["kind"],
    dedupKey: string,
    payload: Record<string, unknown>,
    now: Date
  ): boolean {
    const user = [...this.#usersByTelegram.values()].find((candidate) => candidate.id === trip.userId);
    const profile = this.#profiles.get(trip.userId);
    if (!user || !profile || profile.notificationMode === "off") return false;
    if (
      ["price_rise", "price_drop", "new_best"].includes(kind)
      && [...this.#notifications.values()].filter((notification) =>
        notification.userId === trip.userId
        && ["price_rise", "price_drop", "new_best"].includes(notification.kind)
        && Date.parse(notification.createdAt) >= now.getTime() - 86_400_000
        && notification.status !== "superseded"
      ).length >= profile.maxAlertsPerDay
    ) return false;
    if ([...this.#notifications.values()].some((candidate) => candidate.dedupKey === dedupKey)) return false;
    const id = randomUUID();
    this.#notifications.set(id, {
      id,
      userId: trip.userId,
      tripId: trip.id,
      telegramChatId: user.telegramChatId,
      kind,
      // The immutable goal remains available as internal decision context.
      payload: { ...notificationGoalPayload(trip, profile), ...payload },
      attempts: 0,
      telegramMessageId: null,
      status: "pending",
      availableAt: deliveryTime(now, user.timezone, profile).toISOString(),
      createdAt: now.toISOString(),
      dedupKey,
      error: null
    });
    return true;
  }

}

function onboardingFollowupKey(userId: string, stage: OnboardingFollowupStage): string {
  return `${userId}:${stage}`;
}

function checkpointCorrelationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof payload.checkpointKey === "string"
      ? { checkpointKey: payload.checkpointKey }
      : {}),
    ...(typeof payload.tripVersion === "number"
      ? { tripVersion: payload.tripVersion }
      : {})
  };
}

function displayName(input: TelegramUserInput): string {
  return input.firstName?.trim() || (input.username ? `@${input.username}` : `traveller ${input.telegramUserId}`);
}

function deliveryTime(
  now: Date,
  timezone: string,
  preferences: Pick<
    TravellerProfile,
    "quietHoursEnabled" | "quietHoursStart" | "quietHoursEnd"
  >
): Date {
  if (!preferences.quietHoursEnabled) return now;
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
    const start = preferences.quietHoursStart;
    const end = preferences.quietHoursEnd;
    if (start === end) return now;
    if (start > end) {
      if (hour >= start) return new Date(now.getTime() + (24 - hour + end) * 3_600_000);
      if (hour < end) return new Date(now.getTime() + (end - hour) * 3_600_000);
    } else if (hour >= start && hour < end) {
      return new Date(now.getTime() + (end - hour) * 3_600_000);
    }
  } catch {
    // Invalid timezones fall back to immediate delivery.
  }
  return now;
}

function localParts(now: Date, timezone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour"))
  };
}

/**
 * Postgres round-trips every timestamp through `timestamptz` and reads it back
 * in canonical form, so a caller-supplied "2026-08-01T12:00:01Z" comes out as
 * "2026-08-01T12:00:01.000Z". Normalising on the way in keeps this store's
 * observable output identical rather than echoing whatever the caller wrote.
 */
function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function materializeTripGraph(tripId: string, brief: TripBrief): TripGraph {
  const routeLegs = legacyRouteLegs(brief);
  const cities: TripCity[] = routeLegs.map((leg, position) => ({
    id: randomUUID(),
    tripId,
    position,
    label: cityLabelForAirportCodes(leg.originAirports),
    airportCodes: clone(leg.originAirports),
    arrivalWindow: position === 0
      ? null
      : arrivalWindowFor(routeLegs[position - 1]!),
    departureWindow: clone(leg.departureWindow)
  }));
  const finalLeg = routeLegs.at(-1);
  if (finalLeg) {
    cities.push({
      id: randomUUID(),
      tripId,
      position: routeLegs.length,
      label: cityLabelForAirportCodes(finalLeg.destinationAirports),
      airportCodes: clone(finalLeg.destinationAirports),
      arrivalWindow: arrivalWindowFor(finalLeg),
      departureWindow: null
    });
  }
  const legs: TripCityLeg[] = routeLegs.map((leg, position) => ({
    id: randomUUID(),
    tripId,
    position,
    originCityId: cities[position]!.id,
    destinationCityId: cities[position + 1]!.id,
    departureWindow: clone(leg.departureWindow),
    arriveBy: leg.arriveBy ?? null,
    selectedFlightKey: null,
    latestSearchId: null
  }));
  return { cities, legs };
}

function arrivalWindowFor(leg: {
  departureWindow: { start: string; end: string };
  arriveBy: string | null;
}): { start: string; end: string } {
  return leg.arriveBy
    ? { start: leg.arriveBy, end: leg.arriveBy }
    : clone(leg.departureWindow);
}

function legacyRouteLegs(brief: TripBrief): Array<{
  originAirports: string[];
  destinationAirports: string[];
  departureWindow: { start: string; end: string };
  arriveBy: string | null;
}> {
  if (brief.tripType === "multi_city" && brief.legs?.length) {
    return clone(brief.legs).map((leg) => ({ ...leg, arriveBy: leg.arriveBy ?? null }));
  }
  const outbound = {
    originAirports: clone(brief.originAirports),
    destinationAirports: clone(brief.destinationAirports),
    departureWindow: clone(brief.departureWindow),
    arriveBy: null
  };
  if (brief.tripType !== "round_trip" || !brief.stayNights) return [outbound];
  return [outbound, {
    originAirports: clone(brief.destinationAirports),
    destinationAirports: clone(brief.originAirports),
    departureWindow: {
      start: addUtcDays(brief.departureWindow.start, brief.stayNights.minimum),
      end: addUtcDays(brief.departureWindow.end, brief.stayNights.maximum)
    },
    arriveBy: null
  }];
}

function addUtcDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function assertLegSearchRequest(
  leg: Pick<TripCityLeg, "departureWindow">,
  requestedWindow: { start: string; end: string },
  datesRequested: string[]
): void {
  const requestedDates = enumerateIsoDates(requestedWindow.start, requestedWindow.end);
  if (
    requestedDates.length === 0
    || requestedDates.length > MAX_MANUAL_SEARCH_DAYS
    || requestedWindow.start < leg.departureWindow.start
    || requestedWindow.end > leg.departureWindow.end
    || JSON.stringify(datesRequested) !== JSON.stringify(requestedDates)
  ) {
    throw new RangeError("Leg search must cover every date in a valid window of at most 7 days");
  }
}

function enumerateIsoDates(start: string, end: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(start) || !/^\d{4}-\d{2}-\d{2}$/u.test(end)) return [];
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
  const result: string[] = [];
  for (
    let value = startMs;
    value <= endMs && result.length <= MAX_MANUAL_SEARCH_DAYS;
    value += 86_400_000
  ) {
    result.push(new Date(value).toISOString().slice(0, 10));
  }
  return result;
}

function assertLegSearchRevision(revision: LegSearchSnapshotRevision): void {
  legSearchSnapshotSchema.shape.status.parse(revision.status);
  legSearchSnapshotSchema.shape.analysis.parse(revision.analysis);
  legSearchSnapshotSchema.shape.flights.parse(revision.flights);
  legSearchSnapshotSchema.shape.offers.parse(revision.offers);
  legSearchSnapshotSchema.shape.completedAt.parse(revision.completedAt);
  const flightKeys = new Set(revision.flights.map((flight) => flight.key));
  if (revision.offers.some((offer) => !flightKeys.has(offer.flightKey))) {
    throw new Error("Every offer must reference a canonical flight in the same snapshot");
  }
}

function dedupeFlightOffers(offers: FlightOfferSnapshot[]): FlightOfferSnapshot[] {
  const byProviderOffer = new Map<string, FlightOfferSnapshot>();
  for (const offer of offers) {
    const key = `${offer.provider}:${offer.offerId}`;
    const current = byProviderOffer.get(key);
    if (!current || offer.observedAt > current.observedAt) byProviderOffer.set(key, offer);
  }
  return [...byProviderOffer.values()].sort((left, right) =>
    Number(left.priceAmount) - Number(right.priceAmount)
    || right.observedAt.localeCompare(left.observedAt)
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function publicBetaEnabled(): boolean {
  return !["0", "false", "off", "no"].includes(
    (process.env.CAPTAIN_PUBLIC_BETA_ENABLED ?? "true").trim().toLowerCase()
  );
}

function isActiveTripStatus(status: Trip["status"]): boolean {
  return !["cancelled", "completed", "archived"].includes(status);
}

function daysUntilDeparture(departureStart: string, now: Date): number {
  const departure = Date.parse(`${departureStart}T00:00:00.000Z`);
  return Number.isFinite(departure)
    ? Math.ceil((departure - now.getTime()) / 86_400_000)
    : 0;
}

function reusedConfirmation(
  confirmed: { draft: TripPlanDraft; result: TripCreationResult } | null
): { draft: TripPlanDraft; result: TripCreationResult } | null {
  return confirmed
    ? clone({
        ...confirmed,
        result: { ...confirmed.result, created: false }
      })
    : null;
}
