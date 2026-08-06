import { useState, type FormEvent } from "react";

import { updateProfile } from "../api";
import type { RankingMode, TravellerProfile } from "../domain";
import { label } from "../format";
import { AirlineSearchSelect } from "../components/AirlineSearchSelect";

export function AccountPreferences({
  profile,
  onSaved
}: {
  profile: TravellerProfile;
  onSaved: (profile: TravellerProfile) => void;
}) {
  return (
    <>
      <NotificationsCard profile={profile} onSaved={onSaved} />
      <FlightPreferencesCard profile={profile} onSaved={onSaved} />
    </>
  );
}

/** Every PATCH sends the whole preference set, so each form starts from the saved profile. */
function saveProfile(
  profile: TravellerProfile,
  changes: Partial<TravellerProfile>
): Promise<TravellerProfile> {
  const next = { ...profile, ...changes };
  return updateProfile({
    defaultCurrency: next.defaultCurrency.toUpperCase(),
    timeZone: next.timeZone,
    rankingMode: next.rankingMode,
    preferredAirlineCodes: next.preferredAirlineCodes.slice(0, 12),
    excludedAirlineCodes: next.excludedAirlineCodes.slice(0, 12),
    alertsEnabled: next.notificationMode !== "off",
    notificationMode: next.notificationMode,
    digestHourLocal: next.digestHourLocal,
    priceRiseAlertsEnabled: next.priceRiseAlertsEnabled,
    betterOptionAlertsEnabled: next.betterOptionAlertsEnabled,
    maxAlertsPerDay: next.maxAlertsPerDay,
    quietHoursEnabled: next.quietHoursEnabled,
    quietHoursStart: next.quietHoursStart,
    quietHoursEnd: next.quietHoursEnd
  });
}

