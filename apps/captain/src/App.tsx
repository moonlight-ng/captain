import { useEffect, useRef, useState } from "react";
import { Liveline, type LivelinePoint } from "liveline";

import {
  agentAction,
  createAgent,
  getFlightDetails,
  getWorkspace,
  listAgents
} from "./api";
import {
  EMPTY_PREFERENCES,
  briefSubtitle,
  defaultBrief,
  formatCompactDateRange,
  formatDate,
  formatDuration,
  formatProcessingTime,
  formatTimestamp,
  sortAndFilterFlights,
  validateBrief,
  type AgentSummary,
  type BrowsePreferences,
  type CadenceHours,
  type FlightAgentBrief,
  type FlightDetails,
  type FlightItem,
  type TrackingWindowDays,
  type Workspace
} from "./domain";

type Screen = "loading" | "home" | "brief" | "review" | "starting" | "workspace" | "settings" | "detail";
type WorkspaceTab = "Flights" | "Browse";
type SettingsPanel = "menu" | "brief" | "activity";
type TrackingNoticeState = { readonly message: string; readonly open: boolean } | null;
const STARTUP_STAGES = ["Reading your brief", "Preparing the flight search", "Opening your workspace"] as const;
const TRACKING_NOTICE_VISIBLE_MS = 2_280;
const TRACKING_NOTICE_EXIT_MS = 120;

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("Flights");
  const [draftBrief, setDraftBrief] = useState<FlightAgentBrief>(() => defaultBrief());
  const [briefEditing, setBriefEditing] = useState(false);
  const [startupStage, setStartupStage] = useState(0);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>("menu");
  const [selectedFlight, setSelectedFlight] = useState<FlightDetails | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftPreferences, setDraftPreferences] = useState<BrowsePreferences>(EMPTY_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackingNotice, setTrackingNotice] = useState<TrackingNoticeState>(null);
  const trackingNoticeCloseTimer = useRef<number | null>(null);
  const trackingNoticeRemovalTimer = useRef<number | null>(null);

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => () => {
    if (trackingNoticeCloseTimer.current !== null) window.clearTimeout(trackingNoticeCloseTimer.current);
    if (trackingNoticeRemovalTimer.current !== null) window.clearTimeout(trackingNoticeRemovalTimer.current);
  }, []);

  useEffect(() => {
    if (!workspace || ["home", "brief", "review", "starting"].includes(screen)) return;
    const interval = window.setInterval(() => {
      void refreshWorkspace(workspace.agent.key, false);
    }, workspace.agent.latestCheck?.status === "running" || workspace.agent.status === "queued" ? 2_500 : 15_000);
    return () => window.clearInterval(interval);
  }, [workspace?.agent.key, workspace?.agent.latestCheck?.status, workspace?.agent.status, screen, filterOpen]);

  async function initialize() {
    setError(null);
    try {
      const routeKey = agentKeyFromPath();
      if (routeKey) {
        await openAgent(routeKey, false);
      } else {
        setAgents(await listAgents());
        setScreen("home");
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setScreen("home");
    }
  }

  async function refreshAgents() {
    try {
      setAgents(await listAgents());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function openAgent(key: string, navigate = true) {
    setBusy(true);
    setError(null);
    try {
      const next = await getWorkspace(key);
      setWorkspace(next);
      setDraftPreferences(next.agent.browsePreferences);
      setWorkspaceTab("Flights");
      const settingsTarget = settingsTargetFromLocation();
      if (settingsTarget) {
        setSettingsPanel(settingsTarget);
        setScreen("settings");
      } else {
        setScreen("workspace");
      }
      if (navigate) {
        const path = settingsTarget
          ? `/agents/${key}?settings=${settingsTarget === "menu" ? "1" : settingsTarget}`
          : `/agents/${key}`;
        window.history.pushState({}, "", path);
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setWorkspace(null);
      setScreen("home");
      if (agentKeyFromPath() === key) window.history.replaceState({}, "", "/");
      try {
        setAgents(await listAgents());
      } catch {
        // Preserve the original workspace error; the home screen can retry.
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshWorkspace(key = workspace?.agent.key, showError = true) {
    if (!key) return;
    try {
      const next = await getWorkspace(key);
      setWorkspace(next);
      if (!filterOpen) setDraftPreferences(next.agent.browsePreferences);
    } catch (cause) {
      if (showError) setError(errorMessage(cause));
    }
  }

  function startBrief() {
    setDraftBrief(defaultBrief());
    setBriefEditing(false);
    setError(null);
    setScreen("brief");
  }

  async function startNewAgent() {
    if (validateBrief(draftBrief).length > 0) return;
    setBusy(true);
    setError(null);
    setStartupStage(0);
    setScreen("starting");
    const timers = [
      window.setTimeout(() => setStartupStage(1), 900),
      window.setTimeout(() => setStartupStage(2), 1_900)
    ];
    try {
      const [agent] = await Promise.all([
        createAgent(draftBrief),
        new Promise((resolve) => window.setTimeout(resolve, 3_000))
      ]);
      await openAgent(agent.key);
      await refreshAgents();
    } catch (cause) {
      setError(errorMessage(cause));
      setScreen("review");
    } finally {
      timers.forEach(window.clearTimeout);
      setBusy(false);
    }
  }

  async function performAction(
    action: Parameters<typeof agentAction>[1],
    success?: () => void
  ) {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await agentAction(workspace.agent, action);
      setWorkspace((current) => current ? { ...current, agent } : current);
      await refreshWorkspace(agent.key, false);
      success?.();
    } catch (cause) {
      setError(errorMessage(cause));
      await refreshWorkspace(workspace.agent.key, false);
    } finally {
      setBusy(false);
    }
  }

  async function openFlight(flight: FlightItem) {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      setSelectedFlight(await getFlightDetails(workspace.agent.key, flight.id));
      setScreen("detail");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function leaveWorkspace() {
    window.history.pushState({}, "", "/");
    setWorkspace(null);
    setSelectedFlight(null);
    setScreen("home");
    await refreshAgents();
  }

  function showTrackingNotice(message: string) {
    if (trackingNoticeCloseTimer.current !== null) window.clearTimeout(trackingNoticeCloseTimer.current);
    if (trackingNoticeRemovalTimer.current !== null) window.clearTimeout(trackingNoticeRemovalTimer.current);
    setTrackingNotice({ message, open: true });
    trackingNoticeCloseTimer.current = window.setTimeout(() => {
      setTrackingNotice((current) => current ? { ...current, open: false } : current);
      trackingNoticeCloseTimer.current = null;
    }, TRACKING_NOTICE_VISIBLE_MS);
    trackingNoticeRemovalTimer.current = window.setTimeout(() => {
      setTrackingNotice(null);
      trackingNoticeRemovalTimer.current = null;
    }, TRACKING_NOTICE_VISIBLE_MS + TRACKING_NOTICE_EXIT_MS);
  }

  return (
    <main className="app-stage">
      <AppViewport>
        {error && <ErrorNotice message={error} onClose={() => setError(null)} />}
        {trackingNotice && <TrackingNotice message={trackingNotice.message} open={trackingNotice.open} />}
        {screen === "loading" && <LoadingScreen />}
        {screen === "home" && (
          <HomeScreen agents={agents} busy={busy} onStart={startBrief} onOpen={(key) => void openAgent(key)} />
        )}
        {screen === "brief" && (
          <BriefScreen
            brief={draftBrief}
            editing={briefEditing}
            busy={busy}
            onBrief={setDraftBrief}
            onBack={() => setScreen(briefEditing ? "settings" : "home")}
            onContinue={() => {
              if (briefEditing) {
                void performAction({ type: "update_brief", brief: draftBrief }, () => {
                  setSettingsPanel("brief");
                  setScreen("settings");
                });
              } else {
                setScreen("review");
              }
            }}
          />
        )}
        {screen === "review" && (
          <ReviewScreen brief={draftBrief} busy={busy} onBack={() => setScreen("brief")} onStart={() => void startNewAgent()} />
        )}
        {screen === "starting" && <StartingScreen stage={startupStage} />}
        {screen === "workspace" && workspace && (
          <WorkspaceScreen
            workspace={workspace}
            tab={workspaceTab}
            busy={busy}
            onTab={setWorkspaceTab}
            onHome={() => void leaveWorkspace()}
            onSettings={() => { setSettingsPanel("menu"); setScreen("settings"); }}
            onBrowse={() => setWorkspaceTab("Browse")}
            onOpenFlight={(flight) => void openFlight(flight)}
            onRetain={(flight) => void performAction({ type: "retain_flight", flightKey: flight.id }, () => {
              showTrackingNotice(`${flight.marketingAirline} is now being tracked`);
            })}
            onDismiss={(flight) => void performAction({ type: "dismiss_flight", flightKey: flight.id }, () => {
              showTrackingNotice(`${flight.marketingAirline} is no longer being tracked`);
            })}
            onFilters={() => {
              setDraftPreferences(workspace.agent.browsePreferences);
              setFilterOpen(true);
            }}
            onClearFilters={() => void performAction({
              type: "set_browse_preferences",
              preferences: EMPTY_PREFERENCES
            })}
          />
        )}
        {screen === "settings" && workspace && (
          <SettingsScreen
            workspace={workspace}
            busy={busy}
            panel={settingsPanel}
            onPanel={setSettingsPanel}
            onClose={() => setScreen("workspace")}
            onPause={() => void performAction({ type: workspace.agent.status === "paused" ? "resume" : "pause" })}
            onRun={() => void performAction({ type: "run" })}
            onCadence={(cadenceHours) => void performAction({ type: "set_cadence", cadenceHours })}
            onTrackingWindow={(trackingWindowDays) => void performAction({ type: "set_tracking_window", trackingWindowDays })}
            onEditBrief={() => {
              setDraftBrief(workspace.agent.brief);
              setBriefEditing(true);
              setScreen("brief");
            }}
          />
        )}
        {screen === "detail" && workspace && selectedFlight && (
          <FlightDetailScreen
            details={selectedFlight}
            busy={busy}
            onBack={() => setScreen("workspace")}
            onRetain={() => void performAction({ type: "retain_flight", flightKey: selectedFlight.flight.id }, async () => {
              setSelectedFlight(await getFlightDetails(workspace.agent.key, selectedFlight.flight.id));
              showTrackingNotice(`${selectedFlight.flight.marketingAirline} is now being tracked`);
            })}
            onDismiss={() => void performAction({ type: "dismiss_flight", flightKey: selectedFlight.flight.id }, () => {
              setScreen("workspace");
              showTrackingNotice(selectedFlight.flight.reviewState === "retained" || selectedFlight.flight.reviewState === "promoted"
                ? `${selectedFlight.flight.marketingAirline} is no longer being tracked`
                : `${selectedFlight.flight.marketingAirline} was dismissed`);
            })}
          />
        )}
        {workspace && (
          <FilterSheet
            open={filterOpen}
            preferences={draftPreferences}
            flights={workspace.browseFlights}
            onPreferences={setDraftPreferences}
            onClose={() => setFilterOpen(false)}
            onApply={() => void performAction(
              { type: "set_browse_preferences", preferences: draftPreferences },
              () => setFilterOpen(false)
            )}
          />
        )}
      </AppViewport>
    </main>
  );
}

function HomeScreen(props: {
  readonly agents: AgentSummary[];
  readonly busy: boolean;
  readonly onStart: () => void;
  readonly onOpen: (key: string) => void;
}) {
  const placeholderCount = Math.max(0, 3 - props.agents.length);

  return (
    <section className={`screen home-screen ${props.agents.length > 0 ? "has-agent" : ""}`} data-screen="home">
      {props.agents.length > 0 && <div className="home-atmosphere" aria-hidden="true" />}
      <div className="home-content live-home-content">
        <div className="home-intro">
          <h1>Flight Agents</h1>
          <button className="primary-pill" disabled={props.busy} onClick={props.onStart}>Start a brief</button>
        </div>
        <div className="agent-card-list" aria-label="Trips">
          {props.agents.map((agent) => (
            <button className="agent-home-card live-agent-card" key={agent.key} onClick={() => props.onOpen(agent.key)}>
              <span>
                <strong>{agent.brief.originAirports.join("/")} <span>→</span> {agent.brief.destinationAirports.join("/")}</strong>
                <small>{homeTripDates(agent.brief)}</small>
              </span>
              <span className="agent-card-meta">
                <span className="agent-home-label"><i className={`status-dot ${agent.status === "paused" ? "paused" : "active"}`} />{formatProcessingTime(agent.processingTimeMs)}</span>
                <ChevronRightIcon />
              </span>
            </button>
          ))}
          {Array.from({ length: placeholderCount }, (_, index) => (
            <div className="agent-home-card live-agent-card agent-home-placeholder" aria-hidden="true" key={`agent-placeholder-${index}`}>
              <span className="agent-placeholder-copy"><i /><i /></span>
              <span className="agent-placeholder-mark" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BriefScreen(props: {
  readonly brief: FlightAgentBrief;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onBrief: (brief: FlightAgentBrief) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const errors = validateBrief(props.brief);
  const brief = props.brief;
  function update<Key extends keyof FlightAgentBrief>(key: Key, value: FlightAgentBrief[Key]) {
    props.onBrief({ ...brief, [key]: value });
  }
  return (
    <section className="screen column-screen live-brief-screen" data-screen="brief">
      <header className="simple-header">
        <IconButton label="Go back" onClick={props.onBack}><ChevronLeftIcon /></IconButton>
        <strong>{props.editing ? "Edit brief" : "Trip brief"}</strong>
      </header>
      <div className="scroll-content structured-brief">
        <div className="brief-heading fade-up">
          <h2>Where should your agent look?</h2>
          <p>Add airports and travel dates.</p>
        </div>
        <FormSection label="Route">
          <div className="form-grid two">
            <Field label="From">
              <input value={brief.originAirports.join(", ")} onChange={(event) => update("originAirports", airportList(event.target.value))} placeholder="LHR, LGW" />
            </Field>
            <Field label="To">
              <input value={brief.destinationAirports.join(", ")} onChange={(event) => update("destinationAirports", airportList(event.target.value))} placeholder="JFK" />
            </Field>
          </div>
          <SegmentedControl
            value={brief.tripType}
            options={[{ value: "round_trip", label: "Return" }, { value: "one_way", label: "One way" }]}
            onChange={(tripType) => update("tripType", tripType as FlightAgentBrief["tripType"])}
          />
        </FormSection>
        <FormSection label="Travel window">
          <div className="form-grid two">
            <Field label="Earliest departure"><input type="date" value={brief.departureWindow.start} onInput={(event) => update("departureWindow", { ...brief.departureWindow, start: event.currentTarget.value })} /></Field>
            <Field label="Latest departure"><input type="date" value={brief.departureWindow.end} onInput={(event) => update("departureWindow", { ...brief.departureWindow, end: event.currentTarget.value })} /></Field>
          </div>
          {brief.tripType === "round_trip" && brief.stayNights && (
            <div className="form-grid three">
              <NumberField label="Minimum nights" value={brief.stayNights.minimum} min={1} max={30} onChange={(value) => update("stayNights", { ...brief.stayNights!, minimum: value })} />
              <NumberField label="Preferred" value={brief.stayNights.preferred} min={1} max={30} onChange={(value) => update("stayNights", { ...brief.stayNights!, preferred: value })} />
              <NumberField label="Maximum" value={brief.stayNights.maximum} min={1} max={30} onChange={(value) => update("stayNights", { ...brief.stayNights!, maximum: value })} />
            </div>
          )}
        </FormSection>
        <FormSection label="Travellers & comfort">
          <div className="form-grid three">
            <NumberField label="Adults" value={brief.travellers.adults} min={1} max={9} onChange={(adults) => update("travellers", { ...brief.travellers, adults })} />
            <NumberField label="Children" value={brief.travellers.childrenAges.length} min={0} max={8} onChange={(children) => update("travellers", { ...brief.travellers, childrenAges: Array.from({ length: children }, (_, index) => brief.travellers.childrenAges[index] ?? 10) })} />
            <NumberField label="Infants" value={brief.travellers.infants} min={0} max={4} onChange={(infants) => update("travellers", { ...brief.travellers, infants })} />
          </div>
          {brief.travellers.childrenAges.length > 0 && (
            <div className="child-age-row">
              {brief.travellers.childrenAges.map((age, index) => (
                <NumberField key={index} label={`Child ${index + 1} age`} value={age} min={2} max={17} onChange={(value) => {
                  const ages = [...brief.travellers.childrenAges];
                  ages[index] = value;
                  update("travellers", { ...brief.travellers, childrenAges: ages });
                }} />
              ))}
            </div>
          )}
          <div className="form-grid two">
            <Field label="Cabin"><select value={brief.cabin} onChange={(event) => update("cabin", event.target.value as FlightAgentBrief["cabin"])}><option value="economy">Economy</option><option value="premium_economy">Premium economy</option><option value="business">Business</option><option value="first">First</option></select></Field>
            <Field label="Maximum stops"><select value={brief.maxStops} onChange={(event) => update("maxStops", Number(event.target.value))}><option value={0}>Direct only</option><option value={1}>One stop</option><option value={2}>Two stops</option></select></Field>
          </div>
        </FormSection>
        <FormSection label="Price & signals">
          <div className="form-grid two">
            <Field label="Currency"><input maxLength={3} value={brief.currency} onChange={(event) => update("currency", event.target.value.toUpperCase())} /></Field>
            <Field label="Maximum total fare"><input type="number" min={1} value={brief.maximumPrice ?? ""} placeholder="Open" onChange={(event) => update("maximumPrice", event.target.value ? Number(event.target.value) : null)} /></Field>
          </div>
          <Field label="Preferred airline codes"><input value={brief.preferredAirlines.join(", ")} placeholder="BA, VS" onChange={(event) => update("preferredAirlines", tokenList(event.target.value))} /></Field>
          <Field label="Exclude airline codes"><input value={brief.excludedAirlines.join(", ")} placeholder="Optional" onChange={(event) => update("excludedAirlines", tokenList(event.target.value))} /></Field>
          <Field label="Additional context"><textarea value={brief.context} placeholder="Timing, accessibility or other preferences" onChange={(event) => update("context", event.target.value)} /></Field>
        </FormSection>
        {errors.length > 0 && <div className="validation-card" role="alert">{errors.map((item) => <p key={item}>{item}</p>)}</div>}
      </div>
      <footer className="single-action-footer">
        <button className="primary-action" disabled={errors.length > 0 || props.busy} onClick={props.onContinue}>{props.editing ? "Save brief" : "Review brief"}</button>
      </footer>
    </section>
  );
}

function ReviewScreen(props: { readonly brief: FlightAgentBrief; readonly busy: boolean; readonly onBack: () => void; readonly onStart: () => void }) {
  const brief = props.brief;
  return (
    <section className="screen column-screen" data-screen="review">
      <header className="simple-header"><IconButton label="Back to brief" onClick={props.onBack}><ChevronLeftIcon /></IconButton><strong>Review brief</strong></header>
      <div className="scroll-content review-content">
        <div className="review-intro fade-up"><SectionLabel>Your trip</SectionLabel><h2>Ready to start your agent?</h2><p>{briefSubtitle(brief)}. {brief.tripType === "round_trip" ? `${brief.stayNights?.preferred ?? 0} nights` : "One way"}, {cabinLabel(brief.cabin).toLowerCase()}.</p></div>
        <div className="review-list">
          <ReviewRow label="Route" value={`${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")}`} />
          <ReviewRow label="Dates" value={brief.departureWindow.start === brief.departureWindow.end ? formatDate(brief.departureWindow.start) : `${formatDate(brief.departureWindow.start)}–${formatDate(brief.departureWindow.end)}`} />
          <ReviewRow label="Travellers" value={`${brief.travellers.adults} adult${brief.travellers.adults === 1 ? "" : "s"}${brief.travellers.childrenAges.length ? ` · ${brief.travellers.childrenAges.length} children` : ""}`} />
          <ReviewRow label="Cabin" value={cabinLabel(brief.cabin)} />
          <ReviewRow label="Stops" value={brief.maxStops === 0 ? "Direct only" : `Up to ${brief.maxStops} stop${brief.maxStops === 1 ? "" : "s"}`} />
          <ReviewRow label="Budget" value={brief.maximumPrice ? `${brief.currency} ${brief.maximumPrice}` : "Open"} />
        </div>
        <p className="quiet-copy">The agent searches immediately, then every six hours until you pause it.</p>
      </div>
      <footer className="single-action-footer"><button className="primary-action" disabled={props.busy} onClick={props.onStart}>Start agent</button></footer>
    </section>
  );
}

function StartingScreen({ stage }: { readonly stage: number }) {
  return <section className="screen starting-screen" data-screen="starting" aria-live="polite"><div className="agent-orbit" aria-hidden="true"><span /><i /></div><div className="starting-copy" key={stage}><p>Starting your agent</p><h2>{STARTUP_STAGES[stage] ?? STARTUP_STAGES[0]}</h2></div><div className="stage-dots" aria-hidden="true">{STARTUP_STAGES.map((_, index) => <span className={index <= stage ? "active" : ""} key={index} />)}</div></section>;
}

function WorkspaceScreen(props: {
  readonly workspace: Workspace;
  readonly tab: WorkspaceTab;
  readonly busy: boolean;
  readonly onTab: (tab: WorkspaceTab) => void;
  readonly onHome: () => void;
  readonly onSettings: () => void;
  readonly onBrowse: () => void;
  readonly onOpenFlight: (flight: FlightItem) => void;
  readonly onRetain: (flight: FlightItem) => void;
  readonly onDismiss: (flight: FlightItem) => void;
  readonly onFilters: () => void;
  readonly onClearFilters: () => void;
}) {
  const { workspace } = props;
  const flights = sortAndFilterFlights(workspace.browseFlights, workspace.agent.browsePreferences);
  const activeFilters = countFilters(workspace.agent.browsePreferences);
  return (
    <section className="screen column-screen workspace-screen" data-screen="workspace">
      <div className="workspace-atmosphere" aria-hidden="true" />
      <header className="workspace-header"><IconButton label="Back home" onClick={props.onHome}><ChevronLeftIcon /></IconButton><div><strong>{workspaceTitle(workspace.agent.brief)}</strong></div><button className="settings-button" aria-label="Open settings" onClick={props.onSettings}><SettingsIcon /></button></header>
      <nav className="workspace-menu" aria-label="Flight workspace">{(["Flights", "Browse"] as const).map((tab) => <button className={props.tab === tab ? "active" : ""} key={tab} onClick={() => props.onTab(tab)}>{tab}</button>)}</nav>
      <div className="scroll-content workspace-content">
        {props.tab === "Flights" ? (
          <section className="saved-view">
            {workspace.reviewFlights.length === 0 ? (
              <div className="empty-state"><div className="empty-mark" aria-hidden="true"><PlaneIcon /></div><h2>No tracked flights yet</h2><p>Your agent will add flights here for review.</p><button className="primary-pill" onClick={props.onBrowse}>Browse flights</button></div>
            ) : (
              <div className="flight-list">{workspace.reviewFlights.map((flight) => <FlightCard key={flight.id} flight={flight} onOpen={() => props.onOpenFlight(flight)} action={<button className="card-icon-action" aria-label="Remove from review" disabled={props.busy} onClick={(event) => { event.stopPropagation(); props.onDismiss(flight); }}><CloseIcon /></button>} />)}</div>
            )}
          </section>
        ) : (
          <section className="browse-view">
            <div className="browse-toolbar"><button className={`sort-filter-button ${activeFilters ? "active" : ""}`} onClick={props.onFilters}><span className="sort-filter-title"><FilterIcon /><strong>Sort &amp; filter</strong></span><span className="sort-filter-summary"><span>{sortLabel(workspace.agent.browsePreferences.sort)}</span>{activeFilters > 0 && <b>{activeFilters}</b>}<ChevronRightIcon /></span></button></div>
            {activeFilters > 0 && <div className="active-filter-row" aria-label="Active filters">{filterChips(workspace.agent.browsePreferences).map((chip) => <span key={chip}>{chip}</span>)}<button disabled={props.busy} onClick={props.onClearFilters}>Clear all</button></div>}
            {flights.length === 0 ? (
              <div className="empty-state compact"><div className="empty-mark" aria-hidden="true"><SearchIcon /></div><h2>{workspace.agent.latestCheck?.status === "failed" ? "Fares unavailable" : workspace.browseFlights.length === 0 ? "Search in progress" : "No matches"}</h2><p>{workspace.agent.latestCheck?.status === "failed" ? "Your agent will retry automatically." : workspace.browseFlights.length === 0 ? "Your agent is building the first set of options." : "Adjust the current filters to see more flights."}</p></div>
            ) : (
              <div className="flight-list">{flights.map((flight) => <FlightCard key={flight.id} flight={flight} onOpen={() => props.onOpenFlight(flight)} action={flight.reviewState === "promoted" || flight.reviewState === "retained" ? <span className="review-badge"><i />Tracking</span> : <button className="card-icon-action" aria-label={`Track ${flight.marketingAirline} flight`} disabled={props.busy} onClick={(event) => { event.stopPropagation(); props.onRetain(flight); }}><TrackIcon /></button>} />)}</div>
            )}
          </section>
        )}
      </div>
    </section>
  );
}

function FlightCard(props: { readonly flight: FlightItem; readonly onOpen: () => void; readonly action: React.ReactNode }) {
  const { flight } = props;
  const change = flight.changePercent;
  return (
    <article className="flight-card live-flight-card" tabIndex={0} role="button" aria-label={`${flight.marketingAirline}, ${flight.latest.route}, ${currency(flight.latest.price, flight.latest.currency)}`} onClick={props.onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onOpen(); } }}>
      <div className="flight-card-heading"><span className="airline-monogram">{flight.marketingAirlineCode}</span><span><strong>{flight.marketingAirline}</strong><small>{flight.latest.route}</small></span>{props.action}</div>
      <div className="flight-card-journey"><div className="flight-times"><strong>{time(flight.latest.departure)}</strong><i /><strong>{time(flight.latest.arrival)}</strong></div><div className="flight-price"><strong>{currency(flight.latest.price, flight.latest.currency)}</strong>{change !== null && Math.abs(change) >= 0.1 && <span className={change < 0 ? "price-down" : "price-up"}>{change > 0 ? "+" : ""}{change.toFixed(1)}%</span>}</div></div>
      <div className="flight-card-foot"><span>{formatDate(flight.travelDate)}</span><span>{flight.latest.stops === 0 ? "Direct" : `${flight.latest.stops} stop${flight.latest.stops === 1 ? "" : "s"}`}</span><span>{formatDuration(flight.latest.durationSeconds)}</span><ChevronRightIcon /></div>
    </article>
  );
}

function SettingsScreen(props: {
  readonly workspace: Workspace;
  readonly busy: boolean;
  readonly panel: SettingsPanel;
  readonly onPanel: (panel: SettingsPanel) => void;
  readonly onClose: () => void;
  readonly onPause: () => void;
  readonly onRun: () => void;
  readonly onCadence: (cadence: CadenceHours) => void;
  readonly onTrackingWindow: (value: TrackingWindowDays) => void;
  readonly onEditBrief: () => void;
}) {
  return (
    <section className="screen column-screen settings-screen" data-screen="settings">
      <header className="simple-header"><IconButton label={props.panel === "menu" ? "Close settings" : "Back to settings"} onClick={props.panel === "menu" ? props.onClose : () => props.onPanel("menu")}>{props.panel === "menu" ? <CloseIcon /> : <ChevronLeftIcon />}</IconButton><strong>{settingsTitle(props.panel)}</strong></header>
      <div className="scroll-content settings-content">
        {props.panel === "menu" && <SettingsMenu workspace={props.workspace} busy={props.busy} onPanel={props.onPanel} onPause={props.onPause} onRun={props.onRun} onCadence={props.onCadence} onTrackingWindow={props.onTrackingWindow} />}
        {props.panel === "brief" && <BriefSettings brief={props.workspace.agent.brief} onEdit={props.onEditBrief} />}
        {props.panel === "activity" && <ActivitySettings workspace={props.workspace} />}
      </div>
    </section>
  );
}

function SettingsMenu(props: { readonly workspace: Workspace; readonly busy: boolean; readonly onPanel: (panel: SettingsPanel) => void; readonly onPause: () => void; readonly onRun: () => void; readonly onCadence: (value: CadenceHours) => void; readonly onTrackingWindow: (value: TrackingWindowDays) => void }) {
  const check = props.workspace.agent.latestCheck;
  const { agent } = props.workspace;
  const tracking = agent.trackingWindowDays;
  return (
    <div className="settings-index">
      <section className="settings-status">
        <div className="settings-status-line"><span><i className={`status-dot ${agent.status === "paused" ? "paused" : "active"}`} /><strong>{agent.status === "paused" ? "Agent paused" : check?.status === "running" ? "Checking flights" : "Agent active"}</strong></span><button className="switch-control" role="switch" aria-label="Agent active" aria-checked={agent.status !== "paused"} disabled={props.busy} onClick={props.onPause}><i /></button></div>
        <button className="check-now-action" disabled={props.busy || agent.status === "paused" || check?.status === "running"} onClick={props.onRun}>{check?.status === "running" ? "Checking now…" : "Check now"}</button>
      </section>
      <div className="brief-detail-card settings-search-summary">
        <DetailRow label="Last check" value={formatTimestamp(agent.lastCheckAt)} />
        <DetailRow label="Options" value={`${props.workspace.browseFlights.length} available`} />
        <DetailRow label="Sources" value={workspaceSourcesLabel(props.workspace)} />
      </div>
      <SectionLabel>Automation</SectionLabel>
      <SettingChoice title="Search frequency" detail="How often the agent refreshes fares."><div className="cadence-options">{([1, 6, 12, 24] as CadenceHours[]).map((value) => <button className={agent.cadenceHours === value ? "selected" : ""} aria-pressed={agent.cadenceHours === value} disabled={props.busy} key={value} onClick={() => props.onCadence(value)}>{value}h</button>)}</div></SettingChoice>
      <SettingChoice title="Track selected flights" detail="Default tracking period after you save a flight."><div className="tracking-options">{([7, 14, 30, null] as TrackingWindowDays[]).map((value) => <button className={tracking === value ? "selected" : ""} aria-pressed={tracking === value} disabled={props.busy} key={value ?? "trip"} onClick={() => props.onTrackingWindow(value)}>{value === null ? "Until trip" : `${value}d`}</button>)}</div></SettingChoice>
      <SectionLabel>Trip</SectionLabel>
      <SettingsLink icon={<BriefIcon />} title="Brief" detail={briefSubtitle(agent.brief)} onClick={() => props.onPanel("brief")} />
      <SettingsLink icon={<ActivityIcon />} title="Activity" detail={latestActivitySummary(props.workspace)} onClick={() => props.onPanel("activity")} />
    </div>
  );
}

function BriefSettings(props: { readonly brief: FlightAgentBrief; readonly onEdit: () => void }) {
  const { brief } = props;
  return <div className="settings-section"><div className="settings-section-heading"><SectionLabel>Stable search inputs</SectionLabel><button className="small-action" onClick={props.onEdit}>Edit</button></div><div className="brief-detail-card"><DetailRow label="Route" value={`${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")}`} /><DetailRow label="Window" value={`${formatDate(brief.departureWindow.start)}–${formatDate(brief.departureWindow.end)}`} /><DetailRow label="Trip" value={brief.tripType === "one_way" ? "One way" : `${brief.stayNights?.minimum}–${brief.stayNights?.maximum} nights`} /><DetailRow label="Travellers" value={`${brief.travellers.adults} adult${brief.travellers.adults === 1 ? "" : "s"}${brief.travellers.childrenAges.length ? `, ${brief.travellers.childrenAges.length} children` : ""}`} /><DetailRow label="Cabin" value={cabinLabel(brief.cabin)} /><DetailRow label="Stops" value={brief.maxStops === 0 ? "Direct" : `Up to ${brief.maxStops}`} /><DetailRow label="Budget" value={brief.maximumPrice ? currency(brief.maximumPrice, brief.currency) : "Open"} />{brief.context && <DetailRow label="Context" value={brief.context} />}</div></div>;
}

function ActivitySettings({ workspace }: { readonly workspace: Workspace }) {
  return <div className="settings-section"><SectionLabel>Recorded events</SectionLabel><div className="activity-list">{workspace.activity.map((item) => <article key={item.id}><i className={item.kind.includes("failed") ? "error" : ""} /><span><strong>{item.message}</strong><small>{formatTimestamp(item.createdAt)}</small></span></article>)}</div>{workspace.activity.length === 0 && <p className="quiet-copy">Activity appears here as the agent works.</p>}</div>;
}

function FlightDetailScreen(props: { readonly details: FlightDetails; readonly busy: boolean; readonly onBack: () => void; readonly onRetain: () => void; readonly onDismiss: () => void }) {
  const { flight } = props.details;
  const observedPrices = props.details.observations.map((observation) => observation.price);
  const minimum = observedPrices.length ? Math.min(...observedPrices) : flight.latest.price;
  const maximum = observedPrices.length ? Math.max(...observedPrices) : flight.latest.price;
  const tracking = flight.reviewState === "retained" || flight.reviewState === "promoted";
  return <section className="screen column-screen flight-detail-screen" data-screen="flight-detail"><header className="simple-header"><IconButton label="Back to flights" onClick={props.onBack}><ChevronLeftIcon /></IconButton><strong>Flight details</strong></header><div className="scroll-content flight-detail-content"><div className="flight-detail-hero"><div className="detail-airline"><span className="airline-monogram large">{flight.marketingAirlineCode}</span><span><strong>{flight.marketingAirline}</strong><small>{flight.latest.flightNumber}</small></span>{tracking && <em><i />Tracking</em>}</div><h2>{flight.latest.origin} <span>→</span> {flight.destination}</h2><p>{formatDate(flight.travelDate)} · {time(flight.latest.departure)}–{time(flight.latest.arrival)} · {flight.latest.stops === 0 ? "Direct" : `${flight.latest.stops} stop${flight.latest.stops === 1 ? "" : "s"}`}</p><div className="detail-price"><strong>{currency(flight.latest.price, flight.latest.currency)}</strong>{flight.changePercent !== null && Math.abs(flight.changePercent) >= 0.1 && <small className={flight.changePercent < 0 ? "price-down" : "price-up"}>{flight.changePercent > 0 ? "+" : ""}{flight.changePercent.toFixed(1)}%</small>}</div>{flight.promotionReason && <span className="detail-signal">{flight.promotionReason}</span>}</div><section className="detail-section"><SectionLabel>Price history</SectionLabel><PriceTimeline observations={props.details.observations} minimum={minimum} maximum={maximum} /></section><details className="detail-disclosure"><summary>Flight information <ChevronRightIcon /></summary><div className="brief-detail-card"><DetailRow label="Route" value={flight.latest.route} /><DetailRow label="Source" value={flightSourceName(flight.latest)} /><DetailRow label="Duration" value={formatDuration(flight.latest.durationSeconds)} /><DetailRow label="Cabin" value={cabinLabel(flight.latest.cabin)} /><DetailRow label="Observed" value={`${flight.observationCount} time${flight.observationCount === 1 ? "" : "s"}`} /></div></details>{props.details.research[0] && <details className="detail-disclosure"><summary>Route context <ChevronRightIcon /></summary><div className="research-card"><p>{props.details.research[0].overview ?? props.details.research[0].error}</p>{props.details.research[0].results.slice(0, 3).map((result) => <a href={result.sourceUrl} target="_blank" rel="noreferrer" key={result.sourceUrl}><strong>{result.title}</strong><span>{result.finding}</span><small>{result.sourceName}</small></a>)}</div></details>}</div><footer className="detail-actions"><button disabled={props.busy} onClick={props.onDismiss}>{tracking ? "Stop tracking" : "Dismiss"}</button><button className="primary-action" disabled={props.busy || tracking} onClick={props.onRetain}>{tracking ? trackingButtonLabel(flight) : "Track flight"}</button></footer></section>;
}

function PriceTimeline(props: { readonly observations: FlightDetails["observations"]; readonly minimum: number; readonly maximum: number }) {
  const orderedObservations = [...props.observations].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const currencyCode = orderedObservations.at(-1)?.currency ?? "GBP";
  const observedPricePoints: LivelinePoint[] = orderedObservations.map((observation) => ({
    time: Date.parse(observation.observedAt) / 1_000,
    value: observation.price
  }));
  const nowSeconds = Date.now() / 1_000;
  const latestObservedTime = observedPricePoints.at(-1)?.time ?? nowSeconds;
  const displayTimeOffset = nowSeconds - latestObservedTime;
  const shiftedPricePoints = observedPricePoints.map((point) => ({ ...point, time: point.time + displayTimeOffset }));
  const chartPoints = shiftedPricePoints.length === 1
    ? [{ time: shiftedPricePoints[0]!.time - 60, value: shiftedPricePoints[0]!.value }, shiftedPricePoints[0]!]
    : shiftedPricePoints;
  const observedSpanSeconds = Math.max(1, (chartPoints.at(-1)?.time ?? nowSeconds) - (chartPoints[0]?.time ?? nowSeconds));
  const historyWindowSeconds = Math.max(90, Math.ceil(observedSpanSeconds * 1.1) + 30);
  const latestPrice = chartPoints.at(-1)?.value ?? props.minimum;
  const timeline = orderedObservations.map((observation, index) => ({
    observation,
    change: index === 0 ? null : percentChange(orderedObservations[index - 1]!.price, observation.price)
  })).reverse();
  return <div className="price-chart"><div className="price-chart-summary"><span><small>Low</small><strong>{currency(props.minimum, currencyCode)}</strong></span><span><small>High</small><strong>{currency(props.maximum, currencyCode)}</strong></span></div><div className="price-chart-live" role="img" aria-label={`Observed price history from ${currency(props.minimum, currencyCode)} to ${currency(props.maximum, currencyCode)}`}><Liveline data={chartPoints} value={latestPrice} theme="dark" color="#a7c49a" window={historyWindowSeconds} formatValue={(value) => currency(value, currencyCode)} formatTime={(timestamp) => formatLivelineTime(timestamp - displayTimeOffset, historyWindowSeconds)} badgeVariant="minimal" exaggerate emptyText="No price observations yet" /></div><div className="timeline-observations">{timeline.map(({ observation, change }) => <div key={observation.id}><span>{formatTimestamp(observation.observedAt)}</span><strong>{currency(observation.price, observation.currency)}{change !== null && <em className={change < 0 ? "price-down" : change > 0 ? "price-up" : ""}>{change > 0 ? "+" : ""}{change.toFixed(1)}%</em>}</strong><small>{observation.route} · {observation.flightNumber}</small><small>{flightSourceName(observation)}</small></div>)}</div></div>;
}

function formatLivelineTime(timestampSeconds: number, windowSeconds: number): string {
  const date = new Date(timestampSeconds * 1_000);
  return windowSeconds <= 86_400
    ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function flightSourceName(snapshot: FlightDetails["flight"]["latest"]): string {
  return snapshot.sourceName || (snapshot.provider === "codex_web" ? "Codex web" : "Duffel");
}

function FilterSheet(props: { readonly open: boolean; readonly preferences: BrowsePreferences; readonly flights: FlightItem[]; readonly onPreferences: React.Dispatch<React.SetStateAction<BrowsePreferences>>; readonly onClose: () => void; readonly onApply: () => void }) {
  const airlines = [...new Set(props.flights.map((flight) => flight.marketingAirline))].sort();
  const airports = [...new Set(props.flights.flatMap((flight) => [flight.latest.origin, flight.destination]))].sort();
  const cabins = [...new Set(props.flights.map((flight) => flight.latest.cabin))].sort();
  const matches = sortAndFilterFlights(props.flights, props.preferences).length;
  function update<Key extends keyof BrowsePreferences>(key: Key, value: BrowsePreferences[Key]) { props.onPreferences((current) => ({ ...current, [key]: value })); }
  return <div className="sheet-backdrop" data-open={props.open} aria-hidden={!props.open} role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}><section className="bottom-sheet filter-sheet" role="dialog" aria-modal={props.open} aria-label="Sort and filter flights"><header><span><strong>Sort &amp; filter</strong><small>{matches} matching flight{matches === 1 ? "" : "s"}</small></span><IconButton label="Close filters" onClick={props.onClose}><CloseIcon /></IconButton></header><div className="sheet-scroll"><FilterGroup label="Sort"><select value={props.preferences.sort} onInput={(event) => update("sort", event.currentTarget.value as BrowsePreferences["sort"])}><option value="recommended">Recommended</option><option value="price">Lowest price</option><option value="duration">Shortest duration</option><option value="departure">Earliest departure</option></select></FilterGroup><FilterGroup label="Stops"><div className="filter-choice-row">{[0, 1, 2].map((stops) => <button className={props.preferences.stops.includes(stops) ? "selected" : ""} key={stops} onClick={() => update("stops", toggle(props.preferences.stops, stops))}>{stops === 0 ? "Direct" : `${stops} stop${stops === 1 ? "" : "s"}`}</button>)}</div></FilterGroup>{airlines.length > 0 && <FilterGroup label="Airlines"><div className="filter-choice-row wrap">{airlines.map((airline) => <button className={props.preferences.airlines.includes(airline) ? "selected" : ""} key={airline} onClick={() => update("airlines", toggle(props.preferences.airlines, airline))}>{airline}</button>)}</div></FilterGroup>}{airports.length > 0 && <FilterGroup label="Airports"><div className="filter-choice-row wrap">{airports.map((airport) => <button className={props.preferences.airports.includes(airport) ? "selected" : ""} key={airport} onClick={() => update("airports", toggle(props.preferences.airports, airport))}>{airport}</button>)}</div></FilterGroup>}{cabins.length > 0 && <FilterGroup label="Cabin"><div className="filter-choice-row wrap">{cabins.map((cabin) => <button className={props.preferences.cabins.includes(cabin) ? "selected" : ""} key={cabin} onClick={() => update("cabins", toggle(props.preferences.cabins, cabin))}>{cabinLabel(cabin)}</button>)}</div></FilterGroup>}<FilterGroup label="Departure"><div className="filter-choice-row">{(["morning", "afternoon", "evening"] as const).map((period) => <button className={props.preferences.departurePeriods.includes(period) ? "selected" : ""} key={period} onClick={() => update("departurePeriods", toggle(props.preferences.departurePeriods, period))}>{period[0]!.toUpperCase() + period.slice(1)}</button>)}</div></FilterGroup><FilterGroup label="Maximum price"><input className="sheet-input" type="number" min={1} value={props.preferences.maximumPrice ?? ""} placeholder="No maximum" onChange={(event) => update("maximumPrice", event.target.value ? Number(event.target.value) : null)} /></FilterGroup></div><footer><button className="secondary-action" onClick={() => props.onPreferences(EMPTY_PREFERENCES)}>Reset</button><button className="primary-action" onClick={props.onApply}>Show {matches}</button></footer></section></div>;
}

function LoadingScreen() { return <section className="screen starting-screen"><div className="agent-orbit small" aria-hidden="true"><span /><i /></div><div className="starting-copy"><p>Flight Agent</p><h2>Opening workspace</h2></div></section>; }
function ErrorNotice(props: { readonly message: string; readonly onClose: () => void }) {
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(true), [props.message]);
  return <div className="error-notice app-notice" data-open={open} aria-hidden={!open} role="alert" onTransitionEnd={(event) => { if (event.propertyName === "opacity" && !open) props.onClose(); }}><span>{props.message}</span><button aria-label="Dismiss error" onClick={() => setOpen(false)}><CloseIcon /></button></div>;
}
function TrackingNotice(props: { readonly message: string; readonly open: boolean }) { return <div className="tracking-notice app-notice" data-open={props.open} aria-hidden={!props.open} role="status"><TrackIcon /><span>{props.message}</span></div>; }
function AppViewport({ children }: { readonly children: React.ReactNode }) { return <div className="app-viewport">{children}</div>; }
function IconButton(props: { readonly label: string; readonly onClick: () => void; readonly children: React.ReactNode }) { return <button className="icon-button" aria-label={props.label} onClick={props.onClick}>{props.children}</button>; }
function SectionLabel({ children }: { readonly children: React.ReactNode }) { return <h3 className="section-label">{children}</h3>; }
function FormSection(props: { readonly label: string; readonly children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  return <section className={`form-section ${expanded ? "expanded" : "collapsed"}`}><button className="form-section-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}><span>{props.label}</span><ChevronRightIcon /></button>{expanded && <div className="form-section-content">{props.children}</div>}</section>;
}
function Field(props: { readonly label: string; readonly children: React.ReactNode }) { return <label className="form-field"><span>{props.label}</span>{props.children}</label>; }
function NumberField(props: { readonly label: string; readonly value: number; readonly min: number; readonly max: number; readonly onChange: (value: number) => void }) { return <Field label={props.label}><input type="number" min={props.min} max={props.max} value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} /></Field>; }
function SegmentedControl(props: { readonly value: string; readonly options: Array<{ value: string; label: string }>; readonly onChange: (value: string) => void }) { return <div className="segmented-control">{props.options.map((option) => <button className={props.value === option.value ? "selected" : ""} aria-pressed={props.value === option.value} key={option.value} onClick={() => props.onChange(option.value)}>{option.label}</button>)}</div>; }
function ReviewRow(props: { readonly label: string; readonly value: string }) { return <div className="review-row static"><span>{props.label}</span><strong>{props.value}</strong></div>; }
function DetailRow(props: { readonly label: string; readonly value: string }) { return <div className="detail-row"><span>{props.label}</span><strong>{props.value}</strong></div>; }
function SettingChoice(props: { readonly title: string; readonly detail: string; readonly children: React.ReactNode }) { return <section className="setting-choice"><span><strong>{props.title}</strong><small>{props.detail}</small></span>{props.children}</section>; }
function SettingsLink(props: { readonly icon: React.ReactNode; readonly title: string; readonly detail: string; readonly onClick: () => void }) { return <button className="settings-index-row" onClick={props.onClick}><span className="settings-row-icon">{props.icon}</span><span><strong>{props.title}</strong><small>{props.detail}</small></span><ChevronRightIcon /></button>; }
function FilterGroup(props: { readonly label: string; readonly children: React.ReactNode }) { return <div className="filter-group"><strong>{props.label}</strong>{props.children}</div>; }

function settingsTitle(panel: SettingsPanel): string { return ({ menu: "Settings", brief: "Brief", activity: "Activity" })[panel]; }
function workspaceSourcesLabel(workspace: Workspace): string {
  const sourceRuns = workspace.agent.latestCheck?.sourceRuns;
  if (sourceRuns?.length) return sourceRuns.map((source) => `${source.source === "duffel" ? "Duffel" : "Codex"} ${source.status}`).join(" · ");
  const sources = new Set([...workspace.reviewFlights, ...workspace.browseFlights].map((flight) => flightSourceName(flight.latest)));
  if (workspace.agent.latestCheck?.research) sources.add("Codex");
  return [...sources].join(" · ") || "No sources yet";
}
function sortLabel(sort: BrowsePreferences["sort"]): string { return ({ recommended: "Recommended", price: "Lowest price", duration: "Shortest", departure: "Earliest" })[sort]; }
function countFilters(preferences: BrowsePreferences): number { return preferences.stops.length + preferences.airlines.length + preferences.airports.length + preferences.cabins.length + preferences.departurePeriods.length + (preferences.maximumPrice === null ? 0 : 1); }
function filterChips(preferences: BrowsePreferences): string[] { return [
  ...preferences.stops.map((stops) => stops === 0 ? "Direct" : `${stops} stop${stops === 1 ? "" : "s"}`),
  ...preferences.airlines,
  ...preferences.airports,
  ...preferences.cabins.map(cabinLabel),
  ...preferences.departurePeriods.map((period) => period[0]!.toUpperCase() + period.slice(1)),
  ...(preferences.maximumPrice === null ? [] : [`Up to ${preferences.maximumPrice}`])
]; }
function cabinLabel(cabin: FlightAgentBrief["cabin"]): string { return cabin.split("_").map((word, index) => index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word).join(" "); }
function time(value: string): string { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function currency(value: number, code: string): string { return new Intl.NumberFormat("en-GB", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(value); }
function airportList(value: string): string[] { return value.toUpperCase().split(/[\s,]+/).map((item) => item.trim()).filter(Boolean); }
function tokenList(value: string): string[] { return [...new Set(value.toUpperCase().split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]; }
function toggle<T>(values: readonly T[], value: T): T[] { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function percentChange(previous: number, current: number): number { return previous === 0 ? 0 : ((current - previous) / previous) * 100; }
function homeTripDates(brief: FlightAgentBrief): string { return brief.departureWindow.start === brief.departureWindow.end ? formatDate(brief.departureWindow.start) : `${formatDate(brief.departureWindow.start)}–${formatDate(brief.departureWindow.end)}`; }
function workspaceTitle(brief: FlightAgentBrief): string { return `${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")} · ${formatCompactDateRange(brief.departureWindow.start, brief.departureWindow.end)}`; }
function latestActivitySummary(workspace: Workspace): string { const latest = workspace.activity[0]; return latest ? `${latest.message} · ${formatTimestamp(latest.createdAt)}` : "No activity yet"; }
function trackingButtonLabel(flight: FlightItem): string { return flight.trackedUntilAt ? `Tracking until ${formatDate(flight.trackedUntilAt)}` : "Tracking"; }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : "Something went wrong"; }
function agentKeyFromPath(): string | null { const match = /^\/agents\/([^/]+)$/.exec(window.location.pathname); return match?.[1] ? decodeURIComponent(match[1]) : null; }
function settingsTargetFromLocation(): SettingsPanel | null {
  const value = new URLSearchParams(window.location.search).get("settings");
  if (value === null) return null;
  if (value === "brief" || value === "activity") return value;
  return "menu";
}

function ChevronLeftIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>; }
function ChevronRightIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>; }
function FilterIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4" /></svg>; }
function SearchIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>; }
function SettingsIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></svg>; }
function TrackIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3" /></svg>; }
function PlaneIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 11 18-7-7 18-2.5-8.5L3 11Z" /><path d="m11.5 13.5 4-4" /></svg>; }
function BriefIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h6" /><path d="M5 2.8h14a2 2 0 0 1 2 2v14.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2Z" /></svg>; }
function ActivityIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>; }
