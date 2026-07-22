import { createHash, randomUUID } from "node:crypto";

import type {
  AgentAction,
  AgentActivity,
  AgentCheck,
  CheckMode,
  CreateFlightAgentInput,
  FlightAgent,
  FlightAgentSummary,
  FlightAgentWorkspace,
  FlightFolder,
  FlightReviewState,
  FlightSnapshot,
  FlightWorkspaceItem,
  PriceObservation,
  ResearchResult
} from "../domain/types.js";
import {
  InvalidStateError,
  NotFoundError,
  VersionConflictError
} from "../domain/types.js";
import type {
  ClaimedCheck,
  CompletedCheck,
  FailedCheck,
  FlightAgentStore,
  FlightDetails,
  IdempotencyRecord,
  RecordedCheckSource
} from "./contracts.js";

type MemoryAgent = {
  agent: FlightAgent;
  runningCheckId: string | null;
  failures: number;
  flights: Map<string, FlightWorkspaceItem>;
  identityIds: Map<string, string>;
  observations: Map<string, PriceObservation[]>;
  checks: AgentCheck[];
  activity: AgentActivity[];
  folders: Map<string, FlightFolder>;
  memberships: Map<string, Set<string>>;
};

export type SerializedMemoryAgent = {
  agent: FlightAgent;
  runningCheckId: string | null;
  failures: number;
  flights: FlightWorkspaceItem[];
  identityIds: Array<[string, string]>;
  observations: Array<[string, PriceObservation[]]>;
  checks: AgentCheck[];
  activity: AgentActivity[];
  folders: FlightFolder[];
  memberships: Array<[string, string[]]>;
};

