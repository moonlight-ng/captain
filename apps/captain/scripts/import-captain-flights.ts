import { createHash } from "node:crypto";

import postgres from "postgres";

import type {
  AgentActivity,
  AgentCheck,
  FlightAgent,
  FlightAgentBrief,
  FlightSnapshot,
  FlightWorkspaceItem,
  PriceObservation
} from "../services/domain/types.js";
import type { SerializedMemoryAgent } from "../services/store/memory-store.js";
import { mirrorNormalizedState } from "../services/store/postgres-store.js";

type SourceMapping = {
  sourceTable: string;
  sourceId: string;
  targetType: string;
  targetId: string;
};

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for Captain import");

const sql = postgres(databaseUrl, { max: 1 });
try {
  await assertTargetSchema();
  let imported = 0;
  if (await tableExists("captain_flight_selection_goals")) {
    imported += await importSelectionGoals();
  }
  if (await tableExists("captain_flight_watches")) {
    imported += await importWatches();
  }
  console.info(`Imported ${imported} Captain flight agent${imported === 1 ? "" : "s"}`);
} finally {
  await sql.end({ timeout: 5 });
}

async function assertTargetSchema(): Promise<void> {
  const rows = await sql<{ table_name: string | null }[]>`
    select to_regclass('flight_agent.agent_states')::text as table_name
  `;
  if (!rows[0]?.table_name) throw new Error("Run pnpm db:migrate before importing Captain flights");
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await sql<{ table_name: string | null }[]>`
    select to_regclass(${`public.${name}`})::text as table_name
  `;
  return Boolean(rows[0]?.table_name);
}

async function importSelectionGoals(): Promise<number> {
  const goals = await sql<Array<{
    id: string;
    workspace_key: string;
    status: string;
    spec: Record<string, unknown>;
    version: number;
    searched_at: string | null;
    last_error: string | null;
    created_at: string;
  }>>`
    select id, workspace_key, status, spec, version, searched_at, last_error, created_at
    from public.captain_flight_selection_goals
    order by created_at
  `;
  let count = 0;
  for (const goal of goals) {
    if (await wasImported("captain_flight_selection_goals", goal.id)) continue;
    const candidates = await sql<Array<{
      id: string;
      provider_offer_id: string;
      search_id: string;
      rank: number;
      decision: string;
      offer: Record<string, unknown>;
      observed_at: string;
    }>>`
      select id, provider_offer_id, search_id, rank, decision, offer, observed_at
      from public.captain_flight_selection_candidates
      where goal_id = ${goal.id}
      order by observed_at, rank
    `;
    const events = await sql<Array<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
      created_at: string;
    }>>`
      select id, type, payload, created_at
      from public.captain_flight_selection_events
      where goal_id = ${goal.id}
      order by created_at
    `;
    const brief = briefFromSelectionSpec(goal.spec);
    const snapshots = candidates
      .map((candidate) => snapshotFromOffer(candidate.offer, {
        providerOfferId: candidate.provider_offer_id,
        searchId: candidate.search_id,
        observedAt: candidate.observed_at,
        rank: candidate.rank,
        brief
      }))
      .filter((value): value is FlightSnapshot => value !== null);
    const decisionByOffer = new Map(candidates.map((candidate) => [candidate.provider_offer_id, candidate.decision]));
    const state = buildState({
      key: goal.workspace_key,
      brief,
      status: mapStatus(goal.status),
      version: Math.max(1, goal.version),
      cadenceHours: cadence(goal.spec),
      createdAt: goal.created_at,
      lastCheckAt: goal.searched_at,
      snapshots,
      reviewState(snapshot) {
        const decision = decisionByOffer.get(snapshot.providerOfferId);
        if (decision === "saved" || decision === "selected") return "retained";
        if (decision === "passed") return "dismissed";
        return "discovered";
      },
      activity: events.map((event) => ({
        id: event.id,
        kind: `imported.${event.type}`,
        message: eventMessage(event.type),
        createdAt: event.created_at,
        metadata: { ...event.payload, importedFrom: "captain" }
      })),
      lastError: goal.last_error
    });
    await persistImportedState(state, "captain_flight_selection_goals", goal.id, [
      ...candidates.map((candidate) => ({
        sourceTable: "captain_flight_selection_candidates",
        sourceId: candidate.id,
        targetType: "observation",
        targetId: deterministicUuid(`observation:${goal.workspace_key}:${candidate.provider_offer_id}:${candidate.observed_at}`)
      })),
      ...events.map((event) => ({
        sourceTable: "captain_flight_selection_events",
        sourceId: event.id,
        targetType: "activity",
        targetId: event.id
      }))
    ]);
    count += 1;
  }
  return count;
}

