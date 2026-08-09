/**
 * Every trip Captain runs is in service of one stated goal, and the goal is
 * derived rather than asked for: it is already fully determined by the route,
 * the departure date, how the traveller wants flights ranked, and any ceiling
 * they put on the fare. Deriving it means the goal can never drift from the
 * trip it describes, and onboarding stays free of extra questions.
 *
 * The dashboard and agent use it as decision context so recommendations stay
 * aligned without printing this internal sentence to the traveller.
 */
import type { RankingMode } from "./profile.js";
import type { TripBrief, TripStatus } from "./trip.js";

export type TripGoalInput = {
  brief: Pick<
    TripBrief,
    | "originAirports"
    | "destinationAirports"
    | "departureWindow"
    | "legs"
    | "tripType"
    | "currency"
    | "maximumPrice"
  >;
  rankingMode: RankingMode;
};

export function tripGoalState(status: TripStatus): {
  planConfirmation: "pending" | "achieved";
  phase: "plan_review" | "fare_pattern_analysis";
  currentGoal: string;
} {
  const confirmed = status !== "draft";
  return confirmed
    ? {
        planConfirmation: "achieved",
        phase: "fare_pattern_analysis",
        currentGoal: "Analyse verified flight and fare patterns, then update the traveller when the cost picture is useful."
      }
    : {
        planConfirmation: "pending",
        phase: "plan_review",
        currentGoal: "Get the traveller to review or confirm the saved itinerary before analysing fares."
      };
}

/** What Captain is ranking for, in the traveller's terms. */
const rankingGoals: Record<RankingMode, string> = {
  cheapest: "the cheapest fare",
  balanced: "the best balance of fare and journey time",
  fastest: "the fastest journey"
};

/**
 * One sentence naming what this trip is for. Deliberately a claim Captain can
 * be held to: a route, a date range, and the way live options will be ranked.
 */
export function formatTripGoal(input: TripGoalInput): string {
  const route = goalRoute(input.brief);
  const target = input.brief.maximumPrice
    ? `under ${formatCeiling(input.brief.maximumPrice, input.brief.currency)}`
    : rankingGoals[input.rankingMode];
  return `Get you ${route} on ${goalDate(input.brief.departureWindow)} for ${target}, `
    + "using verified fares as prices change.";
}

/**
 * The same goal reduced to a fragment an automatic message can close on, so an
 * alert always says what its news means for the thing Captain is chasing.
 */
export function formatTripGoalTarget(input: TripGoalInput): string {
  return input.brief.maximumPrice
    ? `your ${formatCeiling(input.brief.maximumPrice, input.brief.currency)} target`
    : rankingGoals[input.rankingMode];
}

function goalRoute(brief: TripGoalInput["brief"]): string {
  const legs = brief.legs ?? [];
  if (brief.tripType === "multi_city" && legs.length >= 2) {
    return [
      legs[0]!.originAirports.join("/"),
      ...legs.map((leg) => leg.destinationAirports.join("/"))
    ].join(" → ");
  }
  const route = `${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")}`;
  return brief.tripType === "round_trip" ? `${route} and back` : route;
}

/**
 * A window wider than a day is a range the traveller is choosing between, so
 * the goal names both ends rather than pretending a single date was fixed.
 */
function goalDate(window: { start: string; end: string }): string {
  const start = shortDate(window.start);
  return window.start === window.end ? start : `${start}–${shortDate(window.end)}`;
}

function shortDate(value: string): string {
  const parsed = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(new Date(parsed));
}

function formatCeiling(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}
