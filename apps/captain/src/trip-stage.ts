import type { TripPayload } from "./domain.js";
import { relativeTime, scheduleTime } from "./format.js";

/**
 * One vocabulary for where a trip is in its life. Trip settings decides what to
 * render from this, and the trip header labels itself from it.
 */
export type TripStage =
  | "stopped"
  | "booked"
  | "paused"
  | "stale"
  | "searching"
  | "tracking";

export function tripStage({
  trip,
  watch,
  booked = false,
  searchBusy = false
}: {
  trip: TripPayload["trip"] | null;
  watch: TripPayload["watch"] | null | undefined;
  booked?: boolean;
  searchBusy?: boolean;
}): TripStage {
  if (!trip) return "stopped";
  if (booked) return "booked";
  if (trip.status === "paused" || watch?.status === "paused") return "paused";
  if (watch?.status === "completed") return "stale";
  if (searchBusy || isWatchSearching(watch, trip)) return "searching";
  return "tracking";
}

/** Short label for a stage, with check freshness while a run is live. */
export function stageLabel(
  stage: TripStage,
  watch?: TripPayload["watch"] | null
): string {
  if (stage === "stopped") return "";
  if (stage === "booked") return "Booked";
  if (stage === "paused") return "Paused";
  if (stage === "stale") return "Prices stale";
  if (stage === "searching") return "Searching";
  if (watch?.lastCheckAt) return `Checked ${relativeTime(watch.lastCheckAt)}`;
  if (watch?.nextCheckAt) {
    const next = scheduleTime(watch.nextCheckAt);
    return next === "Due now" ? "Checking soon" : `Next check ${next.toLowerCase()}`;
  }
  return "Tracking";
}

/**
 * Opening a trip should show current prices, so Captain starts a check on
 * arrival instead of waiting for the schedule. A trip the traveller stopped,
 * finished, or booked stays where it is, and a run already under way is the
 * check we would have started. A run past its window needs Track, not a
 * refresh, so opening the trip leaves that to the traveller.
 */
export function shouldAutoSearchOnOpen({
  trip,
  watch,
  booked = false
}: {
  trip: TripPayload["trip"] | null;
  watch: TripPayload["watch"] | null | undefined;
  booked?: boolean;
}): boolean {
  if (!trip || booked || !watch) return false;
  if (trip.status === "paused") return false;
  if (watch.status !== "active" && watch.status !== "scheduled") return false;
  if (Date.parse(watch.runEndsAt) <= Date.now()) return false;
  return !isWatchSearching(watch, trip);
}

export function isWatchSearching(
  watch: TripPayload["watch"] | null | undefined,
  trip: TripPayload["trip"] | null
): boolean {
  if (!trip || trip.status === "paused" || !watch || watch.status !== "active") return false;
  if (!watch.lastCheckAt) return true;
  if (watch.lastManualRefreshAt && Date.parse(watch.lastManualRefreshAt) > Date.parse(watch.lastCheckAt)) {
    return true;
  }
  if (watch.nextCheckAt && Date.parse(watch.nextCheckAt) <= Date.now() + 60_000) return true;
  return false;
}
