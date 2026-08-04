import { randomUUID } from "node:crypto";

import {
  DEFAULT_PROFILE,
  MAX_ACTIVE_TRIPS_PER_USER,
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  EMPTY_TRIP_DRAFT_STATE,
  tripPlanConfirmationSnapshotSchema,
  tripDraftStateSchema,
  type CaptainSessionPath,
  type CreatePassengerInput,
  type CreateTripInput,
  type FlightSearchProviderId,
  type OfferSnapshot,
  type Passenger,
  type PaymentCardDeletion,
  type PaymentCardSetupIntent,
  type PaymentMethod,
  type SavePaymentMethodInput,
  type SearchSpec,
  type Trip,
  type TripAction,
  type TripCreationResult,
  type TripPlanDraft,
  type TripPlanDraftRevision,
  type TripStatus,
  type TravellerProfile,
  type UpdatePassengerInput,
  type UpdateTravellerProfile,
  type UpdateTripBrief,
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
  TrackingMaintenance,
  TripFlightSelection,
  TripActivity,
  TripRecommendation
} from "./contracts.js";
import {
  BetaCapacityError,
  BetaLaunchGateError,
  PaymentMethodLimitError,
  PaymentSetupConflictError,
  PaymentSetupInProgressError
} from "./contracts.js";
import {
  meetsAlertThreshold,
  rankOffers,
  recommendationReasonCodes,
  recommendationSummary
} from "./ranking.js";
import {
  adaptiveWatchIntervalMs,
  CURRENT_OFFER_RETENTION_MS,
  DIGEST_TRIP_LIMIT,
  DISCOVERY_SEARCH_SPEC_LIMIT,
  PRICE_HISTORY_RETENTION_MS,
  retainSearchOffers,
  TRACKING_SEARCH_SPEC_LIMIT,
  trackingStartsAt,
  INACTIVITY_AUTO_PAUSE_MS,
  INACTIVITY_CHECKIN_MS
} from "./watch-policy.js";

const SETUP_INTENT_TTL_MS = 30 * 60_000;
const SETUP_INTENT_COMPLETED_RETENTION_MS = 24 * 60 * 60_000;
const CLIENT_KEY_ISSUE_LEASE_MS = 45_000;
const CLIENT_KEY_ISSUE_POLL_INITIAL_MS = 25;
const CLIENT_KEY_ISSUE_POLL_MAX_MS = 250;
/** Bounds how long a client-key request may wait on another issuer's lease. */
const CLIENT_KEY_ISSUE_DEADLINE_MS = 10_000;
const MAX_PAYMENT_METHODS_PER_USER = 20;
/** Retries span roughly four days before a deletion is parked for manual reconciliation. */
const MAX_CARD_DELETION_ATTEMPTS = 10;
const CARD_DELETION_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000
] as const;

function cardDeletionBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), CARD_DELETION_BACKOFF_MS.length - 1);
  return CARD_DELETION_BACKOFF_MS[index]!;
}

function truncateErrorDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.slice(0, 500);
}

