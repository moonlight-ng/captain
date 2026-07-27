import { createCaptainAccessLink, deriveOfferMetrics } from "@agents/flight-domain";
import type {
  CaptainNotification,
  CaptainPlatformStore,
  ClaimedSearchRun,
  CompletedProviderOffer,
  RecommendationSnapshot
} from "@agents/flight-store";
import { logEvent } from "@agents/observability";
import type { FlightSearchProvider } from "@agents/provider-web";
import { WebSearchProviderError } from "@agents/provider-web";

const RESPONSES_PER_RUN = 2;

export class FlightWorker {
  readonly #store: CaptainPlatformStore;
  readonly #provider: FlightSearchProvider;
  readonly #telegramBotToken: string;
  readonly #captainPublicUrl: string;
  readonly #trackingEnabled: boolean;
  readonly #dailyResponseLimit: number;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #freshnessMs: number;
  readonly #claimLimit: number;
  #running = false;

  constructor(options: {
    store: CaptainPlatformStore;
    provider: FlightSearchProvider;
    telegramBotToken: string;
    captainPublicUrl: string;
    trackingEnabled: boolean;
    dailyResponseLimit: number;
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
    this.#dailyResponseLimit = options.dailyResponseLimit;
    this.#workerId = options.workerId;
    this.#leaseMs = options.leaseMs;
    this.#freshnessMs = options.freshnessMs;
    this.#claimLimit = options.claimLimit;
  }

  async tick(now = new Date()): Promise<{ scheduled: number; processed: number; notified: number }> {
    if (this.#running) return { scheduled: 0, processed: 0, notified: 0 };
    this.#running = true;
    try {
      await this.#store.pruneWatchData(now);
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
        worker_id: this.#workerId
      });
      return { scheduled, processed, notified };
    } finally {
      this.#running = false;
    }
  }

  async #processRun(run: ClaimedSearchRun, now: Date): Promise<void> {
    const startedAt = Date.now();
    try {
      const reserved = await this.#store.reserveDailyResponseBudget(
        now,
        RESPONSES_PER_RUN,
        this.#dailyResponseLimit
      );
      if (!reserved) {
        const until = nextUtcDay(now);
        await this.#store.deferSearchRun(
          this.#workerId,
          run.id,
          until,
          "Daily OpenAI Responses safety ceiling reached; tracking is delayed.",
          now
        );
        logEvent("warn", "flight_worker.search_deferred", {
          run_id: run.id,
          reason: "daily_response_limit",
          scheduled_at: until.toISOString()
        });
        return;
      }

      const result = await this.#provider.search(run.request);
      await this.#store.recordWebSearchCalls(now, result.webSearchCalls);
      const offers: CompletedProviderOffer[] = result.offers.map((offer) => {
        const metrics = deriveOfferMetrics(offer.slices);
        return {
          itineraryKey: offer.itineraryKey,
          provider: this.#provider.provider,
          providerOfferId: offer.itineraryKey,
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
          verifiedAt: now.toISOString(),
          expiresAt: null,
          observedAt: now.toISOString(),
          snapshot: {
            route: metrics.route,
            airlineCodes: metrics.airlineCodes,
            flightNumbers: metrics.flightNumbers,
            stops: metrics.stops,
            durationSeconds: metrics.durationSeconds,
            conditions: { fareBasis: "One-adult total shown by the cited source" },
            segments: metrics.segments,
            slices: offer.slices
          }
        };
      });
      await this.#store.completeSearchRun(this.#workerId, run.id, result.requestId, offers, now);
      const changed = await this.#store.evaluateTripsForSearchSpec(run.searchSpecId, now);
      logEvent("info", "flight_worker.search_completed", {
        run_id: run.id,
        search_spec_id: run.searchSpecId,
        verified_offers: offers.length,
        rejection_counts: result.rejectionCounts,
        recommendations_changed: changed,
        duration_ms: Date.now() - startedAt
      });
    } catch (error) {
      const retryAfterMs = error instanceof WebSearchProviderError ? error.retryAfterMs : null;
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
        error_code: error instanceof WebSearchProviderError
          ? error.code
          : error instanceof Error ? error.name : "UnknownError",
        duration_ms: Date.now() - startedAt
      });
    }
  }

  async #deliver(notification: CaptainNotification, now: Date): Promise<boolean> {
    try {
      const tripUrl = this.#createTripAccessLink(notification.userId);
      const response = await fetch(`https://api.telegram.org/bot${this.#telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: notification.telegramChatId,
          text: notificationText(notification),
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: "Open trip", url: tripUrl }]] }
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

  #createTripAccessLink(userId: string): string {
    return createCaptainAccessLink(
      this.#captainPublicUrl,
      "/trip",
      userId,
      this.#telegramBotToken
    );
  }
}

export function notificationText(notification: CaptainNotification): string {
  const title = stringField(notification.payload, "tripTitle") || "your Trip";
  if (notification.kind === "watch_attention") {
    return `Captain needs attention on ${title}. Checks have failed repeatedly; tracking will retry automatically and keep your last verified results.`;
  }
  const snapshot = recommendationSnapshot(notification.payload.snapshot);
  const summary = stringField(notification.payload, "summary") || "A verified flight option is ready.";
  if (notification.kind === "initial_results" || !snapshot?.previous) {
    return `I found the first verified option for ${title}.\n\n${summary}\n\nReply to this alert if you want me to explain it.`;
  }
  const improvement = improvementText(snapshot);
  return `I found a better flight for ${title}: ${improvement}.\n\n${summary}\n\nReply to this alert if you want me to explain the exact comparison.`;
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

function stringField(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? payload[key] : "";
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

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
}
