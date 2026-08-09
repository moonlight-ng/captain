import type {
  AdminConversationDetail,
  AdminConversationPage,
  AdminConversationSummary,
  AdminCostBreakdown,
  AdminCostRange,
  AdminCostReport,
  AgentSession,
  AgentSessionStatus,
  ModelUsageLookupStatus
} from "@agents/flight-domain";
import postgres, { type Sql } from "postgres";

export type RecordAgentSessionInput = {
  sessionId: string;
  userId: string | null;
  agentName: string;
  channel: string;
  model: string;
  status: AgentSessionStatus;
  occurredAt: Date;
  turnStarted?: boolean;
  ended?: boolean;
  failureCode?: string | null;
};

export type RecordModelUsageInput = {
  eventKey: string;
  userId: string | null;
  sessionId: string | null;
  source: "eve" | "gateway";
  operation: string;
  model: string;
  provider?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  webSearchCalls?: number;
  costUsd?: number | null;
  gatewayGenerationId?: string | null;
  lookupStatus: ModelUsageLookupStatus;
  occurredAt: Date;
};

export type PendingModelUsage = {
  eventKey: string;
  gatewayGenerationId: string;
  lookupAttempts: number;
};

export type ResolvedModelUsage = {
  costUsd: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchCalls: number;
};

export type AdminOverviewData = {
  trackingStartedAt: string;
  lastActivityAt: string | null;
  activeTurns: number;
  metrics: {
    users: number;
    conversations: number;
    messages24h: number;
    modelCalls30d: number;
    costUsd30d: number;
    unresolvedCostCount: number;
  };
  recentConversations: AdminConversationSummary[];
};

export interface CaptainAdminStore {
  recordAgentSession(input: RecordAgentSessionInput): Promise<void>;
  recordModelUsage(input: RecordModelUsageInput): Promise<void>;
  listPendingModelUsage(limit?: number): Promise<PendingModelUsage[]>;
  resolveModelUsage(eventKey: string, usage: ResolvedModelUsage, now: Date): Promise<void>;
  failModelUsageLookup(eventKey: string, terminal: boolean, now: Date): Promise<void>;
  getOverview(now: Date): Promise<AdminOverviewData>;
  listConversations(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminConversationPage>;
  getConversation(input: {
    conversationId: string;
    before?: string;
    limit: number;
  }): Promise<AdminConversationDetail | null>;
  getCosts(range: AdminCostRange, now: Date): Promise<AdminCostReport>;
}

export class MemoryCaptainAdminStore implements CaptainAdminStore {
  readonly #trackingStartedAt = new Date().toISOString();
  readonly #sessions = new Map<string, AgentSession>();
  readonly #usage = new Map<string, RecordModelUsageInput & { lookupAttempts: number }>();

