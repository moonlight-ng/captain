import { useEffect, useMemo, useState, Fragment, type Dispatch, type SetStateAction } from "react";

import {
  ApiError,
  accessHref,
  getProfile,
  getSession,
  getTrip,
  initializeAccessToken,
  setTripFlightSelection,
  tripAction
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
  durationRange,
  durationSeconds,
  filterChips,
  formatDurationSeconds,
  formatMoney,
  isMixed,
  label,
  money,
  moneyRange,
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
import { ChevronRightIcon, FilterIcon, FlightIcon, SearchRadarIcon } from "./components/icons";
import { FilterSheet } from "./components/FilterSheet";
import {
  createMockBooking,
  readMockBooking,
  removeMockBooking,
  writeMockBooking,
  type MockBooking
} from "./mock-booking";
import { BookedFlight } from "./screens/BookedFlight";
import { Preferences } from "./screens/Preferences";

type Tab = "flights" | "airlines" | "browse";
const tabLabels: Record<Tab, string> = {
  flights: "Top picks",
  airlines: "Airlines",
  browse: "All flights"
};

type Page = "trip" | "profile";

function currentPage(): Page {
  return ["/profile", "/settings", "/preferences", "/travellers", "/payment"].includes(
    window.location.pathname
  ) ? "profile" : "trip";
}

function currentTripId(): string | undefined {
  const match = /^\/trip\/([^/]+)\/?$/u.exec(window.location.pathname);
  if (match?.[1]) return decodeURIComponent(match[1]);
  return new URLSearchParams(window.location.search).get("trip") ?? undefined;
}

type WatchlistFocus = {
  offerId: string;
  mode?: RankingMode;
};

export function App() {
  const [profile, setProfile] = useState<TravellerProfile | null>(null);
  const [tripData, setTripData] = useState<TripPayload | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [credential, setCredential] = useState<"session" | "legacy-bearer" | null>(null);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("flights");
  const [browsePreferences, setBrowsePreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftPreferences, setDraftPreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [watchlistFocus, setWatchlistFocus] = useState<WatchlistFocus | null>(null);
  const [dismissedItineraryKeys, setDismissedItineraryKeys] = useState<string[]>([]);
  const [watchedOfferCache, setWatchedOfferCache] = useState<Record<string, VerifiedOffer>>({});
  const [searchBusy, setSearchBusy] = useState(false);
  const [mockBooking, setMockBooking] = useState<MockBooking | null>(null);
  const page = currentPage();

  async function load() {
    setLoading(true);
    setError("");
    try {
      initializeAccessToken();
      const session = await getSession();
      setDisplayName(session.displayName);
      setPaymentsEnabled(session.paymentsEnabled);
      setCredential(session.credential);
      setAuthenticated(true);
      const requestedTripId = currentTripId();
      const [nextProfile, nextTrip] = await Promise.all([
        getProfile(),
        getTrip(requestedTripId)
      ]);
      setProfile(nextProfile);
      setTripData(nextTrip);
      if (
        nextTrip.trip
        && window.location.pathname === "/trip"
        && new URLSearchParams(window.location.search).has("trip")
      ) {
        window.history.replaceState(null, "", accessHref("/trip", nextTrip.trip.id));
      }
    } catch (cause) {
      setAuthenticated(false);
      if (!(cause instanceof ApiError && cause.status === 401)) {
        setError("Captain couldn’t load this page.");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (["/settings", "/preferences", "/travellers", "/payment"].includes(window.location.pathname)) {
      window.history.replaceState(null, "", `/profile${window.location.search}${window.location.hash}`);
    }
    void load();
  }, []);

  const trip = tripData?.trip ?? null;
  const watch = tripData?.watch ?? null;
  const searching = searchBusy || isWatchSearching(watch, trip);

  useEffect(() => {
    setMockBooking(trip?.id ? readMockBooking(trip.id) : null);
  }, [trip?.id]);

  useEffect(() => {
    if ((!searching && watch?.status !== "active") || !trip) return;
    let cancelled = false;
    const tripId = trip.id;
    const tick = async () => {
      try {
        const next = await getTrip(tripId);
        if (cancelled) return;
        setTripData((current) => {
          // Keep the last good offer set while a refresh briefly returns none.
          if (next.offers.length === 0 && (current?.offers.length ?? 0) > 0) {
            return { ...next, offers: current!.offers };
          }
          return next;
        });
      } catch {
        /* keep current trip data while the search runs */
      }
    };
    const id = window.setInterval(() => { void tick(); }, searching ? 4000 : 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [searching, trip?.id, watch?.status]);

  const personSelectionKeys = useMemo(
    () => [...new Set(
      (tripData?.selections ?? [])
        .filter((item) => item.selectedBy === "person")
        .map((item) => item.itineraryKey)
    )],
    [tripData?.selections]
  );

  useEffect(() => {
    if (!trip?.id) {
      setWatchedOfferCache({});
      return;
    }
    const liveOffers = tripData?.offers ?? [];
    const selected = new Set(personSelectionKeys);
    const stored = readWatchedOfferCache(trip.id);
    setWatchedOfferCache((current) => {
      const next: Record<string, VerifiedOffer> = {};
      for (const key of selected) {
        const live = liveOffers.find((offer) => offer.itineraryKey === key);
        if (live) next[key] = live;
        else if (current[key]) next[key] = current[key];
        else if (stored[key]) next[key] = stored[key];
      }
      writeWatchedOfferCache(trip.id, next);
      return next;
    });
  }, [trip?.id, personSelectionKeys, tripData?.offers]);

  const offers = tripData?.offers ?? [];
  const watchedOffers = useMemo(() => {
    const items: VerifiedOffer[] = [];
    for (const key of personSelectionKeys) {
      const offer = watchedOfferCache[key]
        ?? offers.find((item) => item.itineraryKey === key);
      if (offer) items.push(offer);
    }
    return items;
  }, [personSelectionKeys, watchedOfferCache, offers]);

  if (loading) return <CenteredState title="Opening Captain…" detail="Loading your trip." />;
  if (!authenticated) {
    return (
      <CenteredState
        title="Open Captain from Telegram"
        detail={error || "Use Open trip or Profile from Captain in Telegram."}
      />
    );
  }
  if (page === "profile" && profile) {
    return (
      <Preferences
        profile={profile}
        tripData={tripData}
        displayName={displayName}
        trackingError={error}
        sessionCredential={credential === "session"}
        paymentsEnabled={paymentsEnabled}
        onSaved={setProfile}
        onTripChanged={load}
        onTripError={setError}
        onBack={() => { window.location.href = accessHref("/trip", tripData?.trip?.id); }}
      />
    );
  }

  const needsManualSearch = Boolean(
    trip && trip.status !== "paused" && watch?.status === "scheduled"
  );

  async function searchFlights() {
    if (!trip) return;
    setSearchBusy(true);
    setError("");
    try {
      await tripAction("refresh", trip.id, trip.version);
      const next = await getTrip(trip.id);
      setTripData((current) => {
        if (next.offers.length === 0 && (current?.offers.length ?? 0) > 0) {
          return { ...next, offers: current!.offers };
        }
        return next;
      });
    } catch {
      setError("That search didn’t start. Try again.");
    } finally {
      setSearchBusy(false);
    }
  }

  async function trackPrices() {
    if (!trip) return;
    setSearchBusy(true);
    setError("");
    try {
      await tripAction("track", trip.id, trip.version);
      const next = await getTrip(trip.id);
      setTripData(next);
    } catch {
      setError("That tracking run didn’t start. Try again.");
    } finally {
      setSearchBusy(false);
    }
  }

  const emptySearch = {
    needsManualSearch,
    searching,
    completed: watch?.status === "completed",
    busy: searchBusy,
    onSearch: () => { void searchFlights(); }
  };

  const focusOffer = watchlistFocus
    ? offers.find((item) => item.id === watchlistFocus.offerId)
      ?? watchedOffers.find((item) => item.id === watchlistFocus.offerId)
      ?? null
    : null;
  const focusWatching = Boolean(
    focusOffer
    && personSelectionKeys.includes(focusOffer.itineraryKey)
  );

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href={accessHref("/trip", trip?.id)} aria-label="Captain home">
          <span className="brand-mark">C</span>
          <span>Captain</span>
        </a>
        <div className="top-actions">
          <span className="name">{mockBooking ? "Mock booking" : agentRunningLabel(tripData?.watch, trip)}</span>
          <a className="quiet-link" href={accessHref("/profile", trip?.id)}>Profile</a>
        </div>
      </header>

      {!trip ? (
        <section className="empty-hero">
          <p className="eyebrow">No active trip</p>
          <h1>Tell Captain where you want to go.</h1>
          <p>Return to Telegram to create a trip. Captain can track up to three at once.</p>
        </section>
      ) : mockBooking && mockBooking.tripId === trip.id ? (
        <BookedFlight
          booking={mockBooking}
          onChange={(next) => {
            setMockBooking(next);
            writeMockBooking(next);
          }}
          onReset={() => {
            removeMockBooking(trip.id);
            setMockBooking(null);
          }}
        />
      ) : watchlistFocus ? (
        <>
          {error && <div className="notice">{error}</div>}
          <WatchlistDetail
            offer={focusOffer}
            {...(watchlistFocus.mode ? { mode: watchlistFocus.mode } : {})}
            offers={offers}
            watch={tripData?.watch ?? null}
            activity={tripData?.activity ?? []}
            tripId={trip.id}
            watching={focusWatching}
            onBack={() => setWatchlistFocus(null)}
            onBook={(offer) => {
              const booking = createMockBooking(trip.id, offer);
              writeMockBooking(booking);
              setMockBooking(booking);
              setWatchlistFocus(null);
            }}
            onSelectionChange={(itineraryKey, selected) => {
              setTripData((current) => {
                if (!current) return current;
                const selections = current.selections.filter((item) =>
                  !(item.itineraryKey === itineraryKey && item.selectedBy === "person")
                );
                return {
                  ...current,
                  selections: selected
                    ? [...selections, { itineraryKey, selectedBy: "person" as const }]
                    : selections
                };
              });
              if (selected) {
                const offer = focusOffer?.itineraryKey === itineraryKey
                  ? focusOffer
                  : offers.find((item) => item.itineraryKey === itineraryKey)
                    ?? watchedOfferCache[itineraryKey];
                if (offer && trip) {
                  setWatchedOfferCache((current) => {
                    const next = { ...current, [itineraryKey]: offer };
                    writeWatchedOfferCache(trip.id, next);
                    return next;
                  });
                }
                setDismissedItineraryKeys((current) => current.filter((key) => key !== itineraryKey));
                setTab("flights");
              } else if (trip) {
                setWatchedOfferCache((current) => {
                  const next = { ...current };
                  delete next[itineraryKey];
                  writeWatchedOfferCache(trip.id, next);
                  return next;
                });
              }
            }}
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

          {tripData?.watch?.delayReason && tripData.watch.status !== "completed" && (
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

          {watch && (
            <TrackingRunCard
              watch={watch}
              offers={offers}
              recommendation={tripData?.recommendation ?? null}
              busy={searchBusy}
              onTrack={() => { void trackPrices(); }}
            />
          )}

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
                watchedOffers={watchedOffers}
                profile={profile!}
                dismissedItineraryKeys={dismissedItineraryKeys}
                emptySearch={emptySearch}
                onOpen={(offer, mode) => {
                  setError("");
                  setWatchlistFocus(mode ? { offerId: offer.id, mode } : { offerId: offer.id });
                }}
              />
            )}
            {tab === "airlines" && (
              <AirlinesTab
                offers={offers}
                emptySearch={emptySearch}
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
                emptySearch={emptySearch}
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

function TrackingRunCard({
  watch,
  offers,
  recommendation,
  busy,
  onTrack
}: {
  watch: Watch;
  offers: VerifiedOffer[];
  recommendation: TripPayload["recommendation"];
  busy: boolean;
  onTrack: () => void;
}) {
  const best = offers.find((offer) => offer.id === recommendation?.offerId)
    ?? offers.find((offer) => offer.itineraryKey === recommendation?.itineraryKey)
    ?? offers[0]
    ?? null;

  if (watch.status === "completed") {
    return (
      <section className="tracking-run-card complete" aria-label="Tracking run summary">
        <div className="tracking-run-icon" aria-hidden="true">✓</div>
        <div className="tracking-run-copy">
          <p className="eyebrow">Prices stale</p>
          <h2>Three-day watch finished</h2>
          <p>
            Captain checked {watch.checksCompleted || "the route"}
            {watch.checksCompleted ? ` time${watch.checksCompleted === 1 ? "" : "s"}` : ""} and stopped as planned.
            {best
              ? " No further checks are scheduled. The last strongest option is below. Choose Track to check a fresh price before booking."
              : recommendation?.summary
                ? ` ${recommendation.summary}`
                : " No verified fare was available at the end of this run."}
          </p>
        </div>
        {best && (
          <div className="tracking-best">
            <span>Last strongest option</span>
            <strong>{money(best)}</strong>
            <small>{airlineName(best.primaryAirlineCode, [best])} · {duration(best)} · {stops(best)}</small>
          </div>
        )}
        <div className="tracking-run-actions">
          <button className="primary-action" disabled={busy} onClick={onTrack}>
            {busy ? "Starting…" : "Track"}
          </button>
          <small>Starts a new three-day check.</small>
        </div>
      </section>
    );
  }

  const started = Date.parse(watch.runStartedAt);
  const ends = Date.parse(watch.runEndsAt);
  const span = Math.max(1, ends - started);
  const progress = Math.min(100, Math.max(2, ((Date.now() - started) / span) * 100));
  const paused = watch.status === "paused";
  return (
    <section className={`tracking-run-card${paused ? " paused" : ""}`} aria-label="Tracking run progress">
      <div className="tracking-run-copy">
        <p className="eyebrow">{paused ? "Tracking paused" : "Tracking now"}</p>
        <h2>Three-day price watch</h2>
        <p>
          {paused
            ? "This run is paused. Resume it from Profile when you’re ready."
            : `Checking every six hours until ${runEndLabel(watch.runEndsAt)}. Captain will stop automatically and send a summary.`}
        </p>
      </div>
      <div className="tracking-progress" aria-label={`${Math.round(progress)}% complete`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <dl className="tracking-run-facts">
        <div><dt>Checks complete</dt><dd>{watch.checksCompleted}</dd></div>
        <div><dt>Next check</dt><dd>{watch.nextCheckAt ? scheduleTime(watch.nextCheckAt) : "Finishing"}</dd></div>
        <div><dt>Ends</dt><dd>{runEndLabel(watch.runEndsAt)}</dd></div>
      </dl>
    </section>
  );
}

function runEndLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const day = date.toDateString() === today.toDateString()
    ? "today"
    : date.toDateString() === new Date(today.getTime() + 86_400_000).toDateString()
      ? "tomorrow"
      : new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
  return `${day} at ${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date)}`;
}

type EmptySearchProps = {
  needsManualSearch: boolean;
  searching: boolean;
  completed: boolean;
  busy: boolean;
  onSearch: () => void;
};

function isWatchSearching(
  watch: TripPayload["watch"] | null | undefined,
  trip: TripPayload["trip"] | null
): boolean {
  if (!trip || trip.status === "paused" || !watch || watch.status !== "active") return false;
  if (!watch.lastCheckAt) return true;
  if (watch.lastManualRefreshAt && Date.parse(watch.lastManualRefreshAt) > Date.parse(watch.lastCheckAt)) {
    return true;
  }
  if (watch.nextCheckAt && Date.parse(watch.nextCheckAt) <= Date.now() + 60_000) return true;
  return false;
}

function FlightsTab({
  offers,
  watchedOffers,
  profile,
  dismissedItineraryKeys,
  emptySearch,
  onOpen
}: {
  offers: VerifiedOffer[];
  watchedOffers: VerifiedOffer[];
  profile: TravellerProfile;
  dismissedItineraryKeys: string[];
  emptySearch: EmptySearchProps;
  onOpen: (offer: VerifiedOffer, mode?: RankingMode) => void;
}) {
  const dismissed = useMemo(() => new Set(dismissedItineraryKeys), [dismissedItineraryKeys]);
  const watched = useMemo(() => {
    const seen = new Set<string>();
    return watchedOffers.filter((offer) => {
      if (seen.has(offer.itineraryKey)) return false;
      seen.add(offer.itineraryKey);
      return true;
    });
  }, [watchedOffers]);
  const watchedKeys = useMemo(
    () => new Set(watched.map((offer) => offer.itineraryKey)),
    [watched]
  );
  const recommendations = useMemo(() => ({
    cheapest: rankOffers(offers, "cheapest", profile.preferredAirlineCodes)[0],
    balanced: rankOffers(offers, "balanced", profile.preferredAirlineCodes)[0],
    fastest: rankOffers(offers, "fastest", profile.preferredAirlineCodes)[0]
  }), [offers, profile.preferredAirlineCodes]);
  const modes = (["cheapest", "balanced", "fastest"] as RankingMode[])
    .sort((left, right) => Number(right === profile.rankingMode) - Number(left === profile.rankingMode));
  const suggested = modes
    .map((mode) => {
      const offer = recommendations[mode];
      if (!offer || dismissed.has(offer.itineraryKey) || watchedKeys.has(offer.itineraryKey)) {
        return null;
      }
      return { mode, offer };
    })
    .filter((item): item is { mode: RankingMode; offer: VerifiedOffer } => item !== null);
  if (offers.length === 0 && watched.length === 0) return <ResultsEmpty {...emptySearch} />;
  if (watched.length === 0 && suggested.length === 0) {
    return (
      <div className="results-empty compact">
        <span>⌁</span>
        <h2>Watchlist is clear</h2>
        <p>Watch a flight from the Flights tab to keep an eye on it here.</p>
      </div>
    );
  }
  return (
    <div className="recommendation-grid">
      {watched.map((offer) => (
        <OfferRow
          key={`watched-${offer.itineraryKey}`}
          offer={offer}
          watching
          onOpen={() => onOpen(offer)}
        />
      ))}
      {watched.length > 0 && suggested.length > 0 ? (
        <div className="watchlist-divider" role="separator">
          <span>Recommendations</span>
        </div>
      ) : null}
      {suggested.map(({ mode, offer }) => (
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
  watching,
  onBack,
  onBook,
  onSelectionChange,
  onRemoved,
  onError
}: {
  offer: VerifiedOffer | null;
  mode?: RankingMode;
  offers: VerifiedOffer[];
  watch: Watch | null;
  activity: TripPayload["activity"];
  tripId: string;
  watching: boolean;
  onBack: () => void;
  onBook: (offer: VerifiedOffer) => void;
  onSelectionChange: (itineraryKey: string, selected: boolean) => void;
  onRemoved: (itineraryKey: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
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

  async function toggleWatchlist() {
    setBusy(true);
    onError("");
    const next = !watching;
    try {
      await setTripFlightSelection(tripId, offer!.itineraryKey, next);
      onSelectionChange(offer!.itineraryKey, next);
      if (!next) onRemoved(offer!.itineraryKey);
      else setBusy(false);
    } catch (cause) {
      onError(cause instanceof ApiError ? cause.message : next
        ? "Couldn’t add that option."
        : "Couldn’t remove that option.");
      setBusy(false);
    }
  }

  return (
    <section className="watchlist-detail">
      <header className="watchlist-detail-header">
        <button type="button" className="back-link" onClick={onBack}>Back</button>
        <button
          type="button"
          className={`watchlist-toggle${watching ? " watching" : ""}`}
          aria-pressed={watching}
          disabled={busy}
          onClick={() => { void toggleWatchlist(); }}
        >
          {busy ? (watching ? "Removing…" : "Adding…") : watching ? "Watching" : "Watch"}
        </button>
      </header>

      <div className="watchlist-detail-summary">
        <strong className="price">{money(offer)}</strong>
        <p className="watchlist-airline">
          {mode ? `${label(mode)} · ` : ""}
          {airlineName(offer.primaryAirlineCode, [offer])}
          {isMixed(offer) ? ` · Mixed · ${offer.participatingAirlineCodes.join(", ")}` : ""}
        </p>
        <div className="metrics">
          <span>{duration(offer)}</span>
          <span>{stops(offer)}</span>
        </div>
      </div>

      {watch?.status === "completed" ? (
        <div className="mock-booking-cta stale-price-notice">
          <div>
            <span className="pill">Prices stale</span>
            <strong>Track before booking</strong>
            <p>Return to the trip summary and choose Track to check a fresh price.</p>
          </div>
        </div>
      ) : (
        <div className="mock-booking-cta">
          <div>
            <span className="pill mock-pill">Prototype</span>
            <strong>Preview booking this flight</strong>
            <p>No provider call, reservation, or card charge will be made.</p>
          </div>
          <button type="button" className="primary-action" onClick={() => onBook(offer)}>
            Book flight · mock
          </button>
        </div>
      )}

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
          <details className="activity-disclosure">
            <summary>
              <span>Recent activity</span>
              <em>{Math.min(activity.length, 8)}</em>
            </summary>
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
          </details>
        ) : (
          <p className="set-note">Activity appears here as Captain works.</p>
        )}
      </div>
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
  emptySearch,
  onChoose
}: {
  offers: VerifiedOffer[];
  emptySearch: EmptySearchProps;
  onChoose: (airline: string) => void;
}) {
  const groups = useMemo(() => airlineGroups(offers), [offers]);
  if (groups.length === 0) return <ResultsEmpty {...emptySearch} />;
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
            <ul className="airline-stats">
              <li>
                <span>Price</span>
                <strong>{moneyRange(group.cheapest.price, group.priceMax, group.cheapest.currency)}</strong>
              </li>
              <li>
                <span>Duration</span>
                <strong>{durationRange(group.durationMinSeconds, group.durationMaxSeconds)}</strong>
              </li>
              <li>
                <span>Stops</span>
                <strong>{group.stopMix}</strong>
              </li>
              <li>
                <span>Flights</span>
                <strong>{group.offers.length}</strong>
              </li>
            </ul>
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
  emptySearch,
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
  emptySearch: EmptySearchProps;
  onOpenFilters: () => void;
  onDraftPreferences: Dispatch<SetStateAction<BrowsePreferences>>;
  onCloseFilters: () => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
  onOpen: (offer: VerifiedOffer) => void;
}) {
  const visible = useMemo(() => sortAndFilterOffers(offers, preferences), [offers, preferences]);
  const activeFilters = countFilters(preferences);
  if (offers.length === 0) return <ResultsEmpty {...emptySearch} />;
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

function OfferRow({
  offer,
  watching = false,
  onOpen
}: {
  offer: VerifiedOffer;
  watching?: boolean;
  onOpen: () => void;
}) {
  const schedule = offerScheduleSpine(offer);
  return (
    <button
      type="button"
      className={`recommendation-card${watching ? " selected" : ""}`}
      onClick={onOpen}
    >
      <div className="card-top">
        <span className="mode-label">{airlineName(offer.primaryAirlineCode, [offer])}</span>
        {watching ? <span className="pill">Watching</span> : null}
        {!watching && isMixed(offer) ? <span className="pill">Mixed</span> : null}
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
  if (watch?.status === "completed") return "Prices stale";
  if (watch?.lastCheckAt) return `Checked ${relativeTime(watch.lastCheckAt)}`;
  if (watch?.nextCheckAt) {
    const next = scheduleTime(watch.nextCheckAt);
    return next === "Due now" ? "Checking soon" : `Next check ${next.toLowerCase()}`;
  }
  return "Tracking";
}

function CenteredState({ title, detail }: { title: string; detail: string }) {
  return <main className="centered"><span className="brand-mark">C</span><h1>{title}</h1><p>{detail}</p></main>;
}

function ResultsEmpty({ needsManualSearch, searching, completed, busy, onSearch }: EmptySearchProps) {
  if (searching) {
    return (
      <div className="results-empty searching">
        <span aria-hidden="true"><SearchRadarIcon /></span>
        <h2>Searching for flights</h2>
        <p>Captain is checking the internet for flights. You’ll get a notification in Telegram when options come up.</p>
      </div>
    );
  }
  return (
    <div className="results-empty">
      <span aria-hidden="true"><FlightIcon /></span>
      <h2>No flights found</h2>
      {completed ? (
        <p>No verified price was available when the watch finished. Choose Track from the summary to check again.</p>
      ) : needsManualSearch ? (
        <>
          <p>Regular tracking starts closer to departure. Search now to check current options.</p>
          <button className="primary" disabled={busy} onClick={onSearch}>
            {busy ? "Searching…" : "Search"}
          </button>
        </>
      ) : (
        <p>This tracking run will stop automatically and Captain will send a summary when it finishes.</p>
      )}
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

function watchedOfferCacheKey(tripId: string) {
  return `captain:watched-offers:${tripId}`;
}

function readWatchedOfferCache(tripId: string): Record<string, VerifiedOffer> {
  try {
    const raw = sessionStorage.getItem(watchedOfferCacheKey(tripId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, VerifiedOffer>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeWatchedOfferCache(tripId: string, cache: Record<string, VerifiedOffer>) {
  try {
    sessionStorage.setItem(watchedOfferCacheKey(tripId), JSON.stringify(cache));
  } catch {
    /* ignore quota / private mode failures */
  }
}
