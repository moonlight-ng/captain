import { useMemo, useState } from "react";

import { canonicalFlightHref, tripHref, tripLegHref } from "../api";
import type {
  CanonicalFlight,
  FlightOfferSnapshot,
  LegSearchSnapshot,
  Trip,
  TripCity,
  TripCityLeg
} from "../domain";
import { dateLabel, dateRangeLabel, formatMoney } from "../format";
import { bestOffer, groupFlightsByDate, priceDateStatus, tripDateSpan } from "../multi-city-view";

type SearchProgress = Record<string, LegSearchSnapshot>;

type SharedTripProps = {
  trip: Trip;
  cities: TripCity[];
  legs: TripCityLeg[];
  latestSearches: Record<string, LegSearchSnapshot>;
  searchProgress: SearchProgress;
  searchErrors: Record<string, string>;
  onSearch: (leg: TripCityLeg) => void;
  onNavigate: (href: string) => void;
};

export function MultiCityTripOverview(props: SharedTripProps) {
  const cities = sort(props.cities);
  const legs = sort(props.legs);
  const byId = new Map(cities.map((city) => [city.id, city]));
  const span = tripDateSpan(cities, legs);

  return (
    <section className="multi-city-page">
      <header className="multi-city-heading">
        <p className="eyebrow">Your trip</p>
        <h1>{props.trip.title}</h1>
        <p>
          {cities.length} {cities.length === 1 ? "city" : "cities"}
          {" · "}
          {legs.length} {legs.length === 1 ? "flight" : "flights"}
          {span ? ` · ${span}` : ""}
        </p>
      </header>

      <div className="trip-route" aria-label="Trip itinerary">
        {cities.map((city, index) => {
          const leg = legs.find((item) => item.originCityId === city.id)
            ?? legs[index];
          const destination = leg ? byId.get(leg.destinationCityId) : undefined;
          return (
            <div className="route-step" key={city.id}>
              <CityStop city={city} />
              {leg && destination ? (
                <LegCard
                  leg={leg}
                  origin={city}
                  destination={destination}
                  snapshot={props.latestSearches[leg.id]}
                  progress={props.searchProgress[leg.id]}
                  error={props.searchErrors[leg.id]}
                  onSearch={() => props.onSearch(leg)}
                  onOpen={() => props.onNavigate(tripLegHref(props.trip.id, leg.id))}
                  onOpenFlight={(flightKey) => props.onNavigate(canonicalFlightHref(flightKey))}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CityStop({ city }: { city: TripCity }) {
  const timing = cityTiming(city);
  return (
    <article className="city-stop">
      <span className="city-stop-dot" aria-hidden="true" />
      <div>
        <h2>{city.label}</h2>
        {timing.length > 0 ? <p>{timing.join(" · ")}</p> : null}
        <small>{city.airportCodes.join(" / ")}</small>
      </div>
    </article>
  );
}

function LegCard({
  leg,
  origin,
  destination,
  snapshot,
  progress,
  error,
  onSearch,
  onOpen,
  onOpenFlight
}: {
  leg: TripCityLeg;
  origin: TripCity;
  destination: TripCity;
  snapshot?: LegSearchSnapshot | undefined;
  progress?: LegSearchSnapshot | undefined;
  error?: string | undefined;
  onSearch: () => void;
  onOpen: () => void;
  onOpenFlight: (flightKey: string) => void;
}) {
  const active = progress?.status === "queued" || progress?.status === "running";
  const result = snapshot ?? (progress && !active ? progress : undefined);
  const selected = leg.selectedFlightKey
    ? result?.flights.find((flight) => flight.key === leg.selectedFlightKey)
    : undefined;
  const best = result?.analysis.cheapest ?? null;
  const progressAnalysis = progress?.analysis;

  return (
    <article className="trip-leg-card">
      <div className="trip-leg-rail" aria-hidden="true"><span>↓</span></div>
      <div className="trip-leg-body">
        <div className="trip-leg-topline">
          <span>{origin.label} → {destination.label}</span>
          <small>{dateRangeLabel(leg.departureWindow.start, leg.departureWindow.end)}</small>
        </div>

        {active && progressAnalysis ? (
          <div className="leg-progress" role="status">
            <span
              style={{
                width: `${Math.round(
                  progressAnalysis.datesCompleted.length
                  / Math.max(1, progressAnalysis.datesRequested.length) * 100
                )}%`
              }}
            />
            <p>
              {progressAnalysis.datesCompleted.length} of {progressAnalysis.datesRequested.length} dates checked
            </p>
          </div>
        ) : null}

        {selected ? (
          <button
            type="button"
            className="leg-best leg-selected"
            onClick={() => onOpenFlight(selected.key)}
          >
            <span>Selected flight</span>
            <strong>{flightSchedule(selected)}</strong>
          </button>
        ) : best && result ? (
          <button type="button" className="leg-best" onClick={onOpen}>
            <span>{result?.analysis.complete ? "Lowest in range" : "Lowest found"}</span>
            <strong>{formatMoney(Number(best.priceAmount), best.currency)}</strong>
            <small>{flightPickSchedule(best.flightKey, result)}</small>
          </button>
        ) : (
          <p className="leg-empty-copy">
            {active ? "Looking across your date range…" : "No flight search yet"}
          </p>
        )}

        {result ? (
          <p className="leg-coverage">
            {result.analysis.datesCompleted.length} of {result.analysis.datesRequested.length} dates
            {" · "}{result.analysis.optionsChecked} verified options
            {result.analysis.observedAt ? ` · ${observedLabel(result.analysis.observedAt)}` : ""}
          </p>
        ) : null}
        {error ? <p className="leg-inline-error">{error}</p> : null}

        <div className="leg-actions">
          <button type="button" disabled={active} onClick={onSearch}>
            {active ? "Searching…" : result ? "Search again" : "Search flights"}
          </button>
          {result && result.flights.length > 0 ? (
            <button type="button" className="primary" onClick={onOpen}>View results</button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function TripLegResults({
  legId,
  onSelect,
  ...props
}: SharedTripProps & {
  legId: string;
  onSelect: (leg: TripCityLeg, flightKey: string) => void;
}) {
  const [sortMode, setSortMode] = useState<"recommended" | "price" | "duration" | "departure">("recommended");
  const [stopFilter, setStopFilter] = useState<"all" | "nonstop" | "one_stop">("all");
  const leg = props.legs.find((item) => item.id === legId);
  const origin = leg && props.cities.find((city) => city.id === leg.originCityId);
  const destination = leg && props.cities.find((city) => city.id === leg.destinationCityId);
  const snapshot = leg ? props.latestSearches[leg.id] : undefined;
  const progress = leg ? props.searchProgress[leg.id] : undefined;
  const displaySnapshot = snapshot ?? (progress && !isSearching(progress) ? progress : undefined);
  const flights = useMemo(
    () => sortFlights(
      (displaySnapshot?.flights ?? []).filter((flight) => {
        if (stopFilter === "nonstop") return flight.stops === 0;
        if (stopFilter === "one_stop") return flight.stops <= 1;
        return true;
      }),
      displaySnapshot,
      sortMode
    ),
    [displaySnapshot, sortMode, stopFilter]
  );
  const grouped = groupFlightsByDate(flights);

  if (!leg || !origin || !destination) {
    return (
      <section className="multi-city-page leg-results-page">
        <button type="button" className="back-link" onClick={() => props.onNavigate(tripHref(props.trip.id))}>Back</button>
        <div className="results-empty compact"><h2>Flight leg unavailable</h2><p>This leg is no longer part of the trip.</p></div>
      </section>
    );
  }

  const active = progress ? isSearching(progress) : false;
  const partial = Boolean(displaySnapshot && !displaySnapshot.analysis.complete);
  const expired = displaySnapshot?.offers.some(
    (offer) => offer.expiresAt !== null && Date.parse(offer.expiresAt) <= Date.now()
  ) ?? false;

  return (
    <section className="multi-city-page leg-results-page">
      <header className="leg-results-heading">
        <button type="button" className="back-link" onClick={() => props.onNavigate(tripHref(props.trip.id))}>Back</button>
        <p className="eyebrow">Flight {leg.position + 1} of {props.legs.length}</p>
        <h1>{origin.label} → {destination.label}</h1>
        <p>{dateRangeLabel(leg.departureWindow.start, leg.departureWindow.end)}</p>
      </header>

      {active && progress ? <SearchCoverage snapshot={progress} /> : null}
      {partial && displaySnapshot ? (
        <div className="leg-notice">
          <strong>Partial results.</strong> {displaySnapshot.analysis.datesCompleted.length} of {displaySnapshot.analysis.datesRequested.length} dates completed, so this is the lowest fare found—not necessarily the lowest in the full range.
        </div>
      ) : null}
      {expired ? <div className="leg-notice">Some seller prices have expired. Search again before choosing.</div> : null}
      {props.searchErrors[leg.id] ? <div className="notice">{props.searchErrors[leg.id]}</div> : null}

      {displaySnapshot ? (
        <>
          <PriceByDate snapshot={displaySnapshot} />
          <div className="leg-result-tools">
            <label>
              <span>Sort</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}>
                <option value="recommended">Captain’s pick</option>
                <option value="price">Lowest price</option>
                <option value="duration">Shortest</option>
                <option value="departure">Earliest</option>
              </select>
            </label>
            <label>
              <span>Stops</span>
              <select value={stopFilter} onChange={(event) => setStopFilter(event.target.value as typeof stopFilter)}>
                <option value="all">Any</option>
                <option value="nonstop">Nonstop</option>
                <option value="one_stop">Up to 1 stop</option>
              </select>
            </label>
            <button type="button" disabled={active} onClick={() => props.onSearch(leg)}>
              {active ? "Searching…" : "Search again"}
            </button>
          </div>

          {flights.length === 0 ? (
            <div className="results-empty compact"><h2>No matching flights</h2><p>Adjust the stops filter or search again.</p></div>
          ) : (
            <div className="dated-flight-groups">
              {grouped.map(([date, items]) => (
                <section key={date} className="dated-flight-group">
                  <h2>{dateLabel(date)} <span>{items.length} option{items.length === 1 ? "" : "s"}</span></h2>
                  <div className="leg-flight-list">
                    {items.map((flight) => (
                      <LegFlightCard
                        key={flight.key}
                        flight={flight}
                        offer={bestOffer(flight.key, displaySnapshot.offers)}
                        snapshot={displaySnapshot}
                        selected={leg.selectedFlightKey === flight.key}
                        onOpen={() => props.onNavigate(canonicalFlightHref(flight.key))}
                        onSelect={() => onSelect(leg, flight.key)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="results-empty leg-search-empty">
          <h2>Search this date range</h2>
          <p>Captain will check each day from {dateRangeLabel(leg.departureWindow.start, leg.departureWindow.end)} and compare verified flights.</p>
          <button className="primary" type="button" disabled={active} onClick={() => props.onSearch(leg)}>
            {active ? "Searching…" : "Search flights"}
          </button>
        </div>
      )}
    </section>
  );
}

function SearchCoverage({ snapshot }: { snapshot: LegSearchSnapshot }) {
  const { datesCompleted, datesRequested, optionsChecked } = snapshot.analysis;
  return (
    <div className="leg-search-progress" role="status">
      <div><span style={{ width: `${datesCompleted.length / Math.max(1, datesRequested.length) * 100}%` }} /></div>
      <p>Checking {datesCompleted.length} of {datesRequested.length} dates · {optionsChecked} verified options so far</p>
    </div>
  );
}

function PriceByDate({ snapshot }: { snapshot: LegSearchSnapshot }) {
  const byDate = new Map(snapshot.analysis.cheapestByDate.map((pick) => [pick.departureDate, pick]));
  return (
    <section className="price-by-date" aria-labelledby="price-by-date-title">
      <div className="section-title-row">
        <h2 id="price-by-date-title">Price by date</h2>
        {snapshot.analysis.observedAt ? <span>{observedLabel(snapshot.analysis.observedAt)}</span> : null}
      </div>
      <div className="price-date-strip">
        {snapshot.analysis.datesRequested.map((date) => {
          const pick = byDate.get(date);
          const status = priceDateStatus(
            date,
            snapshot.analysis.datesCompleted,
            snapshot.analysis.failedDates
          );
          return (
            <div className={`price-date${pick ? " has-price" : ""}`} key={date}>
              <span>{shortDay(date)}</span>
              <strong>
                {pick
                  ? formatMoney(Number(pick.priceAmount), pick.currency)
                  : status}
              </strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LegFlightCard({
  flight,
  offer,
  snapshot,
  selected,
  onOpen,
  onSelect
}: {
  flight: CanonicalFlight;
  offer: FlightOfferSnapshot | null;
  snapshot: LegSearchSnapshot;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
}) {
  const tags = [
    snapshot.analysis.cheapest?.flightKey === flight.key ? "Lowest" : null,
    snapshot.analysis.fastest?.flightKey === flight.key ? "Fastest" : null,
    snapshot.analysis.balanced?.flightKey === flight.key ? "Captain’s pick" : null
  ].filter((tag): tag is string => Boolean(tag));
  return (
    <article className={`leg-flight-card${selected ? " selected" : ""}`}>
      <button type="button" className="leg-flight-main" onClick={onOpen}>
        <div className="flight-card-topline">
          <span>{flight.segments[0]?.marketingAirline ?? flight.primaryAirlineCode}</span>
          <strong>{offer ? formatMoney(Number(offer.priceAmount), offer.currency) : "Fare unavailable"}</strong>
        </div>
        <div className="flight-card-schedule">
          <strong>{flightSchedule(flight)}</strong>
          <span>{durationLabel(flight.durationMinutes)} · {stopLabel(flight.stops)}</span>
        </div>
        {tags.length > 0 ? <div className="flight-tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
      </button>
      <button type="button" className="select-flight" disabled={selected || !offer} onClick={onSelect}>
        {selected ? "Selected" : "Select flight"}
      </button>
    </article>
  );
}

function sort<T extends { position: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.position - right.position);
}

function isSearching(snapshot: LegSearchSnapshot): boolean {
  return snapshot.status === "queued" || snapshot.status === "running";
}

function cityTiming(city: TripCity): string[] {
  const timing: string[] = [];
  if (city.arrivalWindow) {
    timing.push(city.arrivalWindow.start === city.arrivalWindow.end
      ? `Arrive by ${dateLabel(city.arrivalWindow.end)}`
      : `Arrive ${dateRangeLabel(city.arrivalWindow.start, city.arrivalWindow.end)}`);
  }
  if (city.departureWindow) {
    timing.push(city.departureWindow.start === city.departureWindow.end
      ? `Leave ${dateLabel(city.departureWindow.start)}`
      : `Leave ${dateRangeLabel(city.departureWindow.start, city.departureWindow.end)}`);
  }
  return timing;
}

function shortDay(date: string): string {
  return new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
}

function observedLabel(value: string): string {
  return `Checked ${new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value))}`;
}

function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function stopLabel(stops: number): string {
  return stops === 0 ? "Nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`;
}

function flightSchedule(flight: CanonicalFlight): string {
  const first = flight.segments[0];
  const last = flight.segments.at(-1);
  if (!first || !last) return `${flight.origin} → ${flight.destination}`;
  return `${clock(first.departure)} ${first.origin} → ${clock(last.arrival)} ${last.destination}`;
}

function flightPickSchedule(flightKey: string, snapshot: LegSearchSnapshot): string {
  const flight = snapshot.flights.find((item) => item.key === flightKey);
  return flight ? `${shortDay(flight.departureDate)} · ${flightSchedule(flight)}` : "View flight options";
}

function clock(value: string): string {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function sortFlights(
  flights: CanonicalFlight[],
  snapshot: LegSearchSnapshot | undefined,
  mode: "recommended" | "price" | "duration" | "departure"
): CanonicalFlight[] {
  const balancedKey = snapshot?.analysis.balanced?.flightKey;
  return [...flights].sort((left, right) => {
    if (mode === "recommended") {
      const preference = Number(right.key === balancedKey) - Number(left.key === balancedKey);
      if (preference !== 0) return preference;
    }
    if (mode === "duration") return left.durationMinutes - right.durationMinutes;
    if (mode === "departure") {
      return Date.parse(left.segments[0]?.departure ?? "") - Date.parse(right.segments[0]?.departure ?? "");
    }
    const leftPrice = Number(bestOffer(left.key, snapshot?.offers ?? [])?.priceAmount ?? Number.POSITIVE_INFINITY);
    const rightPrice = Number(bestOffer(right.key, snapshot?.offers ?? [])?.priceAmount ?? Number.POSITIVE_INFINITY);
    return leftPrice - rightPrice || left.durationMinutes - right.durationMinutes;
  });
}
