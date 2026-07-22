import postgres, { type Sql } from "postgres";

import type {
  AgentAction,
  AgentCheck,
  CreateFlightAgentInput
} from "../domain/types.js";
import type {
  CheckTrigger,
  CompletedCheck,
  FailedCheck,
  FlightAgentStore,
  IdempotencyRecord,
  RecordedCheckSource
} from "./contracts.js";
import {
  MemoryFlightAgentStore,
  type SerializedMemoryAgent
} from "./memory-store.js";

export class PostgresFlightAgentStore implements FlightAgentStore {
  readonly #sql: Sql;
  readonly #memory: MemoryFlightAgentStore;

  private constructor(sql: Sql, memory: MemoryFlightAgentStore) {
    this.#sql = sql;
    this.#memory = memory;
  }

  static async connect(databaseUrl: string): Promise<PostgresFlightAgentStore> {
    const sql = postgres(databaseUrl, {
      max: 8,
      idle_timeout: 20,
      connect_timeout: 15,
      transform: { undefined: null }
    });
    const rows = await sql<Array<{ state: SerializedMemoryAgent }>>`
      select state
      from flight_agent.agent_states
      order by updated_at asc
    `;
    const memory = new MemoryFlightAgentStore();
    for (const row of rows) memory.importState(row.state);
    return new PostgresFlightAgentStore(sql, memory);
  }

  async createAgent(key: string, input: CreateFlightAgentInput, now: Date) {
    const result = await this.#memory.createAgent(key, input, now);
    await this.#persist(key);
    return result;
  }

