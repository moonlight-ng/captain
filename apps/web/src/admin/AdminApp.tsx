import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type {
  AdminConversationDetail,
  AdminConversationPage,
  AdminConversationSummary,
  AdminCostRange,
  AdminCostReport,
  AdminOverview,
  AdminTripDetail,
  AdminTripFlight,
  AdminTripPage,
  AdminTripSummary,
} from "@agents/flight-domain/admin";

import { CheckIcon, ChevronRightIcon, CloseIcon, ConversationsIcon, CopyIcon, CostsIcon, OverviewIcon, SearchIcon, SettingsIcon, TripsIcon } from "../components/icons";
import { feedPostsFromActivity } from "../feed-posts";
import type { TripActivity } from "../domain";
import { AdminApi, AdminApiError, loadErrorCopy } from "./api";
import { parseAdminRoute, type AdminRoute } from "./routing";
import "./admin.css";

type Identity = { id: string; email: string };
const adminDataCache = new Map<string, unknown>();

function readAdminCache<T>(key: string): T | null {
  return (adminDataCache.get(key) as T | undefined) ?? null;
}

function writeAdminCache<T>(key: string, value: T): T {
  adminDataCache.set(key, value);
  return value;
}

function clearAdminDataCache() {
  adminDataCache.clear();
}

export function AdminApp() {
  const [api, setApi] = useState<AdminApi | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [state, setState] = useState<"booting" | "signed-out" | "checking" | "ready" | "forbidden" | "unconfigured">("booting");
  const [route, setRoute] = useState<AdminRoute>(() => readRoute());

  useEffect(() => {
    let active = true;
    void AdminApi.connect().then(async (connected) => {
      if (!active) return;
      setApi(connected);
      const session = await connected.session();
      clearAuthFragment();
      if (!active) return;
      if (!session) {
        setState("signed-out");
        return;
      }
      setState("checking");
      await verify(connected, setIdentity, setState);
    }).catch((error) => {
      if (!active) return;
      setState(error instanceof AdminApiError && error.status === 503 ? "unconfigured" : "signed-out");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!api) return;
    const { data } = api.supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        clearAdminDataCache();
        setIdentity(null);
        setState("signed-out");
        return;
      }
      setState("checking");
      clearAuthFragment();
      void verify(api, setIdentity, setState);
    });
    return () => data.subscription.unsubscribe();
  }, [api]);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setRoute(readRoute());
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  if (state === "booting" || state === "checking") {
    return (
      <main className="admin-gate">
        <section className="admin-login-card admin-login-status">
          <Brand />
          <p className="admin-gate-status" role="status">Verifying access…</p>
        </section>
      </main>
    );
  }
  if (state === "unconfigured") {
    return <AdminGate title="Admin access isn’t configured" body="Add the Supabase URL, publishable key, and administrator allowlist to the Captain service." />;
  }
  if (state === "forbidden") {
    return <AdminGate title="This account isn’t allowed" body="Your identity is valid, but it is not on Captain’s administrator allowlist.">
      <button className="admin-button" onClick={() => { clearAdminDataCache(); void api?.signOut(); }}>Use another account</button>
    </AdminGate>;
  }
  if (state === "signed-out" || !api || !identity) return <AdminLogin api={api} />;

  return (
    <AdminShell identity={identity} route={route} navigate={navigate}>
      {route.page === "overview" && <OverviewPage api={api} navigate={navigate} />}
      {route.page === "conversations" && <ConversationsPage api={api} navigate={navigate} />}
      {route.page === "conversation" && <ConversationPage api={api} id={route.id} navigate={navigate} />}
      {route.page === "trips" && <TripsPage api={api} navigate={navigate} />}
      {route.page === "trip" && <TripPage api={api} id={route.id} navigate={navigate} />}
      {route.page === "costs" && <CostsPage api={api} navigate={navigate} />}
      {route.page === "settings" && <SettingsPage api={api} identity={identity} signOut={() => { clearAdminDataCache(); void api.signOut(); }} />}
    </AdminShell>
  );
}

async function verify(
  api: AdminApi,
  setIdentity: (identity: Identity | null) => void,
  setState: (state: "signed-out" | "ready" | "forbidden" | "unconfigured") => void
): Promise<void> {
  try {
    setIdentity(await api.verifySession());
    setState("ready");
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 403) setState("forbidden");
    else if (error instanceof AdminApiError && error.status === 503) setState("unconfigured");
    else {
      await api.signOut();
      setState("signed-out");
    }
  }
}

