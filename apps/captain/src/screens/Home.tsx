import { profileHref, tripHref } from "../api";
import type { Trip } from "../domain";
import { dateRangeLabel, label } from "../format";
import { inPageLink } from "../navigation";

export function Home({
  trips,
  displayName,
  onNavigate
}: {
  trips: Trip[];
  displayName: string;
  onNavigate: (href: string) => void;
}) {
  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand" aria-label="Captain home">
          <span className="brand-mark">C</span>
          <span>Captain</span>
        </span>
        <div className="top-actions">
          <a
            className="quiet-link"
            href={profileHref()}
            onClick={inPageLink(profileHref(), onNavigate)}
          >
            {displayName || "Profile"}
          </a>
        </div>
      </header>

      {trips.length === 0 ? (
        // Two levels and nothing else. There is one thing to know here and one
        // thing to do, and a third line of explanation only buries both.
        <section className="empty-hero">
          <h1>Plan trips and track flight prices</h1>
          <p>Send your trip by text or voice note in Telegram</p>
        </section>
      ) : (
        <section className="trip-list" aria-label="Your trips">
          {trips.map((trip) => (
            <a
              className="trip-list-item"
              key={trip.id}
              href={tripHref(trip.id)}
              onClick={inPageLink(tripHref(trip.id), onNavigate)}
            >
              <span>
                <strong>{trip.title}</strong>
                <small>
                  {dateRangeLabel(trip.brief.departureWindow.start, trip.brief.departureWindow.end)}
                </small>
              </span>
              <em>{label(trip.status)}</em>
            </a>
          ))}
        </section>
      )}
    </main>
  );
}
