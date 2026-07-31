import { useEffect, useMemo, useState, Fragment, type Dispatch, type SetStateAction } from "react";

import {
  ApiError,
  accessHref,
  getProfile,
  getSession,
  getTrip,
  initializeAccessToken,
  setTripFlightSelection
} from "./api";
import {
  EMPTY_BROWSE_PREFERENCES,
  sortAndFilterOffers,
  type BrowsePreferences,
  type RankingMode,
  type Segment,
  type TravellerProfile,
  type TripPayload,
  type VerifiedOffer,
  type Watch
} from "./domain";
import { airlineGroups } from "./airline-groups";
import {
  activityLabel,
  airlineName,
  calendarDayOffset,
  clockLabel,
  countFilters,
  dateLabel,
  duration,
  durationSeconds,
  filterChips,
  formatDurationSeconds,
  formatMoney,
  isMixed,
  label,
  money,
  outboundSegments,
  peerPriceComparison,
  relativeTime,
  routeLabel,
  scheduleTime,
  sortLabel,
  stopCount,
  stops,
  timestampLabel
} from "./format";
import { ChevronRightIcon, FilterIcon } from "./components/icons";
import { FilterSheet } from "./components/FilterSheet";
import { Preferences } from "./screens/Preferences";

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

  if (loading) return <CenteredState title="Opening Captain…" detail="Loading your trip." />;
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
          <p className="eyebrow">No active trip</p>
          <h1>Tell Captain where you want to go.</h1>
          <p>Return to Telegram to create a trip. Captain can track up to three at once.</p>
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
        <p className="set-note">Among verified options for this trip.</p>
      </div>

      <div className="watchlist-panel">
        <h2>Sources</h2>
        {offer.evidence.length > 0 ? (
          <table className="sources-table">
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

function CenteredState({ title, detail }: { title: string; detail: string }) {
  return <main className="centered"><span className="brand-mark">C</span><h1>{title}</h1><p>{detail}</p></main>;
}

function ResultsEmpty() {
  return (
    <div className="results-empty">
      <span>⌁</span>
      <h2>No flights found</h2>
      <p>Captain is checking the internet for flights. You’ll get a notification in Telegram when new options come up.</p>
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
