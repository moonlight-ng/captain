import { useEffect, useMemo, useState, type ReactNode, type UIEvent } from "react";

import { canonicalFlightHref, tripLegHref } from "../api";
import { CaptainFeedPosts } from "../components/CaptainFeedPosts";
import { ChevronRightIcon, FilterIcon, RefreshIcon } from "../components/icons";
import {
  EMPTY_BROWSE_PREFERENCES,
  departurePeriod,
  type BrowsePreferences,
  type CanonicalFlight,
  type FlightOfferSnapshot,
  type LegSearchSnapshot,
  type Recommendation,
  type Trip,
  type TripActivity,
  type TripCity,
  type TripCityLeg
} from "../domain";
import { activityFeedLine, feedPostsFromActivity, withFeedUpdateAction } from "../feed-posts";
import {
  countFilters,
  dateLabel,
  dateRangeLabel,
  filterChips,
  formatMoney,
  sortLabel
} from "../format";
import {
  bestOffer,
  planTimelineItems,
  tripDateSpan
} from "../multi-city-view";

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

type FeedTripProps = SharedTripProps & {
  activity: TripActivity[];
  recommendation: Recommendation | null;
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
                  onOpen={() => props.onNavigate(tripLegHref(props.trip.id, leg.id))}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MultiCityPlanSummary({
  cities: unsortedCities,
  legs: unsortedLegs
}: Pick<SharedTripProps, "cities" | "legs">) {
  const cities = sort(unsortedCities);
  const legs = sort(unsortedLegs);

  return (
    <header className="plan-summary">
      <p>Confirm date</p>
      <p>
        {cities.length} {cities.length === 1 ? "city" : "cities"}
        {" · "}
        {legs.length} {legs.length === 1 ? "flight" : "flights"}
      </p>
    </header>
  );
}

export function MultiCityPlanOverview({
  cities: unsortedCities
}: Pick<SharedTripProps, "cities">) {
  const items = planTimelineItems(unsortedCities);

  return (
    <section className="multi-city-page multi-city-tab-page plan-itinerary" aria-label="Trip itinerary">
      <ol className="plan-timeline">
        {items.map((item) => {
          const start = item.kind === "flight" ? item.date : item.window.start;
          const end = item.kind === "flight" ? item.date : item.window.end;
          const date = planTimelineDate(start, end);
          return (
            <li
              className={`plan-timeline-event ${item.kind === "event" ? "is-between" : "is-flight"}`}
              key={`${item.cityId}-${item.kind}`}
            >
              <time dateTime={start}>
                <strong>{date.day}</strong>
                {item.kind === "flight" ? <small>{date.year}</small> : null}
              </time>
              <span className="plan-timeline-track" aria-hidden="true"><i /></span>
              {item.kind === "flight" ? (
                <div className="plan-timeline-city">
                  <strong>{item.cityLabel}</strong>
                  <small>{item.action}</small>
                </div>
              ) : (
                <div className="plan-timeline-city">
                  <strong>Event</strong>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function MultiCityFlightsOverview(
  props: SharedTripProps
) {
  const cities = sort(props.cities);
  const legs = sort(props.legs);
  const byId = new Map(cities.map((city) => [city.id, city]));
  const onlyLeg = legs.length === 1 ? legs[0] : undefined;

  if (onlyLeg) {
    return (
      <TripLegResults
        {...props}
        legId={onlyLeg.id}
        embedded
      />
    );
  }

  return (
    <section className="multi-city-page multi-city-tab-page">
      <div className="multi-city-flight-list">
        {legs.map((leg) => {
          const origin = byId.get(leg.originCityId);
          const destination = byId.get(leg.destinationCityId);
          if (!origin || !destination) return null;
          return (
            <LegCard
              key={leg.id}
              leg={leg}
              origin={origin}
              destination={destination}
              snapshot={props.latestSearches[leg.id]}
              progress={props.searchProgress[leg.id]}
              error={props.searchErrors[leg.id]}
              onOpen={() => props.onNavigate(tripLegHref(props.trip.id, leg.id))}
            />
          );
        })}
      </div>
    </section>
  );
}

export function MultiCityFeed(props: FeedTripProps) {
  const cities = sort(props.cities);
  const legs = sort(props.legs);
  const byId = new Map(cities.map((city) => [city.id, city]));
  const watching = legs.flatMap((leg) => {
    if (!leg.selectedFlightKey) return [];
    const snapshot = props.latestSearches[leg.id];
    const flight = snapshot?.flights.find((item) => item.key === leg.selectedFlightKey);
    if (!snapshot || !flight) return [];
    return [{
      leg,
      flight,
      offer: bestOffer(flight.key, snapshot.offers),
      origin: byId.get(leg.originCityId),
      destination: byId.get(leg.destinationCityId)
    }];
  });
  const recommendationFlight = props.recommendation
    ? Object.values(props.latestSearches)
      .flatMap((snapshot) => snapshot.flights)
      .find((flight) => flight.key === props.recommendation!.itineraryKey)
    : undefined;
  const posts = withFeedUpdateAction(
    feedPostsFromActivity(props.activity, (item) => feedActivityTitle(item, byId, legs)),
    recommendationFlight
      ? {
        label: "Open flight",
        onClick: () => props.onNavigate(canonicalFlightHref(recommendationFlight.key))
      }
      : undefined
  );
  const empty = watching.length === 0
    && posts.length === 0
    && !props.recommendation;

  return (
    <section className="multi-city-page multi-city-tab-page">
      {empty ? (
        <div className="results-empty compact">
          <span>⌁</span>
          <h2>No activity yet</h2>
          <p>Select a flight on any leg to start watching it. Captain’s actions and recommendations land here.</p>
        </div>
      ) : (
        <div className="multi-city-feed">
          {watching.length > 0 ? (
            <WatchingFeed
              items={watching}
              onOpen={(flightKey) => props.onNavigate(canonicalFlightHref(flightKey))}
            />
          ) : null}

          <CaptainFeedPosts posts={posts} />
        </div>
      )}
    </section>
  );
}

function feedActivityTitle(
  item: TripActivity,
  cities: Map<string, TripCity>,
  legs: TripCityLeg[]
): string {
  if (item.eventType === "trip_leg_flight_selected") {
    const legId = typeof item.payload.legId === "string" ? item.payload.legId : null;
    const leg = legId ? legs.find((candidate) => candidate.id === legId) : undefined;
    if (leg) {
      const origin = cities.get(leg.originCityId)?.label ?? "Origin";
      const destination = cities.get(leg.destinationCityId)?.label ?? "Destination";
      return `Started watching ${origin} → ${destination}.`;
    }
  }
  return activityFeedLine(item.eventType);
}

type WatchingItem = {
  leg: TripCityLeg;
  flight: CanonicalFlight;
  offer: FlightOfferSnapshot | null | undefined;
  origin: TripCity | undefined;
  destination: TripCity | undefined;
};

function WatchingFeed({
  items,
  onOpen
}: {
  items: WatchingItem[];
  onOpen: (flightKey: string) => void;
}) {
  const carousel = items.length > 1;
  const [active, setActive] = useState(0);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const track = event.currentTarget;
    const width = track.clientWidth;
    if (width <= 0) return;
    setActive(Math.round(track.scrollLeft / width));
  }

  return (
    <div className={`feed-watching${carousel ? " is-carousel" : ""}`}>
      <div
        className={carousel ? "feed-watching-track" : undefined}
        role={carousel ? "region" : undefined}
        aria-label={carousel ? "Watched flights" : "Watched flight"}
        onScroll={carousel ? onScroll : undefined}
      >
        {items.map(({ leg, flight, offer, origin, destination }) => (
          <button
            type="button"
            className="recommendation-card feed-watching-card"
            key={leg.id}
            onClick={() => onOpen(flight.key)}
          >
            <div className="card-top">
              <span className="mode-label">
                {origin?.label ?? "Origin"} → {destination?.label ?? "Destination"}
              </span>
              <span className="pill">Watching</span>
            </div>
            <strong className="price">
              {offer ? formatMoney(Number(offer.priceAmount), offer.currency) : "Fare unavailable"}
            </strong>
            <div className="metrics">
              <span>{flight.primaryAirlineCode}</span>
              <span className="metrics-emphasis">{stopLabel(flight.stops)}</span>
              <span className="metrics-emphasis">{dateLabel(flight.departureDate)}</span>
            </div>
            <div className="metrics">
              <span>{flightSchedule(flight)}</span>
            </div>
          </button>
        ))}
      </div>
      {carousel ? (
        <div className="feed-watching-dots" role="tablist" aria-label="Watched flight pages">
          {items.map((item, index) => (
            <span
              key={item.leg.id}
              className={`feed-watching-dot${index === active ? " active" : ""}`}
              aria-hidden="true"
            />
          ))}
        </div>
      ) : null}
    </div>
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
  onOpen
}: {
  leg: TripCityLeg;
  origin: TripCity;
  destination: TripCity;
  snapshot?: LegSearchSnapshot | undefined;
  progress?: LegSearchSnapshot | undefined;
  error?: string | undefined;
  onOpen: () => void;
}) {
  const active = progress?.status === "queued" || progress?.status === "running";
  const result = snapshot ?? (progress && !active ? progress : undefined);
  const selected = leg.selectedFlightKey
    ? result?.flights.find((flight) => flight.key === leg.selectedFlightKey)
    : undefined;
  const offer = selected ? bestOffer(selected.key, result?.offers ?? []) : null;
  const placeholder = active ? "Looking for flights…" : "Browse flights";
  const flightDate = selected?.departureDate ?? (
    leg.departureWindow.start === leg.departureWindow.end
      ? leg.departureWindow.start
      : null
  );

  return (
    <article className="trip-leg-card">
      <div className="trip-leg-rail" aria-hidden="true"><i /></div>
      <div className="trip-leg-body">
        <div className="trip-leg-topline">
          <span>{origin.label} → {destination.label}</span>
          {flightDate ? <small>{dateLabel(flightDate)}</small> : null}
        </div>

        <button
          type="button"
          className={`leg-pick${selected ? " is-set" : " is-empty"}`}
          onClick={onOpen}
        >
          {selected ? (
            <>
              <strong>{flightSchedule(selected)}</strong>
              <small>
                {selected.primaryAirlineCode}
                {" · "}
                {stopLabel(selected.stops)}
                {offer ? ` · ${formatMoney(Number(offer.priceAmount), offer.currency)}` : ""}
              </small>
            </>
          ) : (
            <span className="leg-pick-placeholder">{placeholder}</span>
          )}
        </button>

        {result ? (
          <p className="leg-coverage">
            {result.analysis.optionsChecked} verified option{result.analysis.optionsChecked === 1 ? "" : "s"}
            {result.analysis.observedAt ? ` · ${observedLabel(result.analysis.observedAt)}` : ""}
          </p>
        ) : active && progress?.analysis ? (
          <p className="leg-coverage">
            {progress.analysis.optionsChecked} verified option{progress.analysis.optionsChecked === 1 ? "" : "s"} so far
          </p>
        ) : null}
        {error ? <p className="leg-inline-error">{error}</p> : null}
      </div>
    </article>
  );
}

export function TripLegResults({
  legId,
  embedded = false,
  ...props
}: SharedTripProps & {
  legId: string;
  embedded?: boolean;
}) {
  const [preferences, setPreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [draftPreferences, setDraftPreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pendingRefresh, setPendingRefresh] = useState(false);
  const leg = props.legs.find((item) => item.id === legId);
  const origin = leg && props.cities.find((city) => city.id === leg.originCityId);
  const destination = leg && props.cities.find((city) => city.id === leg.destinationCityId);
  const snapshot = leg ? props.latestSearches[leg.id] : undefined;
  const progress = leg ? props.searchProgress[leg.id] : undefined;
  const displaySnapshot = snapshot ?? (progress && !isSearching(progress) ? progress : undefined);
  const flights = useMemo(
    () => sortAndFilterLegFlights(displaySnapshot?.flights ?? [], displaySnapshot, preferences),
    [displaySnapshot, preferences]
  );
  const activeFilters = countFilters(preferences);
  const active = progress ? isSearching(progress) : false;
  const searchError = leg ? props.searchErrors[leg.id] : undefined;

  useEffect(() => {
    if (active || searchError) setPendingRefresh(false);
  }, [active, searchError]);

  if (!leg || !origin || !destination) {
    return (
      <section className="multi-city-page leg-results-page">
        <div className="results-empty compact"><h2>Flight leg unavailable</h2><p>This leg is no longer part of the trip.</p></div>
      </section>
    );
  }

  if (filtersOpen) {
    return (
      <TripLegFiltersPage
        preferences={draftPreferences}
        flights={displaySnapshot?.flights ?? []}
        snapshot={displaySnapshot}
        onPreferences={setDraftPreferences}
        onBack={() => setFiltersOpen(false)}
        onApply={() => {
          setPreferences(draftPreferences);
          setFiltersOpen(false);
        }}
        onReset={() => setDraftPreferences(EMPTY_BROWSE_PREFERENCES)}
      />
    );
  }

  const partial = Boolean(displaySnapshot && !displaySnapshot.analysis.complete);
  const expired = displaySnapshot?.offers.some(
    (offer) => offer.expiresAt !== null && Date.parse(offer.expiresAt) <= Date.now()
  ) ?? false;
  const refreshing = active || pendingRefresh;
  const refreshLabel = active && progress && progress.analysis.datesRequested.length > 0
    ? `Checking ${progress.analysis.datesCompleted.length}/${progress.analysis.datesRequested.length}`
    : refreshing
      ? "Updating…"
      : "Some seller prices have expired.";
  const refresh = () => {
    setPendingRefresh(true);
    props.onSearch(leg);
  };

  return (
    <section className={`multi-city-page leg-results-page${embedded ? " is-embedded" : ""}`}>
      {partial && displaySnapshot ? (
        <div className="leg-notice">
          <strong>Partial results.</strong> {displaySnapshot.analysis.datesCompleted.length} of {displaySnapshot.analysis.datesRequested.length} dates completed, so this is the lowest fare found—not necessarily the lowest in the full range.
        </div>
      ) : null}
      {expired || refreshing ? (
        <button
          type="button"
          className={`leg-notice leg-notice-action${refreshing ? " is-refreshing" : ""}`}
          disabled={refreshing}
          onClick={refresh}
          aria-live="polite"
        >
          <span>{refreshLabel}</span>
          <RefreshIcon />
        </button>
      ) : null}
      {props.searchErrors[leg.id] ? <div className="notice">{props.searchErrors[leg.id]}</div> : null}

      {displaySnapshot ? (
        <>
          <div className="browse-toolbar">
            <button
              type="button"
              className={`sort-filter-button${activeFilters ? " active" : ""}`}
              onClick={() => {
                setDraftPreferences(preferences);
                setFiltersOpen(true);
              }}
            >
              <span className="sort-filter-title">
                <FilterIcon />
                <strong>Sort &amp; filter</strong>
              </span>
              <span className="sort-filter-summary">
                <span>{sortLabel(preferences.sort)}</span>
                {activeFilters > 0 ? <b>{activeFilters}</b> : null}
                <ChevronRightIcon />
              </span>
            </button>
          </div>
          {activeFilters > 0 ? (
            <div className="active-filter-row" aria-label="Active filters">
              {filterChips(preferences).map((chip) => <span key={chip}>{chip}</span>)}
              <button type="button" onClick={() => setPreferences(EMPTY_BROWSE_PREFERENCES)}>Clear all</button>
            </div>
          ) : null}

          {flights.length === 0 ? (
            <div className="results-empty compact">
              <h2>No matching flights</h2>
              <p>
                {displaySnapshot.flights.length === 0
                  ? "No verified options yet for this date range."
                  : "Adjust filters or refresh to check again."}
              </p>
              <button type="button" disabled={active} onClick={refresh}>
                {active ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          ) : (
            <div className="leg-flight-list">
              {flights.map((flight) => (
                <LegFlightCard
                  key={flight.key}
                  flight={flight}
                  offer={bestOffer(flight.key, displaySnapshot.offers)}
                  snapshot={displaySnapshot}
                  selected={leg.selectedFlightKey === flight.key}
                  onOpen={() => props.onNavigate(canonicalFlightHref(flight.key))}
                />
              ))}
            </div>
          )}
        </>
      ) : active ? null : (
        <div className="results-empty leg-search-empty">
          <h2>No flights found</h2>
          <p>Search again to check current options for this leg.</p>
          <button type="button" onClick={refresh}>Refresh</button>
        </div>
      )}
    </section>
  );
}

function TripLegFiltersPage({
  preferences,
  flights,
  snapshot,
  onPreferences,
  onBack,
  onApply,
  onReset
}: {
  preferences: BrowsePreferences;
  flights: CanonicalFlight[];
  snapshot: LegSearchSnapshot | undefined;
  onPreferences: (value: BrowsePreferences | ((current: BrowsePreferences) => BrowsePreferences)) => void;
  onBack: () => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const matches = sortAndFilterLegFlights(flights, snapshot, preferences).length;
  const airlines = [...new Set(flights.map((flight) => flight.primaryAirlineCode))].sort();
  const airports = [...new Set(flights.flatMap(flightAirports))].sort();
  const hasDepartures = flights.some((flight) => flight.segments[0]?.departure);
  function update<Key extends keyof BrowsePreferences>(key: Key, value: BrowsePreferences[Key]) {
    onPreferences((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="leg-filters-page" aria-label="Sort and filter flights">
      <header className="topbar leg-filters-topbar">
        <button type="button" className="back-link" onClick={onBack}>← Results</button>
        <span className="name">Sort &amp; filter</span>
      </header>
      <div className="leg-filters-scroll">
        <FilterGroup label="Sort">
          <select
            value={preferences.sort}
            onChange={(event) => update("sort", event.target.value as BrowsePreferences["sort"])}
          >
            <option value="recommended">Captain’s pick</option>
            <option value="price">Lowest price</option>
            <option value="duration">Shortest duration</option>
            <option value="departure">Earliest departure</option>
          </select>
        </FilterGroup>
        <FilterGroup label="Stops">
          <div className="filter-choice-row">
            {[0, 1, 2].map((stops) => (
              <button
                type="button"
                className={preferences.stops.includes(stops) ? "selected" : ""}
                key={stops}
                onClick={() => update("stops", toggle(preferences.stops, stops))}
              >
                {stops === 0 ? "Direct" : `${stops} stop${stops === 1 ? "" : "s"}`}
              </button>
            ))}
          </div>
        </FilterGroup>
        {airlines.length > 0 ? (
          <FilterGroup label="Airlines">
            <div className="filter-choice-row wrap">
              {airlines.map((airline) => (
                <button
                  type="button"
                  className={preferences.airlines.includes(airline) ? "selected" : ""}
                  key={airline}
                  onClick={() => update("airlines", toggle(preferences.airlines, airline))}
                >
                  {airlineLabel(airline, flights)}
                </button>
              ))}
            </div>
          </FilterGroup>
        ) : null}
        {airports.length > 0 ? (
          <FilterGroup label="Airports">
            <div className="filter-choice-row wrap">
              {airports.map((airport) => (
                <button
                  type="button"
                  className={preferences.airports.includes(airport) ? "selected" : ""}
                  key={airport}
                  onClick={() => update("airports", toggle(preferences.airports, airport))}
                >
                  {airport}
                </button>
              ))}
            </div>
          </FilterGroup>
        ) : null}
        {hasDepartures ? (
          <FilterGroup label="Departure">
            <div className="filter-choice-row">
              {(["morning", "afternoon", "evening"] as const).map((period) => (
                <button
                  type="button"
                  className={preferences.departurePeriods.includes(period) ? "selected" : ""}
                  key={period}
                  onClick={() => update("departurePeriods", toggle(preferences.departurePeriods, period))}
                >
                  {period[0]!.toUpperCase() + period.slice(1)}
                </button>
              ))}
            </div>
          </FilterGroup>
        ) : null}
        <FilterGroup label="Maximum price">
          <input
            className="sheet-input"
            type="number"
            min={1}
            value={preferences.maximumPrice ?? ""}
            placeholder="No maximum"
            onChange={(event) => update(
              "maximumPrice",
              event.target.value ? Number(event.target.value) : null
            )}
          />
        </FilterGroup>
      </div>
      <footer className="leg-filters-footer">
        <button type="button" className="secondary-action" onClick={onReset}>Reset</button>
        <button type="button" className="primary-action" onClick={onApply}>
          Show {matches}
        </button>
      </footer>
    </section>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="filter-group"><strong>{label}</strong>{children}</div>;
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function flightAirports(flight: CanonicalFlight): string[] {
  return [...new Set(flight.segments.flatMap((segment) => [segment.origin, segment.destination]))];
}

function airlineLabel(code: string, flights: CanonicalFlight[]): string {
  const named = flights.find((flight) =>
    flight.primaryAirlineCode === code && flight.segments[0]?.marketingAirline.trim()
  );
  return named?.segments[0]?.marketingAirline.trim() || code;
}

function LegFlightCard({
  flight,
  offer,
  snapshot,
  selected,
  onOpen
}: {
  flight: CanonicalFlight;
  offer: FlightOfferSnapshot | null;
  snapshot: LegSearchSnapshot;
  selected: boolean;
  onOpen: () => void;
}) {
  const tags = [
    snapshot.analysis.cheapest?.flightKey === flight.key ? "Lowest" : null,
    snapshot.analysis.fastest?.flightKey === flight.key ? "Fastest" : null,
    snapshot.analysis.balanced?.flightKey === flight.key ? "Captain’s pick" : null
  ].filter((tag): tag is string => Boolean(tag));
  return (
    <button
      type="button"
      className={`leg-flight-card${selected ? " selected" : ""}`}
      onClick={onOpen}
      aria-pressed={selected}
    >
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

function planTimelineDate(start: string, end: string): { day: string; year: string } {
  const startDate = new Date(`${start}T12:00:00Z`);
  const endDate = new Date(`${end}T12:00:00Z`);
  const month = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
  const day = new Intl.DateTimeFormat("en", { day: "numeric", timeZone: "UTC" });
  const year = new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "UTC" });
  const startMonth = month.format(startDate);
  const endMonth = month.format(endDate);
  const startDay = day.format(startDate);
  const endDay = day.format(endDate);
  const startYear = year.format(startDate);
  const endYear = year.format(endDate);

  if (start === end) return { day: `${startMonth} ${startDay}`, year: startYear };
  if (startYear !== endYear) {
    return { day: `${startMonth} ${startDay} – ${endMonth} ${endDay}`, year: `${startYear}–${endYear}` };
  }
  if (startMonth === endMonth) return { day: `${startMonth} ${startDay} – ${endDay}`, year: startYear };
  return { day: `${startMonth} ${startDay} – ${endMonth} ${endDay}`, year: startYear };
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

function clock(value: string): string {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function sortAndFilterLegFlights(
  flights: CanonicalFlight[],
  snapshot: LegSearchSnapshot | undefined,
  preferences: BrowsePreferences
): CanonicalFlight[] {
  const filtered = flights.filter((flight) => {
    if (preferences.stops.length > 0 && !preferences.stops.includes(flight.stops)) return false;
    if (preferences.airlines.length > 0 && !preferences.airlines.includes(flight.primaryAirlineCode)) {
      return false;
    }
    if (
      preferences.airports.length > 0
      && !preferences.airports.some((airport) => flightAirports(flight).includes(airport))
    ) {
      return false;
    }
    if (preferences.maximumPrice !== null) {
      const price = Number(bestOffer(flight.key, snapshot?.offers ?? [])?.priceAmount ?? Number.POSITIVE_INFINITY);
      if (price > preferences.maximumPrice) return false;
    }
    if (preferences.departurePeriods.length > 0) {
      const departure = flight.segments[0]?.departure;
      if (!departure || !preferences.departurePeriods.includes(departurePeriod(departure))) {
        return false;
      }
    }
    return true;
  });
  return sortFlights(filtered, snapshot, preferences.sort);
}

function sortFlights(
  flights: CanonicalFlight[],
  snapshot: LegSearchSnapshot | undefined,
  mode: BrowsePreferences["sort"]
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
