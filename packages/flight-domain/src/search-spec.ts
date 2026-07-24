import { createHash } from "node:crypto";

import type { TripBrief } from "./trip.js";
import { MAX_SEARCH_COMBINATIONS } from "./trip.js";

export type SearchSlice = { origin: string; destination: string; departureDate: string };

export type SearchSpecRequest = {
  provider: "duffel";
  apiVersion: "v2";
  liveMode: boolean;
  slices: SearchSlice[];
  passengers: Array<{ type: "adult" | "infant_without_seat" } | { age: number }>;
  cabin: TripBrief["cabin"];
  maxConnections: number;
  fareContext: string;
};

export type SearchSpec = {
  id: string;
  key: string;
  request: SearchSpecRequest;
};

export type SearchRun = {
  id: string;
  searchSpecId: string;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  providerRequestId: string | null;
  error: string | null;
};

export function buildSearchSpecs(brief: TripBrief, liveMode: boolean): SearchSpec[] {
  if (brief.tripType === "multi_city") {
    return multiCityRequests(brief, liveMode).map((request) => {
      const key = searchSpecKey(request);
      return { id: key, key, request };
    });
  }
  const dates = centerOut(dateRange(brief.departureWindow.start, brief.departureWindow.end));
  const stayLengths = brief.tripType === "round_trip" && brief.stayNights
    ? unique([brief.stayNights.preferred, brief.stayNights.minimum, brief.stayNights.maximum])
    : [null];
  const requests: SearchSpecRequest[] = [];
  for (const departureDate of dates) {
    for (const destination of brief.destinationAirports) {
      for (const origin of brief.originAirports) {
        for (const nights of stayLengths) {
          const slices: SearchSlice[] = [{ origin, destination, departureDate }];
          if (nights !== null) {
            slices.push({ origin: destination, destination: origin, departureDate: addDays(departureDate, nights) });
          }
          requests.push({
            provider: "duffel",
            apiVersion: "v2",
            liveMode,
            slices,
            passengers: [
              ...Array.from({ length: brief.travellers.adults }, () => ({ type: "adult" as const })),
              ...brief.travellers.childrenAges.map((age) => ({ age })),
              ...Array.from({ length: brief.travellers.infants }, () => ({ type: "infant_without_seat" as const }))
            ],
            cabin: brief.cabin,
            maxConnections: brief.maxStops,
            fareContext: "public"
          });
        }
      }
    }
  }
  return requests.slice(0, MAX_SEARCH_COMBINATIONS).map((request) => {
    const key = searchSpecKey(request);
    return { id: key, key, request };
  });
}

function multiCityRequests(brief: TripBrief, liveMode: boolean): SearchSpecRequest[] {
  const requests: SearchSpecRequest[] = [];
  const legs = brief.legs ?? [];
  const passengers = [
    ...Array.from({ length: brief.travellers.adults }, () => ({ type: "adult" as const })),
    ...brief.travellers.childrenAges.map((age) => ({ age })),
    ...Array.from({ length: brief.travellers.infants }, () => ({ type: "infant_without_seat" as const }))
  ];

  const visit = (legIndex: number, slices: SearchSlice[]): void => {
    if (requests.length >= MAX_SEARCH_COMBINATIONS) return;
    if (legIndex === legs.length) {
      requests.push({
        provider: "duffel",
        apiVersion: "v2",
        liveMode,
        slices,
        passengers,
        cabin: brief.cabin,
        maxConnections: brief.maxStops,
        fareContext: "public"
      });
      return;
    }
    const leg = legs[legIndex]!;
    const previous = slices.at(-1);
    for (const departureDate of centerOut(dateRange(leg.departureWindow.start, leg.departureWindow.end))) {
      if (previous && departureDate < previous.departureDate) continue;
      for (const destination of leg.destinationAirports) {
        for (const origin of leg.originAirports) {
          if (previous && previous.destination !== origin) continue;
          visit(legIndex + 1, [...slices, { origin, destination, departureDate }]);
          if (requests.length >= MAX_SEARCH_COMBINATIONS) return;
        }
      }
    }
  };

  visit(0, []);
  return requests;
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

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (
    let current = new Date(`${start}T00:00:00.000Z`);
    current.getTime() <= Date.parse(`${end}T00:00:00.000Z`);
    current = new Date(current.getTime() + 86_400_000)
  ) {
    dates.push(current.toISOString().slice(0, 10));
  }
  return dates;
}

function addDays(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function centerOut<T>(values: T[]): T[] {
  if (values.length < 3) return values;
  const middle = Math.floor((values.length - 1) / 2);
  const result: T[] = [];
  for (let distance = 0; result.length < values.length; distance += 1) {
    const before = middle - distance;
    const after = middle + distance;
    if (before >= 0) result.push(values[before]!);
    if (distance > 0 && after < values.length) result.push(values[after]!);
  }
  return result;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
