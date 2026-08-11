import { randomUUID } from "node:crypto";

import {
  DEFAULT_PROFILE,
  checkpointNotificationKindForAction,
  cityLabelForAirportCodes,
  formatTripGoal,
  formatTripRoute,
  isCheckpointNotificationKind,
  isMaterialTripPlanChange,
  legSearchSnapshotSchema,
  MAX_MANUAL_SEARCH_DAYS,
  MAX_ACTIVE_TRIPS_PER_USER,
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  EMPTY_TRIP_DRAFT_STATE,
  tripPlanConfirmationSnapshotSchema,
  tripDraftStateSchema,
  type CaptainSessionPath,
  type CanonicalFlight,
  type CreateTripInput,
  type FlightOfferSnapshot,
  type FlightSearchProviderId,
  type LegSearchSnapshot,
  type LegSearchSnapshotRevision,
  type OfferSnapshot,
  type SearchSpec,
  type Trip,
  type TripAction,
  type TripBrief,
  type TripCity,
  type TripCityLeg,
  type TripCreationResult,
  type TripGraph,
  type TripPlanDraft,
  type TripPlanDraftRevision,
  type TripStatus,
  type TravellerProfile,
  type UpdateTravellerProfile,
  type UpdateTripBrief,
  type UpdateTripTitle,
  type Watch
} from "@agents/flight-domain";
import postgres, { type Sql } from "postgres";

import type {
  ApplyTripActionOptions,
  CaptainNotification,
  CaptainPlatformStore,
  CaptainUser,
  ClaimedOnboardingFollowup,
  ClaimedSearchRun,
  CompletedProviderOffer,
  ConversationContext,
  TravellerFact,
  TravellerFactInput,
  TravellerFactKind,
  TelegramUserInput,
  TrackingMaintenance,
  MultiCityLegSearchRecording,
  TripFlightSelection,
  TrackedFlightPrices,
  TripActivity,
  TripRecommendation
} from "./contracts.js";
import {
  BetaCapacityError,
  BetaLaunchGateError,
  ONBOARDING_FOLLOWUP_STAGES,
  type OnboardingEngagementReason,
  type OnboardingFollowupStage
} from "./contracts.js";
import { matchingMultiCityLegs, multiCityLegRevision } from "./multi-city-results.js";
import {
  tripLegFlightSelectionPayload,
  tripLegFlightSelectionSummary
} from "./leg-flight-selection.js";
import { notificationGoalPayload, offerDateSummary, offerRangeSummary } from "./notification-payload.js";
import {
  meetsAlertThreshold,
  rankOffers,
  recommendationReasonCodes,
  recommendationSummary
} from "./ranking.js";
import {
  CURRENT_OFFER_RETENTION_MS,
  DISCOVERY_SEARCH_SPEC_LIMIT,
  PRICE_HISTORY_RETENTION_MS,
  retainSearchOffers,
  TRACKING_SEARCH_SPEC_LIMIT,
  trackingRunEndsAt,
  TRACKING_CHECK_INTERVAL_MS
} from "./watch-policy.js";
import { signalFlightWorker } from "./worker-wake.js";

function truncateErrorDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.slice(0, 500);
}

export class PostgresCaptainPlatformStore implements CaptainPlatformStore {
  readonly #sql: Sql;

  private constructor(sql: Sql) {
    this.#sql = sql;
  }

  static connect(
    databaseUrl: string,
    max = 4,
    idleTimeoutSeconds = 600
  ): PostgresCaptainPlatformStore {
    return new PostgresCaptainPlatformStore(postgres(databaseUrl, {
      max,
      idle_timeout: idleTimeoutSeconds,
      connect_timeout: 15,
      transform: { undefined: null }
    }));
  }