  async deleteAgent(key: string, createIdempotencyKey: string): Promise<boolean> {
    if (!await this.#memory.getWorkspace(key)) return false;
    const deleted = await this.#sql.begin(async (tx) => {
      const creation = await tx<Array<{
        request_hash: string;
        response_status: number;
        response_body: unknown;
      }>>`
        select request_hash, response_status, response_body
        from flight_agent.idempotency_keys
        where scope = 'internal:create'
          and idempotency_key = ${createIdempotencyKey}
          and response_body -> 'agent' ->> 'key' = ${key}
        for update
      `;
      if (!creation[0]) return null;
      await tx`delete from flight_agent.agent_states where agent_key = ${key}`;
      await tx`delete from flight_agent.agents where agent_key = ${key}`;
      await tx`
        delete from flight_agent.flights flight
        where not exists (
          select 1 from flight_agent.agent_flights link where link.flight_id = flight.id
        )
      `;
      await tx`
        delete from flight_agent.idempotency_keys
        where scope = 'internal:create' and idempotency_key = ${createIdempotencyKey}
      `;
      return creation[0];
    });
    if (!deleted) return false;
    await this.#memory.putIdempotency("internal:create", createIdempotencyKey, {
      requestHash: deleted.request_hash,
      responseStatus: deleted.response_status,
      responseBody: deleted.response_body
    });
    return this.#memory.deleteAgent(key, createIdempotencyKey);
  }

  listAgents(options?: { status?: string; limit?: number; cursor?: string }) {
    return this.#memory.listAgents(options);
  }

  getWorkspace(key: string) {
    return this.#memory.getWorkspace(key);
  }

  getFlightDetails(key: string, flightId: string) {
    return this.#memory.getFlightDetails(key, flightId);
  }

  async claimCheck(key: string, trigger: CheckTrigger, mode: AgentCheck["mode"], force: boolean, now: Date) {
    const result = await this.#memory.claimCheck(key, trigger, mode, force, now);
    if (result) await this.#persist(key);
    return result;
  }

  listDueAgentKeys(now: Date, limit: number) {
    return this.#memory.listDueAgentKeys(now, limit);
  }

  async recordCheckSource(key: string, checkId: string, result: RecordedCheckSource, now: Date) {
    await this.#memory.recordCheckSource(key, checkId, result, now);
    await this.#persist(key);
  }

  async completeCheck(key: string, checkId: string, result: CompletedCheck, now: Date) {
    await this.#memory.completeCheck(key, checkId, result, now);
    await this.#persist(key);
  }

  async failCheck(key: string, checkId: string, result: FailedCheck, now: Date) {
    await this.#memory.failCheck(key, checkId, result, now);
    await this.#persist(key);
  }

  async applyAction(key: string, action: AgentAction, now: Date) {
    const result = await this.#memory.applyAction(key, action, now);
    await this.#persist(key);
    return result;
  }

  async createFolder(key: string, name: string, now: Date) {
    const result = await this.#memory.createFolder(key, name, now);
    await this.#persist(key);
    return result;
  }

  async renameFolder(key: string, folderId: string, name: string, now: Date) {
    const result = await this.#memory.renameFolder(key, folderId, name, now);
    if (result) await this.#persist(key);
    return result;
  }

  async deleteFolder(key: string, folderId: string, now: Date) {
    const result = await this.#memory.deleteFolder(key, folderId, now);
    if (result) await this.#persist(key);
    return result;
  }

  async setFolderMembership(key: string, folderId: string, flightId: string, included: boolean, now: Date) {
    await this.#memory.setFolderMembership(key, folderId, flightId, included, now);
    await this.#persist(key);
  }

  async getIdempotency(scope: string, key: string): Promise<IdempotencyRecord | null> {
    const rows = await this.#sql<Array<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
    }>>`
      select request_hash, response_status, response_body
      from flight_agent.idempotency_keys
      where scope = ${scope} and idempotency_key = ${key}
    `;
    const row = rows[0];
    return row ? {
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: row.response_body
    } : null;
  }

  async putIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    await this.#sql`
      insert into flight_agent.idempotency_keys (
        scope, idempotency_key, request_hash, response_status, response_body
      ) values (
        ${scope}, ${key}, ${record.requestHash}, ${record.responseStatus},
        ${this.#sql.json(toJson(record.responseBody))}
      ) on conflict (scope, idempotency_key) do nothing
    `;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #persist(key: string): Promise<void> {
    const state = this.#memory.exportState(key);
    if (!state) return;
    await this.#sql.begin(async (tx) => {
      await mirrorNormalizedState(tx, state);
      await tx`
        insert into flight_agent.agent_states (agent_key, state, updated_at)
        values (${key}, ${tx.json(toJson(state))}, now())
        on conflict (agent_key) do update
        set state = excluded.state, updated_at = excluded.updated_at
      `;
    });
  }
}

export async function mirrorNormalizedState(sql: Sql, state: SerializedMemoryAgent): Promise<void> {
  const agent = state.agent;
  await sql`
    insert into flight_agent.agents (
      agent_key, status, version, brief, cadence_hours, search_cursor,
      tracking_window_days, browse_preferences, created_at, processing_started_at,
      accumulated_processing_ms, last_check_at, next_check_at, running_check_id,
      consecutive_failures
    ) values (
      ${agent.key}, ${agent.status}, ${agent.version}, ${sql.json(agent.brief)},
      ${agent.cadenceHours}, ${agent.searchCursor}, ${agent.trackingWindowDays}, ${sql.json(agent.browsePreferences)},
      ${agent.createdAt}, ${agent.processingStartedAt},
      ${agent.accumulatedProcessingMs}, ${agent.lastCheckAt}, ${agent.nextCheckAt},
      ${state.runningCheckId}, ${state.failures}
    )
    on conflict (agent_key) do update set
      status = excluded.status,
      version = excluded.version,
      brief = excluded.brief,
      cadence_hours = excluded.cadence_hours,
      search_cursor = excluded.search_cursor,
      tracking_window_days = excluded.tracking_window_days,
      browse_preferences = excluded.browse_preferences,
      processing_started_at = excluded.processing_started_at,
      accumulated_processing_ms = excluded.accumulated_processing_ms,
      last_check_at = excluded.last_check_at,
      next_check_at = excluded.next_check_at,
      running_check_id = excluded.running_check_id,
      consecutive_failures = excluded.consecutive_failures,
      updated_at = now()
  `;

  // Folders are a mutable projection. Domain history below is append-only and
  // must never be removed just because agent_states receives a new snapshot.
  await sql`delete from flight_agent.folder_memberships where agent_key = ${agent.key}`;
  await sql`delete from flight_agent.folders where agent_key = ${agent.key}`;

  for (const check of state.checks) {
    await sql`
      insert into flight_agent.checks (
        id, agent_key, status, mode, trigger, started_at, completed_at, matrix,
        searched, offers_found, identities_matched, promotions, duffel_error
      ) values (
        ${check.id}, ${agent.key}, ${check.status}, ${check.mode}, ${check.trigger},
        ${check.startedAt}, ${check.completedAt}, ${sql.json(check.matrix)},
        ${check.searched}, ${check.offersFound}, ${check.identitiesMatched},
        ${check.promotions}, ${check.duffelError}
      )
      on conflict (id) do update set
        status = excluded.status,
        mode = excluded.mode,
        completed_at = excluded.completed_at,
        matrix = excluded.matrix,
        searched = excluded.searched,
        offers_found = excluded.offers_found,
        identities_matched = excluded.identities_matched,
        promotions = excluded.promotions,
        duffel_error = excluded.duffel_error
    `;
    for (const sourceRun of check.sourceRuns) {
      await sql`
        insert into flight_agent.check_source_runs (
          check_id, source, status, started_at, completed_at,
          offers_found, observations_saved, error
        ) values (
          ${check.id}, ${sourceRun.source}, ${sourceRun.status}, ${sourceRun.startedAt},
          ${sourceRun.completedAt}, ${sourceRun.offersFound},
          ${sourceRun.observationsSaved}, ${sourceRun.error}
        )
        on conflict (check_id, source) do update set
          status = excluded.status,
          completed_at = excluded.completed_at,
          offers_found = excluded.offers_found,
          observations_saved = excluded.observations_saved,
          error = excluded.error
      `;
    }
    if (check.research) {
      await sql`
        insert into flight_agent.research_runs (
          id, agent_key, check_id, status, searched_at, overview, findings, offers, gaps, error,
          model, input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, duration_ms
        ) values (
          ${`${check.id}-research`}, ${agent.key}, ${check.id}, ${check.research.status},
          ${check.research.searchedAt}, ${check.research.overview},
          ${sql.json(check.research.results)}, ${sql.json(check.research.offers)}, ${sql.json(check.research.gaps)},
          ${check.research.error}, ${check.research.metadata?.model ?? null},
          ${check.research.metadata?.inputTokens ?? null},
          ${check.research.metadata?.cachedInputTokens ?? null},
          ${check.research.metadata?.outputTokens ?? null},
          ${check.research.metadata?.reasoningOutputTokens ?? null},
          ${check.research.metadata?.durationMs ?? null}
        )
        on conflict (id) do nothing
      `;
    }
  }

  for (const flight of state.flights) {
    await sql`
      insert into flight_agent.flights (
        id, itinerary_key, destination_iata, departure_local_date, marketing_carrier_code,
        marketing_carrier_name, created_at, updated_at
      ) values (
        ${flight.id}, ${flight.itineraryKey}, ${flight.destination}, ${flight.travelDate},
        ${flight.marketingAirlineCode}, ${flight.marketingAirline},
        ${flight.firstSeenAt}, ${flight.lastSeenAt}
      )
      on conflict (itinerary_key)
      do update set
        marketing_carrier_name = excluded.marketing_carrier_name,
        updated_at = excluded.updated_at
    `;
    await sql`
      insert into flight_agent.agent_flights (
        agent_key, flight_id, review_state, promotion_reason,
        tracked_until_at, first_seen_at, last_seen_at, latest_snapshot
      ) values (
        ${agent.key}, ${flight.id}, ${flight.reviewState}, ${flight.promotionReason},
        ${flight.trackedUntilAt}, ${flight.firstSeenAt}, ${flight.lastSeenAt}, ${sql.json(toJson(flight.latest))}
      )
      on conflict (agent_key, flight_id) do update set
        review_state = excluded.review_state,
        promotion_reason = excluded.promotion_reason,
        tracked_until_at = excluded.tracked_until_at,
        last_seen_at = excluded.last_seen_at,
        latest_snapshot = excluded.latest_snapshot
    `;
  }

  for (const [flightId, observations] of state.observations) {
    for (const observation of observations) {
      await sql`
        insert into flight_agent.price_observations (
          id, agent_key, flight_id, check_id, source, source_offer_id,
          booking_url, observed_at, price, currency, snapshot
        ) values (
          ${observation.id}, ${agent.key}, ${flightId}, ${observation.checkId},
          ${observation.provider}, ${observation.providerOfferId}, ${observation.bookingUrl},
          ${observation.observedAt}, ${observation.price}, ${observation.currency},
          ${sql.json(toJson(observation))}
        )
        on conflict (id) do nothing
      `;
    }
  }

  for (const item of state.activity) {
    await sql`
      insert into flight_agent.activities (id, agent_key, kind, message, metadata, created_at)
      values (${item.id}, ${agent.key}, ${item.kind}, ${item.message}, ${sql.json(toJson(item.metadata))}, ${item.createdAt})
      on conflict (id) do nothing
    `;
  }
  for (const folder of state.folders) {
    await sql`
      insert into flight_agent.folders (id, agent_key, name, created_at)
      values (${folder.id}, ${agent.key}, ${folder.name}, ${folder.createdAt})
    `;
  }
  for (const [folderId, flightIds] of state.memberships) {
    for (const flightId of flightIds) {
      await sql`
        insert into flight_agent.folder_memberships (agent_key, folder_id, flight_id)
        values (${agent.key}, ${folderId}, ${flightId})
      `;
    }
  }
}

function toJson(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never;
}
