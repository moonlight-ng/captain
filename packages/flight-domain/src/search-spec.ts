import { createHash } from "node:crypto";

import type { FlightSearchProviderId } from "./provider.js";
import type { TripBrief } from "./trip.js";

export type SearchSlice = {
  originAirports: string[];
  destinationAirports: string[];
  departureStart: string;
  departureEnd: string;
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

const METROPOLITAN_AIRPORTS: Readonly<Record<string, readonly string[]>> = {
  LON: ["LHR", "LGW", "LCY", "STN", "LTN"],
  NYC: ["JFK", "EWR", "LGA"],
  PAR: ["CDG", "ORY"],
  TYO: ["HND", "NRT"]
};

export function buildSearchSpecs(brief: TripBrief, _liveMode = true): SearchSpec[] {
  const slices: SearchSlice[] = brief.tripType === "multi_city"
    ? (brief.legs ?? []).map((leg) => ({
        originAirports: expandMetropolitanAirports(leg.originAirports),
        destinationAirports: expandMetropolitanAirports(leg.destinationAirports),
        departureStart: leg.departureWindow.start,
        departureEnd: leg.departureWindow.end
      }))
    : [{
        originAirports: expandMetropolitanAirports(brief.originAirports),
        destinationAirports: expandMetropolitanAirports(brief.destinationAirports),
        departureStart: brief.departureWindow.start,
        departureEnd: brief.departureWindow.end
      }];
  const request: SearchSpecRequest = {
    provider: "openai_web",
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

export function expandMetropolitanAirports(codes: string[]): string[] {
  return [...new Set(codes.flatMap((code) => METROPOLITAN_AIRPORTS[code] ?? [code]))];
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
