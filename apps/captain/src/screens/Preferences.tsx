import { useState, type FormEvent } from "react";

import {
  ApiError,
  tripAction,
  updateProfile,
  updateTripBrief
} from "../api";
import type {
  RankingMode,
  TravellerProfile,
  TripPayload
} from "../domain";
import {
  activityLabel,
  dateLabel,
  dateRangeLabel,
  label,
  relativeTime,
  routeLabel,
  scheduleTime,
  timestampLabel
} from "../format";
import { AirlineSearchSelect } from "../components/AirlineSearchSelect";

export function Preferences({
  profile,
  tripData,
  displayName,
  trackingError,
  onSaved,
  onTripChanged,
  onTripError,
  onBack
}: {
  profile: TravellerProfile;
  tripData: TripPayload | null;
  displayName: string;
  trackingError: string;
  onSaved: (profile: TravellerProfile) => void;
  onTripChanged: () => Promise<void>;
  onTripError: (value: string) => void;
  onBack: () => void;
}) {
  const [currency, setCurrency] = useState(profile.defaultCurrency);
  const [timeZone, setTimeZone] = useState(profile.timeZone);
  const [ranking, setRanking] = useState(profile.rankingMode);
  const [preferred, setPreferred] = useState<string[]>(profile.preferredAirlineCodes);
  const [excluded, setExcluded] = useState<string[]>(profile.excludedAirlineCodes);
  const [notificationMode, setNotificationMode] = useState(profile.notificationMode);
  const [digestHour, setDigestHour] = useState(profile.digestHourLocal);
  const [priceRiseAlerts, setPriceRiseAlerts] = useState(profile.priceRiseAlertsEnabled);
  const [betterOptionAlerts, setBetterOptionAlerts] = useState(profile.betterOptionAlertsEnabled);
  const [trackingCheckins, setTrackingCheckins] = useState(profile.trackingCheckinsEnabled);
  const [maxAlerts, setMaxAlerts] = useState<1 | 2>(profile.maxAlertsPerDay);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(profile.quietHoursEnabled);
  const [quietStart, setQuietStart] = useState(profile.quietHoursStart);
  const [quietEnd, setQuietEnd] = useState(profile.quietHoursEnd);
  const [brief, setBrief] = useState(() => {
    const current = tripData?.trip?.brief;
    if (!current) return null;
    return {
      ...current,
      context: /^Prepared from confirmed Captain trip draft\b/iu.test(current.context)
        ? ""
        : current.context
    };
  });
  const [tripStopped, setTripStopped] = useState(false);
  const [saved, setSaved] = useState<"preferences" | "notifications" | "brief" | "">("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const airportCodes = (value: string) => [...new Set(
    value.toUpperCase().match(/[A-Z]{3}/gu) ?? []
  )].slice(0, 6);
  async function saveProfile(
    event: FormEvent,
    section: "preferences" | "notifications"
  ) {
    event.preventDefault();
    setBusy(true);
    setSaved("");
    setSaveError("");
    try {
      const next = await updateProfile({
        defaultCurrency: currency.toUpperCase(),
        timeZone,
        rankingMode: ranking,
        preferredAirlineCodes: preferred.slice(0, 12),
        excludedAirlineCodes: excluded.slice(0, 12),
        alertsEnabled: notificationMode !== "off",
        notificationMode,
        digestHourLocal: digestHour,
        priceRiseAlertsEnabled: priceRiseAlerts,
        betterOptionAlertsEnabled: betterOptionAlerts,
        trackingCheckinsEnabled: trackingCheckins,
        maxAlertsPerDay: maxAlerts,
        quietHoursEnabled,
        quietHoursStart: quietStart,
        quietHoursEnd: quietEnd
      });
      onSaved(next);
      setSaved(section);
    } catch {
      setSaveError("Captain couldn’t save these settings. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function saveBrief(event: FormEvent) {
    event.preventDefault();
    const trip = tripData?.trip;
    if (!trip || !brief) return;
    setBusy(true);
    setSaved("");
    setSaveError("");
    try {
      await updateTripBrief(trip.id, trip.version, brief);
      setSaved("brief");
      await onTripChanged();
    } catch (cause) {
      setSaveError(cause instanceof ApiError && cause.status === 409
        ? "This trip changed elsewhere. Reload it from Telegram before editing."
        : "Captain couldn’t update this trip brief. Check the fields and try again.");
    } finally {
      setBusy(false);
    }
  }
  const trip = tripStopped ? null : tripData?.trip ?? null;
  const watch = tripStopped ? null : tripData?.watch ?? null;
  return (
    <main className="settings-shell">
      <header className="topbar">
        {tripStopped
          ? <span className="back-link inactive">Trip stopped</span>
          : <button className="back-link" onClick={onBack}>← Trip</button>}
        <span className="name">{displayName}</span>
      </header>
      <section className="settings-intro">
        <h1>{trip ? routeLabel(trip) : "Captain"}</h1>
        <p>{trip
          ? dateRangeLabel(trip.brief.departureWindow.start, trip.brief.departureWindow.end)
          : "Trip tracking has stopped. Choose another trip from Telegram."}</p>
      </section>
      {trip && tripData && (
        <details className="settings-card settings-disclosure" open>
          <summary>
            <span><strong>Tracking</strong></span>
            <em>{trackingStateLabel(watch, trip)}</em>
          </summary>
          <div className="settings-body tracking-settings">
            <dl className="settings-list">
              <div><dt>Last check</dt><dd>{watch?.lastCheckAt ? relativeTime(watch.lastCheckAt) : "Not checked yet"}</dd></div>
              <div>
                <dt>{watch?.status === "scheduled" ? "Tracking starts" : "Next check"}</dt>
                <dd>{watch?.nextCheckAt ? scheduleTime(watch.nextCheckAt) : "Not scheduled"}</dd>
              </div>
              <div><dt>Flights</dt><dd>{tripData.offers.length}</dd></div>
            </dl>
            <p>Captain checks more often as departure approaches. You can also refresh manually anytime.</p>
            {trackingError && <p className="form-error" role="alert">{trackingError}</p>}
            <TripControls
              data={tripData}
              onChanged={onTripChanged}
              onCancelled={() => setTripStopped(true)}
              onError={onTripError}
            />
          </div>
        </details>
      )}
      {trip && brief && (
        <details className="settings-card settings-disclosure">
          <summary>
            <span><strong>Trip brief</strong></span>
            <em>{dateLabel(brief.departureWindow.start)}</em>
          </summary>
          <div className="settings-body">
            <p>Editing the brief starts a fresh verified search for this trip.</p>
            <form onSubmit={(event) => void saveBrief(event)}>
              {brief.tripType === "multi_city" ? (
                <div className="read-only-field">
                  <span>Route</span>
                  <strong>{routeLabel(trip)}</strong>
                  <small>Change multi-city routes in Telegram.</small>
                </div>
              ) : (
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
              )}
              {brief.tripType !== "multi_city" && (
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
                          stayNights: {
                            ...brief.stayNights!,
                            [key]: Number(event.target.value)
                          }
                        })}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="form-grid two">
                <label>
                  Cabin
                  <select value={brief.cabin} onChange={(event) => setBrief({
                    ...brief,
                    cabin: event.target.value
                  })}>
                    <option value="economy">Economy</option>
                    <option value="premium_economy">Premium economy</option>
                    <option value="business">Business</option>
                    <option value="first">First</option>
                  </select>
                </label>
                <label>
                  Stops
                  <select value={brief.maxStops} onChange={(event) => setBrief({
                    ...brief,
                    maxStops: Number(event.target.value)
                  })}>
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
                    placeholder="No maximum"
                    value={brief.maximumPrice ?? ""}
                    onChange={(event) => setBrief({
                      ...brief,
                      maximumPrice: event.target.value ? Number(event.target.value) : null
                    })}
                  />
                </label>
              </div>
              <label>
                Preferred airlines for this trip
                <AirlineSearchSelect
                  values={brief.preferredAirlines}
                  placeholder="Search airlines"
                  onChange={(preferredAirlines) => setBrief({ ...brief, preferredAirlines })}
                />
              </label>
              <label>
                Avoid airlines for this trip
                <AirlineSearchSelect
                  values={brief.excludedAirlines}
                  placeholder="Search airlines to avoid"
                  onChange={(excludedAirlines) => setBrief({ ...brief, excludedAirlines })}
                />
              </label>
              <label>
                Notes for Captain
                <textarea
                  value={brief.context}
                  maxLength={1000}
                  placeholder="Timing or airport constraints"
                  onChange={(event) => setBrief({ ...brief, context: event.target.value })}
                />
              </label>
              {saveError && <p className="form-error" role="alert">{saveError}</p>}
              <button className="save-button" disabled={busy}>
                {busy ? "Saving…" : saved === "brief" ? "Trip updated" : "Update trip"}
              </button>
            </form>
          </div>
        </details>
      )}
      <details className="settings-card settings-disclosure">
        <summary>
          <span><strong>Notifications</strong></span>
          <em>{notificationModeLabel(notificationMode)}</em>
        </summary>
        <div className="settings-body">
          <form onSubmit={(event) => void saveProfile(event, "notifications")}>
            <label>
              Notification mode
              <select
                value={notificationMode}
                onChange={(event) => setNotificationMode(
                  event.target.value as TravellerProfile["notificationMode"]
                )}
              >
                <option value="smart">Smart</option>
                <option value="daily">Daily</option>
                <option value="changes_only">Changes only</option>
                <option value="off">Off</option>
              </select>
              <small>{notificationModeDescription(notificationMode)}</small>
            </label>
            <label>
              Daily update time
              <input
                type="time"
                step={3600}
                disabled={!["smart", "daily"].includes(notificationMode)}
                value={`${String(digestHour).padStart(2, "0")}:00`}
                onChange={(event) => setDigestHour(Number(event.target.value.slice(0, 2)))}
              />
            </label>
            <label className="switch-setting">
              <span><strong>Price rise alerts</strong><small>Warn when the watched option rises meaningfully.</small></span>
              <input
                type="checkbox"
                role="switch"
                disabled={notificationMode === "off"}
                checked={priceRiseAlerts}
                onChange={(event) => setPriceRiseAlerts(event.target.checked)}
              />
            </label>
            <label className="switch-setting">
              <span><strong>Better option alerts</strong><small>Tell me when Captain finds a meaningfully better flight.</small></span>
              <input
                type="checkbox"
                role="switch"
                disabled={notificationMode === "off"}
                checked={betterOptionAlerts}
                onChange={(event) => setBetterOptionAlerts(event.target.checked)}
              />
            </label>
            <label className="switch-setting">
              <span><strong>Tracking check-ins</strong><small>Ask after seven quiet days before pausing.</small></span>
              <input
                type="checkbox"
                role="switch"
                disabled={notificationMode === "off"}
                checked={trackingCheckins}
                onChange={(event) => setTrackingCheckins(event.target.checked)}
              />
            </label>
            <label>
              Immediate alert limit
              <select
                value={maxAlerts}
                disabled={notificationMode === "off"}
                onChange={(event) => setMaxAlerts(Number(event.target.value) as 1 | 2)}
              >
                <option value={1}>1 in 24 hours</option>
                <option value={2}>2 in 24 hours</option>
              </select>
            </label>
            <label className="switch-setting">
              <span><strong>Quiet hours</strong><small>Hold Telegram fare alerts during this window.</small></span>
              <input
                type="checkbox"
                role="switch"
                checked={quietHoursEnabled}
                onChange={(event) => setQuietHoursEnabled(event.target.checked)}
              />
            </label>
            <div className="form-grid two">
              <label>
                From
                <input
                  type="time"
                  step={3600}
                  disabled={!quietHoursEnabled}
                  value={`${String(quietStart).padStart(2, "0")}:00`}
                  onChange={(event) => setQuietStart(Number(event.target.value.slice(0, 2)))}
                />
              </label>
              <label>
                Until
                <input
                  type="time"
                  step={3600}
                  disabled={!quietHoursEnabled}
                  value={`${String(quietEnd).padStart(2, "0")}:00`}
                  onChange={(event) => setQuietEnd(Number(event.target.value.slice(0, 2)))}
                />
              </label>
            </div>
            {saveError && <p className="form-error" role="alert">{saveError}</p>}
            <button className="save-button" disabled={busy}>
              {busy ? "Saving…" : saved === "notifications" ? "Saved" : "Save notifications"}
            </button>
          </form>
        </div>
      </details>
      <details className="settings-card settings-disclosure">
        <summary>
          <span><strong>Flight preferences</strong></span>
          <em>{label(ranking)}</em>
        </summary>
        <div className="settings-body">
          <form onSubmit={(event) => void saveProfile(event, "preferences")}>
          <label>
            Default currency
            <input value={currency} maxLength={3} pattern="[A-Za-z]{3}" onChange={(event) => setCurrency(event.target.value)} />
            <small>Captain never converts a fare between currencies.</small>
          </label>
          <label>
            Timezone
            <input
              value={timeZone}
              list="captain-timezones"
              onChange={(event) => setTimeZone(event.target.value)}
            />
            <datalist id="captain-timezones">
              <option value="Africa/Lagos" />
              <option value="Africa/Dar_es_Salaam" />
              <option value="Europe/London" />
              <option value="America/New_York" />
              <option value="UTC" />
            </datalist>
            <small>Used to resolve “today”, “tomorrow”, and weekdays in Telegram.</small>
          </label>
          <fieldset>
            <legend>How should Captain rank flights?</legend>
            <div className="ranking-options">
              {(["cheapest", "balanced", "fastest"] as RankingMode[]).map((mode) => (
                <label className={ranking === mode ? "checked" : ""} key={mode}>
                  <input type="radio" name="ranking" checked={ranking === mode} onChange={() => setRanking(mode)} />
                  <strong>{label(mode)}</strong>
                  <span>{mode === "balanced" ? "Fare, time and stops" : mode === "cheapest" ? "Lowest verified fare" : "Shortest journey"}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Preferred airlines
            <AirlineSearchSelect
              values={preferred}
              placeholder="Search airlines"
              onChange={setPreferred}
            />
          </label>
          <label>
            Avoid airlines
            <AirlineSearchSelect
              values={excluded}
              placeholder="Search airlines to avoid"
              onChange={setExcluded}
            />
            <small>Any itinerary using an avoided airline is removed.</small>
          </label>
          {saveError && <p className="form-error" role="alert">{saveError}</p>}
          <button className="save-button" disabled={busy}>
            {busy ? "Saving…" : saved === "preferences" ? "Saved" : "Save preferences"}
          </button>
        </form>
        </div>
      </details>
      {trip && (
        <details className="settings-card settings-disclosure">
          <summary>
            <span><strong>Activity</strong></span>
            <em>{tripData?.activity.length ?? 0}</em>
          </summary>
          <div className="settings-body">
            {(tripData?.activity.length ?? 0) > 0 ? (
              <div className="activity-list">
                {tripData!.activity.map((item) => (
                  <article key={item.id}>
                    <i />
                    <span>
                      <strong>{activityLabel(item.eventType)}</strong>
                      <small>{timestampLabel(item.createdAt)}</small>
                    </span>
                  </article>
                ))}
              </div>
            ) : <p>Activity appears here as Captain works.</p>}
          </div>
        </details>
      )}
    </main>
  );
}

function TripControls({
  data,
  onChanged,
  onCancelled,
  onError
}: {
  data: TripPayload;
  onChanged: () => Promise<void>;
  onCancelled: () => void;
  onError: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const trip = data.trip!;
  async function act(type: "pause" | "resume" | "refresh" | "cancel") {
    setBusy(true);
    onError("");
    try {
      await tripAction(type, trip.id, trip.version);
      if (type === "cancel") {
        onCancelled();
        return;
      }
      await onChanged();
    } catch {
      onError("That action didn’t complete. Reload and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="trip-controls">
      <button disabled={busy} onClick={() => void act(trip.status === "paused" ? "resume" : "pause")}>
        {trip.status === "paused" ? "Resume" : "Pause"}
      </button>
      <button className="primary" disabled={busy || trip.status === "paused"} onClick={() => void act("refresh")}>
        Refresh
      </button>
      <button
        className="danger"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Stop tracking ${routeLabel(trip)}?`)) void act("cancel");
        }}
      >
        Stop
      </button>
    </div>
  );
}

function trackingStateLabel(
  watch: TripPayload["watch"] | null,
  trip: NonNullable<TripPayload["trip"]>
): string {
  if (trip.status === "paused" || watch?.status === "paused") return "Paused";
  if (watch?.status === "scheduled" && watch.trackingStartsAt) {
    return `Scheduled — starts ${dateLabel(watch.trackingStartsAt.slice(0, 10))}`;
  }
  return "Active";
}

function notificationModeLabel(mode: TravellerProfile["notificationMode"]): string {
  return ({
    smart: "Smart",
    daily: "Daily",
    changes_only: "Changes only",
    off: "Off"
  })[mode];
}

function notificationModeDescription(mode: TravellerProfile["notificationMode"]): string {
  return ({
    smart: "One useful daily update while active, with important changes sooner near departure.",
    daily: "One combined update every active day.",
    changes_only: "Only baselines, activations, and meaningful changes.",
    off: "Keep tracking silently without Telegram updates."
  })[mode];
}