async function importWatches(): Promise<number> {
  const watches = await sql<Array<{
    id: string;
    request: Record<string, unknown>;
    status: string;
    next_check_at: string;
    last_error: string | null;
    created_at: string;
  }>>`
    select id, request, status, next_check_at, last_error, created_at
    from public.captain_flight_watches
    order by created_at
  `;
  let count = 0;
  for (const watch of watches) {
    if (await wasImported("captain_flight_watches", watch.id)) continue;
    const offers = await sql<Array<{
      id: string;
      observation_id: string;
      provider_offer_id: string;
      price: number | string;
      currency: string;
      airlines: string[];
      duration_seconds: number;
      stops: number;
      itinerary: Record<string, unknown>;
      searched_at: string;
      search_id: string;
    }>>`
      select o.id, o.observation_id, o.provider_offer_id, o.price, o.currency,
             o.airlines, o.duration_seconds, o.stops, o.itinerary,
             observation.searched_at, observation.search_id
      from public.captain_flight_offers o
      join public.captain_flight_observations observation on observation.id = o.observation_id
      where o.watch_id = ${watch.id}
      order by observation.searched_at, o.price
    `;
    const bookingIntents = await sql<Array<{
      id: string;
      candidate_id: string;
      status: string;
      created_at: string;
    }>>`
      select id, candidate_id, status, created_at
      from public.captain_flight_booking_intents
      where watch_id = ${watch.id}
      order by created_at
    `;
    const retainedOfferIds = new Set(bookingIntents
      .filter((intent) => !["failed", "cancelled"].includes(intent.status))
      .map((intent) => intent.candidate_id));
    const brief = briefFromWatchRequest(watch.request);
    const snapshots = offers
      .map((offer, index) => snapshotFromOffer({
        ...offer.itinerary,
        price: offer.price,
        currency: offer.currency,
        airlines: offer.airlines,
        durationSeconds: offer.duration_seconds,
        stops: offer.stops
      }, {
        providerOfferId: offer.provider_offer_id,
        searchId: offer.search_id,
        observedAt: offer.searched_at,
        rank: index + 1,
        brief
      }))
      .filter((value): value is FlightSnapshot => value !== null);
    const key = `fw_${watch.id.replaceAll("-", "").slice(0, 24)}`;
    const state = buildState({
      key,
      brief,
      status: mapStatus(watch.status),
      version: 1,
      cadenceHours: cadence(watch.request),
      createdAt: watch.created_at,
      lastCheckAt: offers.at(-1)?.searched_at ?? null,
      snapshots,
      reviewState: (snapshot) => offers.some((offer) =>
        offer.provider_offer_id === snapshot.providerOfferId && retainedOfferIds.has(offer.id)
      ) ? "retained" : "discovered",
      activity: [{
        id: deterministicUuid(`watch-activity:${watch.id}`),
        kind: "imported.watch",
        message: "Legacy Captain fare watch imported",
        createdAt: watch.created_at,
        metadata: { sourceWatchId: watch.id }
      }, ...bookingIntents.map((intent) => ({
        id: intent.id,
        kind: "imported.booking_intent",
        message: `Legacy booking intent · ${intent.status}`,
        createdAt: intent.created_at,
        metadata: { sourceOfferId: intent.candidate_id, importedFrom: "captain" }
      }))],
      lastError: watch.last_error
    });
    if (state.agent.status === "active") {
      state.agent = { ...state.agent, nextCheckAt: new Date().toISOString() };
    }
    const observationMappings = new Map(offers.map((offer) => [offer.observation_id, {
      sourceTable: "captain_flight_observations",
      sourceId: offer.observation_id,
      targetType: "check",
      targetId: deterministicUuid(`check:${key}:${offer.search_id}`)
    }]));
    await persistImportedState(state, "captain_flight_watches", watch.id, [
      ...offers.map((offer) => ({
        sourceTable: "captain_flight_offers",
        sourceId: offer.id,
        targetType: "observation",
        targetId: deterministicUuid(`observation:${key}:${offer.provider_offer_id}:${offer.searched_at}`)
      })),
      ...observationMappings.values(),
      ...bookingIntents.map((intent) => ({
        sourceTable: "captain_flight_booking_intents",
        sourceId: intent.id,
        targetType: "activity",
        targetId: intent.id
      }))
    ]);
    count += 1;
  }
  return count;
}

