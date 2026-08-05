import { useEffect, useState } from "react";

import type { ProfileTab } from "../api";
import type { TravellerProfile } from "../domain";
import { AccountPreferences } from "./AccountPreferences";
import { Payment } from "./Payment";
import { Travellers } from "./Travellers";

const tabs: ProfileTab[] = ["preferences", "travellers", "payment"];
const tabLabels: Record<ProfileTab, string> = {
  preferences: "Preferences",
  travellers: "Travellers",
  payment: "Card"
};

export function Profile({
  profile,
  displayName,
  sessionCredential,
  onSaved,
  onBack
}: {
  profile: TravellerProfile;
  displayName: string;
  /** Traveller records need a revocable cookie session, not a legacy bearer. */
  sessionCredential: boolean;
  onSaved: (profile: TravellerProfile) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<ProfileTab>(requestedTab);
  const [editingTraveller, setEditingTraveller] = useState(
    () => Boolean(new URLSearchParams(window.location.search).get("traveller"))
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    url.searchParams.delete("section");
    url.hash = window.location.hash.startsWith("#access=") ? window.location.hash : "";
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  return (
    <main className={`settings-shell${editingTraveller ? " is-traveller-editor" : ""}`}>
      {!editingTraveller && (
        <>
          <header className="topbar">
            <button className="back-link" onClick={onBack}>← Home</button>
            <span className="name">{displayName}</span>
          </header>

          <nav className="tabs" aria-label="Profile">
            {tabs.map((item) => (
              <button
                key={item}
                className={tab === item ? "active" : ""}
                onClick={() => setTab(item)}
              >
                {tabLabels[item]}
              </button>
            ))}
          </nav>
        </>
      )}

      {tab === "preferences" ? (
        <AccountPreferences profile={profile} onSaved={onSaved} />
      ) : tab === "payment" ? (
        <Payment />
      ) : !sessionCredential ? (
        <section className="settings-card">
          <h1>Secure setup</h1>
          <p>Open /profile from Captain on Telegram.</p>
        </section>
      ) : (
        <Travellers displayName={displayName} onEditingChange={setEditingTraveller} />
      )}
    </main>
  );
}

/** Honours `?tab=`, and the older `?section=` / `#payment` links still in Telegram history. */
function requestedTab(): ProfileTab {
  const search = new URLSearchParams(window.location.search);
  // Trip deep-links open a traveller editor; force the Travellers tab.
  if (search.get("traveller")) return "travellers";
  const requested = search.get("tab") ?? search.get("section") ?? window.location.hash.slice(1);
  if (tabs.includes(requested as ProfileTab)) return requested as ProfileTab;
  if (requested === "card" || requested === "invoices") return "payment";
  if (requested === "profiles") return "travellers";
  return "preferences";
}
