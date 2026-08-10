import type { OfferSnapshot } from "@agents/flight-domain";
import type { CaptainNotification, RecommendationSnapshot } from "@agents/flight-store";

/**
 * Deterministic explanations of why a recommendation or alert says what it
 * says. The arithmetic — regret weights, price deltas, journey-time changes —
 * is settled here rather than reasoned about by a model, so the numbers a
 * traveller is given always reconcile with the ones Captain ranked on.
 *
 * Lifted out of the Telegram channel when explanation questions stopped being
 * routed by a regex there: the capability is needed by the agent's `get_trip`
 * too, and a tool importing a channel would drag the whole webhook adapter
 * into its module graph.
 */
export function explainRecommendation(snapshot: RecommendationSnapshot): string {
  const current = snapshot.current;
  const previous = snapshot.previous;
  const currentDuration = snapshotNumber(current.snapshot, "durationSeconds");
  const previousDuration = previous ? snapshotNumber(previous.snapshot, "durationSeconds") : 0;
  const evidence = current.evidence[0];
  const source = evidence ? `\nEvidence: ${evidence.url}` : "";
  if (!previous) {
    return [
      `This was the first ${titleCase(snapshot.rankingMode)} option I found for the trip.`,
      `It was ${current.currency} ${current.priceAmount}, ${durationLabel(currentDuration)}, ${stopLabel(snapshotNumber(current.snapshot, "stops"))}.`,
      "Prices and availability can change, so use the source below to check the latest details."
    ].join("\n") + source;
  }
  const priceChange = previous.price - current.price;
  const durationChange = previousDuration - currentDuration;
  const comparison = snapshot.rankingMode === "cheapest"
    ? `It saves ${formatMoney(Math.max(0, priceChange), current.currency)} (${percentage(priceChange, previous.price)}).`
    : snapshot.rankingMode === "fastest"
      ? `It cuts journey time by ${durationLabel(Math.max(0, durationChange))}.`
      : [
          "Balanced uses 50% price regret, 35% duration regret, and 15% stops, with a small preferred-airline credit.",
          [
            priceChange > 0 ? `${formatMoney(priceChange, current.currency)} cheaper` : "",
            durationChange > 0 ? `${durationLabel(durationChange)} shorter` : "",
            snapshotNumber(previous.snapshot, "stops") > snapshotNumber(current.snapshot, "stops")
              ? "fewer stops"
              : ""
          ].filter(Boolean).join(", ") || "Its combined score improved by at least 10%."
        ].join("\n");
  return [
    `Captain compared this alert with the exact earlier result it replaced (${previous.currency} ${previous.priceAmount}, ${durationLabel(previousDuration)}).`,
    comparison,
    `New result: ${current.currency} ${current.priceAmount}, ${durationLabel(currentDuration)}, ${stopLabel(snapshotNumber(current.snapshot, "stops"))}.`
  ].join("\n") + source;
}

export function explainNotification(notification: CaptainNotification): string | null {
  const snapshot = snapshotFromPayload(notification.payload);
  if (snapshot) return explainRecommendation(snapshot);
  if (notification.kind === "price_rise") {
    const current = record(notification.payload.current) as unknown as OfferSnapshot | null;
    if (!current) return null;
    const increase = Number(notification.payload.increase);
    const low = Number(notification.payload.sevenDayLow);
    const percent = Number(notification.payload.percent);
    if (![increase, low, percent].every(Number.isFinite)) return null;
    const evidence = current.evidence[0];
    return [
      `The option was ${current.currency} ${current.priceAmount}, up ${formatMoney(increase, current.currency)} (${Math.round(percent)}%) from its seven-day low of ${formatMoney(low, current.currency)}.`,
      evidence ? `I checked it here: ${evidence.url}` : ""
    ].filter(Boolean).join("\n");
  }
  return null;
}

function snapshotFromPayload(payload: Record<string, unknown>): RecommendationSnapshot | null {
  const snapshot = record(payload.snapshot);
  return snapshot?.current && snapshot.rankingMode
    ? snapshot as unknown as RecommendationSnapshot
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function snapshotNumber(snapshot: Record<string, unknown>, key: string): number {
  const value = Number(snapshot[key]);
  return Number.isFinite(value) ? value : 0;
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

function durationLabel(seconds: number): string {
  if (seconds <= 0) return "unknown duration";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.round((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

function stopLabel(value: number): string {
  return value === 0 ? "nonstop" : `${value} stop${value === 1 ? "" : "s"}`;
}

function percentage(change: number, previous: number): string {
  return previous > 0 ? `${Math.max(0, Math.round(change / previous * 100))}%` : "an improvement";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
