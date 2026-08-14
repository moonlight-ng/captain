import postgres, { type Sql } from "postgres";

export type ConversationReviewMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  inWindow: boolean;
};

export type ConversationReviewThread = {
  conversationId: string;
  userId: string;
  displayName: string;
  username: string | null;
  messageCount: number;
  travellerMessageCount: number;
  captainMessageCount: number;
  modelCalls: number;
  costUsd: number;
  unresolvedCostCount: number;
  messages: ConversationReviewMessage[];
};

export type ConversationReviewDeliveryClaim = "new" | "duplicate";

export interface CaptainConversationReviewStore {
  loadConversationReviewThreads(
    since: Date,
    until: Date
  ): Promise<ConversationReviewThread[]>;
  claimConversationReviewDelivery(input: {
    date: string;
    since: Date;
    until: Date;
    recipients: string[];
    now: Date;
  }): Promise<ConversationReviewDeliveryClaim>;
  markConversationReviewDelivered(
    date: string,
    providerMessageId: string | null,
    now: Date
  ): Promise<void>;
  markConversationReviewFailed(
    date: string,
    error: string,
    now: Date
  ): Promise<void>;
}

type DeliveryState = "sending" | "delivered" | "failed";

export class MemoryCaptainConversationReviewStore
implements CaptainConversationReviewStore {
  readonly #threads: ConversationReviewThread[];
  readonly #deliveries = new Map<string, {
    status: DeliveryState;
    claimedAt: Date;
  }>();

  constructor(threads: ConversationReviewThread[] = []) {
    this.#threads = structuredClone(threads);
  }

  async loadConversationReviewThreads(
    since: Date,
    until: Date
  ): Promise<ConversationReviewThread[]> {
    return structuredClone(this.#threads.flatMap((thread) => {
      const messages = thread.messages.filter((message) => {
        const at = Date.parse(message.createdAt);
        return at >= since.getTime() && at < until.getTime();
      });
      if (messages.length === 0) return [];
      return [{
        ...thread,
        messageCount: messages.length,
        travellerMessageCount: messages.filter((message) => message.role === "user").length,
        captainMessageCount: messages.filter((message) => message.role === "assistant").length
      }];
    }));
  }

  async claimConversationReviewDelivery(input: {
    date: string;
    since: Date;
    until: Date;
    recipients: string[];
    now: Date;
  }): Promise<ConversationReviewDeliveryClaim> {
    const current = this.#deliveries.get(input.date);
    const stale = current?.status === "sending"
      && current.claimedAt.getTime() < input.now.getTime() - 30 * 60_000;
    if (current?.status === "delivered" || (current?.status === "sending" && !stale)) {
      return "duplicate";
    }
    this.#deliveries.set(input.date, { status: "sending", claimedAt: input.now });
    return "new";
  }

  async markConversationReviewDelivered(
    date: string,
    _providerMessageId: string | null,
    now: Date
  ): Promise<void> {
    this.#deliveries.set(date, { status: "delivered", claimedAt: now });
  }

  async markConversationReviewFailed(
    date: string,
    _error: string,
    now: Date
  ): Promise<void> {
    this.#deliveries.set(date, { status: "failed", claimedAt: now });
  }
}

type ReviewRow = {
  conversation_id: string;
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  message_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date;
  in_window: boolean;
  message_count: string;
  traveller_message_count: string;
  captain_message_count: string;
  model_calls: string;
  cost_usd: string;
  unresolved_cost_count: string;
};

