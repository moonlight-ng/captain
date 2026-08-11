import { useEffect, useMemo, useState } from "react";

import { ApiError, getCanonicalFlight, homeHref, selectTripLegFlight } from "../api";
import type { CanonicalFlightPayload } from "../domain";
import { calendarDayOffset, formatMoney } from "../format";
import { inPageLink } from "../navigation";

type TripFlightContext = {
  tripId: string;
  legId: string;
  routeLabel: string;
  selected: boolean;
};

export function CanonicalFlightPage({
  flightKey,
  tripContext = null,
  onNavigate,
  onBack,
  onSelected
}: {
  flightKey: string;
  /** When opening via `/trip/:id/flight/:key`, the trip slot is known from the URL. */
  tripContext?: TripFlightContext | null;
  onNavigate: (href: string) => void;
  onBack: () => void;
  onSelected?: (legId: string, flightKey: string) => void;
}) {
  const [payload, setPayload] = useState<CanonicalFlightPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectError, setSelectError] = useState("");
  const [selectedOverride, setSelectedOverride] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setSelectError("");
    setSelectedOverride(null);
    void getCanonicalFlight(flightKey)
      .then((next) => {
        if (!cancelled) setPayload(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof ApiError && cause.status === 404
            ? "This flight is no longer available."
            : "Captain couldn’t load this flight.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [flightKey]);

  const offers = useMemo(
    () => [...(payload?.offers ?? [])].sort((left, right) => Number(left.priceAmount) - Number(right.priceAmount)),
    [payload?.offers]
  );

  const context = useMemo((): TripFlightContext | null => {
    const base = tripContext ?? payload?.context ?? null;
    if (!base) return null;
    if (selectedOverride === null) return base;
    return { ...base, selected: selectedOverride };
  }, [tripContext, payload?.context, selectedOverride]);

  async function chooseFlight() {
    if (!context || context.selected || selecting) return;
    setSelecting(true);
    setSelectError("");
    try {
      await selectTripLegFlight(context.legId, flightKey);
      setSelectedOverride(true);
      onSelected?.(context.legId, flightKey);
    } catch {
      setSelectError("Couldn’t select that flight. Try again.");
    } finally {
      setSelecting(false);
    }
  }

  if (loading) return <CanonicalState title="Loading flight…" detail="Checking the latest verified details." />;
  if (!payload) return <CanonicalState title="Flight unavailable" detail={error} onBack={onBack} />;

  const { flight } = payload;
  const first = flight.segments[0]!;
  const last = flight.segments.at(-1)!;
  const dayOffset = calendarDayOffset(first.departure, last.arrival);
  const canSelect = Boolean(context && !context.selected && offers.length > 0);
  return (
    <main className="shell canonical-flight-shell">
      <header className="topbar">
        <a className="brand" href={homeHref()} onClick={inPageLink(homeHref(), onNavigate)} aria-label="Captain home">
          <span className="brand-mark">C</span><span>Captain</span>
        </a>
        <button type="button" className="quiet-link" onClick={onBack}>Back</button>
      </header>

      <section className="canonical-flight-page">
        <header className="canonical-flight-heading">
          <h1>{flight.origin} → {flight.destination}</h1>
          <p>{longDate(flight.departureDate)} · {durationLabel(flight.durationMinutes)} · {stopLabel(flight.stops)}</p>
        </header>

        {context ? (
          <section className={`flight-select-card${context.selected ? " is-watching" : ""}`}>
            <div className="flight-select-copy">
              <span>{context.selected ? "Watching for" : "Add to trip"}</span>
              <p>
                {context.selected
                  ? "Captain is tracking this fare for the slot."
                  : "Select this flight into the slot to start watching its price."}
              </p>
            </div>
            <button
              type="button"
              className={`primary-action${context.selected ? " selected" : ""}`}
              disabled={context.selected || selecting || !canSelect}
              onClick={() => { void chooseFlight(); }}
            >
              {context.selected ? "Watching this flight" : selecting ? "Selecting…" : "Select & watch"}
            </button>
            {selectError ? <p className="canonical-select-error" role="alert">{selectError}</p> : null}
            {!context.selected && offers.length === 0
              ? <p className="canonical-select-hint">A verified price is required before Captain can watch this flight.</p>
              : null}
          </section>
        ) : null}

        <section className="canonical-schedule" aria-labelledby="flight-schedule-heading">
          <div className="section-title-row">
            <h2 id="flight-schedule-heading">Flight schedule</h2>
            <span>{flight.primaryAirlineCode} · {stopLabel(flight.stops)}</span>
          </div>
          <div
            className="canonical-route"
            aria-label={`${first.origin} to ${last.destination}`}
          >
            <div className="flight-card-endpoint">
              <strong>{clock(first.departure)}</strong>
              <span>{first.origin}</span>
            </div>
            <div className="flight-card-path" aria-hidden="true">
              <span>{durationLabel(flight.durationMinutes)}</span>
              <i />
              <span>{stopLabel(flight.stops)}</span>
            </div>
            <div className="flight-card-endpoint is-arrival">
              <strong>
                {clock(last.arrival)}
                {dayOffset > 0 ? <sup>+{dayOffset}</sup> : null}
              </strong>
              <span>{last.destination}</span>
            </div>
          </div>
          <ol className="canonical-segments">
            {flight.segments.map((segment, index) => (
              <li key={`${segment.flightNumber}-${segment.departure}`}>
                <span className="segment-index">{index + 1}</span>
                <div>
                  <strong>{segment.origin} → {segment.destination}</strong>
                  <p>{segment.marketingAirline} · {segment.flightNumber}</p>
                  <small>{dateTime(segment.departure)} → {dateTime(segment.arrival)}</small>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="canonical-offers" aria-labelledby="verified-prices-heading">
          <h2 id="verified-prices-heading">Verified prices</h2>
          {offers.length > 0 ? (
            <ul className="canonical-offer-list">
              {offers.map((offer) => {
                const expired = offer.expiresAt !== null && Date.parse(offer.expiresAt) <= Date.now();
                return (
                  <li className={expired ? "expired" : undefined} key={offer.offerId}>
                    <strong>{formatMoney(Number(offer.priceAmount), offer.currency)}</strong>
                    <span>{providerLabel(offer.provider)}{expired ? " · Expired" : ""}</span>
                    <time dateTime={offer.observedAt}>{dateTime(offer.observedAt)}</time>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="canonical-no-offers">No current seller price is available for this schedule.</p>
          )}
        </section>

        {!tripContext ? (
          <p className="canonical-privacy">This shared page contains flight and seller information only. Personal trip details are never included.</p>
        ) : null}
      </section>
    </main>
  );
}

function CanonicalState({ title, detail, onBack }: { title: string; detail: string; onBack?: () => void }) {
  return (
    <main className="centered">
      <span className="brand-mark">C</span>
      <h1>{title}</h1>
      <p>{detail}</p>
      {onBack ? <button type="button" className="primary-action" onClick={onBack}>Go back</button> : null}
    </main>
  );
}

function providerLabel(provider: string): string {
  return provider
    .replace(/^official_/u, "")
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function longDate(value: string): string {
  return new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T12:00:00Z`));
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    .format(new Date(value));
}

function clock(value: string): string {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours > 0 ? `${hours}h ` : ""}${remainder}m`;
}

function stopLabel(stops: number): string {
  return stops === 0 ? "Nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`;
}
