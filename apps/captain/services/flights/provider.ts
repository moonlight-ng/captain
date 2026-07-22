import type { FlightSearchRequest, FlightSearchResult } from "./types.js";

export type FlightProviderErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "invalid_response";

export class FlightProviderError extends Error {
  constructor(
    readonly code: FlightProviderErrorCode,
    readonly detail?: string,
    readonly retryAfterMs?: number
  ) {
    super(detail ?? `Duffel request failed: ${code}`);
    this.name = "FlightProviderError";
  }
}

export type FlightSearchClient = {
  readonly provider: "duffel";
  search(input: FlightSearchRequest, signal?: AbortSignal): Promise<FlightSearchResult>;
};