  async recordAgentSession(input: RecordAgentSessionInput): Promise<void> {
    const current = this.#sessions.get(input.sessionId);
    const at = input.occurredAt.toISOString();
    const newest = !current || at >= current.lastEventAt;
    this.#sessions.set(input.sessionId, {
      sessionId: input.sessionId,
      userId: input.userId ?? current?.userId ?? null,
      agentName: newest ? input.agentName : current!.agentName,
      channel: newest ? input.channel : current!.channel,
      model: newest ? input.model : current!.model,
      status: newest ? input.status : current!.status,
      startedAt: current ? [current.startedAt, at].sort()[0]! : at,
      lastEventAt: current ? [current.lastEventAt, at].sort().at(-1)! : at,
      lastTurnAt: input.turnStarted
        ? [current?.lastTurnAt, at].filter((value): value is string => Boolean(value)).sort().at(-1)!
        : current?.lastTurnAt ?? null,
      endedAt: input.ended ? at : current?.endedAt ?? null,
      failureCode: input.failureCode ?? current?.failureCode ?? null
    });
  }

  async recordModelUsage(input: RecordModelUsageInput): Promise<void> {
    if (this.#usage.has(input.eventKey)) return;
    if (
      input.gatewayGenerationId
      && [...this.#usage.values()].some((item) => item.gatewayGenerationId === input.gatewayGenerationId)
    ) return;
    this.#usage.set(input.eventKey, { ...input, lookupAttempts: 0 });
  }

  async listPendingModelUsage(limit = 25): Promise<PendingModelUsage[]> {
    return [...this.#usage.values()]
      .filter((item) => item.lookupStatus === "pending" && item.gatewayGenerationId)
      .slice(0, limit)
      .map((item) => ({
        eventKey: item.eventKey,
        gatewayGenerationId: item.gatewayGenerationId!,
        lookupAttempts: item.lookupAttempts
      }));
  }

  async resolveModelUsage(eventKey: string, usage: ResolvedModelUsage): Promise<void> {
    const current = this.#usage.get(eventKey);
    if (!current) return;
    this.#usage.set(eventKey, {
      ...current,
      ...usage,
      lookupStatus: "complete",
      lookupAttempts: current.lookupAttempts + 1
    });
  }

  async failModelUsageLookup(eventKey: string, terminal: boolean): Promise<void> {
    const current = this.#usage.get(eventKey);
    if (!current) return;
    this.#usage.set(eventKey, {
      ...current,
      lookupStatus: terminal ? "unavailable" : "pending",
      lookupAttempts: current.lookupAttempts + 1
    });
  }

  async getOverview(now: Date): Promise<AdminOverviewData> {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
    const recent = [...this.#usage.values()].filter((item) => item.occurredAt >= thirtyDaysAgo);
    const lastActivityAt = [...this.#sessions.values()]
      .map((item) => item.lastEventAt)
      .sort()
      .at(-1) ?? null;
    return {
      trackingStartedAt: this.#trackingStartedAt,
      lastActivityAt,
      activeTurns: [...this.#sessions.values()].filter((item) =>
        item.status === "active"
        && new Date(item.lastEventAt).getTime() >= now.getTime() - 10 * 60_000
      ).length,
      metrics: {
        users: 0,
        conversations: 0,
        messages24h: 0,
        modelCalls30d: recent.length,
        costUsd30d: sum(recent.map((item) => item.costUsd ?? 0)),
        unresolvedCostCount: recent.filter((item) => item.lookupStatus !== "complete").length
      },
      recentConversations: []
    };
  }

  async listConversations(): Promise<AdminConversationPage> {
    return { conversations: [], nextCursor: null };
  }

  async getConversation(): Promise<AdminConversationDetail | null> {
    return null;
  }

  async getCosts(range: AdminCostRange, now: Date): Promise<AdminCostReport> {
    const from = rangeStart(range, new Date(this.#trackingStartedAt), now);
    const events = [...this.#usage.values()].filter((item) => item.occurredAt >= from);
    const complete = events.filter((item) => item.lookupStatus === "complete");
    return {
      range,
      from: from.toISOString(),
      through: now.toISOString(),
      trackingStartedAt: this.#trackingStartedAt,
      summary: {
        costUsd: sum(complete.map((item) => item.costUsd ?? 0)),
        calls: events.length,
        inputTokens: sum(events.map((item) => item.inputTokens ?? 0)),
        outputTokens: sum(events.map((item) => item.outputTokens ?? 0)),
        cacheReadTokens: sum(events.map((item) => item.cacheReadTokens ?? 0)),
        cacheWriteTokens: sum(events.map((item) => item.cacheWriteTokens ?? 0)),
        unresolvedCostCount: events.length - complete.length
      },
      daily: dailyBuckets(from, now, usageDays(events)),
      byModel: breakdown(events, (item) => item.model),
      byOperation: breakdown(events, (item) => item.operation),
      topConversations: []
    };
  }
}

type ConversationRow = {
  conversation_id: string;
  user_id: string;
  conversation_created_at: Date;
  telegram_user_id: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  last_role: "user" | "assistant" | null;
  last_content: string | null;
  last_message_at: Date | null;
  message_count: string;
  session_count: string;
  cost_usd: string;
  unresolved_cost_count: string;
};

type SessionRow = {
  session_id: string;
  user_id: string | null;
  agent_name: string;
  channel: string;
  model: string;
  status: AgentSessionStatus;
  started_at: Date;
  last_event_at: Date;
  last_turn_at: Date | null;
  ended_at: Date | null;
  failure_code: string | null;
};

const CONVERSATION_SELECT = `
  select
    conversation.id as conversation_id,
    conversation.user_id,
    conversation.created_at as conversation_created_at,
    telegram.telegram_user_id::text,
    telegram.username,
    telegram.first_name,
    telegram.last_name,
    latest.role as last_role,
    latest.content as last_content,
    latest.created_at as last_message_at,
    coalesce(message_stats.message_count, 0)::text as message_count,
    coalesce(session_stats.session_count, 0)::text as session_count,
    coalesce(usage_stats.cost_usd, 0)::text as cost_usd,
    coalesce(usage_stats.unresolved_cost_count, 0)::text as unresolved_cost_count
  from captain.conversations conversation
  join captain.users captain_user on captain_user.id = conversation.user_id
  left join captain.telegram_accounts telegram on telegram.user_id = captain_user.id
  left join lateral (
    select message.role, message.content, message.created_at
    from captain.messages message
    where message.conversation_id = conversation.id
    order by message.created_at desc, message.id desc
    limit 1
  ) latest on true
  left join lateral (
    select count(*) as message_count
    from captain.messages message
    where message.conversation_id = conversation.id
  ) message_stats on true
  left join lateral (
    select count(*) as session_count
    from captain.agent_sessions session
    where session.user_id = conversation.user_id
  ) session_stats on true
  left join lateral (
    select
      coalesce(sum(usage.cost_usd) filter (where usage.lookup_status = 'complete'), 0) as cost_usd,
      count(*) filter (where usage.lookup_status <> 'complete') as unresolved_cost_count
    from captain.model_usage_events usage
    where usage.user_id = conversation.user_id
  ) usage_stats on true
  where ($1::text is null or (
    captain_user.id::text ilike $1
    or coalesce(telegram.username, '') ilike $1
    or coalesce(telegram.first_name, '') ilike $1
    or coalesce(telegram.last_name, '') ilike $1
    or exists (
      select 1 from captain.messages searched
      where searched.conversation_id = conversation.id and searched.content ilike $1
    )
  ))
  and ($2::uuid is null or conversation.id = $2::uuid)
  order by coalesce(latest.created_at, conversation.created_at) desc, conversation.id desc
`;

export class PostgresCaptainAdminStore implements CaptainAdminStore {
  readonly #sql: Sql;

  private constructor(sql: Sql) {
    this.#sql = sql;
  }

  static connect(databaseUrl: string, max = 2): PostgresCaptainAdminStore {
    return new PostgresCaptainAdminStore(postgres(databaseUrl, {
      max,
      idle_timeout: 600,
      connect_timeout: 15,
      transform: { undefined: null }
    }));
  }

  async recordAgentSession(input: RecordAgentSessionInput): Promise<void> {
    const at = input.occurredAt;
    await this.#sql`
      insert into captain.agent_sessions (
        session_id, user_id, agent_name, channel, model, status,
        started_at, last_event_at, last_turn_at, ended_at, failure_code, updated_at
      ) values (
        ${input.sessionId}, ${input.userId}, ${input.agentName}, ${input.channel},
        ${input.model}, ${input.status}, ${at}, ${at},
        ${input.turnStarted ? at : null}, ${input.ended ? at : null},
        ${input.failureCode ?? null}, ${at}
      )
      on conflict (session_id) do update set
        user_id = coalesce(excluded.user_id, captain.agent_sessions.user_id),
        agent_name = excluded.agent_name,
        channel = excluded.channel,
        model = excluded.model,
        status = case
          when excluded.last_event_at >= captain.agent_sessions.last_event_at then excluded.status
          else captain.agent_sessions.status
        end,
        last_event_at = greatest(captain.agent_sessions.last_event_at, excluded.last_event_at),
        last_turn_at = case
          when excluded.last_turn_at is null then captain.agent_sessions.last_turn_at
          else greatest(
            coalesce(captain.agent_sessions.last_turn_at, excluded.last_turn_at),
            excluded.last_turn_at
          )
        end,
        ended_at = coalesce(excluded.ended_at, captain.agent_sessions.ended_at),
        failure_code = coalesce(excluded.failure_code, captain.agent_sessions.failure_code),
        updated_at = excluded.updated_at
    `;
  }

  async recordModelUsage(input: RecordModelUsageInput): Promise<void> {
    const now = new Date();
    await this.#sql`
      insert into captain.model_usage_events (
        event_key, user_id, session_id, source, operation, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        web_search_calls, cost_usd, gateway_generation_id, lookup_status,
        occurred_at, created_at, updated_at
      ) values (
        ${input.eventKey}, ${input.userId}, ${input.sessionId}, ${input.source},
        ${input.operation}, ${input.model}, ${input.provider ?? null},
        ${nonNegative(input.inputTokens)}, ${nonNegative(input.outputTokens)},
        ${nonNegative(input.cacheReadTokens)}, ${nonNegative(input.cacheWriteTokens)},
        ${nonNegative(input.webSearchCalls)}, ${moneyValue(input.costUsd)},
        ${input.gatewayGenerationId ?? null}, ${input.lookupStatus},
        ${input.occurredAt}, ${now}, ${now}
      )
      on conflict do nothing
    `;
  }

  async listPendingModelUsage(limit = 25): Promise<PendingModelUsage[]> {
    const rows = await this.#sql<Array<{
      event_key: string;
      gateway_generation_id: string;
      lookup_attempts: number;
    }>>`
      select event_key, gateway_generation_id, lookup_attempts
      from captain.model_usage_events
      where lookup_status = 'pending'
        and gateway_generation_id is not null
        and lookup_attempts < 6
      order by occurred_at asc
      limit ${Math.max(1, Math.min(limit, 100))}
    `;
    return rows.map((row) => ({
      eventKey: row.event_key,
      gatewayGenerationId: row.gateway_generation_id,
      lookupAttempts: row.lookup_attempts
    }));
  }

  async resolveModelUsage(eventKey: string, usage: ResolvedModelUsage, now: Date): Promise<void> {
    await this.#sql`
      update captain.model_usage_events set
        cost_usd = ${moneyValue(usage.costUsd)},
        model = ${usage.model},
        provider = ${usage.provider},
        input_tokens = ${nonNegative(usage.inputTokens)},
        output_tokens = ${nonNegative(usage.outputTokens)},
        cache_read_tokens = ${nonNegative(usage.cacheReadTokens)},
        cache_write_tokens = ${nonNegative(usage.cacheWriteTokens)},
        web_search_calls = ${nonNegative(usage.webSearchCalls)},
        lookup_status = 'complete',
        lookup_attempts = lookup_attempts + 1,
        last_lookup_at = ${now},
        updated_at = ${now}
      where event_key = ${eventKey}
    `;
  }

  async failModelUsageLookup(eventKey: string, terminal: boolean, now: Date): Promise<void> {
    await this.#sql`
      update captain.model_usage_events set
        lookup_status = ${terminal ? "unavailable" : "pending"},
        lookup_attempts = lookup_attempts + 1,
        last_lookup_at = ${now},
        updated_at = ${now}
      where event_key = ${eventKey}
    `;
  }

  async getOverview(now: Date): Promise<AdminOverviewData> {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const [metaRows, totalRows, usageRows, activityRows, recent] = await Promise.all([
      this.#sql<Array<{ usage_tracking_started_at: Date }>>`
        select usage_tracking_started_at from captain.project_meta where singleton = true
      `,
      this.#sql<Array<{ users: string; conversations: string; messages_24h: string }>>`
        select
          (select count(*) from captain.users)::text as users,
          (select count(*) from captain.conversations)::text as conversations,
          (select count(*) from captain.messages where created_at >= ${dayAgo})::text as messages_24h
      `,
      this.#sql<Array<{ calls: string; cost_usd: string; unresolved: string }>>`
        select
          count(*)::text as calls,
          coalesce(sum(cost_usd) filter (where lookup_status = 'complete'), 0)::text as cost_usd,
          count(*) filter (where lookup_status <> 'complete')::text as unresolved
        from captain.model_usage_events
        where occurred_at >= ${thirtyDaysAgo}
      `,
      this.#sql<Array<{ last_activity_at: Date | null; active_turns: string }>>`
        select
          max(last_event_at) as last_activity_at,
          count(*) filter (
            where status = 'active' and last_event_at >= ${new Date(now.getTime() - 10 * 60_000)}
          )::text as active_turns
        from captain.agent_sessions
      `,
      this.listConversations({ limit: 5 })
    ]);
    const trackingStartedAt = metaRows[0]?.usage_tracking_started_at ?? now;
    const totals = totalRows[0];
    const usage = usageRows[0];
    const activity = activityRows[0];
    return {
      trackingStartedAt: trackingStartedAt.toISOString(),
      lastActivityAt: activity?.last_activity_at?.toISOString() ?? null,
      activeTurns: integer(activity?.active_turns),
      metrics: {
        users: integer(totals?.users),
        conversations: integer(totals?.conversations),
        messages24h: integer(totals?.messages_24h),
        modelCalls30d: integer(usage?.calls),
        costUsd30d: decimal(usage?.cost_usd),
        unresolvedCostCount: integer(usage?.unresolved)
      },
      recentConversations: recent.conversations
    };
  }

  async listConversations(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminConversationPage> {
    const query = input.query?.trim().slice(0, 120);
    const rows = await this.#conversationRows(query ? `%${query}%` : null, null);
    const cursor = decodeCursor(input.cursor);
    const afterCursor = cursor
      ? rows.filter((row) => conversationAfterCursor(row, cursor))
      : rows;
    const limit = Math.max(1, Math.min(input.limit, 50));
    const selected = afterCursor.slice(0, limit + 1);
    const hasMore = selected.length > limit;
    const pageRows = selected.slice(0, limit);
    const conversations = pageRows.map(toConversationSummary);
    const last = pageRows.at(-1);
    return {
      conversations,
      nextCursor: hasMore && last
        ? encodeCursor({ at: conversationActivity(last).toISOString(), id: last.conversation_id })
        : null
    };
  }

  async getConversation(input: {
    conversationId: string;
    before?: string;
    limit: number;
  }): Promise<AdminConversationDetail | null> {
    const rows = await this.#conversationRows(null, input.conversationId);
    const row = rows[0];
    if (!row) return null;
    const before = decodeCursor(input.before);
    const limit = Math.max(1, Math.min(input.limit, 100));
    const messages = await this.#sql<Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      created_at: Date;
    }>>`
      select id, role, content, created_at
      from captain.messages
      where conversation_id = ${input.conversationId}
        and (
          ${before?.at ?? null}::timestamptz is null
          or (created_at, id) < (${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid)
        )
      order by created_at desc, id desc
      limit ${limit + 1}
    `;
    const hasOlder = messages.length > limit;
    const page = messages.slice(0, limit).reverse();
    const oldest = page[0];
    const sessions = await this.#sql<SessionRow[]>`
      select session_id, user_id, agent_name, channel, model, status,
        started_at, last_event_at, last_turn_at, ended_at, failure_code
      from captain.agent_sessions
      where user_id = ${row.user_id}
      order by last_event_at desc
      limit 20
    `;
    return {
      conversation: toConversationSummary(row),
      messages: page.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.created_at.toISOString()
      })),
      sessions: sessions.map(toAgentSession),
      olderCursor: hasOlder && oldest
        ? encodeCursor({ at: oldest.created_at.toISOString(), id: oldest.id })
        : null
    };
  }

  async getCosts(range: AdminCostRange, now: Date): Promise<AdminCostReport> {
    const metaRows = await this.#sql<Array<{ usage_tracking_started_at: Date }>>`
      select usage_tracking_started_at from captain.project_meta where singleton = true
    `;
    const trackingStartedAt = metaRows[0]?.usage_tracking_started_at ?? now;
    const from = rangeStart(range, trackingStartedAt, now);
    const [summaryRows, dailyRows, modelRows, operationRows, conversations] = await Promise.all([
      this.#sql<Array<{
        cost_usd: string;
        calls: string;
        input_tokens: string;
        output_tokens: string;
        cache_read_tokens: string;
        cache_write_tokens: string;
        unresolved: string;
      }>>`
        select
          coalesce(sum(cost_usd) filter (where lookup_status = 'complete'), 0)::text as cost_usd,
          count(*)::text as calls,
          coalesce(sum(input_tokens), 0)::text as input_tokens,
          coalesce(sum(output_tokens), 0)::text as output_tokens,
          coalesce(sum(cache_read_tokens), 0)::text as cache_read_tokens,
          coalesce(sum(cache_write_tokens), 0)::text as cache_write_tokens,
          count(*) filter (where lookup_status <> 'complete')::text as unresolved
        from captain.model_usage_events
        where occurred_at >= ${from} and occurred_at <= ${now}
      `,
      this.#sql<Array<{ day: string; cost_usd: string; calls: string }>>`
        select
          to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') as day,
          coalesce(sum(cost_usd) filter (where lookup_status = 'complete'), 0)::text as cost_usd,
          count(*)::text as calls
        from captain.model_usage_events
        where occurred_at >= ${from} and occurred_at <= ${now}
        group by 1 order by 1
      `,
      this.#sql<Array<{ key: string; cost_usd: string; calls: string }>>`
        select model as key,
          coalesce(sum(cost_usd) filter (where lookup_status = 'complete'), 0)::text as cost_usd,
          count(*)::text as calls
        from captain.model_usage_events
        where occurred_at >= ${from} and occurred_at <= ${now}
        group by model order by sum(coalesce(cost_usd, 0)) desc
      `,
      this.#sql<Array<{ key: string; cost_usd: string; calls: string }>>`
        select operation as key,
          coalesce(sum(cost_usd) filter (where lookup_status = 'complete'), 0)::text as cost_usd,
          count(*)::text as calls
        from captain.model_usage_events
        where occurred_at >= ${from} and occurred_at <= ${now}
        group by operation order by sum(coalesce(cost_usd, 0)) desc
      `,
      this.#conversationRows(null, null)
    ]);
    const summary = summaryRows[0];
    return {
      range,
      from: from.toISOString(),
      through: now.toISOString(),
      trackingStartedAt: trackingStartedAt.toISOString(),
      summary: {
        costUsd: decimal(summary?.cost_usd),
        calls: integer(summary?.calls),
        inputTokens: integer(summary?.input_tokens),
        outputTokens: integer(summary?.output_tokens),
        cacheReadTokens: integer(summary?.cache_read_tokens),
        cacheWriteTokens: integer(summary?.cache_write_tokens),
        unresolvedCostCount: integer(summary?.unresolved)
      },
      daily: dailyBuckets(from, now, dailyRows.map((row) => ({
        date: row.day,
        costUsd: decimal(row.cost_usd),
        calls: integer(row.calls)
      }))),
      byModel: modelRows.map(toBreakdown),
      byOperation: operationRows.map(toBreakdown),
      topConversations: conversations
        .map(toConversationSummary)
        .filter((item) => item.costUsd > 0 || item.unresolvedCostCount > 0)
        .sort((left, right) => right.costUsd - left.costUsd)
        .slice(0, 5)
    };
  }

  #conversationRows(search: string | null, conversationId: string | null): Promise<ConversationRow[]> {
    return this.#sql.unsafe(CONVERSATION_SELECT, [search, conversationId]);
  }
}

type Cursor = { at: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof parsed.at !== "string"
      || !Number.isFinite(Date.parse(parsed.at))
      || typeof parsed.id !== "string"
      || parsed.id.length === 0
    ) return null;
    return { at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
}

function conversationActivity(row: ConversationRow): Date {
  return row.last_message_at ?? row.conversation_created_at;
}

function conversationAfterCursor(row: ConversationRow, cursor: Cursor): boolean {
  const at = conversationActivity(row).toISOString();
  return at < cursor.at || (at === cursor.at && row.conversation_id < cursor.id);
}

function toConversationSummary(row: ConversationRow): AdminConversationSummary {
  const displayName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim()
    || (row.username ? `@${row.username}` : "")
    || row.user_id;
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    identities: row.telegram_user_id ? [{
      channel: "telegram",
      displayName,
      username: row.username
    }] : [],
    lastMessage: row.last_role && row.last_content && row.last_message_at ? {
      role: row.last_role,
      content: row.last_content,
      createdAt: row.last_message_at.toISOString()
    } : null,
    lastActivityAt: conversationActivity(row).toISOString(),
    messageCount: integer(row.message_count),
    sessionCount: integer(row.session_count),
    costUsd: decimal(row.cost_usd),
    unresolvedCostCount: integer(row.unresolved_cost_count)
  };
}

function toAgentSession(row: SessionRow): AgentSession {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    agentName: row.agent_name,
    channel: row.channel,
    model: row.model,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    lastEventAt: row.last_event_at.toISOString(),
    lastTurnAt: row.last_turn_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    failureCode: row.failure_code
  };
}

function rangeStart(range: AdminCostRange, trackingStartedAt: Date, now: Date): Date {
  if (range === "all") return trackingStartedAt;
  const days = range === "7d" ? 7 : 30;
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)
  ));
  return start < trackingStartedAt ? trackingStartedAt : start;
}

function dailyBuckets(
  from: Date,
  through: Date,
  values: Array<{ date: string; costUsd: number; calls: number }>
): Array<{ date: string; costUsd: number; calls: number }> {
  const byDate = new Map(values.map((value) => [value.date, value]));
  const result: Array<{ date: string; costUsd: number; calls: number }> = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), through.getUTCDate()));
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? { date, costUsd: 0, calls: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function usageDays(values: Array<{
  occurredAt: Date;
  lookupStatus: ModelUsageLookupStatus;
  costUsd?: number | null;
}>): Array<{ date: string; costUsd: number; calls: number }> {
  const grouped = new Map<string, { date: string; costUsd: number; calls: number }>();
  for (const value of values) {
    const date = value.occurredAt.toISOString().slice(0, 10);
    const current = grouped.get(date) ?? { date, costUsd: 0, calls: 0 };
    current.calls += 1;
    if (value.lookupStatus === "complete") current.costUsd += value.costUsd ?? 0;
    grouped.set(date, current);
  }
  return [...grouped.values()];
}

function toBreakdown(row: { key: string; cost_usd: string; calls: string }): AdminCostBreakdown {
  return {
    key: row.key,
    label: humanize(row.key),
    costUsd: decimal(row.cost_usd),
    calls: integer(row.calls)
  };
}

function breakdown<T extends { costUsd?: number | null }>(
  values: T[],
  keyFor: (value: T) => string
): AdminCostBreakdown[] {
  const grouped = new Map<string, { costUsd: number; calls: number }>();
  for (const value of values) {
    const key = keyFor(value);
    const current = grouped.get(key) ?? { costUsd: 0, calls: 0 };
    current.costUsd += value.costUsd ?? 0;
    current.calls += 1;
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([key, value]) => ({
    key,
    label: humanize(key),
    ...value
  })).sort((left, right) => right.costUsd - left.costUsd);
}

function humanize(value: string): string {
  return value
    .replace(/^openai\//u, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function moneyValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function integer(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : Math.max(0, Math.trunc(parsed || 0));
}

function decimal(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
