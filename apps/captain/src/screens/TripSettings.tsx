import { useState } from "react";

import { tripAction } from "../api";
import { TripPlanEditor } from "../components/TripPlanEditor";
import type { TripPayload } from "../domain";
import {
  activityLabel,
  dateRangeLabel,
  relativeTime,
  routeLabel,
  scheduleTime,
  timestampLabel
} from "../format";
import { stageLabel, tripStage, type TripStage } from "../trip-stage";

export function TripSettings({
  tripData,
  trackingError,
  onTripChanged,
  onTripError,
  onBack
}: {
  tripData: TripPayload | null;
  trackingError: string;
  onTripChanged: () => Promise<void>;
  onTripError: (value: string) => void;
  onBack: () => void;
}) {
  const [stopped, setStopped] = useState(false);
  const trip = stopped ? null : tripData?.trip ?? null;
  const watch = stopped ? null : tripData?.watch ?? null;
  const stage = tripStage({ trip, watch });

  if (!trip || !tripData) {
    return (
      <main className="settings-shell">
        <SettingsTopbar onBack={onBack} />
        <section className="settings-intro">
          <h1>Trip stopped</h1>
          <p>Choose another trip from Telegram.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="settings-shell">
      <SettingsTopbar onBack={onBack} />
      <section className="settings-intro">
        <h1>{trip.title}</h1>
        <p>{dateRangeLabel(trip.brief.departureWindow.start, trip.brief.departureWindow.end)}</p>
      </section>

      <TripPlanEditor key={`${trip.id}:${trip.version}`} trip={trip} onSaved={onTripChanged} />
      <TrackingCard
        data={tripData}
        stage={stage}
        error={trackingError}
        onChanged={onTripChanged}
        onStopped={() => setStopped(true)}
        onError={onTripError}
      />
      <details className="settings-card settings-disclosure">
        <summary>
          <span><strong>Activity</strong></span>
          <em>{tripData.activity.length}</em>
        </summary>
        <div className="settings-body">
          {tripData.activity.length > 0 ? (
            <div className="activity-list">
              {tripData.activity.map((item) => (
                <article key={item.id}>
                  <i />
                  <span>
                    <strong>{activityLabel(item.eventType)}</strong>
                    <small>{timestampLabel(item.createdAt)}</small>
                  </span>
                </article>
              ))}
            </div>
          ) : <p>Nothing yet.</p>}
        </div>
      </details>
    </main>
  );
}

function SettingsTopbar({ onBack }: { onBack: () => void }) {
  return (
    <header className="topbar">
      <button className="back-link" onClick={onBack}>← Trip</button>
      <span className="name">Trip settings</span>
    </header>
  );
}

function TrackingCard({
  data,
  stage,
  error,
  onChanged,
  onStopped,
  onError
}: {
  data: TripPayload;
  stage: TripStage;
  error: string;
  onChanged: () => Promise<void>;
  onStopped: () => void;
  onError: (value: string) => void;
}) {
  const watch = data.watch;
  return (
    <details className="settings-card settings-disclosure" open>
      <summary>
        <span><strong>Tracking</strong></span>
        <em>{stageLabel(stage, watch)}</em>
      </summary>
      <div className="settings-body tracking-settings">
        <dl className="settings-list">
          <div>
            <dt>Last check</dt>
            <dd>{watch?.lastCheckAt ? relativeTime(watch.lastCheckAt) : "None"}</dd>
          </div>
          <div>
            <dt>{stage === "stale" ? "Ended" : "Next check"}</dt>
            <dd>{stage === "stale" && watch?.completedAt
              ? relativeTime(watch.completedAt)
              : watch?.nextCheckAt ? scheduleTime(watch.nextCheckAt) : "Not scheduled"}</dd>
          </div>
          <div><dt>Flights</dt><dd>{data.offers.length}</dd></div>
        </dl>
        <p>{stage === "planning"
          ? "Confirm this plan before Captain starts analysing fares."
          : "Checked once a day, until the day you fly."}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <TripControls
          data={data}
          stage={stage}
          onChanged={onChanged}
          onStopped={onStopped}
          onError={onError}
        />
      </div>
    </details>
  );
}

function TripControls({
  data,
  stage,
  onChanged,
  onStopped,
  onError
}: {
  data: TripPayload;
  stage: TripStage;
  onChanged: () => Promise<void>;
  onStopped: () => void;
  onError: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const trip = data.trip!;
  async function act(type: "pause" | "resume" | "refresh" | "track" | "cancel") {
    setBusy(true);
    onError("");
    try {
      await tripAction(type, trip.id, trip.version);
      if (type === "cancel") {
        onStopped();
        return;
      }
      await onChanged();
    } catch {
      onError("That action didn’t complete. Reload and try again.");
    } finally {
      setBusy(false);
    }
  }
  const stop = (
    <button
      className="danger"
      disabled={busy}
      onClick={() => {
        if (window.confirm(`Stop tracking ${routeLabel(trip)}?`)) void act("cancel");
      }}
    >
      Stop
    </button>
  );
  if (stage === "stale") {
    return (
      <div className="trip-controls">
        <button className="primary" disabled={busy} onClick={() => void act("track")}>Track</button>
        {stop}
      </div>
    );
  }
  if (stage === "planning") {
    return (
      <div className="trip-controls">
        <button className="primary" disabled={busy} onClick={() => void act("track")}>
          {busy ? "Now checking flights…" : "Confirm"}
        </button>
        {stop}
      </div>
    );
  }
  const paused = stage === "paused";
  return (
    <div className="trip-controls">
      <button disabled={busy} onClick={() => void act(paused ? "resume" : "pause")}>
        {paused ? "Resume" : "Pause"}
      </button>
      <button className="primary" disabled={busy || paused} onClick={() => void act("refresh")}>
        Refresh
      </button>
      {stop}
    </div>
  );
}
