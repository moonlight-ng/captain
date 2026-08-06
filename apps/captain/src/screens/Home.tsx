import { profileHref, tripHref } from "../api";
import type { Trip } from "../domain";
import { dateRangeLabel, label, routeLabel } from "../format";

export function Home({ trips, displayName }: { trips: Trip[]; displayName: string }) {
  return (
    <main className="shell">
      <header className="topbar">
        <span className="brand" aria-label="Captain home">
          <span className="brand-mark">C</span>
          <span>Captain</span>
        </span>
        <div className="top-actions">
          <a className="quiet-link" href={profileHref()}>{displayName || "Profile"}</a>
        </div>
      </header>

      {trips.length === 0 ? (
        <section className="empty-hero">
          <p className="eyebrow">No trips</p>
          <h1>Tell Captain where you want to go.</h1>
          <p>Create a trip from Telegram. Captain tracks one trip at a time.</p>
        </section>
      ) : (
        <section className="trip-list" aria-label="Your trips">
          {trips.map((trip) => (
            <a className="trip-list-item" key={trip.id} href={tripHref(trip.id)}>
              <span>
                <strong>{routeLabel(trip)}</strong>
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