  async ensureTelegramUser(input: TelegramUserInput, now: Date): Promise<CaptainUser> {
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
        await tx`
          update captain.telegram_accounts set
            chat_id = ${input.telegramChatId}, username = ${input.username},
            first_name = ${input.firstName}, last_name = ${input.lastName},
            last_seen_at = ${now}
          where telegram_user_id = ${input.telegramUserId}
        `;
        return toUser({ ...existing[0], chat_id: input.telegramChatId, username: input.username, first_name: input.firstName, last_name: input.lastName });
      }
      if (!publicBetaEnabled()) throw new BetaLaunchGateError();
      await tx`select pg_advisory_xact_lock(1906202601)`;
      const betaLimit = positiveInteger(process.env.CAPTAIN_BETA_USER_LIMIT, 25);
      const counts = await tx<Array<{ count: string }>>`
        select count(*)::text as count from captain.users
      `;
      if (Number(counts[0]?.count ?? 0) >= betaLimit) throw new BetaCapacityError(betaLimit);
      const userId = randomUUID();
      const conversationId = randomUUID();
      await tx`
        insert into captain.users (id, status, timezone, created_at, updated_at)
        values (${userId}, 'active', 'UTC', ${now}, ${now})
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
        id: userId, status: "active", timezone: "UTC",
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

  async updateUserTimezone(userId: string, timeZone: string, now: Date): Promise<CaptainUser> {
    await this.#sql`
      update captain.users set timezone = ${timeZone}, updated_at = ${now}
      where id = ${userId}
    `;
    const user = await this.getUser(userId);
    if (!user) throw new Error("User not found");
    return user;
  }

  async countUsers(): Promise<number> {
    const rows = await this.#sql<Array<{ count: string }>>`
      select count(*)::text as count from captain.users
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.#sql.begin(async (tx) => {
      // Audit rows use ON DELETE SET NULL for general retention. Account deletion
      // is stricter: remove any payload that was associated with this user.
      await tx`delete from captain.audit_events where user_id = ${userId}`;
      await tx`delete from captain.users where id = ${userId}`;
    });
  }

  async clearTravellerData(userId: string, now: Date): Promise<void> {
    await this.ensureProfile(userId, now);
    await this.#sql.begin(async (tx) => {
      await tx`
        update captain.traveller_profiles set
          default_currency = ${DEFAULT_PROFILE.defaultCurrency},
          ranking_mode = ${DEFAULT_PROFILE.rankingMode},
          preferred_airline_codes = ${tx.json([])},
          excluded_airline_codes = ${tx.json([])},
          alerts_enabled = ${DEFAULT_PROFILE.alertsEnabled},
          notification_mode = ${DEFAULT_PROFILE.notificationMode},
          price_rise_alerts_enabled = ${DEFAULT_PROFILE.priceRiseAlertsEnabled},
          better_option_alerts_enabled = ${DEFAULT_PROFILE.betterOptionAlertsEnabled},
          max_alerts_per_day = ${DEFAULT_PROFILE.maxAlertsPerDay},
          quiet_hours_enabled = ${DEFAULT_PROFILE.quietHoursEnabled},
          quiet_hours_start = ${DEFAULT_PROFILE.quietHoursStart},
          quiet_hours_end = ${DEFAULT_PROFILE.quietHoursEnd},
          onboarding_step = 'welcome',
          onboarding_completed_at = null,
          updated_at = ${now}
        where user_id = ${userId}
      `;
      // Trips cascade into watches, recommendations, flight selections, trip
      // events and notifications, and the conversation's active trip nulls
      // itself. Drafts are owned by the traveller rather than by a trip, so an
      // unfinished one has to be deleted on its own or it would come straight
      // back the next time they typed. Shared search data—specs, runs, offers,
      // price history—belongs to every traveller on the route, so it stays.
      await tx`delete from captain.trips where user_id = ${userId}`;
      await tx`delete from captain.trip_plan_drafts where user_id = ${userId}`;
      await tx`delete from captain.onboarding_followups where user_id = ${userId}`;
      await tx`delete from captain.messages where user_id = ${userId}`;
      await tx`delete from captain.traveller_facts where user_id = ${userId}`;
      await tx`
        update captain.conversations set
          summary = '',
          summary_updated_at = null,
          summary_through_message_id = null,
          active_trip_id = null,
          updated_at = ${now}
        where user_id = ${userId}
      `;
    });
  }

  async getProfile(userId: string): Promise<TravellerProfile | null> {
    const rows = await this.#sql<ProfileRow[]>`
      select * from captain.traveller_profiles where user_id = ${userId}
    `;
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async ensureProfile(userId: string, now: Date): Promise<TravellerProfile> {
    const rows = await this.#sql<ProfileRow[]>`
      insert into captain.traveller_profiles (
        user_id, default_currency, ranking_mode, preferred_airline_codes,
        excluded_airline_codes, alerts_enabled, max_alerts_per_day,
        notification_mode, price_rise_alerts_enabled,
        better_option_alerts_enabled,
        quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
        onboarding_step, onboarding_completed_at,
        created_at, updated_at
      )
      select ${userId}, ${DEFAULT_PROFILE.defaultCurrency}, ${DEFAULT_PROFILE.rankingMode},
        ${this.#sql.json([])}, ${this.#sql.json([])}, ${DEFAULT_PROFILE.alertsEnabled},
        ${DEFAULT_PROFILE.maxAlertsPerDay}, ${DEFAULT_PROFILE.notificationMode},
        ${DEFAULT_PROFILE.priceRiseAlertsEnabled},
        ${DEFAULT_PROFILE.betterOptionAlertsEnabled},
        ${DEFAULT_PROFILE.quietHoursEnabled},
        ${DEFAULT_PROFILE.quietHoursStart}, ${DEFAULT_PROFILE.quietHoursEnd},
        'welcome', null, ${now}, ${now}
      where exists (select 1 from captain.users where id = ${userId})
      on conflict (user_id) do update set user_id = excluded.user_id
      returning *
    `;
    if (!rows[0]) throw new Error("User not found");
    return toProfile(rows[0]);
  }

  async updateProfile(
    userId: string,
    input: UpdateTravellerProfile & {
      onboardingStep?: TravellerProfile["onboardingStep"];
      onboardingCompletedAt?: string | null;
    },
    now: Date
  ): Promise<TravellerProfile> {
    await this.ensureProfile(userId, now);
    const rows = await this.#sql<ProfileRow[]>`
      update captain.traveller_profiles set
        default_currency = coalesce(${input.defaultCurrency ?? null}, default_currency),
        ranking_mode = coalesce(${input.rankingMode ?? null}, ranking_mode),
        preferred_airline_codes = coalesce(
          ${input.preferredAirlineCodes ? this.#sql.json(input.preferredAirlineCodes) : null},
          preferred_airline_codes
        ),
        excluded_airline_codes = coalesce(
          ${input.excludedAirlineCodes ? this.#sql.json(input.excludedAirlineCodes) : null},
          excluded_airline_codes
        ),
        alerts_enabled = case
          when ${input.notificationMode !== undefined}
            then ${input.notificationMode !== "off"}
          else coalesce(${input.alertsEnabled ?? null}, alerts_enabled)
        end,
        notification_mode = case
          when ${input.notificationMode !== undefined}
            then ${input.notificationMode ?? null}
          when ${input.alertsEnabled ?? null} = false then 'off'
          when ${input.alertsEnabled ?? null} = true and notification_mode = 'off' then 'changes_only'
          else notification_mode
        end,
        price_rise_alerts_enabled = coalesce(
          ${input.priceRiseAlertsEnabled ?? null},
          price_rise_alerts_enabled
        ),
        better_option_alerts_enabled = coalesce(
          ${input.betterOptionAlertsEnabled ?? null},
          better_option_alerts_enabled
        ),
        max_alerts_per_day = coalesce(${input.maxAlertsPerDay ?? null}, max_alerts_per_day),
        quiet_hours_enabled = coalesce(${input.quietHoursEnabled ?? null}, quiet_hours_enabled),
        quiet_hours_start = coalesce(${input.quietHoursStart ?? null}, quiet_hours_start),
        quiet_hours_end = coalesce(${input.quietHoursEnd ?? null}, quiet_hours_end),
        onboarding_step = coalesce(${input.onboardingStep ?? null}, onboarding_step),
        onboarding_completed_at = case
          when ${input.onboardingCompletedAt !== undefined}
            then ${input.onboardingCompletedAt ? new Date(input.onboardingCompletedAt) : null}
          else onboarding_completed_at
        end,
        updated_at = ${now}
      where user_id = ${userId}
      returning *
    `;
    const updatedProfile = toProfile(rows[0]!);
    // Turning notifications off retires anything already queued for delivery.
    if (updatedProfile.notificationMode === "off") {
      await this.#sql`
        update captain.notifications set
          status = 'superseded',
          error = 'Notification preference changed before delivery',
          updated_at = ${now}
        where user_id = ${userId} and status = 'pending'
      `;
    }
    const specs = await this.#sql<Array<{ search_spec_id: string }>>`
      select distinct link.search_spec_id
      from captain.watch_search_specs link
      join captain.watches watch on watch.id = link.watch_id
      join captain.trips trip on trip.id = watch.trip_id
      where trip.user_id = ${userId}
        and trip.status not in ('cancelled', 'completed', 'archived')
    `;
    for (const spec of specs) await this.evaluateTripsForSearchSpec(spec.search_spec_id, now);
    return updatedProfile;
  }

  async createLoginToken(
    userId: string,
    tokenHash: string,
    redirectPath: CaptainSessionPath,
    expiresAt: Date,
    now: Date
  ): Promise<void> {
    await this.#sql`
      insert into captain.login_tokens (
        token_hash, user_id, redirect_path, expires_at, consumed_at, created_at
      ) values (${tokenHash}, ${userId}, ${redirectPath}, ${expiresAt}, null, ${now})
    `;
  }

  async consumeLoginToken(tokenHash: string, now: Date) {
    const rows = await this.#sql<Array<{ user_id: string; redirect_path: CaptainSessionPath }>>`
      update captain.login_tokens set consumed_at = ${now}
      where token_hash = ${tokenHash} and consumed_at is null and expires_at > ${now}
      returning user_id, redirect_path
    `;
    return rows[0] ? { userId: rows[0].user_id, redirectPath: rows[0].redirect_path } : null;
  }

  async createWebSession(userId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<void> {
    await this.#sql`
      insert into captain.web_sessions (
        token_hash, user_id, expires_at, revoked_at, created_at, last_seen_at
      ) values (${tokenHash}, ${userId}, ${expiresAt}, null, ${now}, ${now})
    `;
  }

  async resolveWebSession(tokenHash: string, now: Date): Promise<string | null> {
    const rows = await this.#sql<Array<{ user_id: string }>>`
      update captain.web_sessions set last_seen_at = ${now}
      where token_hash = ${tokenHash} and revoked_at is null and expires_at > ${now}
      returning user_id
    `;
    return rows[0]?.user_id ?? null;
  }

  async revokeWebSession(tokenHash: string, now: Date): Promise<void> {
    await this.#sql`
      update captain.web_sessions set revoked_at = ${now}
      where token_hash = ${tokenHash} and revoked_at is null
    `;
  }

  async revokeUserSessions(userId: string, now: Date): Promise<void> {
    await this.#sql`
      update captain.web_sessions set revoked_at = ${now}
      where user_id = ${userId} and revoked_at is null
    `;
  }

  async claimOnboardingWelcome(userId: string, now: Date): Promise<boolean> {
    await this.ensureProfile(userId, now);
    return this.#sql.begin(async (tx) => {
      const rows = await tx<Array<{ user_id: string }>>`
        update captain.traveller_profiles
        set onboarding_step = 'complete',
          onboarding_completed_at = ${now},
          updated_at = ${now}
        where user_id = ${userId}
          and onboarding_step = 'welcome'
          and onboarding_completed_at is null
        returning user_id
      `;
      if (rows.length !== 1) return false;
      for (const [index, followup] of ONBOARDING_FOLLOWUP_STAGES.entries()) {
        const baseDue = new Date(now.getTime() + followup.delayMs);
        const availableAt = await userDeliveryTime(tx, userId, baseDue);
        await tx`
          insert into captain.onboarding_followups (
            user_id, stage, position, sequence_started_at, available_at,
            status, attempts, created_at, updated_at
          ) values (
            ${userId}, ${followup.stage}, ${index + 1}, ${now}, ${availableAt},
            'pending', 0, ${now}, ${now}
          )
          on conflict (user_id, stage) do update set
            position = excluded.position,
            sequence_started_at = excluded.sequence_started_at,
            available_at = excluded.available_at,
            status = 'pending', attempts = 0, lease_expires_at = null,
            telegram_message_id = null, delivered_at = null,
            disabled_at = null, disabled_reason = null, error = null,
            updated_at = excluded.updated_at
        `;
      }
      return true;
    });
  }

  async disableOnboardingFollowups(
    userId: string,
    reason: OnboardingEngagementReason,
    now: Date
  ): Promise<void> {
    await this.#sql`
      update captain.onboarding_followups set
        status = 'cancelled', lease_expires_at = null,
        disabled_at = ${now}, disabled_reason = ${reason},
        error = null, updated_at = ${now}
      where user_id = ${userId} and status in ('pending', 'sending')
    `;
  }

  async claimDueOnboardingFollowups(
    now: Date,
    leaseMs: number,
    limit: number
  ): Promise<ClaimedOnboardingFollowup[]> {
    return this.#sql.begin(async (tx) => {
      await tx`
        update captain.onboarding_followups set
          status = case when attempts >= 3 then 'failed' else 'pending' end,
          lease_expires_at = null,
          updated_at = ${now}
        where status = 'sending' and lease_expires_at <= ${now}
      `;
      await cancelOnboardingFollowupsWithActivity(tx, null, now);
      const rows = await tx<Array<OnboardingFollowupRow & { chat_id: string }>>`
        with candidates as (
          select followup.user_id, followup.stage
          from captain.onboarding_followups followup
          where followup.status = 'pending'
            and followup.available_at <= ${now}
            and not exists (
              select 1
              from captain.onboarding_followups earlier
              where earlier.user_id = followup.user_id
                and earlier.position < followup.position
                and earlier.status in ('pending', 'sending')
            )
          order by followup.available_at asc, followup.position asc
          limit ${Math.max(0, limit)}
          for update of followup skip locked
        ), claimed as (
          update captain.onboarding_followups followup set
            status = 'sending', attempts = followup.attempts + 1,
            lease_expires_at = ${new Date(now.getTime() + leaseMs)},
            updated_at = ${now}
          from candidates
          where followup.user_id = candidates.user_id
            and followup.stage = candidates.stage
          returning followup.*
        )
        select claimed.*, telegram.chat_id::text as chat_id
        from claimed
        join captain.telegram_accounts telegram on telegram.user_id = claimed.user_id
      `;
      return rows.map((row) => ({
        userId: row.user_id,
        telegramChatId: Number(row.chat_id),
        stage: row.stage,
        attempts: row.attempts,
        availableAt: iso(row.available_at)
      }));
    });
  }

  async revalidateOnboardingFollowup(
    userId: string,
    stage: OnboardingFollowupStage,
    now: Date
  ): Promise<boolean> {
    return this.#sql.begin(async (tx) => {
      await cancelOnboardingFollowupsWithActivity(tx, userId, now);
      const rows = await tx<Array<{ eligible: boolean }>>`
        select exists(
          select 1 from captain.onboarding_followups
          where user_id = ${userId} and stage = ${stage} and status = 'sending'
        ) as eligible
      `;
      return rows[0]?.eligible === true;
    });
  }

  async markOnboardingFollowupSent(
    userId: string,
    stage: OnboardingFollowupStage,
    telegramMessageId: number,
    body: string,
    now: Date
  ): Promise<void> {
    const trimmed = body.trim();
    await this.#sql.begin(async (tx) => {
      const rows = await tx<Array<{ user_id: string }>>`
        update captain.onboarding_followups set
          status = 'sent', lease_expires_at = null,
          telegram_message_id = ${telegramMessageId}, delivered_at = ${now},
          error = null, updated_at = ${now}
        where user_id = ${userId} and stage = ${stage} and status = 'sending'
        returning user_id
      `;
      if (!rows[0] || !trimmed) return;
      await tx`
        insert into captain.messages (id, conversation_id, user_id, role, content, created_at)
        select ${randomUUID()}, conversation.id, ${userId}, 'assistant', ${trimmed}, ${now}
        from captain.conversations conversation where conversation.user_id = ${userId}
      `;
    });
  }

  async markOnboardingFollowupFailed(
    userId: string,
    stage: OnboardingFollowupStage,
    error: string,
    now: Date
  ): Promise<void> {
    await this.#sql`
      update captain.onboarding_followups set
        status = case when attempts >= 3 then 'failed' else 'pending' end,
        available_at = ${new Date(now.getTime() + 5 * 60_000)},
        lease_expires_at = null,
        error = ${truncateErrorDetail(error)}, updated_at = ${now}
      where user_id = ${userId} and stage = ${stage} and status = 'sending'
    `;
  }

  async reserveDailyResponseBudget(now: Date, amount: number, limit: number): Promise<boolean> {
    return this.#sql.begin(async (tx) => {
      const date = now.toISOString().slice(0, 10);
      await tx`
        insert into captain.api_usage_days (
          usage_date, response_count, web_search_call_count, updated_at
        ) values (${date}, 0, 0, ${now})
        on conflict (usage_date) do nothing
      `;
      const rows = await tx<Array<{ response_count: number }>>`
        select response_count from captain.api_usage_days
        where usage_date = ${date}
        for update
      `;
      if (Number(rows[0]?.response_count ?? 0) + amount > limit) return false;
      await tx`
        update captain.api_usage_days set
          response_count = response_count + ${amount}, updated_at = ${now}
        where usage_date = ${date}
      `;
      return true;
    });
  }

  async recordWebSearchCalls(now: Date, count: number): Promise<void> {
    const date = now.toISOString().slice(0, 10);
    await this.#sql`
      insert into captain.api_usage_days (
        usage_date, response_count, web_search_call_count, updated_at
      ) values (${date}, 0, ${Math.max(0, count)}, ${now})
      on conflict (usage_date) do update set
        web_search_call_count = captain.api_usage_days.web_search_call_count + excluded.web_search_call_count,
        updated_at = excluded.updated_at
    `;
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
    const conversations = await this.#sql<Array<{
      id: string;
      summary: string;
      summary_updated_at: Date | null;
      summary_through_message_id: string | null;
      active_trip_id: string | null;
    }>>`
      select id, summary, summary_updated_at, summary_through_message_id, active_trip_id
      from captain.conversations where user_id = ${userId}
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
      summaryUpdatedAt: conversation.summary_updated_at
        ? iso(conversation.summary_updated_at)
        : null,
      summaryThroughMessageId: conversation.summary_through_message_id,
      activeTripId: conversation.active_trip_id,
      recentMessages: messages.reverse().map((message) => ({
        id: message.id, role: message.role, content: message.content, createdAt: iso(message.created_at)
      }))
    };
  }

  async listTravellerFacts(userId: string): Promise<TravellerFact[]> {
    const rows = await this.#sql<TravellerFactRow[]>`
      select id, kind, value, evidence, source_message_id, status, created_at, updated_at
      from captain.traveller_facts
      where user_id = ${userId} and status = 'active'
      order by kind, created_at
    `;
    return rows.map(travellerFactFromRow);
  }

  async recordTravellerFacts(
    userId: string,
    facts: TravellerFactInput[],
    now: Date
  ): Promise<TravellerFact[]> {
    if (facts.length === 0) return [];
    const recorded: TravellerFact[] = [];
    for (const fact of facts) {
      // `where status = 'active'` on the update: a dismissed fact stays
      // dismissed. The traveller correcting Captain has to outrank Captain
      // hearing the same sentence again.
      const rows = await this.#sql<TravellerFactRow[]>`
        insert into captain.traveller_facts (
          id, user_id, kind, value, evidence, source_message_id, status, created_at, updated_at
        )
        values (
          ${randomUUID()}, ${userId}, ${fact.kind}, ${fact.value},
          ${fact.evidence}, ${fact.sourceMessageId}, 'active', ${now}, ${now}
        )
        on conflict (user_id, kind, value) do update
          set evidence = excluded.evidence,
              source_message_id = excluded.source_message_id,
              updated_at = ${now}
          where captain.traveller_facts.status = 'active'
        returning id, kind, value, evidence, source_message_id, status, created_at, updated_at
      `;
      const row = rows[0];
      if (row) recorded.push(travellerFactFromRow(row));
    }
    return recorded;
  }

  async dismissTravellerFact(userId: string, factId: string, now: Date): Promise<boolean> {
    const rows = await this.#sql<Array<{ id: string }>>`
      update captain.traveller_facts
      set status = 'dismissed', updated_at = ${now}
      where user_id = ${userId} and id = ${factId} and status = 'active'
      returning id
    `;
    return rows.length === 1;
  }

  async setConversationSummary(
    userId: string,
    summary: string,
    throughMessageId: string | null,
    now: Date
  ): Promise<void> {
    await this.#sql`
      update captain.conversations
      set summary = ${summary},
          summary_updated_at = ${now},
          summary_through_message_id = ${throughMessageId},
          updated_at = ${now}
      where user_id = ${userId}
    `;
  }

  async appendMessage(userId: string, role: "user" | "assistant", content: string, now: Date): Promise<string> {
    const id = randomUUID();
    const trimmed = content.trim();
    const rows = await this.#sql<Array<{ id: string }>>`
      insert into captain.messages (id, conversation_id, user_id, role, content, created_at)
      select ${id}, conversation.id, ${userId}, ${role}, ${trimmed}, ${now}
      from captain.conversations conversation where conversation.user_id = ${userId}
      returning id
    `;
    if (!rows[0]) throw new Error("Conversation not found");
    // Chat stays in messages — freeform assistant replies are not trip checkpoints.
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

  async archiveTripForReplacement(userId: string, tripId: string, now: Date): Promise<Trip> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<TripRow[]>`
        update captain.trips set
          status = 'archived',
          version = version + 1,
          archived_at = ${now},
          archive_reason = 'replaced',
          updated_at = ${now}
        where id = ${tripId} and user_id = ${userId}
        returning *
      `;
      if (!rows[0]) throw new TripNotFoundError();
      await tx`
        update captain.watches set
          status = 'completed',
          next_check_at = null,
          completed_at = coalesce(completed_at, ${now}),
          updated_at = ${now}
        where trip_id = ${tripId}
      `;
      await tx`
        update captain.conversations set active_trip_id = null, updated_at = ${now}
        where user_id = ${userId} and active_trip_id = ${tripId}
      `;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (${randomUUID()}, ${tripId}, ${userId}, 'trip_replaced', '{}'::jsonb, ${now})
      `;
      return toTrip(rows[0]);
    });
  }

  async listTrips(userId: string): Promise<Trip[]> {
    const rows = await this.#sql<TripRow[]>`
      select * from captain.trips where user_id = ${userId} order by updated_at desc
    `;
    return rows.map(toTrip);
  }

  async getActiveTrip(userId: string): Promise<Trip | null> {
    const rows = await this.#sql<TripRow[]>`
      select trip.* from captain.trips trip
      left join captain.conversations conversation
        on conversation.user_id = trip.user_id
      where trip.user_id = ${userId}
        and trip.status not in ('cancelled', 'completed', 'archived')
      order by
        case when trip.id = conversation.active_trip_id then 0 else 1 end,
        trip.updated_at desc
      limit 1
    `;
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async getTrip(userId: string, tripId: string): Promise<Trip | null> {
    const rows = await this.#sql<TripRow[]>`
      select * from captain.trips where id = ${tripId} and user_id = ${userId}
    `;
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async getTripById(tripId: string): Promise<Trip | null> {
    const rows = await this.#sql<TripRow[]>`
      select * from captain.trips where id = ${tripId}
    `;
    return rows[0] ? toTrip(rows[0]) : null;
  }

  async getTripGraph(userId: string, tripId: string): Promise<TripGraph> {
    if (!await this.getTrip(userId, tripId)) throw new TripNotFoundError();
    const [cities, legs] = await Promise.all([
      this.#sql<TripCityRow[]>`
        select city.* from captain.trip_cities city
        join captain.trips trip on trip.id = city.trip_id
        where city.trip_id = ${tripId} and trip.user_id = ${userId}
        order by city.position
      `,
      this.#sql<TripCityLegRow[]>`
        select leg.* from captain.trip_legs leg
        join captain.trips trip on trip.id = leg.trip_id
        where leg.trip_id = ${tripId} and trip.user_id = ${userId}
        order by leg.position
      `
    ]);
    return { cities: cities.map(toTripCity), legs: legs.map(toTripCityLeg) };
  }

  async getTripLeg(
    userId: string,
    tripId: string,
    legId: string
  ): Promise<TripCityLeg | null> {
    const rows = await this.#sql<TripCityLegRow[]>`
      select leg.* from captain.trip_legs leg
      join captain.trips trip on trip.id = leg.trip_id
      where leg.id = ${legId} and leg.trip_id = ${tripId} and trip.user_id = ${userId}
    `;
    return rows[0] ? toTripCityLeg(rows[0]) : null;
  }

  async createLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string,
    requestedWindow: { start: string; end: string },
    datesRequested: string[],
    now: Date
  ): Promise<LegSearchSnapshot> {
    return this.#sql.begin(async (tx) => {
      const legs = await tx<TripCityLegRow[]>`
        select leg.* from captain.trip_legs leg
        join captain.trips trip on trip.id = leg.trip_id
        where leg.id = ${legId} and leg.trip_id = ${tripId} and trip.user_id = ${userId}
        for update of leg
      `;
      if (!legs[0]) throw new TripNotFoundError();
      assertLegSearchRequest(toTripCityLeg(legs[0]), requestedWindow, datesRequested);
      const id = randomUUID();
      const analysis: LegSearchSnapshot["analysis"] = {
        complete: false,
        datesRequested,
        datesCompleted: [],
        failedDates: [],
        optionsChecked: 0,
        cheapest: null,
        fastest: null,
        balanced: null,
        cheapestByDate: [],
        observedAt: null
      };
      const rows = await tx<LegSearchSnapshotRow[]>`
        insert into captain.leg_search_snapshots (
          id, trip_id, leg_id, revision, status,
          requested_start, requested_end, analysis, flights, offers,
          created_at, updated_at, completed_at
        ) values (
          ${id}, ${tripId}, ${legId}, 1, 'queued',
          ${requestedWindow.start}, ${requestedWindow.end},
          ${tx.json(json(analysis))}, ${tx.json([])}, ${tx.json([])},
          ${now}, ${now}, null
        )
        returning *
      `;
      await tx`
        update captain.trip_legs set latest_search_id = ${id}, updated_at = ${now}
        where id = ${legId}
      `;
      return toLegSearchSnapshot(rows[0]!);
    });
  }

  async reviseLegSearchSnapshot(
    userId: string,
    searchId: string,
    expectedRevision: number,
    revision: LegSearchSnapshotRevision,
    now: Date
  ): Promise<LegSearchSnapshot | null> {
    assertLegSearchRevision(revision);
    const rows = await this.#sql<LegSearchSnapshotRow[]>`
      update captain.leg_search_snapshots snapshot set
        revision = snapshot.revision + 1,
        status = ${revision.status},
        analysis = ${this.#sql.json(json(revision.analysis))},
        flights = ${this.#sql.json(json(revision.flights))},
        offers = ${this.#sql.json(json(revision.offers))},
        completed_at = ${revision.completedAt ? new Date(revision.completedAt) : null},
        updated_at = ${now}
      from captain.trips trip
      where snapshot.id = ${searchId}
        and snapshot.revision = ${expectedRevision}
        and trip.id = snapshot.trip_id
        and trip.user_id = ${userId}
      returning snapshot.*
    `;
    return rows[0] ? toLegSearchSnapshot(rows[0]) : null;
  }

  async getLegSearchSnapshot(
    userId: string,
    searchId: string
  ): Promise<LegSearchSnapshot | null> {
    const rows = await this.#sql<LegSearchSnapshotRow[]>`
      select snapshot.* from captain.leg_search_snapshots snapshot
      join captain.trips trip on trip.id = snapshot.trip_id
      where snapshot.id = ${searchId} and trip.user_id = ${userId}
    `;
    return rows[0] ? toLegSearchSnapshot(rows[0]) : null;
  }

  async getLatestLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string
  ): Promise<LegSearchSnapshot | null> {
    const rows = await this.#sql<LegSearchSnapshotRow[]>`
      select snapshot.* from captain.trip_legs leg
      join captain.trips trip on trip.id = leg.trip_id
      join captain.leg_search_snapshots snapshot on snapshot.id = leg.latest_search_id
      where leg.id = ${legId} and leg.trip_id = ${tripId} and trip.user_id = ${userId}
    `;
    return rows[0] ? toLegSearchSnapshot(rows[0]) : null;
  }

  async setTripLegFlight(
    userId: string,
    tripId: string,
    legId: string,
    flightKey: string | null,
    selectedBy: "agent" | "person",
    now: Date
  ): Promise<TripCityLeg> {
    return this.#sql.begin(async (tx) => {
      const trips = await tx<TripRow[]>`
        select * from captain.trips
        where id = ${tripId} and user_id = ${userId}
        for update
      `;
      if (!trips[0]) throw new TripNotFoundError();
      const legs = await tx<TripCityLegRow[]>`
        select * from captain.trip_legs
        where id = ${legId} and trip_id = ${tripId}
        for update
      `;
      if (!legs[0]) throw new TripNotFoundError();
      const previousFlightKey = legs[0].selected_flight_key;
      if (flightKey) {
        const matching = await tx<Array<{ present: boolean }>>`
          select exists (
            select 1
            from captain.leg_search_snapshots snapshot,
              jsonb_array_elements(snapshot.flights) flight
            where snapshot.trip_id = ${tripId}
              and snapshot.leg_id = ${legId}
              and flight ->> 'key' = ${flightKey}
          ) as present
        `;
        if (matching[0]?.present !== true) throw new Error("Flight not found for Trip leg");
      }
      const flight = flightKey
        ? await this.#legFlightSelectionSummary(tx, tripId, legId, flightKey)
        : null;
      const previousFlight = previousFlightKey && previousFlightKey !== flightKey
        ? await this.#legFlightSelectionSummary(tx, tripId, legId, previousFlightKey)
        : null;
      const updated = await tx<TripCityLegRow[]>`
        update captain.trip_legs set selected_flight_key = ${flightKey}, updated_at = ${now}
        where id = ${legId}
        returning *
      `;
      await tx`
        update captain.trips set version = version + 1, updated_at = ${now}
        where id = ${tripId}
      `;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (
          ${randomUUID()}, ${tripId}, ${userId},
          ${flightKey ? "trip_leg_flight_selected" : "trip_leg_flight_unselected"},
          ${tx.json(json(tripLegFlightSelectionPayload({
            legId,
            flightKey,
            selectedBy,
            previousFlightKey: previousFlightKey !== flightKey ? previousFlightKey : null,
            flight,
            previousFlight
          })))}, ${now}
        )
      `;
      return toTripCityLeg(updated[0]!);
    });
  }

  async getCanonicalFlight(
    flightKey: string,
    now: Date
  ): Promise<{ flight: CanonicalFlight; offers: FlightOfferSnapshot[] } | null> {
    const flights = await this.#sql<Array<{ flight: CanonicalFlight }>>`
      select flight as flight
      from captain.leg_search_snapshots snapshot,
        jsonb_array_elements(snapshot.flights) flight
      where flight ->> 'key' = ${flightKey}
      order by snapshot.updated_at desc
      limit 1
    `;
    if (!flights[0]) return null;
    const offers = await this.#sql<Array<{ offer: FlightOfferSnapshot }>>`
      select offer as offer
      from captain.leg_search_snapshots snapshot,
        jsonb_array_elements(snapshot.offers) offer
      where offer ->> 'flightKey' = ${flightKey}
        and (
          offer ->> 'expiresAt' is null
          or (offer ->> 'expiresAt')::timestamptz > ${now}
        )
      order by snapshot.updated_at desc
    `;
    return {
      flight: flights[0].flight,
      offers: dedupeFlightOffers(offers.map((row) => row.offer))
    };
  }

  async getWatch(userId: string, tripId: string): Promise<Watch | null> {
    const rows = await this.#sql<WatchRow[]>`
      select watch.* from captain.watches watch
      join captain.trips trip on trip.id = watch.trip_id
      where trip.id = ${tripId} and trip.user_id = ${userId}
    `;
    return rows[0] ? toWatch(rows[0]) : null;
  }

  async createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<TripCreationResult> {
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      return createTripInTransaction(tx, userId, input, specs, now);
    });
  }

  async startTripTracking(
    userId: string,
    tripId: string,
    expectedVersion: number,
    specs: SearchSpec[],
    now: Date
  ): Promise<{ trip: Trip; watch: Watch }> {
    if (specs.length === 0) throw new Error("Tracking needs at least one flight search specification");
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      const trips = await tx<TripRow[]>`
        select * from captain.trips
        where id = ${tripId} and user_id = ${userId}
        for update
      `;
      const current = trips[0];
      if (!current) throw new TripNotFoundError();
      const existingWatches = await tx<WatchRow[]>`
        select * from captain.watches where trip_id = ${tripId} for update
      `;
      const existingWatch = existingWatches[0];
      if (
        ["tracking", "recommended"].includes(current.status)
        && existingWatch
        && ["active", "scheduled"].includes(existingWatch.status)
      ) {
        return { trip: toTrip(current), watch: toWatch(existingWatch) };
      }
      if (current.version !== expectedVersion) {
        throw new TripVersionConflictError(current.version);
      }
      if (current.status !== "draft") throw new Error("Only a reviewed draft can start tracking");

      const runEndsAt = trackingRunEndsAt(now, current.brief.departureWindow.start);
      const watchId = existingWatch?.id ?? randomUUID();
      const watchRows = existingWatch
        ? await tx<WatchRow[]>`
            update captain.watches set
              status = 'active', run_started_at = ${now}, run_ends_at = ${runEndsAt},
              completed_at = null, checks_completed = 0, next_check_at = ${now},
              last_check_at = null, last_manual_refresh_at = null,
              tracking_starts_at = null, baseline_completed_at = null,
              activated_at = ${now}, last_user_activity_at = ${now},
              price_rise_itinerary_key = null, price_rise_armed = true,
              delayed_at = null, delay_reason = null, updated_at = ${now}
            where id = ${watchId}
            returning *
          `
        : await tx<WatchRow[]>`
            insert into captain.watches (
              id, trip_id, status, run_started_at, run_ends_at,
              checks_completed, next_check_at, tracking_starts_at,
              activated_at, last_user_activity_at, created_at, updated_at
            ) values (
              ${watchId}, ${tripId}, 'active', ${now}, ${runEndsAt},
              0, ${now}, null, ${now}, ${now}, ${now}, ${now}
            )
            returning *
          `;
      await syncSpecs(tx, watchId, specs, now);
      const updated = await tx<TripRow[]>`
        update captain.trips set
          status = 'tracking', version = version + 1, updated_at = ${now}
        where id = ${tripId}
        returning *
      `;
      const checkpointKey = `${tripId}:tracking_started:${updated[0]!.version}`;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (
          ${randomUUID()}, ${tripId}, ${userId}, 'trip_tracking_started',
          ${tx.json(json({
            tripVersion: updated[0]!.version,
            checkpointKey
          }))}, ${now}
        )
      `;
      await enqueueNotification(tx, {
        userId,
        tripId,
        kind: "tracking_started",
        dedupKey: checkpointKey,
        payload: {
          eventType: "trip_tracking_started",
          tripTitle: updated[0]!.title,
          tripVersion: updated[0]!.version,
          checkpointKey
        },
        immediate: true,
        now
      });
      await signalFlightWorker(tx);
      return { trip: toTrip(updated[0]!), watch: toWatch(watchRows[0]!) };
    });
  }

  async updateTripBrief(
    userId: string,
    tripId: string,
    input: UpdateTripBrief,
    specs: SearchSpec[],
    now: Date
  ): Promise<Trip> {
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      const rows = await tx<TripRow[]>`
        select * from captain.trips
        where id = ${tripId} and user_id = ${userId}
        for update
      `;
      const current = rows[0];
      if (!current) throw new TripNotFoundError();
      if (current.version !== input.expectedVersion) {
        throw new TripVersionConflictError(current.version);
      }
      const previousBrief = current.brief as TripBrief;
      const material = isMaterialTripPlanChange(previousBrief, input.brief);
      const updated = await tx<TripRow[]>`
        update captain.trips set
          brief = ${tx.json(json(input.brief))},
          status = 'draft',
          version = version + 1,
          updated_at = ${now}
        where id = ${tripId}
        returning *
      `;
      await tx`
        update captain.watches set
          status = 'completed',
          completed_at = coalesce(completed_at, ${now}),
          next_check_at = null,
          last_user_activity_at = ${now},
          updated_at = ${now}
        where trip_id = ${tripId}
      `;
      await tx`delete from captain.trip_cities where trip_id = ${tripId}`;
      await insertTripGraph(tx, materializeTripGraph(tripId, input.brief), now);
      await tx`delete from captain.trip_recommendations where trip_id = ${tripId}`;
      const trip = toTrip(updated[0]!);
      if (material) {
        const checkpointKey = `${tripId}:plan_changed:${trip.version}`;
        await tx`
          insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
          values (
            ${randomUUID()}, ${tripId}, ${userId}, 'trip_plan_changed',
            ${tx.json(json({
              ...input.brief,
              tripVersion: trip.version,
              checkpointKey
            }))}, ${now}
          )
        `;
        await enqueueNotification(tx, {
          userId,
          tripId,
          kind: checkpointNotificationKindForAction("plan_changed"),
          dedupKey: checkpointKey,
          payload: {
            eventType: "trip_plan_changed",
            tripTitle: trip.title,
            tripRoute: formatTripRoute(trip.brief),
            tripVersion: trip.version,
            checkpointKey
          },
          immediate: true,
          now
        });
      }
      void specs;
      return trip;
    });
  }

  async updateTripTitle(
    userId: string,
    tripId: string,
    input: UpdateTripTitle,
    now: Date
  ): Promise<Trip> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<TripRow[]>`
        select * from captain.trips
        where id = ${tripId} and user_id = ${userId}
        for update
      `;
      const current = rows[0];
      if (!current) throw new TripNotFoundError();
      if (current.version !== input.expectedVersion) {
        throw new TripVersionConflictError(current.version);
      }
      const updated = await tx<TripRow[]>`
        update captain.trips set
          title = ${input.title}, version = version + 1, updated_at = ${now}
        where id = ${tripId}
        returning *
      `;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (
          ${randomUUID()}, ${tripId}, ${userId}, 'trip_title_updated',
          ${tx.json(json({ title: input.title }))}, ${now}
        )
      `;
      return toTrip(updated[0]!);
    });
  }

  async createTripPlanDraft(
    userId: string,
    request: string,
    sourceMessageId: string | null,
    now: Date
  ): Promise<TripPlanDraft> {
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`trip-plan:${userId}`}))`;
      await expireTripPlanDrafts(tx, userId, now);
      const existing = await tx<TripPlanDraftRow[]>`
        select * from captain.trip_plan_drafts
        where user_id = ${userId}
          and status in ('collecting', 'awaiting_confirmation', 'starting')
        order by updated_at desc limit 1
        for update
      `;
      if (existing[0]) return toTripPlanDraft(existing[0]);
      const id = randomUUID();
      const expiresAt = new Date(now.getTime() + 86_400_000);
      const rows = await tx<TripPlanDraftRow[]>`
        insert into captain.trip_plan_drafts (
          id, user_id, status, revision, conversation, draft_state, confirmation_snapshot,
          source_message_ids, trip_id, create_idempotency_key, created_at, updated_at, expires_at
        ) values (
          ${id}, ${userId}, 'collecting', 1, ${tx.json([request.trim()])},
          ${tx.json(json(EMPTY_TRIP_DRAFT_STATE))}, null,
          ${tx.json(sourceMessageId ? [sourceMessageId] : [])},
          null, null, ${now}, ${now}, ${expiresAt}
        )
        returning *
      `;
      return toTripPlanDraft(rows[0]!);
    });
  }

  async getTripPlanDraft(userId: string, draftId: string, now: Date): Promise<TripPlanDraft | null> {
    await expireTripPlanDrafts(this.#sql, userId, now);
    const rows = await this.#sql<TripPlanDraftRow[]>`
      select * from captain.trip_plan_drafts where id = ${draftId} and user_id = ${userId}
    `;
    return rows[0] ? toTripPlanDraft(rows[0]) : null;
  }

  async findOpenTripPlanDraft(userId: string, now: Date): Promise<TripPlanDraft | null> {
    await expireTripPlanDrafts(this.#sql, userId, now);
    const rows = await this.#sql<TripPlanDraftRow[]>`
      select * from captain.trip_plan_drafts
      where user_id = ${userId}
        and status in ('collecting', 'awaiting_confirmation', 'starting')
      order by updated_at desc limit 1
    `;
    return rows[0] ? toTripPlanDraft(rows[0]) : null;
  }

  async reviseTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    revision: TripPlanDraftRevision,
    now: Date
  ): Promise<TripPlanDraft | null> {
    const rows = await this.#sql<TripPlanDraftRow[]>`
      update captain.trip_plan_drafts set
        status = ${revision.status},
        revision = revision + 1,
        conversation = ${this.#sql.json(json(revision.conversation))},
        draft_state = ${this.#sql.json(json(revision.state))},
        confirmation_snapshot = ${revision.confirmationSnapshot
          ? this.#sql.json(json(revision.confirmationSnapshot))
          : null},
        source_message_ids = ${this.#sql.json(json(revision.sourceMessageIds))},
        updated_at = ${now},
        expires_at = ${new Date(now.getTime() + 86_400_000)}
      where id = ${draftId} and user_id = ${userId}
        and revision = ${expectedRevision}
        and status in ('collecting', 'awaiting_confirmation')
        and expires_at > ${now}
      returning *
    `;
    return rows[0] ? toTripPlanDraft(rows[0]) : null;
  }

  async cancelTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    now: Date
  ): Promise<TripPlanDraft | null> {
    return this.#transitionTripPlanDraft(
      userId,
      draftId,
      expectedRevision,
      ["collecting", "awaiting_confirmation"],
      "cancelled",
      now
    );
  }

  async reopenTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    now: Date
  ): Promise<TripPlanDraft | null> {
    return this.#transitionTripPlanDraft(
      userId,
      draftId,
      expectedRevision,
      ["awaiting_confirmation"],
      "collecting",
      now
    );
  }

  async confirmTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    specs: SearchSpec[],
    now: Date
  ): Promise<{ draft: TripPlanDraft; result: TripCreationResult } | null> {
    const confirmed = await this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`trip-plan:${userId}`}))`;
      await expireTripPlanDrafts(tx, userId, now);
      const rows = await tx<TripPlanDraftRow[]>`
        select * from captain.trip_plan_drafts
        where id = ${draftId} and user_id = ${userId}
        for update
      `;
      const current = rows[0] ? toTripPlanDraft(rows[0]) : null;
      if (!current) return null;
      if (current.status === "started" && current.tripId) {
        const trips = await tx<TripRow[]>`
          select * from captain.trips where id = ${current.tripId} and user_id = ${userId}
        `;
        const watches = trips[0]
          ? await tx<WatchRow[]>`select * from captain.watches where trip_id = ${current.tripId}`
          : [];
        return trips[0]
          ? {
              draft: current,
              result: {
                trip: toTrip(trips[0]),
                watch: watches[0] ? toWatch(watches[0]) : null,
                created: false
              }
            }
          : null;
      }
      if (
        current.status !== "awaiting_confirmation"
        || current.revision !== expectedRevision
        || !current.confirmationSnapshot
      ) {
        return null;
      }
      await tx`
        update captain.trip_plan_drafts set
          status = 'starting',
          revision = revision + 1,
          create_idempotency_key = ${`trip-plan:${draftId}:${expectedRevision}`},
          updated_at = ${now}
        where id = ${draftId}
      `;
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      const result = await createTripInTransaction(
        tx,
        userId,
        current.confirmationSnapshot.input,
        specs,
        now
      );
      const startedRows = await tx<TripPlanDraftRow[]>`
        update captain.trip_plan_drafts set
          status = 'started',
          revision = revision + 1,
          trip_id = ${result.trip.id},
          updated_at = ${now}
        where id = ${draftId}
        returning *
      `;
      return { draft: toTripPlanDraft(startedRows[0]!), result };
    });
    if (!confirmed) return null;
    return confirmed;
  }

  async applyTripAction(
    userId: string,
    tripId: string,
    action: TripAction,
    now: Date,
    options: ApplyTripActionOptions = {}
  ): Promise<Trip> {
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
      await tx<WatchRow[]>`
        select * from captain.watches where trip_id = ${tripId} for update
      `;
      const watchStatus = status === "paused"
        ? "paused"
        : ["cancelled", "completed"].includes(status)
          ? "completed"
          : "active";
      const departureStart = (current.brief as { departureWindow?: { start?: string } })
        .departureWindow?.start ?? "";
      await tx`
        update captain.watches set status = ${watchStatus},
          run_started_at = case when ${action.type} = 'track' then ${now} else run_started_at end,
          run_ends_at = case
            when ${action.type} = 'track' then ${trackingRunEndsAt(now, departureStart)}
            else run_ends_at
          end,
          completed_at = case
            when ${action.type} = 'track' then null
            when ${action.type} in ('cancel', 'complete') then coalesce(completed_at, ${now})
            else completed_at
          end,
          checks_completed = case when ${action.type} = 'track' then 0 else checks_completed end,
          next_check_at = case
            when ${action.type} in ('track', 'refresh', 'resume') then ${now}
            when ${action.type} in ('cancel', 'complete') then null
            else next_check_at
          end,
          activated_at = case when ${action.type} = 'track' then ${now} else activated_at end,
          delayed_at = case when ${action.type} = 'track' then null else delayed_at end,
          delay_reason = case when ${action.type} = 'track' then null else delay_reason end,
          last_manual_refresh_at = case when ${action.type} = 'refresh' then ${now} else last_manual_refresh_at end,
          last_user_activity_at = ${now},
          updated_at = ${now}
        where trip_id = ${tripId}
      `;
      const trip = toTrip(updated[0]!);
      const checkpointKey = action.type === "cancel" || action.type === "complete"
        ? `${tripId}:trip_closed:${trip.version}`
        : `${tripId}:trip_${action.type}:${trip.version}`;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (
          ${randomUUID()}, ${tripId}, ${userId}, ${`trip_${action.type}`},
          ${tx.json(json({ ...action, tripVersion: trip.version, checkpointKey }))}, ${now}
        )
      `;
      if (
        options.notifyCheckpoint !== false
        && (action.type === "pause" || action.type === "resume")
      ) {
        await enqueueNotification(tx, {
          userId,
          tripId,
          kind: checkpointNotificationKindForAction(action.type),
          dedupKey: checkpointKey,
          payload: {
            eventType: `trip_${action.type}`,
            tripTitle: trip.title,
            tripRoute: formatTripRoute(trip.brief),
            tripVersion: trip.version,
            checkpointKey
          },
          immediate: true,
          now
        });
      } else if (
        options.notifyCheckpoint !== false
        && (action.type === "cancel" || action.type === "complete")
      ) {
        await enqueueNotification(tx, {
          userId,
          tripId,
          kind: checkpointNotificationKindForAction(action.type),
          dedupKey: checkpointKey,
          payload: {
            eventType: `trip_${action.type}`,
            tripTitle: trip.title,
            tripRoute: formatTripRoute(trip.brief),
            tripVersion: trip.version,
            reason: action.type,
            checkpointKey
          },
          immediate: true,
          now
        });
      }
      if (["resume", "refresh", "track"].includes(action.type)) {
        await signalFlightWorker(tx);
      }
      return trip;
    });
  }

  async listTripActivity(userId: string, tripId: string): Promise<TripActivity[]> {
    const rows = await this.#sql<Array<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
      body: string | null;
      channel: TripActivity["channel"];
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
      join captain.trips trip on trip.id = event.trip_id
      where event.trip_id = ${tripId} and trip.user_id = ${userId}
      order by event.created_at desc
      limit 50
    `;
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: iso(row.created_at),
      body: row.body,
      channel: row.channel,
      notificationId: row.notification_id,
      sourceMessageId: row.source_message_id
    }));
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

  async getTrackedFlightPrices(userId: string, tripId: string): Promise<TrackedFlightPrices | null> {
    const watched = await this.#sql<Array<{ itinerary_key: string }>>`
      select selection.itinerary_key
      from captain.trip_flight_selections selection
      join captain.trips trip on trip.id = selection.trip_id
      where selection.trip_id = ${tripId}
        and trip.user_id = ${userId}
        and selection.selected_by = 'person'
      order by selection.selected_at desc
      limit 1
    `;
    const itineraryKey = watched[0]?.itinerary_key;
    if (!itineraryKey) return null;
    // Currency is fixed for a trip, but a provider swap could still leave two
    // in the table; the newest observation decides which series to return.
    const latest = await this.#sql<Array<{ currency: string }>>`
      select currency from captain.price_observations
      where itinerary_key = ${itineraryKey}
      order by observed_at desc
      limit 1
    `;
    const currency = latest[0]?.currency;
    if (!currency) return { itineraryKey, currency: "USD", observations: [] };
    const rows = await this.#sql<Array<{ price: string | number; observed_at: Date }>>`
      select price, observed_at
      from captain.price_observations
      where itinerary_key = ${itineraryKey} and currency = ${currency}
      order by observed_at asc
    `;
    return {
      itineraryKey,
      currency,
      observations: rows.map((row) => ({
        price: Number(row.price),
        observedAt: iso(row.observed_at)
      }))
    };
  }

  async listTripFlightSelections(userId: string, tripId: string): Promise<TripFlightSelection[]> {
    const rows = await this.#sql<Array<{
      trip_id: string;
      itinerary_key: string;
      selected_by: TripFlightSelection["selectedBy"];
      selected_at: Date;
    }>>`
      select recommendation.trip_id, recommendation.itinerary_key,
        'agent'::text as selected_by, recommendation.observed_at as selected_at
      from captain.trip_recommendations recommendation
      join captain.trips trip on trip.id = recommendation.trip_id
      where recommendation.trip_id = ${tripId} and trip.user_id = ${userId}
      union all
      select selection.trip_id, selection.itinerary_key,
        selection.selected_by, selection.selected_at
      from captain.trip_flight_selections selection
      join captain.trips trip on trip.id = selection.trip_id
      where selection.trip_id = ${tripId} and trip.user_id = ${userId}
      order by selected_at desc, selected_by, itinerary_key
    `;
    return rows.map((row) => ({
      tripId: row.trip_id,
      itineraryKey: row.itinerary_key,
      selectedBy: row.selected_by,
      selectedAt: iso(row.selected_at)
    }));
  }

  async setTripFlightSelection(
    userId: string,
    tripId: string,
    itineraryKey: string,
    selected: boolean,
    now: Date
  ): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const trips = await tx<Array<{ id: string }>>`
        select id from captain.trips where id = ${tripId} and user_id = ${userId}
        for update
      `;
      if (!trips[0]) throw new TripNotFoundError();
      if (selected) {
        const offers = await tx<Array<{ exists: boolean }>>`
          select exists(
            select 1 from captain.offers offer
            join captain.watch_search_specs link on link.search_spec_id = offer.search_spec_id
            join captain.watches watch on watch.id = link.watch_id
            where watch.trip_id = ${tripId}
              and offer.itinerary_key = ${itineraryKey}
              and (offer.expires_at is null or offer.expires_at > ${now})
          ) as exists
        `;
        if (!offers[0]?.exists) throw new Error("Flight offer not found");
        await tx`
          insert into captain.trip_flight_selections (
            trip_id, itinerary_key, selected_by, selected_at
          ) values (${tripId}, ${itineraryKey}, 'person', ${now})
          on conflict (trip_id, itinerary_key, selected_by)
          do update set selected_at = excluded.selected_at
        `;
      } else {
        await tx`
          delete from captain.trip_flight_selections
          where trip_id = ${tripId} and itinerary_key = ${itineraryKey}
            and selected_by = 'person'
        `;
      }
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (
          ${randomUUID()}, ${tripId}, ${userId},
          ${selected ? "flight_selected" : "flight_unselected"},
          ${tx.json(json({ itineraryKey, selectedBy: "person" }))}, ${now}
        )
      `;
      await tx`
        update captain.watches set
          last_user_activity_at = ${now},
          updated_at = ${now}
        where trip_id = ${tripId}
      `;
    });
  }

  async markTripActivity(userId: string, tripId: string, now: Date): Promise<void> {
    const rows = await this.#sql<Array<{ id: string }>>`
      update captain.trips set updated_at = ${now}
      where id = ${tripId} and user_id = ${userId}
      returning id
    `;
    if (!rows[0]) throw new TripNotFoundError();
    await this.#sql`
      update captain.watches set last_user_activity_at = ${now}, updated_at = ${now}
      where trip_id = ${tripId}
    `;
  }

  async hasDueWorkerWork(now: Date): Promise<boolean> {
    const rows = await this.#sql<Array<{ due: boolean }>>`
      select (
        exists (
          select 1
          from captain.watches watch
          join captain.trips trip on trip.id = watch.trip_id
          where trip.status not in ('cancelled', 'completed', 'archived')
            and (
              (
                watch.status = 'active'
                and watch.next_check_at is not null
                and watch.next_check_at <= ${now}
              )
              or (
                watch.status = 'active'
                and watch.run_ends_at <= ${now}
              )
              or (
                watch.status = 'scheduled'
                and watch.tracking_starts_at is not null
                and watch.tracking_starts_at <= ${now}
              )
            )
        )
        or exists (
          select 1
          from captain.search_runs run
          where run.scheduled_at <= ${now}
            and run.attempt < 3
            and (
              run.status in ('queued', 'deferred')
              or (
                run.status = 'running'
                and run.lease_expires_at is not null
                and run.lease_expires_at <= ${now}
              )
            )
        )
        or exists (
          select 1
          from captain.notifications notification
          where notification.status = 'pending'
            and notification.available_at <= ${now}
        )
      ) as due
    `;
    return rows[0]?.due ?? false;
  }

  async maintainTracking(now: Date): Promise<TrackingMaintenance> {
    const rows = await this.#sql<Array<{
      watch_id: string;
      trip_id: string;
      user_id: string;
      title: string;
      watch_status: Watch["status"];
      tracking_starts_at: Date | null;
      run_started_at: Date;
      run_ends_at: Date;
      checks_completed: number;
      notification_mode: TravellerProfile["notificationMode"];
      ranking_mode: TravellerProfile["rankingMode"];
      brief: Trip["brief"];
      recommendation_summary: string | null;
    }>>`
      select watch.id as watch_id, trip.id as trip_id, trip.user_id, trip.title,
        watch.status as watch_status, watch.tracking_starts_at,
        watch.run_started_at, watch.run_ends_at,
        watch.checks_completed,
        profile.notification_mode, profile.ranking_mode, trip.brief,
        recommendation.summary as recommendation_summary
      from captain.watches watch
      join captain.trips trip on trip.id = watch.trip_id
      join captain.traveller_profiles profile on profile.user_id = trip.user_id
      left join captain.trip_recommendations recommendation on recommendation.trip_id = trip.id
      where watch.status in ('active', 'scheduled')
        and trip.status not in ('cancelled', 'completed', 'archived')
        and (
          (
            watch.status = 'scheduled'
            and watch.tracking_starts_at is not null
            and watch.tracking_starts_at <= ${now}
          )
          or (
            watch.status = 'active'
            and watch.run_ends_at <= ${now}
            and not exists (
              select 1
              from captain.watch_search_specs link
              join captain.search_runs run on run.search_spec_id = link.search_spec_id
              where link.watch_id = watch.id
                and run.status in ('queued', 'running', 'deferred')
            )
          )
        )
    `;
    let activated = 0;
    let completed = 0;
    for (const row of rows) {
      if (row.watch_status === "active" && row.run_ends_at.getTime() <= now.getTime()) {
        const checkpointKey = `${row.trip_id}:tracking_summary:${row.run_started_at.toISOString()}`;
        const didComplete = await this.#sql.begin(async (tx) => {
          const watches = await tx<Array<{ id: string }>>`
            update captain.watches set
              status = 'completed',
              next_check_at = null,
              completed_at = ${now},
              updated_at = ${now}
            where id = ${row.watch_id}
              and status = 'active'
              and run_ends_at <= ${now}
              and not exists (
                select 1
                from captain.watch_search_specs link
                join captain.search_runs run on run.search_spec_id = link.search_spec_id
                where link.watch_id = ${row.watch_id}
                  and run.status in ('queued', 'running', 'deferred')
              )
            returning id
          `;
          if (!watches[0]) return false;
          await tx`
            update captain.trips set
              status = 'recommended',
              version = version + 1,
              updated_at = ${now}
            where id = ${row.trip_id}
          `;
          await tx`
            insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
            values (
              ${randomUUID()}, ${row.trip_id}, ${row.user_id}, 'tracking_completed',
              ${tx.json(json({
                checksCompleted: row.checks_completed,
                recommendationSummary: row.recommendation_summary,
                checkpointKey
              }))}, ${now}
            )
          `;
          return true;
        });
        if (!didComplete) continue;
        if (row.notification_mode !== "off") {
          await enqueueNotification(this.#sql, {
            userId: row.user_id,
            tripId: row.trip_id,
            kind: "tracking_summary",
            dedupKey: checkpointKey,
            payload: {
              tripTitle: row.title,
              tripRoute: formatTripRoute(row.brief),
              tripGoal: formatTripGoal({ brief: row.brief, rankingMode: row.ranking_mode }),
              checksCompleted: row.checks_completed,
              summary: row.recommendation_summary ?? "The latest verified options are ready to review.",
              checkpointKey
            },
            now
          });
        }
        completed += 1;
        continue;
      }
      if (
        row.watch_status === "scheduled"
        && row.tracking_starts_at
        && row.tracking_starts_at.getTime() <= now.getTime()
      ) {
        const updated = await this.#sql<Array<{ id: string }>>`
          update captain.watches set
            status = 'active',
            next_check_at = ${now},
            activated_at = ${now},
            last_user_activity_at = ${now},
            updated_at = ${now}
          where id = ${row.watch_id} and status = 'scheduled'
          returning id
        `;
        if (!updated[0]) continue;
        if (row.notification_mode !== "off") {
          await enqueueNotification(this.#sql, {
            userId: row.user_id,
            tripId: row.trip_id,
            kind: "tracking_activation",
            dedupKey: `${row.trip_id}:tracking_activation:${row.tracking_starts_at.toISOString()}`,
            payload: {
              tripTitle: row.title,
              tripGoal: formatTripGoal({ brief: row.brief, rankingMode: row.ranking_mode }),
              trackingStartsAt: row.tracking_starts_at.toISOString()
            },
            now
          });
        }
        activated += 1;
      }
    }
    return { activated, completed };
  }

  async finalizeFarFutureBaseline(searchSpecId: string, now: Date): Promise<void> {
    await this.#sql`
      update captain.watches watch set
        status = 'scheduled',
        next_check_at = watch.tracking_starts_at,
        baseline_completed_at = ${now},
        updated_at = ${now}
      from captain.watch_search_specs link
      where link.watch_id = watch.id
        and link.search_spec_id = ${searchSpecId}
        and watch.status = 'active'
        and watch.tracking_starts_at > ${now}
    `;
  }

  async scheduleDueSearchRuns(now: Date, freshnessMs: number, limit: number): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const watches = await tx<Array<{
        id: string;
        trip_id: string;
        run_ends_at: Date;
      }>>`
        select watch.id, watch.trip_id, watch.run_ends_at
        from captain.watches watch
        join captain.trips trip on trip.id = watch.trip_id
        where watch.status = 'active'
          and watch.next_check_at <= ${now}
          and watch.run_ends_at > ${now}
        order by watch.next_check_at asc limit ${limit}
        for update skip locked
      `;
      let scheduled = 0;
      const claimedSpecs = new Set<string>();
      for (const watch of watches) {
        const recommendations = await tx<Array<{ search_spec_id: string | null }>>`
          select search_spec_id from captain.trip_recommendations where trip_id = ${watch.trip_id}
        `;
        const preferredSpecId = recommendations[0]?.search_spec_id ?? null;
        const batchLimit = preferredSpecId ? TRACKING_SEARCH_SPEC_LIMIT : DISCOVERY_SEARCH_SPEC_LIMIT;
        const specs = await tx<Array<{ search_spec_id: string }>>`
          select link.search_spec_id
          from captain.watch_search_specs link
          left join captain.search_runs run
            on run.search_spec_id = link.search_spec_id and run.status = 'completed'
          where link.watch_id = ${watch.id}
          group by link.search_spec_id, link.created_at
          order by
            case when link.search_spec_id = ${preferredSpecId} then 0 else 1 end,
            max(run.completed_at) asc nulls first,
            link.created_at,
            link.search_spec_id
          limit ${batchLimit}
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
          update captain.watches set next_check_at = ${new Date(Math.min(
            watch.run_ends_at.getTime(),
            now.getTime() + TRACKING_CHECK_INTERVAL_MS
          ))}, updated_at = ${now}
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
            and (
              status in ('queued', 'deferred')
              or (status = 'running' and lease_expires_at <= ${now})
            )
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
    const retainedOffers = retainSearchOffers(offers);
    await this.#sql.begin(async (tx) => {
      const runs = await tx<Array<{ search_spec_id: string }>>`
        update captain.search_runs set status = 'completed', completed_at = ${now},
          provider_request_id = ${providerRequestId}, lease_expires_at = null, error = null,
          provider_offer_count = ${offers.length}, retained_offer_count = ${retainedOffers.length}
        where id = ${runId} and status = 'running' and claimed_by = ${workerId}
        returning search_spec_id
      `;
      const run = runs[0];
      if (!run) throw new Error("Search run lease is not owned by this worker");
      // Empty verified sets keep the last good offers rather than wiping the trip blank.
      if (retainedOffers.length === 0) {
        await tx`
          update captain.watches watch set last_check_at = ${now},
            checks_completed = checks_completed + 1,
            delayed_at = ${now},
            delay_reason = ${"No fares were found in the latest check."},
            updated_at = ${now}
          from captain.watch_search_specs link
          where link.watch_id = watch.id and link.search_spec_id = ${run.search_spec_id}
        `;
        return;
      }
      await tx`delete from captain.offers where search_spec_id = ${run.search_spec_id}`;
      for (const offer of retainedOffers) {
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
            observed_at, snapshot, fare_basis, primary_airline_code,
            participating_airline_codes, evidence, discovery_response_id,
            verification_response_id, prompt_version, model, verified_at
          ) values (
            ${offerId}, ${runId}, ${run.search_spec_id}, ${offer.itineraryKey}, ${offer.provider},
            ${offer.providerOfferId}, ${offer.providerSearchId}, ${offer.price}, ${offer.currency},
            ${offer.expiresAt}, ${offer.observedAt}, ${tx.json(json(offer.snapshot))},
            ${offer.fareBasis}, ${offer.primaryAirlineCode},
            ${tx.json(json(offer.participatingAirlineCodes))},
            ${tx.json(json(offer.evidence))}, ${offer.discoveryResponseId},
            ${offer.verificationResponseId}, ${offer.promptVersion}, ${offer.model},
            ${offer.verifiedAt}
          ) on conflict (search_run_id, provider_offer_id) do nothing
        `;
        await tx`
          insert into captain.price_observations (
            id, search_run_id, search_spec_id, itinerary_key, provider,
            provider_offer_id, price, currency, observed_at, snapshot
          ) values (
            ${randomUUID()}, ${runId}, ${run.search_spec_id}, ${offer.itineraryKey}, ${offer.provider},
            ${offer.providerOfferId}, ${offer.price}, ${offer.currency}, ${offer.observedAt},
            ${tx.json(json({}))}
          )
        `;
      }
      await tx`
        delete from captain.itineraries itinerary
        where not exists (
          select 1 from captain.offers offer where offer.itinerary_key = itinerary.itinerary_key
        )
      `;
      await tx`
        update captain.watches watch set last_check_at = ${now},
          checks_completed = checks_completed + 1,
          delayed_at = null, delay_reason = null, updated_at = ${now}
        from captain.watch_search_specs link
        where link.watch_id = watch.id and link.search_spec_id = ${run.search_spec_id}
      `;
    });
  }

  async recordMultiCityLegSearchResult(
    searchSpecId: string,
    offers: CompletedProviderOffer[] | null,
    errorCode: string | null,
    now: Date
  ): Promise<MultiCityLegSearchRecording> {
    const specs = await this.#sql<Array<{ request: SearchSpec["request"] }>>`
      select request from captain.search_specs where id = ${searchSpecId}
    `;
    const request = specs[0]?.request;
    if (!request) return { matched: 0, notified: 0 };
    const rows = await this.#sql<TripRow[]>`
      select distinct trip.* from captain.trips trip
      join captain.watches watch on watch.trip_id = trip.id
      join captain.watch_search_specs link on link.watch_id = watch.id
      where link.search_spec_id = ${searchSpecId}
        and trip.status not in ('cancelled', 'completed', 'archived')
    `;
    let matched = 0;
    let notified = 0;
    for (const row of rows) {
      const trip = toTrip(row);
      const graph = await this.getTripGraph(trip.userId, trip.id);
      for (const match of matchingMultiCityLegs(trip, graph, request)) {
        const datesRequested = enumerateIsoDates(
          match.leg.departureWindow.start,
          match.leg.departureWindow.end
        );
        const snapshot = await this.createLegSearchSnapshot(
          trip.userId,
          trip.id,
          match.leg.id,
          match.leg.departureWindow,
          datesRequested,
          now
        );
        const revision = multiCityLegRevision(match, trip, offers, errorCode, now);
        const completed = await this.reviseLegSearchSnapshot(
          trip.userId,
          snapshot.id,
          snapshot.revision,
          revision,
          now
        );
        matched += 1;
        if (!completed || completed.analysis.optionsChecked === 0) continue;
        const refreshed = await this.getTripGraph(trip.userId, trip.id);
        const snapshots = await Promise.all(refreshed.legs.map((leg) =>
          leg.latestSearchId
            ? this.getLegSearchSnapshot(trip.userId, leg.latestSearchId)
            : Promise.resolve(null)
        ));
        const remainingLegs = snapshots.filter((current) =>
          !current || ["queued", "running"].includes(current.status)
        ).length;
        const queued = await enqueueNotification(this.#sql, {
          userId: trip.userId,
          tripId: trip.id,
          kind: "initial_results",
          dedupKey: `${trip.id}:initial_results:multi_city`,
          payload: {
            ...notificationGoalPayload(trip, await this.ensureProfile(trip.userId, now)),
            tripTitle: trip.title,
            multiCityProgress: {
              legRoute: `${match.origin.airportCodes[0]} → ${match.destination.airportCodes[0]}`,
              legsTotal: graph.legs.length,
              remainingLegs
            }
          },
          now
        });
        if (queued) {
          notified += 1;
          await this.#sql`
            update captain.trips set status = 'recommended',
              version = version + 1, updated_at = ${now}
            where id = ${trip.id} and status = 'tracking'
          `;
        }
      }
    }
    return { matched, notified };
  }

  async pruneWatchData(now: Date): Promise<void> {
    const staleOfferBefore = new Date(now.getTime() - CURRENT_OFFER_RETENTION_MS);
    const staleHistoryBefore = new Date(now.getTime() - PRICE_HISTORY_RETENTION_MS);
    await this.#sql.begin(async (tx) => {
      await tx`
        delete from captain.offers
        where (expires_at is not null and expires_at <= ${now})
           or observed_at < ${staleOfferBefore}
      `;
      await tx`
        delete from captain.price_observations where observed_at < ${staleHistoryBefore}
      `;
      await tx`
        delete from captain.search_runs
        where status in ('completed', 'failed')
          and completed_at < ${staleOfferBefore}
      `;
      await tx`
        delete from captain.trips
        where status = 'archived'
          and archived_at < ${new Date(now.getTime() - 90 * 86_400_000)}
      `;
      await tx`
        delete from captain.itineraries itinerary
        where not exists (
          select 1 from captain.offers offer where offer.itinerary_key = itinerary.itinerary_key
        )
      `;
    });
  }

  async failSearchRun(
    workerId: string,
    runId: string,
    error: string,
    retryAfterMs: number | null,
    retryable: boolean,
    now: Date
  ): Promise<boolean> {
    const terminal = await this.#sql.begin(async (tx) => {
      const rows = await tx<Array<{ attempt: number; search_spec_id: string }>>`
        select attempt, search_spec_id from captain.search_runs
        where id = ${runId} and status = 'running' and claimed_by = ${workerId}
        for update
      `;
      const run = rows[0];
      if (!run) throw new Error("Search run lease is not owned by this worker");
      const retry = retryable && run.attempt < 3;
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
    if (terminal) {
      await this.#sql`
        update captain.watches watch set
          delayed_at = ${now},
          delay_reason = 'A scheduled check was delayed; keeping last results.',
          updated_at = ${now}
        from captain.watch_search_specs link
        where link.watch_id = watch.id
          and link.search_spec_id = ${terminal}
      `;
    }
    return terminal !== null;
  }

  async deferSearchRun(workerId: string, runId: string, until: Date, reason: string, now: Date): Promise<void> {
    const rows = await this.#sql<Array<{ id: string }>>`
      update captain.search_runs set
        status = 'deferred', attempt = greatest(0, attempt - 1),
        claimed_by = null, lease_expires_at = null, scheduled_at = ${until},
        completed_at = null, error = ${reason}
      where id = ${runId} and status = 'running' and claimed_by = ${workerId}
      returning id
    `;
    if (!rows[0]) throw new Error("Search run lease is not owned by this worker");
    await this.#sql`
      update captain.watches watch set
        delayed_at = ${now}, delay_reason = ${reason}, updated_at = ${now}
      from captain.watch_search_specs link
      where link.watch_id = watch.id
        and link.search_spec_id = (
          select search_spec_id from captain.search_runs where id = ${runId}
        )
    `;
  }

  async evaluateTripsForSearchSpec(searchSpecId: string, now: Date): Promise<number> {
    const rows = await this.#sql<TripRow[]>`
      select distinct trip.* from captain.trips trip
      join captain.watches watch on watch.trip_id = trip.id
      join captain.watch_search_specs link on link.watch_id = watch.id
      where link.search_spec_id = ${searchSpecId}
        and trip.status not in ('paused', 'cancelled', 'completed', 'archived')
    `;
    let changed = 0;
    for (const row of rows) {
      const trip = toTrip(row);
      const offers = await this.listTripOffers(trip.userId, trip.id, now);
      const profile = await this.ensureProfile(trip.userId, now);
      const watch = await this.getWatch(trip.userId, trip.id);
      const ranked = rankOffers(trip.brief, profile, offers);
      const best = ranked[0];
      if (!best) {
        await this.#sql`delete from captain.trip_recommendations where trip_id = ${trip.id}`;
        continue;
      }
      const previousRows = await this.#sql<RecommendationRow[]>`
        select * from captain.trip_recommendations where trip_id = ${trip.id}
      `;
      const previous = previousRows[0] ? toRecommendation(previousRows[0]) : null;
      const comparison = previous
        ? rankOffers(trip.brief, profile, [...offers, previous.snapshot.current])
        : [];
      const previousRanked = previous
        ? comparison.find((candidate) => candidate.offer.id === previous.snapshot.current.id) ?? {
            offer: previous.snapshot.current,
            score: previous.score
          }
        : null;
      const comparableBest = comparison.find((candidate) => candidate.offer.id === best.offer.id) ?? best;
      const qualifies = meetsAlertThreshold(profile.rankingMode, comparableBest, previousRanked);
      const reasonCodes = previous && !qualifies
        ? []
        : recommendationReasonCodes(
            profile.rankingMode,
            best.offer,
            previous?.snapshot.current ?? null
          );
      const recommendation: TripRecommendation = {
        tripId: trip.id, offerId: best.offer.id, searchSpecId: best.offer.searchSpecId,
        itineraryKey: best.offer.itineraryKey,
        score: best.score, price: best.offer.price, currency: best.offer.currency,
        summary: recommendationSummary(best.offer), observedAt: best.offer.observedAt,
        rankingMode: profile.rankingMode,
        snapshot: {
          current: best.offer,
          previous: previous?.snapshot.current ?? null,
          rankingMode: profile.rankingMode,
          reasonCodes,
          createdAt: now.toISOString()
        }
      };
      // The first search always earns a message: it tells the traveller what
      // Captain found and what to do next. After that, only a change worth the
      // interruption speaks.
      const kind = profile.notificationMode === "off"
        ? null
        : !previous
          ? "initial_results"
          : qualifies && profile.betterOptionAlertsEnabled
            ? profile.rankingMode === "cheapest" ? "price_drop" : "new_best"
            : null;
      const notified = await this.#sql.begin(async (tx) => {
        let queued = false;
        await tx`
          insert into captain.trip_recommendations (
            trip_id, offer_id, search_spec_id, itinerary_key, score, price, currency,
            summary, observed_at, ranking_mode, snapshot, updated_at
          ) values (
            ${trip.id}, ${best.offer.id}, ${best.offer.searchSpecId}, ${best.offer.itineraryKey}, ${best.score},
            ${best.offer.price}, ${best.offer.currency}, ${recommendation.summary},
            ${best.offer.observedAt}, ${recommendation.rankingMode},
            ${tx.json(json(recommendation.snapshot))}, ${now}
          ) on conflict (trip_id) do update set
            offer_id = excluded.offer_id, search_spec_id = excluded.search_spec_id,
            itinerary_key = excluded.itinerary_key,
            score = excluded.score, price = excluded.price, currency = excluded.currency,
            summary = excluded.summary, observed_at = excluded.observed_at,
            ranking_mode = excluded.ranking_mode, snapshot = excluded.snapshot,
            updated_at = excluded.updated_at
        `;
        if (kind) {
          const recentAlerts = await tx<Array<{ count: string }>>`
            select count(*)::text as count from captain.notifications
            where user_id = ${trip.userId}
              and kind in ('price_rise', 'price_drop', 'new_best')
              and status <> 'superseded'
              and created_at >= ${new Date(now.getTime() - 86_400_000)}
          `;
          const capped = kind !== "initial_results"
            && Number(recentAlerts[0]?.count ?? 0) >= profile.maxAlertsPerDay;
          if (!capped) {
            const dedupKey = `${trip.id}:${kind}:${best.offer.itineraryKey}:${best.offer.price}`;
            const telegram = await tx<Array<{ exists: boolean }>>`
              select exists(select 1 from captain.telegram_accounts where user_id = ${trip.userId}) as exists
            `;
            if (telegram[0]?.exists) {
              const availableAt = await userDeliveryTime(tx, trip.userId, now);
              const inserted = await tx<Array<{ id: string }>>`
                insert into captain.notifications (
                  id, user_id, trip_id, kind, dedup_key, payload, status,
                  attempts, available_at, created_at, updated_at
                ) values (
                  ${randomUUID()}, ${trip.userId}, ${trip.id}, ${kind}, ${dedupKey},
                  ${tx.json(json({
                    ...notificationGoalPayload(trip, profile),
                    ...recommendation,
                    ...(kind === "initial_results"
                      ? { range: offerRangeSummary(offers), dateSummary: offerDateSummary(offers, trip) }
                      : {}),
                    ...(kind === "initial_results" && watch?.trackingStartsAt
                      ? { trackingStartsAt: watch.trackingStartsAt }
                      : {}),
                    ...(previous ? {
                      previousPrice: previous.price,
                      dropPercent: previous.price > 0 ? Math.round((1 - recommendation.price / previous.price) * 100) : 0
                    } : {})
                  }))},
                  'pending', 0, ${availableAt}, ${now}, ${now}
                ) on conflict (dedup_key) do nothing
                returning id
              `;
              queued = inserted.length === 1;
            }
          }
        }
        if (trip.status === "tracking") {
          await tx`
            update captain.trips set status = 'recommended',
              version = version + 1, updated_at = ${now} where id = ${trip.id}
          `;
        }
        return queued;
      });
      if (notified) changed += 1;
      if (
        watch
        && await this.#evaluatePriceRise(trip, watch, profile, offers, best.offer, now)
      ) {
        changed += 1;
      }
    }
    return changed;
  }

  async #evaluatePriceRise(
    trip: Trip,
    watch: Watch,
    profile: TravellerProfile,
    offers: OfferSnapshot[],
    recommended: OfferSnapshot,
    now: Date
  ): Promise<boolean> {
    const selections = await this.#sql<Array<{ itinerary_key: string }>>`
      select itinerary_key
      from captain.trip_flight_selections
      where trip_id = ${trip.id} and selected_by = 'person'
      order by selected_at desc
      limit 1
    `;
    const monitored = offers.find((offer) =>
      offer.itineraryKey === selections[0]?.itinerary_key
    ) ?? recommended;
    const lows = await this.#sql<Array<{ minimum: string | number | null }>>`
      select min(price) as minimum
      from captain.price_observations
      where itinerary_key = ${monitored.itineraryKey}
        and currency = ${monitored.currency}
        and observed_at >= ${new Date(now.getTime() - 7 * 86_400_000)}
    `;
    const low = Number(lows[0]?.minimum ?? monitored.price);
    const increase = monitored.price - low;
    const percent = low > 0 ? increase / low : 0;
    const sameItinerary = watch.priceRiseItineraryKey === monitored.itineraryKey;
    const armed = sameItinerary ? watch.priceRiseArmed : true;
    const thresholdReached = percent >= 0.05 && increase >= 20;
    let queued = false;
    if (thresholdReached && armed && profile.priceRiseAlertsEnabled) {
      const recent = await this.#sql<Array<{ count: string }>>`
        select count(*)::text as count
        from captain.notifications
        where user_id = ${trip.userId}
          and kind in ('price_rise', 'price_drop', 'new_best')
          and status <> 'superseded'
          and created_at >= ${new Date(now.getTime() - 86_400_000)}
      `;
      if (Number(recent[0]?.count ?? 0) < profile.maxAlertsPerDay) {
        queued = await enqueueNotification(this.#sql, {
          userId: trip.userId,
          tripId: trip.id,
          kind: "price_rise",
          dedupKey: `${trip.id}:price_rise:${monitored.itineraryKey}:${low}:${monitored.price}`,
          payload: {
            ...notificationGoalPayload(trip, profile),
            current: monitored,
            sevenDayLow: low,
            increase,
            percent: Math.round(percent * 100)
          },
          now
        });
      }
    }
    await this.#sql`
      update captain.watches set
        price_rise_itinerary_key = ${monitored.itineraryKey},
        price_rise_armed = ${thresholdReached ? !queued && armed : true},
        updated_at = ${now}
      where id = ${watch.id}
    `;
    return queued;
  }

  async listPendingNotifications(now: Date, limit: number): Promise<CaptainNotification[]> {
    return this.#sql.begin(async (tx) => {
      await tx`
        update captain.notifications set
          status = 'superseded',
          error = 'Suppressed by smart notification policy',
          updated_at = ${now}
        where status = 'pending'
          and available_at <= ${now}
          and (
            kind = 'watch_attention'
            or (
              kind = 'inventory_gap'
              and coalesce(payload ->> 'initialSearchFailure', 'false') <> 'true'
            )
          )
      `;
      // A stale "better option" is worth dropping for a fresher one. The
      // opening overview is not one of those, so it always gets delivered.
      await tx`
        with ranked as (
          select id,
            row_number() over (
              partition by trip_id
              order by created_at desc, id desc
            ) as position
          from captain.notifications
          where status = 'pending'
            and kind in ('price_drop', 'new_best')
        )
        update captain.notifications notification set
          status = 'superseded',
          error = 'A newer trip update was available before delivery',
          updated_at = ${now}
        from ranked
        where notification.id = ranked.id
          and ranked.position > 1
      `;
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
        payload: row.payload, attempts: row.attempts,
        telegramMessageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id)
      }));
    });
  }

  async markNotificationSent(
    notificationId: string,
    telegramMessageId: number,
    body: string,
    now: Date
  ): Promise<void> {
    const trimmed = body.trim();
    await this.#sql.begin(async (tx) => {
      const rows = await tx<Array<{
        trip_id: string;
        user_id: string;
        kind: string;
        payload: Record<string, unknown>;
      }>>`
        update captain.notifications set status = 'sent', delivered_at = ${now},
          telegram_message_id = ${telegramMessageId}, error = null, updated_at = ${now}
        where id = ${notificationId} and status = 'sending'
        returning trip_id, user_id, kind, payload
      `;
      const row = rows[0];
      if (!row || !trimmed || !isCheckpointNotificationKind(row.kind)) return;
      await tx`
        insert into captain.trip_events (
          id, trip_id, user_id, event_type, payload, body, channel, notification_id, created_at
        ) values (
          ${randomUUID()}, ${row.trip_id}, ${row.user_id}, 'captain_update',
          ${tx.json({
            kind: row.kind,
            ...checkpointCorrelationPayload(row.payload)
          })}, ${trimmed}, 'telegram', ${notificationId}, ${now}
        )
      `;
    });
  }

  async markNotificationFailed(notificationId: string, error: string, now: Date): Promise<void> {
    await this.#sql`
      update captain.notifications set
        status = case when attempts >= 3 then 'failed' else 'pending' end,
        available_at = ${new Date(now.getTime() + 300_000)}, error = ${error}, updated_at = ${now}
      where id = ${notificationId} and status = 'sending'
    `;
  }

  async getNotificationByTelegramMessage(
    userId: string,
    telegramMessageId: number
  ): Promise<CaptainNotification | null> {
    const rows = await this.#sql<Array<NotificationRow & { chat_id: string }>>`
      select notification.*, telegram.chat_id::text as chat_id
      from captain.notifications notification
      join captain.telegram_accounts telegram on telegram.user_id = notification.user_id
      where notification.user_id = ${userId}
        and notification.telegram_message_id = ${telegramMessageId}
      limit 1
    `;
    const row = rows[0];
    return row ? {
      id: row.id,
      userId: row.user_id,
      tripId: row.trip_id,
      telegramChatId: Number(row.chat_id),
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      telegramMessageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id)
    } : null;
  }

  async getRecommendation(userId: string, tripId: string): Promise<TripRecommendation | null> {
    const rows = await this.#sql<RecommendationRow[]>`
      select recommendation.*
      from captain.trip_recommendations recommendation
      join captain.trips trip on trip.id = recommendation.trip_id
      where recommendation.trip_id = ${tripId} and trip.user_id = ${userId}
    `;
    return rows[0] ? toRecommendation(rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #transitionTripPlanDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    expectedStatuses: TripPlanDraft["status"][],
    status: TripPlanDraft["status"],
    now: Date
  ): Promise<TripPlanDraft | null> {
    const firstExpectedStatus = expectedStatuses[0];
    if (!firstExpectedStatus) throw new Error("Expected at least one Trip draft status");
    const secondExpectedStatus = expectedStatuses[1] ?? firstExpectedStatus;
    const rows = await this.#sql<TripPlanDraftRow[]>`
      update captain.trip_plan_drafts set
        status = ${status},
        revision = revision + 1,
        updated_at = ${now},
        expires_at = ${new Date(now.getTime() + 86_400_000)}
      where id = ${draftId} and user_id = ${userId}
        and revision = ${expectedRevision}
        and (status = ${firstExpectedStatus} or status = ${secondExpectedStatus})
        and expires_at > ${now}
      returning *
    `;
    return rows[0] ? toTripPlanDraft(rows[0]) : null;
  }

  async enqueueInventoryGapForSearchSpec(searchSpecId: string, now: Date): Promise<number> {
    const rows = await this.#sql<Array<{
      watch_id: string;
      trip_id: string;
      user_id: string;
      title: string;
      brief: TripBrief;
    }>>`
      select distinct watch.id as watch_id, trip.id as trip_id,
        trip.user_id, trip.title, trip.brief
      from captain.watches watch
      join captain.trips trip on trip.id = watch.trip_id
      join captain.watch_search_specs link on link.watch_id = watch.id
      where link.search_spec_id = ${searchSpecId}
        and trip.status not in ('cancelled', 'completed', 'archived')
    `;
    let queued = 0;
    for (const row of rows) {
      const pending = await this.#sql<Array<{ exists: boolean }>>`
        select exists (
          select 1 from captain.watch_search_specs link
          where link.watch_id = ${row.watch_id}
            and (
              exists (
                select 1 from captain.search_runs run
                where run.search_spec_id = link.search_spec_id
                  and run.status in ('queued', 'running', 'deferred')
              )
              or not exists (
                select 1 from captain.search_runs run
                where run.search_spec_id = link.search_spec_id
                  and run.status in ('completed', 'failed')
              )
            )
        ) as exists
      `;
      if (pending[0]?.exists) continue;
      const initial = await this.#sql<Array<{ exists: boolean }>>`
        select exists (
          select 1 from captain.notifications
          where trip_id = ${row.trip_id}
            and kind = 'initial_results'
            and status <> 'superseded'
        ) as exists
      `;
      if (initial[0]?.exists) continue;
      const trip: Trip = {
        id: row.trip_id,
        userId: row.user_id,
        title: row.title,
        status: "tracking",
        version: 1,
        brief: row.brief,
        archivedAt: null,
        archiveReason: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      if (await enqueueNotification(this.#sql, {
        userId: row.user_id,
        tripId: row.trip_id,
        kind: "inventory_gap",
        dedupKey: `${row.trip_id}:initial_search_failed`,
        payload: {
          ...notificationGoalPayload(trip, await this.ensureProfile(row.user_id, now)),
          tripTitle: row.title,
          multiCity: row.brief.tripType === "multi_city",
          initialSearchFailure: true
        },
        now
      })) queued += 1;
    }
    return queued;
  }

  async #legFlightSelectionSummary(
    sql: Sql,
    tripId: string,
    legId: string,
    flightKey: string
  ) {
    const rows = await sql<Array<{
      flight: CanonicalFlight;
      offers: FlightOfferSnapshot[];
    }>>`
      select flight as flight, snapshot.offers as offers
      from captain.leg_search_snapshots snapshot,
        jsonb_array_elements(snapshot.flights) flight
      where snapshot.trip_id = ${tripId}
        and snapshot.leg_id = ${legId}
        and flight ->> 'key' = ${flightKey}
      order by snapshot.updated_at desc
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    return tripLegFlightSelectionSummary(row.flight, row.offers);
  }

}

