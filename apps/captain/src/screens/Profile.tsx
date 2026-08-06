import type { TravellerProfile } from "../domain";
import { AccountPreferences } from "./AccountPreferences";

/**
 * The whole account surface: how Captain notifies you, and how it ranks flights.
 * There is nothing else here — Captain tracks fares and never books them.
 */
export function Profile({
  profile,
  displayName,
  onSaved,
  onBack
}: {
  profile: TravellerProfile;
  displayName: string;
  onSaved: (profile: TravellerProfile) => void;
  onBack: () => void;
}) {
  return (
    <main className="settings-shell">
      <header className="topbar">
        <button className="back-link" onClick={onBack}>← Home</button>
        <span className="name">{displayName}</span>
      </header>
      <AccountPreferences profile={profile} onSaved={onSaved} />
    </main>
  );
}
