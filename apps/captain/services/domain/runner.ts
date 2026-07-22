import type { CaptainResearchClient } from "../bridge/captain-client.js";
import { marketingAirlineCode, offerMatchesAirlines } from "../flights/airlines.js";
import { FlightProviderError, type FlightSearchClient } from "../flights/provider.js";
import type { FlightOffer } from "../flights/types.js";
import type {
  ClaimedCheck,
  FlightAgentStore,
  CheckTrigger
} from "../store/contracts.js";
import { buildSearchMatrix } from "./search-matrix.js";
import type {
  FlightAgentBrief,
  FlightSnapshot,
  CheckMode,
  ResearchResult,
  SearchCombination
} from "./types.js";

const FIRST_PASS_SEARCH_COMBINATIONS = 1;
const BACKFILL_SEARCH_COMBINATIONS = 6;
const BACKFILL_DELAY_MS = 30_000;

export type StartedFlightCheck = {
  checkId: string;
  completion: Promise<void>;
};

export class FlightAgentRunner {
  readonly #store: FlightAgentStore;
  readonly #flights: FlightSearchClient | null;
  readonly #research: CaptainResearchClient;
  readonly #now: () => Date;
  readonly #running = new Set<string>();

  constructor(options: {
    store: FlightAgentStore;
    flights: FlightSearchClient | null;
    research: CaptainResearchClient;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#flights = options.flights;
    this.#research = options.research;
    this.#now = options.now ?? (() => new Date());
  }

  async start(
    agentKey: string,
    trigger: CheckTrigger,
    force = false,
    mode: CheckMode = "fare"
  ): Promise<StartedFlightCheck | null> {
    if (this.#running.has(agentKey)) return null;
    this.#running.add(agentKey);
    try {
      const startedAt = this.#now();
      const claimed = await this.#store.claimCheck(agentKey, trigger, mode, force, startedAt);
      if (!claimed) {
        this.#running.delete(agentKey);
        return null;
      }
      const completion = this.#execute(claimed).finally(() => {
        this.#running.delete(agentKey);
      });
      return { checkId: claimed.check.id, completion };
    } catch (error) {
      this.#running.delete(agentKey);
      throw error;
    }
  }

  async run(
    agentKey: string,
    trigger: CheckTrigger,
    force = false,
    mode: CheckMode = "fare"
  ): Promise<boolean> {
    const started = await this.start(agentKey, trigger, force, mode);
    if (!started) return false;
    await started.completion;
    return true;
  }

  async #execute(claimed: ClaimedCheck): Promise<void> {
    const agentKey = claimed.agent.key;
    const startedAt = Date.parse(claimed.check.startedAt);
    try {
      const searchLimit = claimed.check.trigger === "scheduled"
        ? BACKFILL_SEARCH_COMBINATIONS
        : FIRST_PASS_SEARCH_COMBINATIONS;
      const { matrix, nextCursor, total } = buildSearchMatrix(
        claimed.agent.brief,
        claimed.agent.searchCursor,
        searchLimit
      );
      console.info(JSON.stringify({
        service: "flight-agent",
        agent_id: "flight-agent",
        event: "flight_agent.check_started",
        run_id: claimed.check.id,
        status: "running",
        duration_ms: 0,
        error_code: null,
        agent_key: agentKey,
        mode: claimed.check.mode,
        trigger: claimed.check.trigger,
        combinations: matrix.length,
        totalCombinations: total
      }));
      const researchPromise = claimed.check.mode === "fare_and_research"
        ? safeResearch(this.#research, {
            agentKey: claimed.agent.key,
            checkId: claimed.check.id,
            brief: claimed.agent.brief,
            flights: [],
            movements: []
          })
        : Promise.resolve(null);
      let searchResults: Array<{
        combination: SearchCombination;
        result: Awaited<ReturnType<FlightSearchClient["search"]>>;
      }> = [];
      let duffelError: unknown = null;
      if (this.#flights) {
        try {
        // Duffel's test and live buckets are burst-sensitive. A matrix is small
        // and bounded, so serial execution is the safest deterministic default.
          searchResults = await mapWithConcurrency(matrix, 1, async (combination) => ({
            combination,
            result: await this.#flights!.search(toSearchRequest(claimed.agent.brief, combination))
          }));
        } catch (error) {
          duffelError = error;
        }
      } else {
        duffelError = new FlightProviderError("provider_unavailable", "DUFFEL_ACCESS_TOKEN is not configured");
      }

