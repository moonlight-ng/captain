import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";

import {
  ApiError,
  accessHref,
  getProfile,
  getSession,
  getTrip,
  initializeAccessToken,
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
  type TravellerProfile,
  type TripPayload,
  type VerifiedOffer
} from "./domain";
import {
  airlineLabel,
  normalizeAirlineCode,
  searchAirlines
} from "./airline-catalog";
import { airlineGroups } from "./airline-groups";

type Tab = "flights" | "airlines" | "browse";
const tabLabels: Record<Tab, string> = {
  flights: "Options",
  airlines: "Airlines",
  browse: "Flights"
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
              <strong>Tracking is delayed.</strong> {tripData.watch.delayReason} Your last verified results remain below.
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
              <FlightsTab offers={offers} profile={profile!} />
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
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function FlightsTab({ offers, profile }: { offers: VerifiedOffer[]; profile: TravellerProfile }) {
  const recommendations = useMemo(() => ({
    cheapest: rankOffers(offers, "cheapest", profile.preferredAirlineCodes)[0],
    balanced: rankOffers(offers, "balanced", profile.preferredAirlineCodes)[0],
    fastest: rankOffers(offers, "fastest", profile.preferredAirlineCodes)[0]
  }), [offers, profile.preferredAirlineCodes]);
  if (offers.length === 0) return <ResultsEmpty />;
  const modes = (["cheapest", "balanced", "fastest"] as RankingMode[])
    .sort((left, right) => Number(right === profile.rankingMode) - Number(left === profile.rankingMode));
  return (
    <>
      <div className="recommendation-grid">
        {modes.map((mode) => {
          const offer = recommendations[mode];
          return offer ? (
            <RecommendationCard
              key={mode}
              offer={offer}
              mode={mode}
              selected={profile.rankingMode === mode}
              offers={offers}
            />
          ) : null;
        })}
      </div>
    </>
  );
}

function RecommendationCard({
  offer,
  mode,
  selected,
  offers
}: {
  offer: VerifiedOffer;
  mode: RankingMode;
  selected: boolean;
  offers: VerifiedOffer[];
}) {
  const evidence = offer.evidence[0];
  const className = `recommendation-card ${selected ? "selected" : ""}`;
  const body = (
    <>
      <div className="card-top">
        {selected && <span className="pill">Your preference</span>}
        <span className="mode-label">{label(mode)}</span>
      </div>
      <strong className="price">{money(offer)}</strong>
      <div className="metrics">
        <span className="airline">{offer.primaryAirlineCode}{isMixed(offer) ? " · Mixed" : ""}</span>
        <span>{duration(offer)}</span>
        <span>{stops(offer)}</span>
      </div>
      <p className="why">{whyLabel(mode, offer, offers)}</p>
    </>
  );
  return evidence ? (
    <a className={className} href={evidence.url} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <article className={className}>{body}</article>
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
  onClearFilters
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
          {visible.map((offer) => <OfferRow offer={offer} key={offer.id} />)}
        </div>
      )}
      <p className="set-note">Captain shows the verified options it found across airlines. This is not an exhaustive market listing.</p>
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

function OfferRow({ offer }: { offer: VerifiedOffer }) {
  const evidence = offer.evidence[0];
  const body = (
    <>
      <div className="carrier">
        <span className="airline-monogram">{offer.primaryAirlineCode.slice(0, 2)}</span>
        <div>
          <strong>{airlineName(offer.primaryAirlineCode, [offer])}</strong>
          <p>{isMixed(offer) ? `Mixed · ${offer.participatingAirlineCodes.join(", ")}` : "Primary airline"}</p>
        </div>
      </div>
      <div className="route">
        <strong>{offer.snapshot.route || "Verified itinerary"}</strong>
        <p>{(offer.snapshot.flightNumbers ?? []).join(" · ")}</p>
      </div>
      <div className="trip-stats">
        <div className="metrics compact">
          <span>{duration(offer)}</span>
          <span>{stops(offer)}</span>
        </div>
        <span>Checked {relativeTime(offer.verifiedAt)}</span>
      </div>
      <div className="fare">
        <strong>{money(offer)}</strong>
        <span>1 adult total</span>
      </div>
    </>
  );
  return evidence ? (
    <a className="offer-row" href={evidence.url} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <article className="offer-row">{body}</article>
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
  if (watch?.nextCheckAt) {
    const next = scheduleTime(watch.nextCheckAt);
    return next === "Due now" ? "Checking soon" : `Next check ${next.toLowerCase()}`;
  }
  if (watch?.lastCheckAt) return `Checked ${relativeTime(watch.lastCheckAt)}`;
  return "Tracking";
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
  const [alertsEnabled, setAlertsEnabled] = useState(profile.alertsEnabled);
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
        alertsEnabled,
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
            <em>{trip.status === "paused" ? "Paused" : "Active"}</em>
          </summary>
          <div className="settings-body tracking-settings">
            <dl className="settings-list">
              <div><dt>Last check</dt><dd>{watch?.lastCheckAt ? relativeTime(watch.lastCheckAt) : "Not checked yet"}</dd></div>
              <div><dt>Next check</dt><dd>{watch?.nextCheckAt ? scheduleTime(watch.nextCheckAt) : "Not scheduled"}</dd></div>
              <div><dt>Verified results</dt><dd>{tripData.offers.length}</dd></div>
              <div><dt>Schedule</dt><dd>Adaptive</dd></div>
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
          <em>{alertsEnabled ? "On" : "Off"}</em>
        </summary>
        <div className="settings-body">
          <form onSubmit={(event) => void saveProfile(event, "notifications")}>
            <label className="switch-setting">
              <span><strong>Improvement alerts</strong><small>Initial results and meaningful improvements.</small></span>
              <input
                type="checkbox"
                role="switch"
                checked={alertsEnabled}
                onChange={(event) => setAlertsEnabled(event.target.checked)}
              />
            </label>
            <label>
              Maximum alerts in 24 hours
              <select
                value={maxAlerts}
                disabled={!alertsEnabled}
                onChange={(event) => setMaxAlerts(Number(event.target.value) as 1 | 2)}
              >
                <option value={1}>1 improvement alert</option>
                <option value={2}>2 improvement alerts</option>
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
          <p>Ranking and airlines apply to every tracked Trip. Default currency applies only to future Trips.</p>
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

function whyLabel(mode: RankingMode, offer: VerifiedOffer, offers: VerifiedOffer[]): string {
  if (mode === "cheapest") return `Lowest verified fare; then time and stops break ties.`;
  if (mode === "fastest") return `Shortest summed journey time; destination stays are excluded.`;
  const cheapest = Math.min(...offers.map((item) => item.price));
  const premium = cheapest > 0 ? Math.round((offer.price / cheapest - 1) * 100) : 0;
  return `${premium > 0 ? `${premium}% above the lowest fare, with` : "Combines"} time and stop trade-offs.`;
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
