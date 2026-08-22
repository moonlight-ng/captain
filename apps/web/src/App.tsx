import { useEffect, useMemo, useRef, useState, Fragment, type Dispatch, type SetStateAction } from "react";

import {
  ApiError,
  getProfile,
  getSession,
  getTripLegSearch,
  flightHref,
  getTrip,
  bookHref,
  homeHref,
  initializeAccessToken,
  setTripFlightSelection,
  startTripLegSearch,
  tripAction,
  tripHref
} from "./api";
import {
  EMPTY_BROWSE_PREFERENCES,
  sortAndFilterOffers,
  type BrowsePreferences,
  type LegSearchSnapshot,
  type RankingMode,
  type TravellerProfile,
  type TrackedPriceHistory,
  type TripPayload,
  type TripCity,
  type TripCityLeg,
  type VerifiedOffer,
  type Watch
} from "./domain";
import {
  airlineName,
  calendarDayOffset,
  clockLabel,
  countFilters,
  dateLabel,
  duration,
  filterChips,
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
  stops,
  timestampLabel
} from "./format";
import { ChevronRightIcon, FilterIcon, FlightIcon, SearchRadarIcon } from "./components/icons";
import { FilterSheet } from "./components/FilterSheet";
import { FlightTimeline } from "./components/FlightTimeline";
import { PriceChart, TrackedFlightCard } from "./components/TrackedFlight";
import { feedPostsFromActivity, withFeedUpdateAction, legFlightSummaryFromSnapshot } from "./feed-posts";
import { CaptainFeedPosts } from "./components/CaptainFeedPosts";
import { inPageLink } from "./navigation";
import { isWatchSearching, shouldAutoSearchOnOpen } from "./trip-stage";
import {
  TRIP_TAB_LABELS,
  defaultTripTab,
  orderedTripTabs,
  type TripTab
} from "./trip-tabs";
import { Home } from "./screens/Home";
import { Profile } from "./screens/Profile";
import { Feedback } from "./screens/Feedback";
import { TripSettings } from "./screens/TripSettings";
import { CanonicalFlightPage } from "./screens/CanonicalFlight";
import {
  MultiCityFeed,
  MultiCityFlightsOverview,
  MultiCityPlanOverview,
  MultiCityPlanSummary,
  TripLegResults
} from "./screens/MultiCityTrip";

type Page = "home" | "trip" | "trip-leg" | "trip-settings" | "flight" | "profile" | "feedback";

/** Account paths already sent to Telegram. They all land on the one profile page. */
const profileAliases = new Set(["/profile", "/settings", "/preferences", "/travellers", "/payment"]);

function currentPage(): Page {
  if (/^\/feedback\/?$/u.test(window.location.pathname)) return "feedback";
  if (profileAliases.has(window.location.pathname)) return "profile";
  if (window.location.pathname === "/trips") return "home";
  if (/^\/flight\/[^/]+\/?$/u.test(window.location.pathname)) return "flight";
  if (/^\/trip\/[^/]+\/leg\/[^/]+\/?$/u.test(window.location.pathname)) return "trip-leg";
  return /^\/trip\/[^/]+\/settings\/?$/u.test(window.location.pathname)
    ? "trip-settings"
    : "trip";
}

function currentTripId(): string | undefined {
  const match = /^\/trip\/([^/]+?)(?:\/settings|\/leg\/[^/]+|\/flight\/[^/]+(?:\/book)?)?\/?$/u
    .exec(window.location.pathname);
  if (match?.[1]) return decodeURIComponent(match[1]);
  return new URLSearchParams(window.location.search).get("trip") ?? undefined;
}

