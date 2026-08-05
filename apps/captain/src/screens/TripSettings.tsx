import { useEffect, useState, type FormEvent } from "react";

import {
  ApiError,
  listPassengers,
  setTripTravellers,
  tripAction,
  updateTripBrief
} from "../api";
import type { Passenger, TripPayload } from "../domain";
import {
  activityLabel,
  dateLabel,
  dateRangeLabel,
  formatMoney,
  label,
  relativeTime,
  routeLabel,
  scheduleTime,
  timestampLabel
} from "../format";
import { stageLabel, tripStage, type TripStage } from "../trip-stage";
import type { MockBooking } from "../mock-booking";
import { AirlineSearchSelect } from "../components/AirlineSearchSelect";
import { travellerProfileHref } from "../components/TripTravellerPicker";

export function TripSettings({
  tripData,
  booking,
  trackingError,
  sessionCredential,
  onTripChanged,
  onTripError,
  onBookingChange,
  onBack
}: {
  tripData: TripPayload | null;
  booking: MockBooking | null;
  trackingError: string;
  /** Assigning a traveller needs a revocable cookie session, not a legacy bearer. */
  sessionCredential: boolean;
  onTripChanged: () => Promise<void>;
  onTripError: (value: string) => void;
  onBookingChange: (booking: MockBooking) => void;
  onBack: () => void;
}) {
  const [stopped, setStopped] = useState(false);
  const trip = stopped ? null : tripData?.trip ?? null;
  const watch = stopped ? null : tripData?.watch ?? null;
  const stage = tripStage({ trip, watch, booked: Boolean(booking) });

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
        <h1>{routeLabel(trip)}</h1>
        <p>{dateRangeLabel(trip.brief.departureWindow.start, trip.brief.departureWindow.end)}</p>
      </section>

      {stage === "booked" && booking ? (
        <BookingCard booking={booking} onChange={onBookingChange} onBack={onBack} />
      ) : (
        <>
          <TrackingCard
            data={tripData}
            stage={stage}
            error={trackingError}
            onChanged={onTripChanged}
            onStopped={() => setStopped(true)}
            onError={onTripError}
          />
          <BriefCard trip={trip} onSaved={onTripChanged} />
        </>
      )}

      <TravellerCard
        tripId={trip.id}
        assigned={tripData.travellers}
        sessionCredential={sessionCredential}
        readOnly={stage === "booked"}
        onAssigned={onTripChanged}
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
        <p>Three days, checked every six hours.</p>
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

function BriefCard({
  trip,
  onSaved
}: {
  trip: NonNullable<TripPayload["trip"]>;
  onSaved: () => Promise<void>;
}) {
  const [brief, setBrief] = useState(() => ({
    ...trip.brief,
    context: /^Prepared from confirmed Captain trip draft\b/iu.test(trip.brief.context)
      ? ""
      : trip.brief.context
  }));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const airportCodes = (value: string) => [...new Set(
    value.toUpperCase().match(/[A-Z]{3}/gu) ?? []
  )].slice(0, 6);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      await updateTripBrief(trip.id, trip.version, brief);
      setSaved(true);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? "This trip changed elsewhere. Reload it from Telegram before editing."
        : "Captain couldn’t update this trip. Check the fields and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="settings-card settings-disclosure">
      <summary>
        <span><strong>Trip brief</strong></span>
        <em>{dateLabel(brief.departureWindow.start)}</em>
      </summary>
      <div className="settings-body">
        <form onSubmit={(event) => void save(event)}>
          {brief.tripType === "multi_city" ? (
            <div className="read-only-field">
              <span>Route</span>
              <strong>{routeLabel(trip)}</strong>
              <small>Change multi-city routes in Telegram.</small>
            </div>
          ) : (
            <>
              <div className="form-grid two">
                <label>
                  From
                  <input
                    value={brief.originAirports.join(", ")}
                    onChange={(event) => setBrief({
                      ...brief,
                      originAirports: airportCodes(event.target.value)
                    })}
                  />
                </label>
                <label>
                  To
                  <input
                    value={brief.destinationAirports.join(", ")}
                    onChange={(event) => setBrief({
                      ...brief,
                      destinationAirports: airportCodes(event.target.value)
                    })}
                  />
                </label>
              </div>
              <div className="form-grid two">
                <label>
                  Earliest departure
                  <input
                    type="date"
                    value={brief.departureWindow.start}
                    onChange={(event) => setBrief({
                      ...brief,
                      departureWindow: { ...brief.departureWindow, start: event.target.value }
                    })}
                  />
                </label>
                <label>
                  Latest departure
                  <input
                    type="date"
                    value={brief.departureWindow.end}
                    onChange={(event) => setBrief({
                      ...brief,
                      departureWindow: { ...brief.departureWindow, end: event.target.value }
                    })}
                  />
                </label>
              </div>
            </>
          )}
          {brief.tripType === "round_trip" && brief.stayNights && (
            <div className="form-grid three">
              {(["minimum", "preferred", "maximum"] as const).map((key) => (
                <label key={key}>
                  {label(key)} nights
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={brief.stayNights![key]}
                    onChange={(event) => setBrief({
                      ...brief,
                      stayNights: { ...brief.stayNights!, [key]: Number(event.target.value) }
                    })}
                  />
                </label>
              ))}
            </div>
          )}
          <div className="form-grid two">
            <label>
              Cabin
              <select
                value={brief.cabin}
                onChange={(event) => setBrief({ ...brief, cabin: event.target.value })}
              >
                <option value="economy">Economy</option>
                <option value="premium_economy">Premium economy</option>
                <option value="business">Business</option>
                <option value="first">First</option>
              </select>
            </label>
            <label>
              Stops
              <select
                value={brief.maxStops}
                onChange={(event) => setBrief({ ...brief, maxStops: Number(event.target.value) })}
              >
                <option value={0}>Direct only</option>
                <option value={1}>Up to 1</option>
                <option value={2}>Up to 2</option>
              </select>
            </label>
          </div>
          <div className="form-grid two">
            <label>
              Currency
              <input
                value={brief.currency}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                onChange={(event) => setBrief({
                  ...brief,
                  currency: event.target.value.toUpperCase()
                })}
              />
            </label>
            <label>
              Maximum fare
              <input
                type="number"
                min={1}
                placeholder="None"
                value={brief.maximumPrice ?? ""}
                onChange={(event) => setBrief({
                  ...brief,
                  maximumPrice: event.target.value ? Number(event.target.value) : null
                })}
              />
            </label>
          </div>
          <label>
            Preferred airlines
            <AirlineSearchSelect
              values={brief.preferredAirlines}
              placeholder="Search airlines"
              onChange={(preferredAirlines) => setBrief({ ...brief, preferredAirlines })}
            />
          </label>
          <label>
            Avoid airlines
            <AirlineSearchSelect
              values={brief.excludedAirlines}
              placeholder="Search airlines to avoid"
              onChange={(excludedAirlines) => setBrief({ ...brief, excludedAirlines })}
            />
          </label>
          <label>
            Notes
            <textarea
              value={brief.context}
              maxLength={1000}
              placeholder="Timing or airport constraints"
              onChange={(event) => setBrief({ ...brief, context: event.target.value })}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="save-button" disabled={busy}>
            {busy ? "Saving…" : saved ? "Updated" : "Update trip"}
          </button>
        </form>
      </div>
    </details>
  );
}