async function createTripInTransaction(
  sql: Sql,
  userId: string,
  input: CreateTripInput,
  specs: SearchSpec[],
  now: Date
): Promise<TripCreationResult> {
  const duplicates = await sql<TripRow[]>`
    select * from captain.trips
    where user_id = ${userId} and status not in ('cancelled', 'completed', 'archived')
      and brief = ${sql.json(json(input.brief))}
    order by updated_at desc limit 1
    for update
  `;
  if (duplicates[0]) {
    const watches = await sql<WatchRow[]>`
      select * from captain.watches where trip_id = ${duplicates[0].id}
    `;
    await sql`
      update captain.conversations set active_trip_id = ${duplicates[0].id}, updated_at = ${now}
      where user_id = ${userId}
    `;
    return {
      trip: toTrip(duplicates[0]),
      watch: watches[0] ? toWatch(watches[0]) : null,
      created: false
    };
  }
  const activeCounts = await sql<Array<{ count: string }>>`
    select count(*)::text as count
    from captain.trips
    where user_id = ${userId}
      and status not in ('cancelled', 'completed', 'archived')
  `;
  if (Number(activeCounts[0]?.count ?? 0) >= MAX_ACTIVE_TRIPS_PER_USER) {
    throw new TripLimitError();
  }
  const tripId = randomUUID();
  await sql`
    insert into captain.trips (
      id, user_id, title, status, version, brief, created_at, updated_at
    ) values (
      ${tripId}, ${userId}, ${input.title}, 'draft', 1,
      ${sql.json(json(input.brief))}, ${now}, ${now}
    )
  `;
  await insertTripGraph(sql, materializeTripGraph(tripId, input.brief), now);
  await sql`
    insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
    values (${randomUUID()}, ${tripId}, ${userId}, 'trip_created', ${sql.json(json(input))}, ${now})
  `;
  await sql`
    update captain.conversations set active_trip_id = ${tripId}, updated_at = ${now}
    where user_id = ${userId}
  `;
  void specs;
  return {
    trip: {
      id: tripId,
      userId,
      title: input.title,
      status: "draft",
      version: 1,
      brief: input.brief,
      archivedAt: null,
      archiveReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    },
    watch: null,
    created: true
  };
}

