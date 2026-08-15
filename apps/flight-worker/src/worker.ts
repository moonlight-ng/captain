import {
  createCaptainAccessLink,
  deriveOfferMetrics,
  FlightSearchProviderError,
  reviewCaptainMessage,
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
import type { TelegramLanguageService } from "@agents/telegram-core";

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
  readonly #language: Pick<TelegramLanguageService, "localize"> | null;
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
    language?: Pick<TelegramLanguageService, "localize"> | null;
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
    this.#language = options.language ?? null;
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
      // Progress acks (plan confirmed, pause/resume, …) must leave the chat
      // before provider search work starts. Otherwise the traveller waits the
      // full first-search latency for the message that says work has begun.
      let notified = await this.#deliverPending(now);
      const scheduled = this.#trackingEnabled
        ? await this.#store.scheduleDueSearchRuns(now, this.#freshnessMs, 100)
        : 0;
      let processed = 0;
      if (this.#trackingEnabled) {
        while (processed < this.#claimLimit) {
          const runNow = new Date(Math.max(now.getTime(), Date.now()));
          const runs = await this.#store.claimSearchRuns(
            this.#workerId,
            runNow,
            this.#leaseMs,
            this.#claimLimit - processed
          );
          if (runs.length === 0) break;
          await Promise.all(runs.map((run) => this.#processRun(run, runNow)));
          processed += runs.length;
        }
      }
      // Search completion may enqueue results digests; deliver those after work.
      notified += await this.#deliverPending(now);
      logEvent("info", "flight_worker.tick_completed", {
        scheduled,
        processed,
        notified,
        tracking_enabled: this.#trackingEnabled,
        worker_id: this.#workerId,
        provider: this.#provider.provider,
        tracking_activated: maintenance.activated,
        tracking_runs_completed: maintenance.completed
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
            departureDates: offer.slices.map((slice) => slice.departureDate),
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
      const multiCity = await this.#store.recordMultiCityLegSearchResult(
        run.searchSpecId,
        offers,
        null,
        completedAt
      );
      const changed = multiCity.matched > 0
        ? multiCity.notified
        : await this.#store.evaluateTripsForSearchSpec(run.searchSpecId, completedAt);
      if (offers.length === 0) {
        await this.#store.enqueueInventoryGapForSearchSpec(run.searchSpecId, completedAt);
      }
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
          error_message: error instanceof Error ? error.message : "Unknown error",
          duration_ms: Date.now() - startedAt
        });
        return;
      }
      const retryAfterMs = error instanceof FlightSearchProviderError
        ? error.retryAfterMs
        : null;
      const terminal = await this.#store.failSearchRun(
        this.#workerId,
        run.id,
        error instanceof Error ? error.message : "Unknown search failure",
        retryAfterMs,
        retryableSearchError(error),
        now
      );
      if (terminal) {
        const code = error instanceof FlightSearchProviderError ? error.code : "unknown";
        await this.#store.recordMultiCityLegSearchResult(run.searchSpecId, null, code, now);
        await this.#store.enqueueInventoryGapForSearchSpec(run.searchSpecId, now);
      }
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

  async #deliverPending(now: Date): Promise<number> {
    const deliveryNow = new Date(Math.max(now.getTime(), Date.now()));
    const notifications = await this.#store.listPendingNotifications(deliveryNow, 20);
    let notified = 0;
    for (const notification of notifications) {
      if (await this.#deliver(notification, deliveryNow)) notified += 1;
    }
    return notified;
  }

  async #deliver(notification: CaptainNotification, now: Date): Promise<boolean> {
    try {
      const shouldLocalize = notification.preferredLanguageSource !== "default"
        && notification.preferredLanguage
        && !notification.preferredLanguage.toLowerCase().startsWith("en");
      const language = notification.preferredLanguage ?? "en";
      const [text, openTripLabel] = shouldLocalize && this.#language
        ? await Promise.all([
            this.#language.localize(notificationText(notification), language),
            this.#language.localize("Open trip", language)
          ])
        : [notificationText(notification), "Open trip"];
      const replyMarkup = this.#notificationReplyMarkup(notification, openTripLabel);
      const response = await fetch(`https://api.telegram.org/bot${this.#telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: notification.telegramChatId,
          text,
          disable_web_page_preview: true,
          reply_markup: replyMarkup
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
      const body = await response.json() as { ok?: boolean; result?: { message_id?: number } };
      const messageId = body.result?.message_id;
      if (!Number.isSafeInteger(messageId)) throw new Error("Telegram did not return a message ID");
      await this.#store.markNotificationSent(notification.id, messageId!, text, now);
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

  /**
   * One trip is tracked at a time, so the button never needs to name a route
   * to disambiguate. "Open trip" reads the same in every message, which is the
   * point: the traveller learns one button rather than reading each one.
   */
  #notificationReplyMarkup(notification: CaptainNotification, openTripLabel = "Open trip"): {
    inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
  } | undefined {
    if (notification.kind === "tracking_started") return undefined;
    return {
      inline_keyboard: [[{
        text: openTripLabel,
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

function retryableSearchError(error: unknown): boolean {
  if (!(error instanceof FlightSearchProviderError)) return true;
  return ["rate_limited", "timeout", "unavailable", "invalid_response"].includes(error.code);
}

/** Captain only writes when something happened, so every message has news. */
export function notificationText(notification: CaptainNotification): string {
  return reviewCaptainMessage(notificationDraftText(notification));
}

function notificationDraftText(notification: CaptainNotification): string {
  const title = stringField(notification.payload, "tripTitle") || "your trip";
  const route = stringField(notification.payload, "tripRoute") || shortRoute(title);
  if (notification.kind === "tracking_started") {
    return "Plan confirmed. Now checking flights…";
  }
  if (notification.kind === "plan_changed") {
    return `I’ve updated the plan for ${route}.\nOpen the trip to review the changes.`;
  }
  if (notification.kind === "tracking_paused") {
    return `Paused tracking for ${route}.`;
  }
  if (notification.kind === "tracking_resumed") {
    return `Resumed tracking for ${route}. I’ll message you when something changes.`;
  }
  if (notification.kind === "trip_closed") {
    const reason = stringField(notification.payload, "reason")
      || stringField(notification.payload, "eventType");
    if (reason === "replaced" || reason === "trip_replaced") {
      return `Archived ${route} so we can start the new trip.`;
    }
    if (reason === "complete" || reason === "trip_complete") {
      return `Marked ${route} complete.`;
    }
    return `Stopped tracking ${route}.`;
  }
  if (notification.kind === "inventory_gap") {
    const multiCity = notification.payload.multiCity === true;
    return multiCity
      ? `I couldn’t complete the first flight check for ${route} yet.\n`
        + "Open the trip to review the legs or adjust the dates."
      : `I couldn’t complete the first flight check for ${route} yet.\n`
        + "Open the trip to try again or adjust the dates.";
  }
  if (notification.kind === "initial_results") {
    const progress = recordField(notification.payload, "multiCityProgress");
    if (progress) {
      const legRoute = stringField(progress, "legRoute") || "the first leg";
      const remaining = numericField(progress, "remainingLegs");
      const checking = remaining > 0
        ? ` I’m still checking ${remaining} other ${remaining === 1 ? "leg" : "legs"}.`
        : "";
      return `I found flights for ${legRoute}.${checking}\n`
        + (remaining > 0
          ? "Open your trip to compare them as the remaining results arrive."
          : "Open your trip to compare the best options for each leg.");
    }
    return firstUpdateText(notification, route);
  }
  if (notification.kind === "tracking_activation") {
    return `Daily price checks are now running for ${route}.\n`
      + "I’ll only message you when something changes.";
  }
  if (notification.kind === "tracking_summary") {
    const checksCompleted = numericField(notification.payload, "checksCompleted");
    const summary = stringField(notification.payload, "summary")
      || "The latest verified options are ready to review.";
    const checks = checksCompleted > 0
      ? ` I checked ${checksCompleted} time${checksCompleted === 1 ? "" : "s"}.`
      : "";
    return `Your price watch for ${route} is complete.${checks}\n${summary}\n`
      + "These prices are now stale. Open the trip and choose Track.";
  }
  if (notification.kind === "price_rise") {
    const current = offerSnapshot(notification.payload.current);
    const increase = numericField(notification.payload, "increase");
    const percent = numericField(notification.payload, "percent");
    const airline = current ? airlineName(current) : "flight";
    const currency = current?.currency || stringField(notification.payload, "currency") || "USD";
    return `The ${airline} fare you’re watching is up `
      + `${formatAmount(increase, currency)} (${Math.round(percent)}%) this week.\n`
      + "Open the trip to decide whether to book now.";
  }
  const snapshot = recommendationSnapshot(notification.payload.snapshot);
  const current = snapshot?.current ?? offerSnapshot(notification.payload.current);
  const details = current ? offerLine(current) : stringField(notification.payload, "summary");
  if (!snapshot?.previous) {
    return firstUpdateText(notification, route);
  }
  return `I found a better option for ${route}: ${improvementText(snapshot)}.\n${details}.`;
}

/**
 * The first thing Captain ever says about a trip. It is an overview, not a
 * quote: the traveller has just described a journey and wants to know what
 * Captain found and what to do next.
 */
function firstUpdateText(
  notification: CaptainNotification,
  route: string
): string {
  const range = recordField(notification.payload, "range");
  const count = numericField(range, "count");
  const low = numericField(range, "low");
  const currency = stringField(range ?? {}, "currency") || "USD";
  const trackingStartsAt = stringField(notification.payload, "trackingStartsAt");
  const snapshot = recommendationSnapshot(notification.payload.snapshot);
  const departure = stringField(notification.payload, "tripDepartureDate")
    || (snapshot?.current ? offerDepartureDate(snapshot.current) : "");
  const trip = `${route}${departure ? ` on ${formatDate(departure)}` : ""}`;
  if (count <= 0) {
    return `I didn’t find any fares for ${trip} yet.\n`
      + "I’ll keep checking. Open the trip if you want to change the route or dates.";
  }
  const finding = comparativeDateFinding(notification.payload, route)
    ?? (count === 1
      ? `I found 1 fare for ${trip} at ${formatAmount(low, currency)}.`
      : `I found ${count} fares for ${trip}, starting at ${formatAmount(low, currency)}.`);
  const dateSummary = recordField(notification.payload, "dateSummary");
  const isMultiCity = arrayField(dateSummary ?? {}, "searchWindows").length > 1;
  if (isMultiCity) {
    return `${finding}\n\nOpen your trip to compare the best flights for each leg.`;
  }
  const followUp = trackingStartsAt
    ? `Daily price checks start ${formatDate(trackingStartsAt)}.`
    : "I’ll check prices daily and only message you when something changes.";
  return `${finding}\nOpen the trip to compare the best options and choose one to watch. ${followUp}`;
}

function comparativeDateFinding(
  payload: Record<string, unknown>,
  route: string
): string | null {
  const summary = recordField(payload, "dateSummary");
  if (!summary) return null;
  const combinations = arrayField(summary, "combinations")
    .filter(recordValue);
  const searchWindows = arrayField(summary, "searchWindows")
    .filter(recordValue);
  const cheapestDates = arrayField(summary, "cheapestDepartureDates")
    .filter((value): value is string => typeof value === "string");
  const currency = stringField(summary, "currency") || "USD";
  const tripType = stringField(summary, "tripType");
  const cheapest = numericField(summary, "cheapest");
  const high = numericField(summary, "highestCombinationLow");
  const searched = numericField(summary, "searchedCombinationCount");
  if (combinations.length === 0 || cheapestDates.length === 0 || cheapest <= 0) return null;
  if (tripType === "round_trip" && cheapestDates.length >= 2) {
    return `${route} is about ${formatAmount(cheapest, currency)} round trip. `
      + `Best dates: depart ${formatDate(cheapestDates[0]!)}, return ${formatDate(cheapestDates[1]!)}.`;
  }
  if (searchWindows.length === 1) {
    const window = searchWindows[0]!;
    const start = stringField(window, "start");
    const end = stringField(window, "end");
    const range = high > cheapest
      ? `${formatAmount(cheapest, currency)}–${formatAmount(high, currency)}`
      : `about ${formatAmount(cheapest, currency)}`;
    const across = start && end && start !== end
      ? ` across ${formatDateWindow(start, end)}`
      : "";
    if (!across) {
      return `${route} is about ${formatAmount(cheapest, currency)} one-way for ${formatDate(cheapestDates[0]!)}.`;
    }
    return `${route} is ${range} one-way${across}. Cheapest is ${formatDate(cheapestDates[0]!)} at about ${formatAmount(cheapest, currency)}.`;
  }
  const stops = route.split(/\s*→\s*/u).filter(Boolean);
  const legs = searchWindows.map((window, index) => {
    const start = stringField(window, "start");
    const end = stringField(window, "end");
    const legRoute = stops[index] && stops[index + 1]
      ? `${stops[index]} → ${stops[index + 1]}`
      : `Leg ${index + 1}`;
    const dates = start && end
      ? (start === end ? formatDate(start) : formatDateWindow(start, end))
      : "Dates unavailable";
    return `${legRoute}\n${dates}`;
  }).join("\n\n");
  const range = high > cheapest
    ? `${formatAmount(cheapest, currency)}–${formatAmount(high, currency)}`
    : `about ${formatAmount(cheapest, currency)}`;
  const checked = searched > 0
    ? `\n\nI checked ${searched} date combination${searched === 1 ? "" : "s"} around your dates.`
    : "";
  return `I’ve checked your dates and found options for every leg.\n\n${legs}`
    + `\n\nAltogether, the trip is coming in at ${range}.${checked}`;
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

function formatDateWindow(start: string, end: string): string {
  if (start.slice(0, 7) === end.slice(0, 7)) {
    return `${Number(start.slice(8, 10))}–${formatDate(end)}`;
  }
  return `${formatDate(start)}–${formatDate(end)}`;
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
