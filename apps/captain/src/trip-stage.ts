import type { TripPayload } from "./domain.js";
import { relativeTime, scheduleTime } from "./format.js";

/**
 * One vocabulary for where a trip is in its life. Trip settings decides what to
 * render from this, and the trip header labels itself from it.
 */
export type TripStage =
  | "stopped"
  | "paused"
  | "stale"
  | "searching"
  | "tracking";

export function tripStage({
  trip,
  watch,
  search,
  searchBusy = false
}: {
  trip: TripPayload["trip"] | null;
  watch: TripPayload["watch"] | null | undefined;
  search?: TripPayload["search"] | null;
  searchBusy?: boolean;
}): TripStage {
  if (!trip) return "stopped";
  if (trip.status === "paused" || watch?.status === "paused") return "paused";
  if (watch?.status === "completed") return "stale";
  if (searchBusy || isTripSearchPending(search)) return "searching";
  return "tracking";
}

/** Short label for a stage, with check freshness while a run is live. */
export function stageLabel(
  stage: TripStage,
  watch?: TripPayload["watch"] | null
): string {
  if (stage === "stopped") return "";
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
 * arrival instead of waiting for the daily schedule. A run already under way
 * is the check we would have started, so repeated page opens join it.
 */
export function shouldAutoSearchOnOpen({
  trip,
  search
}: {
  trip: TripPayload["trip"] | null;
  search: TripPayload["search"] | null | undefined;
}): boolean {
  return Boolean(trip) && !isTripSearchPending(search);
}

export function isTripSearchPending(
  search: TripPayload["search"] | null | undefined
): boolean {
  return search?.status === "queued" || search?.status === "running";
}
