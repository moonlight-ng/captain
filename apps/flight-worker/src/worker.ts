import {
  createCaptainAccessLink,
  deriveOfferMetrics,
  FlightSearchProviderError,
  type FlightSearchProvider
} from "@agents/flight-domain";
import {
  WATCH_DATA_PRUNE_INTERVAL_MS,
  type CaptainNotification,
  type CaptainPlatformStore,
  type ClaimedSearchRun,
  type CompletedProviderOffer,
  type RecommendationSnapshot
} from "@agents/flight-store";
import { logEvent } from "@agents/observability";

export class FlightWorker {
  readonly #store: CaptainPlatformStore;
  readonly #provider: FlightSearchProvider;
  readonly #telegramBotToken: string;
  readonly #captainPublicUrl: string;
  readonly #trackingEnabled: boolean;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #freshnessMs: number;
  readonly #claimLimit: number;
  #running = false;
  #lastPrunedAt = 0;
  #lastTickHadDueWork = false;

  constructor(options: {
    store: CaptainPlatformStore;
    provider: FlightSearchProvider;
    telegramBotToken: string;
    captainPublicUrl: string;
    trackingEnabled: boolean;
    workerId: string;
    leaseMs: number;
    freshnessMs: number;
    claimLimit: number;
  }) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#telegramBotToken = options.telegramBotToken;
    this.#captainPublicUrl = options.captainPublicUrl;
    this.#trackingEnabled = options.trackingEnabled;
    this.#workerId = options.workerId;
    this.#leaseMs = options.leaseMs;
    this.#freshnessMs = options.freshnessMs;
    this.#claimLimit = options.claimLimit;
  }

  get lastTickHadDueWork(): boolean {
    return this.#lastTickHadDueWork;
  }

  async tick(now = new Date()): Promise<{
    scheduled: number;
    processed: number;
    notified: number;
  }> {
    if (this.#running) return { scheduled: 0, processed: 0, notified: 0 };
    this.#running = true;
    this.#lastTickHadDueWork = false;
    try {
      if (now.getTime() - this.#lastPrunedAt >= WATCH_DATA_PRUNE_INTERVAL_MS) {
        await this.#store.pruneWatchData(now);
        this.#lastPrunedAt = now.getTime();
      }

      if (!await this.#store.hasDueWorkerWork(now)) {
        return { scheduled: 0, processed: 0, notified: 0 };
      }
      this.#lastTickHadDueWork = true;
      const maintenance = await this.#store.maintainTracking(now);
      const scheduled = this.#trackingEnabled
        ? await this.#store.scheduleDueSearchRuns(now, this.#freshnessMs, 100)
        : 0;
      let processed = 0;
      if (this.#trackingEnabled) {
        while (processed < this.#claimLimit) {
          const runNow = new Date(Math.max(now.getTime(), Date.now()));
          const [run] = await this.#store.claimSearchRuns(this.#workerId, runNow, this.#leaseMs, 1);
          if (!run) break;
          await this.#processRun(run, runNow);
          processed += 1;
        }
      }
      const digestsQueued = await this.#store.enqueueDueDigests(
        new Date(Math.max(now.getTime(), Date.now()))
      );
      const deliveryNow = new Date(Math.max(now.getTime(), Date.now()));
      const notifications = await this.#store.listPendingNotifications(deliveryNow, 20);
      let notified = 0;
      for (const notification of notifications) {
        if (await this.#deliver(notification, deliveryNow)) notified += 1;
      }
      logEvent("info", "flight_worker.tick_completed", {
        scheduled,
        processed,
        notified,
        tracking_enabled: this.#trackingEnabled,
        worker_id: this.#workerId,
        provider: this.#provider.provider,
        tracking_activated: maintenance.activated,
        tracking_checkins_queued: maintenance.checkInsQueued,
        tracking_auto_paused: maintenance.autoPaused,
        tracking_runs_completed: maintenance.completed,
        digests_queued: digestsQueued
      });
      return { scheduled, processed, notified };
    } finally {
      this.#running = false;
    }
  }

  async #processRun(run: ClaimedSearchRun, now: Date): Promise<void> {
    const startedAt = Date.now();
    let searchCompleted = false;
    try {
      const result = await this.#provider.search(run.request);
      const completedAt = new Date();
      const offers: CompletedProviderOffer[] = result.offers.map((offer) => {
        const metrics = deriveOfferMetrics(offer.slices);
        const providerOfferId = offer.providerOfferId
          ?? duffelOfferId(offer.evidence[0]?.url)
          ?? offer.itineraryKey;
        return {
          itineraryKey: offer.itineraryKey,
          provider: result.provider,
          providerOfferId,
          providerSearchId: result.requestId,
          price: Number(offer.priceAmount),
          priceAmount: offer.priceAmount,
          currency: offer.currency,
          fareBasis: offer.fareBasis,
          primaryAirlineCode: offer.primaryAirlineCode,
          participatingAirlineCodes: offer.participatingAirlineCodes,
          evidence: offer.evidence,
          discoveryResponseId: result.discoveryResponseId,
          verificationResponseId: result.verificationResponseId,
          promptVersion: result.promptVersion,
          model: result.model,
          verifiedAt: completedAt.toISOString(),
          expiresAt: offer.expiresAt ?? null,
          observedAt: completedAt.toISOString(),
          snapshot: {
            route: metrics.route,
            airlineCodes: metrics.airlineCodes,
            flightNumbers: metrics.flightNumbers,
            stops: metrics.stops,
            durationSeconds: metrics.durationSeconds,
            conditions: {
              fareBasis: result.provider === "official_duffel"
                ? "One-adult Duffel total converted into trip currency when needed"
                : "One-adult Flysoar total converted into trip currency when needed"
            },
            segments: metrics.segments,
            slices: offer.slices
          }
        };
      });
      await this.#store.completeSearchRun(this.#workerId, run.id, result.requestId, offers, completedAt);
      searchCompleted = true;
      const changed = await this.#store.evaluateTripsForSearchSpec(run.searchSpecId, completedAt);
      await this.#store.finalizeFarFutureBaseline(run.searchSpecId, completedAt);
      logEvent("info", "flight_worker.search_completed", {
        run_id: run.id,
        search_spec_id: run.searchSpecId,
        provider: result.provider,
        verified_offers: offers.length,
        rejection_counts: result.rejectionCounts,
        recommendations_changed: changed,
        duration_ms: Date.now() - startedAt
      });
    } catch (error) {
      if (searchCompleted) {
        logEvent("error", "flight_worker.recommendation_evaluation_failed", {
          run_id: run.id,
          search_spec_id: run.searchSpecId,
          provider: this.#provider.provider,
          error_code: error instanceof Error ? error.name : "UnknownError",
          duration_ms: Date.now() - startedAt
        });
        return;
      }
      const retryAfterMs = error instanceof FlightSearchProviderError
        ? error.retryAfterMs
        : null;
      await this.#store.failSearchRun(
        this.#workerId,
        run.id,
        error instanceof Error ? error.message : "Unknown search failure",
        retryAfterMs,
        now
      );
      logEvent("error", "flight_worker.search_failed", {
        run_id: run.id,
        search_spec_id: run.searchSpecId,
        provider: error instanceof FlightSearchProviderError
          ? error.provider
          : this.#provider.provider,
        error_code: error instanceof FlightSearchProviderError
          ? error.code
          : error instanceof Error ? error.name : "UnknownError",
        duration_ms: Date.now() - startedAt
      });
    }
  }

  async #deliver(notification: CaptainNotification, now: Date): Promise<boolean> {
    try {
      const replyMarkup = this.#notificationReplyMarkup(notification);
      const response = await fetch(`https://api.telegram.org/bot${this.#telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: notification.telegramChatId,
          text: notificationText(notification),
          disable_web_page_preview: true,
          reply_markup: replyMarkup
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
      const body = await response.json() as { ok?: boolean; result?: { message_id?: number } };
      const messageId = body.result?.message_id;
      if (!Number.isSafeInteger(messageId)) throw new Error("Telegram did not return a message ID");
      await this.#store.markNotificationSent(notification.id, messageId!, now);
      return true;
    } catch (error) {
      await this.#store.markNotificationFailed(
        notification.id,
        error instanceof Error ? error.message : "Telegram delivery failed",
        now
      );
      return false;
    }
  }

  #notificationReplyMarkup(notification: CaptainNotification): {
    inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
  } {
    if (notification.kind === "tracking_checkin") {
      return {
        inline_keyboard: [[
          {
            text: "Keep tracking",
            callback_data: `captain-watch:keep:${notification.tripId}`
          },
          {
            text: "Pause tracking",
            callback_data: `captain-watch:pause:${notification.tripId}`
          }
        ]]
      };
    }
    if (notification.kind === "daily_digest") {
      const trips = arrayField(notification.payload, "trips");
      const buttons = trips.slice(0, 3).flatMap((value) => {
        if (!recordValue(value)) return [];
        const tripId = stringField(value, "tripId");
        if (!tripId) return [];
        return [[{
          text: `Open ${shortRoute(stringField(value, "tripTitle") || "trip")}`,
          url: this.#createTripAccessLink(notification.userId, tripId)
        }]];
      });
      if (buttons.length > 0) return { inline_keyboard: buttons };
    }
    return {
      inline_keyboard: [[{
        text: "Open trip",
        url: this.#createTripAccessLink(notification.userId, notification.tripId)
      }]]
    };
  }

  #createTripAccessLink(userId: string, tripId: string): string {
    const accessLink = createCaptainAccessLink(
      this.#captainPublicUrl,
      "/trip",
      userId,
      this.#telegramBotToken
    );
    const url = new URL(accessLink);
    url.pathname = `/trip/${encodeURIComponent(tripId)}`;
    return url.toString();
  }
}

export function notificationText(notification: CaptainNotification): string {
  const title = stringField(notification.payload, "tripTitle") || "your trip";
  const route = shortRoute(title);
  if (notification.kind === "daily_digest") {
    const trips = arrayField(notification.payload, "trips");
    const lines = trips.slice(0, 3).flatMap((value) => {
      if (!recordValue(value)) return [];
      const tripTitle = shortRoute(stringField(value, "tripTitle") || "trip");
      const snapshot = digestSnapshot(value);
      if (!snapshot) {
        const summary = stringField(value, "summary");
        return summary ? [`${tripTitle}: ${summary}`] : [];
      }
      const current = snapshot.current;
      const rise = recordField(value, "priceRise");
      const riseAmount = numericField(rise, "increase");
      const risePercent = numericField(rise, "percent");
      if (riseAmount >= 20 && risePercent >= 5) {
        return [
          `${tripTitle}: ${formatAmount(current.price, current.currency)}, up `
          + `${formatAmount(riseAmount, current.currency)} (${Math.round(risePercent)}%) this week.`
        ];
      }
      if (
        snapshot.previous
        && snapshot.reasonCodes.some((code) =>
          ["lower_price", "shorter_duration", "better_balance"].includes(code)
        )
      ) {
        return [
          `${tripTitle}: ${airlineName(snapshot.current)} is now ${improvementText(snapshot)}.`
        ];
      }
      return [`${tripTitle}: ${formatAmount(current.price, current.currency)}, no meaningful change.`];
    });
    return ["Here’s today’s flight update.", ...lines].join("\n");
  }
  if (notification.kind === "tracking_activation") {
    return `I’m starting regular tracking for ${route} now.\nI’ll keep an eye on prices and better options.`;
  }
  if (notification.kind === "tracking_checkin") {
    const departureDate = stringField(notification.payload, "departureDate");
    const dateText = departureDate ? ` on ${formatDate(departureDate)}` : "";
    return `Are you still planning ${route}${dateText}?\nI can keep watching, or pause it for now.`;
  }
  if (notification.kind === "tracking_paused") {
    return `I paused tracking for ${route} because I didn’t hear back.\nYour trip is saved whenever you want to resume.`;
  }
  if (notification.kind === "tracking_summary") {
    const checksCompleted = numericField(notification.payload, "checksCompleted");
    const summary = stringField(notification.payload, "summary")
      || "The latest verified options are ready to review.";
    const checks = checksCompleted > 0
      ? ` I checked ${checksCompleted} time${checksCompleted === 1 ? "" : "s"}.`
      : "";
    return `Your three-day price watch for ${route} is complete.${checks}\n${summary}\nThese prices are now stale. Open the trip and choose Track.`;
  }
  if (notification.kind === "price_rise") {
    const current = offerSnapshot(notification.payload.current);
    const increase = numericField(notification.payload, "increase");
    const percent = numericField(notification.payload, "percent");
    const airline = current ? airlineName(current) : "flight";
    const currency = current?.currency || stringField(notification.payload, "currency") || "USD";
    return `Heads up — the ${airline} option you’re watching is up `
      + `${formatAmount(increase, currency)} (${Math.round(percent)}%) this week.\n`
      + "It may be worth checking now.";
  }
  const snapshot = recommendationSnapshot(notification.payload.snapshot);
  const current = snapshot?.current ?? offerSnapshot(notification.payload.current);
  const details = current ? offerLine(current) : stringField(notification.payload, "summary");
  const departureDate = current ? offerDepartureDate(current) : "";
  const dateText = departureDate ? ` for ${formatDate(departureDate)}` : "";
  if (notification.kind === "initial_results" || !snapshot?.previous) {
    const trackingStartsAt = stringField(notification.payload, "trackingStartsAt");
    if (trackingStartsAt) {
      return `I checked ${route}${dateText}. Best match right now is ${details}.\n`
        + `I’ll start regular tracking on ${formatDate(trackingStartsAt)}, 30 days before departure.`;
    }
    return `I checked ${route}${dateText}.\nBest match right now is ${details}.`;
  }
  const improvement = improvementText(snapshot);
  return `Good news — I found a better option for ${route}: ${improvement}.\n${details}.`;
}

function duffelOfferId(url: string | undefined): string | null {
  if (!url) return null;
  const match = /\/air\/offers\/([^/?#]+)/u.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function improvementText(snapshot: RecommendationSnapshot): string {
  const currentDuration = numericSnapshot(snapshot.current.snapshot, "durationSeconds");
  const previousDuration = numericSnapshot(snapshot.previous?.snapshot, "durationSeconds");
  if (snapshot.rankingMode === "cheapest" && snapshot.previous) {
    const saved = Math.max(0, snapshot.previous.price - snapshot.current.price);
    return `${formatAmount(saved, snapshot.current.currency)} less`;
  }
  if (snapshot.rankingMode === "fastest" && previousDuration > currentDuration) {
    return `${formatDuration(previousDuration - currentDuration)} shorter`;
  }
  const priceSaved = snapshot.previous
    ? Math.max(0, snapshot.previous.price - snapshot.current.price)
    : 0;
  const timeSaved = Math.max(0, previousDuration - currentDuration);
  const details = [
    priceSaved > 0 ? `${formatAmount(priceSaved, snapshot.current.currency)} less` : "",
    timeSaved > 0 ? `${formatDuration(timeSaved)} shorter` : ""
  ].filter(Boolean);
  return details.join(" and ") || "a meaningfully better balance of fare, time, and stops";
}

function recommendationSnapshot(value: unknown): RecommendationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RecommendationSnapshot>;
  return candidate.current && candidate.rankingMode ? candidate as RecommendationSnapshot : null;
}

function offerSnapshot(value: unknown): RecommendationSnapshot["current"] | null {
  if (!recordValue(value)) return null;
  return typeof value.itineraryKey === "string"
    && typeof value.currency === "string"
    && Number.isFinite(Number(value.price))
    ? value as RecommendationSnapshot["current"]
    : null;
}

function digestSnapshot(value: Record<string, unknown>): RecommendationSnapshot | null {
  const direct = recommendationSnapshot(value.snapshot);
  const recommendation = recordField(value, "recommendation");
  const snapshot = direct
    ?? recommendationSnapshot(recommendation?.snapshot)
    ?? recommendationSnapshot(recommendation)
    ?? recommendationSnapshot(value.recommendation);
  return recommendationSnapshot(snapshot?.pendingDigestChange) ?? snapshot;
}

function offerLine(offer: RecommendationSnapshot["current"]): string {
  const stops = numericSnapshot(offer.snapshot, "stops");
  const duration = numericSnapshot(offer.snapshot, "durationSeconds");
  const stopText = stops === 0 ? "nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`;
  return `${airlineName(offer)} at ${formatAmount(offer.price, offer.currency)}`
    + `${duration > 0 ? ` · ${formatDuration(duration)}` : ""} · ${stopText}`;
}

function airlineName(offer: RecommendationSnapshot["current"]): string {
  const segments = Array.isArray(offer.snapshot.segments) ? offer.snapshot.segments : [];
  const first = recordValue(segments[0]) ? segments[0] : null;
  return first && typeof first.airline === "string"
    ? first.airline
    : offer.primaryAirlineCode;
}

function offerDepartureDate(offer: RecommendationSnapshot["current"]): string {
  const segments = Array.isArray(offer.snapshot.segments) ? offer.snapshot.segments : [];
  const first = recordValue(segments[0]) ? segments[0] : null;
  return first && typeof first.departure === "string" ? first.departure : "";
}

function shortRoute(value: string): string {
  return value
    .replace(/\s+Trip$/iu, "")
    .replace(/\s+to\s+/giu, " → ");
}

function formatDate(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(parsed);
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordField(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  return recordValue(value) ? value : null;
}

function arrayField(payload: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(payload[key]) ? payload[key] : [];
}

function stringField(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? payload[key] : "";
}

function numericField(payload: Record<string, unknown> | null, key: string): number {
  const value = Number(payload?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function numericSnapshot(snapshot: Record<string, unknown> | undefined, key: string): number {
  const value = Number(snapshot?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function formatAmount(value: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.round((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
