import type {
  RankingMode,
  Recommendation,
  TrackedPriceHistory,
  Watch
} from "./domain.js";
import { scheduleTime } from "./format.js";

export type FeedBriefing = {
  prose: string;
  observedAt: string | null;
};

/**
 * Short Captain-voice copy for the feed: where things stand, and what to do next.
 * Not a flight metrics line — that belongs on the cards below.
 */
export function feedBriefing({
  recommendation,
  pickLabel,
  tracked,
  watch,
  watchingCount
}: {
  recommendation: Recommendation | null;
  pickLabel: string | null;
  tracked: TrackedPriceHistory | null;
  watch: Watch | null;
  watchingCount: number;
}): FeedBriefing | null {
  const state = stateSentence({ recommendation, pickLabel, tracked, watchingCount });
  const next = nextSentence({ tracked, watch, watchingCount, hasPick: Boolean(recommendation) });
  const prose = [state, next].filter(Boolean).join(" ");
  if (!prose) return null;

  return {
    prose,
    observedAt: recommendation?.observedAt
      ?? tracked?.points.at(-1)?.observedAt
      ?? watch?.lastCheckAt
      ?? null
  };
}

function stateSentence({
  recommendation,
  pickLabel,
  tracked,
  watchingCount
}: {
  recommendation: Recommendation | null;
  pickLabel: string | null;
  tracked: TrackedPriceHistory | null;
  watchingCount: number;
}): string | null {
  if (recommendation) {
    const mode = rankingLabel(recommendation.rankingMode);
    const pick = pickLabel
      ? `Captain’s pick is ${pickLabel}`
      : `Captain has a ${mode} pick ready`;
    if (tracked?.headline) return `${pick}. ${tracked.headline}`;
    return `${pick} on the ${mode} ranking.`;
  }

  if (tracked?.headline) return tracked.headline;
  if (watchingCount > 0) {
    return watchingCount === 1
      ? "Watching one flight."
      : `Watching ${watchingCount} flights.`;
  }
  return null;
}

function nextSentence({
  tracked,
  watch,
  watchingCount,
  hasPick
}: {
  tracked: TrackedPriceHistory | null;
  watch: Watch | null;
  watchingCount: number;
  hasPick: boolean;
}): string | null {
  if (watch?.status === "paused") {
    return "Tracking is paused — resume when you want Captain to keep looking.";
  }

  if (tracked?.verdict === "book_now") {
    return "Open the flight if you want to lock it in.";
  }

  if (tracked?.verdict === "wait") {
    return watchNext(watch)
      ?? "Captain will keep watching for a better fare.";
  }

  if (watch?.status === "completed") {
    return "This run finished — refresh when you want another look.";
  }

  const scheduled = watchNext(watch);
  if (scheduled) return scheduled;

  if (watchingCount > 0 && !hasPick) {
    return "Captain will surface a pick once a check finds a clear standout.";
  }

  if (hasPick) return "Open the flight when you’re ready, or wait for the next check.";
  return null;
}

function watchNext(watch: Watch | null): string | null {
  if (!watch || watch.status === "paused" || watch.status === "completed") return null;
  if (!watch.nextCheckAt) return null;
  return `Next check ${scheduleTime(watch.nextCheckAt)}.`;
}

function rankingLabel(mode: RankingMode): string {
  if (mode === "cheapest") return "cheapest";
  if (mode === "fastest") return "fastest";
  return "balanced";
}
