import type { CaptainNotification, CaptainPlatformStore, ClaimedSearchRun } from "@agents/flight-store";
import { logEvent } from "@agents/observability";
import { DuffelClient, DuffelError } from "@agents/provider-duffel";

export class FlightWorker {
  readonly #store: CaptainPlatformStore;
  readonly #duffel: DuffelClient;
  readonly #telegramBotToken: string;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #freshnessMs: number;
  readonly #claimLimit: number;
  #running = false;

  constructor(options: {
    store: CaptainPlatformStore;
    duffel: DuffelClient;
    telegramBotToken: string;
    workerId: string;
    leaseMs: number;
    freshnessMs: number;
    claimLimit: number;
  }) {
    this.#store = options.store;
    this.#duffel = options.duffel;
    this.#telegramBotToken = options.telegramBotToken;
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
      const scheduled = await this.#store.scheduleDueSearchRuns(now, this.#freshnessMs, 100);
      let processed = 0;
      // One provider request at a time keeps the Duffel bucket deterministic.
      while (processed < this.#claimLimit) {
        const runNow = new Date(Math.max(now.getTime(), Date.now()));
        const [run] = await this.#store.claimSearchRuns(this.#workerId, runNow, this.#leaseMs, 1);
        if (!run) break;
        await this.#processRun(run, runNow);
        processed += 1;
      }
      const deliveryNow = new Date(Math.max(now.getTime(), Date.now()));
      const notifications = await this.#store.listPendingNotifications(deliveryNow, 20);
      let notified = 0;
      for (const notification of notifications) {
        if (await this.#deliver(notification, deliveryNow)) notified += 1;
      }
      logEvent("info", "flight_worker.tick_completed", { scheduled, processed, notified, worker_id: this.#workerId });
      return { scheduled, processed, notified };
    } finally {
      this.#running = false;
    }
  }

  async #processRun(run: ClaimedSearchRun, now: Date): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.#duffel.search(run.request);
      await this.#store.completeSearchRun(this.#workerId, run.id, result.searchId, result.offers.map((offer) => ({
        itineraryKey: offer.itineraryKey,
        provider: "duffel" as const,
        providerOfferId: offer.id,
        providerSearchId: result.searchId,
        price: offer.price,
        currency: offer.currency,
        expiresAt: offer.expiresAt,
        observedAt: result.searchedAt,
        snapshot: {
          route: offer.segments.length > 0
            ? [offer.segments[0]!.origin, ...offer.segments.map((segment) => segment.destination)].join(" → ")
            : "",
          airlineCodes: [...new Set(offer.segments.map((segment) => segment.airlineCode).filter(Boolean))],
          flightNumbers: offer.segments.map((segment) => segment.flightNumber),
          stops: Math.max(0, offer.segments.length - run.request.slices.length),
          durationSeconds: totalDuration(offer.segments),
          conditions: offer.conditions,
          segments: offer.segments
        }
      })), now);
      const changed = await this.#store.evaluateTripsForSearchSpec(run.searchSpecId, now);
      logEvent("info", "flight_worker.search_completed", {
        run_id: run.id, search_spec_id: run.searchSpecId, offers: result.offers.length,
        recommendations_changed: changed, duration_ms: Date.now() - startedAt
      });
    } catch (error) {
      const retryAfterMs = error instanceof DuffelError ? error.retryAfterMs ?? null : null;
      await this.#store.failSearchRun(
        this.#workerId,
        run.id,
        error instanceof Error ? error.message : "Unknown search failure",
        retryAfterMs,
        now
      );
      logEvent("error", "flight_worker.search_failed", {
        run_id: run.id, search_spec_id: run.searchSpecId,
        error_code: error instanceof DuffelError ? error.code : error instanceof Error ? error.name : "UnknownError",
        duration_ms: Date.now() - startedAt
      });
    }
  }

  async #deliver(notification: CaptainNotification, now: Date): Promise<boolean> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.#telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: notification.telegramChatId,
          text: notificationText(notification),
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
      await this.#store.markNotificationSent(notification.id, now);
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
}

function notificationText(notification: CaptainNotification): string {
  const title = stringField(notification.payload, "tripTitle") || "your Trip";
  if (notification.kind === "watch_attention") {
    return `Captain needs attention on ${title}. Flight checks have failed repeatedly; tracking will retry automatically.`;
  }
  const summary = stringField(notification.payload, "summary") || "A strong flight option is ready.";
  const lead = notification.kind === "initial_results"
    ? `I found the first strong option for ${title}.`
    : notification.kind === "price_drop"
      ? `The best price for ${title} dropped${numberField(notification.payload, "dropPercent") > 0 ? ` by ${numberField(notification.payload, "dropPercent")}%` : " by at least 5%"}.`
      : `I found a better flight for ${title}.`;
  return `${lead}\n\n${summary}\n\nReply here if you want me to explain or adjust this Trip.`;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? payload[key] : "";
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = Number(payload[key]);
  return Number.isFinite(value) ? value : 0;
}

function totalDuration(segments: Array<{ departure: string; arrival: string }>): number {
  if (segments.length === 0) return 0;
  const start = Date.parse(segments[0]!.departure);
  const end = Date.parse(segments.at(-1)!.arrival);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1_000) : 0;
}
