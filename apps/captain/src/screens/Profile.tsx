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
  payment: "Payment"
};

export function Profile({
  profile,
  displayName,
  sessionCredential,
  paymentsEnabled,
  onSaved,
  onBack
}: {
  profile: TravellerProfile;
  displayName: string;
  /** Traveller and card records need a revocable cookie session, not a legacy bearer. */
  sessionCredential: boolean;
  paymentsEnabled: boolean;
  onSaved: (profile: TravellerProfile) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<ProfileTab>(requestedTab);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    url.searchParams.delete("section");
    url.hash = window.location.hash.startsWith("#access=") ? window.location.hash : "";
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  return (
    <main className="settings-shell">
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

      {tab === "preferences" ? (
        <AccountPreferences profile={profile} onSaved={onSaved} />
      ) : !sessionCredential ? (
        <section className="settings-card">
          <h1>Secure setup</h1>
          <p>Open /profile from Captain on Telegram.</p>
        </section>
      ) : tab === "travellers" ? (
        <Travellers displayName={displayName} />
      ) : paymentsEnabled ? (
        <Payment />
      ) : (
        <section className="settings-card">
          <h1>Not available yet</h1>
          <p>Captain will let you know when payment is ready.</p>
        </section>
      )}
    </main>
  );
}

/** Honours `?tab=`, and the older `?section=` / `#payment` links still in Telegram history. */
function requestedTab(): ProfileTab {
  const search = new URLSearchParams(window.location.search);
  const requested = search.get("tab") ?? search.get("section") ?? window.location.hash.slice(1);
  if (tabs.includes(requested as ProfileTab)) return requested as ProfileTab;
  if (requested === "card" || requested === "invoices") return "payment";
  if (requested === "profiles") return "travellers";
  return "preferences";
}
