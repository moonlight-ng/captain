import { randomUUID } from "node:crypto";

import {
  DEFAULT_PROFILE,
  MAX_ACTIVE_TRIPS_PER_USER,
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  EMPTY_TRIP_DRAFT_STATE,
  type CreatePassengerInput,
  type CreateTripInput,
  type OfferSnapshot,
  type Passenger,
  type PaymentCardDeletion,
  type PaymentCardSetupIntent,
  type PaymentMethod,
  type SavePaymentMethodInput,
  type TripCreationResult,
  type TripPlanDraft,
  type TripPlanDraftRevision,
  type TravellerProfile,
  type UpdatePassengerInput,
  type UpdateTravellerProfile,
  type UpdateTripBrief,
  type SearchSpec,
  type Trip,
  type TripAction,
  type Watch,
  type CaptainSessionPath
} from "@agents/flight-domain";

import type {
  CaptainNotification,
  CaptainPlatformStore,
  CaptainUser,
  ClaimedSearchRun,
  CompletedProviderOffer,
  ConversationContext,
  TelegramUserInput,
  TrackingMaintenance,
  TripFlightSelection,
  TripActivity,
  TripRecommendation
} from "./contracts.js";
import {
  BetaCapacityError,
  BetaLaunchGateError,
  PaymentMethodLimitError,
  PaymentSetupConflictError,
  PaymentSetupInProgressError
} from "./contracts.js";
import {
  meetsAlertThreshold,
  rankOffers,
  recommendationReasonCodes,
  recommendationSummary
} from "./ranking.js";
import {
  adaptiveWatchIntervalMs,
  CURRENT_OFFER_RETENTION_MS,
  DIGEST_TRIP_LIMIT,
  DISCOVERY_SEARCH_SPEC_LIMIT,
  INACTIVITY_AUTO_PAUSE_MS,
  INACTIVITY_CHECKIN_MS,
  retainSearchOffers,
  TRACKING_SEARCH_SPEC_LIMIT,
  trackingStartsAt
} from "./watch-policy.js";

const SETUP_INTENT_TTL_MS = 30 * 60_000;
const SETUP_INTENT_COMPLETED_RETENTION_MS = 24 * 60 * 60_000;
const MAX_PAYMENT_METHODS_PER_USER = 20;
const CARD_DELETION_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000
] as const;

function cardDeletionBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), CARD_DELETION_BACKOFF_MS.length - 1);
  return CARD_DELETION_BACKOFF_MS[index]!;
}

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

