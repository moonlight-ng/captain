import { useEffect, useMemo, useState } from "react";

import { ApiError, getCanonicalFlight, homeHref, selectTripLegFlight, tripLegHref } from "../api";
import type { CanonicalFlightPayload, FlightOfferSnapshot } from "../domain";
import { formatMoney } from "../format";
import { inPageLink } from "../navigation";

export function CanonicalFlightPage({
  flightKey,
  onNavigate,
  onBack
}: {
  flightKey: string;
  onNavigate: (href: string) => void;
  onBack: () => void;
}) {
  const [payload, setPayload] = useState<CanonicalFlightPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectError, setSelectError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setSelectError("");
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

  function goToLeg() {
    const context = payload?.context;
    if (context) {
      onNavigate(tripLegHref(context.tripId, context.legId));
      return;
    }
    onBack();
  }

  async function chooseFlight() {
    const context = payload?.context;
    if (!context || context.selected || selecting) return;
    setSelecting(true);
    setSelectError("");
    try {
      await selectTripLegFlight(context.legId, flightKey);
      setPayload((current) => current?.context
        ? { ...current, context: { ...current.context, selected: true } }
        : current);
    } catch {
      setSelectError("Couldn’t select that flight. Try again.");
    } finally {
      setSelecting(false);
    }
  }

  if (loading) return <CanonicalState title="Loading flight…" detail="Checking the latest verified details." />;
  if (!payload) return <CanonicalState title="Flight unavailable" detail={error} onBack={onBack} />;

  const { flight, context } = payload;
  const first = flight.segments[0]!;
  const last = flight.segments.at(-1)!;
  const canSelect = Boolean(context && !context.selected && offers.length > 0);
  return (
    <main className="shell canonical-flight-shell">
      <header className="topbar">
        <a className="brand" href={homeHref()} onClick={inPageLink(homeHref(), onNavigate)} aria-label="Captain home">
          <span className="brand-mark">C</span><span>Captain</span>
        </a>
        <button type="button" className="quiet-link" onClick={goToLeg}>Back</button>
      </header>

      <section className="canonical-flight-page">
        <header className="canonical-flight-heading">
          <h1>{flight.origin} → {flight.destination}</h1>
          <p>{longDate(flight.departureDate)} · {durationLabel(flight.durationMinutes)} · {stopLabel(flight.stops)}</p>
        </header>

        {context ? (
          <a
            className="flight-context"
            href={tripLegHref(context.tripId, context.legId)}
            onClick={inPageLink(tripLegHref(context.tripId, context.legId), onNavigate)}
          >
            <span>{context.selected ? "Selected for" : "Option for"}</span>
            <strong>{context.routeLabel}</strong>
            <em>View leg →</em>
          </a>
        ) : null}

        {context ? (
          <div className="canonical-flight-action">
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
          </div>
        ) : null}

        <section className="canonical-schedule" aria-labelledby="flight-schedule-heading">
          <div className="section-title-row">
            <h2 id="flight-schedule-heading">Flight schedule</h2>
            <span>{flight.primaryAirlineCode}</span>
          </div>
          <div className="canonical-summary-time">
            <strong>{clock(first.departure)} <small>{first.origin}</small></strong>
            <span>{durationLabel(flight.durationMinutes)}</span>
            <strong>{clock(last.arrival)} <small>{last.destination}</small></strong>
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
          <div className="section-title-row">
            <h2 id="verified-prices-heading">Verified prices</h2>
            <span>{offers.length} seller{offers.length === 1 ? "" : "s"}</span>
          </div>
          {offers.length > 0 ? offers.map((offer) => <OfferSource key={offer.offerId} offer={offer} />) : (
            <p className="canonical-no-offers">No current seller price is available for this schedule.</p>
          )}
        </section>

        <p className="canonical-privacy">This shared page contains flight and seller information only. Personal trip details are never included.</p>
      </section>
    </main>
  );
}

function OfferSource({ offer }: { offer: FlightOfferSnapshot }) {
  const source = offer.evidence[0];
  const expired = offer.expiresAt !== null && Date.parse(offer.expiresAt) <= Date.now();
  return (
    <article className={`canonical-offer${expired ? " expired" : ""}`}>
      <div>
        <strong>{formatMoney(Number(offer.priceAmount), offer.currency)}</strong>
        <span>{providerLabel(offer.provider)}{expired ? " · Expired" : ""}</span>
      </div>
      <div>
        <small>Observed {dateTime(offer.observedAt)}</small>
        {source ? <a href={source.url} target="_blank" rel="noreferrer">View evidence ↗</a> : null}
      </div>
    </article>
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