function buildState(options: {
  key: string;
  brief: FlightAgentBrief;
  status: FlightAgent["status"];
  version: number;
  cadenceHours: FlightAgent["cadenceHours"];
  createdAt: string;
  lastCheckAt: string | null;
  snapshots: FlightSnapshot[];
  reviewState(snapshot: FlightSnapshot): FlightWorkspaceItem["reviewState"];
  activity: AgentActivity[];
  lastError: string | null;
}): SerializedMemoryAgent {
  const grouped = new Map<string, FlightSnapshot[]>();
  for (const snapshot of options.snapshots) {
    const identity = identityKey(snapshot);
    grouped.set(identity, [...(grouped.get(identity) ?? []), snapshot]);
  }
  const flights: FlightWorkspaceItem[] = [];
  const observations: Array<[string, PriceObservation[]]> = [];
  const identityIds: Array<[string, string]> = [];
  const checksBySearch = new Map<string, AgentCheck>();
  for (const [identity, values] of grouped) {
    const ordered = [...values].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const latest = ordered.at(-1)!;
    const previous = ordered.at(-2);
    const flightId = deterministicUuid(`flight-agent:flight:${identity}`);
    identityIds.push([identity, flightId]);
    flights.push({
      id: flightId,
      itineraryKey: identity,
      destination: latest.destination,
      travelDate: latest.travelDate,
      marketingAirlineCode: latest.marketingAirlineCode,
      marketingAirline: latest.marketingAirline,
      reviewState: options.reviewState(latest),
      promotionReason: options.reviewState(latest) === "retained" ? "Saved in Captain before migration" : null,
      firstSeenAt: ordered[0]!.observedAt,
      lastSeenAt: latest.observedAt,
      latest,
      previousPrice: previous?.price ?? null,
      changePercent: previous ? ((latest.price - previous.price) / previous.price) * 100 : null,
      observationCount: ordered.length,
      trackedUntilAt: null,
      folderIds: []
    });
    observations.push([flightId, ordered.map((snapshot) => {
      const checkId = deterministicUuid(`check:${options.key}:${snapshot.providerSearchId}`);
      if (!checksBySearch.has(snapshot.providerSearchId)) {
        checksBySearch.set(snapshot.providerSearchId, importedCheck(checkId, snapshot));
      } else {
        const check = checksBySearch.get(snapshot.providerSearchId)!;
        checksBySearch.set(snapshot.providerSearchId, {
          ...check,
          offersFound: check.offersFound + 1,
          identitiesMatched: check.identitiesMatched + 1
        });
      }
      return { ...snapshot, id: deterministicUuid(`observation:${options.key}:${snapshot.providerOfferId}:${snapshot.observedAt}`), checkId };
    })]);
  }
  const active = options.status === "active" || options.status === "needs_attention";
  const agent: FlightAgent = {
    key: options.key,
    status: options.status,
    version: options.version,
    brief: options.brief,
    cadenceHours: options.cadenceHours,
    trackingWindowDays: 30,
    searchCursor: 0,
    browsePreferences: { sort: "recommended", stops: [], airlines: [], airports: [], cabins: [], maximumPrice: null, departurePeriods: [] },
    createdAt: options.createdAt,
    processingStartedAt: null,
    accumulatedProcessingMs: 0,
    lastCheckAt: options.lastCheckAt,
    nextCheckAt: active ? new Date().toISOString() : null,
    latestCheck: [...checksBySearch.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
  };
  const activity = options.lastError
    ? [{ id: deterministicUuid(`import-error:${options.key}`), kind: "imported.error", message: options.lastError, createdAt: options.lastCheckAt ?? options.createdAt, metadata: {} }, ...options.activity]
    : options.activity;
  return {
    agent,
    runningCheckId: null,
    failures: options.status === "needs_attention" ? 3 : 0,
    flights,
    identityIds,
    observations,
    checks: [...checksBySearch.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    activity,
    folders: [],
    memberships: []
  };
}

function importedCheck(id: string, snapshot: FlightSnapshot): AgentCheck {
  return {
    id,
    status: "completed",
    mode: "fare",
    trigger: "scheduled",
    startedAt: snapshot.observedAt,
    completedAt: snapshot.observedAt,
    matrix: [{ origin: snapshot.origin, destination: snapshot.destination, departureDate: snapshot.travelDate, returnDate: snapshot.returnDate }],
    searched: 1,
    offersFound: 1,
    identitiesMatched: 1,
    promotions: 0,
    duffelError: null,
    sourceRuns: [{
      source: "duffel",
      status: "completed",
      startedAt: snapshot.observedAt,
      completedAt: snapshot.observedAt,
      offersFound: 1,
      observationsSaved: 1,
      error: null
    }],
    research: null
  };
}

function snapshotFromOffer(
  offer: Record<string, unknown>,
  context: { providerOfferId: string; searchId: string; observedAt: string; rank: number; brief: FlightAgentBrief }
): FlightSnapshot | null {
  const outbound = record(offer.outbound);
  const segments = Array.isArray(outbound.segments) ? outbound.segments.map(record) : [];
  const first = segments[0];
  const last = segments.at(-1);
  const destination = string(first?.destination) || context.brief.destinationAirports[0];
  const departure = string(first?.departure) || `${context.brief.departureWindow.start}T00:00:00Z`;
  const airline = string(first?.airline) || firstString(offer.airlines) || string(offer.ownerAirline) || "Unknown";
  const flightNumber = string(first?.flightNumber) || "";
  const code = flightNumber.match(/^([A-Z0-9]{2,3})/i)?.[1]?.toUpperCase() || airline.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "UNK";
  const price = number(offer.price);
  if (!destination || price === null) return null;
  const importedSegments = segments.map((segment) => ({
    airlineCode: string(segment.airlineCode) || string(segment.flightNumber).match(/^([A-Z0-9]{2,3})/i)?.[1]?.toUpperCase() || code,
    airline: string(segment.airline) || airline,
    flightNumber: string(segment.flightNumber) || flightNumber || code,
    origin: string(segment.origin) || context.brief.originAirports[0]!,
    destination: string(segment.destination) || destination,
    departure: string(segment.departure) || departure,
    arrival: string(segment.arrival) || string(last?.arrival) || departure
  }));
  return {
    provider: "duffel",
    sourceName: "Duffel import",
    sourceUrl: null,
    bookingUrl: null,
    evidence: "direct",
    providerOfferId: context.providerOfferId,
    providerSearchId: context.searchId,
    observedAt: context.observedAt,
    origin: string(first?.origin) || context.brief.originAirports[0]!,
    destination,
    travelDate: departure.slice(0, 10),
    returnDate: context.brief.tripType === "round_trip" ? context.brief.departureWindow.end : null,
    marketingAirlineCode: code,
    marketingAirline: airline,
    flightNumber: flightNumber || code,
    route: string(offer.route) || string(outbound.route) || `${string(first?.origin)} → ${destination}`,
    departure,
    arrival: string(last?.arrival) || departure,
    durationSeconds: number(offer.durationSeconds) ?? number(outbound.durationSeconds) ?? 0,
    stops: number(offer.stops) ?? number(outbound.stops) ?? Math.max(0, segments.length - 1),
    cabin: context.brief.cabin,
    price,
    currency: string(offer.currency) || context.brief.currency,
    rank: context.rank,
    passengerCount: context.brief.travellers.adults + context.brief.travellers.childrenAges.length + context.brief.travellers.infants,
    segments: importedSegments.length > 0 ? importedSegments : [{
      airlineCode: code,
      airline,
      flightNumber: flightNumber || code,
      origin: string(first?.origin) || context.brief.originAirports[0]!,
      destination,
      departure,
      arrival: string(last?.arrival) || departure
    }],
    conditions: record(offer.conditions) as Record<string, string>
  };
}

function briefFromSelectionSpec(spec: Record<string, unknown>): FlightAgentBrief {
  const routes = Array.isArray(spec.routes) ? spec.routes.map(record) : [];
  const first = routes[0] ?? {};
  const last = routes.at(-1) ?? first;
  const departureDates = routes.map((route) => string(route.departureDate)).filter(Boolean).sort();
  const departure = departureDates[0] || new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const roundTrip = routes.length > 1 && string(last.destination) === string(first.origin);
  const returnDate = roundTrip ? string(last.departureDate) : null;
  const nights = returnDate ? Math.max(1, Math.round((Date.parse(returnDate) - Date.parse(departure)) / 86_400_000)) : null;
  return {
    originAirports: [string(first.origin) || "LHR"],
    destinationAirports: [string(first.destination) || "JFK"],
    tripType: roundTrip ? "round_trip" : "one_way",
    departureWindow: { start: departure, end: departure },
    stayNights: nights ? { minimum: nights, preferred: nights, maximum: nights } : null,
    travellers: {
      adults: number(spec.adults) ?? 1,
      childrenAges: Array.isArray(spec.childrenAges) ? spec.childrenAges.map(number).filter((value): value is number => value !== null).map((age) => Math.max(2, age)) : [],
      infants: 0
    },
    cabin: cabin(spec.cabin),
    maxStops: Math.min(2, number(spec.maxStops) ?? 2),
    currency: string(spec.currency) || "GBP",
    maximumPrice: number(spec.maxPrice),
    preferredAirlines: [],
    excludedAirlines: [],
    context: string(spec.objective)
  };
}

function briefFromWatchRequest(request: Record<string, unknown>): FlightAgentBrief {
  const departure = string(request.departureDate) || new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const returnDate = string(request.returnDate);
  const nights = returnDate ? Math.max(1, Math.round((Date.parse(returnDate) - Date.parse(departure)) / 86_400_000)) : null;
  return {
    originAirports: [string(request.origin) || "LHR"],
    destinationAirports: [string(request.destination) || "JFK"],
    tripType: returnDate ? "round_trip" : "one_way",
    departureWindow: { start: departure, end: departure },
    stayNights: nights ? { minimum: nights, preferred: nights, maximum: nights } : null,
    travellers: {
      adults: number(request.adults) ?? 1,
      childrenAges: Array.isArray(request.childrenAges) ? request.childrenAges.map(number).filter((value): value is number => value !== null).map((age) => Math.max(2, age)) : [],
      infants: 0
    },
    cabin: cabin(request.cabin),
    maxStops: Math.min(2, number(request.maxStops) ?? 2),
    currency: string(request.currency) || "GBP",
    maximumPrice: null,
    preferredAirlines: [],
    excludedAirlines: [],
    context: "Imported Captain fare watch"
  };
}

async function persistImportedState(
  state: SerializedMemoryAgent,
  sourceTable: string,
  sourceId: string,
  mappings: SourceMapping[] = []
): Promise<void> {
  const agent = state.agent;
  await sql.begin(async (transaction) => {
    await mirrorNormalizedState(transaction, state);
    await transaction`
      insert into flight_agent.agent_states (agent_key, state)
      values (${agent.key}, ${transaction.json(toJson(state))})
      on conflict (agent_key) do update set state = excluded.state, updated_at = now()
    `;
    await transaction`
      insert into flight_agent.source_imports (source_table, source_id, agent_key, target_type, target_id)
      values (${sourceTable}, ${sourceId}, ${agent.key}, 'agent', ${agent.key})
      on conflict (source_table, source_id) do nothing
    `;
    for (const mapping of mappings) {
      await transaction`
        insert into flight_agent.source_imports (
          source_table, source_id, agent_key, target_type, target_id
        ) values (
          ${mapping.sourceTable}, ${mapping.sourceId}, ${agent.key},
          ${mapping.targetType}, ${mapping.targetId}
        ) on conflict (source_table, source_id) do nothing
      `;
    }
  });
}

async function wasImported(sourceTable: string, sourceId: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    select exists (
      select 1 from flight_agent.source_imports
      where source_table = ${sourceTable} and source_id = ${sourceId}
    ) as present
  `;
  return rows[0]?.present ?? false;
}

function mapStatus(value: string): FlightAgent["status"] {
  if (value === "active") return "active";
  if (value === "needs_attention" || value === "failed") return "needs_attention";
  return "paused";
}

function identityKey(snapshot: FlightSnapshot): string {
  return snapshot.segments.map((segment) => [
    segment.airlineCode,
    segment.flightNumber,
    segment.origin,
    segment.destination,
    segment.departure,
    segment.arrival
  ].join(":"))
    .join("|");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function eventMessage(type: string): string {
  return ({
    "goal.created": "Flight selection goal imported",
    "search.completed": "Legacy search completed",
    "search.failed": "Legacy search failed",
    "candidate.saved": "Flight saved in Captain",
    "candidate.selected": "Flight selected in Captain"
  } as Record<string, string>)[type] ?? type.replaceAll(".", " ");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function firstString(value: unknown): string { return Array.isArray(value) && typeof value[0] === "string" ? value[0] : ""; }
function cabin(value: unknown): FlightAgentBrief["cabin"] { return ["economy", "premium_economy", "business", "first"].includes(string(value)) ? string(value) as FlightAgentBrief["cabin"] : "economy"; }
function cadence(value: Record<string, unknown>): FlightAgent["cadenceHours"] {
  const parsed = number(value.cadenceHours) ?? number(value.intervalHours) ?? 6;
  return [1, 6, 12, 24].includes(parsed) ? parsed as FlightAgent["cadenceHours"] : 6;
}
function toJson(value: unknown): never { return JSON.parse(JSON.stringify(value)) as never; }
