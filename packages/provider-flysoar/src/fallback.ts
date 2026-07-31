import {
  FlightSearchProviderError,
  type FlightSearchProvider,
  type FlightSearchProviderId,
  type FlightSearchResult,
  type SearchSpecRequest
} from "@agents/flight-domain";

export class FallbackFlightSearchProvider implements FlightSearchProvider {
  readonly provider: FlightSearchProviderId;
  readonly #primary: FlightSearchProvider;
  readonly #fallback: FlightSearchProvider;

  constructor(options: {
    primary: FlightSearchProvider;
    fallback: FlightSearchProvider;
  }) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.provider = options.primary.provider;
  }

  async search(request: SearchSpecRequest): Promise<FlightSearchResult> {
    let primaryResult: FlightSearchResult | null = null;
    let primaryError: unknown;
    try {
      primaryResult = await this.#primary.search({
        ...request,
        provider: this.#primary.provider
      });
      if (primaryResult.offers.length > 0) return primaryResult;
    } catch (error) {
      primaryError = error;
    }

    try {
      return await this.#fallback.search({
        ...request,
        provider: this.#fallback.provider
      });
    } catch (fallbackError) {
      if (primaryResult) return primaryResult;
      if (fallbackError instanceof FlightSearchProviderError) {
        const primaryMessage = primaryError instanceof Error
          ? primaryError.message
          : "Primary provider failed";
        throw new FlightSearchProviderError(
          fallbackError.provider,
          fallbackError.code,
          `${primaryMessage}; Flysoar fallback failed: ${fallbackError.message}`,
          fallbackError.retryAfterMs
        );
      }
      throw fallbackError;
    }
  }
}