      const duffelOffersFound = searchResults.reduce((sum, item) => sum + item.result.totalResults, 0);
      const duffelSnapshots = normalizeSnapshots(claimed.agent.brief, searchResults);
      await this.#store.recordCheckSource(claimed.agent.key, claimed.check.id, {
        source: "duffel",
        status: duffelError ? "failed" : "completed",
        snapshots: duffelSnapshots,
        searched: searchResults.length,
        offersFound: duffelOffersFound,
        error: duffelError instanceof Error ? duffelError.message : duffelError ? "Duffel failed" : null,
        research: null
      }, this.#now());

      const research = await researchPromise;
      const codexSnapshots = research
        ? researchSnapshots(claimed.agent.brief, claimed.check.id, research)
        : [];
      if (research) {
        await this.#store.recordCheckSource(claimed.agent.key, claimed.check.id, {
          source: "codex_web",
          status: research.status,
          snapshots: codexSnapshots,
          searched: research.status === "completed" ? 1 : 0,
          offersFound: research.offers.length,
          error: research.error,
          research
        }, this.#now());
      }

      if (duffelError && (!research || research.status === "failed")) {
        await this.#fail(claimed.agent.key, claimed.check.id, matrix, nextCursor, duffelError);
        return;
      }

      try {
        const completedAt = this.#now();
        await this.#store.completeCheck(claimed.agent.key, claimed.check.id, {
          matrix,
          snapshots: [],
          searchCursor: nextCursor,
          searched: searchResults.length + (research?.status === "completed" ? 1 : 0),
          offersFound: duffelOffersFound + (research?.offers.length ?? 0),
          identitiesMatched: duffelSnapshots.length + codexSnapshots.length,
          research,
          status: duffelError || research?.status === "failed" ? "partial" : "completed",
          duffelError: duffelError instanceof Error ? duffelError.message : null,
          nextCheckAt: new Date(completedAt.getTime() + nextCheckDelayMs({
            cadenceHours: claimed.agent.cadenceHours,
            currentCursor: claimed.agent.searchCursor,
            nextCursor,
            searched: matrix.length,
            total
          })).toISOString()
        }, completedAt);
        console.info(JSON.stringify({
          service: "flight-agent",
          agent_id: "flight-agent",
          event: "flight_agent.check_completed",
          run_id: claimed.check.id,
          status: duffelError || research?.status === "failed" ? "partial" : "success",
          duration_ms: Math.max(0, Date.now() - startedAt),
          error_code: duffelError ? "DuffelFailed" : research?.status === "failed" ? "ResearchFailed" : null,
          agent_key: agentKey,
          mode: claimed.check.mode,
          combinations: searchResults.length,
          offersFound: duffelOffersFound + (research?.offers.length ?? 0),
          identities: duffelSnapshots.length + codexSnapshots.length,
          research: research?.status ?? "not_requested"
        }));
      } catch (error) {
        await this.#fail(claimed.agent.key, claimed.check.id, matrix, nextCursor, error);
      }
    } catch (error) {
      console.error(JSON.stringify({
        service: "flight-agent",
        agent_id: "flight-agent",
        event: "flight_agent.check_crashed",
        run_id: claimed.check.id,
        status: "failed",
        duration_ms: Math.max(0, Date.now() - startedAt),
        error_code: error instanceof Error ? error.name : "UnknownError",
        agent_key: agentKey
      }));
      throw error;
    }
  }

  async #fail(
    agentKey: string,
    checkId: string,
    matrix: SearchCombination[],
    searchCursor: number,
    error: unknown
  ): Promise<void> {
    const now = this.#now();
    const workspace = await this.#store.getWorkspace(agentKey);
    const previousFailures = workspace?.recentChecks
      .filter((check) => check.id !== checkId)
      .findIndex((check) => check.status !== "failed") ?? -1;
    const failureCount = previousFailures < 0
      ? (workspace?.recentChecks.filter((check) => check.status === "failed").length ?? 0) + 1
      : previousFailures + 1;
    const backoff = [5, 15, 60][Math.min(failureCount - 1, 2)]! * 60_000;
    const retryAfter = error instanceof FlightProviderError ? error.retryAfterMs : undefined;
    const nextCheckAt = new Date(now.getTime() + Math.max(backoff, retryAfter ?? 0)).toISOString();
    const message = error instanceof Error ? error.message : "Unknown Duffel failure";
    await this.#store.failCheck(agentKey, checkId, {
      error: message,
      matrix,
      searchCursor,
      nextCheckAt
    }, now);
    console.error(JSON.stringify({
      service: "flight-agent",
      agent_id: "flight-agent",
      event: "flight_agent.check_failed",
      run_id: checkId,
      status: "failed",
      duration_ms: Math.max(0, now.getTime() - (workspace?.agent.latestCheck?.startedAt ? Date.parse(workspace.agent.latestCheck.startedAt) : now.getTime())),
      error_code: error instanceof FlightProviderError ? error.code : error instanceof Error ? error.name : "UnknownError",
      agent_key: agentKey,
      nextCheckAt
    }));
  }
}