export class PostgresCaptainPlatformStore implements CaptainPlatformStore {
  readonly #sql: Sql;
  readonly #piiEncryptionKey: string;
  readonly #clientKeyIssues = new Map<string, {
    setupIntentId: string;
    work: Promise<{ setupIntentId: string; clientKey: string }>;
  }>();

  private constructor(sql: Sql, piiEncryptionKey: string) {
    this.#sql = sql;
    this.#piiEncryptionKey = piiEncryptionKey;
  }

  static connect(
    databaseUrl: string,
    max = 4,
    idleTimeoutSeconds = 600,
    piiEncryptionKey = "captain-local-passenger-documents"
  ): PostgresCaptainPlatformStore {
    return new PostgresCaptainPlatformStore(postgres(databaseUrl, {
      max,
      idle_timeout: idleTimeoutSeconds,
      connect_timeout: 15,
      transform: { undefined: null }
    }), piiEncryptionKey);
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
      // Same lock finalizePaymentMethod takes. Without it a card finalized between
      // this select and the cascade below would vanish locally without ever being
      // queued for remote deletion.
      await tx`select pg_advisory_xact_lock(hashtext(${`${userId}:payment_methods`}))`;
      const methods = await tx<PaymentMethodRow[]>`
        select * from captain.payment_methods where user_id = ${userId}
      `;
      const now = new Date();
      for (const method of methods) {
        await enqueueCardDeletion(tx, method, now);
      }
      await tx`delete from captain.users where id = ${userId}`;
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
        notification_mode, digest_hour_local, price_rise_alerts_enabled,
        better_option_alerts_enabled, tracking_checkins_enabled,
        quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
        onboarding_step, onboarding_completed_at,
        created_at, updated_at
      )
      select ${userId}, ${DEFAULT_PROFILE.defaultCurrency}, ${DEFAULT_PROFILE.rankingMode},
        ${this.#sql.json([])}, ${this.#sql.json([])}, ${DEFAULT_PROFILE.alertsEnabled},
        ${DEFAULT_PROFILE.maxAlertsPerDay}, ${DEFAULT_PROFILE.notificationMode},
        ${DEFAULT_PROFILE.digestHourLocal}, ${DEFAULT_PROFILE.priceRiseAlertsEnabled},
        ${DEFAULT_PROFILE.betterOptionAlertsEnabled}, ${DEFAULT_PROFILE.trackingCheckinsEnabled},
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
          when ${input.alertsEnabled ?? null} = true and notification_mode = 'off' then 'smart'
          else notification_mode
        end,
        digest_hour_local = coalesce(${input.digestHourLocal ?? null}, digest_hour_local),
        price_rise_alerts_enabled = coalesce(
          ${input.priceRiseAlertsEnabled ?? null},
          price_rise_alerts_enabled
        ),
        better_option_alerts_enabled = coalesce(
          ${input.betterOptionAlertsEnabled ?? null},
          better_option_alerts_enabled
        ),
        tracking_checkins_enabled = coalesce(
          ${input.trackingCheckinsEnabled ?? null},
          tracking_checkins_enabled
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
    if (
      updatedProfile.notificationMode === "off"
      || !updatedProfile.trackingCheckinsEnabled
    ) {
      await this.#sql`
        update captain.watches watch set
          check_in_sent_at = null,
          auto_pause_at = null,
          updated_at = ${now}
        from captain.trips trip
        where watch.trip_id = trip.id and trip.user_id = ${userId}
      `;
      await this.#sql`
        update captain.notifications set
          status = 'superseded',
          error = 'Notification preference changed before delivery',
          updated_at = ${now}
        where user_id = ${userId}
          and status = 'pending'
          and (
            ${updatedProfile.notificationMode === "off"}
            or kind = 'tracking_checkin'
          )
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

  async markTravellerSetupPrompted(userId: string, now: Date): Promise<boolean> {
    await this.ensureProfile(userId, now);
    const rows = await this.#sql<Array<{ user_id: string }>>`
      update captain.traveller_profiles
      set traveller_setup_prompted_at = ${now}, updated_at = ${now}
      where user_id = ${userId} and traveller_setup_prompted_at is null
      returning user_id
    `;
    return rows.length === 1;
  }

  async listPassengers(userId: string): Promise<Passenger[]> {
    const rows = await this.#sql<PassengerRow[]>`
      select * from captain.passengers
      where user_id = ${userId}
      order by is_default desc, created_at asc
    `;
    return rows.map(mapPassenger);
  }

  async getPassenger(userId: string, passengerId: string): Promise<Passenger | null> {
    const rows = await this.#sql<PassengerRow[]>`
      select * from captain.passengers
      where user_id = ${userId} and id = ${passengerId}
    `;
    return rows[0] ? mapPassenger(rows[0]) : null;
  }

  async createPassenger(userId: string, input: CreatePassengerInput, now: Date): Promise<Passenger> {
    return this.#sql.begin(async (tx) => {
      const existing = await tx<Array<{ count: number }>>`
        select count(*)::int as count from captain.passengers where user_id = ${userId}
      `;
      const makeDefault = input.isDefault === true || (existing[0]?.count ?? 0) === 0;
      if (makeDefault) {
        await tx`
          update captain.passengers set is_default = false, updated_at = ${now}
          where user_id = ${userId} and is_default
        `;
      }
      const id = randomUUID();
      const rows = await tx<PassengerRow[]>`
        insert into captain.passengers (
          id, user_id, given_name, middle_name, family_name, title, gender, born_on,
          email, phone_number, nationality, country_of_residence,
          passport_number_encrypted, passport_last4, passport_issuing_country,
          passport_expires_on, is_default, created_at, updated_at
        ) values (
          ${id}, ${userId}, ${input.givenName}, ${input.middleName ?? null}, ${input.familyName},
          ${input.title ?? null}, ${input.gender ?? null}, ${input.bornOn ?? null},
          ${input.email ?? null}, ${input.phoneNumber ?? null},
          ${input.nationality ?? null}, ${input.countryOfResidence ?? null},
          case when ${input.passportNumber ?? null}::text is null then null
            else pgp_sym_encrypt(${input.passportNumber ?? null}, ${this.#piiEncryptionKey}, 'cipher-algo=aes256') end,
          ${input.passportNumber?.slice(-4) ?? null},
          ${input.passportIssuingCountry ?? null}, ${input.passportExpiresOn ?? null},
          ${makeDefault},
          ${now}, ${now}
        )
        returning *
      `;
      return mapPassenger(rows[0]!);
    });
  }

  async updatePassenger(
    userId: string,
    passengerId: string,
    input: UpdatePassengerInput,
    now: Date
  ): Promise<Passenger> {
    return this.#sql.begin(async (tx) => {
      if (input.isDefault === true) {
        await tx`
          update captain.passengers set is_default = false, updated_at = ${now}
          where user_id = ${userId} and is_default and id <> ${passengerId}
        `;
      }
      const rows = await tx<PassengerRow[]>`
        update captain.passengers set
          given_name = coalesce(${input.givenName ?? null}, given_name),
          middle_name = case
            when ${input.middleName !== undefined} then ${input.middleName ?? null}
            else middle_name
          end,
          family_name = coalesce(${input.familyName ?? null}, family_name),
          title = case when ${input.title !== undefined} then ${input.title ?? null} else title end,
          gender = case when ${input.gender !== undefined} then ${input.gender ?? null} else gender end,
          born_on = case when ${input.bornOn !== undefined} then ${input.bornOn ?? null} else born_on end,
          email = case when ${input.email !== undefined} then ${input.email ?? null} else email end,
          phone_number = case
            when ${input.phoneNumber !== undefined} then ${input.phoneNumber ?? null}
            else phone_number
          end,
          nationality = case
            when ${input.nationality !== undefined} then ${input.nationality ?? null}
            else nationality
          end,
          country_of_residence = case
            when ${input.countryOfResidence !== undefined} then ${input.countryOfResidence ?? null}
            else country_of_residence
          end,
          passport_number_encrypted = case
            when ${input.passportNumber !== undefined} then
              case when ${input.passportNumber ?? null}::text is null then null
                else pgp_sym_encrypt(${input.passportNumber ?? null}, ${this.#piiEncryptionKey}, 'cipher-algo=aes256') end
            else passport_number_encrypted
          end,
          passport_last4 = case
            when ${input.passportNumber !== undefined} then ${input.passportNumber?.slice(-4) ?? null}
            else passport_last4
          end,
          passport_issuing_country = case
            when ${input.passportIssuingCountry !== undefined} then ${input.passportIssuingCountry ?? null}
            else passport_issuing_country
          end,
          passport_expires_on = case
            when ${input.passportExpiresOn !== undefined} then ${input.passportExpiresOn ?? null}
            else passport_expires_on
          end,
          is_default = coalesce(${input.isDefault ?? null}, is_default),
          updated_at = ${now}
        where user_id = ${userId} and id = ${passengerId}
        returning *
      `;
      if (!rows[0]) throw new Error("Passenger not found");
      return mapPassenger(rows[0]);
    });
  }

  async deletePassenger(userId: string, passengerId: string): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx<Array<{ is_default: boolean }>>`
        delete from captain.passengers
        where user_id = ${userId} and id = ${passengerId}
        returning is_default
      `;
      if (rows[0]?.is_default) {
        await tx`
          update captain.passengers set is_default = true
          where id = (
            select id from captain.passengers
            where user_id = ${userId}
            order by created_at asc
            limit 1
          )
        `;
      }
    });
  }

  async setDefaultPassenger(userId: string, passengerId: string, now: Date): Promise<Passenger> {
    return this.updatePassenger(userId, passengerId, { isDefault: true }, now);
  }

  async listTripPassengers(userId: string, tripId: string): Promise<Passenger[]> {
    const rows = await this.#sql<PassengerRow[]>`
      select passenger.*
      from captain.trip_passengers assignment
      join captain.passengers passenger on passenger.id = assignment.passenger_id
      join captain.trips trip on trip.id = assignment.trip_id
      where trip.user_id = ${userId}
        and assignment.trip_id = ${tripId}
        and passenger.user_id = ${userId}
      order by assignment.ordinal asc
    `;
    return rows.map(mapPassenger);
  }

  async setTripPassengers(userId: string, tripId: string, passengerIds: string[]): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const trips = await tx<Array<{ id: string }>>`
        select id from captain.trips where user_id = ${userId} and id = ${tripId}
      `;
      if (!trips[0]) throw new TripNotFoundError();
      for (const passengerId of passengerIds) {
        const passengers = await tx<Array<{ id: string }>>`
          select id from captain.passengers
          where user_id = ${userId} and id = ${passengerId}
        `;
        if (!passengers[0]) throw new Error("Passenger not found");
      }
      await tx`delete from captain.trip_passengers where trip_id = ${tripId}`;
      for (const [ordinal, passengerId] of passengerIds.entries()) {
        await tx`
          insert into captain.trip_passengers (trip_id, passenger_id, ordinal)
          values (${tripId}, ${passengerId}, ${ordinal})
        `;
      }
    });
  }

  async listPaymentMethods(userId: string): Promise<PaymentMethod[]> {
    const rows = await this.#sql<PaymentMethodRow[]>`
      select * from captain.payment_methods
      where user_id = ${userId} and status = 'active'
      order by is_default desc, created_at asc
    `;
    return rows.map(mapPaymentMethod);
  }

  async setDefaultPaymentMethod(
    userId: string,
    paymentMethodId: string,
    now: Date
  ): Promise<PaymentMethod> {
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`${userId}:payment_methods`}))`;
      const target = await tx<PaymentMethodRow[]>`
        select * from captain.payment_methods
        where id = ${paymentMethodId} and user_id = ${userId} and status = 'active'
        for update
      `;
      if (!target[0]) throw new Error("Payment method not found");
      await tx`
        update captain.payment_methods
        set is_default = false, updated_at = ${now}
        where user_id = ${userId} and status = 'active' and is_default
      `;
      const rows = await tx<PaymentMethodRow[]>`
        update captain.payment_methods
        set is_default = true, updated_at = ${now}
        where id = ${paymentMethodId} and user_id = ${userId} and status = 'active'
        returning *
      `;
      return mapPaymentMethod(rows[0]!);
    });
  }

  async reservePaymentCardSetupIntent(
    userId: string,
    setupIntentId: string,
    now: Date
  ): Promise<PaymentCardSetupIntent> {
    const user = await this.getUser(userId);
    if (!user) throw new Error("User not found");
    await this.cleanupPaymentCardSetupIntents(now);
    return this.#reservePaymentCardSetupIntentWith(this.#sql, userId, setupIntentId, now);
  }

  async getPaymentCardSetupIntent(
    userId: string,
    setupIntentId: string
  ): Promise<PaymentCardSetupIntent | null> {
    const rows = await this.#sql<PaymentCardSetupIntentRow[]>`
      select * from captain.payment_card_setup_intents
      where id = ${setupIntentId} and user_id = ${userId}
    `;
    return rows[0] ? mapPaymentCardSetupIntent(rows[0]) : null;
  }

  async #reservePaymentCardSetupIntentWith(
    sql: Sql,
    userId: string,
    setupIntentId: string,
    now: Date
  ): Promise<PaymentCardSetupIntent> {
    return sql.begin((tx) => this.#reservePaymentCardSetupIntentInTransaction(
      tx,
      userId,
      setupIntentId,
      now
    ));
  }

  async #reservePaymentCardSetupIntentInTransaction(
    sql: Sql,
    userId: string,
    setupIntentId: string,
    now: Date
  ): Promise<PaymentCardSetupIntent> {
    await sql`select pg_advisory_xact_lock(hashtext(${`${userId}:payment_methods`}))`;
    const existingRows = await sql<PaymentCardSetupIntentRow[]>`
      select * from captain.payment_card_setup_intents
      where id = ${setupIntentId}
      for update
    `;
    const existing = existingRows[0];
    if (existing) {
      if (existing.user_id !== userId) throw new PaymentSetupConflictError("setup_intent_invalid");
      if (existing.status === "pending" && new Date(existing.expires_at).getTime() > now.getTime()) {
        return mapPaymentCardSetupIntent(existing);
      }
      if (existing.status === "completed") {
        throw new PaymentSetupConflictError("setup_intent_completed");
      }
      throw new PaymentSetupConflictError("setup_intent_invalid");
    }
    const pendingRows = await sql<Array<{ id: string }>>`
      select id from captain.payment_card_setup_intents
      where user_id = ${userId}
        and status = 'pending'
        and expires_at > ${now}
      limit 1
    `;
    if (pendingRows[0]) throw new PaymentSetupInProgressError();
    const counts = await sql<Array<{ count: number }>>`
      select count(*)::int as count from captain.payment_methods where user_id = ${userId}
    `;
    if ((counts[0]?.count ?? 0) >= MAX_PAYMENT_METHODS_PER_USER) {
      throw new PaymentMethodLimitError();
    }
    const expiresAt = new Date(now.getTime() + SETUP_INTENT_TTL_MS);
    const rows = await sql<PaymentCardSetupIntentRow[]>`
      insert into captain.payment_card_setup_intents (
        id, user_id, status, payment_method_id, component_client_key,
        client_key_issue_token, client_key_issue_expires_at,
        expires_at, completed_at, created_at, updated_at
      ) values (
        ${setupIntentId}, ${userId}, 'pending', null, null,
        null, null, ${expiresAt}, null, ${now}, ${now}
      )
      returning *
    `;
    return mapPaymentCardSetupIntent(rows[0]!);
  }

  async issuePaymentCardSetupClientKey(
    userId: string,
    setupIntentId: string,
    mint: () => Promise<string>,
    now: Date
  ): Promise<{ setupIntentId: string; clientKey: string }> {
    const existing = this.#clientKeyIssues.get(userId);
    if (existing) {
      if (existing.setupIntentId !== setupIntentId) {
        throw new PaymentSetupInProgressError();
      }
      return existing.work;
    }

    const work = this.#issuePaymentCardSetupClientKeyWithLease(
      userId,
      setupIntentId,
      mint,
      now
    );
    this.#clientKeyIssues.set(userId, { setupIntentId, work });
    try {
      return await work;
    } finally {
      const current = this.#clientKeyIssues.get(userId);
      if (current?.work === work) {
        this.#clientKeyIssues.delete(userId);
      }
    }
  }

  async #issuePaymentCardSetupClientKeyWithLease(
    userId: string,
    setupIntentId: string,
    mint: () => Promise<string>,
    now: Date
  ): Promise<{ setupIntentId: string; clientKey: string }> {
    const user = await this.getUser(userId);
    if (!user) throw new Error("User not found");
    await this.cleanupPaymentCardSetupIntents(now);

    const issueToken = randomUUID();
    let pollMs = CLIENT_KEY_ISSUE_POLL_INITIAL_MS;
    const deadline = Date.now() + CLIENT_KEY_ISSUE_DEADLINE_MS;
    while (true) {
      if (Date.now() >= deadline) throw new PaymentSetupInProgressError();
      const claim = await this.#sql.begin(async (tx) => {
        const reserved = await this.#reservePaymentCardSetupIntentInTransaction(
          tx,
          userId,
          setupIntentId,
          now
        );
        if (reserved.componentClientKey) {
          return {
            state: "ready" as const,
            result: { setupIntentId: reserved.id, clientKey: reserved.componentClientKey }
          };
        }
        const claimed = await tx<Array<{ id: string }>>`
          update captain.payment_card_setup_intents
          set client_key_issue_token = ${issueToken},
              client_key_issue_expires_at =
                clock_timestamp() + ${CLIENT_KEY_ISSUE_LEASE_MS} * interval '1 millisecond'
          where id = ${reserved.id}
            and user_id = ${userId}
            and status = 'pending'
            and component_client_key is null
            and (
              client_key_issue_token is null
              or client_key_issue_expires_at <= clock_timestamp()
              or client_key_issue_token = ${issueToken}
            )
          returning id
        `;
        return claimed[0]
          ? { state: "claimed" as const, setupIntentId: reserved.id }
          : { state: "waiting" as const };
      });

      if (claim.state === "ready") return claim.result;
      if (claim.state === "waiting") {
        await wait(pollMs);
        pollMs = Math.min(pollMs * 2, CLIENT_KEY_ISSUE_POLL_MAX_MS);
        continue;
      }

      let minted: string;
      try {
        minted = await mint();
      } catch (error) {
        try {
          await this.#releasePaymentCardClientKeyLease(claim.setupIntentId, userId, issueToken);
        } catch {
          // Preserve the provider error; the lease expiry is the crash-safe fallback.
        }
        throw error;
      }

      const persisted = await this.#sql.begin(async (tx) => {
        const updated = await tx<PaymentCardSetupIntentRow[]>`
          update captain.payment_card_setup_intents
          set component_client_key = ${minted},
              client_key_issue_token = null,
              client_key_issue_expires_at = null,
              updated_at = ${now}
          where id = ${claim.setupIntentId}
            and user_id = ${userId}
            and status = 'pending'
            and component_client_key is null
            and client_key_issue_token = ${issueToken}
          returning *
        `;
        if (updated[0]?.component_client_key) {
          return {
            setupIntentId: updated[0].id,
            clientKey: updated[0].component_client_key
          };
        }
        const rows = await tx<PaymentCardSetupIntentRow[]>`
          select * from captain.payment_card_setup_intents
          where id = ${claim.setupIntentId} and user_id = ${userId}
        `;
        const current = rows[0];
        if (!current || current.status !== "pending") {
          throw new PaymentSetupConflictError("setup_intent_invalid");
        }
        if (current.component_client_key) {
          return { setupIntentId: current.id, clientKey: current.component_client_key };
        }
        return null;
      });
      if (persisted) return persisted;
      pollMs = CLIENT_KEY_ISSUE_POLL_INITIAL_MS;
    }
  }

  async #releasePaymentCardClientKeyLease(
    setupIntentId: string,
    userId: string,
    issueToken: string
  ): Promise<void> {
    await this.#sql`
      update captain.payment_card_setup_intents
      set client_key_issue_token = null,
          client_key_issue_expires_at = null
      where id = ${setupIntentId}
        and user_id = ${userId}
        and status = 'pending'
        and component_client_key is null
        and client_key_issue_token = ${issueToken}
    `;
  }

  async finalizePaymentMethod(
    userId: string,
    input: SavePaymentMethodInput,
    now: Date
  ): Promise<PaymentMethod> {
    const user = await this.getUser(userId);
    if (!user) throw new Error("User not found");
    await this.cleanupPaymentCardSetupIntents(now);
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`${userId}:payment_methods`}))`;
      const intentRows = await tx<PaymentCardSetupIntentRow[]>`
        select * from captain.payment_card_setup_intents
        where id = ${input.setupIntentId}
        for update
      `;
      const intent = intentRows[0];
      if (!intent || intent.user_id !== userId) {
        throw new PaymentSetupConflictError("setup_intent_invalid");
      }
      if (intent.status === "completed") {
        if (!intent.payment_method_id) throw new PaymentSetupConflictError("setup_intent_invalid");
        const existingRows = await tx<PaymentMethodRow[]>`
          select * from captain.payment_methods
          where id = ${intent.payment_method_id} and user_id = ${userId}
        `;
        const existing = existingRows[0];
        if (!existing) throw new PaymentSetupConflictError("setup_intent_invalid");
        if (existing.provider_card_id !== input.cardId) {
          // Client-asserted card IDs are not safe to queue for remote deletion.
          throw new PaymentSetupConflictError("setup_intent_mismatch");
        }
        return mapPaymentMethod(existing);
      }
      if (intent.status !== "pending" || new Date(intent.expires_at).getTime() <= now.getTime()) {
        throw new PaymentSetupConflictError("setup_intent_invalid");
      }

      const pendingDeletion = await tx<Array<{ id: string }>>`
        select id from captain.payment_card_deletions
        where provider = 'duffel' and provider_card_id = ${input.cardId}
        limit 1
      `;
      if (pendingDeletion[0]) throw new PaymentSetupConflictError("card_pending_deletion");

      const removedExisting = await tx<Array<{ id: string }>>`
        select id from captain.payment_methods
        where user_id = ${userId}
          and provider_card_id = ${input.cardId}
          and status = 'removed'
        limit 1
      `;
      if (removedExisting[0]) throw new PaymentSetupConflictError("card_pending_deletion");

      // Card IDs are client-asserted and a Duffel token is global. Without this a
      // caller who guessed another user's token would end up sharing it, and the
      // first removal would delete the other user's card at Duffel.
      const claimedElsewhere = await tx<Array<{ id: string }>>`
        select id from captain.payment_methods
        where provider = 'duffel'
          and provider_card_id = ${input.cardId}
          and user_id <> ${userId}
          and status = 'active'
        limit 1
      `;
      if (claimedElsewhere[0]) throw new PaymentSetupConflictError("card_unavailable");

      // Any row for this card is necessarily active: the removed case threw above.
      const existingForCard = await tx<PaymentMethodRow[]>`
        select * from captain.payment_methods
        where user_id = ${userId} and provider_card_id = ${input.cardId}
        for update
      `;
      let methodRow: PaymentMethodRow;
      if (existingForCard[0]) {
        const updated = await tx<PaymentMethodRow[]>`
          update captain.payment_methods set
            brand = ${input.brand},
            last4 = ${input.last4},
            cardholder_name = ${input.cardholderName},
            status = 'active',
            updated_at = ${now}
          where id = ${existingForCard[0].id}
          returning *
        `;
        methodRow = updated[0]!;
      } else {
        const counts = await tx<Array<{ count: number }>>`
          select count(*)::int as count from captain.payment_methods where user_id = ${userId}
        `;
        if ((counts[0]?.count ?? 0) >= MAX_PAYMENT_METHODS_PER_USER) {
          throw new PaymentMethodLimitError();
        }
        const inserted = await tx<PaymentMethodRow[]>`
          insert into captain.payment_methods (
            id, user_id, provider, provider_card_id, brand, last4,
            cardholder_name, status, is_default, created_at, updated_at
          ) values (
            ${randomUUID()}, ${userId}, 'duffel', ${input.cardId}, ${input.brand},
            ${input.last4}, ${input.cardholderName}, 'active',
            not exists (
              select 1 from captain.payment_methods
              where user_id = ${userId} and status = 'active' and is_default
            ),
            ${now}, ${now}
          )
          returning *
        `;
        methodRow = inserted[0]!;
      }

      await tx`
        update captain.payment_card_setup_intents set
          status = 'completed',
          payment_method_id = ${methodRow.id},
          component_client_key = null,
          client_key_issue_token = null,
          client_key_issue_expires_at = null,
          completed_at = ${now},
          updated_at = ${now}
        where id = ${intent.id}
      `;
      return mapPaymentMethod(methodRow);
    });
  }

  async removePaymentMethod(userId: string, paymentMethodId: string, now: Date): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`${userId}:payment_methods`}))`;
      const rows = await tx<PaymentMethodRow[]>`
        update captain.payment_methods
        set status = 'removed', is_default = false, updated_at = ${now}
        where user_id = ${userId} and id = ${paymentMethodId} and status = 'active'
        returning *
      `;
      const method = rows[0];
      if (!method) return;
      await enqueueCardDeletion(tx, method, now);
      if (method.is_default) {
        await tx`
          update captain.payment_methods set is_default = true, updated_at = ${now}
          where id = (
            select id from captain.payment_methods
            where user_id = ${userId} and status = 'active'
            order by created_at asc
            limit 1
          )
        `;
      }
    });
  }

  async claimCardDeletions(
    workerId: string,
    now: Date,
    leaseMs: number,
    limit: number
  ): Promise<PaymentCardDeletion[]> {
    if (limit <= 0) return [];
    const rows = await this.#sql.begin(async (tx) => {
      return tx<PaymentCardDeletionRow[]>`
        with candidates as (
          select id from captain.payment_card_deletions
          where available_at <= ${now}
            and (
              status = 'queued'
              or (
                status = 'running'
                and (lease_expires_at is null or lease_expires_at <= ${now})
              )
            )
          order by created_at asc
          limit ${limit}
          for update skip locked
        ), claimed as (
          update captain.payment_card_deletions deletion set
            status = 'running',
            attempts = deletion.attempts + 1,
            claimed_by = ${workerId},
            lease_expires_at = ${new Date(now.getTime() + leaseMs)},
            updated_at = ${now}
          from candidates
          where deletion.id = candidates.id
          returning deletion.*
        )
        select * from claimed
        order by created_at asc
      `;
    });
    return rows.map(mapPaymentCardDeletion);
  }

  async completeCardDeletion(workerId: string, deletionId: string): Promise<boolean> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<PaymentCardDeletionRow[]>`
        select * from captain.payment_card_deletions
        where id = ${deletionId} and status = 'running' and claimed_by = ${workerId}
        for update
      `;
      const deletion = rows[0];
      if (!deletion) return false;
      await releaseDeletedCardRow(tx, deletion);
      await tx`delete from captain.payment_card_deletions where id = ${deletionId}`;
      return true;
    });
  }

  async failCardDeletion(
    workerId: string,
    deletionId: string,
    errorCode: string,
    errorDetail: string | null,
    retryAfterMs: number | null,
    now: Date
  ): Promise<boolean> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<PaymentCardDeletionRow[]>`
        select * from captain.payment_card_deletions
        where id = ${deletionId} and status = 'running' and claimed_by = ${workerId}
        for update
      `;
      const deletion = rows[0];
      if (!deletion) return false;
      if (deletion.attempts >= MAX_CARD_DELETION_ATTEMPTS) {
        // Give up remotely, but free the local row so a card Duffel refuses to
        // delete cannot consume the user's cap forever. The token survives here
        // for manual reconciliation.
        await releaseDeletedCardRow(tx, deletion);
        await tx`
          update captain.payment_card_deletions set
            status = 'failed',
            claimed_by = null,
            lease_expires_at = null,
            last_error_code = ${errorCode.slice(0, 100)},
            last_error_detail = ${truncateErrorDetail(errorDetail)},
            updated_at = ${now}
          where id = ${deletionId}
        `;
        return true;
      }
      const delay = retryAfterMs !== null && retryAfterMs > 0
        ? Math.min(retryAfterMs, 24 * 60 * 60_000)
        : cardDeletionBackoffMs(deletion.attempts);
      await tx`
        update captain.payment_card_deletions set
          status = 'queued',
          available_at = ${new Date(now.getTime() + delay)},
          claimed_by = null,
          lease_expires_at = null,
          last_error_code = ${errorCode.slice(0, 100)},
          last_error_detail = ${truncateErrorDetail(errorDetail)},
          updated_at = ${now}
        where id = ${deletionId}
      `;
      return true;
    });
  }

  async countPendingCardDeletions(): Promise<{
    queued: number;
    running: number;
    failed: number;
    highAttempts: number;
    oldestQueuedAgeMs: number | null;
  }> {
    const rows = await this.#sql<Array<{
      queued: number;
      running: number;
      failed: number;
      high_attempts: number;
      oldest_created_at: Date | null;
    }>>`
      select
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'failed')::int as failed,
        count(*) filter (where attempts >= 5 and status <> 'failed')::int as high_attempts,
        min(created_at) filter (where status = 'queued') as oldest_created_at
      from captain.payment_card_deletions
    `;
    const row = rows[0];
    const oldest = row?.oldest_created_at ?? null;
    return {
      queued: row?.queued ?? 0,
      running: row?.running ?? 0,
      failed: row?.failed ?? 0,
      highAttempts: row?.high_attempts ?? 0,
      oldestQueuedAgeMs: oldest ? Date.now() - new Date(oldest).getTime() : null
    };
  }

  async cleanupPaymentCardSetupIntents(now: Date): Promise<number> {
    return this.#sql.begin(async (tx) => {
      await tx`
        update captain.payment_card_setup_intents
        set status = 'expired',
            client_key_issue_token = null,
            client_key_issue_expires_at = null,
            updated_at = ${now}
        where status = 'pending' and expires_at <= ${now}
      `;
      const deleted = await tx<Array<{ id: string }>>`
        delete from captain.payment_card_setup_intents
        where status = 'expired'
           or (
             status = 'completed'
             and completed_at is not null
             and completed_at <= ${new Date(now.getTime() - SETUP_INTENT_COMPLETED_RETENTION_MS)}
           )
        returning id
      `;
      return deleted.length;
    });
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

  async getWatch(userId: string, tripId: string): Promise<Watch | null> {
    const rows = await this.#sql<WatchRow[]>`
      select watch.* from captain.watches watch
      join captain.trips trip on trip.id = watch.trip_id
      where trip.id = ${tripId} and trip.user_id = ${userId}
    `;
    return rows[0] ? toWatch(rows[0]) : null;
  }

  async createTrip(userId: string, input: CreateTripInput, specs: SearchSpec[], now: Date): Promise<TripCreationResult> {
    const created = await this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${userId}))`;
      return createTripInTransaction(tx, userId, input, specs, now);
    });
    for (const specId of new Set(specs.map((spec) => spec.id))) {
      await this.evaluateTripsForSearchSpec(specId, now);
      const recommendation = await this.getRecommendation(userId, created.trip.id);
      if (recommendation) await this.finalizeFarFutureBaseline(specId, now);
    }
    return {
      ...created,
      trip: await this.getTrip(userId, created.trip.id) ?? created.trip,
      watch: await this.getWatch(userId, created.trip.id) ?? created.watch
    };
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
      const updated = await tx<TripRow[]>`
        update captain.trips set
          brief = ${tx.json(json(input.brief))},
          status = 'tracking',
          version = version + 1,
          updated_at = ${now}
        where id = ${tripId}
        returning *
      `;
      const startsAt = trackingStartsAt(input.brief.departureWindow.start);
      const futureTracking = startsAt.getTime() > now.getTime();
      const watches = await tx<Array<{ id: string }>>`
        update captain.watches set
          status = 'active',
          next_check_at = ${now},
          tracking_starts_at = ${futureTracking ? startsAt : null},
          baseline_completed_at = null,
          activated_at = ${futureTracking ? null : now},
          last_user_activity_at = ${now},
          check_in_sent_at = null,
          auto_pause_at = null,
          price_rise_itinerary_key = null,
          price_rise_armed = true,
          delayed_at = null,
          delay_reason = null,
          updated_at = ${now}
        where trip_id = ${tripId}
        returning id
      `;
      if (!watches[0]) throw new Error("Trip Watch not found");
      await syncSpecs(tx, watches[0].id, specs, now);
      await tx`delete from captain.trip_recommendations where trip_id = ${tripId}`;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (
          ${randomUUID()}, ${tripId}, ${userId}, 'trip_brief_updated',
          ${tx.json(json(input.brief))}, ${now}
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
        return trips[0] && watches[0]
          ? {
              draft: current,
              result: { trip: toTrip(trips[0]), watch: toWatch(watches[0]), created: false }
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
    for (const specId of new Set(specs.map((spec) => spec.id))) {
      await this.evaluateTripsForSearchSpec(specId, now);
      const recommendation = await this.getRecommendation(userId, confirmed.result.trip.id);
      if (recommendation) await this.finalizeFarFutureBaseline(specId, now);
    }
    return {
      draft: confirmed.draft,
      result: {
        ...confirmed.result,
        trip: await this.getTrip(userId, confirmed.result.trip.id) ?? confirmed.result.trip,
        watch: await this.getWatch(userId, confirmed.result.trip.id) ?? confirmed.result.watch
      }
    };
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
      const watches = await tx<WatchRow[]>`
        select * from captain.watches where trip_id = ${tripId} for update
      `;
      const currentWatch = watches[0];
      const futureScheduled = Boolean(
        currentWatch?.tracking_starts_at
        && currentWatch.tracking_starts_at.getTime() > now.getTime()
        && currentWatch.baseline_completed_at
      );
      const watchStatus = status === "paused"
        ? "paused"
        : ["cancelled", "completed"].includes(status)
          ? "completed"
          : action.type === "resume" && futureScheduled
            ? "scheduled"
            : "active";
      await tx`
        update captain.watches set status = ${watchStatus},
          next_check_at = case
            when ${action.type} = 'refresh' then ${now}
            when ${action.type} = 'resume' and ${futureScheduled}
              then tracking_starts_at
            when ${action.type} = 'resume' then ${now}
            else next_check_at
          end,
          last_manual_refresh_at = case when ${action.type} = 'refresh' then ${now} else last_manual_refresh_at end,
          last_user_activity_at = ${now},
          check_in_sent_at = null,
          auto_pause_at = null,
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

  async listTripActivity(userId: string, tripId: string): Promise<TripActivity[]> {
    const rows = await this.#sql<Array<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>>`
      select event.id, event.event_type, event.payload, event.created_at
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
      createdAt: iso(row.created_at)
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
          check_in_sent_at = null,
          auto_pause_at = null,
          updated_at = ${now}
        where trip_id = ${tripId}
      `;
    });
  }

  async markTripActivity(userId: string, tripId: string, now: Date): Promise<void> {
    const rows = await this.#sql<Array<{ id: string }>>`
      update captain.watches watch set
        last_user_activity_at = ${now},
        check_in_sent_at = null,
        auto_pause_at = null,
        updated_at = ${now}
      from captain.trips trip
      where watch.trip_id = trip.id
        and trip.id = ${tripId}
        and trip.user_id = ${userId}
      returning watch.id
    `;
    if (!rows[0]) throw new TripNotFoundError();
    await this.#sql`
      update captain.notifications set
        status = 'superseded',
        error = 'Traveller activity reset the check-in timer',
        updated_at = ${now}
      where trip_id = ${tripId}
        and kind = 'tracking_checkin'
        and status = 'pending'
    `;
  }

  async respondToTrackingCheckIn(
    userId: string,
    tripId: string,
    action: "keep" | "pause",
    now: Date
  ): Promise<Trip> {
    return this.#sql.begin(async (tx) => {
      const trips = await tx<TripRow[]>`
        select * from captain.trips
        where id = ${tripId} and user_id = ${userId}
        for update
      `;
      const trip = trips[0];
      if (!trip) throw new TripNotFoundError();
      const watches = await tx<WatchRow[]>`
        select * from captain.watches where trip_id = ${tripId} for update
      `;
      const watch = watches[0];
      if (!watch) throw new Error("Trip Watch not found");
      const futureScheduled = Boolean(
        watch.tracking_starts_at
        && watch.tracking_starts_at.getTime() > now.getTime()
        && watch.baseline_completed_at
      );
      const hasRecommendation = await tx<Array<{ exists: boolean }>>`
        select exists(
          select 1 from captain.trip_recommendations where trip_id = ${tripId}
        ) as exists
      `;
      const tripStatus: TripStatus = action === "pause"
        ? "paused"
        : hasRecommendation[0]?.exists ? "recommended" : "tracking";
      const updated = await tx<TripRow[]>`
        update captain.trips set
          status = ${tripStatus},
          version = version + 1,
          updated_at = ${now}
        where id = ${tripId}
        returning *
      `;
      await tx`
        update captain.watches set
          status = ${action === "pause" ? "paused" : futureScheduled ? "scheduled" : "active"},
          next_check_at = case
            when ${action === "pause"} then next_check_at
            when ${futureScheduled} then tracking_starts_at
            else ${now}
          end,
          last_user_activity_at = ${now},
          check_in_sent_at = null,
          auto_pause_at = null,
          updated_at = ${now}
        where trip_id = ${tripId}
      `;
      await tx`
        insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
        values (
          ${randomUUID()}, ${tripId}, ${userId},
          ${action === "pause" ? "tracking_checkin_paused" : "tracking_checkin_kept"},
          '{}'::jsonb, ${now}
        )
      `;
      return toTrip(updated[0]!);
    });
  }

  async hasDueWorkerWork(now: Date): Promise<boolean> {
    const checkInBefore = new Date(now.getTime() - INACTIVITY_CHECKIN_MS);
    const rows = await this.#sql<Array<{ due: boolean }>>`
      select (
        exists (
          select 1
          from captain.watches watch
          join captain.trips trip on trip.id = watch.trip_id
          left join captain.traveller_profiles profile on profile.user_id = trip.user_id
          where trip.status not in ('cancelled', 'completed', 'archived')
            and (
              (
                watch.status = 'active'
                and watch.next_check_at is not null
                and watch.next_check_at <= ${now}
              )
              or (
                watch.status = 'scheduled'
                and watch.tracking_starts_at is not null
                and watch.tracking_starts_at <= ${now}
              )
              or (
                watch.status = 'active'
                and watch.auto_pause_at is not null
                and watch.auto_pause_at <= ${now}
              )
              or (
                watch.status = 'active'
                and profile.notification_mode <> 'off'
                and profile.tracking_checkins_enabled
                and watch.check_in_sent_at is null
                and watch.last_user_activity_at <= ${checkInBefore}
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
        or exists (
          select 1
          from captain.traveller_profiles profile
          join captain.users users on users.id = profile.user_id
          where profile.notification_mode in ('smart', 'daily')
            and extract(hour from timezone(users.timezone, ${now}::timestamptz))
              >= profile.digest_hour_local
            and (
              profile.last_digest_at is null
              or timezone(users.timezone, profile.last_digest_at)::date
                < timezone(users.timezone, ${now}::timestamptz)::date
            )
            and exists (
              select 1
              from captain.trips trip
              join captain.watches watch on watch.trip_id = trip.id
              join captain.trip_recommendations recommendation
                on recommendation.trip_id = trip.id
              where trip.user_id = profile.user_id
                and trip.status not in ('paused', 'cancelled', 'completed', 'archived')
                and watch.status = 'active'
            )
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
      departure_date: string | null;
      watch_status: Watch["status"];
      tracking_starts_at: Date | null;
      last_user_activity_at: Date;
      check_in_sent_at: Date | null;
      auto_pause_at: Date | null;
      notification_mode: TravellerProfile["notificationMode"];
      tracking_checkins_enabled: boolean;
    }>>`
      select watch.id as watch_id, trip.id as trip_id, trip.user_id, trip.title,
        trip.brief #>> '{departureWindow,start}' as departure_date,
        watch.status as watch_status, watch.tracking_starts_at,
        watch.last_user_activity_at, watch.check_in_sent_at, watch.auto_pause_at,
        profile.notification_mode, profile.tracking_checkins_enabled
      from captain.watches watch
      join captain.trips trip on trip.id = watch.trip_id
      join captain.traveller_profiles profile on profile.user_id = trip.user_id
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
            and watch.auto_pause_at is not null
            and watch.auto_pause_at <= ${now}
          )
          or (
            watch.status = 'active'
            and profile.notification_mode <> 'off'
            and profile.tracking_checkins_enabled
            and watch.check_in_sent_at is null
            and watch.last_user_activity_at
              <= ${new Date(now.getTime() - INACTIVITY_CHECKIN_MS)}
          )
        )
    `;
    let activated = 0;
    let checkInsQueued = 0;
    let autoPaused = 0;
    for (const row of rows) {
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
            check_in_sent_at = null,
            auto_pause_at = null,
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
              trackingStartsAt: row.tracking_starts_at.toISOString()
            },
            now
          });
        }
        if (["smart", "daily"].includes(row.notification_mode)) {
          await this.#sql`
            update captain.traveller_profiles
            set last_digest_at = ${now}, updated_at = ${now}
            where user_id = ${row.user_id}
          `;
        }
        activated += 1;
        continue;
      }
      if (row.watch_status !== "active") continue;
      if (row.auto_pause_at && row.auto_pause_at.getTime() <= now.getTime()) {
        const paused = await this.#sql.begin(async (tx) => {
          const watches = await tx<Array<{ id: string }>>`
            update captain.watches set
              status = 'paused',
              check_in_sent_at = null,
              auto_pause_at = null,
              updated_at = ${now}
            where id = ${row.watch_id}
              and status = 'active'
              and auto_pause_at <= ${now}
            returning id
          `;
          if (!watches[0]) return false;
          await tx`
            update captain.trips set
              status = 'paused',
              version = version + 1,
              updated_at = ${now}
            where id = ${row.trip_id}
          `;
          return true;
        });
        if (!paused) continue;
        if (row.notification_mode !== "off") {
          await enqueueNotification(this.#sql, {
            userId: row.user_id,
            tripId: row.trip_id,
            kind: "tracking_paused",
            dedupKey: `${row.trip_id}:tracking_paused:${row.auto_pause_at.toISOString()}`,
            payload: { tripTitle: row.title },
            now
          });
        }
        autoPaused += 1;
        continue;
      }
      if (
        row.notification_mode !== "off"
        && row.tracking_checkins_enabled
        && !row.check_in_sent_at
        && row.last_user_activity_at.getTime() <= now.getTime() - INACTIVITY_CHECKIN_MS
      ) {
        const deliveryAt = await userDeliveryTime(this.#sql, row.user_id, now);
        const updated = await this.#sql<Array<{ id: string }>>`
          update captain.watches set
            check_in_sent_at = ${now},
            auto_pause_at = ${new Date(deliveryAt.getTime() + INACTIVITY_AUTO_PAUSE_MS)},
            updated_at = ${now}
          where id = ${row.watch_id}
            and status = 'active'
            and check_in_sent_at is null
            and last_user_activity_at <= ${new Date(now.getTime() - INACTIVITY_CHECKIN_MS)}
          returning id
        `;
        if (!updated[0]) continue;
        const queued = await enqueueNotification(this.#sql, {
          userId: row.user_id,
          tripId: row.trip_id,
          kind: "tracking_checkin",
          dedupKey: `${row.trip_id}:tracking_checkin:${now.toISOString().slice(0, 10)}`,
          payload: {
            tripTitle: row.title,
            departureDate: row.departure_date
          },
          now
        });
        if (queued) checkInsQueued += 1;
      }
    }
    return { activated, checkInsQueued, autoPaused };
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

  async enqueueDueDigests(now: Date): Promise<number> {
    const profiles = await this.#sql<Array<ProfileRow & { timezone: string }>>`
      select profile.*, users.timezone
      from captain.traveller_profiles profile
      join captain.users users on users.id = profile.user_id
      where profile.notification_mode in ('smart', 'daily')
        and extract(hour from timezone(users.timezone, ${now}::timestamptz))
          >= profile.digest_hour_local
        and (
          profile.last_digest_at is null
          or timezone(users.timezone, profile.last_digest_at)::date
            < timezone(users.timezone, ${now}::timestamptz)::date
        )
        and exists (
          select 1
          from captain.trips trip
          join captain.watches watch on watch.trip_id = trip.id
          join captain.trip_recommendations recommendation
            on recommendation.trip_id = trip.id
          where trip.user_id = profile.user_id
            and trip.status not in ('paused', 'cancelled', 'completed', 'archived')
            and watch.status = 'active'
        )
    `;
    let queued = 0;
    for (const profile of profiles) {
      if (!digestDue(now, profile.timezone, profile.digest_hour_local, profile.last_digest_at)) {
        continue;
      }
      const trips = await this.#sql<Array<{
        id: string;
        title: string;
        recommendation: TripRecommendation["snapshot"];
        price: string | number;
        currency: string;
        summary: string;
        price_rise_itinerary_key: string | null;
      }>>`
        select trip.id, trip.title, recommendation.snapshot as recommendation,
          recommendation.price, recommendation.currency, recommendation.summary,
          watch.price_rise_itinerary_key
        from captain.trips trip
        join captain.watches watch on watch.trip_id = trip.id
        join captain.trip_recommendations recommendation on recommendation.trip_id = trip.id
        where trip.user_id = ${profile.user_id}
          and trip.status not in ('paused', 'cancelled', 'completed', 'archived')
          and watch.status = 'active'
        order by trip.updated_at desc
        limit ${DIGEST_TRIP_LIMIT}
      `;
      if (trips.length === 0) continue;
      const recent = await this.#sql<Array<{ exists: boolean }>>`
        select exists(
          select 1 from captain.notifications
          where user_id = ${profile.user_id}
            and kind in ('price_rise', 'price_drop', 'new_best')
            and status in ('pending', 'sending', 'sent')
            and created_at >= ${new Date(now.getTime() - 3 * 3_600_000)}
        ) as exists
      `;
      if (recent[0]?.exists) {
        await this.#sql`
          update captain.trip_recommendations recommendation set
            snapshot = recommendation.snapshot - 'pendingDigestChange',
            updated_at = ${now}
          from captain.trips trip
          where recommendation.trip_id = trip.id
            and trip.user_id = ${profile.user_id}
        `;
        await this.#sql`
          update captain.traveller_profiles
          set last_digest_at = ${now}, updated_at = ${now}
          where user_id = ${profile.user_id}
        `;
        continue;
      }
      const primary = trips[0]!;
      const digestTrips = [];
      for (const trip of trips) {
        let priceRise: { increase: number; percent: number } | null = null;
        const itineraryKey = trip.price_rise_itinerary_key;
        if (itineraryKey) {
          const prices = await this.#sql<Array<{
            current_price: string | number;
            low_price: string | number;
          }>>`
            select
              (array_agg(price order by observed_at desc))[1] as current_price,
              min(price) as low_price
            from captain.price_observations
            where itinerary_key = ${itineraryKey}
              and currency = ${trip.currency}
              and observed_at >= ${new Date(now.getTime() - 7 * 86_400_000)}
            having count(*) > 0
          `;
          const current = Number(prices[0]?.current_price);
          const low = Number(prices[0]?.low_price);
          const increase = current - low;
          const percent = low > 0 ? increase / low * 100 : 0;
          if (increase >= 20 && percent >= 5) priceRise = { increase, percent };
        }
        digestTrips.push({
          tripId: trip.id,
          tripTitle: trip.title,
          price: Number(trip.price),
          currency: trip.currency,
          summary: trip.summary,
          snapshot: trip.recommendation,
          priceRise
        });
      }
      const inserted = await enqueueNotification(this.#sql, {
        userId: profile.user_id,
        tripId: primary.id,
        kind: "daily_digest",
        dedupKey: `${profile.user_id}:daily_digest:${localDateKey(now, profile.timezone)}`,
        payload: { trips: digestTrips },
        now
      });
      if (inserted) queued += 1;
      await this.#sql`
        update captain.trip_recommendations recommendation set
          snapshot = recommendation.snapshot - 'pendingDigestChange',
          updated_at = ${now}
        from captain.trips trip
        where recommendation.trip_id = trip.id
          and trip.user_id = ${profile.user_id}
      `;
      await this.#sql`
        update captain.traveller_profiles
        set last_digest_at = ${now}, updated_at = ${now}
        where user_id = ${profile.user_id}
      `;
    }
    return queued;
  }

  async scheduleDueSearchRuns(now: Date, freshnessMs: number, limit: number): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const watches = await tx<Array<{
        id: string;
        trip_id: string;
        cadence_hours: number;
        brief: Trip["brief"];
      }>>`
        select watch.id, watch.trip_id, watch.cadence_hours, trip.brief
        from captain.watches watch
        join captain.trips trip on trip.id = watch.trip_id
        where watch.status = 'active' and watch.next_check_at <= ${now}
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
          update captain.watches set next_check_at = ${new Date(now.getTime() + adaptiveWatchIntervalMs(
            watch.cadence_hours,
            watch.brief.departureWindow.start,
            now
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
          delayed_at = null, delay_reason = null, updated_at = ${now}
        from captain.watch_search_specs link
        where link.watch_id = watch.id and link.search_spec_id = ${run.search_spec_id}
      `;
    });
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
      const pendingDigestChange = ["smart", "daily"].includes(profile.notificationMode)
        ? previous && qualifies
          ? {
              current: best.offer,
              previous: previous.snapshot.current,
              rankingMode: profile.rankingMode,
              reasonCodes,
              createdAt: now.toISOString()
            }
          : previous?.snapshot.pendingDigestChange ?? null
        : null;
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
          createdAt: now.toISOString(),
          pendingDigestChange
        }
      };
      const farBaseline = Boolean(
        watch?.trackingStartsAt
        && Date.parse(watch.trackingStartsAt) > now.getTime()
        && !watch.baselineCompletedAt
      );
      const finalWeek = daysUntilDeparture(trip.brief.departureWindow.start, now) <= 7;
      const immediateInitial = farBaseline || profile.notificationMode === "changes_only";
      const immediateImprovement = profile.betterOptionAlertsEnabled && (
        profile.notificationMode === "changes_only"
        || (profile.notificationMode === "smart" && finalWeek)
      );
      const kind = profile.notificationMode === "off"
        ? null
        : !previous
          ? immediateInitial ? "initial_results" : null
          : qualifies && immediateImprovement && profile.rankingMode === "cheapest"
            ? "price_drop"
            : qualifies && immediateImprovement
              ? "new_best"
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
                    tripTitle: trip.title,
                    ...recommendation,
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
    const finalWeek = daysUntilDeparture(trip.brief.departureWindow.start, now) <= 7;
    const immediate = profile.priceRiseAlertsEnabled && (
      profile.notificationMode === "changes_only"
      || (profile.notificationMode === "smart" && finalWeek)
    );
    let queued = false;
    if (thresholdReached && armed && immediate) {
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
            tripTitle: trip.title,
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
          and kind in ('inventory_gap', 'watch_attention')
      `;
      await tx`
        with ranked as (
          select id,
            row_number() over (
              partition by trip_id
              order by created_at desc, id desc
            ) as position
          from captain.notifications
          where status = 'pending'
            and kind in ('initial_results', 'price_drop', 'new_best')
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

  async markNotificationSent(notificationId: string, telegramMessageId: number, now: Date): Promise<void> {
    await this.#sql`
      update captain.notifications set status = 'sent', delivered_at = ${now},
        telegram_message_id = ${telegramMessageId}, error = null, updated_at = ${now}
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
    void searchSpecId;
    void now;
    return 0;
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
    if (!watches[0]) throw new Error("Trip Watch not found");
    await sql`
      update captain.conversations set active_trip_id = ${duplicates[0].id}, updated_at = ${now}
      where user_id = ${userId}
    `;
    return { trip: toTrip(duplicates[0]), watch: toWatch(watches[0]), created: false };
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
  const watchId = randomUUID();
  const startsAt = trackingStartsAt(input.brief.departureWindow.start);
  const futureTracking = startsAt.getTime() > now.getTime();
  await sql`
    insert into captain.trips (
      id, user_id, title, status, version, brief, created_at, updated_at
    ) values (
      ${tripId}, ${userId}, ${input.title}, 'tracking', 1,
      ${sql.json(json(input.brief))}, ${now}, ${now}
    )
  `;
  await sql`
    insert into captain.watches (
      id, trip_id, status, cadence_hours, next_check_at,
      tracking_starts_at, activated_at, last_user_activity_at,
      created_at, updated_at
    ) values (
      ${watchId}, ${tripId}, 'active', ${input.cadenceHours}, ${now},
      ${futureTracking ? startsAt : null}, ${futureTracking ? null : now}, ${now},
      ${now}, ${now}
    )
  `;
  await syncSpecs(sql, watchId, specs, now);
  await sql`
    insert into captain.trip_events (id, trip_id, user_id, event_type, payload, created_at)
    values (${randomUUID()}, ${tripId}, ${userId}, 'trip_created', ${sql.json(json(input))}, ${now})
  `;
  await sql`
    update captain.conversations set active_trip_id = ${tripId}, updated_at = ${now}
    where user_id = ${userId}
  `;
  return {
    trip: {
      id: tripId,
      userId,
      title: input.title,
      status: "tracking",
      version: 1,
      brief: input.brief,
      archivedAt: null,
      archiveReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    },
    watch: {
      id: watchId,
      tripId,
      status: "active",
      cadenceHours: input.cadenceHours,
      nextCheckAt: now.toISOString(),
      lastCheckAt: null,
      lastManualRefreshAt: null,
      trackingStartsAt: futureTracking ? startsAt.toISOString() : null,
      baselineCompletedAt: null,
      activatedAt: futureTracking ? null : now.toISOString(),
      lastUserActivityAt: now.toISOString(),
      checkInSentAt: null,
      autoPauseAt: null,
      priceRiseItineraryKey: null,
      priceRiseArmed: true,
      delayedAt: null,
      delayReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    },
    created: true
  };
}

async function expireTripPlanDrafts(sql: Sql, userId: string, now: Date): Promise<void> {
  await sql`
    update captain.trip_plan_drafts set status = 'expired', updated_at = ${now}
    where user_id = ${userId}
      and status in ('collecting', 'awaiting_confirmation', 'starting')
      and expires_at <= ${now}
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
  if (!recipients[0]?.exists || recipients[0].notification_mode === "off") return false;
  const availableAt = await userDeliveryTime(sql, input.userId, input.now);
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
  return rows.length === 1;
}

function digestDue(
  now: Date,
  timezone: string,
  digestHourLocal: number,
  lastDigestAt: Date | string | undefined | null
): boolean {
  try {
    const parts = localParts(now, timezone);
    if (parts.hour < digestHourLocal) return false;
    return !lastDigestAt || localDateKey(new Date(lastDigestAt), timezone) !== parts.date;
  } catch {
    return now.getUTCHours() >= digestHourLocal
      && (!lastDigestAt
        || new Date(lastDigestAt).toISOString().slice(0, 10) !== now.toISOString().slice(0, 10));
  }
}

function localDateKey(now: Date, timezone: string): string {
  return localParts(now, timezone).date;
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
  if (action === "resume" || action === "refresh") return "tracking";
  if (action === "cancel") return "cancelled";
  if (action === "complete") return "completed";
  return current;
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
  id: string; trip_id: string; status: Watch["status"]; cadence_hours: number;
  next_check_at: Date | null; last_check_at: Date | null;
  last_manual_refresh_at: Date | null;
  tracking_starts_at: Date | null; baseline_completed_at: Date | null;
  activated_at: Date | null; last_user_activity_at: Date;
  check_in_sent_at: Date | null; auto_pause_at: Date | null;
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
type ProfileRow = {
  user_id: string;
  default_currency: string;
  ranking_mode: TravellerProfile["rankingMode"];
  preferred_airline_codes: string[];
  excluded_airline_codes: string[];
  alerts_enabled: boolean;
  notification_mode: TravellerProfile["notificationMode"];
  digest_hour_local: number;
  price_rise_alerts_enabled: boolean;
  better_option_alerts_enabled: boolean;
  tracking_checkins_enabled: boolean;
  last_digest_at: Date | null;
  max_alerts_per_day: number;
  quiet_hours_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  onboarding_completed_at: Date | null;
  onboarding_step: TravellerProfile["onboardingStep"];
  traveller_setup_prompted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type PassengerRow = {
  id: string;
  user_id: string;
  given_name: string;
  middle_name: string | null;
  family_name: string;
  title: Passenger["title"];
  gender: Passenger["gender"];
  born_on: string | Date | null;
  email: string | null;
  phone_number: string | null;
  nationality: string | null;
  country_of_residence: string | null;
  passport_last4: string | null;
  passport_issuing_country: string | null;
  passport_expires_on: string | Date | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
};

type PaymentMethodRow = {
  id: string;
  user_id: string;
  provider: "duffel";
  provider_card_id: string;
  brand: string;
  last4: string;
  cardholder_name: string;
  status: PaymentMethod["status"];
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
};

type PaymentCardSetupIntentRow = {
  id: string;
  user_id: string;
  status: PaymentCardSetupIntent["status"];
  payment_method_id: string | null;
  component_client_key: string | null;
  client_key_issue_token: string | null;
  client_key_issue_expires_at: Date | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type PaymentCardDeletionRow = {
  id: string;
  provider: "duffel";
  provider_card_id: string;
  payment_method_id: string | null;
  status: PaymentCardDeletion["status"];
  attempts: number;
  available_at: Date;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  last_error_detail: string | null;
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
    id: row.id, tripId: row.trip_id, status: row.status, cadenceHours: row.cadence_hours,
    nextCheckAt: row.next_check_at ? iso(row.next_check_at) : null,
    lastCheckAt: row.last_check_at ? iso(row.last_check_at) : null,
    lastManualRefreshAt: row.last_manual_refresh_at ? iso(row.last_manual_refresh_at) : null,
    trackingStartsAt: row.tracking_starts_at ? iso(row.tracking_starts_at) : null,
    baselineCompletedAt: row.baseline_completed_at ? iso(row.baseline_completed_at) : null,
    activatedAt: row.activated_at ? iso(row.activated_at) : null,
    lastUserActivityAt: iso(row.last_user_activity_at),
    checkInSentAt: row.check_in_sent_at ? iso(row.check_in_sent_at) : null,
    autoPauseAt: row.auto_pause_at ? iso(row.auto_pause_at) : null,
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
    digestHourLocal: row.digest_hour_local,
    priceRiseAlertsEnabled: row.price_rise_alerts_enabled,
    betterOptionAlertsEnabled: row.better_option_alerts_enabled,
    trackingCheckinsEnabled: row.tracking_checkins_enabled,
    maxAlertsPerDay: row.max_alerts_per_day,
    quietHoursEnabled: row.quiet_hours_enabled,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    onboardingCompletedAt: row.onboarding_completed_at ? iso(row.onboarding_completed_at) : null,
    onboardingStep: row.onboarding_step,
    travellerSetupPromptedAt: row.traveller_setup_prompted_at
      ? iso(row.traveller_setup_prompted_at)
      : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapPassenger(row: PassengerRow): Passenger {
  return {
    id: row.id,
    userId: row.user_id,
    givenName: row.given_name,
    middleName: row.middle_name,
    familyName: row.family_name,
    title: row.title,
    gender: row.gender,
    bornOn: row.born_on
      ? (row.born_on instanceof Date ? row.born_on.toISOString().slice(0, 10) : String(row.born_on).slice(0, 10))
      : null,
    email: row.email,
    phoneNumber: row.phone_number,
    nationality: row.nationality,
    countryOfResidence: row.country_of_residence,
    passportLast4: row.passport_last4,
    passportIssuingCountry: row.passport_issuing_country,
    passportExpiresOn: row.passport_expires_on
      ? (row.passport_expires_on instanceof Date
          ? row.passport_expires_on.toISOString().slice(0, 10)
          : String(row.passport_expires_on).slice(0, 10))
      : null,
    isDefault: row.is_default,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapPaymentMethod(row: PaymentMethodRow): PaymentMethod {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerCardId: row.provider_card_id,
    brand: row.brand as PaymentMethod["brand"],
    last4: row.last4,
    cardholderName: row.cardholder_name,
    status: row.status,
    isDefault: row.is_default,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapPaymentCardSetupIntent(row: PaymentCardSetupIntentRow): PaymentCardSetupIntent {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    paymentMethodId: row.payment_method_id,
    componentClientKey: row.component_client_key,
    expiresAt: iso(row.expires_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mapPaymentCardDeletion(row: PaymentCardDeletionRow): PaymentCardDeletion {
  return {
    id: row.id,
    provider: row.provider,
    providerCardId: row.provider_card_id,
    paymentMethodId: row.payment_method_id,
    status: row.status,
    attempts: row.attempts,
    availableAt: iso(row.available_at),
    claimedBy: row.claimed_by,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    lastErrorCode: row.last_error_code,
    lastErrorDetail: row.last_error_detail,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

/** Drops the local card row a deletion was holding open, once we stop tracking it remotely. */
async function releaseDeletedCardRow(
  sql: Sql,
  deletion: Pick<PaymentCardDeletionRow, "payment_method_id" | "provider_card_id">
): Promise<void> {
  if (!deletion.payment_method_id) return;
  await sql`
    delete from captain.payment_methods
    where id = ${deletion.payment_method_id}
      and status = 'removed'
      and provider_card_id = ${deletion.provider_card_id}
  `;
}

async function enqueueCardDeletion(
  sql: Sql,
  method: Pick<PaymentMethodRow, "id" | "provider" | "provider_card_id">,
  now: Date
): Promise<void> {
  await sql`
    insert into captain.payment_card_deletions (
      id, provider, provider_card_id, payment_method_id, status, attempts,
      available_at, claimed_by, lease_expires_at, last_error_code, last_error_detail,
      created_at, updated_at
    ) values (
      ${randomUUID()}, ${method.provider}, ${method.provider_card_id}, ${method.id},
      'queued', 0, ${now}, null, null, null, null, ${now}, ${now}
    )
    on conflict (provider, provider_card_id) do nothing
  `;
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
