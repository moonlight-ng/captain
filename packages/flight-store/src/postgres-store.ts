import { randomUUID } from "node:crypto";

import {
  MAX_ACTIVE_TRIPS_PER_USER,
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  type CreateTripInput,
  type OfferSnapshot,
  type SearchSpec,
  type Trip,
  type TripAction,
  type TripStatus,
  type UpdateTripInput,
  type Watch
} from "@agents/flight-domain";
import postgres, { type Sql } from "postgres";

import type {
  CaptainNotification,
  CaptainPlatformStore,
  CaptainUser,
  ClaimedSearchRun,
  CompletedProviderOffer,
  ConversationContext,
  TelegramUserInput,
  TripRecommendation
} from "./contracts.js";
import { offerScore, recommendationSummary } from "./ranking.js";

export class PostgresCaptainPlatformStore implements CaptainPlatformStore {
  readonly #sql: Sql;

  private constructor(sql: Sql) {
    this.#sql = sql;
  }

  static connect(databaseUrl: string, max = 8): PostgresCaptainPlatformStore {
    return new PostgresCaptainPlatformStore(postgres(databaseUrl, {
      max,
      idle_timeout: 20,
      connect_timeout: 15,
      transform: { undefined: null }
    }));
  }

  async ensureTelegramUser(input: TelegramUserInput, autoAllowlist: boolean, now: Date): Promise<CaptainUser> {
    return this.#sql.begin(async (tx) => {
      const existing = await tx<Array<UserRow & TelegramRow>>`
        select users.id, users.status, users.timezone,
          telegram.telegram_user_id, telegram.chat_id, telegram.username,
          telegram.first_name, telegram.last_name
        from captain.telegram_accounts telegram
        join captain.users users on users.id = telegram.user_id
        where telegram.telegram_user_id = ${input.telegramUserId}
        for update
      `;
      if (existing[0]) {
        const status = autoAllowlist && existing[0].status !== "suspended" ? "active" : existing[0].status;
        if (status !== existing[0].status) {
          await tx`update captain.users set status = ${status}, updated_at = ${now} where id = ${existing[0].id}`;
        }
        await tx`
          update captain.telegram_accounts set
            chat_id = ${input.telegramChatId}, username = ${input.username},
            first_name = ${input.firstName}, last_name = ${input.lastName},
            last_seen_at = ${now}
          where telegram_user_id = ${input.telegramUserId}
        `;
        return toUser({ ...existing[0], status, chat_id: input.telegramChatId, username: input.username, first_name: input.firstName, last_name: input.lastName });
      }
      const userId = randomUUID();
      const conversationId = randomUUID();
      const status = autoAllowlist ? "active" : "pending";
      await tx`
        insert into captain.users (id, status, timezone, created_at, updated_at)
        values (${userId}, ${status}, 'UTC', ${now}, ${now})
      `;
      await tx`
        insert into captain.telegram_accounts (
          telegram_user_id, user_id, chat_id, username, first_name, last_name,
          first_seen_at, last_seen_at
        ) values (
          ${input.telegramUserId}, ${userId}, ${input.telegramChatId}, ${input.username},
          ${input.firstName}, ${input.lastName}, ${now}, ${now}
        )
      `;
      await tx`
        insert into captain.conversations (id, user_id, summary, created_at, updated_at)
        values (${conversationId}, ${userId}, '', ${now}, ${now})
      `;
      return {
        id: userId, status, timezone: "UTC",
        telegramUserId: input.telegramUserId, telegramChatId: input.telegramChatId,
        displayName: displayName(input)
      };
    });
  }

  async getUser(userId: string): Promise<CaptainUser | null> {
    const rows = await this.#sql<Array<UserRow & TelegramRow>>`
      select users.id, users.status, users.timezone,
        telegram.telegram_user_id, telegram.chat_id, telegram.username,
        telegram.first_name, telegram.last_name
      from captain.users users
      join captain.telegram_accounts telegram on telegram.user_id = users.id
      where users.id = ${userId}
    `;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async claimTelegramUpdate(updateKey: string, userId: string, now: Date): Promise<boolean> {
    const rows = await this.#sql<Array<{ update_key: string }>>`
      insert into captain.telegram_updates (update_key, user_id, processed_at)
      values (${updateKey}, ${userId}, ${now})
      on conflict (update_key) do nothing
      returning update_key
    `;
    return rows.length === 1;
  }

  async getConversation(userId: string, limit = 20): Promise<ConversationContext> {
    const conversations = await this.#sql<Array<{ id: string; summary: string; active_trip_id: string | null }>>`
      select id, summary, active_trip_id from captain.conversations where user_id = ${userId}
    `;
    const conversation = conversations[0];
    if (!conversation) throw new Error("Conversation not found");
    const messages = await this.#sql<Array<{ id: string; role: "user" | "assistant"; content: string; created_at: Date }>>`
      select id, role, content, created_at
      from captain.messages where conversation_id = ${conversation.id}
      order by created_at desc limit ${limit}
    `;
    return {
      conversationId: conversation.id,
      summary: conversation.summary,
      activeTripId: conversation.active_trip_id,
      recentMessages: messages.reverse().map((message) => ({
        id: message.id, role: message.role, content: message.content, createdAt: iso(message.created_at)
      }))
    };
  }

  async appendMessage(userId: string, role: "user" | "assistant", content: string, now: Date): Promise<string> {
    const id = randomUUID();
    const rows = await this.#sql<Array<{ id: string }>>`
      insert into captain.messages (id, conversation_id, user_id, role, content, created_at)
      select ${id}, conversation.id, ${userId}, ${role}, ${content.trim()}, ${now}
      from captain.conversations conversation where conversation.user_id = ${userId}
      returning id
    `;
    if (!rows[0]) throw new Error("Conversation not found");
    return id;
  }

  async setActiveTrip(userId: string, tripId: string | null, now: Date): Promise<void> {
    if (tripId) {
      const trip = await this.getTrip(userId, tripId);
      if (!trip) throw new TripNotFoundError();
    }
    await this.#sql`
      update captain.conversations set active_trip_id = ${tripId}, updated_at = ${now}
      where user_id = ${userId}
    `;
  }

  async listTrips(userId: string): Promise<Trip[]> {
    const rows = await this.#sql<TripRow[]>`
      select * from captain.trips where user_id = ${userId} order by updated_at desc
    `;
    return rows.map(toTrip);
  }

  async getTrip(userId: string, tripId: string): Promise<Trip | null> {
    const rows = await this.#sql<TripRow[]>`
      select * from captain.trips where id = ${tripId} and user_id = ${userId}
    `;
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async getWatch(userId: string, tripId: string): Promise<Watch | null> {
    const rows = await this.#sql<WatchRow[]>`
      select watch.* from captain.watches watch
      join captain.trips trip on trip.id = watch.trip_id
      where trip.id = ${tripId} and trip.user_id = ${userId}
    `;
    return rows[0] ? toWatch(rows[0]) : null;
  }

  async getTripByLegacyKey(userId: string, legacyAgentKey: string): Promise<Trip | null> {
    const rows = await this.#sql<TripRow[]>`
      select * from captain.trips where legacy_agent_key = ${legacyAgentKey} and user_id = ${userId}
    `;
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<{ trip: Trip; watch: Watch }> {
    const created: { trip: Trip; watch: Watch } = await this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      const counts = await tx<Array<{ count: string }>>`
        select count(*)::text as count from captain.trips
        where user_id = ${userId} and status not in ('cancelled', 'completed')
      `;
      const duplicates = await tx<TripRow[]>`
        select * from captain.trips
        where user_id = ${userId} and status not in ('cancelled', 'completed')
          and brief = ${tx.json(json(input.brief))}
        order by updated_at desc limit 1
        for update
      `;
      if (duplicates[0]) {
        const watches = await tx<WatchRow[]>`select * from captain.watches where trip_id = ${duplicates[0].id}`;
        if (!watches[0]) throw new Error("Trip Watch not found");
        await tx`update captain.conversations set active_trip_id = ${duplicates[0].id}, updated_at = ${now} where user_id = ${userId}`;
        return { trip: toTrip(duplicates[0]), watch: toWatch(watches[0]) };
      }
      if (Number(counts[0]?.count ?? 0) >= MAX_ACTIVE_TRIPS_PER_USER) throw new TripLimitError();
      const tripId = randomUUID();
      const watchId = randomUUID();
      await tx`
        insert into captain.trips (
          id, user_id, title, status, version, brief, created_at, updated_at
        ) values (
          ${tripId}, ${userId}, ${input.title}, 'tracking', 1,
          ${tx.json(json(input.brief))}, ${now}, ${now}
        )
      `;
      await tx`
        insert into captain.watches (
          id, trip_id, status, cadence_hours, next_check_at, created_at, updated_at
        ) values (${watchId}, ${tripId}, 'active', ${input.cadenceHours}, ${now}, ${now}, ${now})
      `;
      await syncSpecs(tx, watchId, specs, now);
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (${randomUUID()}, ${tripId}, ${userId}, 'trip_created', ${tx.json(json(input))}, ${now})
      `;
      await tx`
        update captain.conversations set active_trip_id = ${tripId}, updated_at = ${now}
        where user_id = ${userId}
      `;
      return {
        trip: { id: tripId, userId, legacyAgentKey: null, title: input.title, status: "tracking", version: 1, brief: input.brief, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        watch: { id: watchId, tripId, status: "active", cadenceHours: input.cadenceHours, nextCheckAt: now.toISOString(), lastCheckAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }
      };
    });
    for (const specId of new Set(specs.map((spec) => spec.id))) {
      await this.evaluateTripsForSearchSpec(specId, now);
    }
    return { ...created, trip: await this.getTrip(userId, created.trip.id) ?? created.trip };
  }

  async updateTrip(userId: string, tripId: string, input: UpdateTripInput, specs: SearchSpec[] | null, now: Date): Promise<Trip> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<TripRow[]>`select * from captain.trips where id = ${tripId} and user_id = ${userId} for update`;
      const current = rows[0];
      if (!current) throw new TripNotFoundError();
      if (current.version !== input.expectedVersion) throw new TripVersionConflictError(current.version);
      const title = input.title ?? current.title;
      const brief = input.brief ?? current.brief;
      const status = input.brief ? "tracking" : current.status;
      const updated = await tx<TripRow[]>`
        update captain.trips set title = ${title}, brief = ${tx.json(json(brief))},
          status = ${status}, version = version + 1, updated_at = ${now}
        where id = ${tripId} returning *
      `;
      if (specs) {
        const watches = await tx<Array<{ id: string }>>`select id from captain.watches where trip_id = ${tripId}`;
        if (watches[0]) {
          await syncSpecs(tx, watches[0].id, specs, now);
          await tx`update captain.watches set status = 'active', next_check_at = ${now}, updated_at = ${now} where id = ${watches[0].id}`;
        }
      }
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (${randomUUID()}, ${tripId}, ${userId}, 'trip_updated', ${tx.json(json(input))}, ${now})
      `;
      return toTrip(updated[0]!);
    });
  }

  async applyTripAction(userId: string, tripId: string, action: TripAction, now: Date): Promise<Trip> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<TripRow[]>`select * from captain.trips where id = ${tripId} and user_id = ${userId} for update`;
      const current = rows[0];
      if (!current) throw new TripNotFoundError();
      if (current.version !== action.expectedVersion) throw new TripVersionConflictError(current.version);
      const status = actionStatus(action.type, current.status);
      const updated = await tx<TripRow[]>`
        update captain.trips set status = ${status}, version = version + 1, updated_at = ${now}
        where id = ${tripId} returning *
      `;
      const watchStatus = status === "paused" ? "paused" : ["cancelled", "completed"].includes(status) ? "completed" : "active";
      await tx`
        update captain.watches set status = ${watchStatus},
          next_check_at = case when ${action.type} in ('refresh', 'resume') then ${now} else next_check_at end,
          updated_at = ${now}
        where trip_id = ${tripId}
      `;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (${randomUUID()}, ${tripId}, ${userId}, ${`trip_${action.type}`}, ${tx.json(json(action))}, ${now})
      `;
      return toTrip(updated[0]!);
    });
  }

  async listTripOffers(userId: string, tripId: string, now: Date): Promise<OfferSnapshot[]> {
    const rows = await this.#sql<OfferRow[]>`
      select distinct on (offer.itinerary_key)
        offer.*
      from captain.offers offer
      join captain.watch_search_specs link on link.search_spec_id = offer.search_spec_id
      join captain.watches watch on watch.id = link.watch_id
      join captain.trips trip on trip.id = watch.trip_id
      where trip.id = ${tripId} and trip.user_id = ${userId}
        and (offer.expires_at is null or offer.expires_at > ${now})
      order by offer.itinerary_key, offer.observed_at desc, offer.price asc
    `;
    return rows.map(toOffer).sort((left, right) => left.price - right.price);
  }

  async scheduleDueSearchRuns(now: Date, freshnessMs: number, limit: number): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const watches = await tx<Array<{ id: string; cadence_hours: number }>>`
        select id, cadence_hours from captain.watches
        where status = 'active' and next_check_at <= ${now}
        order by next_check_at asc limit ${limit}
        for update skip locked
      `;
      let scheduled = 0;
      const claimedSpecs = new Set<string>();
      for (const watch of watches) {
        const specs = await tx<Array<{ search_spec_id: string }>>`
          select search_spec_id from captain.watch_search_specs where watch_id = ${watch.id}
        `;
        for (const spec of specs) {
          if (claimedSpecs.has(spec.search_spec_id)) continue;
          const rows = await tx<Array<{ should_schedule: boolean }>>`
            select
              not exists (
                select 1 from captain.search_runs
                where search_spec_id = ${spec.search_spec_id} and status in ('queued', 'running')
              ) and not exists (
                select 1 from captain.search_runs
                where search_spec_id = ${spec.search_spec_id} and status = 'completed'
                  and completed_at >= ${new Date(now.getTime() - freshnessMs)}
              ) as should_schedule
          `;
          if (!rows[0]?.should_schedule) continue;
          await tx`
            insert into captain.search_runs (
              id, search_spec_id, status, attempt, scheduled_at, created_at
            ) values (${randomUUID()}, ${spec.search_spec_id}, 'queued', 0, ${now}, ${now})
            on conflict do nothing
          `;
          claimedSpecs.add(spec.search_spec_id);
          scheduled += 1;
        }
        await tx`
          update captain.watches set next_check_at = ${new Date(now.getTime() + watch.cadence_hours * 3_600_000)}, updated_at = ${now}
          where id = ${watch.id}
        `;
      }
      return scheduled;
    });
  }

  async claimSearchRuns(workerId: string, now: Date, leaseMs: number, limit: number): Promise<ClaimedSearchRun[]> {
    type ClaimRow = {
      id: string; search_spec_id: string; request: ClaimedSearchRun["request"];
      attempt: number; lease_expires_at: Date;
    };
    const rows: ClaimRow[] = await this.#sql.begin(async (tx): Promise<ClaimRow[]> => {
      await tx`select pg_advisory_xact_lock(hashtext('captain-search-global-capacity'))`;
      const active = await tx<Array<{ count: string }>>`
        select count(*)::text as count from captain.search_runs
        where status = 'running' and lease_expires_at > ${now}
      `;
      const available = Math.max(0, 4 - Number(active[0]?.count ?? 0));
      const claimLimit = Math.min(limit, available);
      if (claimLimit === 0) return [];
      return tx<ClaimRow[]>`
        with candidates as (
          select id from captain.search_runs
          where scheduled_at <= ${now} and attempt < 3
            and (status = 'queued' or (status = 'running' and lease_expires_at <= ${now}))
          order by scheduled_at asc limit ${claimLimit}
          for update skip locked
        ), claimed as (
          update captain.search_runs run set
            status = 'running', claimed_by = ${workerId}, attempt = run.attempt + 1,
            lease_expires_at = ${new Date(now.getTime() + leaseMs)},
            started_at = coalesce(run.started_at, ${now}), error = null
          from candidates where run.id = candidates.id
          returning run.*
        )
        select claimed.id, claimed.search_spec_id, spec.request,
          claimed.attempt, claimed.lease_expires_at
        from claimed join captain.search_specs spec on spec.id = claimed.search_spec_id
      `;
    });
    return rows.map((row) => ({
      id: row.id, searchSpecId: row.search_spec_id, request: row.request,
      attempt: row.attempt, leaseExpiresAt: iso(row.lease_expires_at)
    }));
  }

  async completeSearchRun(workerId: string, runId: string, providerRequestId: string, offers: CompletedProviderOffer[], now: Date): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const runs = await tx<Array<{ search_spec_id: string }>>`
        update captain.search_runs set status = 'completed', completed_at = ${now},
          provider_request_id = ${providerRequestId}, lease_expires_at = null, error = null
        where id = ${runId} and status = 'running' and claimed_by = ${workerId}
        returning search_spec_id
      `;
      const run = runs[0];
      if (!run) throw new Error("Search run lease is not owned by this worker");
      for (const offer of offers) {
        const offerId = randomUUID();
        const segments = Array.isArray(offer.snapshot.segments) ? offer.snapshot.segments : [];
        await tx`
          insert into captain.itineraries (itinerary_key, segments, created_at, updated_at)
          values (${offer.itineraryKey}, ${tx.json(json(segments))}, ${now}, ${now})
          on conflict (itinerary_key) do update set segments = excluded.segments, updated_at = excluded.updated_at
        `;
        await tx`
          insert into captain.offers (
            id, search_run_id, search_spec_id, itinerary_key, provider,
            provider_offer_id, provider_search_id, price, currency, expires_at,
            observed_at, snapshot
          ) values (
            ${offerId}, ${runId}, ${run.search_spec_id}, ${offer.itineraryKey}, ${offer.provider},
            ${offer.providerOfferId}, ${offer.providerSearchId}, ${offer.price}, ${offer.currency},
            ${offer.expiresAt}, ${offer.observedAt}, ${tx.json(json(offer.snapshot))}
          ) on conflict (search_run_id, provider_offer_id) do nothing
        `;
        await tx`
          insert into captain.price_observations (
            id, search_run_id, search_spec_id, itinerary_key, provider,
            provider_offer_id, price, currency, observed_at, snapshot
          ) values (
            ${randomUUID()}, ${runId}, ${run.search_spec_id}, ${offer.itineraryKey}, ${offer.provider},
            ${offer.providerOfferId}, ${offer.price}, ${offer.currency}, ${offer.observedAt},
            ${tx.json(json(offer.snapshot))}
          )
        `;
      }
      await tx`
        update captain.watches watch set last_check_at = ${now}, updated_at = ${now}
        from captain.watch_search_specs link
        where link.watch_id = watch.id and link.search_spec_id = ${run.search_spec_id}
      `;
    });
  }

  async failSearchRun(workerId: string, runId: string, error: string, retryAfterMs: number | null, now: Date): Promise<void> {
    const terminal = await this.#sql.begin(async (tx) => {
      const rows = await tx<Array<{ attempt: number; search_spec_id: string }>>`
        select attempt, search_spec_id from captain.search_runs
        where id = ${runId} and status = 'running' and claimed_by = ${workerId}
        for update
      `;
      const run = rows[0];
      if (!run) throw new Error("Search run lease is not owned by this worker");
      const retry = run.attempt < 3;
      const delay = retryAfterMs ?? [300_000, 900_000, 3_600_000][Math.max(0, run.attempt - 1)]!;
      await tx`
        update captain.search_runs set
          status = ${retry ? "queued" : "failed"}, claimed_by = null, lease_expires_at = null,
          scheduled_at = ${retry ? new Date(now.getTime() + delay) : now},
          completed_at = ${retry ? null : now}, error = ${error}
        where id = ${runId}
      `;
      return retry ? null : run.search_spec_id;
    });
    if (terminal) await this.#enqueueAttentionForSpec(terminal, error, now);
  }

  async evaluateTripsForSearchSpec(searchSpecId: string, now: Date): Promise<number> {
    const rows = await this.#sql<TripRow[]>`
      select distinct trip.* from captain.trips trip
      join captain.watches watch on watch.trip_id = trip.id
      join captain.watch_search_specs link on link.watch_id = watch.id
      where link.search_spec_id = ${searchSpecId}
        and trip.status not in ('paused', 'cancelled', 'completed')
    `;
    let changed = 0;
    for (const row of rows) {
      const trip = toTrip(row);
      const offers = await this.listTripOffers(trip.userId, trip.id, now);
      const ranked = offers.map((offer) => ({ offer, score: offerScore(trip.brief, offer) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((left, right) => left.score - right.score || left.offer.price - right.offer.price);
      const best = ranked[0];
      if (!best) continue;
      const previousRows = await this.#sql<RecommendationRow[]>`
        select * from captain.trip_recommendations where trip_id = ${trip.id}
      `;
      const previous = previousRows[0] ? toRecommendation(previousRows[0]) : null;
      const recommendation: TripRecommendation = {
        tripId: trip.id, offerId: best.offer.id, itineraryKey: best.offer.itineraryKey,
        score: best.score, price: best.offer.price, currency: best.offer.currency,
        summary: recommendationSummary(best.offer), observedAt: best.offer.observedAt
      };
      const kind = !previous
        ? "initial_results"
        : best.offer.price <= previous.price * 0.95
          ? "price_drop"
          : previous.itineraryKey !== best.offer.itineraryKey && best.score < previous.score
            ? "new_best"
            : null;
      await this.#sql.begin(async (tx) => {
        await tx`
          insert into captain.trip_recommendations (
            trip_id, offer_id, itinerary_key, score, price, currency, summary, observed_at, updated_at
          ) values (
            ${trip.id}, ${best.offer.id}, ${best.offer.itineraryKey}, ${best.score},
            ${best.offer.price}, ${best.offer.currency}, ${recommendation.summary}, ${best.offer.observedAt}, ${now}
          ) on conflict (trip_id) do update set
            offer_id = excluded.offer_id, itinerary_key = excluded.itinerary_key,
            score = excluded.score, price = excluded.price, currency = excluded.currency,
            summary = excluded.summary, observed_at = excluded.observed_at, updated_at = excluded.updated_at
        `;
        if (kind) {
          const dedupKey = `${trip.id}:${kind}:${best.offer.itineraryKey}:${best.offer.price}`;
          const telegram = await tx<Array<{ exists: boolean }>>`
            select exists(select 1 from captain.telegram_accounts where user_id = ${trip.userId}) as exists
          `;
          if (telegram[0]?.exists) {
            const availableAt = await userDeliveryTime(tx, trip.userId, now);
            await tx`
              insert into captain.notifications (
                id, user_id, trip_id, kind, dedup_key, payload, status,
                attempts, available_at, created_at, updated_at
              ) values (
                ${randomUUID()}, ${trip.userId}, ${trip.id}, ${kind}, ${dedupKey},
                ${tx.json(json({
                  tripTitle: trip.title,
                  ...recommendation,
                  ...(previous ? {
                    previousPrice: previous.price,
                    dropPercent: previous.price > 0 ? Math.round((1 - recommendation.price / previous.price) * 100) : 0
                  } : {})
                }))},
                'pending', 0, ${availableAt}, ${now}, ${now}
              ) on conflict (dedup_key) do nothing
            `;
          }
        }
        if (trip.status === "tracking") {
          await tx`
            update captain.trips set status = 'recommended',
              version = version + 1, updated_at = ${now} where id = ${trip.id}
          `;
        }
      });
      if (kind) changed += 1;
    }
    return changed;
  }

  async listPendingNotifications(now: Date, limit: number): Promise<CaptainNotification[]> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<Array<NotificationRow & { chat_id: string }>>`
        with candidates as (
          select id from captain.notifications
          where status = 'pending' and available_at <= ${now}
          order by available_at asc limit ${limit}
          for update skip locked
        ), claimed as (
          update captain.notifications notification set
            status = 'sending', attempts = notification.attempts + 1, updated_at = ${now}
          from candidates where notification.id = candidates.id
          returning notification.*
        )
        select claimed.*, telegram.chat_id::text as chat_id
        from claimed join captain.telegram_accounts telegram on telegram.user_id = claimed.user_id
      `;
      return rows.map((row) => ({
        id: row.id, userId: row.user_id, tripId: row.trip_id,
        telegramChatId: Number(row.chat_id), kind: row.kind,
        payload: row.payload, attempts: row.attempts
      }));
    });
  }

  async markNotificationSent(notificationId: string, now: Date): Promise<void> {
    await this.#sql`
      update captain.notifications set status = 'sent', delivered_at = ${now}, error = null, updated_at = ${now}
      where id = ${notificationId} and status = 'sending'
    `;
  }

  async markNotificationFailed(notificationId: string, error: string, now: Date): Promise<void> {
    await this.#sql`
      update captain.notifications set
        status = case when attempts >= 3 then 'failed' else 'pending' end,
        available_at = ${new Date(now.getTime() + 300_000)}, error = ${error}, updated_at = ${now}
      where id = ${notificationId} and status = 'sending'
    `;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #enqueueAttentionForSpec(searchSpecId: string, error: string, now: Date): Promise<void> {
    const trips = await this.#sql<Array<{ id: string; user_id: string; title: string }>>`
      select distinct trip.id, trip.user_id, trip.title
      from captain.trips trip
      join captain.watches watch on watch.trip_id = trip.id
      join captain.watch_search_specs link on link.watch_id = watch.id
      join captain.telegram_accounts telegram on telegram.user_id = trip.user_id
      where link.search_spec_id = ${searchSpecId}
    `;
    for (const trip of trips) {
      const dedupKey = `${trip.id}:watch_attention:${now.toISOString().slice(0, 10)}`;
      const availableAt = await userDeliveryTime(this.#sql, trip.user_id, now);
      await this.#sql`
        insert into captain.notifications (
          id, user_id, trip_id, kind, dedup_key, payload, status,
          attempts, available_at, created_at, updated_at
        ) values (
          ${randomUUID()}, ${trip.user_id}, ${trip.id}, 'watch_attention', ${dedupKey},
          ${this.#sql.json(json({ tripTitle: trip.title, error }))}, 'pending', 0,
          ${availableAt}, ${now}, ${now}
        ) on conflict (dedup_key) do nothing
      `;
    }
  }
}

async function syncSpecs(sql: Sql, watchId: string, specs: SearchSpec[], now: Date): Promise<void> {
  for (const spec of specs) {
    await sql`
      insert into captain.search_specs (id, spec_key, provider, request, created_at, updated_at)
      values (${spec.id}, ${spec.key}, ${spec.request.provider}, ${sql.json(json(spec.request))}, ${now}, ${now})
      on conflict (id) do update set request = excluded.request, updated_at = excluded.updated_at
    `;
  }
  await sql`delete from captain.watch_search_specs where watch_id = ${watchId}`;
  for (const spec of specs) {
    await sql`
      insert into captain.watch_search_specs (watch_id, search_spec_id, created_at)
      values (${watchId}, ${spec.id}, ${now}) on conflict do nothing
    `;
  }
}

async function userDeliveryTime(sql: Sql, userId: string, now: Date): Promise<Date> {
  const rows = await sql<Array<{ timezone: string }>>`select timezone from captain.users where id = ${userId}`;
  const timezone = rows[0]?.timezone ?? "UTC";
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
    if (hour >= 22) return new Date(now.getTime() + (31 - hour) * 3_600_000);
    if (hour < 7) return new Date(now.getTime() + (7 - hour) * 3_600_000);
  } catch {
    // Invalid timezones fall back to immediate delivery.
  }
  return now;
}

function actionStatus(action: TripAction["type"], current: TripStatus): TripStatus {
  if (action === "pause") return "paused";
  if (action === "resume" || action === "refresh") return "tracking";
  if (action === "cancel") return "cancelled";
  if (action === "complete") return "completed";
  return current;
}

type UserRow = { id: string; status: CaptainUser["status"]; timezone: string };
type TelegramRow = { telegram_user_id: string | number; chat_id: string | number; username: string | null; first_name: string | null; last_name: string | null };
type TripRow = {
  id: string; user_id: string; legacy_agent_key: string | null; title: string; status: TripStatus;
  version: number; brief: Trip["brief"]; created_at: Date; updated_at: Date;
};
type OfferRow = {
  id: string; search_run_id: string; search_spec_id: string; itinerary_key: string;
  provider: "duffel"; provider_offer_id: string; provider_search_id: string;
  price: string | number; currency: string; expires_at: Date | null; observed_at: Date;
  snapshot: Record<string, unknown>;
};
type WatchRow = {
  id: string; trip_id: string; status: Watch["status"]; cadence_hours: number;
  next_check_at: Date | null; last_check_at: Date | null; created_at: Date; updated_at: Date;
};
type RecommendationRow = {
  trip_id: string; offer_id: string; itinerary_key: string; score: string | number;
  price: string | number; currency: string; summary: string; observed_at: Date;
};
type NotificationRow = {
  id: string; user_id: string; trip_id: string; kind: CaptainNotification["kind"];
  payload: Record<string, unknown>; attempts: number;
};

function toUser(row: UserRow & TelegramRow): CaptainUser {
  return {
    id: row.id, status: row.status, timezone: row.timezone,
    telegramUserId: Number(row.telegram_user_id), telegramChatId: Number(row.chat_id),
    displayName: displayName({
      telegramUserId: Number(row.telegram_user_id), telegramChatId: Number(row.chat_id),
      username: row.username, firstName: row.first_name, lastName: row.last_name
    })
  };
}

function toTrip(row: TripRow): Trip {
  return {
    id: row.id, userId: row.user_id, legacyAgentKey: row.legacy_agent_key,
    title: row.title, status: row.status, version: row.version, brief: row.brief,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function toOffer(row: OfferRow): OfferSnapshot {
  return {
    id: row.id, searchRunId: row.search_run_id, searchSpecId: row.search_spec_id,
    itineraryKey: row.itinerary_key, provider: row.provider,
    providerOfferId: row.provider_offer_id, providerSearchId: row.provider_search_id,
    price: Number(row.price), currency: row.currency, expiresAt: row.expires_at ? iso(row.expires_at) : null,
    observedAt: iso(row.observed_at), snapshot: row.snapshot
  };
}

function toWatch(row: WatchRow): Watch {
  return {
    id: row.id, tripId: row.trip_id, status: row.status, cadenceHours: row.cadence_hours,
    nextCheckAt: row.next_check_at ? iso(row.next_check_at) : null,
    lastCheckAt: row.last_check_at ? iso(row.last_check_at) : null,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function toRecommendation(row: RecommendationRow): TripRecommendation {
  return {
    tripId: row.trip_id, offerId: row.offer_id, itineraryKey: row.itinerary_key,
    score: Number(row.score), price: Number(row.price), currency: row.currency,
    summary: row.summary, observedAt: iso(row.observed_at)
  };
}

function displayName(input: TelegramUserInput): string {
  return input.firstName?.trim() || (input.username ? `@${input.username}` : `traveller ${input.telegramUserId}`);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json(value: unknown): Parameters<Sql["json"]>[0] {
  return value as Parameters<Sql["json"]>[0];
}