function currentLegId(): string | undefined {
  const match = /^\/trip\/[^/]+\/leg\/([^/]+)\/?$/u.exec(window.location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function currentCanonicalFlightKey(): string | undefined {
  const match = /^\/flight\/([^/]+)\/?$/u.exec(window.location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

type WatchlistFocus = {
  itineraryKey: string;
  mode?: RankingMode;
  /** "book" is the handoff page, which lives at the flight's own URL + /book. */
  view: "detail" | "book";
};

const rankingModes: RankingMode[] = ["cheapest", "balanced", "fastest"];

/** The focused flight lives in the URL, so it survives reload, share, and Back. */
function currentFocus(): WatchlistFocus | null {
  const match = /^\/trip\/[^/]+\/flight\/([^/]+?)(\/book)?\/?$/u.exec(window.location.pathname);
  if (!match?.[1]) return null;
  const itineraryKey = decodeURIComponent(match[1]);
  const mode = new URLSearchParams(window.location.search).get("mode");
  const view = match[2] ? "book" as const : "detail" as const;
  return rankingModes.includes(mode as RankingMode)
    ? { itineraryKey, mode: mode as RankingMode, view }
    : { itineraryKey, view };
}

export function App() {
  const [profile, setProfile] = useState<TravellerProfile | null>(null);
  /*
    Every screen here renders from data this component already holds, so moving
    between them is a state change, not a page load. Reading the path once into
    state — rather than on each render — is what lets a link push history and
    repaint immediately, instead of tearing the app down and showing the
    "Opening Captain…" splash on the way into Settings.
  */
  const [page, setPage] = useState<Page>(currentPage);
  const [tripData, setTripData] = useState<TripPayload | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TripTab>("plan");
  const [browsePreferences, setBrowsePreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftPreferences, setDraftPreferences] = useState<BrowsePreferences>(EMPTY_BROWSE_PREFERENCES);
  const [watchlistFocus, setWatchlistFocus] = useState<WatchlistFocus | null>(currentFocus);
  const [watchedOfferCache, setWatchedOfferCache] = useState<Record<string, VerifiedOffer>>({});
  const [searchBusy, setSearchBusy] = useState(false);
  const [legSearchProgress, setLegSearchProgress] = useState<Record<string, LegSearchSnapshot>>({});
  const [legSearchErrors, setLegSearchErrors] = useState<Record<string, string>>({});
  /** Trips already checked on arrival, so a reload of state can't re-fire it. */
  const autoSearchedTripIds = useRef(new Set<string>());
  const autoSearchedLegIds = useRef(new Set<string>());

  async function load() {
    setLoading(true);
    setError("");
    try {
      initializeAccessToken();
      const targetPage = currentPage();
      if (targetPage === "flight") {
        try {
          const session = await getSession();
          setDisplayName(session.displayName);
        } catch {
          // Canonical flight pages are deliberately public. Authentication only
          // adds optional trip context to the API response.
        }
        setAuthenticated(true);
        return;
      }
      const session = await getSession();
      setDisplayName(session.displayName);
      setAuthenticated(true);
      if (currentPage() === "feedback") return;
      const requestedTripId = currentTripId();
      const [nextProfile, nextTrip] = await Promise.all([
        getProfile(),
        getTrip(requestedTripId)
      ]);
      setProfile(nextProfile);
      setTripData(nextTrip);
      setTab(defaultTripTab(nextTrip.trip));
      if (
        nextTrip.trip
        && window.location.pathname === "/trip"
        && new URLSearchParams(window.location.search).has("trip")
      ) {
        window.history.replaceState(null, "", tripHref(nextTrip.trip.id));
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

  const legSearchPollKey = Object.entries(legSearchProgress)
    .filter(([, snapshot]) => snapshot.status === "queued" || snapshot.status === "running")
    .map(([legId, snapshot]) => `${legId}:${snapshot.id}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (profileAliases.has(window.location.pathname) && window.location.pathname !== "/profile") {
      const url = new URL(window.location.href);
      url.pathname = "/profile";
      url.search = "";
      window.history.replaceState(null, "", url.toString());
    }
    void load();
  }, []);

  useEffect(() => {
    const sync = () => {
      const nextPage = currentPage();
      setPage(nextPage);
      setWatchlistFocus(currentFocus());
      if (nextPage !== "flight" && !tripData) void load();
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [tripData]);

  /** Moves between screens without leaving the page. */
  function navigate(href: string) {
    setError("");
    window.history.pushState({ captainNavigation: true }, "", href);
    const nextPage = currentPage();
    setPage(nextPage);
    setWatchlistFocus(currentFocus());
    // Screens render from data already in hand, except a trip we have never
    // fetched. That one is worth a load; the rest are instant.
    const requestedTripId = currentTripId();
    if (
      (requestedTripId && requestedTripId !== tripData?.trip?.id)
      || (nextPage !== "flight" && !tripData)
    ) void load();
  }

  const trip = tripData?.trip ?? null;
  const watch = tripData?.watch ?? null;
  const searching = searchBusy || isWatchSearching(watch, trip);

  useEffect(() => {
    if (page !== "trip-leg" || trip?.status !== "draft") return;
    window.history.replaceState(null, "", tripHref(trip.id));
    setPage("trip");
    setTab("plan");
  }, [page, trip?.id, trip?.status]);

  async function searchTripLeg(leg: TripCityLeg) {
    if (!trip) return;
    setLegSearchErrors((current) => ({ ...current, [leg.id]: "" }));
    try {
      const snapshot = await startTripLegSearch(leg.id);
      setLegSearchProgress((current) => ({ ...current, [leg.id]: snapshot }));
    } catch (cause) {
      setLegSearchErrors((current) => ({
        ...current,
        [leg.id]: cause instanceof ApiError && [400, 422].includes(cause.status)
          ? "That date range is too wide. Ask Captain in Telegram to narrow it to seven days."
          : "That search didn’t start. Try again."
      }));
    }
  }

  useEffect(() => {
    if (!trip) return;
    const active = Object.entries(legSearchProgress).filter(([, snapshot]) =>
      snapshot.status === "queued" || snapshot.status === "running"
    );
    if (active.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const results = await Promise.all(active.map(async ([legId, snapshot]) => {
        try {
          return [legId, await getTripLegSearch(legId, snapshot.id)] as const;
        } catch {
          return null;
        }
      }));
      if (cancelled) return;
      for (const result of results) {
        if (!result) continue;
        const [legId, snapshot] = result;
        if (snapshot.status === "queued" || snapshot.status === "running") {
          setLegSearchProgress((current) => ({ ...current, [legId]: snapshot }));
          continue;
        }
        setTripData((current) => current ? {
          ...current,
          latestSearches: { ...(current.latestSearches ?? {}), [legId]: snapshot },
          legs: (current.legs ?? []).map((leg) => leg.id === legId
            ? { ...leg, latestSearchId: snapshot.id }
            : leg)
        } : current);
        setLegSearchProgress((current) => {
          const next = { ...current };
          delete next[legId];
          return next;
        });
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [trip?.id, legSearchPollKey]);

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

  const trackedHistory = tripData?.priceHistory ?? null;

  const needsManualSearch = Boolean(
    trip && trip.status !== "paused" && watch?.status === "scheduled"
  );

  /**
   * A background search leaves the page as it is: results already on screen
   * stay put and stay interactive, and a failure waits for the next check
   * rather than interrupting with an error nobody asked for.
   */
  async function searchFlights({ background = false } = {}) {
    if (!trip) return;
    if (!background) {
      setSearchBusy(true);
      setError("");
    }
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
      if (!background) setError("That search didn’t start. Try again.");
    } finally {
      if (!background) setSearchBusy(false);
    }
  }

  async function trackPrices() {
    if (!trip) return;
    const previousTab = tab;
    setSearchBusy(true);
    setError("");
    setTab("flights");
    try {
      await tripAction("track", trip.id, trip.version);
      const next = await getTrip(trip.id);
      setTripData(next);
    } catch {
      setError("That tracking run didn’t start. Try again.");
      if (trip.status === "draft") setTab(previousTab);
    } finally {
      setSearchBusy(false);
    }
  }

  // Opening a trip checks prices right away, so the page shows what fares cost
  // now rather than whatever the last scheduled check left behind. With nothing
  // to show yet the search takes over the page; with results already up it runs
  // behind them and the poller swaps in whatever comes back.
  useEffect(() => {
    if (page !== "trip" || !trip || autoSearchedTripIds.current.has(trip.id)) return;
    if (!shouldAutoSearchOnOpen({ trip, watch })) return;
    autoSearchedTripIds.current.add(trip.id);
    void searchFlights({ background: offers.length > 0 });
  }, [page, trip?.id, trip?.status, watch?.status]);

  useEffect(() => {
    if (!trip || trip.status === "draft") return;
    const legs = page === "trip-leg"
      ? (tripData?.legs ?? []).filter((leg) => leg.id === currentLegId())
      : page === "trip" && tab === "flights"
        ? (tripData?.legs ?? [])
        : [];
    for (const leg of legs) {
      if (tripData?.latestSearches?.[leg.id] || legSearchProgress[leg.id]) continue;
      if (autoSearchedLegIds.current.has(leg.id)) continue;
      autoSearchedLegIds.current.add(leg.id);
      void searchTripLeg(leg);
    }
  }, [page, tab, trip?.id, trip?.status, tripData?.legs, tripData?.latestSearches, legSearchPollKey]);

  if (loading) return <CenteredState title="Opening Captain…" detail="Loading your trip." />;
  if (!authenticated) {
    return (
      <CenteredState
        title="Open Captain from Telegram"
        detail={error || "Use a link from Captain in Telegram."}
      />
    );
  }
  if (page === "feedback") {
    return (
      <Feedback
        displayName={displayName}
        onBack={() => window.location.assign(homeHref())}
      />
    );
  }
  if (page === "flight") {
    const flightKey = currentCanonicalFlightKey();
    if (!flightKey) return <CenteredState title="Flight unavailable" detail="That flight link is incomplete." />;
    return (
      <CanonicalFlightPage
        flightKey={flightKey}
        onNavigate={navigate}
        onSelected={(legId, selectedFlightKey) => {
          const selectedAt = new Date().toISOString();
          setTripData((current) => {
            if (!current) return current;
            const leg = (current.legs ?? []).find((item) => item.id === legId);
            const snapshot = current.latestSearches?.[legId];
            const flight = snapshot
              ? legFlightSummaryFromSnapshot(snapshot, selectedFlightKey)
              : null;
            const previousFlightKey = leg?.selectedFlightKey && leg.selectedFlightKey !== selectedFlightKey
              ? leg.selectedFlightKey
              : null;
            const previousFlight = previousFlightKey && snapshot
              ? legFlightSummaryFromSnapshot(snapshot, previousFlightKey)
              : null;
            return {
              ...current,
              legs: (current.legs ?? []).map((item) => item.id === legId
                ? { ...item, selectedFlightKey }
                : item),
              activity: [
                {
                  id: `local-leg-select-${legId}-${selectedAt}`,
                  eventType: "trip_leg_flight_selected",
                  payload: {
                    legId,
                    flightKey: selectedFlightKey,
                    selectedBy: "person",
                    previousFlightKey,
                    flight,
                    previousFlight
                  },
                  createdAt: selectedAt,
                  body: null,
                  channel: "web",
                  notificationId: null,
                  sourceMessageId: null
                },
                ...(current.activity ?? [])
              ]
            };
          });
        }}
        onBack={() => {
          if ((window.history.state as { captainNavigation?: boolean } | null)?.captainNavigation) {
            window.history.back();
          } else {
            window.location.assign(homeHref());
          }
        }}
      />
    );
  }
  if (page === "profile" && profile) {
    return (
      <Profile
        profile={profile}
        displayName={displayName}
        onSaved={setProfile}
        onBack={() => navigate(homeHref())}
      />
    );
  }

  if (page === "home") {
    return (
      <Home
        trips={tripData?.trips ?? []}
        displayName={displayName}
        onNavigate={navigate}
      />
    );
  }

  if (page === "trip-settings") {
    return (
      <TripSettings
        tripData={tripData}
        trackingError={error}
        onTripChanged={load}
        onTripError={setError}
        onBack={() => navigate(tripHref(trip?.id))}
      />
    );
  }

  const hasTripGraph = Boolean(
    trip && (tripData?.cities?.length ?? 0) >= 2 && (tripData?.legs?.length ?? 0) >= 1
  );
  const multiCityShared = trip && hasTripGraph ? {
    trip,
    cities: tripData?.cities ?? [],
    legs: tripData?.legs ?? [],
    latestSearches: tripData?.latestSearches ?? {},
    searchProgress: legSearchProgress,
    searchErrors: legSearchErrors,
    onSearch: (leg: TripCityLeg) => { void searchTripLeg(leg); },
    onNavigate: navigate
  } : null;
  const flightsTabCount = hasTripGraph
    ? Object.values(tripData?.latestSearches ?? {}).reduce(
      (total, snapshot) => total + snapshot.analysis.optionsChecked,
      0
    )
    : offers.length;
  if (trip && multiCityShared && page === "trip-leg") {
    const activeLegId = currentLegId() ?? "";
    const activeProgress = legSearchProgress[activeLegId];
    const legRefreshing = Boolean(
      activeProgress && (activeProgress.status === "queued" || activeProgress.status === "running")
    );
    const refreshLabel = activeProgress && legRefreshing
      ? activeProgress.analysis.datesRequested.length > 0
        ? `Checking ${activeProgress.analysis.datesCompleted.length}/${activeProgress.analysis.datesRequested.length}`
        : "Updating…"
      : null;
    return (
      <main className="shell">
        <header className="topbar">
          <button
            type="button"
            className="back-link"
            onClick={() => {
              navigate(tripHref(trip.id));
              setTab("flights");
            }}
          >
            ← Back
          </button>
          <span className={`name${refreshLabel ? " is-updating" : ""}`}>
            {refreshLabel ?? trip.title}
          </span>
        </header>
        <TripLegResults
          {...multiCityShared}
          legId={activeLegId}
        />
      </main>
    );
  }

  if (trip && multiCityShared && watchlistFocus?.view === "detail") {
    const flightKey = watchlistFocus.itineraryKey;
    const tripFlightContext = tripLegFlightContext(
      trip.id,
      multiCityShared.cities,
      multiCityShared.legs,
      multiCityShared.latestSearches,
      flightKey
    );
    const knownMultiCityFlight = Boolean(tripFlightContext) || Object.values(multiCityShared.latestSearches)
      .some((snapshot) => snapshot.flights.some((flight) => flight.key === flightKey));
    if (knownMultiCityFlight) {
      return (
        <CanonicalFlightPage
          flightKey={flightKey}
          tripContext={tripFlightContext}
          onNavigate={navigate}
          onSelected={(legId, selectedFlightKey) => {
            const selectedAt = new Date().toISOString();
            setTripData((current) => current ? {
              ...current,
              legs: (current.legs ?? []).map((item) => item.id === legId
                ? { ...item, selectedFlightKey }
                : item),
              activity: [
                {
                  id: `local-leg-select-${legId}-${selectedAt}`,
                  eventType: "trip_leg_flight_selected",
                  payload: { legId, flightKey: selectedFlightKey },
                  createdAt: selectedAt,
                  body: null,
                  channel: "web",
                  notificationId: null,
                  sourceMessageId: null
                },
                ...(current.activity ?? []).filter((item) =>
                  !(item.eventType === "trip_leg_flight_selected"
                    && item.payload.legId === legId)
                )
              ]
            } : current);
            navigate(tripHref(trip.id));
            setTab("flights");
          }}
          onBack={() => {
            if (
              (window.history.state as { captainNavigation?: boolean; captainFlight?: boolean } | null)
                ?.captainNavigation
              || (window.history.state as { captainFlight?: boolean } | null)?.captainFlight
            ) {
              window.history.back();
              return;
            }
            window.history.replaceState(null, "", tripHref(trip.id));
            setWatchlistFocus(null);
          }}
        />
      );
    }
  }

  const emptySearch = {
    needsManualSearch,
    searching,
    completed: watch?.status === "completed",
    busy: searchBusy,
    onSearch: () => { void searchFlights(); }
  };

  function openFlight(offer: VerifiedOffer, mode?: RankingMode) {
    if (!trip) return;
    setError("");
    window.history.pushState(
      { captainFlight: true },
      "",
      flightHref(trip.id, offer.itineraryKey, mode)
    );
    setWatchlistFocus(mode
      ? { itineraryKey: offer.itineraryKey, mode, view: "detail" }
      : { itineraryKey: offer.itineraryKey, view: "detail" });
  }

  function closeFlight() {
    // Step back when we opened the flight ourselves; a direct link has nothing behind it.
    if ((window.history.state as { captainFlight?: boolean } | null)?.captainFlight) {
      window.history.back();
      return;
    }
    if (trip) window.history.replaceState(null, "", tripHref(trip.id));
    setWatchlistFocus(null);
  }

  const focusOffer = watchlistFocus
    ? offers.find((item) => item.itineraryKey === watchlistFocus.itineraryKey)
      ?? watchedOffers.find((item) => item.itineraryKey === watchlistFocus.itineraryKey)
      ?? watchedOfferCache[watchlistFocus.itineraryKey]
      ?? null
    : null;
  const focusWatching = Boolean(
    watchlistFocus && personSelectionKeys.includes(watchlistFocus.itineraryKey)
  );

  return (
    <main className="shell">
      {!watchlistFocus && (
        <header className="topbar">
          <a
            className="brand"
            href={homeHref()}
            aria-label="Captain home"
            onClick={inPageLink(homeHref(), navigate)}
          >
            <span className="brand-mark">C</span>
            <span>Captain</span>
          </a>
          <div className="top-actions">
            {/* Profile is reached from Telegram, not from inside a trip. */}
            {trip && (
              <a
                className="quiet-link"
                href={tripHref(trip.id, "settings")}
                onClick={inPageLink(tripHref(trip.id, "settings"), navigate)}
              >
                Settings
              </a>
            )}
          </div>
        </header>
      )}

      {!trip ? (
        <section className="empty-hero">
          <h1>Plan trips and track flight prices</h1>
          <p>Send your trip by text or voice note in Telegram</p>
        </section>
      ) : watchlistFocus?.view === "book" ? (
        <BookHandoff
          offer={focusOffer}
          onBack={() => navigate(flightHref(trip.id, watchlistFocus.itineraryKey))}
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
            history={
              trackedHistory?.itineraryKey === watchlistFocus.itineraryKey ? trackedHistory : null
            }
            tripId={trip.id}
            watching={focusWatching}
            refreshBusy={searchBusy}
            onBook={() => navigate(bookHref(trip.id, watchlistFocus.itineraryKey))}
            onBack={closeFlight}
            onRefresh={() => {
              if (watch?.status === "completed") void trackPrices();
              else void searchFlights();
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
                setTab("feed");
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
              void itineraryKey;
              closeFlight();
            }}
            onError={setError}
          />
        </>
      ) : (
        <>
          <section className="trip-heading">
            <div>
              {trip.status === "paused" && <p className="eyebrow">Tracking paused</p>}
              <h1>
                <a
                  className="trip-title-link"
                  href={tripHref(trip.id, "settings")}
                  onClick={inPageLink(tripHref(trip.id, "settings"), navigate)}
                  aria-label={`Open settings for ${trip.title}`}
                >
                  {trip.title}
                </a>
              </h1>
              <p className="trip-meta">
                {dateLabel(trip.brief.departureWindow.start)} · {trip.brief.travellers.adults} {trip.brief.travellers.adults === 1 ? "adult" : "adults"} · {label(trip.brief.cabin)} · {trip.brief.currency}
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

          <nav className="tabs" aria-label="Trip results">
            {orderedTripTabs(trip).map((item) => (
              <button
                key={item}
                className={tab === item ? "active" : ""}
                onClick={() => setTab(trip.status === "draft" && item !== "plan" ? "plan" : item)}
              >
                {TRIP_TAB_LABELS[item]}
                {item === "flights" && flightsTabCount > 0 ? <span>{flightsTabCount}</span> : null}
              </button>
            ))}
          </nav>

          <section className="workspace">
            {tab === "plan" && (
              <div className="plan-tab">
                <div className="plan-review-card">
                  {multiCityShared ? (
                    <>
                      <MultiCityPlanSummary
                        trip={multiCityShared.trip}
                        cities={multiCityShared.cities}
                        legs={multiCityShared.legs}
                      />
                      <MultiCityPlanOverview
                        cities={multiCityShared.cities}
                      />
                    </>
                  ) : (
                    <section className="simple-plan" aria-label="Trip itinerary">
                      <strong>{routeLabel(trip)}</strong>
                      <time dateTime={trip.brief.departureWindow.start}>
                        {dateLabel(trip.brief.departureWindow.start)}
                      </time>
                    </section>
                  )}
                  <div className="plan-actions">
                    <a
                      href={tripHref(trip.id, "settings")}
                      onClick={inPageLink(tripHref(trip.id, "settings"), navigate)}
                    >
                      {trip.status === "draft" ? "Review" : "Edit plan"}
                    </a>
                    {trip.status === "draft" ? (
                      <button className="primary" disabled={searchBusy} onClick={() => void trackPrices()}>
                        {searchBusy ? "Now checking flights…" : "Confirm"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
            {tab === "flights" && (multiCityShared ? (
              <MultiCityFlightsOverview
                {...multiCityShared}
              />
            ) : (
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
                onOpen={(offer) => openFlight(offer)}
              />
            ))}
            {tab === "feed" && (multiCityShared ? (
              <MultiCityFeed
                {...multiCityShared}
                activity={tripData?.activity ?? []}
                recommendation={tripData?.recommendation ?? null}
              />
            ) : (
              <FeedTab
                offers={watchedOffers}
                trackedHistory={trackedHistory}
                liveOffers={offers}
                watchedOfferCache={watchedOfferCache}
                recommendation={tripData?.recommendation ?? null}
                activity={tripData?.activity ?? []}
                onOpen={openFlight}
                onFindFlights={() => setTab("flights")}
              />
            ))}
          </section>
        </>
      )}
    </main>
  );
}

type EmptySearchProps = {
  needsManualSearch: boolean;
  searching: boolean;
  completed: boolean;
  busy: boolean;
  onSearch: () => void;
};

function WatchlistDetail({
  offer,
  mode,
  offers,
  watch,
  activity,
  history,
  tripId,
  watching,
  refreshBusy,
  onBook,
  onBack,
  onRefresh,
  onSelectionChange,
  onRemoved,
  onError
}: {
  offer: VerifiedOffer | null;
  mode?: RankingMode;
  offers: VerifiedOffer[];
  watch: Watch | null;
  activity: TripPayload["activity"];
  /** Set only when this flight is the one being watched. */
  history: TrackedPriceHistory | null;
  tripId: string;
  watching: boolean;
  refreshBusy: boolean;
  onBook: () => void;
  onBack: () => void;
  onRefresh: () => void;
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
  const recentPosts = feedPostsFromActivity(activity).slice(0, 8);

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
        <button type="button" className="book-link" onClick={onBook}>Book</button>
      </header>

      <div className="watchlist-detail-summary">
        <div className="watchlist-summary-top">
          <strong className="price">{money(offer)}</strong>
          <button
            type="button"
            className="summary-refresh"
            disabled={refreshBusy}
            onClick={onRefresh}
          >
            {refreshBusy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <p className="watchlist-airline">
          {mode ? `${label(mode)} · ` : ""}
          {airlineName(offer.primaryAirlineCode, [offer])}
          {isMixed(offer) ? ` · Mixed · ${offer.participatingAirlineCodes.join(", ")}` : ""}
          {offer.fareBasis === "party_total" ? " · Party total" : ""}
        </p>
        <div className="metrics">
          <span>{duration(offer)}</span>
          <span>{stops(offer)}</span>
        </div>
      </div>

      <WatchCallToAction
        watching={watching}
        busy={busy}
        onToggle={() => { void toggleWatchlist(); }}
      />

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

      {history && (
        <div className="watchlist-panel">
          <h2>Price since you started watching</h2>
          <PriceChart history={history} height={110} />
          <dl className="tracked-stats">
            <div>
              <dt>Now</dt>
              <dd>{formatMoney(history.current, history.currency)}</dd>
            </div>
            <div>
              <dt>Lowest</dt>
              <dd>{formatMoney(history.low, history.currency)}</dd>
            </div>
            <div>
              <dt>Highest</dt>
              <dd>{formatMoney(history.high, history.currency)}</dd>
            </div>
            <div>
              <dt>Average</dt>
              <dd>{formatMoney(history.average, history.currency)}</dd>
            </div>
          </dl>
          <p className="set-note">{history.headline}</p>
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
                  <td className="sources-title" title={item.title}>{item.title}</td>
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
        {recentPosts.length > 0 ? (
          <details className="activity-disclosure">
            <summary>
              <span>Recent activity</span>
              <em>{recentPosts.length}</em>
            </summary>
            <div className="activity-list">
              {recentPosts.map((item) => (
                <article key={item.id}>
                  <i />
                  <span>
                    <strong>{item.body}</strong>
                    <small>{item.createdAt ? timestampLabel(item.createdAt) : ""}</small>
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

/**
 * Watching is the only thing Captain asks a traveller to decide, and until
 * they decide it there is no price history and nothing to say about timing. It
 * gets a card of its own, above the itinerary, rather than a small toggle in a
 * header that reads as a bookmark.
 */
function WatchCallToAction({
  watching,
  busy,
  onToggle
}: {
  watching: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`watch-cta${watching ? " watching" : ""}`}>
      <div className="watch-cta-copy">
        <strong>{watching ? "Captain is watching this flight" : "Watch this flight"}</strong>
        <span>
          {watching
            ? "Checked once a day. You’ll hear from Captain when the price moves."
            : "Captain follows one flight at a time and charts what its price does."}
        </span>
      </div>
      <button
        type="button"
        className="watch-cta-button"
        aria-pressed={watching}
        disabled={busy}
        onClick={onToggle}
      >
        {busy
          ? watching ? "Stopping…" : "Starting…"
          : watching ? "Stop watching" : "Watch this flight"}
      </button>
    </div>
  );
}

/**
 * Captain tracks fares; it does not sell them. This says so plainly and hands
 * the traveller to whoever does, rather than leaving a Book button that turns
 * out to do nothing.
 */
function BookHandoff({
  offer,
  onBack
}: {
  offer: VerifiedOffer | null;
  onBack: () => void;
}) {
  return (
    <section className="watchlist-detail">
      <header className="watchlist-detail-header">
        <button type="button" className="back-link" onClick={onBack}>Back</button>
      </header>

      <div className="watchlist-panel booking-panel">
        <h2>Booking isn’t available in Captain</h2>
        <p className="set-note">
          Captain researches and tracks fares. It never takes a payment and holds no
          passport or card details, so the booking itself happens on the airline or
          agent’s own site.
        </p>
        {offer ? (
          <>
            <p className="set-note">
              This fare was {money(offer)}{offer.fareBasis === "party_total" ? " for your party" : ""} when Captain last verified it
              {" "}({relativeTime(offer.verifiedAt)}). Prices change between checks, so
              confirm the total before you pay.
            </p>
            {offer.evidence.length > 0 ? (
              <div className="booking-links">
                {offer.evidence.map((item) => (
                  <a
                    key={item.url}
                    className="booking-link"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>
                      <strong>Continue on {item.domain}</strong>
                      <small>{item.title}</small>
                    </span>
                    <ChevronRightIcon />
                  </a>
                ))}
              </div>
            ) : (
              <p className="set-note">
                Captain has no source link for this fare. Search the flight number on
                the airline’s own site to book it.
              </p>
            )}
          </>
        ) : (
          <p className="set-note">
            That fare is no longer in the verified set, so there is nothing to hand you
            on to. Open the trip for the latest options.
          </p>
        )}
      </div>
    </section>
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

function FeedTab({
  offers,
  trackedHistory,
  liveOffers,
  watchedOfferCache,
  recommendation,
  activity,
  onOpen,
  onFindFlights
}: {
  offers: VerifiedOffer[];
  trackedHistory: TrackedPriceHistory | null;
  liveOffers: VerifiedOffer[];
  watchedOfferCache: Record<string, VerifiedOffer>;
  recommendation: TripPayload["recommendation"];
  activity: TripPayload["activity"];
  onOpen: (offer: VerifiedOffer) => void;
  onFindFlights: () => void;
}) {
  const trackedOffer = trackedHistory
    ? liveOffers.find((item) => item.itineraryKey === trackedHistory.itineraryKey)
      ?? watchedOfferCache[trackedHistory.itineraryKey]
      ?? null
    : null;
  const remaining = offers.filter((offer) => offer.itineraryKey !== trackedHistory?.itineraryKey);
  const recommendationOffer = recommendation
    ? liveOffers.find((item) => item.itineraryKey === recommendation.itineraryKey)
      ?? watchedOfferCache[recommendation.itineraryKey]
      ?? offers.find((item) => item.itineraryKey === recommendation.itineraryKey)
      ?? null
    : null;
  const posts = withFeedUpdateAction(
    feedPostsFromActivity(activity),
    recommendationOffer
      ? { label: "Open flight", onClick: () => onOpen(recommendationOffer) }
      : undefined
  );
  const empty = !trackedHistory
    && remaining.length === 0
    && !recommendation
    && posts.length === 0;

  if (empty) {
    return (
      <div className="results-empty compact">
        <span>⌁</span>
        <h2>No activity yet</h2>
        <p>Open Flights and watch an option. Captain’s actions and recommendations land here.</p>
        <button type="button" onClick={onFindFlights}>Find flights</button>
      </div>
    );
  }

  return (
    <div className="feed-tab">
      <CaptainFeedPosts posts={posts} />
      {trackedHistory ? (
        <TrackedFlightCard
          history={trackedHistory}
          offer={trackedOffer}
          onOpen={() => { if (trackedOffer) onOpen(trackedOffer); }}
        />
      ) : null}
      {remaining.length > 0 ? (
        <div className="offer-list">
          {remaining.map((offer) => (
            <OfferRow
              offer={offer}
              watching
              key={offer.id}
              onOpen={() => onOpen(offer)}
            />
          ))}
        </div>
      ) : null}
    </div>
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
        {offer.fareBasis === "party_total" ? <span className="pill">Party total</span> : null}
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


function CenteredState({ title, detail }: { title: string; detail: string }) {
  return <main className="centered"><span className="brand-mark">C</span><h1>{title}</h1><p>{detail}</p></main>;
}

/*
  A search takes minutes, not seconds, so this line does two jobs at once: it
  says what Captain is working on, and — on every other message — that nobody
  has to sit and watch it happen. Alternating is what makes the second point
  land; as a permanent line of instruction it reads once and is never read
  again. Each message is written to fit one line on a phone.
*/
const SEARCH_STATUS_MESSAGES = [
  "Checking fares across airlines",
  "You can close this page",
  "Comparing routes, times and stops",
  "Captain messages you in Telegram",
  "Verifying today’s prices",
  "No need to wait here"
] as const;

const SEARCH_STATUS_ROTATION_MS = 3_200;

function SearchStatusLine() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setIndex((current) => (current + 1) % SEARCH_STATUS_MESSAGES.length),
      SEARCH_STATUS_ROTATION_MS
    );
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      {/*
        Rotating text in a live region would interrupt a screen reader every
        few seconds, so the animation is hidden from one and the whole point
        is stated once instead.
      */}
      <p className="searching-status" aria-hidden="true">
        <span key={index}>{SEARCH_STATUS_MESSAGES[index]}</span>
      </p>
      <p className="visually-hidden">
        Captain is searching for flights. You can close this page — it sends the
        results to you in Telegram.
      </p>
    </>
  );
}

function ResultsEmpty({ needsManualSearch, searching, completed, busy, onSearch }: EmptySearchProps) {
  if (searching) {
    return (
      <div className="results-empty searching">
        <span aria-hidden="true"><SearchRadarIcon /></span>
        <h2>Now checking flights</h2>
        <SearchStatusLine />
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

/** Resolve which trip leg a flight belongs to when opening `/trip/:id/flight/:key`. */
function tripLegFlightContext(
  tripId: string,
  cities: TripCity[],
  legs: TripCityLeg[],
  latestSearches: Record<string, LegSearchSnapshot>,
  flightKey: string
): {
  tripId: string;
  legId: string;
  routeLabel: string;
  selected: boolean;
} | null {
  const selectedLeg = legs.find((leg) => leg.selectedFlightKey === flightKey) ?? null;
  const leg = selectedLeg ?? legs.find((candidate) =>
    latestSearches[candidate.id]?.flights.some((flight) => flight.key === flightKey)
  ) ?? null;
  if (!leg) return null;
  const origin = cities.find((city) => city.id === leg.originCityId);
  const destination = cities.find((city) => city.id === leg.destinationCityId);
  if (!origin || !destination) return null;
  return {
    tripId,
    legId: leg.id,
    routeLabel: `${origin.label} → ${destination.label}`,
    selected: leg.selectedFlightKey === flightKey
  };
}
