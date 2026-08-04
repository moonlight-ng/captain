import { useState } from "react";

import { Invoices } from "./Invoices";
import { Payment } from "./Payment";
import { Travellers } from "./Travellers";

type ProfileTab = "travellers" | "payment" | "invoices";

function initialTab(): ProfileTab {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("tab") ?? params.get("section");
  return requested === "payment" || requested === "invoices" ? requested : "travellers";
}

export function Profile({
  displayName,
  sessionCredential,
  paymentsEnabled,
  onBack
}: {
  displayName: string;
  sessionCredential: boolean;
  paymentsEnabled: boolean;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<ProfileTab>(initialTab);

  function selectTab(next: ProfileTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.pathname = "/profile";
    url.searchParams.set("tab", next);
    url.searchParams.delete("section");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <main className="settings-shell profile-shell">
      <header className="profile-header">
        <button type="button" className="back-link" onClick={onBack}>Back to trip</button>
        <h1>Profile</h1>
      </header>

      <nav className="tabs profile-tabs" aria-label="Profile sections">
        {(["travellers", "payment", "invoices"] as const).map((item) => (
          <button
            type="button"
            key={item}
            className={tab === item ? "active" : ""}
            aria-current={tab === item ? "page" : undefined}
            onClick={() => selectTab(item)}
          >
            {item === "payment" ? "Payment" : item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>

      <p className="profile-inline-notice">
        Prototype mode — booking buttons work as a preview only. No flight reservation or card charge is made.
      </p>

      <div className="profile-tab-panel">
        {!sessionCredential ? (
          <section className="profile-empty-state">
            <h2>Open Profile from Telegram</h2>
            <p>A secure session is required to manage traveller and payment details.</p>
          </section>
        ) : tab === "travellers" ? (
          <Travellers displayName={displayName} />
        ) : tab === "payment" ? (
          paymentsEnabled
            ? <Payment />
            : <section className="profile-empty-state"><h2>Cards are unavailable</h2><p>Payment setup is not enabled for this environment.</p></section>
        ) : (
          <Invoices />
        )}
      </div>
    </main>
  );
}
