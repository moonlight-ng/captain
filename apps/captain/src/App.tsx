import { useEffect, useMemo, useRef, useState, Fragment, type Dispatch, type FormEvent, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";

import {
  ApiError,
  accessHref,
  getProfile,
  getSession,
  getTrip,
  initializeAccessToken,
  setTripFlightSelection,
  tripAction,
  updateProfile,
  updateTripBrief
} from "./api";
import {
  EMPTY_BROWSE_PREFERENCES,
  offerAirports,
  offerDeparture,
  sortAndFilterOffers,
  type BrowsePreferences,
  type RankingMode,
  type Segment,
  type TravellerProfile,
  type TripPayload,
  type VerifiedOffer,
  type Watch
} from "./domain";
import {
  airlineLabel,
  normalizeAirlineCode,
  searchAirlines
} from "./airline-catalog";
import { airlineGroups } from "./airline-groups";

type Tab = "flights" | "airlines" | "browse";
const tabLabels: Record<Tab, string> = {
  flights: "Watchlist",
  airlines: "Airlines",
  browse: "Flights"
};

type WatchlistFocus = {
  offerId: string;
  mode?: RankingMode;
};

export function App() {
  const [profile, setProfile] = useState<TravellerProfile | null>(null);
  const [tripData, setTripData] = useState<TripPayload | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("flights");
  const [browsePreferences, setBrowsePreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftPreferences, setDraftPreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [watchlistFocus, setWatchlistFocus] = useState<WatchlistFocus | null>(null);
  const [dismissedItineraryKeys, setDismissedItineraryKeys] = useState<string[]>([]);
  const preferencesPage = window.location.pathname === "/preferences";

  async function load() {
    setLoading(true);
    setError("");
    try {
      initializeAccessToken();
      const session = await getSession();
      const requestedTripId = new URLSearchParams(window.location.search).get("trip") ?? undefined;
      const [nextProfile, nextTrip] = await Promise.all([
        getProfile(),
        getTrip(requestedTripId)
      ]);
      setDisplayName(session.displayName);
      setProfile(nextProfile);
      setTripData(nextTrip);
      setAuthenticated(true);
    } catch (cause) {
      setAuthenticated(false);
      if (!(cause instanceof ApiError && cause.status === 401)) {
        setError("Captain couldn’t load this page. Please try the latest link from Telegram.");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <CenteredState title="Opening Captain…" detail="Loading your Trip." />;
  if (!authenticated) {
    return (
      <CenteredState
        title="Open Captain from Telegram"
        detail={error || "Use Open trip or Agent settings from Captain in Telegram."}
      />
    );
  }
  if (preferencesPage && profile) {
    return (
      <Preferences
        profile={profile}
        tripData={tripData}
        displayName={displayName}
        trackingError={error}
        onSaved={setProfile}
        onTripChanged={load}
        onTripError={setError}
        onBack={() => { window.location.href = accessHref("/trip", tripData?.trip?.id); }}
      />
    );
  }

  const trip = tripData?.trip ?? null;
  const offers = tripData?.offers ?? [];
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href={accessHref("/trip", trip?.id)} aria-label="Captain home">
          <span className="brand-mark">C</span>
          <span>Captain</span>
        </a>
        <div className="top-actions">
          <span className="name">{agentRunningLabel(tripData?.watch, trip)}</span>
          <a className="quiet-link" href={accessHref("/preferences", trip?.id)}>Settings</a>
        </div>
      </header>

      {!trip ? (
        <section className="empty-hero">
          <p className="eyebrow">No active Trip</p>
          <h1>Tell Captain where you want to go.</h1>
          <p>Return to Telegram to create a Trip. Captain can track up to three at once.</p>
        </section>
      ) : watchlistFocus ? (
        <>
          {error && <div className="notice">{error}</div>}
          <WatchlistDetail
            offer={offers.find((item) => item.id === watchlistFocus.offerId) ?? null}
            {...(watchlistFocus.mode ? { mode: watchlistFocus.mode } : {})}
            offers={offers}
            watch={tripData?.watch ?? null}
            activity={tripData?.activity ?? []}
            tripId={trip.id}
            onBack={() => setWatchlistFocus(null)}
            onRemoved={(itineraryKey) => {
              setDismissedItineraryKeys((current) =>
                current.includes(itineraryKey) ? current : [...current, itineraryKey]
              );
              setWatchlistFocus(null);
            }}
            onError={setError}
          />
        </>
      ) : (
        <>
          <section className="trip-heading">
            <div>
              {trip.status === "paused" && <p className="eyebrow">Tracking paused</p>}
              <h1>{routeLabel(trip)}</h1>
              <p className="trip-meta">
                {dateLabel(trip.brief.departureWindow.start)} · {label(trip.brief.cabin)} · {trip.brief.currency}
              </p>
            </div>
          </section>

          {tripData?.watch?.delayReason && (
            <div className="notice notice-delay">
              <strong>Tracking update.</strong> {tripData.watch.delayReason}{" "}
              {offers.length > 0
                ? "Your last checked results remain below."
                : tripData.watch.status === "scheduled"
                  ? "I’ll check again when regular tracking starts."
                  : "I’ll keep trying on the normal schedule."}
            </div>
          )}
          {error && <div className="notice">{error}</div>}

          <nav className="tabs" aria-label="Trip results">
            {(["flights", "airlines", "browse"] as Tab[]).map((item) => (
              <button
                key={item}
                className={tab === item ? "active" : ""}
                onClick={() => setTab(item)}
              >
                {tabLabels[item]}
                {item === "browse" && offers.length > 0 ? <span>{offers.length}</span> : null}
              </button>
            ))}
          </nav>

          <section className="workspace">
            {tab === "flights" && (
              <FlightsTab
                offers={offers}
                profile={profile!}
                dismissedItineraryKeys={dismissedItineraryKeys}
                onOpen={(offer, mode) => {
                  setError("");
                  setWatchlistFocus({ offerId: offer.id, mode });
                }}
              />
            )}
            {tab === "airlines" && (
              <AirlinesTab
                offers={offers}
                onChoose={(airline) => {
                  const next = { ...EMPTY_BROWSE_PREFERENCES, airlines: [airline] };
                  setBrowsePreferences(next);
                  setDraftPreferences(next);
                  setTab("browse");
                }}
              />
            )}
            {tab === "browse" && (
              <BrowseTab
                offers={offers}
                preferences={browsePreferences}
                filterOpen={filterOpen}
                draftPreferences={draftPreferences}
                onOpenFilters={() => {
                  setDraftPreferences(browsePreferences);
                  setFilterOpen(true);
                }}
                onDraftPreferences={setDraftPreferences}
                onCloseFilters={() => setFilterOpen(false)}
                onApplyFilters={() => {
                  setBrowsePreferences(draftPreferences);
                  setFilterOpen(false);
                }}
                onClearFilters={() => {
                  setBrowsePreferences(EMPTY_BROWSE_PREFERENCES);
                  setDraftPreferences(EMPTY_BROWSE_PREFERENCES);
                }}
                onOpen={(offer) => {
                  setError("");
                  setWatchlistFocus({ offerId: offer.id });
                }}
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function FlightsTab({
  offers,
  profile,
  dismissedItineraryKeys,
  onOpen
}: {
  offers: VerifiedOffer[];
  profile: TravellerProfile;
  dismissedItineraryKeys: string[];
  onOpen: (offer: VerifiedOffer, mode: RankingMode) => void;
}) {
  const dismissed = useMemo(() => new Set(dismissedItineraryKeys), [dismissedItineraryKeys]);
  const recommendations = useMemo(() => ({
    cheapest: rankOffers(offers, "cheapest", profile.preferredAirlineCodes)[0],
    balanced: rankOffers(offers, "balanced", profile.preferredAirlineCodes)[0],
    fastest: rankOffers(offers, "fastest", profile.preferredAirlineCodes)[0]
  }), [offers, profile.preferredAirlineCodes]);
  if (offers.length === 0) return <ResultsEmpty />;
  const modes = (["cheapest", "balanced", "fastest"] as RankingMode[])
    .sort((left, right) => Number(right === profile.rankingMode) - Number(left === profile.rankingMode));
  const visible = modes
    .map((mode) => {
      const offer = recommendations[mode];
      if (!offer || dismissed.has(offer.itineraryKey)) return null;
      return { mode, offer };
    })
    .filter((item): item is { mode: RankingMode; offer: VerifiedOffer } => item !== null);
  if (visible.length === 0) {
    return (
      <div className="results-empty compact">
        <span>⌁</span>
        <h2>Watchlist is clear</h2>
        <p>Removed options stay out of this list until you reload the page.</p>
      </div>
    );
  }
  return (
    <div className="recommendation-grid">
      {visible.map(({ mode, offer }) => (
        <RecommendationCard
          key={`${mode}-${offer.id}`}
          offer={offer}
          mode={mode}
          selected={profile.rankingMode === mode}
          onOpen={() => onOpen(offer, mode)}
        />
      ))}
    </div>
  );
}

function RecommendationCard({
  offer,
  mode,
  selected,
  onOpen
}: {
  offer: VerifiedOffer;
  mode: RankingMode;
  selected: boolean;
  onOpen: () => void;
}) {
  const schedule = offerScheduleSpine(offer);
  return (
    <button
      type="button"
      className={`recommendation-card ${selected ? "selected" : ""}`}
      onClick={onOpen}
    >
      <div className="card-top">
        <span className="mode-label">{label(mode)}</span>
        {selected && <span className="pill">Your preference</span>}
      </div>
      <strong className="price">{money(offer)}</strong>
      <div className="metrics">
        <span className="airline">{offer.primaryAirlineCode}{isMixed(offer) ? " · Mixed" : ""}</span>
        <span>{duration(offer)}</span>
        <span>{stops(offer)}</span>
      </div>
      {schedule ? <ScheduleSpine spine={schedule} /> : null}
    </button>
  );
}

function WatchlistDetail({
  offer,
  mode,
  offers,
  watch,
  activity,
  tripId,
  onBack,
  onRemoved,
  onError
}: {
  offer: VerifiedOffer | null;
  mode?: RankingMode;
  offers: VerifiedOffer[];
  watch: Watch | null;
  activity: TripPayload["activity"];
  tripId: string;
  onBack: () => void;
  onRemoved: (itineraryKey: string) => void;
  onError: (message: string) => void;
}) {
  const [removing, setRemoving] = useState(false);
  if (!offer) {
    return (
      <section className="watchlist-detail">
        <button type="button" className="back-link" onClick={onBack}>Back</button>
        <div className="results-empty compact">
          <span>⌁</span>
          <h2>Option unavailable</h2>
          <p>That fare is no longer in the verified set.</p>
        </div>
      </section>
    );
  }

  const outbound = outboundSegments(offer.snapshot.segments ?? []);
  const comparison = peerPriceComparison(offer, offers);

  async function remove() {
    setRemoving(true);
    onError("");
    try {
      await setTripFlightSelection(tripId, offer!.itineraryKey, false);
      onRemoved(offer!.itineraryKey);
    } catch (cause) {
      onError(cause instanceof ApiError ? cause.message : "Couldn’t remove that option.");
      setRemoving(false);
    }
  }

  return (
    <section className="watchlist-detail">
      <header className="watchlist-detail-header">
        <button type="button" className="back-link" onClick={onBack}>Back</button>
        <span className="mode-label">
          {mode ? label(mode) : airlineName(offer.primaryAirlineCode, [offer])}
        </span>
      </header>

      <div className="watchlist-detail-summary">
        <strong className="price">{money(offer)}</strong>
        <p className="watchlist-airline">
          {airlineName(offer.primaryAirlineCode, [offer])}
          {isMixed(offer) ? ` · Mixed · ${offer.participatingAirlineCodes.join(", ")}` : ""}
        </p>
        <div className="metrics">
          <span>{duration(offer)}</span>
          <span>{stops(offer)}</span>
        </div>
      </div>

      {outbound.length > 0 && (
        <div className="watchlist-panel">
          <div className="flight-details-heading">
            <h2>Flight details</h2>
            <p>
              Departing
              {" · "}
              <span className={outbound.length > 1 ? "stop-count" : undefined}>
                {outbound.length > 1
                  ? `${outbound.length - 1} stop${outbound.length === 2 ? "" : "s"}`
                  : "Nonstop"}
              </span>
            </p>
          </div>
          <FlightTimeline segments={outbound} />
        </div>
      )}

      <div className="watchlist-panel">
        <h2>How it compares</h2>
        <PeerPricePlot comparison={comparison} currency={offer.currency} />
        <p className="set-note">Among verified options for this Trip.</p>
      </div>

      <div className="watchlist-panel">
        <h2>Sources</h2>
        {offer.evidence.length > 0 ? (
          <table className="sources-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {offer.evidence.map((item) => (
                <tr key={item.url}>
                  <td>
                    <a href={item.url} target="_blank" rel="noreferrer">{item.domain}</a>
                  </td>
                  <td>{item.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="set-note">No provider evidence links on this fare.</p>
        )}
        <p className="set-note">
          Last verified {relativeTime(offer.verifiedAt)}
          {offer.observedAt !== offer.verifiedAt ? ` · Observed ${relativeTime(offer.observedAt)}` : ""}
        </p>
      </div>

      <div className="watchlist-panel">
        <h2>Agent activity</h2>
        <dl className="watch-checks">
          <div>
            <dt>Last check</dt>
            <dd>{watch?.lastCheckAt ? relativeTime(watch.lastCheckAt) : "Not yet"}</dd>
          </div>
          <div>
            <dt>Next check</dt>
            <dd>{watch?.nextCheckAt ? scheduleTime(watch.nextCheckAt) : "Unscheduled"}</dd>
          </div>
        </dl>
        {activity.length > 0 ? (
          <div className="activity-list">
            {activity.slice(0, 8).map((item) => (
              <article key={item.id}>
                <i />
                <span>
                  <strong>{activityLabel(item.eventType)}</strong>
                  <small>{timestampLabel(item.createdAt)}</small>
                </span>
              </article>
            ))}
          </div>
        ) : (
          <p className="set-note">Activity appears here as Captain works.</p>
        )}
      </div>

      <button
        type="button"
        className="remove-watchlist"
        disabled={removing}
        onClick={() => { void remove(); }}
      >
        {removing ? "Removing…" : "Remove from watchlist"}
      </button>
    </section>
  );
}

function FlightTimeline({ segments }: { segments: Segment[] }) {
  return (
    <ol className="flight-timeline">
      {segments.map((segment, index) => {
        const next = segments[index + 1];
        const travelSeconds = Math.max(
          0,
          (Date.parse(segment.arrival) - Date.parse(segment.departure)) / 1000
        );
        const layoverMs = next
          ? Date.parse(next.departure) - Date.parse(segment.arrival)
          : null;
        const showLayover = layoverMs !== null && Number.isFinite(layoverMs) && layoverMs > 0;
        return (
          <li key={`${segment.flightNumber}-${segment.departure}`} className="timeline-leg">
            <div className="timeline-node">
              <strong>{clockLabel(segment.departure)}</strong>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-node-body">
                <b>{segment.origin}</b>
              </div>
            </div>
            <div className="timeline-rail">
              <span className="timeline-rail-line" aria-hidden="true" />
              <p className="timeline-travel">Travel {formatDurationSeconds(travelSeconds)}</p>
            </div>
            <div className="timeline-node">
              <strong>{clockLabel(segment.arrival)}</strong>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-node-body">
                <b>{segment.destination}</b>
                <small>{segment.airline} · {segment.flightNumber}</small>
              </div>
            </div>
            {showLayover && (
              <p className="timeline-layover">
                {formatDurationSeconds(layoverMs / 1000)} layover · {segment.destination}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PeerPricePlot({
  comparison,
  currency
}: {
  comparison: { min: number; max: number; median: number; value: number };
  currency: string;
}) {
  const span = Math.max(comparison.max - comparison.min, 1);
  const position = Math.min(100, Math.max(0, ((comparison.value - comparison.min) / span) * 100));
  const medianPosition = Math.min(100, Math.max(0, ((comparison.median - comparison.min) / span) * 100));
  return (
    <div className="peer-plot" aria-label="Price compared with other verified options">
      <div className="peer-plot-track">
        <span className="peer-plot-fill" style={{ width: `${position}%` }} />
        <span className="peer-plot-median" style={{ left: `${medianPosition}%` }} title="Median" />
        <span className="peer-plot-pin" style={{ left: `${position}%` }} />
      </div>
      <div className="peer-plot-labels">
        <span>{formatMoney(comparison.min, currency)}</span>
        <span>{formatMoney(comparison.value, currency)}</span>
        <span>{formatMoney(comparison.max, currency)}</span>
      </div>
    </div>
  );
}

function AirlinesTab({
  offers,
  onChoose
}: {
  offers: VerifiedOffer[];
  onChoose: (airline: string) => void;
}) {
  const groups = useMemo(() => airlineGroups(offers), [offers]);
  if (groups.length === 0) return <ResultsEmpty />;
  return (
    <>
      <div className="airline-grid">
        {groups.map((group) => (
          <button className="airline-card" key={group.airline} onClick={() => onChoose(group.airline)}>
            <div className="airline-monogram">{group.airline.slice(0, 2)}</div>
            <div className="airline-card-title">
              <strong>{airlineName(group.airline, group.offers)}</strong>
              {group.mixed && <span className="pill">Mixed</span>}
            </div>
            {group.mixed && (
              <p className="carrier-list">
                Carriers: {[...new Set(group.offers.flatMap((offer) => offer.participatingAirlineCodes))].join(", ")}
              </p>
            )}
            <dl>
              <div><dt>Lowest fare</dt><dd>{money(group.cheapest)}</dd></div>
              <div><dt>Shortest</dt><dd>{duration(group.fastest)}</dd></div>
              <div><dt>Stops</dt><dd>{group.stopMix}</dd></div>
              <div><dt>Results</dt><dd>{group.offers.length}</dd></div>
            </dl>
            <p>Checked {relativeTime(group.latestVerified)}</p>
          </button>
        ))}
      </div>
    </>
  );
}

function BrowseTab({
  offers,
  preferences,
  filterOpen,
  draftPreferences,
  onOpenFilters,
  onDraftPreferences,
  onCloseFilters,
  onApplyFilters,
  onClearFilters,
  onOpen
}: {
  offers: VerifiedOffer[];
  preferences: BrowsePreferences;
  filterOpen: boolean;
  draftPreferences: BrowsePreferences;
  onOpenFilters: () => void;
  onDraftPreferences: Dispatch<SetStateAction<BrowsePreferences>>;
  onCloseFilters: () => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
  onOpen: (offer: VerifiedOffer) => void;
}) {
  const visible = useMemo(() => sortAndFilterOffers(offers, preferences), [offers, preferences]);
  const activeFilters = countFilters(preferences);
  if (offers.length === 0) return <ResultsEmpty />;
  return (
    <>
      <div className="browse-toolbar">
        <button
          className={`sort-filter-button ${activeFilters ? "active" : ""}`}
          onClick={onOpenFilters}
        >
          <span className="sort-filter-title">
            <FilterIcon />
            <strong>Sort &amp; filter</strong>
          </span>
          <span className="sort-filter-summary">
            <span>{sortLabel(preferences.sort)}</span>
            {activeFilters > 0 && <b>{activeFilters}</b>}
            <ChevronRightIcon />
          </span>
        </button>
      </div>
      {activeFilters > 0 && (
        <div className="active-filter-row" aria-label="Active filters">
          {filterChips(preferences).map((chip) => <span key={chip}>{chip}</span>)}
          <button onClick={onClearFilters}>Clear all</button>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="results-empty compact">
          <span>⌁</span>
          <h2>No matches</h2>
          <p>Adjust the current filters to see more flights.</p>
        </div>
      ) : (
        <div className="offer-list">
          {visible.map((offer) => (
            <OfferRow offer={offer} key={offer.id} onOpen={() => onOpen(offer)} />
          ))}
        </div>
      )}
      <FilterSheet
        open={filterOpen}
        preferences={draftPreferences}
        offers={offers}
        onPreferences={onDraftPreferences}
        onClose={onCloseFilters}
        onApply={onApplyFilters}
      />
    </>
  );
}

function OfferRow({ offer, onOpen }: { offer: VerifiedOffer; onOpen: () => void }) {
  const schedule = offerScheduleSpine(offer);
  return (
    <button type="button" className="recommendation-card" onClick={onOpen}>
      <div className="card-top">
        <span className="mode-label">{airlineName(offer.primaryAirlineCode, [offer])}</span>
        {isMixed(offer) && <span className="pill">Mixed</span>}
      </div>
      <strong className="price">{money(offer)}</strong>
      <div className="metrics">
        <span className="airline">{offer.primaryAirlineCode}</span>
        <span>{duration(offer)}</span>
        <span>{stops(offer)}</span>
      </div>
      {schedule ? <ScheduleSpine spine={schedule} /> : null}
    </button>
  );
}

function FilterSheet({
  open,
  preferences,
  offers,
  onPreferences,
  onClose,
  onApply
}: {
  open: boolean;
  preferences: BrowsePreferences;
  offers: VerifiedOffer[];
  onPreferences: Dispatch<SetStateAction<BrowsePreferences>>;
  onClose: () => void;
  onApply: () => void;
}) {
  const airlines = [...new Set(offers.map((offer) => offer.primaryAirlineCode))].sort();
  const airports = [...new Set(offers.flatMap(offerAirports))].sort();
  const hasDepartures = offers.some((offer) => offerDeparture(offer));
  const matches = sortAndFilterOffers(offers, preferences).length;
  function update<Key extends keyof BrowsePreferences>(key: Key, value: BrowsePreferences[Key]) {
    onPreferences((current) => ({ ...current, [key]: value }));
  }
  return (
    <div
      className="sheet-backdrop"
      data-open={open}
      aria-hidden={!open}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="bottom-sheet filter-sheet"
        role="dialog"
        aria-modal={open}
        aria-label="Sort and filter flights"
      >
        <header>
          <span>
            <strong>Sort &amp; filter</strong>
            <small>{matches} matching flight{matches === 1 ? "" : "s"}</small>
          </span>
          <button className="icon-button" aria-label="Close filters" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="sheet-scroll">
          <FilterGroup label="Sort">
            <select
              value={preferences.sort}
              onChange={(event) => update("sort", event.target.value as BrowsePreferences["sort"])}
            >
              <option value="recommended">Recommended</option>
              <option value="price">Lowest price</option>
              <option value="duration">Shortest duration</option>
              <option value="departure">Earliest departure</option>
            </select>
          </FilterGroup>
          <FilterGroup label="Stops">
            <div className="filter-choice-row">
              {[0, 1, 2].map((stops) => (
                <button
                  className={preferences.stops.includes(stops) ? "selected" : ""}
                  key={stops}
                  onClick={() => update("stops", toggle(preferences.stops, stops))}
                >
                  {stops === 0 ? "Direct" : `${stops} stop${stops === 1 ? "" : "s"}`}
                </button>
              ))}
            </div>
          </FilterGroup>
          {airlines.length > 0 && (
            <FilterGroup label="Airlines">
              <div className="filter-choice-row wrap">
                {airlines.map((airline) => (
                  <button
                    className={preferences.airlines.includes(airline) ? "selected" : ""}
                    key={airline}
                    onClick={() => update("airlines", toggle(preferences.airlines, airline))}
                  >
                    {airlineName(airline, offers)}
                  </button>
                ))}
              </div>
            </FilterGroup>
          )}
          {airports.length > 0 && (
            <FilterGroup label="Airports">
              <div className="filter-choice-row wrap">
                {airports.map((airport) => (
                  <button
                    className={preferences.airports.includes(airport) ? "selected" : ""}
                    key={airport}
                    onClick={() => update("airports", toggle(preferences.airports, airport))}
                  >
                    {airport}
                  </button>
                ))}
              </div>
            </FilterGroup>
          )}
          {hasDepartures && (
            <FilterGroup label="Departure">
              <div className="filter-choice-row">
                {(["morning", "afternoon", "evening"] as const).map((period) => (
                  <button
                    className={preferences.departurePeriods.includes(period) ? "selected" : ""}
                    key={period}
                    onClick={() => update("departurePeriods", toggle(preferences.departurePeriods, period))}
                  >
                    {period[0]!.toUpperCase() + period.slice(1)}
                  </button>
                ))}
              </div>
            </FilterGroup>
          )}
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
        <footer>
          <button className="secondary-action" onClick={() => onPreferences(EMPTY_BROWSE_PREFERENCES)}>
            Reset
          </button>
          <button className="primary-action" onClick={onApply}>
            Show {matches}
          </button>
        </footer>
      </section>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="filter-group"><strong>{label}</strong>{children}</div>;
}

function AirlineSearchSelect({
  values,
  placeholder,
  onChange,
  max = 12
}: {
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
  max?: number;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const suggestions = useMemo(() => searchAirlines(query, values), [query, values]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function add(code: string) {
    const normalized = normalizeAirlineCode(code);
    if (!normalized || values.includes(normalized) || values.length >= max) return;
    onChange([...values, normalized]);
    setQuery("");
    setOpen(false);
  }

  function remove(code: string) {
    onChange(values.filter((value) => value !== code));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const exact = suggestions.find((airline) => airline.code === query.trim().toUpperCase())
        ?? suggestions[0];
      if (exact) add(exact.code);
      else {
        const code = normalizeAirlineCode(query);
        if (code) add(code);
      }
    } else if (event.key === "Backspace" && !query && values.length > 0) {
      remove(values.at(-1)!);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="airline-search" ref={rootRef}>
      <div className={`airline-search-field ${open ? "open" : ""}`}>
        {values.map((code) => (
          <button
            type="button"
            className="airline-chip"
            key={code}
            onClick={() => remove(code)}
            aria-label={`Remove ${airlineLabel(code)}`}
          >
            <strong>{code}</strong>
            <span>{airlineLabel(code)}</span>
            <i aria-hidden="true">×</i>
          </button>
        ))}
        <input
          value={query}
          placeholder={values.length === 0 ? placeholder : "Add another"}
          disabled={values.length >= max}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && suggestions.length > 0 && values.length < max && (
        <ul className="airline-search-results" role="listbox">
          {suggestions.map((airline) => (
            <li key={airline.code}>
              <button type="button" onClick={() => add(airline.code)}>
                <strong>{airline.code}</strong>
                <span>{airline.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sortLabel(sort: BrowsePreferences["sort"]): string {
  return ({
    recommended: "Recommended",
    price: "Lowest price",
    duration: "Shortest",
    departure: "Earliest"
  })[sort];
}

function countFilters(preferences: BrowsePreferences): number {
  return preferences.stops.length
    + preferences.airlines.length
    + preferences.airports.length
    + preferences.departurePeriods.length
    + (preferences.maximumPrice === null ? 0 : 1);
}

function filterChips(preferences: BrowsePreferences): string[] {
  return [
    ...preferences.stops.map((stops) => stops === 0 ? "Direct" : `${stops} stop${stops === 1 ? "" : "s"}`),
    ...preferences.airlines,
    ...preferences.airports,
    ...preferences.departurePeriods.map((period) => period[0]!.toUpperCase() + period.slice(1)),
    ...(preferences.maximumPrice === null ? [] : [`Up to ${preferences.maximumPrice}`])
  ];
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function airlineName(code: string, offers: VerifiedOffer[]): string {
  for (const offer of offers) {
    for (const segment of offer.snapshot.segments ?? []) {
      if (segment.airlineCode === code && segment.airline.trim()) {
        return segment.airline.trim();
      }
    }
  }
  return code;
}

function agentRunningLabel(
  watch: TripPayload["watch"] | null | undefined,
  trip: TripPayload["trip"] | null
): string {
  if (!trip) return "";
  if (trip.status === "paused" || watch?.status === "paused") return "Paused";
  if (watch?.status === "scheduled" && watch.trackingStartsAt) {
    return `Scheduled · starts ${dateLabel(watch.trackingStartsAt.slice(0, 10))}`;
  }
  if (watch?.nextCheckAt) {
    const next = scheduleTime(watch.nextCheckAt);
    return next === "Due now" ? "Checking soon" : `Next check ${next.toLowerCase()}`;
  }
  if (watch?.lastCheckAt) return `Checked ${relativeTime(watch.lastCheckAt)}`;
  return "Tracking";
}

function trackingStateLabel(
  watch: TripPayload["watch"] | null,
  trip: NonNullable<TripPayload["trip"]>
): string {
  if (trip.status === "paused" || watch?.status === "paused") return "Paused";
  if (watch?.status === "scheduled" && watch.trackingStartsAt) {
    return `Scheduled — starts ${dateLabel(watch.trackingStartsAt.slice(0, 10))}`;
  }
  return "Active";
}

function notificationModeLabel(mode: TravellerProfile["notificationMode"]): string {
  return ({
    smart: "Smart",
    daily: "Daily",
    changes_only: "Changes only",
    off: "Off"
  })[mode];
}

function notificationModeDescription(mode: TravellerProfile["notificationMode"]): string {
  return ({
    smart: "One useful daily update while active, with important changes sooner near departure.",
    daily: "One combined update every active day.",
    changes_only: "Only baselines, activations, and meaningful changes.",
    off: "Keep tracking silently without Telegram updates."
  })[mode];
}

function TripControls({
  data,
  onChanged,
  onCancelled,
  onError
}: {
  data: TripPayload;
  onChanged: () => Promise<void>;
  onCancelled: () => void;
  onError: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const trip = data.trip!;
  async function act(type: "pause" | "resume" | "refresh" | "cancel") {
    setBusy(true);
    onError("");
    try {
      await tripAction(type, trip.id, trip.version);
      if (type === "cancel") {
        onCancelled();
        return;
      }
      await onChanged();
    } catch (cause) {
      const retry = cause instanceof ApiError && cause.status === 429;
      onError(retry
        ? "Manual refresh is available once every six hours. Captain will keep checking automatically."
        : "That action didn’t complete. Reload and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="trip-controls">
      <button disabled={busy} onClick={() => void act(trip.status === "paused" ? "resume" : "pause")}>
        {trip.status === "paused" ? "Resume" : "Pause"}
      </button>
      <button className="primary" disabled={busy || trip.status === "paused"} onClick={() => void act("refresh")}>
        Refresh
      </button>
      <button
        className="danger"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Stop tracking ${routeLabel(trip)}?`)) void act("cancel");
        }}
      >
        Stop
      </button>
    </div>
  );
}

function Preferences({
  profile,
  tripData,
  displayName,
  trackingError,
  onSaved,
  onTripChanged,
  onTripError,
  onBack
}: {
  profile: TravellerProfile;
  tripData: TripPayload | null;
  displayName: string;
  trackingError: string;
  onSaved: (profile: TravellerProfile) => void;
  onTripChanged: () => Promise<void>;
  onTripError: (value: string) => void;
  onBack: () => void;
}) {
  const [currency, setCurrency] = useState(profile.defaultCurrency);
  const [timeZone, setTimeZone] = useState(profile.timeZone);
  const [ranking, setRanking] = useState(profile.rankingMode);
  const [preferred, setPreferred] = useState<string[]>(profile.preferredAirlineCodes);
  const [excluded, setExcluded] = useState<string[]>(profile.excludedAirlineCodes);
  const [notificationMode, setNotificationMode] = useState(profile.notificationMode);
  const [digestHour, setDigestHour] = useState(profile.digestHourLocal);
  const [priceRiseAlerts, setPriceRiseAlerts] = useState(profile.priceRiseAlertsEnabled);
  const [betterOptionAlerts, setBetterOptionAlerts] = useState(profile.betterOptionAlertsEnabled);
  const [trackingCheckins, setTrackingCheckins] = useState(profile.trackingCheckinsEnabled);
  const [maxAlerts, setMaxAlerts] = useState<1 | 2>(profile.maxAlertsPerDay);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(profile.quietHoursEnabled);
  const [quietStart, setQuietStart] = useState(profile.quietHoursStart);
  const [quietEnd, setQuietEnd] = useState(profile.quietHoursEnd);
  const [brief, setBrief] = useState(() => {
    const current = tripData?.trip?.brief;
    if (!current) return null;
    return {
      ...current,
      context: /^Prepared from confirmed Captain Trip draft\b/iu.test(current.context)
        ? ""
        : current.context
    };
  });
  const [tripStopped, setTripStopped] = useState(false);
  const [saved, setSaved] = useState<"preferences" | "notifications" | "brief" | "">("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const airportCodes = (value: string) => [...new Set(
    value.toUpperCase().match(/[A-Z]{3}/gu) ?? []
  )].slice(0, 6);
  async function saveProfile(
    event: FormEvent,
    section: "preferences" | "notifications"
  ) {
    event.preventDefault();
    setBusy(true);
    setSaved("");
    setSaveError("");
    try {
      const next = await updateProfile({
        defaultCurrency: currency.toUpperCase(),
        timeZone,
        rankingMode: ranking,
        preferredAirlineCodes: preferred.slice(0, 12),
        excludedAirlineCodes: excluded.slice(0, 12),
        alertsEnabled: notificationMode !== "off",
        notificationMode,
        digestHourLocal: digestHour,
        priceRiseAlertsEnabled: priceRiseAlerts,
        betterOptionAlertsEnabled: betterOptionAlerts,
        trackingCheckinsEnabled: trackingCheckins,
        maxAlertsPerDay: maxAlerts,
        quietHoursEnabled,
        quietHoursStart: quietStart,
        quietHoursEnd: quietEnd
      });
      onSaved(next);
      setSaved(section);
    } catch {
      setSaveError("Captain couldn’t save these settings. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function saveBrief(event: FormEvent) {
    event.preventDefault();
    const trip = tripData?.trip;
    if (!trip || !brief) return;
    setBusy(true);
    setSaved("");
    setSaveError("");
    try {
      await updateTripBrief(trip.id, trip.version, brief);
      setSaved("brief");
      await onTripChanged();
    } catch (cause) {
      setSaveError(cause instanceof ApiError && cause.status === 409
        ? "This Trip changed elsewhere. Reload it from Telegram before editing."
        : "Captain couldn’t update this Trip brief. Check the fields and try again.");
    } finally {
      setBusy(false);
    }
  }
  const trip = tripStopped ? null : tripData?.trip ?? null;
  const watch = tripStopped ? null : tripData?.watch ?? null;
  return (
    <main className="settings-shell">
      <header className="topbar">
        {tripStopped
          ? <span className="back-link inactive">Trip stopped</span>
          : <button className="back-link" onClick={onBack}>← Trip</button>}
        <span className="name">{displayName}</span>
      </header>
      <section className="settings-intro">
        <h1>{trip ? routeLabel(trip) : "Captain"}</h1>
        <p>{trip
          ? dateRangeLabel(trip.brief.departureWindow.start, trip.brief.departureWindow.end)
          : "Trip tracking has stopped. Choose another Trip from Telegram."}</p>
      </section>
      {trip && tripData && (
        <details className="settings-card settings-disclosure" open>
          <summary>
            <span><strong>Tracking</strong></span>
            <em>{trackingStateLabel(watch, trip)}</em>
          </summary>
          <div className="settings-body tracking-settings">
            <dl className="settings-list">
              <div><dt>Last check</dt><dd>{watch?.lastCheckAt ? relativeTime(watch.lastCheckAt) : "Not checked yet"}</dd></div>
              <div>
                <dt>{watch?.status === "scheduled" ? "Tracking starts" : "Next check"}</dt>
                <dd>{watch?.nextCheckAt ? scheduleTime(watch.nextCheckAt) : "Not scheduled"}</dd>
              </div>
              <div><dt>Flights</dt><dd>{tripData.offers.length}</dd></div>
            </dl>
            <p>Captain checks more often as departure approaches. Manual refresh is available once every six hours.</p>
            {trackingError && <p className="form-error" role="alert">{trackingError}</p>}
            <TripControls
              data={tripData}
              onChanged={onTripChanged}
              onCancelled={() => setTripStopped(true)}
              onError={onTripError}
            />
          </div>
        </details>
      )}
      {trip && brief && (
        <details className="settings-card settings-disclosure">
          <summary>
            <span><strong>Trip brief</strong></span>
            <em>{dateLabel(brief.departureWindow.start)}</em>
          </summary>
          <div className="settings-body">
            <p>Editing the brief starts a fresh verified search for this Trip.</p>
            <form onSubmit={(event) => void saveBrief(event)}>
              {brief.tripType === "multi_city" ? (
                <div className="read-only-field">
                  <span>Route</span>
                  <strong>{routeLabel(trip)}</strong>
                  <small>Change multi-city routes in Telegram.</small>
                </div>
              ) : (
                <div className="form-grid two">
                  <label>
                    From
                    <input
                      value={brief.originAirports.join(", ")}
                      onChange={(event) => setBrief({
                        ...brief,
                        originAirports: airportCodes(event.target.value)
                      })}
                    />
                  </label>
                  <label>
                    To
                    <input
                      value={brief.destinationAirports.join(", ")}
                      onChange={(event) => setBrief({
                        ...brief,
                        destinationAirports: airportCodes(event.target.value)
                      })}
                    />
                  </label>
                </div>
              )}
              {brief.tripType !== "multi_city" && (
                <div className="form-grid two">
                  <label>
                    Earliest departure
                    <input
                      type="date"
                      value={brief.departureWindow.start}
                      onChange={(event) => setBrief({
                        ...brief,
                        departureWindow: { ...brief.departureWindow, start: event.target.value }
                      })}
                    />
                  </label>
                  <label>
                    Latest departure
                    <input
                      type="date"
                      value={brief.departureWindow.end}
                      onChange={(event) => setBrief({
                        ...brief,
                        departureWindow: { ...brief.departureWindow, end: event.target.value }
                      })}
                    />
                  </label>
                </div>
              )}
              {brief.tripType === "round_trip" && brief.stayNights && (
                <div className="form-grid three">
                  {(["minimum", "preferred", "maximum"] as const).map((key) => (
                    <label key={key}>
                      {label(key)} nights
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={brief.stayNights![key]}
                        onChange={(event) => setBrief({
                          ...brief,
                          stayNights: {
                            ...brief.stayNights!,
                            [key]: Number(event.target.value)
                          }
                        })}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="form-grid two">
                <label>
                  Cabin
                  <select value={brief.cabin} onChange={(event) => setBrief({
                    ...brief,
                    cabin: event.target.value
                  })}>
                    <option value="economy">Economy</option>
                    <option value="premium_economy">Premium economy</option>
                    <option value="business">Business</option>
                    <option value="first">First</option>
                  </select>
                </label>
                <label>
                  Stops
                  <select value={brief.maxStops} onChange={(event) => setBrief({
                    ...brief,
                    maxStops: Number(event.target.value)
                  })}>
                    <option value={0}>Direct only</option>
                    <option value={1}>Up to 1</option>
                    <option value={2}>Up to 2</option>
                  </select>
                </label>
              </div>
              <div className="form-grid two">
                <label>
                  Currency
                  <input
                    value={brief.currency}
                    maxLength={3}
                    pattern="[A-Za-z]{3}"
                    onChange={(event) => setBrief({
                      ...brief,
                      currency: event.target.value.toUpperCase()
                    })}
                  />
                </label>
                <label>
                  Maximum fare
                  <input
                    type="number"
                    min={1}
                    placeholder="No maximum"
                    value={brief.maximumPrice ?? ""}
                    onChange={(event) => setBrief({
                      ...brief,
                      maximumPrice: event.target.value ? Number(event.target.value) : null
                    })}
                  />
                </label>
              </div>
              <label>
                Preferred airlines for this Trip
                <AirlineSearchSelect
                  values={brief.preferredAirlines}
                  placeholder="Search airlines"
                  onChange={(preferredAirlines) => setBrief({ ...brief, preferredAirlines })}
                />
              </label>
              <label>
                Avoid airlines for this Trip
                <AirlineSearchSelect
                  values={brief.excludedAirlines}
                  placeholder="Search airlines to avoid"
                  onChange={(excludedAirlines) => setBrief({ ...brief, excludedAirlines })}
                />
              </label>
              <label>
                Notes for Captain
                <textarea
                  value={brief.context}
                  maxLength={1000}
                  placeholder="Timing or airport constraints"
                  onChange={(event) => setBrief({ ...brief, context: event.target.value })}
                />
              </label>
              {saveError && <p className="form-error" role="alert">{saveError}</p>}
              <button className="save-button" disabled={busy}>
                {busy ? "Saving…" : saved === "brief" ? "Trip updated" : "Update Trip"}
              </button>
            </form>
          </div>
        </details>
      )}
      <details className="settings-card settings-disclosure">
        <summary>
          <span><strong>Notifications</strong></span>
          <em>{notificationModeLabel(notificationMode)}</em>
        </summary>
        <div className="settings-body">
          <form onSubmit={(event) => void saveProfile(event, "notifications")}>
            <label>
              Notification mode
              <select
                value={notificationMode}
                onChange={(event) => setNotificationMode(
                  event.target.value as TravellerProfile["notificationMode"]
                )}
              >
                <option value="smart">Smart</option>
                <option value="daily">Daily</option>
                <option value="changes_only">Changes only</option>
                <option value="off">Off</option>
              </select>
              <small>{notificationModeDescription(notificationMode)}</small>
            </label>
            <label>
              Daily update time
              <input
                type="time"
                step={3600}
                disabled={!["smart", "daily"].includes(notificationMode)}
                value={`${String(digestHour).padStart(2, "0")}:00`}
                onChange={(event) => setDigestHour(Number(event.target.value.slice(0, 2)))}
              />
            </label>
            <label className="switch-setting">
              <span><strong>Price rise alerts</strong><small>Warn when the watched option rises meaningfully.</small></span>
              <input
                type="checkbox"
                role="switch"
                disabled={notificationMode === "off"}
                checked={priceRiseAlerts}
                onChange={(event) => setPriceRiseAlerts(event.target.checked)}
              />
            </label>
            <label className="switch-setting">
              <span><strong>Better option alerts</strong><small>Tell me when Captain finds a meaningfully better flight.</small></span>
              <input
                type="checkbox"
                role="switch"
                disabled={notificationMode === "off"}
                checked={betterOptionAlerts}
                onChange={(event) => setBetterOptionAlerts(event.target.checked)}
              />
            </label>
            <label className="switch-setting">
              <span><strong>Tracking check-ins</strong><small>Ask after seven quiet days before pausing.</small></span>
              <input
                type="checkbox"
                role="switch"
                disabled={notificationMode === "off"}
                checked={trackingCheckins}
                onChange={(event) => setTrackingCheckins(event.target.checked)}
              />
            </label>
            <label>
              Immediate alert limit
              <select
                value={maxAlerts}
                disabled={notificationMode === "off"}
                onChange={(event) => setMaxAlerts(Number(event.target.value) as 1 | 2)}
              >
                <option value={1}>1 in 24 hours</option>
                <option value={2}>2 in 24 hours</option>
              </select>
            </label>
            <label className="switch-setting">
              <span><strong>Quiet hours</strong><small>Hold Telegram fare alerts during this window.</small></span>
              <input
                type="checkbox"
                role="switch"
                checked={quietHoursEnabled}
                onChange={(event) => setQuietHoursEnabled(event.target.checked)}
              />
            </label>
            <div className="form-grid two">
              <label>
                From
                <input
                  type="time"
                  step={3600}
                  disabled={!quietHoursEnabled}
                  value={`${String(quietStart).padStart(2, "0")}:00`}
                  onChange={(event) => setQuietStart(Number(event.target.value.slice(0, 2)))}
                />
              </label>
              <label>
                Until
                <input
                  type="time"
                  step={3600}
                  disabled={!quietHoursEnabled}
                  value={`${String(quietEnd).padStart(2, "0")}:00`}
                  onChange={(event) => setQuietEnd(Number(event.target.value.slice(0, 2)))}
                />
              </label>
            </div>
            {saveError && <p className="form-error" role="alert">{saveError}</p>}
            <button className="save-button" disabled={busy}>
              {busy ? "Saving…" : saved === "notifications" ? "Saved" : "Save notifications"}
            </button>
          </form>
        </div>
      </details>
      <details className="settings-card settings-disclosure">
        <summary>
          <span><strong>Flight preferences</strong></span>
          <em>{label(ranking)}</em>
        </summary>
        <div className="settings-body">
          <form onSubmit={(event) => void saveProfile(event, "preferences")}>
          <label>
            Default currency
            <input value={currency} maxLength={3} pattern="[A-Za-z]{3}" onChange={(event) => setCurrency(event.target.value)} />
            <small>Captain never converts a fare between currencies.</small>
          </label>
          <label>
            Timezone
            <input
              value={timeZone}
              list="captain-timezones"
              onChange={(event) => setTimeZone(event.target.value)}
            />
            <datalist id="captain-timezones">
              <option value="Africa/Lagos" />
              <option value="Africa/Dar_es_Salaam" />
              <option value="Europe/London" />
              <option value="America/New_York" />
              <option value="UTC" />
            </datalist>
            <small>Used to resolve “today”, “tomorrow”, and weekdays in Telegram.</small>
          </label>
          <fieldset>
            <legend>How should Captain rank flights?</legend>
            <div className="ranking-options">
              {(["cheapest", "balanced", "fastest"] as RankingMode[]).map((mode) => (
                <label className={ranking === mode ? "checked" : ""} key={mode}>
                  <input type="radio" name="ranking" checked={ranking === mode} onChange={() => setRanking(mode)} />
                  <strong>{label(mode)}</strong>
                  <span>{mode === "balanced" ? "Fare, time and stops" : mode === "cheapest" ? "Lowest verified fare" : "Shortest journey"}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Preferred airlines
            <AirlineSearchSelect
              values={preferred}
              placeholder="Search airlines"
              onChange={setPreferred}
            />
          </label>
          <label>
            Avoid airlines
            <AirlineSearchSelect
              values={excluded}
              placeholder="Search airlines to avoid"
              onChange={setExcluded}
            />
            <small>Any itinerary using an avoided airline is removed.</small>
          </label>
          {saveError && <p className="form-error" role="alert">{saveError}</p>}
          <button className="save-button" disabled={busy}>
            {busy ? "Saving…" : saved === "preferences" ? "Saved" : "Save preferences"}
          </button>
        </form>
        </div>
      </details>
      {trip && (
        <details className="settings-card settings-disclosure">
          <summary>
            <span><strong>Activity</strong></span>
            <em>{tripData?.activity.length ?? 0}</em>
          </summary>
          <div className="settings-body">
            {(tripData?.activity.length ?? 0) > 0 ? (
              <div className="activity-list">
                {tripData!.activity.map((item) => (
                  <article key={item.id}>
                    <i />
                    <span>
                      <strong>{activityLabel(item.eventType)}</strong>
                      <small>{timestampLabel(item.createdAt)}</small>
                    </span>
                  </article>
                ))}
              </div>
            ) : <p>Activity appears here as Captain works.</p>}
          </div>
        </details>
      )}
    </main>
  );
}

function CenteredState({ title, detail }: { title: string; detail: string }) {
  return <main className="centered"><span className="brand-mark">C</span><h1>{title}</h1><p>{detail}</p></main>;
}

function ResultsEmpty() {
  return (
    <div className="results-empty">
      <span>⌁</span>
      <h2>No verified results yet</h2>
      <p>Captain only shows fares when two web checks agree on the route, dates, segments, airline, cabin, price, currency and evidence.</p>
    </div>
  );
}

function rankOffers(offers: VerifiedOffer[], mode: RankingMode, preferred: string[]): VerifiedOffer[] {
  if (offers.length === 0) return [];
  const minimumPrice = Math.min(...offers.map((offer) => offer.price));
  const positiveDurations = offers.map(durationSeconds).filter((value) => value > 0);
  const minimumDuration = positiveDurations.length ? Math.min(...positiveDurations) : 1;
  const maximumStops = Math.max(1, ...offers.map(stopCount));
  const score = (offer: VerifiedOffer) => {
    if (mode === "cheapest") return offer.price;
    if (mode === "fastest") return durationSeconds(offer);
    const priceRegret = Math.min(1, Math.max(0, offer.price / Math.max(minimumPrice, 0.001) - 1));
    const timeRegret = Math.min(1, Math.max(0, durationSeconds(offer) / minimumDuration - 1));
    return Math.max(0, priceRegret * .5 + timeRegret * .35 + stopCount(offer) / maximumStops * .15
      - (preferred.includes(offer.primaryAirlineCode) ? .05 : 0));
  };
  const preferredTie = (offer: VerifiedOffer) =>
    preferred.includes(offer.primaryAirlineCode) ? 0 : 1;
  return [...offers].sort((left, right) => {
    if (mode === "cheapest") {
      return left.price - right.price
        || durationSeconds(left) - durationSeconds(right)
        || stopCount(left) - stopCount(right)
        || preferredTie(left) - preferredTie(right)
        || left.itineraryKey.localeCompare(right.itineraryKey);
    }
    if (mode === "fastest") {
      return durationSeconds(left) - durationSeconds(right)
        || left.price - right.price
        || stopCount(left) - stopCount(right)
        || preferredTie(left) - preferredTie(right)
        || left.itineraryKey.localeCompare(right.itineraryKey);
    }
    return score(left) - score(right)
      || preferredTie(left) - preferredTie(right)
      || left.price - right.price
      || durationSeconds(left) - durationSeconds(right)
      || left.itineraryKey.localeCompare(right.itineraryKey);
  });
}

function outboundSegments(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments;
  const origin = segments[0]!.origin;
  if (segments.at(-1)!.destination !== origin) return segments;
  let splitAfter = 0;
  let bestGap = -1;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const gap = Date.parse(segments[index + 1]!.departure) - Date.parse(segments[index]!.arrival);
    if (Number.isFinite(gap) && gap > bestGap) {
      bestGap = gap;
      splitAfter = index;
    }
  }
  return segments.slice(0, splitAfter + 1);
}

type ScheduleSpineData = {
  origin: string;
  departure: string;
  destination: string;
  arrival: string;
  stops: string[];
};

function offerScheduleSpine(offer: VerifiedOffer): ScheduleSpineData | null {
  const segments = outboundSegments(offer.snapshot.segments ?? []);
  if (segments.length === 0) return null;
  const first = segments[0]!;
  const last = segments.at(-1)!;
  const dayOffset = calendarDayOffset(first.departure, last.arrival);
  return {
    origin: first.origin,
    departure: clockLabel(first.departure),
    destination: last.destination,
    arrival: `${clockLabel(last.arrival)}${dayOffset > 0 ? `+${dayOffset}` : ""}`,
    stops: segments.slice(0, -1).map((segment) => segment.destination)
  };
}

function ScheduleSpine({ spine }: { spine: ScheduleSpineData }) {
  const points = [
    { key: "origin", label: `${spine.origin} ${spine.departure}`, kind: "end" as const },
    ...spine.stops.map((airport, index) => ({
      key: `stop-${airport}-${index}`,
      label: airport,
      kind: "stop" as const
    })),
    { key: "destination", label: `${spine.arrival} ${spine.destination}`, kind: "end" as const }
  ];
  return (
    <div className="schedule-line" aria-label={`${spine.origin} to ${spine.destination}`}>
      {points.map((point, index) => (
        <Fragment key={point.key}>
          {index > 0 ? <span className="schedule-connector" aria-hidden="true" /> : null}
          <span className={`schedule-point schedule-point-${point.kind}`}>{point.label}</span>
        </Fragment>
      ))}
    </div>
  );
}

function clockLabel(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function calendarDayOffset(start: string, end: string): number {
  const startDay = Date.UTC(
    new Date(start).getFullYear(),
    new Date(start).getMonth(),
    new Date(start).getDate()
  );
  const endDay = Date.UTC(
    new Date(end).getFullYear(),
    new Date(end).getMonth(),
    new Date(end).getDate()
  );
  return Math.max(0, Math.round((endDay - startDay) / 86_400_000));
}

function peerPriceComparison(offer: VerifiedOffer, offers: VerifiedOffer[]) {
  const prices = offers.map((item) => item.price).sort((left, right) => left - right);
  const min = prices[0] ?? offer.price;
  const max = prices.at(-1) ?? offer.price;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length === 0
    ? offer.price
    : prices.length % 2 === 0
      ? ((prices[mid - 1] ?? offer.price) + (prices[mid] ?? offer.price)) / 2
      : prices[mid] ?? offer.price;
  return { min, max, median, value: offer.price };
}

function formatDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function routeLabel(trip: NonNullable<TripPayload["trip"]>): string {
  const legs = trip.brief.legs ?? [];
  return trip.brief.tripType === "multi_city" && legs.length > 0
    ? [legs[0]!.originAirports.join("/"), ...legs.map((leg) => leg.destinationAirports.join("/"))].join(" → ")
    : `${trip.brief.originAirports.join("/")} → ${trip.brief.destinationAirports.join("/")}`;
}

function durationSeconds(offer: VerifiedOffer): number {
  return Number(offer.snapshot.durationSeconds) || 0;
}
function stopCount(offer: VerifiedOffer): number {
  const outbound = outboundSegments(offer.snapshot.segments ?? []);
  if (outbound.length > 0) return Math.max(0, outbound.length - 1);
  return Number(offer.snapshot.stops) || 0;
}
function duration(offer: VerifiedOffer): string {
  const seconds = durationSeconds(offer);
  return seconds ? `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m` : "Time unavailable";
}
function stops(offer: VerifiedOffer): string {
  const count = stopCount(offer);
  return count === 0 ? "Nonstop" : `${count} stop${count === 1 ? "" : "s"}`;
}
function isMixed(offer: VerifiedOffer): boolean {
  return offer.participatingAirlineCodes.length > 1;
}
function money(offer: VerifiedOffer): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: offer.currency }).format(offer.price);
  } catch {
    return `${offer.currency} ${offer.priceAmount}`;
  }
}
function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : dateLabel(value.slice(0, 10));
}
function scheduleTime(value: string): string {
  const difference = Date.parse(value) - Date.now();
  if (difference <= 60_000) return "Due now";
  const minutes = Math.round(difference / 60_000);
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `In ${hours}h` : dateLabel(value.slice(0, 10));
}
function timestampLabel(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
function activityLabel(eventType: string): string {
  const labels: Record<string, string> = {
    trip_created: "Trip tracking started",
    trip_brief_updated: "Trip brief updated",
    trip_pause: "Tracking paused",
    trip_resume: "Tracking resumed",
    trip_refresh: "Manual check requested",
    trip_cancel: "Tracking stopped",
    trip_complete: "Trip completed"
  };
  return labels[eventType] ?? label(eventType);
}
function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T12:00:00Z`));
}
function dateRangeLabel(start: string, end: string): string {
  if (start === end) return dateLabel(start);
  return `${dateLabel(start)} – ${dateLabel(end)}`;
}
function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
