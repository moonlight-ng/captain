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
  return <FlightPreferencesCard profile={profile} onSaved={onSaved} />;
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
    priceRiseAlertsEnabled: next.priceRiseAlertsEnabled,
    betterOptionAlertsEnabled: next.betterOptionAlertsEnabled,
    maxAlertsPerDay: next.maxAlertsPerDay,
    quietHoursEnabled: next.quietHoursEnabled,
    quietHoursStart: next.quietHoursStart,
    quietHoursEnd: next.quietHoursEnd
  });
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
    <details className="settings-card settings-disclosure" open>
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
