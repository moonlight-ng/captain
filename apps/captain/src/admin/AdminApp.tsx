import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type {
  AdminConversationDetail,
  AdminConversationPage,
  AdminConversationSummary,
  AdminCostRange,
  AdminCostReport,
} from "@agents/flight-domain/admin";

import { AdminApi, AdminApiError } from "./api";
import { parseAdminRoute, type AdminRoute } from "./routing";
import "./admin.css";

type Identity = { id: string; email: string };
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

  if (state === "booting" || state === "checking") return <AdminGate title="Verifying access…" />;
  if (state === "unconfigured") {
    return <AdminGate title="Admin access isn’t configured" body="Add the Supabase URL, publishable key, and administrator allowlist to the Captain service." />;
  }
  if (state === "forbidden") {
    return <AdminGate title="This account isn’t allowed" body="Your identity is valid, but it is not on Captain’s administrator allowlist.">
      <button className="admin-button" onClick={() => void api?.signOut()}>Use another account</button>
    </AdminGate>;
  }
  if (state === "signed-out" || !api || !identity) return <AdminLogin api={api} />;

  return (
    <AdminShell identity={identity} route={route} navigate={navigate} signOut={() => void api.signOut()}>
      {route.page === "overview" && <OverviewPage api={api} navigate={navigate} />}
      {route.page === "conversations" && <ConversationsPage api={api} navigate={navigate} />}
      {route.page === "conversation" && <ConversationPage api={api} id={route.id} navigate={navigate} />}
      {route.page === "costs" && <CostsPage api={api} navigate={navigate} />}
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
        <p className="admin-kicker">Private operations</p>
        <h1 id="admin-login-title">Captain admin</h1>
        <p className="admin-login-copy">Monitor the production agent, review conversations, and reconcile AI spend.</p>
        {sent ? (
          <div className="admin-success" role="status">
            <strong>Check your inbox</strong>
            <span>If the address is authorized, its secure sign-in link will open this dashboard.</span>
            <button className="admin-text-button" onClick={() => setSent(false)}>Send another link</button>
          </div>
        ) : (
          <form onSubmit={submit} className="admin-login-form">
            <label htmlFor="admin-email">Administrator email</label>
            <input id="admin-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" />
            {error && <p className="admin-form-error" role="alert">{error}</p>}
            <button className="admin-button admin-button-primary" disabled={!api || busy}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
          </form>
        )}
        <p className="admin-fine-print">No public signup. Access is controlled by Captain’s server allowlist.</p>
      </section>
    </main>
  );
}