async function insertTripGraph(sql: Sql, graph: TripGraph, now: Date): Promise<void> {
  for (const city of graph.cities) {
    await sql`
      insert into captain.trip_cities (
        id, trip_id, position, label, airport_codes,
        arrival_start, arrival_end, departure_start, departure_end,
        created_at, updated_at
      ) values (
        ${city.id}, ${city.tripId}, ${city.position}, ${city.label},
        ${sql.json(json(city.airportCodes))},
        ${city.arrivalWindow?.start ?? null}, ${city.arrivalWindow?.end ?? null},
        ${city.departureWindow?.start ?? null}, ${city.departureWindow?.end ?? null},
        ${now}, ${now}
      )
    `;
  }
  for (const leg of graph.legs) {
    await sql`
      insert into captain.trip_legs (
        id, trip_id, position, origin_city_id, destination_city_id,
        departure_start, departure_end, arrive_by,
        selected_flight_key, latest_search_id, created_at, updated_at
      ) values (
        ${leg.id}, ${leg.tripId}, ${leg.position}, ${leg.originCityId},
        ${leg.destinationCityId}, ${leg.departureWindow.start},
        ${leg.departureWindow.end}, ${leg.arriveBy}, ${leg.selectedFlightKey},
        ${leg.latestSearchId}, ${now}, ${now}
      )
    `;
  }
}

