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
      <LanguagePreferencesCard profile={profile} onSaved={onSaved} />
      <FlightPreferencesCard profile={profile} onSaved={onSaved} />
    </>
  );
}

const LANGUAGE_OPTIONS = [
  ["en", "English"], ["fr", "French"], ["es", "Spanish"], ["pt", "Portuguese"],
  ["de", "German"], ["it", "Italian"], ["nl", "Dutch"], ["ar", "Arabic"],
  ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["hi", "Hindi"],
  ["yo", "Yoruba"], ["sw", "Swahili"], ["tr", "Turkish"], ["ru", "Russian"],
  ["pl", "Polish"]
] as const;

function LanguagePreferencesCard({
  profile,
  onSaved
}: {
  profile: TravellerProfile;
  onSaved: (profile: TravellerProfile) => void;
}) {
  const [language, setLanguage] = useState(profile.preferredLanguage);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  async function save(preferredLanguage: string | null) {
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const updated = await updateProfile({ preferredLanguage });
      setLanguage(updated.preferredLanguage);
      onSaved(updated);
      setSaved(true);
    } catch {
      setError("Captain couldn’t save that language. Use a language tag such as en or fr.");
    } finally {
      setBusy(false);
    }
  }

  const currentName = LANGUAGE_OPTIONS.find(([tag]) => tag === profile.preferredLanguage)?.[1]
    ?? profile.preferredLanguage;
  return (
    <details className="settings-card settings-disclosure" open>
      <summary>
        <span><strong>Language</strong></span>
        <em>{profile.preferredLanguageSource === "default" ? "Automatic" : currentName}</em>
      </summary>
      <div className="settings-body">
        <form onSubmit={(event) => { event.preventDefault(); void save(language); }}>
          <label>
            Preferred language
            <input
              value={language}
              list="captain-languages"
              maxLength={35}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder="Search or enter a language tag"
            />
            <datalist id="captain-languages">
              {LANGUAGE_OPTIONS.map(([tag, name]) => (
                <option value={tag} key={tag}>{name}</option>
              ))}
            </datalist>
          </label>
          <p className="form-hint">
            {profile.preferredLanguageSource === "default"
              ? "English is used until Captain completes a conversation in another language."
              : `Captain will reply in ${currentName}.`}
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="settings-actions">
            <button className="save-button" disabled={busy}>
              {busy ? "Saving…" : saved ? "Saved" : "Save language"}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(null)}>
              Automatic detection
            </button>
          </div>
        </form>
      </div>
    </details>
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