function nextCheckDelayMs(input: {
  cadenceHours: number;
  currentCursor: number;
  nextCursor: number;
  searched: number;
  total: number;
}): number {
  if (input.total === 0 || input.searched >= input.total) {
    return input.cadenceHours * 3_600_000;
  }
  const currentCursor = ((input.currentCursor % input.total) + input.total) % input.total;
  const completedSweep = input.nextCursor <= currentCursor;
  return completedSweep
    ? input.cadenceHours * 3_600_000
    : BACKFILL_DELAY_MS;
}

function toSearchRequest(brief: FlightAgentBrief, combination: SearchCombination) {
  return {
    origin: combination.origin,
    destination: combination.destination,
    departureDate: combination.departureDate,
    ...(combination.returnDate ? { returnDate: combination.returnDate } : {}),
    adults: brief.travellers.adults,
    childrenAges: [...brief.travellers.childrenAges],
    infants: brief.travellers.infants,
    cabin: brief.cabin,
    maxStops: brief.maxStops,
    currency: brief.currency,
    limit: 50,
    sort: "price" as const
  };
}

function normalizeSnapshots(
  brief: FlightAgentBrief,
  searches: Array<{ combination: SearchCombination; result: Awaited<ReturnType<FlightSearchClient["search"]>> }>
): FlightSnapshot[] {
  const candidates: FlightSnapshot[] = [];
  for (const { combination, result } of searches) {
    for (const offer of result.offers) {
      if (offer.stops > brief.maxStops * offer.routes.length) continue;
      if (brief.maximumPrice !== null && offer.price > brief.maximumPrice) continue;
      if (!offerMatchesAirlines(offer, [], brief.excludedAirlines)) continue;
      candidates.push(toSnapshot(brief, combination, result.searchId, result.searchedAt, offer));
    }
  }
  candidates.sort((left, right) => recommendationScore(brief, left) - recommendationScore(brief, right));
  const unique = new Map<string, FlightSnapshot>();
  for (const candidate of candidates) {
    const key = candidate.segments.map((segment) =>
      `${segment.flightNumber}|${segment.origin}|${segment.destination}|${segment.departure}|${segment.arrival}`
    ).join("|");
    const current = unique.get(key);
    if (!current || candidate.price < current.price ||
      (candidate.price === current.price && candidate.durationSeconds < current.durationSeconds)) {
      unique.set(key, candidate);
    }
  }
  const ranked = [...unique.values()].sort((left, right) =>
    recommendationScore(brief, left) - recommendationScore(brief, right)
  );
  const groupRanks = new Map<string, number>();
  return ranked.map((snapshot) => {
    const group = `${snapshot.destination}|${snapshot.travelDate}|${snapshot.cabin}`;
    const rank = (groupRanks.get(group) ?? 0) + 1;
    groupRanks.set(group, rank);
    return { ...snapshot, rank };
  });
}