function AdminLogin({ api }: { api: AdminApi | null }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!api || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendMagicLink(email.trim());
      setSent(true);
    } catch {
      setError("We couldn’t send a sign-in link. Check the address and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="admin-gate">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <Brand />
        <h1 id="admin-login-title">{sent ? "Check your inbox" : "Sign in"}</h1>
        <p className="admin-login-copy" {...(sent ? { role: "status" } : {})}>
          {sent
            ? "If this address is authorized, a secure sign-in link is on its way."
            : "Review Captain’s conversations and AI spend."}
        </p>
        {sent ? (
          <button className="admin-text-button" onClick={() => setSent(false)}>Send another link</button>
        ) : (
          <form onSubmit={submit} className="admin-login-form">
            <input id="admin-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" aria-label="Email" />
            {error && <p className="admin-form-error" role="alert">{error}</p>}
            <button className="admin-button admin-button-primary" disabled={!api || busy}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
          </form>
        )}
      </section>
    </main>
  );
}

function AdminGate({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return <main className="admin-gate"><section className="admin-login-card"><Brand /><h1>{title}</h1>{body && <p className="admin-login-copy">{body}</p>}{children}</section></main>;
}

function AdminShell({ identity, route, navigate, children }: {
  identity: Identity;
  route: AdminRoute;
  navigate: (path: string) => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem("captain-admin-sidebar") === "collapsed");
  const toggleSidebar = () => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("captain-admin-sidebar", next ? "collapsed" : "expanded");
      return next;
    });
  };
  return (
    <div className={`admin-shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="admin-sidebar">
        <div className="admin-sidebar-header">
          <Brand />
          <button className={`admin-sidebar-toggle${collapsed ? "" : " expanded"}`} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleSidebar}><ChevronRightIcon /></button>
        </div>
        <nav aria-label="Admin navigation">
          <NavButton active={route.page === "overview"} onClick={() => navigate("/admin")} label="Overview" icon={<OverviewIcon />} />
          <NavButton active={route.page === "conversations" || route.page === "conversation"} onClick={() => navigate("/admin/conversations")} label="Conversations" icon={<ConversationsIcon />} />
          <NavButton active={route.page === "trips" || route.page === "trip"} onClick={() => navigate("/admin/trips")} label="Trips" icon={<TripsIcon />} />
          <NavButton active={route.page === "costs"} onClick={() => navigate("/admin/costs")} label="Costs" icon={<CostsIcon />} />
        </nav>
        <div className="admin-sidebar-footer">
          <nav aria-label="Account">
            <NavButton active={route.page === "settings"} onClick={() => navigate("/admin/settings")} label="Settings" icon={<SettingsIcon />} />
          </nav>
        </div>
      </aside>
      <header className="admin-mobile-nav">
        <Brand />
        <nav aria-label="Admin navigation">
          <button aria-current={route.page === "overview" ? "page" : undefined} onClick={() => navigate("/admin")}>Overview</button>
          <button aria-current={route.page === "conversations" || route.page === "conversation" ? "page" : undefined} onClick={() => navigate("/admin/conversations")}>Chats</button>
          <button aria-current={route.page === "trips" || route.page === "trip" ? "page" : undefined} onClick={() => navigate("/admin/trips")}>Trips</button>
          <button aria-current={route.page === "costs" ? "page" : undefined} onClick={() => navigate("/admin/costs")}>Costs</button>
        </nav>
        <button className={`admin-mobile-profile${route.page === "settings" ? " active" : ""}`} aria-label="Account settings" aria-current={route.page === "settings" ? "page" : undefined} onClick={() => navigate("/admin/settings")}>{identity.email.slice(0, 1).toUpperCase()}</button>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}

function Brand() {
  return <div className="admin-brand"><img className="admin-brand-avatar" src="/captain-avatar.jpg" alt="" /><span className="admin-brand-label">Captain</span></div>;
}

function NavButton({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon: ReactNode }) {
  return <button className={active ? "active" : ""} aria-current={active ? "page" : undefined} title={label} onClick={onClick}><span>{icon}</span><span className="admin-nav-label">{label}</span></button>;
}

function OverviewPage({ api, navigate }: { api: AdminApi; navigate: (path: string) => void }) {
  const { data, error, reload } = useRefreshing<AdminOverview>("overview", () => api.overview(), []);
  return (
    <Page title="Overview" action={<RefreshButton onClick={reload} />}>
      {!data ? error ? <ErrorState onRetry={reload} title={error.title} body={error.body} /> : <Loading /> : <>
        <section className="admin-agent-card">
          <div className="admin-agent-identity"><div><h2>Captain</h2><p>Production · {data.agent.model}</p></div><div className="admin-status-line"><span className="admin-status-dot" /> Operational</div></div>
          <div className="admin-agent-facts"><Fact label="Environment" value="Production" /><Fact label="Active work" value={`${data.agent.activeTurns} turn${data.agent.activeTurns === 1 ? "" : "s"}`} /><Fact label="Last activity" value={data.agent.lastActivityAt ? relativeTime(data.agent.lastActivityAt) : "No tracked activity"} /><Fact label="Database" value={data.health.database === "available" ? "Connected" : "Local memory"} /></div>
        </section>
        <section className="admin-metrics" aria-label="Key metrics">
          <Metric label="Conversations" value={formatNumber(data.metrics.conversations)} note={`${formatNumber(data.metrics.users)} users`} />
          <Metric label="Messages" value={formatNumber(data.metrics.messages24h)} note="Last 24 hours" />
          <Metric label="Model calls" value={formatNumber(data.metrics.modelCalls30d)} note="Last 30 days" />
          <Metric label="AI spend" value={formatUsd(data.metrics.costUsd30d)} note={data.metrics.unresolvedCostCount ? `${data.metrics.unresolvedCostCount} pending` : "Exact · 30 days"} />
        </section>
        <SectionHeader title="Recent conversations" action={<button className="admin-text-button" onClick={() => navigate("/admin/conversations")}>View all</button>} />
        <ConversationTable conversations={data.recentConversations} navigate={navigate} empty="No conversations yet." />
      </>}
    </Page>
  );
}

function ConversationsPage({ api, navigate }: { api: AdminApi; navigate: (path: string) => void }) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<AdminConversationPage | null>(() => readAdminCache("conversations:"));
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [loading, setLoading] = useState(() => !readAdminCache("conversations:"));
  const load = useCallback(async (cursor?: string, append = false) => {
    const cacheKey = `conversations:${query}`;
    if (!cursor && !append) {
      const cached = readAdminCache<AdminConversationPage>(cacheKey);
      setPage(cached);
      setLoading(!cached);
    } else setLoading(true);
    setError(null);
    try {
      const next = await api.conversations({
        limit: 25,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {})
      });
      setPage((current) => {
        const merged = append && current
          ? { conversations: [...current.conversations, ...next.conversations], nextCursor: next.nextCursor }
          : next;
        return writeAdminCache(cacheKey, merged);
      });
    } catch (caught) { setError(loadErrorCopy(caught)); }
    finally { setLoading(false); }
  }, [api, query]);
  useEffect(() => { void load(); }, [load]);
  const search = (event: FormEvent) => { event.preventDefault(); setQuery(queryInput.trim()); };
  return (
    <Page title="Conversations" action={<RefreshButton onClick={() => void load()} />}>
      <form className="admin-omnibox" onSubmit={search} role="search">
        <label htmlFor="conversation-search" className="sr-only">Search conversations</label>
        <span className="admin-omnibox-icon" aria-hidden="true"><SearchIcon /></span>
        <input id="conversation-search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Search user ID, @username, name, or message…" autoComplete="off" spellCheck={false} enterKeyHint="search" />
        {queryInput && <button type="button" className="admin-omnibox-clear" aria-label="Clear search" onClick={() => { setQueryInput(""); setQuery(""); }}><CloseIcon /></button>}
      </form>
      {error && !page ? <ErrorState onRetry={() => void load()} title={error.title} body={error.body} /> : loading && !page ? <Loading /> : <>
        {query && <p className="admin-result-note">Results for “{query}”</p>}
        <ConversationTable conversations={page?.conversations ?? []} navigate={navigate} empty={query ? "No matching conversations." : "No conversations yet."} />
        {page?.nextCursor && <div className="admin-load-more"><button className="admin-button" disabled={loading} onClick={() => void load(page.nextCursor!, true)}>{loading ? "Loading…" : "Load more"}</button></div>}
      </>}
    </Page>
  );
}

function ConversationPage({ api, id, navigate }: { api: AdminApi; id: string; navigate: (path: string) => void }) {
  const cacheKey = `conversation:${id}`;
  const [detail, setDetail] = useState<AdminConversationDetail | null>(() => readAdminCache(cacheKey));
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [loading, setLoading] = useState(() => !readAdminCache(cacheKey));
  const load = useCallback(async (before?: string) => {
    if (!before) {
      const cached = readAdminCache<AdminConversationDetail>(cacheKey);
      setDetail(cached);
      setLoading(!cached);
    } else setLoading(true);
    setError(null);
    try {
      const next = await api.conversation(id, before);
      setDetail((current) => {
        const merged = before && current
          ? { ...current, messages: [...next.messages, ...current.messages], olderCursor: next.olderCursor }
          : next;
        return writeAdminCache(cacheKey, merged);
      });
    } catch (caught) { setError(loadErrorCopy(caught)); }
    finally { setLoading(false); }
  }, [api, cacheKey, id]);
  useEffect(() => { setDetail(readAdminCache(cacheKey)); void load(); }, [cacheKey, load]);
  const identity = detail ? conversationName(detail.conversation) : "Conversation";
  return (
    <Page title={identity} action={<button className="admin-text-button" onClick={() => navigate("/admin/conversations")}>Back</button>}>
      {error && !detail ? <ErrorState onRetry={() => void load()} title={error.title} body={error.body} /> : loading && !detail ? <Loading /> : detail && <div className="admin-detail-layout">
        <section className="admin-transcript" aria-label="Conversation transcript">
          <div className="admin-transcript-heading"><div><span>{detail.conversation.messageCount} messages</span><span>{formatUsd(detail.conversation.costUsd)} tracked spend</span></div><button className="admin-text-button" onClick={() => void load()} disabled={loading}>Reload</button></div>
          {detail.olderCursor && <div className="admin-load-older"><button className="admin-button" disabled={loading} onClick={() => void load(detail.olderCursor!)}>{loading ? "Loading…" : "Load older messages"}</button></div>}
          {detail.messages.length === 0 ? <EmptyState text="No messages in this conversation." /> : <div className="admin-messages">{detail.messages.map((message) => <article key={message.id} className={`admin-message ${message.role}`}><header><strong>{message.role === "user" ? identity : "Captain"}</strong><time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time></header><p>{message.content}</p></article>)}</div>}
        </section>
        <aside className="admin-detail-sidebar">
          <DetailCard title="Conversation">
            <Fact label="Conversation ID" value={shortId(detail.conversation.conversationId)} title={detail.conversation.conversationId} />
          </DetailCard>
          <DetailCard title="User">
            <Fact label="Internal ID" value={shortId(detail.conversation.userId)} title={detail.conversation.userId} />
            {detail.conversation.identities.map((channel) => (
              <Fragment key={`${channel.channel}:${channel.username}`}>
                <Fact label="Name" value={channel.displayName || "—"} />
                {channel.username ? <Fact label="Username" value={`@${channel.username}`} /> : null}
              </Fragment>
            ))}
          </DetailCard>
          <DetailCard title="Usage"><Fact label="Exact spend" value={formatUsd(detail.conversation.costUsd)} /><Fact label="Pending costs" value={String(detail.conversation.unresolvedCostCount)} /><Fact label="Sessions" value={String(detail.conversation.sessionCount)} /></DetailCard>
        </aside>
      </div>}
    </Page>
  );
}

function TripsPage({ api, navigate }: { api: AdminApi; navigate: (path: string) => void }) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<AdminTripPage | null>(() => readAdminCache("trips:"));
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [loading, setLoading] = useState(() => !readAdminCache("trips:"));
  const load = useCallback(async (cursor?: string, append = false) => {
    const cacheKey = `trips:${query}`;
    if (!cursor && !append) {
      const cached = readAdminCache<AdminTripPage>(cacheKey);
      setPage(cached);
      setLoading(!cached);
    } else setLoading(true);
    setError(null);
    try {
      const next = await api.trips({
        limit: 25,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {})
      });
      setPage((current) => {
        const merged = append && current
          ? { trips: [...current.trips, ...next.trips], nextCursor: next.nextCursor }
          : next;
        return writeAdminCache(cacheKey, merged);
      });
    } catch (caught) { setError(loadErrorCopy(caught)); }
    finally { setLoading(false); }
  }, [api, query]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Page title="Trips" action={<RefreshButton onClick={() => void load()} />}>
      <form className="admin-omnibox" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); }}>
        <label htmlFor="trip-search" className="sr-only">Search trips</label>
        <span className="admin-omnibox-icon" aria-hidden="true"><SearchIcon /></span>
        <input id="trip-search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Search title, route, status, user ID, or @username…" autoComplete="off" spellCheck={false} enterKeyHint="search" />
        {queryInput && <button type="button" className="admin-omnibox-clear" aria-label="Clear search" onClick={() => { setQueryInput(""); setQuery(""); }}><CloseIcon /></button>}
      </form>
      {error && !page ? <ErrorState onRetry={() => void load()} title={error.title} body={error.body} /> : loading && !page ? <Loading /> : <>
        {query && <p className="admin-result-note">Results for “{query}”</p>}
        <TripTable trips={page?.trips ?? []} navigate={navigate} empty={query ? "No matching trips." : "No trips yet."} />
        {page?.nextCursor && <div className="admin-load-more"><button className="admin-button" disabled={loading} onClick={() => void load(page.nextCursor!, true)}>{loading ? "Loading…" : "Load more"}</button></div>}
      </>}
    </Page>
  );
}

function TripPage({ api, id, navigate }: { api: AdminApi; id: string; navigate: (path: string) => void }) {
  const cacheKey = `trip:${id}`;
  const [detail, setDetail] = useState<AdminTripDetail | null>(() => readAdminCache(cacheKey));
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [loading, setLoading] = useState(() => !readAdminCache(cacheKey));
  const load = useCallback(async () => {
    const cached = readAdminCache<AdminTripDetail>(cacheKey);
    setDetail(cached);
    setLoading(!cached);
    setError(null);
    try {
      setDetail(writeAdminCache(cacheKey, await api.trip(id)));
    } catch (caught) { setError(loadErrorCopy(caught)); }
    finally { setLoading(false); }
  }, [api, cacheKey, id]);
  useEffect(() => { setDetail(readAdminCache(cacheKey)); void load(); }, [cacheKey, load]);
  const title = detail?.trip.title || detail?.trip.routeLabel || "Trip";
  const posts = detail
    ? feedPostsFromActivity(detail.activity as TripActivity[])
    : [];
  return (
    <Page title={title} action={<button className="admin-text-button" onClick={() => navigate("/admin/trips")}>Back</button>}>
      {error && !detail ? <ErrorState onRetry={() => void load()} title={error.title} body={error.body} /> : loading && !detail ? <Loading /> : detail && <div className="admin-detail-layout">
        <div className="admin-trip-main">
          <section className="admin-trip-panel" aria-label="Flights">
            <div className="admin-trip-panel-heading">
              <SectionHeader title="Flights" detail={`${detail.flights.length} selected`} />
              <button className="admin-text-button" onClick={() => void load()} disabled={loading}>Reload</button>
            </div>
            {detail.flights.length === 0
              ? <EmptyState text="No selected flights on this trip." />
              : <div className="admin-flight-list">{detail.flights.map((flight) => <FlightRow key={flight.id} flight={flight} />)}</div>}
          </section>
          <section className="admin-trip-panel" aria-label="Agent actions">
            <SectionHeader title="Agent actions" detail={`${posts.length} posts`} />
            {posts.length === 0
              ? <EmptyState text="No agent actions recorded for this trip." />
              : <div className="admin-action-list">{posts.map((post) => (
                <article key={post.id} className="admin-action-post">
                  <header>
                    <strong>{post.author === "traveller" ? "Traveller" : "Captain"}</strong>
                    <span>
                      {post.channel !== "system" ? `${post.channel} · ` : ""}
                      {post.createdAt ? formatDateTime(post.createdAt) : "—"}
                    </span>
                  </header>
                  <p>{post.body}</p>
                </article>
              ))}</div>}
          </section>
        </div>
        <aside className="admin-detail-sidebar">
          <DetailCard title="Trip">
            <Fact label="Status" value={labelStatus(detail.trip.status)} />
            <Fact label="Route" value={detail.trip.routeLabel} />
            <Fact label="Title" value={detail.trip.title || "—"} />
            <Fact label="Updated" value={formatDateTime(detail.trip.updatedAt)} />
            <Fact label="Trip ID" value={shortId(detail.trip.tripId)} title={detail.trip.tripId} />
          </DetailCard>
          <DetailCard title="User">
            <Fact label="Internal ID" value={shortId(detail.trip.userId)} title={detail.trip.userId} />
            {detail.trip.identities.map((channel) => (
              <Fragment key={`${channel.channel}:${channel.username}`}>
                <Fact label="Name" value={channel.displayName || "—"} />
                {channel.username ? <Fact label="Username" value={`@${channel.username}`} /> : null}
              </Fragment>
            ))}
            {detail.trip.conversationId
              ? <>
                <Fact label="Conversation ID" value={shortId(detail.trip.conversationId)} title={detail.trip.conversationId} />
                <button className="admin-button admin-open-conversation" onClick={() => navigate(`/admin/conversations/${detail.trip.conversationId}`)}>Open conversation</button>
              </>
              : <p className="admin-card-empty">No conversation linked.</p>}
          </DetailCard>
        </aside>
      </div>}
    </Page>
  );
}

function FlightRow({ flight }: { flight: AdminTripFlight }) {
  const price = flight.priceAmount && flight.currency
    ? formatMoneyAmount(flight.priceAmount, flight.currency)
    : null;
  return (
    <article className="admin-flight-row">
      <div>
        <strong>{flight.routeLabel}</strong>
        <span>{flight.legLabel}{flight.airlineCode ? ` · ${flight.airlineCode}` : ""}{flight.selectedBy ? ` · ${flight.selectedBy}` : ""}</span>
      </div>
      <div>
        <strong>{price ?? "—"}</strong>
        <span>{flight.departureDate ? formatDate(flight.departureDate) : "Date unknown"}</span>
      </div>
    </article>
  );
}

function CostsPage({ api, navigate }: { api: AdminApi; navigate: (path: string) => void }) {
  const [range, setRange] = useState<AdminCostRange>("30d");
  const { data, error, reload } = useRefreshing<AdminCostReport>(`costs:${range}`, () => api.costs(range), [range]);
  return (
    <Page title="Costs" action={<RefreshButton onClick={reload} />}>
      <div className="admin-range" role="group" aria-label="Cost reporting range">{(["7d", "30d", "all"] as AdminCostRange[]).map((value) => <button key={value} className={range === value ? "active" : ""} aria-pressed={range === value} onClick={() => setRange(value)}>{value === "all" ? "All tracked" : value.replace("d", " days")}</button>)}</div>
      {!data ? error ? <ErrorState onRetry={reload} title={error.title} body={error.body} /> : <Loading /> : <>
        {data.summary.unresolvedCostCount > 0 && <div className="admin-cost-notice" role="status"><strong>{data.summary.unresolvedCostCount} cost {data.summary.unresolvedCostCount === 1 ? "lookup is" : "lookups are"} pending.</strong><span>Exact totals exclude unresolved charges.</span></div>}
        <section className="admin-metrics admin-cost-metrics"><Metric label="AI spend" value={formatUsd(data.summary.costUsd)} note={`Tracked since ${formatDate(data.trackingStartedAt)}`} /><Metric label="Model calls" value={formatNumber(data.summary.calls)} note={rangeLabel(data.range)} /><Metric label="Input tokens" value={formatCompact(data.summary.inputTokens)} note={`${formatCompact(data.summary.cacheReadTokens)} cache read`} /><Metric label="Output tokens" value={formatCompact(data.summary.outputTokens)} note={`${formatCompact(data.summary.cacheWriteTokens)} cache write`} /></section>
        {data.summary.calls === 0 ? <EmptyState text="No usage in this range." /> : <>
          <section className="admin-chart-card"><SectionHeader title="Daily spend" detail="UTC accounting days" /><DailyChart report={data} /></section>
          <div className="admin-breakdown-grid"><Breakdown title="By model" items={data.byModel} total={data.summary.costUsd} /><Breakdown title="By operation" items={data.byOperation} total={data.summary.costUsd} /></div>
          <SectionHeader title="Highest-cost conversations" />
          <ConversationTable conversations={data.topConversations} navigate={navigate} empty="No conversation costs in this range." />
        </>}
      </>}
    </Page>
  );
}

function SettingsPage({ api, identity, signOut }: { api: AdminApi; identity: Identity; signOut: () => void }) {
  const { data, error, reload } = useRefreshing<AdminOverview>("overview", () => api.overview(), []);
  return (
    <Page title="Settings">
      <div className="admin-settings-stack">
        <section className="admin-settings-card">
          <div className="admin-settings-profile"><span>{identity.email.slice(0, 1).toUpperCase()}</span><div><strong>{identity.email}</strong><small>Administrator</small></div></div>
          <button className="admin-button admin-signout-button" onClick={signOut}>Sign out</button>
        </section>
        <section>
          <SectionHeader title="Models" />
          {data?.models?.length ? <div className="admin-model-list">{data.models.map((item) => <div className="admin-model-row" key={item.key}><span>{item.label}</span><strong>{item.model}</strong></div>)}</div>
            : data ? <div className="admin-inline-empty">Model details are unavailable.</div>
            : error ? <div className="admin-inline-error"><span>Models couldn’t be loaded.</span><button className="admin-text-button" onClick={reload}>Try again</button></div>
              : <div className="admin-loading admin-settings-loading" role="status"><span />Loading models…</div>}
        </section>
      </div>
    </Page>
  );
}

function Page({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <><header className="admin-page-header"><h1>{title}</h1>{action}</header><div className="admin-page-body">{children}</div></>;
}

function SectionHeader({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="admin-section-header"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</div>;
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="admin-metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const copyValue = title;
  return (
    <div className="admin-fact">
      <span>{label}</span>
      <div className="admin-fact-value">
        <strong title={title}>{value}</strong>
        {copyValue ? (
          <button
            type="button"
            className="admin-fact-copy"
            aria-label={copied ? "Copied" : `Copy ${label}`}
            onClick={() => {
              void navigator.clipboard.writeText(copyValue).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ConversationTable({ conversations, navigate, empty }: { conversations: AdminConversationSummary[]; navigate: (path: string) => void; empty: string }) {
  if (conversations.length === 0) return <EmptyState text={empty} />;
  return <div className="admin-table"><div className="admin-table-head"><span>User</span><span>Latest message</span><span>Activity</span><span>Spend</span></div>{conversations.map((conversation) => <button className="admin-table-row" key={conversation.conversationId} onClick={() => navigate(`/admin/conversations/${conversation.conversationId}`)}><span className="admin-user-cell"><i>{conversationName(conversation).slice(0, 1).toUpperCase()}</i><span><strong>{conversationName(conversation)}</strong></span></span><span className="admin-latest">{conversation.lastMessage?.content ?? "No messages"}</span><span>{relativeTime(conversation.lastActivityAt)}</span><span className="admin-spend">{formatUsd(conversation.costUsd)}{conversation.unresolvedCostCount > 0 && <small>{conversation.unresolvedCostCount} pending</small>}</span></button>)}</div>;
}

function TripTable({ trips, navigate, empty }: { trips: AdminTripSummary[]; navigate: (path: string) => void; empty: string }) {
  if (trips.length === 0) return <EmptyState text={empty} />;
  return (
    <div className="admin-table admin-trip-table">
      <div className="admin-table-head"><span>User</span><span>Trip</span><span>Status</span><span>Updated</span></div>
      {trips.map((trip) => (
        <button className="admin-table-row" key={trip.tripId} onClick={() => navigate(`/admin/trips/${trip.tripId}`)}>
          <span className="admin-user-cell">
            <i>{tripName(trip).slice(0, 1).toUpperCase()}</i>
            <span><strong>{tripName(trip)}</strong></span>
          </span>
          <span className="admin-latest">
            <strong>{trip.title || trip.routeLabel}</strong>
            <small>{trip.routeLabel}{trip.flightCount > 0 ? ` · ${trip.flightCount} flight${trip.flightCount === 1 ? "" : "s"}` : ""}</small>
          </span>
          <span>{labelStatus(trip.status)}</span>
          <span>{relativeTime(trip.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="admin-detail-card"><h2>{title}</h2>{children}</section>;
}

function DailyChart({ report }: { report: AdminCostReport }) {
  const max = Math.max(...report.daily.map((day) => day.costUsd), 0.000001);
  const stride = Math.max(1, Math.ceil(report.daily.length / 7));
  return <div className="admin-chart" aria-label={`Daily spend from ${formatDate(report.from)} through ${formatDate(report.through)}`}><ul className="sr-only">{report.daily.map((day) => <li key={day.date}>{formatDate(day.date)}: {formatUsd(day.costUsd)}, {day.calls} calls</li>)}</ul>{report.daily.map((day, index) => <div className="admin-chart-column" key={day.date} title={`${formatDate(day.date)}: ${formatUsd(day.costUsd)} · ${day.calls} calls`}><div className="admin-chart-bar-wrap"><span className="admin-chart-value">{day.costUsd > 0 ? formatUsd(day.costUsd) : ""}</span><span className="admin-chart-bar" style={{ height: `${Math.max(day.costUsd > 0 ? 4 : 1, (day.costUsd / max) * 100)}%` }} /></div><time dateTime={day.date}>{index % stride === 0 || index === report.daily.length - 1 ? shortDate(day.date) : ""}</time></div>)}</div>;
}

function Breakdown({ title, items, total }: { title: string; items: Array<{ key: string; label: string; costUsd: number; calls: number }>; total: number }) {
  return <section className="admin-breakdown"><SectionHeader title={title} />{items.length === 0 ? <p className="admin-card-empty">No usage in this range.</p> : items.map((item) => <div className="admin-breakdown-row" key={item.key}><div><strong>{item.label}</strong><small>{formatNumber(item.calls)} calls</small></div><div><strong>{formatUsd(item.costUsd)}</strong><span><i style={{ width: `${total > 0 ? (item.costUsd / total) * 100 : 0}%` }} /></span></div></div>)}</section>;
}

function RefreshButton({ onClick }: { onClick: () => void }) { return <button className="admin-button" onClick={onClick}>Refresh</button>; }
function Loading() { return <div className="admin-loading" role="status"><span />Loading production data…</div>; }
function ErrorState({ onRetry, title, body }: { onRetry: () => void; title?: string; body?: string }) {
  return (
    <div className="admin-empty" role="alert">
      <strong>{title ?? "Production data couldn’t be loaded."}</strong>
      <p>{body ?? "Your session may have expired."}</p>
      <button className="admin-button" onClick={onRetry}>Try again</button>
    </div>
  );
}
function EmptyState({ text }: { text: string }) { return <div className="admin-empty"><strong>{text}</strong><p>New activity appears here.</p></div>; }

function useRefreshing<T>(cacheKey: string, loader: () => Promise<T>, dependencies: unknown[]) {
  const [data, setData] = useState<T | null>(() => readAdminCache(cacheKey));
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const reload = useCallback(() => {
    const cached = readAdminCache<T>(cacheKey);
    setData(cached);
    setError(null);
    void loader()
      .then((value) => setData(writeAdminCache(cacheKey, value)))
      .catch((caught) => setError(loadErrorCopy(caught)));
  // The caller supplies the request dependencies that should replace this polling closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, ...dependencies]);
  useEffect(() => {
    reload();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, 30_000);
    return () => window.clearInterval(interval);
  }, [reload]);
  return { data, error, reload };
}

function readRoute(): AdminRoute {
  return parseAdminRoute(window.location.pathname);
}

function clearAuthFragment() {
  if (!window.location.hash) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function conversationName(conversation: AdminConversationSummary): string {
  return conversation.identities[0]?.displayName || shortId(conversation.userId);
}
function tripName(trip: AdminTripSummary): string {
  return trip.identities[0]?.displayName || shortId(trip.userId);
}
function labelStatus(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
function formatMoneyAmount(amount: string, currency: string): string {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return `${currency} ${amount}`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(parsed);
  } catch {
    return `${currency} ${amount}`;
  }
}
function shortId(value: string): string { return value.length > 15 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
function formatUsd(value: number): string { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 6 : 2 }).format(value); }
function formatNumber(value: number): string { return new Intl.NumberFormat().format(value); }
function formatCompact(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: /^\d{4}-\d{2}-\d{2}$/u.test(value) ? "UTC" : undefined }).format(new Date(value)); }
function shortDate(value: string): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)); }
function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
function rangeLabel(range: AdminCostRange): string { return range === "all" ? "All tracked usage" : `Last ${range.replace("d", " days")}`; }
