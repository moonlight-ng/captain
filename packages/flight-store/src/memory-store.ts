import { randomUUID } from "node:crypto";

import {
  MAX_ACTIVE_TRIPS_PER_USER,
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  type CreateTripInput,
  type OfferSnapshot,
  type SearchSpec,
  type Trip,
  type TripAction,
  type UpdateTripInput,
  type Watch
} from "@agents/flight-domain";

import type {
  CaptainNotification,
  CaptainPlatformStore,
  CaptainUser,
  ClaimedSearchRun,
  CompletedProviderOffer,
  ConversationContext,
  TelegramUserInput,
  TripRecommendation
} from "./contracts.js";
import { offerScore, recommendationSummary } from "./ranking.js";

type MemoryConversation = ConversationContext & { userId: string };
type MemoryRun = ClaimedSearchRun & {
  status: "queued" | "running" | "completed" | "failed";
  claimedBy: string | null;
  scheduledAt: string;
  completedAt: string | null;
  error: string | null;
};
type StoredNotification = CaptainNotification & { status: "pending" | "sent" | "failed"; availableAt: string; dedupKey: string; error: string | null };

export class MemoryCaptainPlatformStore implements CaptainPlatformStore {
  readonly #usersByTelegram = new Map<number, CaptainUser>();
  readonly #updates = new Set<string>();
  readonly #conversations = new Map<string, MemoryConversation>();
  readonly #trips = new Map<string, Trip>();
  readonly #watches = new Map<string, Watch>();
  readonly #specs = new Map<string, SearchSpec>();
  readonly #watchSpecs = new Map<string, Set<string>>();
  readonly #runs = new Map<string, MemoryRun>();
  readonly #offers = new Map<string, OfferSnapshot>();
  readonly #recommendations = new Map<string, TripRecommendation>();
  readonly #notifications = new Map<string, StoredNotification>();

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
    return clone({ ...conversation, recentMessages: conversation.recentMessages.slice(-limit) });
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

  async getTrip(userId: string, tripId: string): Promise<Trip | null> {
    const trip = this.#trips.get(tripId);
    return trip?.userId === userId ? clone(trip) : null;
  }