function materializeTripGraph(tripId: string, brief: TripBrief): TripGraph {
  const routeLegs = legacyRouteLegs(brief);
  const cities: TripCity[] = routeLegs.map((leg, position) => ({
    id: randomUUID(),
    tripId,
    position,
    label: cityLabelForAirportCodes(leg.originAirports),
    airportCodes: [...leg.originAirports],
    arrivalWindow: position === 0
      ? null
      : arrivalWindowFor(routeLegs[position - 1]!),
    departureWindow: { ...leg.departureWindow }
  }));
  const finalLeg = routeLegs.at(-1);
  if (finalLeg) {
    cities.push({
      id: randomUUID(),
      tripId,
      position: routeLegs.length,
      label: cityLabelForAirportCodes(finalLeg.destinationAirports),
      airportCodes: [...finalLeg.destinationAirports],
      arrivalWindow: arrivalWindowFor(finalLeg),
      departureWindow: null
    });
  }
  const legs: TripCityLeg[] = routeLegs.map((leg, position) => ({
    id: randomUUID(),
    tripId,
    position,
    originCityId: cities[position]!.id,
    destinationCityId: cities[position + 1]!.id,
    departureWindow: { ...leg.departureWindow },
    arriveBy: leg.arriveBy ?? null,
    selectedFlightKey: null,
    latestSearchId: null
  }));
  return { cities, legs };
}