function NotificationsCard({
  profile,
  onSaved
}: {
  profile: TravellerProfile;
  onSaved: (profile: TravellerProfile) => void;
}) {
  const [mode, setMode] = useState(profile.notificationMode);
  const [digestHour, setDigestHour] = useState(profile.digestHourLocal);
  const [priceRise, setPriceRise] = useState(profile.priceRiseAlertsEnabled);
  const [betterOption, setBetterOption] = useState(profile.betterOptionAlertsEnabled);
  const [maxAlerts, setMaxAlerts] = useState<1 | 2>(profile.maxAlertsPerDay);
  const [quietEnabled, setQuietEnabled] = useState(profile.quietHoursEnabled);
  const [quietStart, setQuietStart] = useState(profile.quietHoursStart);
  const [quietEnd, setQuietEnd] = useState(profile.quietHoursEnd);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      onSaved(await saveProfile(profile, {
        notificationMode: mode,
        digestHourLocal: digestHour,
        priceRiseAlertsEnabled: priceRise,
        betterOptionAlertsEnabled: betterOption,
        maxAlertsPerDay: maxAlerts,
        quietHoursEnabled: quietEnabled,
        quietHoursStart: quietStart,
        quietHoursEnd: quietEnd
      }));
      setSaved(true);
    } catch {
      setError("Captain couldn’t save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="settings-card settings-disclosure">
      <summary>
        <span><strong>Notifications</strong></span>
        <em>{notificationModeLabel(mode)}</em>
      </summary>
      <div className="settings-body">
        <form onSubmit={(event) => void save(event)}>
          <label>
            Mode
            <select
              value={mode}
              onChange={(event) => setMode(
                event.target.value as TravellerProfile["notificationMode"]
              )}
            >
              <option value="smart">Smart</option>
              <option value="daily">Daily</option>
              <option value="changes_only">Changes only</option>
              <option value="off">Off</option>
            </select>
            <small>{notificationModeDescription(mode)}</small>
          </label>
          <label>
            Daily update
            <input
              type="time"
              step={3600}
              disabled={!["smart", "daily"].includes(mode)}
              value={`${String(digestHour).padStart(2, "0")}:00`}
              onChange={(event) => setDigestHour(Number(event.target.value.slice(0, 2)))}
            />
          </label>
          <label className="switch-setting">
            <span><strong>Price rises</strong></span>
            <input
              type="checkbox"
              role="switch"
              disabled={mode === "off"}
              checked={priceRise}
              onChange={(event) => setPriceRise(event.target.checked)}
            />
          </label>
          <label className="switch-setting">
            <span><strong>Better options</strong></span>
            <input
              type="checkbox"
              role="switch"
              disabled={mode === "off"}
              checked={betterOption}
              onChange={(event) => setBetterOption(event.target.checked)}
            />
          </label>
          <label>
            Immediate alert limit
            <select
              value={maxAlerts}
              disabled={mode === "off"}
              onChange={(event) => setMaxAlerts(Number(event.target.value) as 1 | 2)}
            >
              <option value={1}>1 in 24 hours</option>
              <option value={2}>2 in 24 hours</option>
            </select>
          </label>
          <label className="switch-setting">
            <span><strong>Quiet hours</strong></span>
            <input
              type="checkbox"
              role="switch"
              checked={quietEnabled}
              onChange={(event) => setQuietEnabled(event.target.checked)}
            />
          </label>
          <div className="form-grid two">
            <label>
              From
              <input
                type="time"
                step={3600}
                disabled={!quietEnabled}
                value={`${String(quietStart).padStart(2, "0")}:00`}
                onChange={(event) => setQuietStart(Number(event.target.value.slice(0, 2)))}
              />
            </label>
            <label>
              Until
              <input
                type="time"
                step={3600}
                disabled={!quietEnabled}
                value={`${String(quietEnd).padStart(2, "0")}:00`}
                onChange={(event) => setQuietEnd(Number(event.target.value.slice(0, 2)))}
              />
            </label>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="save-button" disabled={busy}>
            {busy ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
        </form>
      </div>
    </details>
  );
}

function FlightPreferencesCard({
  profile,
  onSaved
}: {
  profile: TravellerProfile;
  onSaved: (profile: TravellerProfile) => void;
}) {
  const [currency, setCurrency] = useState(profile.defaultCurrency);
  const [timeZone, setTimeZone] = useState(profile.timeZone);
  const [ranking, setRanking] = useState(profile.rankingMode);
  const [preferred, setPreferred] = useState<string[]>(profile.preferredAirlineCodes);
  const [excluded, setExcluded] = useState<string[]>(profile.excludedAirlineCodes);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      onSaved(await saveProfile(profile, {
        defaultCurrency: currency,
        timeZone,
        rankingMode: ranking,
        preferredAirlineCodes: preferred,
        excludedAirlineCodes: excluded
      }));
      setSaved(true);
    } catch {
      setError("Captain couldn’t save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="settings-card settings-disclosure">
      <summary>
        <span><strong>Flights</strong></span>
        <em>{label(ranking)}</em>
      </summary>
      <div className="settings-body">
        <form onSubmit={(event) => void save(event)}>
          <div className="form-grid two">
            <label>
              Currency
              <input
                value={currency}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                onChange={(event) => setCurrency(event.target.value)}
              />
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
            </label>
          </div>
          <fieldset>
            <legend>Ranking</legend>
            <div className="ranking-options">
              {(["cheapest", "balanced", "fastest"] as RankingMode[]).map((mode) => (
                <label className={ranking === mode ? "checked" : ""} key={mode}>
                  <input
                    type="radio"
                    name="ranking"
                    checked={ranking === mode}
                    onChange={() => setRanking(mode)}
                  />
                  <strong>{label(mode)}</strong>
                  <span>{mode === "balanced"
                    ? "Fare, time and stops"
                    : mode === "cheapest" ? "Lowest fare" : "Shortest journey"}</span>
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
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="save-button" disabled={busy}>
            {busy ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
        </form>
      </div>
    </details>
  );
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
    smart: "A daily update, plus important changes sooner near departure.",
    daily: "One update each active day.",
    changes_only: "Only meaningful changes.",
    off: "Track silently."
  })[mode];
}
