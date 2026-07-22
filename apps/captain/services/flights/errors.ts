import type { FlightProviderErrorCode } from "./provider.js";

const hints: Record<FlightProviderErrorCode, string> = {
  unauthorized: "Check DUFFEL_ACCESS_TOKEN and its environment.",
  invalid_request: "Check airports, passenger ages, cabin, and ISO travel dates.",
  rate_limited: "Duffel rate-limited this check; the agent will respect Retry-After.",
  timeout: "Duffel did not complete before the configured search timeout.",
  provider_unavailable: "Duffel is currently unavailable or not configured.",
  invalid_response: "Duffel returned an unexpected response shape."
};

export function formatFlightError(code: FlightProviderErrorCode, detail?: string) {
  return { code, detail: detail ?? null, hint: hints[code] };
}