function AdminGate({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return <main className="admin-gate"><section className="admin-login-card"><Brand /><h1>{title}</h1>{body && <p className="admin-login-copy">{body}</p>}{children}</section></main>;
}

function AdminShell({ identity, route, navigate, signOut, children }: {
  identity: Identity;
  route: AdminRoute;
  navigate: (path: string) => void;
  signOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Brand />
        <nav aria-label="Admin navigation">
          <NavButton active={route.page === "overview"} onClick={() => navigate("/admin")} label="Overview" mark="O" />
          <NavButton active={route.page === "conversations" || route.page === "conversation"} onClick={() => navigate("/admin/conversations")} label="Conversations" mark="C" />
          <NavButton active={route.page === "costs"} onClick={() => navigate("/admin/costs")} label="Costs" mark="$" />
        </nav>
        <div className="admin-sidebar-footer">
          <div className="admin-profile"><span>{identity.email.slice(0, 1).toUpperCase()}</span><div><strong>{identity.email}</strong><small>Administrator</small></div></div>
          <button className="admin-signout" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <header className="admin-mobile-nav">
        <Brand />
        <nav aria-label="Admin navigation">
          <button aria-current={route.page === "overview" ? "page" : undefined} onClick={() => navigate("/admin")}>Overview</button>
          <button aria-current={route.page === "conversations" || route.page === "conversation" ? "page" : undefined} onClick={() => navigate("/admin/conversations")}>Chats</button>
          <button aria-current={route.page === "costs" ? "page" : undefined} onClick={() => navigate("/admin/costs")}>Costs</button>
        </nav>
        <button className="admin-mobile-signout" onClick={signOut}>Sign out</button>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}

function Brand() {
  return <div className="admin-brand"><span className="admin-brand-mark">C</span><span>Captain <small>Admin</small></span></div>;
}

function NavButton({ active, onClick, label, mark }: { active: boolean; onClick: () => void; label: string; mark: string }) {
  return <button className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={onClick}><span>{mark}</span>{label}</button>;
}

function OverviewPage({ api, navigate }: { api: AdminApi; navigate: (path: string) => void }) {
  const { data, error, loading, reload } = useRefreshing(() => api.overview(), []);
  return (
    <Page title="Overview" subtitle="Production Captain at a glance" action={<RefreshButton onClick={reload} />}>
      {loading && !data ? <Loading /> : error || !data ? <ErrorState onRetry={reload} /> : <>
        <section className="admin-agent-card">
          <div className="admin-agent-identity"><span className="admin-agent-orb">C</span><div><div className="admin-status-line"><span className="admin-status-dot" /> Operational</div><h2>Captain</h2><p>Single production agent · {data.agent.model}</p></div></div>
          <div className="admin-agent-facts"><Fact label="Environment" value="Production" /><Fact label="Active work" value={`${data.agent.activeTurns} turn${data.agent.activeTurns === 1 ? "" : "s"}`} /><Fact label="Last activity" value={data.agent.lastActivityAt ? relativeTime(data.agent.lastActivityAt) : "No tracked activity"} /><Fact label="Database" value={data.health.database === "available" ? "Connected" : "Local memory"} /></div>
          <div className="admin-coverage"><span>Tracking coverage</span><strong>Since {formatDateTime(data.trackingStartedAt)}</strong><small>Earlier conversations are available; spend is recorded from this point forward.</small></div>
        </section>
        <section className="admin-metrics" aria-label="Key metrics">
          <Metric label="Conversations" value={formatNumber(data.metrics.conversations)} note={`${formatNumber(data.metrics.users)} users`} />
          <Metric label="Messages" value={formatNumber(data.metrics.messages24h)} note="Last 24 hours" />
          <Metric label="Model calls" value={formatNumber(data.metrics.modelCalls30d)} note="Last 30 days" />
          <Metric label="AI spend" value={formatUsd(data.metrics.costUsd30d)} note={data.metrics.unresolvedCostCount ? `${data.metrics.unresolvedCostCount} pending` : "Exact · 30 days"} />
        </section>
        <SectionHeader title="Recent conversations" detail="Latest user activity" action={<button className="admin-text-button" onClick={() => navigate("/admin/conversations")}>View all</button>} />
        <ConversationTable conversations={data.recentConversations} navigate={navigate} empty="No conversations yet." />
      </>}
    </Page>
  );
}

function ConversationsPage({ api, navigate }: { api: AdminApi; navigate: (path: string) => void }) {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<AdminConversationPage | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (cursor?: string, append = false) => {
    setLoading(true); setError(false);
    try {
      const next = await api.conversations({
        limit: 25,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {})
      });
      setPage((current) => append && current ? { conversations: [...current.conversations, ...next.conversations], nextCursor: next.nextCursor } : next);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, [api, query]);
  useEffect(() => { void load(); }, [load]);
  const search = (event: FormEvent) => { event.preventDefault(); setQuery(queryInput.trim()); };
  return (
    <Page title="Conversations" subtitle="Search production transcripts by user, identity, or message text" action={<RefreshButton onClick={() => void load()} />}>
      <form className="admin-search" onSubmit={search} role="search"><label htmlFor="conversation-search" className="sr-only">Search conversations</label><input id="conversation-search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Search user ID, @username, name, or message…" /><button className="admin-button">Search</button>{query && <button type="button" className="admin-text-button" onClick={() => { setQueryInput(""); setQuery(""); }}>Clear</button>}</form>
      {error ? <ErrorState onRetry={() => void load()} /> : loading && !page ? <Loading /> : <>
        {query && <p className="admin-result-note">Results for “{query}”</p>}
        <ConversationTable conversations={page?.conversations ?? []} navigate={navigate} empty={query ? "No matching conversations." : "No conversations yet."} />
        {page?.nextCursor && <div className="admin-load-more"><button className="admin-button" disabled={loading} onClick={() => void load(page.nextCursor!, true)}>{loading ? "Loading…" : "Load more"}</button></div>}
      </>}
    </Page>
  );
}

function ConversationPage({ api, id, navigate }: { api: AdminApi; id: string; navigate: (path: string) => void }) {
  const [detail, setDetail] = useState<AdminConversationDetail | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (before?: string) => {
    setLoading(true); setError(false);
    try {
      const next = await api.conversation(id, before);
      setDetail((current) => before && current ? { ...current, messages: [...next.messages, ...current.messages], olderCursor: next.olderCursor } : next);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, [api, id]);
  useEffect(() => { setDetail(null); void load(); }, [load]);
  const identity = detail ? conversationName(detail.conversation) : "Conversation";
  return (
    <Page title={identity} subtitle={detail ? detail.conversation.userId : "Loading transcript"} action={<button className="admin-text-button" onClick={() => navigate("/admin/conversations")}>Back to conversations</button>}>
      {error ? <ErrorState onRetry={() => void load()} /> : loading && !detail ? <Loading /> : detail && <div className="admin-detail-layout">
        <section className="admin-transcript" aria-label="Conversation transcript">
          <div className="admin-transcript-heading"><div><span>{detail.conversation.messageCount} messages</span><span>{formatUsd(detail.conversation.costUsd)} tracked spend</span></div><button className="admin-text-button" onClick={() => void load()} disabled={loading}>Reload</button></div>
          {detail.olderCursor && <div className="admin-load-older"><button className="admin-button" disabled={loading} onClick={() => void load(detail.olderCursor!)}>{loading ? "Loading…" : "Load older messages"}</button></div>}
          {detail.messages.length === 0 ? <EmptyState text="No messages in this conversation." /> : <div className="admin-messages">{detail.messages.map((message) => <article key={message.id} className={`admin-message ${message.role}`}><header><strong>{message.role === "user" ? identity : "Captain"}</strong><time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time></header><p>{message.content}</p></article>)}</div>}
        </section>
        <aside className="admin-detail-sidebar">
          <DetailCard title="User"><Fact label="Internal ID" value={detail.conversation.userId} mono />{detail.conversation.identities.map((channel) => <Fact key={`${channel.channel}:${channel.username}`} label="Telegram" value={`${channel.displayName}${channel.username ? ` · @${channel.username}` : ""}`} />)}</DetailCard>
          <DetailCard title="Usage"><Fact label="Exact spend" value={formatUsd(detail.conversation.costUsd)} /><Fact label="Pending costs" value={String(detail.conversation.unresolvedCostCount)} /><Fact label="Sessions" value={String(detail.conversation.sessionCount)} /></DetailCard>
          <DetailCard title="Recent sessions">{detail.sessions.length === 0 ? <p className="admin-card-empty">No tracked sessions.</p> : detail.sessions.map((session) => <div className="admin-session" key={session.sessionId}><span className={`admin-session-status ${session.status}`} /> <div><strong>{humanize(session.status)}</strong><small>{session.model} · {formatDateTime(session.lastEventAt)}</small>{session.failureCode && <small>Failure: {session.failureCode}</small>}</div></div>)}</DetailCard>
        </aside>
      </div>}
    </Page>
  );
}

function CostsPage({ api, navigate }: { api: AdminApi; navigate: (path: string) => void }) {
  const [range, setRange] = useState<AdminCostRange>("30d");
  const { data, error, loading, reload } = useRefreshing(() => api.costs(range), [range]);
  return (
    <Page title="Costs" subtitle="Exact AI usage reported by the Gateway" action={<RefreshButton onClick={reload} />}>
      <div className="admin-range" role="group" aria-label="Cost reporting range">{(["7d", "30d", "all"] as AdminCostRange[]).map((value) => <button key={value} className={range === value ? "active" : ""} aria-pressed={range === value} onClick={() => setRange(value)}>{value === "all" ? "All tracked" : value.replace("d", " days")}</button>)}</div>
      {loading && !data ? <Loading /> : error || !data ? <ErrorState onRetry={reload} /> : <>
        {data.summary.unresolvedCostCount > 0 && <div className="admin-cost-notice" role="status"><strong>{data.summary.unresolvedCostCount} cost {data.summary.unresolvedCostCount === 1 ? "lookup is" : "lookups are"} pending or unavailable.</strong><span>Totals include only reconciled Gateway charges; Captain never estimates missing amounts.</span></div>}
        <section className="admin-metrics admin-cost-metrics"><Metric label="AI spend" value={formatUsd(data.summary.costUsd)} note={`Tracked since ${formatDate(data.trackingStartedAt)}`} /><Metric label="Model calls" value={formatNumber(data.summary.calls)} note={rangeLabel(data.range)} /><Metric label="Input tokens" value={formatCompact(data.summary.inputTokens)} note={`${formatCompact(data.summary.cacheReadTokens)} cache read`} /><Metric label="Output tokens" value={formatCompact(data.summary.outputTokens)} note={`${formatCompact(data.summary.cacheWriteTokens)} cache write`} /></section>
        <section className="admin-chart-card"><SectionHeader title="Daily spend" detail="UTC accounting days" /><DailyChart report={data} /></section>
        <div className="admin-breakdown-grid"><Breakdown title="By model" items={data.byModel} total={data.summary.costUsd} /><Breakdown title="By operation" items={data.byOperation} total={data.summary.costUsd} /></div>
        <SectionHeader title="Highest-cost conversations" detail="Exact tracked usage" />
        <ConversationTable conversations={data.topConversations} navigate={navigate} empty="No conversation costs in this range." />
      </>}
    </Page>
  );
}

function Page({ title, subtitle, action, children }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return <><header className="admin-page-header"><div><p className="admin-kicker">Operations</p><h1>{title}</h1><p>{subtitle}</p></div>{action}</header><div className="admin-page-body">{children}</div></>;
}

function SectionHeader({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="admin-section-header"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</div>;
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="admin-metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="admin-fact"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>;
}

function ConversationTable({ conversations, navigate, empty }: { conversations: AdminConversationSummary[]; navigate: (path: string) => void; empty: string }) {
  if (conversations.length === 0) return <EmptyState text={empty} />;
  return <div className="admin-table"><div className="admin-table-head"><span>User</span><span>Latest message</span><span>Activity</span><span>Spend</span></div>{conversations.map((conversation) => <button className="admin-table-row" key={conversation.conversationId} onClick={() => navigate(`/admin/conversations/${conversation.conversationId}`)}><span className="admin-user-cell"><i>{conversationName(conversation).slice(0, 1).toUpperCase()}</i><span><strong>{conversationName(conversation)}</strong><small>{shortId(conversation.userId)} · {conversation.messageCount} messages</small></span></span><span className="admin-latest"><strong>{conversation.lastMessage?.role === "assistant" ? "Captain" : "User"}</strong> {conversation.lastMessage?.content ?? "No messages"}</span><span>{relativeTime(conversation.lastActivityAt)}</span><span className="admin-spend">{formatUsd(conversation.costUsd)}{conversation.unresolvedCostCount > 0 && <small>{conversation.unresolvedCostCount} pending</small>}</span></button>)}</div>;
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
function ErrorState({ onRetry }: { onRetry: () => void }) { return <div className="admin-empty" role="alert"><strong>Production data couldn’t be loaded.</strong><p>Your session may have expired, or the service is temporarily unavailable.</p><button className="admin-button" onClick={onRetry}>Try again</button></div>; }
function EmptyState({ text }: { text: string }) { return <div className="admin-empty"><strong>{text}</strong><p>New activity will appear here automatically.</p></div>; }

function useRefreshing<T>(loader: () => Promise<T>, dependencies: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true); setError(false);
    void loader().then(setData).catch(() => setError(true)).finally(() => setLoading(false));
  // The caller supplies the data dependencies that should replace the polling closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  useEffect(() => {
    reload();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, 30_000);
    return () => window.clearInterval(interval);
  }, [reload]);
  return { data, error, loading, reload };
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
function shortId(value: string): string { return value.length > 15 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
function humanize(value: string): string { return value.replace(/[_-]+/gu, " ").replace(/^\w/u, (letter) => letter.toUpperCase()); }
function formatUsd(value: number): string { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 6 : 2 }).format(value); }
function formatNumber(value: number): string { return new Intl.NumberFormat().format(value); }
function formatCompact(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: /^\d{4}-\d{2}-\d{2}$/u.test(value) ? "UTC" : undefined }).format(new Date(value)); }
function shortDate(value: string): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)); }
function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = absolute < 60 ? [seconds, "second"] : absolute < 3_600 ? [Math.round(seconds / 60), "minute"] : absolute < 86_400 ? [Math.round(seconds / 3_600), "hour"] : [Math.round(seconds / 86_400), "day"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit);
}
function rangeLabel(range: AdminCostRange): string { return range === "all" ? "All tracked usage" : `Last ${range.replace("d", " days")}`; }
