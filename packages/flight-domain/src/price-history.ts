/**
 * Captain tracks one flight and answers a single question: is this a good
 * moment to buy? Everything here reads the observed price series for that one
 * itinerary and turns it into a claim a traveller can act on.
 *
 * Both the dashboard and Telegram render from `summarizePriceHistory`, so the
 * card and the message can never disagree about what the prices are doing.
 */

export type PricePoint = {
  /** Calendar day, UTC. One point per day: the lowest fare seen that day. */
  day: string;
  price: number;
  observedAt: string;
};

export type PriceVerdict =
  /** At or near the lowest price seen, and departure is close enough to act. */
  | "book_now"
  /** Cheaper than most of what has been seen. */
  | "good_price"
  /** Nothing decisive: the fare is sitting mid-range. */
  | "holding"
  /** Near the top of its range with time left for it to come back down. */
  | "wait";

export type PriceHistorySummary = {
  currency: string;
  points: PricePoint[];
  current: number;
  low: number;
  high: number;
  average: number;
  /** Current price minus the first price observed for this flight. */
  changeSinceStart: number;
  /** Current price minus the previous day's. Zero on the first day. */
  changeSinceLastCheck: number;
  /** Where the current price sits in its range: 0 at the low, 1 at the high. */
  positionInRange: number;
  daysTracked: number;
  daysToDeparture: number | null;
  verdict: PriceVerdict;
  /** One sentence stating what the prices are doing. */
  headline: string;
};

/** Within this window fares climb far more often than they fall. */
const FINAL_APPROACH_DAYS = 21;
/** Prices this close to the low are treated as being at the low. */
const AT_LOW_TOLERANCE = 0.02;
/** A move worth telling someone about, as a share of the current price. */
export const MEANINGFUL_MOVE = 0.05;
/** …and in absolute terms, so cheap fares don't alert on small change. */
export const MEANINGFUL_MOVE_MINIMUM = 15;

/**
 * Collapses raw observations into one point per day, keeping the lowest fare
 * seen that day. A manual refresh should not weight a day more than a
 * scheduled check does.
 */
export function toDailyPoints(
  observations: ReadonlyArray<{ price: number; observedAt: string }>
): PricePoint[] {
  const byDay = new Map<string, PricePoint>();
  for (const observation of observations) {
    const parsed = Date.parse(observation.observedAt);
    if (!Number.isFinite(parsed) || !Number.isFinite(observation.price)) continue;
    const day = new Date(parsed).toISOString().slice(0, 10);
    const current = byDay.get(day);
    if (!current || observation.price < current.price) {
      byDay.set(day, {
        day,
        price: observation.price,
        observedAt: new Date(parsed).toISOString()
      });
    }
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
}

export function summarizePriceHistory(input: {
  observations: ReadonlyArray<{ price: number; observedAt: string }>;
  currency: string;
  /** Departure date (YYYY-MM-DD), used to weigh how much time is left to wait. */
  departureDate?: string | null;
  now?: Date;
}): PriceHistorySummary | null {
  const points = toDailyPoints(input.observations);
  const last = points.at(-1);
  const first = points[0];
  if (!last || !first) return null;

  const prices = points.map((point) => point.price);
  const current = last.price;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const average = prices.reduce((total, price) => total + price, 0) / prices.length;
  const previous = points.at(-2)?.price ?? current;
  const span = high - low;
  const daysToDeparture = daysUntil(input.departureDate ?? null, input.now ?? new Date());

  const summary = {
    currency: input.currency,
    points,
    current,
    low,
    high,
    average,
    changeSinceStart: current - first.price,
    changeSinceLastCheck: current - previous,
    positionInRange: span > 0 ? (current - low) / span : 0,
    daysTracked: points.length,
    daysToDeparture
  };
  const verdict = decideVerdict(summary);
  return { ...summary, verdict, headline: headlineFor({ ...summary, verdict }) };
}

type SummaryFacts = Omit<PriceHistorySummary, "verdict" | "headline">;

/**
 * One day of data says nothing about a trend, so a fresh watch stays on
 * "holding" until there is a range to compare against.
 */
function decideVerdict(summary: SummaryFacts): PriceVerdict {
  if (summary.daysTracked < 2 || summary.high === summary.low) return "holding";
  const atLow = summary.current <= summary.low * (1 + AT_LOW_TOLERANCE);
  const timeLeft = summary.daysToDeparture === null
    || summary.daysToDeparture > FINAL_APPROACH_DAYS;

  // Close to departure the fare has nowhere good to go, so the cheapest thing
  // on the board is the recommendation regardless of where it sits in range.
  if (!timeLeft) return atLow ? "book_now" : "holding";
  if (atLow) return "book_now";
  if (summary.positionInRange >= 0.75) return "wait";
  if (summary.current < summary.average) return "good_price";
  return "holding";
}

function headlineFor(summary: SummaryFacts & { verdict: PriceVerdict }): string {
  const move = Math.abs(summary.changeSinceStart);
  const direction = summary.changeSinceStart < 0 ? "down" : "up";
  const since = summary.daysTracked > 1
    ? ` ${direction} ${formatAmount(move, summary.currency)} since tracking started`
    : "";
  switch (summary.verdict) {
    case "book_now":
      return `Cheapest this flight has been${since}. A good moment to buy.`;
    case "wait":
      return `Near the top of its range${since}. There is still time for it to come back down.`;
    case "good_price":
      return `Below its average${since}.`;
    default:
      return summary.daysTracked > 1
        ? `Holding steady${since}.`
        : "Tracking started. Captain needs another day before it can call a trend.";
  }
}

/** A move worth interrupting someone about. */
export function isMeaningfulMove(from: number, to: number): boolean {
  const change = Math.abs(to - from);
  return change >= MEANINGFUL_MOVE_MINIMUM && from > 0 && change / from >= MEANINGFUL_MOVE;
}

function daysUntil(departureDate: string | null, now: Date): number | null {
  if (!departureDate) return null;
  const departure = Date.parse(`${departureDate}T00:00:00.000Z`);
  if (!Number.isFinite(departure)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((departure - today) / 86_400_000);
}

function formatAmount(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}