function toSnapshot(
  brief: FlightAgentBrief,
  combination: SearchCombination,
  searchId: string,
  searchedAt: string,
  offer: FlightOffer
): FlightSnapshot {
  const first = offer.outbound.segments[0];
  const last = offer.outbound.segments.at(-1);
  const code = marketingAirlineCode(offer);
  return {
    provider: "duffel",
    sourceName: "Duffel",
    sourceUrl: null,
    bookingUrl: null,
    evidence: "direct",
    providerOfferId: offer.id,
    providerSearchId: searchId,
    observedAt: searchedAt,
    origin: combination.origin,
    destination: combination.destination,
    travelDate: combination.departureDate,
    returnDate: combination.returnDate,
    marketingAirlineCode: code,
    marketingAirline: first?.airline ?? offer.ownerAirline,
    flightNumber: first?.flightNumber ?? code,
    route: offer.route,
    departure: first?.departure ?? `${combination.departureDate}T00:00:00`,
    arrival: last?.arrival ?? `${combination.departureDate}T00:00:00`,
    durationSeconds: offer.durationSeconds,
    stops: offer.stops,
    cabin: brief.cabin,
    price: offer.price,
    currency: offer.currency,
    rank: 0,
    passengerCount: brief.travellers.adults + brief.travellers.childrenAges.length + brief.travellers.infants,
    segments: offer.routes.flatMap((route) => route.segments.map((segment) => ({
      airlineCode: segment.airlineCode,
      airline: segment.airline,
      flightNumber: segment.flightNumber,
      origin: segment.origin,
      destination: segment.destination,
      departure: segment.departure,
      arrival: segment.arrival
    }))),
    conditions: offer.conditions
  };
}

function researchSnapshots(
  brief: FlightAgentBrief,
  checkId: string,
  research: ResearchResult
): FlightSnapshot[] {
  const partySize = brief.travellers.adults + brief.travellers.childrenAges.length + brief.travellers.infants;
  return research.offers
    .filter((offer) =>
      offer.passengerCount === partySize &&
      offer.cabin === brief.cabin &&
      offer.currency === brief.currency &&
      offer.stops <= brief.maxStops * (offer.returnDate ? 2 : 1) &&
      (brief.maximumPrice === null || offer.price <= brief.maximumPrice) &&
      !brief.excludedAirlines.includes(offer.marketingAirlineCode) &&
      brief.originAirports.includes(offer.origin) &&
      brief.destinationAirports.includes(offer.destination) &&
      offer.travelDate >= brief.departureWindow.start &&
      offer.travelDate <= brief.departureWindow.end &&
      matchesReturnPlan(brief, offer.travelDate, offer.returnDate)
    )
    .map((offer, index) => ({
      provider: "codex_web" as const,
      sourceName: offer.sourceName,
      sourceUrl: offer.sourceUrl,
      bookingUrl: offer.bookingUrl,
      evidence: offer.evidence,
      providerOfferId: `${index + 1}:${offer.sourceUrl}`,
      providerSearchId: checkId,
      observedAt: research.searchedAt,
      origin: offer.origin,
      destination: offer.destination,
      travelDate: offer.travelDate,
      returnDate: offer.returnDate,
      marketingAirlineCode: offer.marketingAirlineCode,
      marketingAirline: offer.marketingAirline,
      flightNumber: offer.flightNumber,
      route: offer.route,
      departure: offer.departure,
      arrival: offer.arrival,
      durationSeconds: offer.durationSeconds,
      stops: offer.stops,
      cabin: offer.cabin,
      price: offer.price,
      currency: offer.currency,
      rank: index + 1,
      passengerCount: offer.passengerCount,
      segments: offer.segments,
      conditions: {
        ...(offer.baggage ? { baggage: offer.baggage } : {}),
        ...(offer.fareConditions ? { fare: offer.fareConditions } : {})
      }
    }));
}

function matchesReturnPlan(
  brief: FlightAgentBrief,
  travelDate: string,
  returnDate: string | null
): boolean {
  if (brief.tripType === "one_way") return returnDate === null;
  if (!returnDate || !brief.stayNights) return false;
  const stay = Math.round((Date.parse(`${returnDate}T00:00:00Z`) - Date.parse(`${travelDate}T00:00:00Z`)) / 86_400_000);
  return stay >= brief.stayNights.minimum && stay <= brief.stayNights.maximum;
}

function recommendationScore(brief: FlightAgentBrief, flight: FlightSnapshot): number {
  const preferred = brief.preferredAirlines.includes(flight.marketingAirlineCode) ? -100_000 : 0;
  return preferred + flight.price * 100 + flight.durationSeconds / 60 + flight.stops * 5_000;
}

async function safeResearch(
  client: CaptainResearchClient,
  input: Parameters<CaptainResearchClient["research"]>[0]
): Promise<ResearchResult> {
  try {
    return await client.research(input);
  } catch (error) {
    return {
      status: "failed",
      searchedAt: new Date().toISOString(),
      overview: null,
      results: [],
      offers: [],
      gaps: [],
      error: error instanceof Error ? error.message : "Captain Codex research failed",
      metadata: null
    };
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await transform(values[index]!);
    }
  }));
  return results;
}