export class MemoryCaptainPlatformStore implements CaptainPlatformStore {
  readonly #usersByTelegram = new Map<number, CaptainUser>();
  readonly #profiles = new Map<string, TravellerProfile>();
  readonly #loginTokens = new Map<string, StoredLoginToken>();
  readonly #webSessions = new Map<string, StoredWebSession>();
  readonly #apiUsage = new Map<string, { responses: number; webSearchCalls: number }>();
  readonly #updates = new Set<string>();
  readonly #conversations = new Map<string, MemoryConversation>();
  readonly #trips = new Map<string, Trip>();
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
  readonly #lastDigestAt = new Map<string, string>();
  readonly #tripActivity = new Map<string, TripActivity[]>();
  readonly #tripPlanDrafts = new Map<string, TripPlanDraft>();
  readonly #tripPlanConfirmations = new Map<
    string,
    Promise<{ draft: TripPlanDraft; result: TripCreationResult } | null>
  >();
  readonly #passengers = new Map<string, Passenger>();
  readonly #tripPassengers = new Map<string, Array<{ passengerId: string; ordinal: number }>>();
  readonly #paymentMethods = new Map<string, PaymentMethod>();
  readonly #setupIntents = new Map<string, PaymentCardSetupIntent>();
  readonly #cardDeletions = new Map<string, PaymentCardDeletion>();

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
    const now = new Date();
    for (const method of this.#paymentMethods.values()) {
      if (method.userId === userId) this.#enqueueCardDeletion(method, now);
    }
    for (const [telegramId, user] of this.#usersByTelegram) {
      if (user.id === userId) this.#usersByTelegram.delete(telegramId);
    }
    this.#profiles.delete(userId);
    this.#conversations.delete(userId);
    for (const [hash, token] of this.#loginTokens) if (token.userId === userId) this.#loginTokens.delete(hash);
    for (const [hash, session] of this.#webSessions) if (session.userId === userId) this.#webSessions.delete(hash);
    for (const [id, passenger] of this.#passengers) if (passenger.userId === userId) this.#passengers.delete(id);
    for (const [id, method] of this.#paymentMethods) if (method.userId === userId) this.#paymentMethods.delete(id);
    for (const [id, intent] of this.#setupIntents) if (intent.userId === userId) this.#setupIntents.delete(id);
    const tripIds = new Set(
      [...this.#trips.values()].filter((trip) => trip.userId === userId).map((trip) => trip.id)
    );
    for (const tripId of tripIds) {
      this.#trips.delete(tripId);
      this.#recommendations.delete(tripId);
      this.#personSelections.delete(tripId);
      this.#tripActivity.delete(tripId);
      this.#tripPassengers.delete(tripId);
    }
    for (const [watchId, watch] of this.#watches) {
      if (tripIds.has(watch.tripId)) {
        this.#watches.delete(watchId);
        this.#watchSpecs.delete(watchId);
      }
    }
    for (const [id, notification] of this.#notifications) if (notification.userId === userId) this.#notifications.delete(id);
    for (const [id, draft] of this.#tripPlanDrafts) if (draft.userId === userId) this.#tripPlanDrafts.delete(id);
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
      travellerSetupPromptedAt: null,
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
          ? {
              notificationMode: input.alertsEnabled
                ? current.notificationMode === "off" ? "smart" : current.notificationMode
                : "off"
            }
        : {}),
      ...(input.digestHourLocal !== undefined ? { digestHourLocal: input.digestHourLocal } : {}),
      ...(input.priceRiseAlertsEnabled !== undefined
        ? { priceRiseAlertsEnabled: input.priceRiseAlertsEnabled }
        : {}),
      ...(input.betterOptionAlertsEnabled !== undefined
        ? { betterOptionAlertsEnabled: input.betterOptionAlertsEnabled }
        : {}),
      ...(input.trackingCheckinsEnabled !== undefined
        ? { trackingCheckinsEnabled: input.trackingCheckinsEnabled }
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
    if (updated.notificationMode === "off" || !updated.trackingCheckinsEnabled) {
      for (const [watchId, watch] of this.#watches) {
        if (this.#trips.get(watch.tripId)?.userId !== userId) continue;
        this.#watches.set(watchId, {
          ...watch,
          checkInSentAt: null,
          autoPauseAt: null,
          updatedAt: now.toISOString()
        });
      }
      for (const [notificationId, notification] of this.#notifications) {
        if (
          notification.userId === userId
          && notification.status === "pending"
          && (
            updated.notificationMode === "off"
            || notification.kind === "tracking_checkin"
          )
        ) {
          this.#notifications.set(notificationId, {
            ...notification,
            status: "superseded"
          });
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

  async markTravellerSetupPrompted(userId: string, now: Date): Promise<boolean> {
    await this.ensureProfile(userId, now);
    const profile = this.#profiles.get(userId);
    if (!profile || profile.travellerSetupPromptedAt) return false;
    profile.travellerSetupPromptedAt = now.toISOString();
    profile.updatedAt = now.toISOString();
    return true;
  }

  async listPassengers(userId: string): Promise<Passenger[]> {
    return [...this.#passengers.values()]
      .filter((passenger) => passenger.userId === userId)
      .sort((left, right) => {
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        return left.createdAt.localeCompare(right.createdAt);
      })
      .map(clone);
  }

  async getPassenger(userId: string, passengerId: string): Promise<Passenger | null> {
    const passenger = this.#passengers.get(passengerId);
    return passenger && passenger.userId === userId ? clone(passenger) : null;
  }

  async createPassenger(userId: string, input: CreatePassengerInput, now: Date): Promise<Passenger> {
    if (!await this.getUser(userId)) throw new Error("User not found");
    const existing = [...this.#passengers.values()].filter((passenger) => passenger.userId === userId);
    if (existing.length >= 8) throw new Error("A traveller may have at most 8 passenger records");
    const timestamp = now.toISOString();
    const makeDefault = input.isDefault === true || existing.length === 0;
    if (makeDefault) {
      for (const passenger of existing) {
        if (passenger.isDefault) {
          this.#passengers.set(passenger.id, { ...passenger, isDefault: false, updatedAt: timestamp });
        }
      }
    }
    const passenger: Passenger = {
      id: randomUUID(),
      userId,
      givenName: input.givenName,
      familyName: input.familyName,
      title: input.title ?? null,
      gender: input.gender ?? null,
      bornOn: input.bornOn ?? null,
      email: input.email ?? null,
      phoneNumber: input.phoneNumber ?? null,
      isDefault: makeDefault,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.#passengers.set(passenger.id, passenger);
    return clone(passenger);
  }

  async updatePassenger(
    userId: string,
    passengerId: string,
    input: UpdatePassengerInput,
    now: Date
  ): Promise<Passenger> {
    const current = await this.getPassenger(userId, passengerId);
    if (!current) throw new Error("Passenger not found");
    const timestamp = now.toISOString();
    if (input.isDefault === true) {
      for (const passenger of this.#passengers.values()) {
        if (passenger.userId === userId && passenger.isDefault && passenger.id !== passengerId) {
          this.#passengers.set(passenger.id, { ...passenger, isDefault: false, updatedAt: timestamp });
        }
      }
    }
    const updated: Passenger = {
      ...current,
      ...(input.givenName !== undefined ? { givenName: input.givenName } : {}),
      ...(input.familyName !== undefined ? { familyName: input.familyName } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.bornOn !== undefined ? { bornOn: input.bornOn } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      updatedAt: timestamp
    };
    this.#passengers.set(passengerId, updated);
    return clone(updated);
  }

  async deletePassenger(userId: string, passengerId: string): Promise<void> {
    const passenger = await this.getPassenger(userId, passengerId);
    if (!passenger) return;
    this.#passengers.delete(passengerId);
    for (const [tripId, assignments] of this.#tripPassengers) {
      const next = assignments.filter((assignment) => assignment.passengerId !== passengerId);
      if (next.length !== assignments.length) this.#tripPassengers.set(tripId, next);
    }
    if (passenger.isDefault) {
      const remaining = [...this.#passengers.values()]
        .filter((candidate) => candidate.userId === userId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const nextDefault = remaining[0];
      if (nextDefault) {
        this.#passengers.set(nextDefault.id, { ...nextDefault, isDefault: true });
      }
    }
  }

  async setDefaultPassenger(userId: string, passengerId: string, now: Date): Promise<Passenger> {
    return this.updatePassenger(userId, passengerId, { isDefault: true }, now);
  }

  async listTripPassengers(userId: string, tripId: string): Promise<Passenger[]> {
    const trip = await this.getTrip(userId, tripId);
    if (!trip) return [];
    const assignments = [...(this.#tripPassengers.get(tripId) ?? [])]
      .sort((left, right) => left.ordinal - right.ordinal);
    return assignments
      .map((assignment) => this.#passengers.get(assignment.passengerId))
      .filter((passenger): passenger is Passenger => Boolean(passenger) && passenger!.userId === userId)
      .map(clone);
  }

  async setTripPassengers(userId: string, tripId: string, passengerIds: string[]): Promise<void> {
    const trip = await this.getTrip(userId, tripId);
    if (!trip) throw new TripNotFoundError();
    for (const passengerId of passengerIds) {
      const passenger = await this.getPassenger(userId, passengerId);
      if (!passenger) throw new Error("Passenger not found");
    }
    this.#tripPassengers.set(
      tripId,
      passengerIds.map((passengerId, ordinal) => ({ passengerId, ordinal }))
    );
  }

  async listPaymentMethods(userId: string): Promise<PaymentMethod[]> {
    return [...this.#paymentMethods.values()]
      .filter((method) => method.userId === userId && method.status === "active")
      .sort((left, right) => {
        if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
        return left.createdAt.localeCompare(right.createdAt);
      })
      .map(clone);
  }

  async reservePaymentCardSetupIntent(
    userId: string,
    setupIntentId: string,
    now: Date
  ): Promise<PaymentCardSetupIntent> {
    if (!await this.getUser(userId)) throw new Error("User not found");
    await this.cleanupPaymentCardSetupIntents(now);
    const existing = this.#setupIntents.get(setupIntentId);
    if (existing) {
      if (existing.userId !== userId) throw new PaymentSetupConflictError("setup_intent_invalid");
      if (existing.status === "pending" && Date.parse(existing.expiresAt) > now.getTime()) {
        return clone(existing);
      }
      if (existing.status === "completed") {
        return clone(existing);
      }
      throw new PaymentSetupConflictError("setup_intent_invalid");
    }
    const pending = [...this.#setupIntents.values()].find(
      (intent) => intent.userId === userId
        && intent.status === "pending"
        && Date.parse(intent.expiresAt) > now.getTime()
    );
    if (pending) throw new PaymentSetupInProgressError();
    const totalRows = [...this.#paymentMethods.values()].filter((method) => method.userId === userId).length;
    if (totalRows >= MAX_PAYMENT_METHODS_PER_USER) throw new PaymentMethodLimitError();
    const timestamp = now.toISOString();
    const intent: PaymentCardSetupIntent = {
      id: setupIntentId,
      userId,
      status: "pending",
      paymentMethodId: null,
      expiresAt: new Date(now.getTime() + SETUP_INTENT_TTL_MS).toISOString(),
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.#setupIntents.set(setupIntentId, intent);
    return clone(intent);
  }

  async finalizePaymentMethod(
    userId: string,
    input: SavePaymentMethodInput,
    now: Date
  ): Promise<PaymentMethod> {
    if (!await this.getUser(userId)) throw new Error("User not found");
    await this.cleanupPaymentCardSetupIntents(now);
    const intent = this.#setupIntents.get(input.setupIntentId);
    if (!intent || intent.userId !== userId) {
      throw new PaymentSetupConflictError("setup_intent_invalid");
    }
    if (intent.status === "completed") {
      if (!intent.paymentMethodId) throw new PaymentSetupConflictError("setup_intent_invalid");
      const existing = this.#paymentMethods.get(intent.paymentMethodId);
      if (!existing || existing.userId !== userId) {
        throw new PaymentSetupConflictError("setup_intent_invalid");
      }
      if (existing.providerCardId !== input.cardId) {
        throw new PaymentSetupConflictError("setup_intent_mismatch");
      }
      return clone(existing);
    }
    if (intent.status !== "pending" || Date.parse(intent.expiresAt) <= now.getTime()) {
      throw new PaymentSetupConflictError("setup_intent_invalid");
    }
    const pendingDeletion = [...this.#cardDeletions.values()].find(
      (deletion) => deletion.provider === "duffel" && deletion.providerCardId === input.cardId
    );
    if (pendingDeletion) throw new PaymentSetupConflictError("card_pending_deletion");

    const removedExisting = [...this.#paymentMethods.values()].find(
      (method) => method.userId === userId
        && method.providerCardId === input.cardId
        && method.status === "removed"
    );
    if (removedExisting) throw new PaymentSetupConflictError("card_pending_deletion");

    const timestamp = now.toISOString();
    const retiring = [...this.#paymentMethods.values()].filter(
      (method) => method.userId === userId && method.status === "active"
    );
    for (const method of retiring) {
      if (method.providerCardId === input.cardId) continue;
      this.#paymentMethods.set(method.id, {
        ...method,
        status: "removed",
        isDefault: false,
        updatedAt: timestamp
      });
      this.#enqueueCardDeletion({ ...method, status: "removed", isDefault: false }, now);
    }

    const existingActive = [...this.#paymentMethods.values()].find(
      (method) => method.userId === userId && method.providerCardId === input.cardId
    );
    let method: PaymentMethod;
    if (existingActive) {
      method = {
        ...existingActive,
        brand: input.brand,
        last4: input.last4,
        cardholderName: input.cardholderName,
        status: "active",
        isDefault: true,
        updatedAt: timestamp
      };
      this.#paymentMethods.set(existingActive.id, method);
    } else {
      const totalRows = [...this.#paymentMethods.values()].filter((entry) => entry.userId === userId).length;
      if (totalRows >= MAX_PAYMENT_METHODS_PER_USER) throw new PaymentMethodLimitError();
      method = {
        id: randomUUID(),
        userId,
        provider: "duffel",
        providerCardId: input.cardId,
        brand: input.brand,
        last4: input.last4,
        cardholderName: input.cardholderName,
        status: "active",
        isDefault: true,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.#paymentMethods.set(method.id, method);
    }

    this.#setupIntents.set(intent.id, {
      ...intent,
      status: "completed",
      paymentMethodId: method.id,
      completedAt: timestamp,
      updatedAt: timestamp
    });
    return clone(method);
  }

  async removePaymentMethod(userId: string, paymentMethodId: string, now: Date): Promise<void> {
    const method = this.#paymentMethods.get(paymentMethodId);
    if (!method || method.userId !== userId || method.status !== "active") return;
    const updated: PaymentMethod = {
      ...method,
      status: "removed",
      isDefault: false,
      updatedAt: now.toISOString()
    };
    this.#paymentMethods.set(paymentMethodId, updated);
    this.#enqueueCardDeletion(updated, now);
  }

  async claimCardDeletions(
    workerId: string,
    now: Date,
    leaseMs: number,
    limit: number
  ): Promise<PaymentCardDeletion[]> {
    const claimed: PaymentCardDeletion[] = [];
    const nowMs = now.getTime();
    const candidates = [...this.#cardDeletions.values()]
      .filter((deletion) => {
        if (Date.parse(deletion.availableAt) > nowMs) return false;
        if (deletion.status === "queued") return true;
        if (deletion.status === "running") {
          return !deletion.leaseExpiresAt || Date.parse(deletion.leaseExpiresAt) <= nowMs;
        }
        return false;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const deletion of candidates) {
      if (claimed.length >= limit) break;
      const next: PaymentCardDeletion = {
        ...deletion,
        status: "running",
        attempts: deletion.attempts + 1,
        claimedBy: workerId,
        leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        updatedAt: now.toISOString()
      };
      this.#cardDeletions.set(deletion.id, next);
      claimed.push(clone(next));
    }
    return claimed;
  }

  async completeCardDeletion(workerId: string, deletionId: string, now: Date): Promise<boolean> {
    const deletion = this.#cardDeletions.get(deletionId);
    if (!deletion || deletion.status !== "running" || deletion.claimedBy !== workerId) return false;
    if (deletion.paymentMethodId) {
      const method = this.#paymentMethods.get(deletion.paymentMethodId);
      if (method && method.status === "removed" && method.providerCardId === deletion.providerCardId) {
        this.#paymentMethods.delete(deletion.paymentMethodId);
      }
    }
    this.#cardDeletions.delete(deletionId);
    void now;
    return true;
  }

  async failCardDeletion(
    workerId: string,
    deletionId: string,
    errorCode: string,
    retryAfterMs: number | null,
    now: Date
  ): Promise<boolean> {
    const deletion = this.#cardDeletions.get(deletionId);
    if (!deletion || deletion.status !== "running" || deletion.claimedBy !== workerId) return false;
    const delay = retryAfterMs !== null && retryAfterMs > 0
      ? Math.min(retryAfterMs, 24 * 60 * 60_000)
      : cardDeletionBackoffMs(deletion.attempts);
    this.#cardDeletions.set(deletionId, {
      ...deletion,
      status: "queued",
      availableAt: new Date(now.getTime() + delay).toISOString(),
      claimedBy: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode.slice(0, 100),
      lastErrorDetail: truncateErrorDetail(errorCode),
      updatedAt: now.toISOString()
    });
    return true;
  }

  async countPendingCardDeletions(): Promise<{
    queued: number;
    running: number;
    highAttempts: number;
    oldestQueuedAgeMs: number | null;
  }> {
    const now = Date.now();
    let queued = 0;
    let running = 0;
    let highAttempts = 0;
    let oldestQueuedAgeMs: number | null = null;
    for (const deletion of this.#cardDeletions.values()) {
      if (deletion.attempts >= 5) highAttempts += 1;
      if (deletion.status === "queued") {
        queued += 1;
        const age = now - Date.parse(deletion.createdAt);
        if (oldestQueuedAgeMs === null || age > oldestQueuedAgeMs) oldestQueuedAgeMs = age;
      } else if (deletion.status === "running") {
        running += 1;
      }
    }
    return { queued, running, highAttempts, oldestQueuedAgeMs };
  }

  async cleanupPaymentCardSetupIntents(now: Date): Promise<number> {
    let removed = 0;
    const nowMs = now.getTime();
    for (const [id, intent] of this.#setupIntents) {
      if (intent.status === "pending" && Date.parse(intent.expiresAt) <= nowMs) {
        this.#setupIntents.set(id, {
          ...intent,
          status: "expired",
          updatedAt: now.toISOString()
        });
      }
      const current = this.#setupIntents.get(id)!;
      if (current.status === "expired") {
        this.#setupIntents.delete(id);
        removed += 1;
        continue;
      }
      if (
        current.status === "completed"
        && current.completedAt
        && Date.parse(current.completedAt) <= nowMs - SETUP_INTENT_COMPLETED_RETENTION_MS
      ) {
        this.#setupIntents.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  #enqueueCardDeletion(method: PaymentMethod, now: Date): void {
    const existing = [...this.#cardDeletions.values()].find(
      (deletion) => deletion.provider === method.provider
        && deletion.providerCardId === method.providerCardId
    );
    if (existing) {
      if (!existing.paymentMethodId && method.id) {
        this.#cardDeletions.set(existing.id, {
          ...existing,
          paymentMethodId: method.id,
          updatedAt: now.toISOString()
        });
      }
      return;
    }
    const deletion: PaymentCardDeletion = {
      id: randomUUID(),
      provider: "duffel",
      providerCardId: method.providerCardId,
      paymentMethodId: method.id,
      status: "queued",
      attempts: 0,
      availableAt: now.toISOString(),
      claimedBy: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.#cardDeletions.set(deletion.id, deletion);
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
    this.#updates.add(updateKey);
    void userId;
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

  async appendMessage(userId: string, role: "user" | "assistant", content: string, now: Date): Promise<string> {
    const conversation = this.#conversations.get(userId);
    if (!conversation) throw new Error("Conversation not found");
    const id = randomUUID();
    conversation.recentMessages.push({ id, role, content: content.trim(), createdAt: now.toISOString() });
    return id;
  }

  async setActiveTrip(userId: string, tripId: string | null, now: Date): Promise<void> {
    const conversation = this.#conversations.get(userId);
    if (!conversation) throw new Error("Conversation not found");
    if (tripId && this.#trips.get(tripId)?.userId !== userId) throw new TripNotFoundError();
    conversation.activeTripId = tripId;
    void now;
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

  async getWatch(userId: string, tripId: string): Promise<Watch | null> {
    if (this.#trips.get(tripId)?.userId !== userId) return null;
    return clone([...this.#watches.values()].find((watch) => watch.tripId === tripId) ?? null);
  }

  async createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<TripCreationResult> {
    const duplicate = [...this.#trips.values()].find((trip) =>
      trip.userId === userId
      && isActiveTripStatus(trip.status)
      && JSON.stringify(trip.brief) === JSON.stringify(input.brief)
    );
    if (duplicate) {
      const existingWatch = [...this.#watches.values()].find((watch) => watch.tripId === duplicate.id);
      if (!existingWatch) throw new Error("Trip Watch not found");
      await this.setActiveTrip(userId, duplicate.id, now);
      return clone({ trip: duplicate, watch: existingWatch, created: false });
    }
    const active = [...this.#trips.values()].filter((trip) => trip.userId === userId && isActiveTripStatus(trip.status));
    if (active.length >= MAX_ACTIVE_TRIPS_PER_USER) throw new TripLimitError();
    const timestamp = now.toISOString();
    const startsAt = trackingStartsAt(input.brief.departureWindow.start);
    const futureTracking = startsAt.getTime() > now.getTime();
    const trip: Trip = {
      id: randomUUID(), userId, title: input.title, status: "tracking", version: 1,
      brief: clone(input.brief), archivedAt: null, archiveReason: null,
      createdAt: timestamp, updatedAt: timestamp
    };
    const watch: Watch = {
      id: randomUUID(), tripId: trip.id, status: "active", cadenceHours: input.cadenceHours,
      nextCheckAt: timestamp, lastCheckAt: null, lastManualRefreshAt: null,
      trackingStartsAt: futureTracking ? startsAt.toISOString() : null,
      baselineCompletedAt: null,
      activatedAt: futureTracking ? null : timestamp,
      lastUserActivityAt: timestamp,
      checkInSentAt: null,
      autoPauseAt: null,
      priceRiseItineraryKey: null,
      priceRiseArmed: true,
      delayedAt: null, delayReason: null,
      createdAt: timestamp, updatedAt: timestamp
    };
    this.#trips.set(trip.id, trip);
    this.#watches.set(watch.id, watch);
    this.#setSpecs(watch.id, specs);
    this.#recordTripActivity(trip.id, "trip_created", clone(input), now);
    await this.setActiveTrip(userId, trip.id, now);
    for (const specId of new Set(specs.map((spec) => spec.id))) {
      await this.evaluateTripsForSearchSpec(specId, now);
      if (this.#recommendations.has(trip.id)) {
        await this.finalizeFarFutureBaseline(specId, now);
      }
    }
    return clone({
      trip: this.#trips.get(trip.id) ?? trip,
      watch: this.#watches.get(watch.id) ?? watch,
      created: true
    });
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
    const updated: Trip = {
      ...trip,
      brief: clone(input.brief),
      status: "tracking",
      version: trip.version + 1,
      updatedAt: now.toISOString()
    };
    this.#trips.set(tripId, updated);
    this.#recommendations.delete(tripId);
    const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === tripId);
    if (watch) {
      const startsAt = trackingStartsAt(input.brief.departureWindow.start);
      const futureTracking = startsAt.getTime() > now.getTime();
      this.#setSpecs(watch.id, specs);
      this.#watches.set(watch.id, {
        ...watch,
        status: "active",
        nextCheckAt: now.toISOString(),
        trackingStartsAt: futureTracking ? startsAt.toISOString() : null,
        baselineCompletedAt: null,
        activatedAt: futureTracking ? null : now.toISOString(),
        lastUserActivityAt: now.toISOString(),
        checkInSentAt: null,
        autoPauseAt: null,
        priceRiseItineraryKey: null,
        priceRiseArmed: true,
        delayedAt: null,
        delayReason: null,
        updatedAt: now.toISOString()
      });
    }
    this.#recordTripActivity(tripId, "trip_brief_updated", clone(input.brief), now);
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
      return trip && watch ? { draft: current, result: { trip, watch, created: false } } : null;
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

  async applyTripAction(userId: string, tripId: string, action: TripAction, now: Date): Promise<Trip> {
    const trip = this.#requiredTrip(userId, tripId);
    if (trip.version !== action.expectedVersion) throw new TripVersionConflictError(trip.version);
    const watch = [...this.#watches.values()].find((item) => item.tripId === tripId);
    let status = trip.status;
    if (action.type === "pause") status = "paused";
    if (action.type === "resume" || action.type === "refresh") status = "tracking";
    if (action.type === "cancel") status = "cancelled";
    if (action.type === "complete") status = "completed";
    const updated = { ...trip, status, version: trip.version + 1, updatedAt: now.toISOString() };
    this.#trips.set(tripId, updated);
    if (watch) {
      const futureScheduled = Boolean(
        watch.trackingStartsAt
        && Date.parse(watch.trackingStartsAt) > now.getTime()
        && watch.baselineCompletedAt
      );
      const watchStatus = status === "paused"
        ? "paused"
        : ["cancelled", "completed"].includes(status)
          ? "completed"
          : action.type === "resume" && futureScheduled
            ? "scheduled"
            : "active";
      this.#watches.set(watch.id, {
        ...watch, status: watchStatus,
        ...(action.type === "refresh"
          ? { nextCheckAt: now.toISOString() }
          : action.type === "resume"
            ? { nextCheckAt: futureScheduled ? watch.trackingStartsAt : now.toISOString() }
            : {}),
        ...(action.type === "refresh" ? { lastManualRefreshAt: now.toISOString() } : {}),
        lastUserActivityAt: now.toISOString(),
        checkInSentAt: null,
        autoPauseAt: null,
        updatedAt: now.toISOString()
      });
    }
    this.#recordTripActivity(tripId, `trip_${action.type}`, clone(action), now);
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
    this.#requiredTrip(userId, tripId);
    const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === tripId);
    if (!watch) throw new Error("Trip Watch not found");
    this.#watches.set(watch.id, {
      ...watch,
      lastUserActivityAt: now.toISOString(),
      checkInSentAt: null,
      autoPauseAt: null,
      updatedAt: now.toISOString()
    });
    for (const [notificationId, notification] of this.#notifications) {
      if (
        notification.tripId === tripId
        && notification.kind === "tracking_checkin"
        && notification.status === "pending"
      ) {
        this.#notifications.set(notificationId, {
          ...notification,
          status: "superseded"
        });
      }
    }
  }

  async respondToTrackingCheckIn(
    userId: string,
    tripId: string,
    action: "keep" | "pause",
    now: Date
  ): Promise<Trip> {
    const trip = this.#requiredTrip(userId, tripId);
    const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === tripId);
    if (!watch) throw new Error("Trip Watch not found");
    const futureScheduled = Boolean(
      watch.trackingStartsAt
      && Date.parse(watch.trackingStartsAt) > now.getTime()
      && watch.baselineCompletedAt
    );
    const nextTrip: Trip = {
      ...trip,
      status: action === "pause"
        ? "paused"
        : this.#recommendations.has(tripId) ? "recommended" : "tracking",
      version: trip.version + 1,
      updatedAt: now.toISOString()
    };
    this.#trips.set(tripId, nextTrip);
    this.#watches.set(watch.id, {
      ...watch,
      status: action === "pause" ? "paused" : futureScheduled ? "scheduled" : "active",
      nextCheckAt: action === "pause"
        ? watch.nextCheckAt
        : futureScheduled ? watch.trackingStartsAt : now.toISOString(),
      lastUserActivityAt: now.toISOString(),
      checkInSentAt: null,
      autoPauseAt: null,
      updatedAt: now.toISOString()
    });
    this.#recordTripActivity(tripId, action === "pause" ? "tracking_checkin_paused" : "tracking_checkin_kept", {}, now);
    return clone(nextTrip);
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
      if (
        watch.status === "scheduled"
        && watch.trackingStartsAt
        && Date.parse(watch.trackingStartsAt) <= nowMs
      ) return true;
      if (
        watch.status === "active"
        && watch.autoPauseAt
        && Date.parse(watch.autoPauseAt) <= nowMs
      ) return true;
      const profile = this.#profiles.get(trip.userId);
      if (
        watch.status === "active"
        && profile?.notificationMode !== "off"
        && profile?.trackingCheckinsEnabled
        && !watch.checkInSentAt
        && Date.parse(watch.lastUserActivityAt) <= nowMs - INACTIVITY_CHECKIN_MS
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
    for (const [userId, profile] of this.#profiles) {
      if (!["smart", "daily"].includes(profile.notificationMode)) continue;
      const user = [...this.#usersByTelegram.values()]
        .find((candidate) => candidate.id === userId);
      if (
        !user
        || !digestDue(now, user.timezone, profile.digestHourLocal, this.#lastDigestAt.get(userId))
      ) continue;
      const hasDigestTrip = [...this.#trips.values()].some((trip) => {
        if (trip.userId !== userId || !isActiveTripStatus(trip.status)) return false;
        const watch = [...this.#watches.values()]
          .find((candidate) => candidate.tripId === trip.id);
        return watch?.status === "active" && this.#recommendations.has(trip.id);
      });
      if (hasDigestTrip) return true;
    }
    return false;
  }

  async maintainTracking(now: Date): Promise<TrackingMaintenance> {
    let activated = 0;
    let checkInsQueued = 0;
    let autoPaused = 0;
    for (const [watchId, watch] of this.#watches) {
      const trip = this.#trips.get(watch.tripId);
      if (!trip) continue;
      const profile = this.#profiles.get(trip.userId) ?? await this.ensureProfile(trip.userId, now);
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
          checkInSentAt: null,
          autoPauseAt: null,
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
        if (["smart", "daily"].includes(profile.notificationMode)) {
          this.#lastDigestAt.set(trip.userId, now.toISOString());
        }
        activated += 1;
        continue;
      }
      if (watch.status !== "active") continue;
      if (watch.autoPauseAt && Date.parse(watch.autoPauseAt) <= now.getTime()) {
        this.#watches.set(watchId, {
          ...watch,
          status: "paused",
          checkInSentAt: null,
          autoPauseAt: null,
          updatedAt: now.toISOString()
        });
        this.#trips.set(trip.id, {
          ...trip,
          status: "paused",
          version: trip.version + 1,
          updatedAt: now.toISOString()
        });
        if (profile.notificationMode !== "off") {
          this.#enqueueSimpleNotification(
            trip,
            "tracking_paused",
            `${trip.id}:tracking_paused:${watch.autoPauseAt}`,
            { tripTitle: trip.title },
            now
          );
        }
        autoPaused += 1;
        continue;
      }
      if (
        profile.notificationMode !== "off"
        && profile.trackingCheckinsEnabled
        && !watch.checkInSentAt
        && Date.parse(watch.lastUserActivityAt) <= now.getTime() - INACTIVITY_CHECKIN_MS
      ) {
        const checkInSentAt = now.toISOString();
        const user = [...this.#usersByTelegram.values()]
          .find((candidate) => candidate.id === trip.userId);
        const deliveryAt = user ? deliveryTime(now, user.timezone, profile) : now;
        this.#watches.set(watchId, {
          ...watch,
          checkInSentAt,
          autoPauseAt: new Date(
            deliveryAt.getTime() + INACTIVITY_AUTO_PAUSE_MS
          ).toISOString(),
          updatedAt: checkInSentAt
        });
        if (this.#enqueueSimpleNotification(
          trip,
          "tracking_checkin",
          `${trip.id}:tracking_checkin:${checkInSentAt.slice(0, 10)}`,
          {
            tripTitle: trip.title,
            departureDate: trip.brief.departureWindow.start
          },
          now
        )) checkInsQueued += 1;
      }
    }
    return { activated, checkInsQueued, autoPaused };
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

  async enqueueDueDigests(now: Date): Promise<number> {
    let queued = 0;
    for (const [userId, profile] of this.#profiles) {
      if (!["smart", "daily"].includes(profile.notificationMode)) continue;
      const user = [...this.#usersByTelegram.values()].find((candidate) => candidate.id === userId);
      if (!user || !digestDue(now, user.timezone, profile.digestHourLocal, this.#lastDigestAt.get(userId))) {
        continue;
      }
      const trips = [...this.#trips.values()].filter((trip) => {
        if (trip.userId !== userId || !isActiveTripStatus(trip.status)) return false;
        const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === trip.id);
        return watch?.status === "active" && this.#recommendations.has(trip.id);
      })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, DIGEST_TRIP_LIMIT);
      if (trips.length === 0) continue;
      const recentImmediate = [...this.#notifications.values()].some((notification) =>
        notification.userId === userId
        && ["price_rise", "price_drop", "new_best"].includes(notification.kind)
        && Date.parse(notification.createdAt) >= now.getTime() - 3 * 3_600_000
      );
      if (recentImmediate) {
        this.#lastDigestAt.set(userId, now.toISOString());
        this.#clearPendingDigestChanges(trips);
        continue;
      }
      const primary = trips[0]!;
      const inserted = this.#enqueueSimpleNotification(
        primary,
        "daily_digest",
        `${userId}:daily_digest:${localDateKey(now, user.timezone)}`,
        {
          // The filter above guarantees a recommendation for every trip here.
          // This shape is the contract Telegram renders from; keep it aligned
          // with the Postgres digest query.
          trips: trips.map((trip) => ({
            tripId: trip.id,
            tripTitle: trip.title,
            price: this.#recommendations.get(trip.id)!.price,
            currency: this.#recommendations.get(trip.id)!.currency,
            summary: this.#recommendations.get(trip.id)!.summary,
            snapshot: this.#recommendations.get(trip.id)!.snapshot,
            priceRise: this.#digestPriceRise(trip.id, now)
          }))
        },
        now
      );
      if (inserted) queued += 1;
      this.#lastDigestAt.set(userId, now.toISOString());
      this.#clearPendingDigestChanges(trips);
    }
    return queued;
  }

  async scheduleDueSearchRuns(now: Date, freshnessMs: number, limit: number): Promise<number> {
    const due = [...this.#watches.values()]
      .filter((watch) => watch.status === "active" && watch.nextCheckAt !== null && watch.nextCheckAt <= now.toISOString())
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
        nextCheckAt: new Date(now.getTime() + adaptiveWatchIntervalMs(
          watch.cadenceHours,
          trip?.brief.departureWindow.start ?? now.toISOString().slice(0, 10),
          now
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
        delayedAt: null,
        delayReason: null,
        updatedAt: now.toISOString()
      });
    }
    void providerRequestId;
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

  async failSearchRun(workerId: string, runId: string, error: string, retryAfterMs: number | null, now: Date): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run || run.claimedBy !== workerId || run.status !== "running") throw new Error("Search run lease is not owned by this worker");
    const retry = run.attempt < 3;
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
    void searchSpecId;
    void now;
    return 0;
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
      const pendingDigestChange = ["smart", "daily"].includes(profile.notificationMode)
        ? previous && qualifies
          ? {
              current: clone(best.offer),
              previous: clone(previous.snapshot.current),
              rankingMode: profile.rankingMode,
              reasonCodes,
              createdAt: now.toISOString()
            }
          : previous?.snapshot.pendingDigestChange ?? null
        : null;
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
          createdAt: now.toISOString(),
          pendingDigestChange
        }
      };
      this.#recommendations.set(trip.id, recommendation);
      const farBaseline = Boolean(
        watch?.trackingStartsAt
        && Date.parse(watch.trackingStartsAt) > now.getTime()
        && !watch.baselineCompletedAt
      );
      const finalWeek = daysUntilDeparture(trip.brief.departureWindow.start, now) <= 7;
      const immediateInitial = farBaseline || profile.notificationMode === "changes_only";
      const immediateImprovement = profile.betterOptionAlertsEnabled && (
        profile.notificationMode === "changes_only"
        || (profile.notificationMode === "smart" && finalWeek)
      );
      const kind = profile.notificationMode === "off"
        ? null
        : !previous
          ? immediateInitial ? "initial_results" : null
          : qualifies && immediateImprovement && profile.rankingMode === "cheapest"
            ? "price_drop"
            : qualifies && immediateImprovement
              ? "new_best"
              : null;
      if (kind) {
        if (this.#enqueueNotification(trip, kind, recommendation, previous, now)) changed += 1;
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
      if (["inventory_gap", "watch_attention"].includes(notification.kind)) {
        this.#notifications.set(notification.id, { ...notification, status: "superseded" });
      }
    }
    const resultKinds = new Set<CaptainNotification["kind"]>(["initial_results", "price_drop", "new_best"]);
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

  async markNotificationSent(notificationId: string, telegramMessageId: number, now: Date): Promise<void> {
    const notification = this.#notifications.get(notificationId);
    if (notification) this.#notifications.set(notificationId, {
      ...notification,
      status: "sent",
      telegramMessageId
    });
    void now;
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
    now: Date
  ): void {
    const activity = this.#tripActivity.get(tripId) ?? [];
    activity.unshift({
      id: randomUUID(),
      eventType,
      payload,
      createdAt: now.toISOString()
    });
    this.#tripActivity.set(tripId, activity.slice(0, 50));
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
        ...recommendation,
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
    const finalWeek = daysUntilDeparture(trip.brief.departureWindow.start, now) <= 7;
    const immediate = profile.priceRiseAlertsEnabled && (
      profile.notificationMode === "changes_only"
      || (profile.notificationMode === "smart" && finalWeek)
    );
    const queued = thresholdReached && armed && immediate
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

  #digestPriceRise(
    tripId: string,
    now: Date
  ): { increase: number; percent: number } | null {
    const watch = [...this.#watches.values()].find((candidate) => candidate.tripId === tripId);
    const itineraryKey = watch?.priceRiseItineraryKey
      ?? this.#recommendations.get(tripId)?.itineraryKey;
    if (!itineraryKey) return null;
    const observations = this.#priceHistory
      .filter((observation) =>
        observation.itineraryKey === itineraryKey
        && Date.parse(observation.observedAt) >= now.getTime() - 7 * 86_400_000
      )
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
    const current = observations[0];
    if (!current) return null;
    const low = observations.reduce(
      (minimum, observation) => Math.min(minimum, observation.price),
      current.price
    );
    const increase = current.price - low;
    const percent = low > 0 ? increase / low * 100 : 0;
    return increase >= 20 && percent >= 5 ? { increase, percent } : null;
  }

  #clearPendingDigestChanges(trips: Trip[]): void {
    for (const trip of trips) {
      const recommendation = this.#recommendations.get(trip.id);
      if (!recommendation?.snapshot.pendingDigestChange) continue;
      // Postgres clears this with the jsonb `-` operator, which drops the key
      // outright. The field is optional, so drop it here too rather than
      // leaving an explicit null the real store never returns.
      const { pendingDigestChange: _cleared, ...snapshot } = recommendation.snapshot;
      this.#recommendations.set(trip.id, { ...recommendation, snapshot });
    }
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
      payload,
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

function digestDue(
  now: Date,
  timezone: string,
  digestHourLocal: number,
  lastDigestAt: string | undefined
): boolean {
  try {
    const parts = localParts(now, timezone);
    if (parts.hour < digestHourLocal) return false;
    return !lastDigestAt || localDateKey(new Date(lastDigestAt), timezone) !== parts.date;
  } catch {
    return now.getUTCHours() >= digestHourLocal
      && (!lastDigestAt || lastDigestAt.slice(0, 10) !== now.toISOString().slice(0, 10));
  }
}

function localDateKey(now: Date, timezone: string): string {
  return localParts(now, timezone).date;
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