function TravellerCard({
  tripId,
  assigned,
  sessionCredential,
  readOnly,
  onAssigned
}: {
  tripId: string;
  assigned: Passenger[];
  sessionCredential: boolean;
  readOnly: boolean;
  onAssigned: () => Promise<void>;
}) {
  const [available, setAvailable] = useState<Passenger[]>([]);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const traveller = assigned[0] ?? null;

  useEffect(() => {
    if (!sessionCredential) return;
    void listPassengers().then(setAvailable).catch(() => setAvailable([]));
  }, [sessionCredential]);

  if (!sessionCredential) {
    return (
      <section className="settings-card">
        <p className="eyebrow">Traveller</p>
        <p>Open Captain from Telegram to assign a traveller.</p>
      </section>
    );
  }

  return (
    <details className="settings-card settings-disclosure" open={!readOnly}>
      <summary>
        <span><strong>Traveller</strong></span>
        <em className={`traveller-state ${travellerStateTone(traveller)}`}>
          {travellerStateLabel(traveller, available.length)}
        </em>
      </summary>
      <div className="settings-body">
        {available.length === 0 ? (
          <p>
            <a className="quiet-link" href={travellerProfileHref(tripId, "new")}>Add a traveller</a>.
          </p>
        ) : traveller && (readOnly || !changing) ? (
          <>
            <a className="read-only-field" href={travellerProfileHref(tripId, traveller.id)}>
              <strong>{traveller.givenName} {traveller.familyName}</strong>
            </a>
            <div className="entity-row" style={{ marginTop: 16 }}>
              {!readOnly && (
                <button type="button" className="quiet-link" onClick={() => setChanging(true)}>
                  Change
                </button>
              )}
              <a className="quiet-link" href={travellerProfileHref(tripId, "new")}>Add</a>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const select = event.currentTarget.elements.namedItem("passengerId");
              const passengerId = select && "value" in select ? String(select.value) : "";
              if (!passengerId) return;
              void (async () => {
                setBusy(true);
                setError("");
                try {
                  await setTripTravellers(tripId, [passengerId]);
                  setChanging(false);
                  await onAssigned();
                } catch (cause) {
                  setError(cause instanceof ApiError ? cause.message : "Could not assign traveller.");
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <label>
              Flying on this trip
              <select
                name="passengerId"
                defaultValue={
                  traveller?.id
                  ?? available.find((passenger) => passenger.isDefault)?.id
                  ?? available[0]?.id
                }
              >
                {available.map((passenger) => (
                  <option key={passenger.id} value={passenger.id}>
                    {passenger.givenName} {passenger.familyName}
                    {passenger.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="save-button" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </form>
        )}
      </div>
    </details>
  );
}

function travellerStateLabel(traveller: Passenger | null, availableCount: number): string {
  if (!traveller) return availableCount === 0 ? "None" : "Empty";
  if (traveller.readyForBooking) return "Ready";
  return "Incomplete";
}

function travellerStateTone(traveller: Passenger | null): "ready" | "warn" | "quiet" {
  if (!traveller) return "quiet";
  if (traveller.readyForBooking) return "ready";
  return "warn";
}

function BookingCard({
  booking,
  onChange,
  onBack
}: {
  booking: MockBooking;
  onChange: (booking: MockBooking) => void;
  onBack: () => void;
}) {
  const cancelled = booking.status === "cancelled";
  return (
    <details className="settings-card settings-disclosure" open>
      <summary>
        <span><strong>Booking</strong></span>
        <em>{cancelled ? "Mock cancelled" : "Mock confirmed"}</em>
      </summary>
      <div className="settings-body">
        <dl className="settings-list">
          <div><dt>Reference</dt><dd>{booking.reference}</dd></div>
          <div><dt>Booked</dt><dd>{timestampLabel(booking.bookedAt)}</dd></div>
          <div>
            <dt>Fare</dt>
            <dd>{formatMoney(booking.offer.price, booking.offer.currency)}</dd>
          </div>
          <div><dt>Seat</dt><dd>{booking.seat ?? "None"}</dd></div>
          <div><dt>Bags</dt><dd>{booking.checkedBags}</dd></div>
        </dl>
        <div className="entity-row" style={{ marginTop: 16 }}>
          <button type="button" className="quiet-link" onClick={onBack}>Manage booking</button>
          {!cancelled && (
            <button
              type="button"
              className="quiet-link"
              onClick={() => {
                if (!window.confirm("Cancel this mock booking?")) return;
                onChange({ ...booking, status: "cancelled" });
              }}
            >
              Cancel booking
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
