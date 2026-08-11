import type { Segment } from "../domain";
import { clockLabel, formatDurationSeconds } from "../format";

export function FlightTimeline({ segments }: { segments: Segment[] }) {
  return (
    <ol className="flight-timeline">
      {segments.map((segment, index) => {
        const next = segments[index + 1];
        const travelSeconds = Math.max(
          0,
          (Date.parse(segment.arrival) - Date.parse(segment.departure)) / 1000
        );
        const layoverMs = next
          ? Date.parse(next.departure) - Date.parse(segment.arrival)
          : null;
        const showLayover = layoverMs !== null && Number.isFinite(layoverMs) && layoverMs > 0;
        return (
          <li key={`${segment.flightNumber}-${segment.departure}`} className="timeline-leg">
            <div className="timeline-node">
              <strong>{clockLabel(segment.departure)}</strong>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-node-body">
                <b>{segment.origin}</b>
              </div>
            </div>
            <div className="timeline-rail">
              <span className="timeline-rail-line" aria-hidden="true" />
              <p className="timeline-travel">Travel {formatDurationSeconds(travelSeconds)}</p>
            </div>
            <div className="timeline-node">
              <strong>{clockLabel(segment.arrival)}</strong>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-node-body">
                <b>{segment.destination}</b>
                <small>{segment.airline} · {segment.flightNumber}</small>
              </div>
            </div>
            {showLayover ? (
              <p className="timeline-layover">
                {formatDurationSeconds(layoverMs / 1000)} layover · {segment.destination}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