  async getWatch(userId: string, tripId: string): Promise<Watch | null> {
    if (this.#trips.get(tripId)?.userId !== userId) return null;
    return clone([...this.#watches.values()].find((watch) => watch.tripId === tripId) ?? null);
  }

  async getTripByLegacyKey(userId: string, legacyAgentKey: string): Promise<Trip | null> {
    return clone([...this.#trips.values()].find((trip) => trip.userId === userId && trip.legacyAgentKey === legacyAgentKey) ?? null);
  }

  async createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<{ trip: Trip; watch: Watch }> {
    const duplicate = [...this.#trips.values()].find((trip) =>
      trip.userId === userId
      && !["cancelled", "completed"].includes(trip.status)
      && JSON.stringify(trip.brief) === JSON.stringify(input.brief)
    );
    if (duplicate) {
      const existingWatch = [...this.#watches.values()].find((watch) => watch.tripId === duplicate.id);
      if (!existingWatch) throw new Error("Trip Watch not found");
      await this.setActiveTrip(userId, duplicate.id, now);
      return clone({ trip: duplicate, watch: existingWatch });
    }
    const active = [...this.#trips.values()].filter((trip) => trip.userId === userId && !["cancelled", "completed"].includes(trip.status));
    if (active.length >= MAX_ACTIVE_TRIPS_PER_USER) throw new TripLimitError();
    const timestamp = now.toISOString();
    const trip: Trip = {
      id: randomUUID(), userId, legacyAgentKey: null, title: input.title, status: "tracking", version: 1,
      brief: clone(input.brief), createdAt: timestamp, updatedAt: timestamp
    };
    const watch: Watch = {
      id: randomUUID(), tripId: trip.id, status: "active", cadenceHours: input.cadenceHours,
      nextCheckAt: timestamp, lastCheckAt: null, createdAt: timestamp, updatedAt: timestamp
    };
    this.#trips.set(trip.id, trip);
    this.#watches.set(watch.id, watch);
    this.#setSpecs(watch.id, specs);
    await this.setActiveTrip(userId, trip.id, now);
    for (const specId of new Set(specs.map((spec) => spec.id))) {
      await this.evaluateTripsForSearchSpec(specId, now);
    }
    return clone({ trip: this.#trips.get(trip.id) ?? trip, watch });
  }

  async updateTrip(userId: string, tripId: string, input: UpdateTripInput, specs: SearchSpec[] | null, now: Date): Promise<Trip> {
    const trip = this.#requiredTrip(userId, tripId);
    if (trip.version !== input.expectedVersion) throw new TripVersionConflictError(trip.version);
    const updated: Trip = {
      ...trip,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.brief !== undefined ? { brief: clone(input.brief), status: "tracking" as const } : {}),
      version: trip.version + 1,
      updatedAt: now.toISOString()
    };
    this.#trips.set(tripId, updated);
    if (specs) {
      const watch = [...this.#watches.values()].find((item) => item.tripId === tripId);
      if (watch) {
        this.#setSpecs(watch.id, specs);
        this.#watches.set(watch.id, { ...watch, status: "active", nextCheckAt: now.toISOString(), updatedAt: now.toISOString() });
      }
    }
    return clone(updated);
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
      const watchStatus = status === "paused" ? "paused" : ["cancelled", "completed"].includes(status) ? "completed" : "active";
      this.#watches.set(watch.id, {
        ...watch, status: watchStatus,
        ...(action.type === "refresh" || action.type === "resume" ? { nextCheckAt: now.toISOString() } : {}),
        updatedAt: now.toISOString()
      });
    }
    return clone(updated);
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

  async scheduleDueSearchRuns(now: Date, freshnessMs: number, limit: number): Promise<number> {
    const due = [...this.#watches.values()]
      .filter((watch) => watch.status === "active" && watch.nextCheckAt !== null && watch.nextCheckAt <= now.toISOString())
      .slice(0, limit);
    const scheduled = new Set<string>();
    for (const watch of due) {
      for (const specId of this.#watchSpecs.get(watch.id) ?? []) {
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
      this.#watches.set(watch.id, {
        ...watch,
        nextCheckAt: new Date(now.getTime() + watch.cadenceHours * 3_600_000).toISOString(),
        updatedAt: now.toISOString()
      });
    }
    return scheduled.size;
  }

  async claimSearchRuns(workerId: string, now: Date, leaseMs: number, limit: number): Promise<ClaimedSearchRun[]> {
    const active = [...this.#runs.values()].filter((run) => run.status === "running" && run.leaseExpiresAt > now.toISOString()).length;
    const available = Math.max(0, 4 - active);
    const candidates = [...this.#runs.values()]
      .filter((run) => run.status === "queued" || (run.status === "running" && run.leaseExpiresAt <= now.toISOString()))
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
    for (const offer of offers) {
      const stored: OfferSnapshot = { ...clone(offer), id: randomUUID(), searchRunId: runId, searchSpecId: run.searchSpecId };
      this.#offers.set(stored.id, stored);
    }
    for (const watch of this.#watchesForSpec(run.searchSpecId)) {
      this.#watches.set(watch.id, { ...watch, lastCheckAt: now.toISOString(), updatedAt: now.toISOString() });
    }
    void providerRequestId;
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
      for (const watch of this.#watchesForSpec(run.searchSpecId)) this.#enqueueAttention(watch.tripId, error, now);
    }
  }

  async evaluateTripsForSearchSpec(searchSpecId: string, now: Date): Promise<number> {
    const tripIds = new Set(this.#watchesForSpec(searchSpecId).map((watch) => watch.tripId));
    let changed = 0;
    for (const tripId of tripIds) {
      const trip = this.#trips.get(tripId)!;
      const offers = await this.listTripOffers(trip.userId, trip.id, now);
      const ranked = offers.map((offer) => ({ offer, score: offerScore(trip.brief, offer) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score || a.offer.price - b.offer.price);
      const best = ranked[0];
      if (!best) continue;
      const previous = this.#recommendations.get(trip.id);
      const recommendation: TripRecommendation = {
        tripId: trip.id, offerId: best.offer.id, itineraryKey: best.offer.itineraryKey,
        score: best.score, price: best.offer.price, currency: best.offer.currency,
        summary: recommendationSummary(best.offer), observedAt: best.offer.observedAt
      };
      this.#recommendations.set(trip.id, recommendation);
      const kind = !previous
        ? "initial_results"
        : best.offer.price <= previous.price * 0.95
          ? "price_drop"
          : previous.itineraryKey !== best.offer.itineraryKey && best.score < previous.score
            ? "new_best"
            : null;
      if (kind) {
        this.#enqueueNotification(trip, kind, recommendation, previous, now);
        changed += 1;
      }
      if (trip.status === "tracking") {
        this.#trips.set(trip.id, { ...trip, status: "recommended", version: trip.version + 1, updatedAt: now.toISOString() });
      }
    }
    return changed;
  }

  async listPendingNotifications(now: Date, limit: number): Promise<CaptainNotification[]> {
    return [...this.#notifications.values()]
      .filter((notification) => notification.status === "pending" && notification.availableAt <= now.toISOString())
      .slice(0, limit)
      .map(clone);
  }

  async markNotificationSent(notificationId: string, now: Date): Promise<void> {
    const notification = this.#notifications.get(notificationId);
    if (notification) this.#notifications.set(notificationId, { ...notification, status: "sent" });
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

  async close(): Promise<void> {}

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

  #watchesForSpec(specId: string): Watch[] {
    return [...this.#watches.values()].filter((watch) => this.#watchSpecs.get(watch.id)?.has(specId));
  }

  #enqueueNotification(
    trip: Trip,
    kind: "initial_results" | "price_drop" | "new_best",
    recommendation: TripRecommendation,
    previous: TripRecommendation | undefined,
    now: Date
  ): void {
    const user = [...this.#usersByTelegram.values()].find((item) => item.id === trip.userId);
    if (!user) return;
    const dedupKey = `${trip.id}:${kind}:${recommendation.itineraryKey}:${recommendation.price}`;
    if ([...this.#notifications.values()].some((item) => item.dedupKey === dedupKey)) return;
    const id = randomUUID();
    this.#notifications.set(id, {
      id, userId: trip.userId, tripId: trip.id, telegramChatId: user.telegramChatId,
      kind,
      payload: {
        tripTitle: trip.title,
        ...recommendation,
        ...(previous ? {
          previousPrice: previous.price,
          dropPercent: previous.price > 0 ? Math.round((1 - recommendation.price / previous.price) * 100) : 0
        } : {})
      },
      attempts: 0,
      status: "pending", availableAt: deliveryTime(now, user.timezone).toISOString(), dedupKey, error: null
    });
  }

  #enqueueAttention(tripId: string, error: string, now: Date): void {
    const trip = this.#trips.get(tripId);
    const user = trip ? [...this.#usersByTelegram.values()].find((item) => item.id === trip.userId) : undefined;
    if (!trip || !user) return;
    const dedupKey = `${trip.id}:watch_attention:${now.toISOString().slice(0, 10)}`;
    if ([...this.#notifications.values()].some((item) => item.dedupKey === dedupKey)) return;
    const id = randomUUID();
    this.#notifications.set(id, {
      id, userId: trip.userId, tripId, telegramChatId: user.telegramChatId,
      kind: "watch_attention", payload: { tripTitle: trip.title, error }, attempts: 0,
      status: "pending", availableAt: deliveryTime(now, user.timezone).toISOString(), dedupKey, error: null
    });
  }
}

function displayName(input: TelegramUserInput): string {
  return input.firstName?.trim() || (input.username ? `@${input.username}` : `traveller ${input.telegramUserId}`);
}

function deliveryTime(now: Date, timezone: string): Date {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
    if (hour >= 22) return new Date(now.getTime() + (31 - hour) * 3_600_000);
    if (hour < 7) return new Date(now.getTime() + (7 - hour) * 3_600_000);
  } catch {
    // Invalid timezones fall back to immediate delivery.
  }
  return now;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
