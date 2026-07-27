import type {
  FlightSearchProviderId,
  SearchSpecRequest,
  VerifiedOfferCandidate
} from "@agents/flight-domain";

export type WebSearchRejectionReason =
  | "invalid_json"
  | "invalid_schema"
  | "route_mismatch"
  | "date_mismatch"
  | "segment_mismatch"
  | "currency_mismatch"
  | "fare_basis_mismatch"
  | "cabin_mismatch"
  | "stop_limit"
  | "price_limit"
  | "unapproved_source"
  | "source_not_retrieved"
  | "two_pass_mismatch";

export type WebSearchResult = {
  requestId: string;
  discoveryResponseId: string;
  verificationResponseId: string;
  model: string;
  promptVersion: string;
  offers: VerifiedOfferCandidate[];
  rejectionCounts: Partial<Record<WebSearchRejectionReason, number>>;
  webSearchCalls: number;
};

export interface FlightSearchProvider {
  readonly provider: FlightSearchProviderId;
  search(request: SearchSpecRequest): Promise<WebSearchResult>;
}
