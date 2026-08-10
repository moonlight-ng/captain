import type { TripPayload } from "./domain.js";
import { relativeTime, scheduleTime } from "./format.js";

/**
 * One vocabulary for where a trip is in its life. Trip settings decides what to
 * render from this, and the trip header labels itself from it.
 */
export type TripStage =
  | "stopped"
  | "paused"
  | "planning"
  | "stale"
  | "searching"
  | "tracking";

export function tripStage({
  trip,
  watch,
  searchBusy = false
}: {
  trip: TripPayload["trip"] | null;
  watch: TripPayload["watch"] | null | undefined;
  searchBusy?: boolean;
}): TripStage {
  if (!trip) return "stopped";
  if (trip.status === "draft") return "planning";
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
  if (stage === "paused") return "Paused";
  if (stage === "planning") return "Not confirmed";
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
 * arrival instead of waiting for the schedule. A trip the traveller stopped or
 * finished stays where it is, and a run already under way is the check we would
 * have started. A run past its window needs Track, not a refresh, so opening
 * the trip leaves that to the traveller.
 */
export function shouldAutoSearchOnOpen({
  trip,
  watch
}: {
  trip: TripPayload["trip"] | null;
  watch: TripPayload["watch"] | null | undefined;
}): boolean {
  if (!trip || !watch) return false;
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

/** When the current check started — for the live running-time status. */
export function searchStartedAt(
  watch: TripPayload["watch"] | null | undefined
): string | null {
  if (!watch || watch.status !== "active") return null;
  if (
    watch.lastManualRefreshAt
    && (!watch.lastCheckAt || Date.parse(watch.lastManualRefreshAt) > Date.parse(watch.lastCheckAt))
  ) {
    return watch.lastManualRefreshAt;
  }
  if (!watch.lastCheckAt) {
    return watch.activatedAt ?? watch.runStartedAt;
  }
  if (watch.nextCheckAt && Date.parse(watch.nextCheckAt) <= Date.now() + 60_000) {
    return Date.parse(watch.nextCheckAt) <= Date.now()
      ? watch.nextCheckAt
      : new Date().toISOString();
  }
  return null;
}

/** Compact mm:ss (or h:mm:ss) elapsed clock for a live search. */
export function formatElapsedClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * How long the agent has been on the job. Same ticking clock under a day;
 * once a run stretches longer, days lead so the face stays readable.
 */
export function formatWorkedDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(total / 86_400);
  if (days <= 0) return formatElapsedClock(total);
  const remainder = total % 86_400;
  return `${days}d ${formatElapsedClock(remainder)}`;
}

/** When the agent started working this run — activation, else run start. */
export function agentStartedAt(
  watch: TripPayload["watch"] | null | undefined
): string | null {
  if (!watch) return null;
  return watch.activatedAt ?? watch.runStartedAt ?? null;
}
