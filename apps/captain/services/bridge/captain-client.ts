import type { FlightAgentBrief, FlightSnapshot, ResearchResult } from "../domain/types.js";
import { signBridgeRequest } from "./signature.js";

export type CaptainResearchInput = {
  agentKey: string;
  checkId: string;
  brief: FlightAgentBrief;
  flights: FlightSnapshot[];
  movements: Array<{
    destination: string;
    travelDate: string;
    marketingAirline: string;
    currentPrice: number;
    previousPrice: number | null;
    currency: string;
    changePercent: number | null;
  }>;
};

export type CaptainResearchClient = {
  research(input: CaptainResearchInput): Promise<ResearchResult>;
};

export class HttpCaptainResearchClient implements CaptainResearchClient {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    baseUrl: string;
    secret: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 660_000;
  }

  async research(input: CaptainResearchInput): Promise<ResearchResult> {
    const startedAt = Date.now();
    const path = "/internal/v1/codex/research";
    const body = JSON.stringify(buildResearchRequest(input));
    const signed = signBridgeRequest({ secret: this.#secret, method: "POST", path, body });
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bridge-timestamp": signed.timestamp,
          "x-bridge-signature": signed.signature,
          "idempotency-key": input.checkId
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
      if (!response.ok) {
        throw new CaptainResearchError(response.status);
      }
      const payload = await response.json() as {
        result: {
          searchedAt: string;
          overview: string;
          results: ResearchResult["results"];
          offers: ResearchResult["offers"];
          gaps: string[];
        };
        metadata: NonNullable<ResearchResult["metadata"]>;
      };
      logResearchBridge(input, "success", Date.now() - startedAt);
      return {
        status: "completed",
        searchedAt: payload.result.searchedAt,
        overview: payload.result.overview,
        results: payload.result.results,
        offers: payload.result.offers ?? [],
        gaps: payload.result.gaps,
        error: null,
        metadata: payload.metadata
      };
    } catch (error) {
      logResearchBridge(
        input,
        "failed",
        Date.now() - startedAt,
        error instanceof CaptainResearchError
          ? `HTTP_${error.status}`
          : error instanceof Error
            ? error.name
            : "UnknownError"
      );
      throw error;
    }
  }
}

class CaptainResearchError extends Error {
  constructor(readonly status: number) {
    super(`Captain research failed with HTTP ${status}`);
    this.name = "CaptainResearchError";
  }
}

function logResearchBridge(
  input: CaptainResearchInput,
  status: "success" | "failed",
  durationMs: number,
  errorCode?: string
): void {
  console.info(JSON.stringify({
    service: "flight-agent",
    agent_id: "flight-agent",
    event: "captain.codex_research",
    run_id: input.checkId,
    status,
    duration_ms: durationMs,
    error_code: errorCode ?? null,
    agent_key: input.agentKey
  }));
}

export class DisabledCaptainResearchClient implements CaptainResearchClient {
  async research(): Promise<ResearchResult> {
    return {
      status: "failed",
      searchedAt: new Date().toISOString(),
      overview: null,
      results: [],
      offers: [],
      gaps: [],
      error: "Captain Codex bridge is not configured",
      metadata: null
    };
  }
}

export function buildResearchRequest(input: CaptainResearchInput) {
  const partySize = input.brief.travellers.adults + input.brief.travellers.childrenAges.length + input.brief.travellers.infants;
  const routes = input.brief.originAirports.flatMap((origin) =>
    input.brief.destinationAirports.map((destination) => `${origin}-${destination}`)
  );
  const returnPlan = input.brief.tripType === "round_trip"
    ? `round trip returning after ${input.brief.stayNights?.preferred ?? 0} nights`
    : "one way";
  return {
    agentKey: input.agentKey,
    checkId: input.checkId,
    request: {
      topic: `Compare live ${input.brief.cabin} flight prices for ${routes.join(", ")} departing ${input.brief.departureWindow.start} to ${input.brief.departureWindow.end}, ${returnPlan}, ${partySize} passenger${partySize === 1 ? "" : "s"}, total in ${input.brief.currency}`.slice(0, 500),
      objective: "compare",
      questions: [
        "What exact-date bookable offers are currently displayed by Skyscanner or the linked seller for these constraints?",
        "For each supported offer, what are the complete flight numbers, segment times, total party price, cabin, baggage, fare conditions, and direct result or booking URL?",
        "Are there current airline, airport, route, schedule, or fee changes that materially affect comparison?"
      ],
      freshness: "live",
      preferredDomains: ["skyscanner.net"],
      maxResults: 10
    },
    publicContext: {
      origins: input.brief.originAirports,
      destinations: input.brief.destinationAirports,
      departureWindow: input.brief.departureWindow,
      cabin: input.brief.cabin,
      maxStops: input.brief.maxStops,
      partySize,
      currency: input.brief.currency,
      observedFlights: input.flights.slice(0, 12).map((flight) => ({
        route: flight.route,
        airline: flight.marketingAirline,
        departure: flight.departure,
        arrival: flight.arrival,
        stops: flight.stops
      })),
      fareMovements: input.movements.slice(0, 12)
    }
  };
}