function arrivalWindowFor(leg: {
  departureWindow: { start: string; end: string };
  arriveBy: string | null;
}): { start: string; end: string } {
  return leg.arriveBy
    ? { start: leg.arriveBy, end: leg.arriveBy }
    : { ...leg.departureWindow };
}

function legacyRouteLegs(brief: TripBrief): Array<{
  originAirports: string[];
  destinationAirports: string[];
  departureWindow: { start: string; end: string };
  arriveBy: string | null;
}> {
  if (brief.tripType === "multi_city" && brief.legs?.length) {
    return structuredClone(brief.legs).map((leg) => ({ ...leg, arriveBy: leg.arriveBy ?? null }));
  }
  const outbound = {
    originAirports: [...brief.originAirports],
    destinationAirports: [...brief.destinationAirports],
    departureWindow: { ...brief.departureWindow },
    arriveBy: null
  };
  if (brief.tripType !== "round_trip" || !brief.stayNights) return [outbound];
  return [outbound, {
    originAirports: [...brief.destinationAirports],
    destinationAirports: [...brief.originAirports],
    departureWindow: {
      start: addUtcDays(brief.departureWindow.start, brief.stayNights.minimum),
      end: addUtcDays(brief.departureWindow.end, brief.stayNights.maximum)
    },
    arriveBy: null
  }];
}

function addUtcDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function expireTripPlanDrafts(sql: Sql, userId: string, now: Date): Promise<void> {
  await sql`
    update captain.trip_plan_drafts set status = 'expired', updated_at = ${now}
    where user_id = ${userId}
      and status in ('collecting', 'awaiting_confirmation', 'starting')
      and expires_at <= ${now}
  `;
}

async function cancelOnboardingFollowupsWithActivity(
  sql: Sql,
  userId: string | null,
  now: Date
): Promise<void> {
  await sql`
    update captain.onboarding_followups followup set
      status = 'cancelled', lease_expires_at = null,
      disabled_at = ${now},
      disabled_reason = case
        when exists (
          select 1 from captain.messages message
          where message.user_id = followup.user_id
            and message.role = 'user'
            and message.created_at > followup.sequence_started_at
        ) then 'telegram_message'
        else 'trip_activity'
      end,
      error = null, updated_at = ${now}
    where followup.status in ('pending', 'sending')
      and (${userId}::uuid is null or followup.user_id = ${userId}::uuid)
      and (
        exists (
          select 1 from captain.messages message
          where message.user_id = followup.user_id
            and message.role = 'user'
            and message.created_at > followup.sequence_started_at
        )
        or exists (
          select 1 from captain.trips trip
          where trip.user_id = followup.user_id
            and trip.created_at >= followup.sequence_started_at
        )
        or exists (
          select 1 from captain.trip_plan_drafts draft
          where draft.user_id = followup.user_id
            and draft.created_at >= followup.sequence_started_at
        )
      )
  `;
}

async function userDeliveryTime(sql: Sql, userId: string, now: Date): Promise<Date> {
  const rows = await sql<Array<{
    timezone: string;
    quiet_hours_enabled: boolean | null;
    quiet_hours_start: number | null;
    quiet_hours_end: number | null;
  }>>`
    select users.timezone, profile.quiet_hours_enabled,
      profile.quiet_hours_start, profile.quiet_hours_end
    from captain.users users
    left join captain.traveller_profiles profile on profile.user_id = users.id
    where users.id = ${userId}
  `;
  const timezone = rows[0]?.timezone ?? "UTC";
  if (rows[0]?.quiet_hours_enabled === false) return now;
  const start = rows[0]?.quiet_hours_start ?? DEFAULT_PROFILE.quietHoursStart;
  const end = rows[0]?.quiet_hours_end ?? DEFAULT_PROFILE.quietHoursEnd;
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
    if (start === end) return now;
    if (start > end) {
      if (hour >= start) return new Date(now.getTime() + (24 - hour + end) * 3_600_000);
      if (hour < end) return new Date(now.getTime() + (end - hour) * 3_600_000);
    } else if (hour >= start && hour < end) {
      return new Date(now.getTime() + (end - hour) * 3_600_000);
    }
  } catch {
    // Invalid timezones fall back to immediate delivery.
  }
  return now;
}

async function enqueueNotification(
  sql: Sql,
  input: {
    userId: string;
    tripId: string;
    kind: CaptainNotification["kind"];
    dedupKey: string;
    payload: Record<string, unknown>;
    immediate?: boolean;
    now: Date;
  }
): Promise<boolean> {
  const recipients = await sql<Array<{
    exists: boolean;
    notification_mode: TravellerProfile["notificationMode"] | null;
  }>>`
    select exists(
      select 1 from captain.telegram_accounts where user_id = ${input.userId}
    ) as exists,
    (
      select notification_mode from captain.traveller_profiles
      where user_id = ${input.userId}
    ) as notification_mode
  `;
  if (!recipients[0]?.exists) return false;
  if (!input.immediate && recipients[0].notification_mode === "off") return false;
  const availableAt = input.immediate
    ? input.now
    : await userDeliveryTime(sql, input.userId, input.now);
  const rows = await sql<Array<{ id: string }>>`
    insert into captain.notifications (
      id, user_id, trip_id, kind, dedup_key, payload, status,
      attempts, available_at, created_at, updated_at
    ) values (
      ${randomUUID()}, ${input.userId}, ${input.tripId}, ${input.kind},
      ${input.dedupKey}, ${sql.json(json(input.payload))}, 'pending',
      0, ${availableAt}, ${input.now}, ${input.now}
    )
    on conflict (dedup_key) do nothing
    returning id
  `;
  if (rows.length === 1 && input.immediate) await signalFlightWorker(sql);
  return rows.length === 1;
}

function checkpointCorrelationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof payload.checkpointKey === "string"
      ? { checkpointKey: payload.checkpointKey }
      : {}),
    ...(typeof payload.tripVersion === "number"
      ? { tripVersion: payload.tripVersion }
      : {})
  };
}

function localParts(now: Date, timezone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour"))
  };
}

function actionStatus(action: TripAction["type"], current: TripStatus): TripStatus {
  if (action === "pause") return "paused";
  if (["resume", "refresh", "track"].includes(action)) {
    return current === "draft" && action !== "track" ? "draft" : "tracking";
  }
  if (action === "cancel") return "cancelled";
  if (action === "complete") return "completed";
  return current;
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

function daysUntilDeparture(departureStart: string, now: Date): number {
  const departure = Date.parse(`${departureStart}T00:00:00.000Z`);
  return Number.isFinite(departure)
    ? Math.ceil((departure - now.getTime()) / 86_400_000)
    : 0;
}

type UserRow = { id: string; status: CaptainUser["status"]; timezone: string };
type TelegramRow = { telegram_user_id: string | number; chat_id: string | number; username: string | null; first_name: string | null; last_name: string | null };
type TripRow = {
  id: string; user_id: string; title: string; status: TripStatus;
  version: number; brief: Trip["brief"]; archived_at: Date | null;
  archive_reason: Trip["archiveReason"]; created_at: Date; updated_at: Date;
};
type TripCityRow = {
  id: string; trip_id: string; position: number; label: string; airport_codes: string[];
  arrival_start: Date | string | null; arrival_end: Date | string | null;
  departure_start: Date | string | null; departure_end: Date | string | null;
};
type TripCityLegRow = {
  id: string; trip_id: string; position: number;
  origin_city_id: string; destination_city_id: string;
  departure_start: Date | string; departure_end: Date | string;
  arrive_by: Date | string | null;
  selected_flight_key: string | null; latest_search_id: string | null;
};
type LegSearchSnapshotRow = {
  id: string; trip_id: string; leg_id: string; revision: number;
  status: LegSearchSnapshot["status"];
  requested_start: Date | string; requested_end: Date | string;
  analysis: LegSearchSnapshot["analysis"];
  flights: LegSearchSnapshot["flights"];
  offers: LegSearchSnapshot["offers"];
  created_at: Date | string; updated_at: Date | string; completed_at: Date | string | null;
};
type OfferRow = {
  id: string; search_run_id: string; search_spec_id: string; itinerary_key: string;
  provider: FlightSearchProviderId; provider_offer_id: string; provider_search_id: string;
  price: string | number; currency: string; expires_at: Date | null; observed_at: Date;
  fare_basis: "one_adult_total"; primary_airline_code: string;
  participating_airline_codes: string[];
  evidence: OfferSnapshot["evidence"];
  discovery_response_id: string; verification_response_id: string;
  prompt_version: string; model: string; verified_at: Date;
  snapshot: Record<string, unknown>;
};
type WatchRow = {
  id: string; trip_id: string; status: Watch["status"];
  run_started_at: Date; run_ends_at: Date; completed_at: Date | null;
  checks_completed: number;
  next_check_at: Date | null; last_check_at: Date | null;
  last_manual_refresh_at: Date | null;
  tracking_starts_at: Date | null; baseline_completed_at: Date | null;
  activated_at: Date | null; last_user_activity_at: Date;
  price_rise_itinerary_key: string | null; price_rise_armed: boolean;
  delayed_at: Date | null; delay_reason: string | null;
  created_at: Date; updated_at: Date;
};
type TripPlanDraftRow = {
  id: string;
  user_id: string;
  status: TripPlanDraft["status"];
  revision: number;
  conversation: string[];
  draft_state: unknown;
  confirmation_snapshot: unknown | null;
  source_message_ids: string[];
  trip_id: string | null;
  create_idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
};
type RecommendationRow = {
  trip_id: string; offer_id: string | null; search_spec_id: string | null;
  itinerary_key: string; score: string | number;
  price: string | number; currency: string; summary: string; observed_at: Date;
  ranking_mode: TripRecommendation["rankingMode"];
  snapshot: TripRecommendation["snapshot"];
};
type NotificationRow = {
  id: string; user_id: string; trip_id: string; kind: CaptainNotification["kind"];
  payload: Record<string, unknown>; attempts: number;
  telegram_message_id: string | number | null;
};
type OnboardingFollowupRow = {
  user_id: string;
  stage: OnboardingFollowupStage;
  attempts: number;
  available_at: Date;
};
type TravellerFactRow = {
  id: string;
  kind: TravellerFactKind;
  value: string;
  evidence: string;
  source_message_id: string | null;
  status: "active" | "dismissed";
  created_at: Date;
  updated_at: Date;
};

function travellerFactFromRow(row: TravellerFactRow): TravellerFact {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    evidence: row.evidence,
    sourceMessageId: row.source_message_id,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}
type ProfileRow = {
  user_id: string;
  default_currency: string;
  ranking_mode: TravellerProfile["rankingMode"];
  preferred_airline_codes: string[];
  excluded_airline_codes: string[];
  alerts_enabled: boolean;
  notification_mode: TravellerProfile["notificationMode"];
  price_rise_alerts_enabled: boolean;
  better_option_alerts_enabled: boolean;
  max_alerts_per_day: number;
  quiet_hours_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  onboarding_completed_at: Date | null;
  onboarding_step: TravellerProfile["onboardingStep"];
  created_at: Date;
  updated_at: Date;
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
    id: row.id, userId: row.user_id,
    title: row.title, status: row.status, version: row.version, brief: row.brief,
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
    archiveReason: row.archive_reason,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function toTripCity(row: TripCityRow): TripCity {
  return {
    id: row.id,
    tripId: row.trip_id,
    position: row.position,
    label: row.label,
    airportCodes: row.airport_codes,
    arrivalWindow: row.arrival_start && row.arrival_end
      ? { start: isoDate(row.arrival_start), end: isoDate(row.arrival_end) }
      : null,
    departureWindow: row.departure_start && row.departure_end
      ? { start: isoDate(row.departure_start), end: isoDate(row.departure_end) }
      : null
  };
}

function toTripCityLeg(row: TripCityLegRow): TripCityLeg {
  return {
    id: row.id,
    tripId: row.trip_id,
    position: row.position,
    originCityId: row.origin_city_id,
    destinationCityId: row.destination_city_id,
    departureWindow: {
      start: isoDate(row.departure_start),
      end: isoDate(row.departure_end)
    },
    arriveBy: row.arrive_by ? isoDate(row.arrive_by) : null,
    selectedFlightKey: row.selected_flight_key,
    latestSearchId: row.latest_search_id
  };
}

function toLegSearchSnapshot(row: LegSearchSnapshotRow): LegSearchSnapshot {
  return {
    id: row.id,
    tripId: row.trip_id,
    legId: row.leg_id,
    revision: row.revision,
    status: row.status,
    requestedWindow: {
      start: isoDate(row.requested_start),
      end: isoDate(row.requested_end)
    },
    analysis: row.analysis,
    flights: row.flights,
    offers: row.offers,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null
  };
}

function toOffer(row: OfferRow): OfferSnapshot {
  return {
    id: row.id, searchRunId: row.search_run_id, searchSpecId: row.search_spec_id,
    itineraryKey: row.itinerary_key, provider: row.provider,
    providerOfferId: row.provider_offer_id, providerSearchId: row.provider_search_id,
    price: Number(row.price), priceAmount: decimalString(row.price), currency: row.currency,
    fareBasis: row.fare_basis,
    primaryAirlineCode: row.primary_airline_code,
    participatingAirlineCodes: row.participating_airline_codes,
    evidence: row.evidence,
    discoveryResponseId: row.discovery_response_id,
    verificationResponseId: row.verification_response_id,
    promptVersion: row.prompt_version,
    model: row.model,
    verifiedAt: iso(row.verified_at),
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    observedAt: iso(row.observed_at), snapshot: row.snapshot
  };
}

function toWatch(row: WatchRow): Watch {
  return {
    id: row.id, tripId: row.trip_id, status: row.status,
    runStartedAt: iso(row.run_started_at),
    runEndsAt: iso(row.run_ends_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    checksCompleted: row.checks_completed,
    nextCheckAt: row.next_check_at ? iso(row.next_check_at) : null,
    lastCheckAt: row.last_check_at ? iso(row.last_check_at) : null,
    lastManualRefreshAt: row.last_manual_refresh_at ? iso(row.last_manual_refresh_at) : null,
    trackingStartsAt: row.tracking_starts_at ? iso(row.tracking_starts_at) : null,
    baselineCompletedAt: row.baseline_completed_at ? iso(row.baseline_completed_at) : null,
    activatedAt: row.activated_at ? iso(row.activated_at) : null,
    lastUserActivityAt: iso(row.last_user_activity_at),
    priceRiseItineraryKey: row.price_rise_itinerary_key,
    priceRiseArmed: row.price_rise_armed,
    delayedAt: row.delayed_at ? iso(row.delayed_at) : null,
    delayReason: row.delay_reason,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function toTripPlanDraft(row: TripPlanDraftRow): TripPlanDraft {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    revision: row.revision,
    conversation: row.conversation,
    state: tripDraftStateSchema.parse(row.draft_state),
    confirmationSnapshot: row.confirmation_snapshot
      ? tripPlanConfirmationSnapshotSchema.parse(row.confirmation_snapshot)
      : null,
    sourceMessageIds: row.source_message_ids,
    tripId: row.trip_id,
    createIdempotencyKey: row.create_idempotency_key,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at)
  };
}

function toRecommendation(row: RecommendationRow): TripRecommendation {
  return {
    tripId: row.trip_id, offerId: row.offer_id, searchSpecId: row.search_spec_id,
    itineraryKey: row.itinerary_key,
    score: Number(row.score), price: Number(row.price), currency: row.currency,
    summary: row.summary, observedAt: iso(row.observed_at),
    rankingMode: row.ranking_mode,
    snapshot: row.snapshot
  };
}

function toProfile(row: ProfileRow): TravellerProfile {
  return {
    userId: row.user_id,
    defaultCurrency: row.default_currency,
    rankingMode: row.ranking_mode,
    preferredAirlineCodes: row.preferred_airline_codes,
    excludedAirlineCodes: row.excluded_airline_codes,
    alertsEnabled: row.alerts_enabled,
    notificationMode: row.notification_mode,
    priceRiseAlertsEnabled: row.price_rise_alerts_enabled,
    betterOptionAlertsEnabled: row.better_option_alerts_enabled,
    maxAlertsPerDay: row.max_alerts_per_day,
    quietHoursEnabled: row.quiet_hours_enabled,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    onboardingCompletedAt: row.onboarding_completed_at ? iso(row.onboarding_completed_at) : null,
    onboardingStep: row.onboarding_step,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function displayName(input: TelegramUserInput): string {
  return input.firstName?.trim() || (input.username ? `@${input.username}` : `traveller ${input.telegramUserId}`);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoDate(value: Date | string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

function json(value: unknown): Parameters<Sql["json"]>[0] {
  return value as Parameters<Sql["json"]>[0];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function publicBetaEnabled(): boolean {
  return !["0", "false", "off", "no"].includes(
    (process.env.CAPTAIN_PUBLIC_BETA_ENABLED ?? "true").trim().toLowerCase()
  );
}

function decimalString(value: string | number): string {
  if (typeof value === "string") {
    return value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;
  }
  return Number.isInteger(value) ? String(value) : String(value);
}

function assertLegSearchRequest(
  leg: Pick<TripCityLeg, "departureWindow">,
  requestedWindow: { start: string; end: string },
  datesRequested: string[]
): void {
  const requestedDates = enumerateIsoDates(requestedWindow.start, requestedWindow.end);
  if (
    requestedDates.length === 0
    || requestedDates.length > MAX_MANUAL_SEARCH_DAYS
    || requestedWindow.start < leg.departureWindow.start
    || requestedWindow.end > leg.departureWindow.end
    || JSON.stringify(datesRequested) !== JSON.stringify(requestedDates)
  ) {
    throw new RangeError("Leg search must cover every date in a valid window of at most 7 days");
  }
}

function enumerateIsoDates(start: string, end: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(start) || !/^\d{4}-\d{2}-\d{2}$/u.test(end)) return [];
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
  const result: string[] = [];
  for (
    let value = startMs;
    value <= endMs && result.length <= MAX_MANUAL_SEARCH_DAYS;
    value += 86_400_000
  ) {
    result.push(new Date(value).toISOString().slice(0, 10));
  }
  return result;
}

function assertLegSearchRevision(revision: LegSearchSnapshotRevision): void {
  legSearchSnapshotSchema.shape.status.parse(revision.status);
  legSearchSnapshotSchema.shape.analysis.parse(revision.analysis);
  legSearchSnapshotSchema.shape.flights.parse(revision.flights);
  legSearchSnapshotSchema.shape.offers.parse(revision.offers);
  legSearchSnapshotSchema.shape.completedAt.parse(revision.completedAt);
  const flightKeys = new Set(revision.flights.map((flight) => flight.key));
  if (revision.offers.some((offer) => !flightKeys.has(offer.flightKey))) {
    throw new Error("Every offer must reference a canonical flight in the same snapshot");
  }
}

function dedupeFlightOffers(offers: FlightOfferSnapshot[]): FlightOfferSnapshot[] {
  const byProviderOffer = new Map<string, FlightOfferSnapshot>();
  for (const offer of offers) {
    const key = `${offer.provider}:${offer.offerId}`;
    const current = byProviderOffer.get(key);
    if (!current || offer.observedAt > current.observedAt) byProviderOffer.set(key, offer);
  }
  return [...byProviderOffer.values()].sort((left, right) =>
    Number(left.priceAmount) - Number(right.priceAmount)
    || right.observedAt.localeCompare(left.observedAt)
  );
}