export class PostgresCaptainConversationReviewStore
implements CaptainConversationReviewStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  static connect(connectionString: string, max = 1): PostgresCaptainConversationReviewStore {
    return new PostgresCaptainConversationReviewStore(postgres(connectionString, {
      max,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false
    }));
  }

  async loadConversationReviewThreads(
    since: Date,
    until: Date
  ): Promise<ConversationReviewThread[]> {
    const rows = await this.#sql<ReviewRow[]>`
      with active_conversations as (
        select
          conversation.id as conversation_id,
          conversation.user_id,
          account.username,
          account.first_name,
          account.last_name,
          min(window_message.created_at) as first_window_message_at,
          count(*)::text as message_count,
          count(*) filter (where window_message.role = 'user')::text
            as traveller_message_count,
          count(*) filter (where window_message.role = 'assistant')::text
            as captain_message_count
        from captain.conversations conversation
        join captain.messages window_message
          on window_message.conversation_id = conversation.id
          and window_message.created_at >= ${since}
          and window_message.created_at < ${until}
        left join captain.telegram_accounts account
          on account.user_id = conversation.user_id
        group by conversation.id, conversation.user_id,
          account.username, account.first_name, account.last_name
        order by first_window_message_at asc, conversation.id asc
        limit 50
      )
      select
        active.conversation_id,
        active.user_id,
        active.username,
        active.first_name,
        active.last_name,
        message.id as message_id,
        message.role,
        message.content,
        message.created_at,
        message.in_window,
        active.message_count,
        active.traveller_message_count,
        active.captain_message_count,
        coalesce(usage_stats.model_calls, 0)::text as model_calls,
        coalesce(usage_stats.cost_usd, 0)::text as cost_usd,
        coalesce(usage_stats.unresolved_cost_count, 0)::text as unresolved_cost_count
      from active_conversations active
      left join lateral (
        select
          count(*) as model_calls,
          coalesce(sum(usage.cost_usd) filter (
            where usage.lookup_status = 'complete'
          ), 0) as cost_usd,
          count(*) filter (where usage.lookup_status <> 'complete')
            as unresolved_cost_count
        from captain.model_usage_events usage
        where usage.user_id = active.user_id
          and usage.occurred_at >= ${since}
          and usage.occurred_at < ${until}
      ) usage_stats on true
      cross join lateral (
        (
          select
            context_message.id,
            context_message.role,
            context_message.content,
            context_message.created_at,
            false as in_window
          from captain.messages context_message
          where context_message.conversation_id = active.conversation_id
            and context_message.created_at < ${since}
          order by context_message.created_at desc, context_message.id desc
          limit 8
        )
        union all
        (
          select
            window_message.id,
            window_message.role,
            window_message.content,
            window_message.created_at,
            true as in_window
          from captain.messages window_message
          where window_message.conversation_id = active.conversation_id
            and window_message.created_at >= ${since}
            and window_message.created_at < ${until}
          order by window_message.created_at asc, window_message.id asc
          limit 60
        )
      ) message
      order by active.first_window_message_at asc,
        active.conversation_id asc, message.created_at asc, message.id asc
    `;

    const threads = new Map<string, ConversationReviewThread>();
    for (const row of rows) {
      let thread = threads.get(row.conversation_id);
      if (!thread) {
        const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
        thread = {
          conversationId: row.conversation_id,
          userId: row.user_id,
          displayName: name || (row.username ? `@${row.username}` : row.user_id),
          username: row.username,
          messageCount: Number(row.message_count),
          travellerMessageCount: Number(row.traveller_message_count),
          captainMessageCount: Number(row.captain_message_count),
          modelCalls: Number(row.model_calls),
          costUsd: finiteNumber(row.cost_usd),
          unresolvedCostCount: Number(row.unresolved_cost_count),
          messages: []
        };
        threads.set(row.conversation_id, thread);
      }
      thread.messages.push({
        id: row.message_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at.toISOString(),
        inWindow: row.in_window
      });
    }
    return [...threads.values()];
  }

  async claimConversationReviewDelivery(input: {
    date: string;
    since: Date;
    until: Date;
    recipients: string[];
    now: Date;
  }): Promise<ConversationReviewDeliveryClaim> {
    const rows = await this.#sql<Array<{ review_date: string }>>`
      insert into captain.conversation_review_deliveries (
        review_date, window_started_at, window_ended_at, recipients,
        status, claimed_at, created_at, updated_at
      ) values (
        ${input.date}::date,
        ${input.since},
        ${input.until},
        ${this.#sql.json(input.recipients as never)},
        'sending',
        ${input.now},
        ${input.now},
        ${input.now}
      )
      on conflict (review_date) do update set
        window_started_at = excluded.window_started_at,
        window_ended_at = excluded.window_ended_at,
        recipients = excluded.recipients,
        status = 'sending',
        claimed_at = excluded.claimed_at,
        last_error = null,
        updated_at = excluded.updated_at
      where captain.conversation_review_deliveries.status = 'failed'
        or (
          captain.conversation_review_deliveries.status = 'sending'
          and captain.conversation_review_deliveries.claimed_at
            < ${new Date(input.now.getTime() - 30 * 60_000)}
        )
      returning review_date::text
    `;
    return rows.length > 0 ? "new" : "duplicate";
  }

  async markConversationReviewDelivered(
    date: string,
    providerMessageId: string | null,
    now: Date
  ): Promise<void> {
    await this.#sql`
      update captain.conversation_review_deliveries set
        status = 'delivered',
        provider_message_id = ${providerMessageId},
        delivered_at = ${now},
        last_error = null,
        updated_at = ${now}
      where review_date = ${date}::date
    `;
  }

  async markConversationReviewFailed(
    date: string,
    error: string,
    now: Date
  ): Promise<void> {
    await this.#sql`
      update captain.conversation_review_deliveries set
        status = 'failed',
        last_error = ${error.slice(0, 500)},
        updated_at = ${now}
      where review_date = ${date}::date
    `;
  }
}

function finiteNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
