import { useEffect, useState } from "react";

import type { Watch } from "../domain";
import {
  formatElapsedClock,
  searchStartedAt,
  type TripStage
} from "../trip-stage";
import { relativeTime, scheduleTime } from "../format";

export function AgentScheduleStatus({
  stage,
  watch: _watch
}: {
  stage: TripStage;
  watch: Watch | null;
}) {
  if (stage === "stopped" || stage === "planning") return null;

  const active = stage === "searching" || stage === "tracking";
  const label = active ? "Active" : "Inactive";
  return (
    <span className={`feed-status is-${active ? "live" : stage}`} aria-label={label}>
      <i className="feed-status-dot" aria-hidden="true" />
      <small>{label}</small>
    </span>
  );
}

export function AgentScheduleChecks({
  stage,
  watch
}: {
  stage: TripStage;
  watch: Watch;
}) {
  const startedAt = stage === "searching" ? searchStartedAt(watch) : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const runTime = startedAt
    ? formatElapsedClock(Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)))
    : null;

  return (
    <dl className="watch-checks">
      {runTime ? (
        <div>
          <dt>Run time</dt>
          <dd>{runTime}</dd>
        </div>
      ) : null}
      <div>
        <dt>Last check</dt>
        <dd>{watch.lastCheckAt ? relativeTime(watch.lastCheckAt) : "Not yet"}</dd>
      </div>
      <div>
        <dt>Next check</dt>
        <dd>{watch.nextCheckAt ? scheduleTime(watch.nextCheckAt) : "Unscheduled"}</dd>
      </div>
    </dl>
  );
}
