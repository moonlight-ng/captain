import { createHash } from "node:crypto";

import type { FlightSearchProviderId } from "./provider.js";
import type { TripBrief } from "./trip.js";

export type SearchSlice = {
  originAirports: string[];
  destinationAirports: string[];
  departureStart: string;
  departureEnd: string;
  /** Latest acceptable local arrival date for this slice. */
  arriveBy?: string | null;
};

export type SearchSpecRequest = {
  provider: FlightSearchProviderId;
  apiVersion: "v1";
  tripType: TripBrief["tripType"];
  slices: SearchSlice[];
  stayNights: TripBrief["stayNights"];
  passenger: { adults: 1; childrenAges: []; infants: 0 };
  cabin: TripBrief["cabin"];
  maxConnections: number;
  currency: string;
  maximumPrice: number | null;
  fareContext: "public_beta";
};

export type SearchSpec = {
  id: string;
  key: string;
  request: SearchSpecRequest;
};

export type SearchRun = {
  id: string;
  searchSpecId: string;
  status: "queued" | "running" | "completed" | "failed" | "deferred";
  attempt: number;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  providerRequestId: string | null;
  error: string | null;
};

export function buildSearchSpecs(brief: TripBrief, _liveMode = true): SearchSpec[] {
  const slices: SearchSlice[] = brief.tripType === "multi_city"
    ? (brief.legs ?? []).map((leg) => ({
        originAirports: leg.originAirports,
      destinationAirports: leg.destinationAirports,
      departureStart: leg.departureWindow.start,
      departureEnd: leg.departureWindow.end,
      ...(leg.arriveBy ? { arriveBy: leg.arriveBy } : {})
      }))
    : [{
        originAirports: brief.originAirports,
        destinationAirports: brief.destinationAirports,
        departureStart: brief.departureWindow.start,
        departureEnd: brief.departureWindow.end
      }];
  const request: SearchSpecRequest = {
    provider: "official_duffel",
    apiVersion: "v1",
    tripType: brief.tripType,
    slices,
    stayNights: brief.stayNights,
    passenger: { adults: 1, childrenAges: [], infants: 0 },
    cabin: brief.cabin,
    maxConnections: brief.maxStops,
    currency: brief.currency,
    maximumPrice: brief.maximumPrice,
    fareContext: "public_beta"
  };
  const key = searchSpecKey(request);
  return [{ id: key, key, request }];
}

export function searchSpecKey(request: SearchSpecRequest): string {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