export class MemoryFlightAgentStore implements FlightAgentStore {
  readonly #agents = new Map<string, MemoryAgent>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  importState(state: SerializedMemoryAgent): void {
    const checks = clone(state.checks.map((check) => ({
      ...check,
      mode: check.mode ?? (check.research ? "fare_and_research" : "fare"),
      sourceRuns: check.sourceRuns ?? legacySourceRuns(check),
      research: check.research ? { ...check.research, offers: check.research.offers ?? [] } : null
    })));
    const agent: FlightAgent = {
      ...state.agent,
      trackingWindowDays: state.agent.trackingWindowDays ?? 30
    };
    const flights = state.flights.map((flight) => {
      const latest = normalizeSnapshot(flight.latest);
      return clone({ ...flight, itineraryKey: flight.itineraryKey ?? `legacy:${flight.id}`, latest, trackedUntilAt: flight.trackedUntilAt ?? null });
    });
    this.#agents.set(state.agent.key, {
      agent: clone(agent),
      runningCheckId: state.runningCheckId,
      failures: state.failures,
      flights: new Map(flights.map((flight) => [flight.id, flight])),
      identityIds: new Map(flights.map((flight) => [flight.itineraryKey, flight.id])),
      observations: new Map(state.observations.map(([id, observations]) => [id, clone(observations.map(normalizeSnapshot))])),
      checks,
      activity: clone(state.activity),
      folders: new Map(state.folders.map((folder) => [folder.id, clone(folder)])),
      memberships: new Map(state.memberships.map(([id, members]) => [id, new Set(members)]))
    });
  }

  exportState(key: string): SerializedMemoryAgent | null {
    const entry = this.#agents.get(key);
    if (!entry) return null;
    return clone({
      agent: entry.agent,
      runningCheckId: entry.runningCheckId,
      failures: entry.failures,
      flights: [...entry.flights.values()],
      identityIds: [...entry.identityIds.entries()],
      observations: [...entry.observations.entries()],
      checks: entry.checks,
      activity: entry.activity,
      folders: [...entry.folders.values()],
      memberships: [...entry.memberships.entries()].map(([id, members]) => [id, [...members]])
    });
  }

  async createAgent(key: string, input: CreateFlightAgentInput, now: Date): Promise<FlightAgent> {
    if (this.#agents.has(key)) return clone(this.#agents.get(key)!.agent);
    const timestamp = now.toISOString();
    const agent: FlightAgent = {
      key,
      status: "queued",
      version: 1,
      brief: clone(input.brief),
      cadenceHours: input.cadenceHours,
      trackingWindowDays: 30,
      searchCursor: 0,
      browsePreferences: {
        sort: "recommended",
        stops: [],
        airlines: [],
        airports: [],
        cabins: [],
        maximumPrice: null,
        departurePeriods: []
      },
      createdAt: timestamp,
      processingStartedAt: null,
      accumulatedProcessingMs: 0,
      lastCheckAt: null,
      nextCheckAt: timestamp,
      latestCheck: null
    };
    this.#agents.set(key, {
      agent,
      runningCheckId: null,
      failures: 0,
      flights: new Map(),
      identityIds: new Map(),
      observations: new Map(),
      checks: [],
      activity: [activity("agent_started", "Flight agent started", now, { requestedBy: input.requestedBy })],
      folders: new Map(),
      memberships: new Map()
    });
    return clone(agent);
  }

  async deleteAgent(key: string, createIdempotencyKey: string): Promise<boolean> {
    const creation = this.#idempotency.get(`internal:create:${createIdempotencyKey}`);
    if (createdAgentKey(creation) !== key) return false;
    const deleted = this.#agents.delete(key);
    if (deleted) this.#idempotency.delete(`internal:create:${createIdempotencyKey}`);
    return deleted;
  }

  async listAgents(options: { status?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const sorted = [...this.#agents.values()]
      .filter((entry) => !options.status || entry.agent.status === options.status)
      .sort((a, b) => b.agent.createdAt.localeCompare(a.agent.createdAt));
    const start = options.cursor
      ? Math.max(0, sorted.findIndex((entry) => entry.agent.key === options.cursor) + 1)
      : 0;
    const page = sorted.slice(start, start + limit);
    return {
      agents: page.map((entry) => summary(entry, new Date())),
      nextCursor: start + limit < sorted.length ? page.at(-1)?.agent.key ?? null : null
    };
  }

  async getWorkspace(key: string): Promise<FlightAgentWorkspace | null> {
    const entry = this.#agents.get(key);
    if (!entry) return null;
    const browseFlights = [...entry.flights.values()]
      .sort((a, b) => a.latest.rank - b.latest.rank || a.latest.price - b.latest.price)
      .map((flight) => withFolders(entry, flight));
    return clone({
      version: 1 as const,
      agent: { ...entry.agent, latestCheck: entry.checks[0] ?? null },
      reviewFlights: browseFlights.filter((flight) => flight.reviewState === "promoted" || flight.reviewState === "retained"),
      browseFlights,
      recentChecks: entry.checks.slice(0, 20),
      activity: entry.activity.slice(0, 100),
      folders: [...entry.folders.values()].map((folder) => ({
        ...folder,
        flightCount: entry.memberships.get(folder.id)?.size ?? 0
      }))
    });
  }

  async getFlightDetails(key: string, flightId: string): Promise<FlightDetails | null> {
    const entry = this.#agents.get(key);
    const flight = entry?.flights.get(flightId);
    if (!entry || !flight) return null;
    const observations = entry.observations.get(flightId) ?? [];
    const checkIds = new Set(observations.map((observation) => observation.checkId));
    const relatedChecks = entry.checks.filter((check) => checkIds.has(check.id));
    const research = relatedChecks
      .map((check) => check.research)
      .filter((value): value is ResearchResult => value !== null);
    return clone({
      flight: withFolders(entry, flight),
      observations,
      relatedChecks,
      research
    });
  }

  async claimCheck(
    key: string,
    trigger: AgentCheck["trigger"],
    mode: CheckMode,
    force: boolean,
    now: Date
  ): Promise<ClaimedCheck | null> {
    const entry = this.#agents.get(key);
    if (!entry) throw new NotFoundError("Flight agent not found");
    if (entry.agent.status === "paused") throw new InvalidStateError("Paused agents cannot run");
    if (entry.runningCheckId) return null;
    if (!force && entry.agent.nextCheckAt && Date.parse(entry.agent.nextCheckAt) > now.getTime()) return null;
    const check: AgentCheck = {
      id: randomUUID(),
      status: "running",
      mode,
      trigger,
      startedAt: now.toISOString(),
      completedAt: null,
      matrix: [],
      searched: 0,
      offersFound: 0,
      identitiesMatched: 0,
      promotions: 0,
      duffelError: null,
      sourceRuns: (mode === "fare"
        ? (["duffel"] as const)
        : (["duffel", "codex_web"] as const)
      ).map((source) => ({
        source,
        status: "running" as const,
        startedAt: now.toISOString(),
        completedAt: null,
        offersFound: 0,
        observationsSaved: 0,
        error: null
      })),
      research: null
    };
    entry.runningCheckId = check.id;
    entry.checks.unshift(check);
    entry.agent = {
      ...entry.agent,
      status: "active",
      processingStartedAt: check.startedAt,
      latestCheck: check
    };
    return clone({ agent: entry.agent, check });
  }

  async listDueAgentKeys(now: Date, limit: number): Promise<string[]> {
    return [...this.#agents.values()]
      .filter((entry) =>
        entry.agent.status !== "paused" &&
        !entry.runningCheckId &&
        entry.agent.nextCheckAt !== null &&
        Date.parse(entry.agent.nextCheckAt) <= now.getTime()
      )
      .sort((a, b) => (a.agent.nextCheckAt ?? "").localeCompare(b.agent.nextCheckAt ?? ""))
      .slice(0, limit)
      .map((entry) => entry.agent.key);
  }

  async recordCheckSource(key: string, checkId: string, result: RecordedCheckSource, now: Date): Promise<void> {
    const entry = requiredEntry(this.#agents, key);
    if (entry.runningCheckId !== checkId) throw new InvalidStateError("Check is no longer active");
    const checkIndex = entry.checks.findIndex((check) => check.id === checkId);
    if (checkIndex < 0) throw new NotFoundError("Check not found");
    const current = entry.checks[checkIndex]!;
    const ingested = ingestSnapshots(entry, checkId, result.snapshots, now);
    const sourceRuns = current.sourceRuns.map((sourceRun) => sourceRun.source === result.source ? {
      ...sourceRun,
      status: result.status,
      completedAt: now.toISOString(),
      offersFound: result.offersFound,
      observationsSaved: ingested.observationsSaved,
      error: result.error
    } : sourceRun);
    const updated: AgentCheck = {
      ...current,
      searched: current.searched + result.searched,
      offersFound: current.offersFound + result.offersFound,
      identitiesMatched: current.identitiesMatched + ingested.observationsSaved,
      promotions: current.promotions + ingested.promotions,
      duffelError: result.source === "duffel" ? result.error : current.duffelError,
      sourceRuns,
      research: result.source === "codex_web" ? result.research : current.research
    };
    entry.checks[checkIndex] = updated;
    entry.agent = { ...entry.agent, latestCheck: updated };
    entry.activity.unshift(activity(
      result.status === "completed" ? "check_source_completed" : "check_source_failed",
      result.status === "completed"
        ? `${sourceLabel(result.source)} returned ${ingested.observationsSaved} comparable offer${ingested.observationsSaved === 1 ? "" : "s"}`
        : `${sourceLabel(result.source)} check failed`,
      now,
      { checkId, source: result.source, error: result.error }
    ));
  }

  async completeCheck(key: string, checkId: string, result: CompletedCheck, now: Date): Promise<void> {
    const entry = requiredEntry(this.#agents, key);
    if (entry.runningCheckId !== checkId) throw new InvalidStateError("Check is no longer active");
    const ingested = ingestSnapshots(entry, checkId, result.snapshots, now);

    const checkIndex = entry.checks.findIndex((check) => check.id === checkId);
    const completed: AgentCheck = {
      ...entry.checks[checkIndex]!,
      status: result.status ?? (result.research?.status === "failed" ? "partial" : "completed"),
      completedAt: now.toISOString(),
      matrix: result.matrix,
      searched: result.searched,
      offersFound: result.offersFound,
      identitiesMatched: result.identitiesMatched ?? entry.checks[checkIndex]!.identitiesMatched + ingested.observationsSaved,
      promotions: entry.checks[checkIndex]!.promotions + ingested.promotions,
      duffelError: result.duffelError === undefined ? entry.checks[checkIndex]!.duffelError : result.duffelError,
      sourceRuns: finalizeSourceRuns(entry.checks[checkIndex]!.sourceRuns, result, now),
      research: result.research ?? entry.checks[checkIndex]!.research
    };
    entry.checks[checkIndex] = completed;
    entry.runningCheckId = null;
    entry.failures = 0;
    entry.agent = {
      ...entry.agent,
      status: "active",
      version: entry.agent.version + 1,
      searchCursor: result.searchCursor,
      processingStartedAt: null,
      accumulatedProcessingMs: completedProcessingTime(entry.checks),
      lastCheckAt: now.toISOString(),
      nextCheckAt: result.nextCheckAt,
      latestCheck: completed
    };
    entry.activity.unshift(activity("check_completed", `${completed.identitiesMatched} source offers matched`, now, {
      checkId,
      searched: result.searched,
      offersFound: result.offersFound,
      promotions: completed.promotions,
      researchStatus: completed.research?.status ?? "not_requested"
    }));
  }

  async failCheck(key: string, checkId: string, result: FailedCheck, now: Date): Promise<void> {
    const entry = requiredEntry(this.#agents, key);
    const checkIndex = entry.checks.findIndex((check) => check.id === checkId);
    if (checkIndex < 0) throw new NotFoundError("Check not found");
    const failed: AgentCheck = {
      ...entry.checks[checkIndex]!,
      status: "failed",
      completedAt: now.toISOString(),
      matrix: result.matrix,
      duffelError: result.error,
      sourceRuns: entry.checks[checkIndex]!.sourceRuns.map((sourceRun) => sourceRun.status === "running" ? {
        ...sourceRun,
        status: "failed",
        completedAt: now.toISOString(),
        error: result.error
      } : sourceRun)
    };
    entry.checks[checkIndex] = failed;
    entry.runningCheckId = null;
    entry.failures += 1;
    entry.agent = {
      ...entry.agent,
      status: entry.failures >= 3 ? "needs_attention" : "active",
      version: entry.agent.version + 1,
      searchCursor: result.searchCursor,
      processingStartedAt: null,
      accumulatedProcessingMs: completedProcessingTime(entry.checks),
      lastCheckAt: now.toISOString(),
      nextCheckAt: result.nextCheckAt,
      latestCheck: failed
    };
    entry.activity.unshift(activity("check_failed", "Duffel check failed", now, {
      checkId,
      error: result.error,
      nextCheckAt: result.nextCheckAt
    }));
  }

  async applyAction(key: string, action: AgentAction, now: Date): Promise<FlightAgent> {
    const entry = requiredEntry(this.#agents, key);
    if (entry.agent.version !== action.expectedVersion) {
      throw new VersionConflictError(entry.agent.version);
    }
    let agent = entry.agent;
    let message = "Agent updated";
    if (action.type === "pause") {
      agent = { ...agent, status: "paused", nextCheckAt: null };
      message = "Agent paused";
    } else if (action.type === "resume") {
      agent = { ...agent, status: "active", nextCheckAt: now.toISOString() };
      message = "Agent resumed";
    } else if (action.type === "run" || action.type === "research") {
      if (agent.status === "paused") throw new InvalidStateError("Paused agents cannot run");
      agent = { ...agent, nextCheckAt: now.toISOString() };
      message = action.type === "research"
        ? "Fare and research check queued"
        : "Manual fare check queued";
    } else if (action.type === "update_brief") {
      agent = { ...agent, brief: clone(action.brief), searchCursor: 0, nextCheckAt: now.toISOString() };
      message = "Trip brief updated";
    } else if (action.type === "set_cadence") {
      agent = { ...agent, cadenceHours: action.cadenceHours };
      message = `Check cadence changed to every ${action.cadenceHours} hours`;
    } else if (action.type === "set_tracking_window") {
      agent = { ...agent, trackingWindowDays: action.trackingWindowDays };
      message = action.trackingWindowDays === null
        ? "Flights will be tracked until departure"
        : `Flight tracking window changed to ${action.trackingWindowDays} days`;
    } else if (action.type === "set_browse_preferences") {
      agent = { ...agent, browsePreferences: clone(action.preferences) };
      message = "Browse preferences updated";
    } else {
      const flight = entry.flights.get(action.flightKey);
      if (!flight) throw new NotFoundError("Flight not found");
      const reviewState: FlightReviewState = action.type === "retain_flight" ? "retained" : "dismissed";
      entry.flights.set(action.flightKey, {
        ...flight,
        reviewState,
        trackedUntilAt: action.type === "retain_flight" ? trackingDeadline(agent, flight, now) : null
      });
      if (action.type === "dismiss_flight") {
        for (const members of entry.memberships.values()) members.delete(action.flightKey);
      }
      message = action.type === "retain_flight" ? "Flight tracking started" : "Flight removed from tracking";
    }
    entry.agent = { ...agent, version: agent.version + 1 };
    entry.activity.unshift(activity("agent_action", message, now, { type: action.type }));
    return clone(entry.agent);
  }

  async createFolder(key: string, name: string, now: Date): Promise<FlightFolder> {
    const entry = requiredEntry(this.#agents, key);
    const normalized = normalizeFolderName(name);
    assertUniqueFolderName(entry, normalized);
    const folder: FlightFolder = { id: randomUUID(), name: normalized, createdAt: now.toISOString(), flightCount: 0 };
    entry.folders.set(folder.id, folder);
    entry.memberships.set(folder.id, new Set());
    entry.activity.unshift(activity("folder_created", `Folder created · ${folder.name}`, now, { folderId: folder.id }));
    return clone(folder);
  }

  async renameFolder(key: string, folderId: string, name: string, now: Date): Promise<FlightFolder | null> {
    const entry = requiredEntry(this.#agents, key);
    const folder = entry.folders.get(folderId);
    if (!folder) return null;
    const normalized = normalizeFolderName(name);
    assertUniqueFolderName(entry, normalized, folderId);
    const updated = { ...folder, name: normalized };
    entry.folders.set(folderId, updated);
    entry.activity.unshift(activity("folder_renamed", `Folder renamed · ${updated.name}`, now, { folderId }));
    return clone({ ...updated, flightCount: entry.memberships.get(folderId)?.size ?? 0 });
  }

  async deleteFolder(key: string, folderId: string, now: Date): Promise<boolean> {
    const entry = requiredEntry(this.#agents, key);
    const folder = entry.folders.get(folderId);
    if (!folder) return false;
    entry.memberships.delete(folderId);
    entry.folders.delete(folderId);
    entry.activity.unshift(activity("folder_deleted", `Folder deleted · ${folder.name}`, now, { folderId }));
    return true;
  }

  async setFolderMembership(key: string, folderId: string, flightId: string, included: boolean, now: Date): Promise<void> {
    const entry = requiredEntry(this.#agents, key);
    if (!entry.folders.has(folderId)) throw new NotFoundError("Folder not found");
    if (!entry.flights.has(flightId)) throw new NotFoundError("Flight not found");
    const members = entry.memberships.get(folderId) ?? new Set<string>();
    if (included) members.add(flightId);
    else members.delete(flightId);
    entry.memberships.set(folderId, members);
    entry.activity.unshift(activity(included ? "folder_member_added" : "folder_member_removed", included ? "Flight added to folder" : "Flight removed from folder", now, { folderId, flightId }));
  }

  async close(): Promise<void> {}

  async getIdempotency(scope: string, key: string): Promise<IdempotencyRecord | null> {
    return clone(this.#idempotency.get(`${scope}:${key}`) ?? null);
  }

  async putIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    this.#idempotency.set(`${scope}:${key}`, clone(record));
  }
}

function createdAgentKey(record: IdempotencyRecord | undefined): string | null {
  if (!record || typeof record.responseBody !== "object" || record.responseBody === null) return null;
  const body = record.responseBody as Record<string, unknown>;
  const agent = body.agent;
  if (typeof agent !== "object" || agent === null) return null;
  return typeof (agent as Record<string, unknown>).key === "string"
    ? String((agent as Record<string, unknown>).key)
    : null;
}

function requiredEntry(agents: Map<string, MemoryAgent>, key: string): MemoryAgent {
  const entry = agents.get(key);
  if (!entry) throw new NotFoundError("Flight agent not found");
  return entry;
}

function ingestSnapshots(
  entry: MemoryAgent,
  checkId: string,
  rawSnapshots: FlightSnapshot[],
  now: Date
): { promotions: number; observationsSaved: number } {
  const snapshots = rawSnapshots.map(normalizeSnapshot);
  const promotionGroups = buildPromotionGroups(snapshots);
  let promotions = 0;
  let observationsSaved = 0;

  for (const snapshot of snapshots) {
    const identity = itineraryKey(snapshot);
    const existingId = entry.identityIds.get(identity);
    const flightId = existingId ?? identityUuid(identity);
    const current = entry.flights.get(flightId);
    const existingObservations = entry.observations.get(flightId) ?? [];
    const observationId = stableUuid("observation", `${entry.agent.key}|${checkId}|${identity}|${snapshot.provider}|${snapshot.providerOfferId}`);
    if (existingObservations.some((observation) => observation.id === observationId)) continue;

    const previousPrice = previousComparablePrice(existingObservations, checkId, snapshot.currency);
    const currentCheck = existingObservations.filter((observation) =>
      observation.checkId === checkId && observation.currency === snapshot.currency
    );
    const latest = [...currentCheck, snapshot].sort((left, right) =>
      left.price - right.price || left.durationSeconds - right.durationSeconds
    )[0]!;
    const trackingExpired = current?.reviewState === "retained" && current.trackedUntilAt !== null && Date.parse(current.trackedUntilAt) <= now.getTime();
    const currentReviewState = trackingExpired ? "discovered" : current?.reviewState;
    const promotion = promotionDecision(latest, currentReviewState, previousPrice, promotionGroups);
    if (promotion.promoted && current?.reviewState !== "promoted" && current?.reviewState !== "retained") promotions += 1;
    const item: FlightWorkspaceItem = {
      id: flightId,
      itineraryKey: identity,
      destination: latest.destination,
      travelDate: latest.travelDate,
      marketingAirlineCode: latest.marketingAirlineCode,
      marketingAirline: latest.marketingAirline,
      reviewState: promotion.state,
      promotionReason: promotion.reason ?? current?.promotionReason ?? null,
      firstSeenAt: current?.firstSeenAt ?? snapshot.observedAt,
      lastSeenAt: current && current.lastSeenAt > snapshot.observedAt ? current.lastSeenAt : snapshot.observedAt,
      latest,
      previousPrice,
      changePercent: previousPrice === null ? null : percentChange(previousPrice, latest.price),
      observationCount: existingObservations.length + 1,
      trackedUntilAt: trackingExpired ? null : current?.trackedUntilAt ?? null,
      folderIds: []
    };
    entry.identityIds.set(identity, flightId);
    entry.flights.set(flightId, item);
    const observation: PriceObservation = { ...snapshot, id: observationId, checkId };
    entry.observations.set(flightId, [...existingObservations, observation]);
    observationsSaved += 1;
    if (promotion.promoted) {
      entry.activity.unshift(activity("flight_promoted", `${latest.marketingAirline} ${latest.destination} added for review`, now, {
        flightId,
        reason: promotion.reason
      }));
    }
  }
  return { promotions, observationsSaved };
}

export function itineraryKey(snapshot: FlightSnapshot): string {
  const normalized = normalizeSnapshot(snapshot);
  return normalized.segments.map((segment) => [
    segment.airlineCode,
    segment.flightNumber,
    segment.origin,
    segment.destination,
    canonicalTimestamp(segment.departure),
    canonicalTimestamp(segment.arrival)
  ].map((value) => value.trim().toUpperCase()).join(":"))
    .join("|");
}

function identityUuid(identity: string): string {
  return stableUuid("flight", identity);
}

function stableUuid(namespace: string, value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`flight-agent:${namespace}:${value}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeSnapshot<T extends FlightSnapshot>(snapshot: T): T {
  const legacy = snapshot as T & Partial<Pick<FlightSnapshot,
    "sourceName" | "sourceUrl" | "bookingUrl" | "evidence" | "passengerCount" | "segments"
  >>;
  const segments = legacy.segments?.length ? legacy.segments : [{
    airlineCode: snapshot.marketingAirlineCode,
    airline: snapshot.marketingAirline,
    flightNumber: snapshot.flightNumber,
    origin: snapshot.origin,
    destination: snapshot.destination,
    departure: snapshot.departure,
    arrival: snapshot.arrival
  }];
  return {
    ...snapshot,
    sourceName: legacy.sourceName ?? sourceLabel(snapshot.provider),
    sourceUrl: legacy.sourceUrl ?? null,
    bookingUrl: legacy.bookingUrl ?? null,
    evidence: legacy.evidence ?? "direct",
    passengerCount: legacy.passengerCount ?? 1,
    segments
  };
}

function canonicalTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function previousComparablePrice(
  observations: PriceObservation[],
  currentCheckId: string,
  currency: string
): number | null {
  const previous = observations
    .filter((observation) => observation.checkId !== currentCheckId && observation.currency === currency)
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const previousCheckId = previous[0]?.checkId;
  if (!previousCheckId) return null;
  return Math.min(...previous.filter((observation) => observation.checkId === previousCheckId).map((observation) => observation.price));
}

function legacySourceRuns(check: AgentCheck): AgentCheck["sourceRuns"] {
  const terminalAt = check.completedAt;
  const running = check.status === "running" || check.status === "queued";
  const duffelStatus = running ? "running" : check.duffelError ? "failed" : "completed";
  const sourceRuns: AgentCheck["sourceRuns"] = [{
    source: "duffel",
    status: duffelStatus,
    startedAt: check.startedAt,
    completedAt: running ? null : terminalAt,
    offersFound: check.offersFound,
    observationsSaved: check.identitiesMatched,
    error: check.duffelError
  }];
  if (check.research || check.mode === "fare_and_research") {
    sourceRuns.push({
      source: "codex_web",
      status: running ? "running" : check.research?.status === "completed" ? "completed" : "failed",
      startedAt: check.startedAt,
      completedAt: running ? null : terminalAt,
      offersFound: check.research?.offers?.length ?? 0,
      observationsSaved: check.research?.offers?.length ?? 0,
      error: check.research?.error ?? null
    });
  }
  return sourceRuns;
}

function finalizeSourceRuns(
  sourceRuns: AgentCheck["sourceRuns"],
  result: CompletedCheck,
  now: Date
): AgentCheck["sourceRuns"] {
  return sourceRuns.map((sourceRun) => {
    if (sourceRun.status !== "running") return sourceRun;
    const failed = sourceRun.source === "duffel"
      ? Boolean(result.duffelError)
      : result.research?.status === "failed";
    return {
      ...sourceRun,
      status: failed ? "failed" : "completed",
      completedAt: now.toISOString(),
      error: failed
        ? sourceRun.source === "duffel" ? result.duffelError ?? "Duffel failed" : result.research?.error ?? "Codex failed"
        : null
    };
  });
}

function sourceLabel(source: FlightSnapshot["provider"]): string {
  return source === "duffel" ? "Duffel" : "Codex web";
}

function buildPromotionGroups(snapshots: readonly FlightSnapshot[]): Map<string, { median: number; topRank: number }> {
  const prices = new Map<string, number[]>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.destination}|${snapshot.travelDate}|${snapshot.cabin}`;
    prices.set(key, [...(prices.get(key) ?? []), snapshot.price]);
  }
  return new Map([...prices.entries()].map(([key, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
    return [key, { median, topRank: 1 }];
  }));
}

function promotionDecision(
  snapshot: FlightSnapshot,
  currentState: FlightReviewState | undefined,
  previousPrice: number | null,
  groups: Map<string, { median: number; topRank: number }>
): { state: FlightReviewState; promoted: boolean; reason?: string } {
  if (snapshot.evidence === "tentative") return { state: currentState ?? "discovered", promoted: false };
  if (currentState === "retained" || currentState === "promoted") {
    return { state: currentState, promoted: false };
  }
  if (previousPrice !== null && snapshot.price <= previousPrice * 0.95) {
    const drop = Math.abs(percentChange(previousPrice, snapshot.price));
    return { state: "promoted", promoted: true, reason: `Fare dropped ${drop.toFixed(1)}%` };
  }
  if (previousPrice === null) {
    const group = groups.get(`${snapshot.destination}|${snapshot.travelDate}|${snapshot.cabin}`);
    if (group && snapshot.rank === group.topRank && snapshot.price <= group.median * 0.9) {
      return { state: "promoted", promoted: true, reason: "Top-ranked fare is at least 10% below comparable median" };
    }
  }
  return { state: currentState ?? "discovered", promoted: false };
}

function withFolders(entry: MemoryAgent, flight: FlightWorkspaceItem): FlightWorkspaceItem {
  return {
    ...flight,
    folderIds: [...entry.memberships.entries()]
      .filter(([, members]) => members.has(flight.id))
      .map(([folderId]) => folderId)
  };
}

function summary(entry: MemoryAgent, now: Date): FlightAgentSummary {
  const workspaceFlights = [...entry.flights.values()];
  return {
    key: entry.agent.key,
    status: entry.agent.status,
    version: entry.agent.version,
    brief: clone(entry.agent.brief),
    cadenceHours: entry.agent.cadenceHours,
    createdAt: entry.agent.createdAt,
    lastCheckAt: entry.agent.lastCheckAt,
    nextCheckAt: entry.agent.nextCheckAt,
    reviewCount: workspaceFlights.filter((flight) => flight.reviewState === "promoted" || flight.reviewState === "retained").length,
    browseCount: workspaceFlights.length,
    processingTimeMs: activeProcessingTime(entry.agent, now)
  };
}

function activeProcessingTime(agent: FlightAgent, now: Date): number {
  if (!agent.processingStartedAt) return agent.accumulatedProcessingMs;
  const startedAt = Date.parse(agent.processingStartedAt);
  if (!Number.isFinite(startedAt)) return agent.accumulatedProcessingMs;
  return agent.accumulatedProcessingMs + Math.max(0, now.getTime() - startedAt);
}

function completedProcessingTime(checks: AgentCheck[]): number {
  return checks.reduce((total, check) => {
    if (!check.completedAt) return total;
    const startedAt = Date.parse(check.startedAt);
    const completedAt = Date.parse(check.completedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return total;
    return total + Math.max(0, completedAt - startedAt);
  }, 0);
}

function trackingDeadline(agent: FlightAgent, flight: FlightWorkspaceItem, now: Date): string {
  const departureEnd = Date.parse(`${flight.travelDate}T23:59:59.999Z`);
  if (agent.trackingWindowDays === null) {
    return new Date(Math.max(now.getTime(), departureEnd)).toISOString();
  }
  const requestedEnd = now.getTime() + agent.trackingWindowDays * 86_400_000;
  return new Date(Math.min(requestedEnd, Math.max(now.getTime(), departureEnd))).toISOString();
}

function activity(
  kind: string,
  message: string,
  now: Date,
  metadata: Record<string, unknown>
): AgentActivity {
  return { id: randomUUID(), kind, message, createdAt: now.toISOString(), metadata };
}

function percentChange(previous: number, current: number): number {
  return previous === 0 ? 0 : ((current - previous) / previous) * 100;
}

function normalizeFolderName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) throw new InvalidStateError("Folder names must contain 1–80 characters");
  return normalized;
}

function assertUniqueFolderName(entry: MemoryAgent, name: string, exceptId?: string): void {
  const normalized = name.toLocaleLowerCase();
  if ([...entry.folders.values()].some((folder) => folder.id !== exceptId && folder.name.toLocaleLowerCase() === normalized)) {
    throw new InvalidStateError("A folder with this name already exists");
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
