import type {
  AdminAutomationPage,
  AdminAutomationState,
  AdminAutomationSummary,
  AdminConversationDetail,
  AdminConversationPage,
  AdminConversationSummary,
  AdminCostBreakdown,
  AdminCostRange,
  AdminCostReport,
  AdminTripActivity,
  AdminTripDetail,
  AdminTripFlight,
  AdminTripPage,
  AdminTripSummary,
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
  listAutomations(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminAutomationPage>;
  listTrips(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminTripPage>;
  getTrip(input: { tripId: string }): Promise<AdminTripDetail | null>;
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

  async listConversations(_input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminConversationPage> {
    return { conversations: [], nextCursor: null };
  }

  async getConversation(_input: {
    conversationId: string;
    before?: string;
    limit: number;
  }): Promise<AdminConversationDetail | null> {
    return null;
  }

  async listAutomations(_input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminAutomationPage> {
    return { automations: [], nextCursor: null };
  }

  async listTrips(_input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminTripPage> {
    return { trips: [], nextCursor: null };
  }

  async getTrip(_input: { tripId: string }): Promise<AdminTripDetail | null> {
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

type TripRow = {
  trip_id: string;
  user_id: string;
  conversation_id: string | null;
  title: string;
  status: string;
  brief: Record<string, unknown>;
  updated_at: Date;
  telegram_user_id: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  flight_count: string;
  latest_event_type: string | null;
  latest_event_body: string | null;
  automation_id: string | null;
  automation_purpose: AdminAutomationState["purpose"] | null;
  automation_status: AdminAutomationState["status"] | null;
  automation_digest_hour_local: number | null;
  automation_digest_time_zone: string | null;
  automation_next_run_at: Date | null;
  automation_last_run_at: Date | null;
  automation_run_started_at: Date | null;
  automation_run_ends_at: Date | null;
  automation_completed_at: Date | null;
  automation_checks_completed: number | null;
  automation_delay_reason: string | null;
  automation_updated_at: Date | null;
};

type AutomationRow = {
  automation_id: string;
  trip_id: string;
  user_id: string;
  conversation_id: string | null;
  title: string;
  trip_status: string;
  brief: Record<string, unknown>;
  purpose: AdminAutomationState["purpose"];
  status: AdminAutomationState["status"];
  digest_hour_local: number | null;
  digest_time_zone: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  run_started_at: Date;
  run_ends_at: Date;
  completed_at: Date | null;
  checks_completed: number;
  delay_reason: string | null;
  updated_at: Date;
  telegram_user_id: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
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

const AUTOMATION_SELECT = `
  select
    watch.id as automation_id,
    watch.trip_id,
    trip.user_id,
    conversation.id as conversation_id,
    trip.title,
    trip.status as trip_status,
    trip.brief,
    watch.purpose,
    watch.status,
    watch.digest_hour_local,
    watch.digest_time_zone,
    watch.next_check_at as next_run_at,
    watch.last_check_at as last_run_at,
    watch.run_started_at,
    watch.run_ends_at,
    watch.completed_at,
    watch.checks_completed,
    watch.delay_reason,
    watch.updated_at,
    telegram.telegram_user_id::text,
    telegram.username,
    telegram.first_name,
    telegram.last_name
  from captain.watches watch
  join captain.trips trip on trip.id = watch.trip_id
  join captain.users captain_user on captain_user.id = trip.user_id
  left join captain.conversations conversation on conversation.user_id = trip.user_id
  left join captain.telegram_accounts telegram on telegram.user_id = captain_user.id
  where ($1::text is null or (
    watch.id::text ilike $1
    or watch.trip_id::text ilike $1
    or trip.user_id::text ilike $1
    or trip.title ilike $1
    or trip.brief::text ilike $1
    or watch.status ilike $1
    or replace(watch.purpose, '_', ' ') ilike $1
    or coalesce(telegram.username, '') ilike $1
    or coalesce(telegram.first_name, '') ilike $1
    or coalesce(telegram.last_name, '') ilike $1
  ))
  order by watch.updated_at desc, watch.id desc
`;

const TRIP_SELECT = `
  select
    trip.id as trip_id,
    trip.user_id,
    conversation.id as conversation_id,
    trip.title,
    trip.status,
    trip.brief,
    trip.updated_at,
    telegram.telegram_user_id::text,
    telegram.username,
    telegram.first_name,
    telegram.last_name,
    coalesce(flight_stats.flight_count, 0)::text as flight_count,
    latest_activity.event_type as latest_event_type,
    latest_activity.body as latest_event_body,
    watch.id as automation_id,
    watch.purpose as automation_purpose,
    watch.status as automation_status,
    watch.digest_hour_local as automation_digest_hour_local,
    watch.digest_time_zone as automation_digest_time_zone,
    watch.next_check_at as automation_next_run_at,
    watch.last_check_at as automation_last_run_at,
    watch.run_started_at as automation_run_started_at,
    watch.run_ends_at as automation_run_ends_at,
    watch.completed_at as automation_completed_at,
    watch.checks_completed as automation_checks_completed,
    watch.delay_reason as automation_delay_reason,
    watch.updated_at as automation_updated_at
  from captain.trips trip
  join captain.users captain_user on captain_user.id = trip.user_id
  left join captain.conversations conversation on conversation.user_id = trip.user_id
  left join captain.telegram_accounts telegram on telegram.user_id = captain_user.id
  left join captain.watches watch on watch.trip_id = trip.id
  left join lateral (
    select
      (
        select count(*)::int
        from captain.trip_legs leg
        where leg.trip_id = trip.id and leg.selected_flight_key is not null
      )
      + (
        select count(*)::int
        from captain.trip_flight_selections selection
        where selection.trip_id = trip.id
      ) as flight_count
  ) flight_stats on true
  left join lateral (
    select event.event_type, event.body
    from captain.trip_events event
    where event.trip_id = trip.id
    order by event.created_at desc, event.id desc
    limit 1
  ) latest_activity on true
  where ($1::text is null or (
    trip.id::text ilike $1
    or trip.title ilike $1
    or trip.status ilike $1
    or coalesce(watch.status, '') ilike $1
    or replace(coalesce(watch.purpose, ''), '_', ' ') ilike $1
    or captain_user.id::text ilike $1
    or coalesce(telegram.username, '') ilike $1
    or coalesce(telegram.first_name, '') ilike $1
    or coalesce(telegram.last_name, '') ilike $1
  ))
  and ($2::uuid is null or trip.id = $2::uuid)
  order by trip.updated_at desc, trip.id desc
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

  async listAutomations(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminAutomationPage> {
    const query = input.query?.trim().slice(0, 120);
    const rows = await this.#automationRows(query ? `%${query}%` : null);
    const cursor = decodeCursor(input.cursor);
    const afterCursor = cursor
      ? rows.filter((row) => automationAfterCursor(row, cursor))
      : rows;
    const limit = Math.max(1, Math.min(input.limit, 50));
    const selected = afterCursor.slice(0, limit + 1);
    const hasMore = selected.length > limit;
    const pageRows = selected.slice(0, limit);
    const automations = pageRows.map(toAutomationSummary);
    const last = pageRows.at(-1);
    return {
      automations,
      nextCursor: hasMore && last
        ? encodeCursor({ at: last.updated_at.toISOString(), id: last.automation_id })
        : null
    };
  }

  async listTrips(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<AdminTripPage> {
    const query = input.query?.trim().slice(0, 120);
    const rows = await this.#tripRows(query ? `%${query}%` : null, null);
    const cursor = decodeCursor(input.cursor);
    const afterCursor = cursor
      ? rows.filter((row) => tripAfterCursor(row, cursor))
      : rows;
    const limit = Math.max(1, Math.min(input.limit, 50));
    const selected = afterCursor.slice(0, limit + 1);
    const hasMore = selected.length > limit;
    const pageRows = selected.slice(0, limit);
    const trips = pageRows.map(toTripSummary);
    const last = pageRows.at(-1);
    return {
      trips,
      nextCursor: hasMore && last
        ? encodeCursor({ at: last.updated_at.toISOString(), id: last.trip_id })
        : null
    };
  }

  async getTrip(input: { tripId: string }): Promise<AdminTripDetail | null> {
    const rows = await this.#tripRows(null, input.tripId);
    const row = rows[0];
    if (!row) return null;
    const [activityRows, flights] = await Promise.all([
      this.#sql<Array<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
        created_at: Date;
        body: string | null;
        channel: AdminTripActivity["channel"];
        notification_id: string | null;
        source_message_id: string | null;
      }>>`
        select
          event.id,
          event.event_type,
          event.payload,
          event.created_at,
          event.body,
          event.channel,
          event.notification_id,
          event.source_message_id
        from captain.trip_events event
        where event.trip_id = ${input.tripId}
        order by event.created_at desc, event.id desc
        limit 50
      `,
      this.#tripFlights(input.tripId)
    ]);
    return {
      trip: toTripSummary(row),
      activity: activityRows.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        payload: event.payload ?? {},
        createdAt: event.created_at.toISOString(),
        body: event.body,
        channel: event.channel ?? "system",
        notificationId: event.notification_id,
        sourceMessageId: event.source_message_id
      })),
      flights
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

  #automationRows(search: string | null): Promise<AutomationRow[]> {
    return this.#sql.unsafe(AUTOMATION_SELECT, [search]);
  }

  #tripRows(search: string | null, tripId: string | null): Promise<TripRow[]> {
    return this.#sql.unsafe(TRIP_SELECT, [search, tripId]);
  }

  async #tripFlights(tripId: string): Promise<AdminTripFlight[]> {
    const legRows = await this.#sql<Array<{
      leg_id: string;
      position: number;
      origin_label: string;
      destination_label: string;
      origin_airports: string[];
      destination_airports: string[];
      selected_flight_key: string;
      departure_start: string;
      flight: {
        key?: string;
        origin?: string;
        destination?: string;
        departureDate?: string;
        primaryAirlineCode?: string;
      } | null;
      offer: {
        priceAmount?: string;
        currency?: string;
      } | null;
    }>>`
      select
        leg.id as leg_id,
        leg.position,
        origin.label as origin_label,
        destination.label as destination_label,
        origin.airport_codes as origin_airports,
        destination.airport_codes as destination_airports,
        leg.selected_flight_key,
        leg.departure_start::text as departure_start,
        (
          select flight
          from captain.leg_search_snapshots snapshot,
            jsonb_array_elements(snapshot.flights) flight
          where snapshot.id = leg.latest_search_id
            and flight ->> 'key' = leg.selected_flight_key
          limit 1
        ) as flight,
        (
          select offer
          from captain.leg_search_snapshots snapshot,
            jsonb_array_elements(snapshot.offers) offer
          where snapshot.id = leg.latest_search_id
            and offer ->> 'flightKey' = leg.selected_flight_key
          order by (offer ->> 'observedAt') desc nulls last
          limit 1
        ) as offer
      from captain.trip_legs leg
      join captain.trip_cities origin on origin.id = leg.origin_city_id
      join captain.trip_cities destination on destination.id = leg.destination_city_id
      where leg.trip_id = ${tripId}
        and leg.selected_flight_key is not null
      order by leg.position asc, leg.id asc
    `;

    const selectionRows = await this.#sql<Array<{
      itinerary_key: string;
      selected_by: "agent" | "person";
      selected_at: Date;
    }>>`
      select selection.itinerary_key, selection.selected_by, selection.selected_at
      from captain.trip_flight_selections selection
      where selection.trip_id = ${tripId}
      order by selection.selected_at desc, selection.itinerary_key
    `;

    const fromLegs: AdminTripFlight[] = legRows.map((row) => {
      const originCode = row.flight?.origin
        ?? row.origin_airports?.[0]
        ?? row.origin_label;
      const destinationCode = row.flight?.destination
        ?? row.destination_airports?.[0]
        ?? row.destination_label;
      return {
        id: row.leg_id,
        legLabel: `Leg ${row.position + 1}`,
        airlineCode: row.flight?.primaryAirlineCode ?? null,
        routeLabel: `${originCode} → ${destinationCode}`,
        departureDate: row.flight?.departureDate ?? row.departure_start ?? null,
        priceAmount: row.offer?.priceAmount ?? null,
        currency: row.offer?.currency ?? null,
        selectedBy: null,
        flightKey: row.selected_flight_key
      };
    });

    const fromSelections: AdminTripFlight[] = selectionRows.map((row) => ({
      id: `${row.itinerary_key}:${row.selected_by}`,
      legLabel: "Watch",
      airlineCode: null,
      routeLabel: row.itinerary_key,
      departureDate: null,
      priceAmount: null,
      currency: null,
      selectedBy: row.selected_by,
      flightKey: row.itinerary_key
    }));

    return [...fromLegs, ...fromSelections];
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

function tripAfterCursor(row: TripRow, cursor: Cursor): boolean {
  const at = row.updated_at.toISOString();
  return at < cursor.at || (at === cursor.at && row.trip_id < cursor.id);
}

function automationAfterCursor(row: AutomationRow, cursor: Cursor): boolean {
  const at = row.updated_at.toISOString();
  return at < cursor.at || (at === cursor.at && row.automation_id < cursor.id);
}

function toAutomationSummary(row: AutomationRow): AdminAutomationSummary {
  const displayName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim()
    || (row.username ? `@${row.username}` : "")
    || row.user_id;
  return {
    automationId: row.automation_id,
    tripId: row.trip_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    title: row.title,
    tripStatus: row.trip_status,
    routeLabel: routeLabelFromBrief(row.brief),
    purpose: row.purpose,
    status: row.status,
    digestHourLocal: row.digest_hour_local === null ? null : integer(row.digest_hour_local),
    digestTimeZone: row.digest_time_zone,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    runStartedAt: row.run_started_at.toISOString(),
    runEndsAt: row.run_ends_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    checksCompleted: integer(row.checks_completed),
    delayReason: row.delay_reason,
    updatedAt: row.updated_at.toISOString(),
    identities: row.telegram_user_id ? [{
      channel: "telegram",
      displayName,
      username: row.username
    }] : []
  };
}

function toTripSummary(row: TripRow): AdminTripSummary {
  const displayName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim()
    || (row.username ? `@${row.username}` : "")
    || row.user_id;
  return {
    tripId: row.trip_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    title: row.title,
    status: row.status,
    routeLabel: routeLabelFromBrief(row.brief),
    updatedAt: row.updated_at.toISOString(),
    identities: row.telegram_user_id ? [{
      channel: "telegram",
      displayName,
      username: row.username
    }] : [],
    flightCount: integer(row.flight_count),
    latestActivityLabel: row.latest_event_body?.trim()
      || (row.latest_event_type ? humanize(row.latest_event_type) : null),
    automation: tripAutomation(row)
  };
}

function tripAutomation(row: TripRow): AdminAutomationState | null {
  if (
    !row.automation_id
    || !row.automation_purpose
    || !row.automation_status
    || !row.automation_run_started_at
    || !row.automation_run_ends_at
    || !row.automation_updated_at
  ) return null;
  return {
    automationId: row.automation_id,
    purpose: row.automation_purpose,
    status: row.automation_status,
    digestHourLocal: row.automation_digest_hour_local === null
      ? null
      : integer(row.automation_digest_hour_local),
    digestTimeZone: row.automation_digest_time_zone,
    nextRunAt: row.automation_next_run_at?.toISOString() ?? null,
    lastRunAt: row.automation_last_run_at?.toISOString() ?? null,
    runStartedAt: row.automation_run_started_at.toISOString(),
    runEndsAt: row.automation_run_ends_at.toISOString(),
    completedAt: row.automation_completed_at?.toISOString() ?? null,
    checksCompleted: integer(row.automation_checks_completed),
    delayReason: row.automation_delay_reason,
    updatedAt: row.automation_updated_at.toISOString()
  };
}

function routeLabelFromBrief(brief: Record<string, unknown>): string {
  const tripType = typeof brief.tripType === "string" ? brief.tripType : null;
  const legs = Array.isArray(brief.legs) ? brief.legs : [];
  if (tripType === "multi_city" && legs.length > 0) {
    const first = legs[0] as { originAirports?: unknown; destinationAirports?: unknown };
    const origin = joinAirports(first?.originAirports);
    const destinations = legs.map((leg) =>
      joinAirports((leg as { destinationAirports?: unknown }).destinationAirports)
    );
    if (origin && destinations.every(Boolean)) return [origin, ...destinations].join(" → ");
  }
  const origin = joinAirports(brief.originAirports);
  const destination = joinAirports(brief.destinationAirports);
  if (origin && destination) return `${origin} → ${destination}`;
  return "Route unavailable";
}

function joinAirports(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string" && item.length > 0).join("/");
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
