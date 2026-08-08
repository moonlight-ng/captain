import type { TravellerProfile } from "../domain";
import { AccountPreferences } from "./AccountPreferences";

/** Flight-search preferences for manual leg searches. */
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
