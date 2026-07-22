import type { FlightAgentBrief, SearchCombination } from "./types.js";

export const MAX_SEARCH_COMBINATIONS = 24;

export function buildSearchMatrix(
  brief: FlightAgentBrief,
  cursor = 0,
  limit = MAX_SEARCH_COMBINATIONS
): { matrix: SearchCombination[]; nextCursor: number; total: number } {
  const dates = centerOut(dateRange(
    brief.departureWindow.start,
    brief.departureWindow.end
  ));
  const stayLengths = brief.tripType === "round_trip" && brief.stayNights
    ? unique([
        brief.stayNights.preferred,
        brief.stayNights.minimum,
        brief.stayNights.maximum
      ])
    : [null];
  const combinations: SearchCombination[] = [];

  for (const departureDate of dates) {
    for (const destination of brief.destinationAirports) {
      for (const origin of brief.originAirports) {
        for (const nights of stayLengths) {
          combinations.push({
            origin,
            destination,
            departureDate,
            returnDate: nights === null ? null : addDays(departureDate, nights)
          });
        }
      }
    }
  }

  if (combinations.length === 0) {
    return { matrix: [], nextCursor: 0, total: 0 };
  }
  const normalizedCursor = modulo(cursor, combinations.length);
  const count = Math.min(Math.max(1, limit), combinations.length);
  const matrix = Array.from(
    { length: count },
    (_, offset) => combinations[(normalizedCursor + offset) % combinations.length]!
  );

  return {
    matrix,
    nextCursor: modulo(normalizedCursor + count, combinations.length),
    total: combinations.length
  };
}

function centerOut<T>(values: T[]): T[] {
  if (values.length < 3) return values;
  const middle = Math.floor((values.length - 1) / 2);
  const ordered: T[] = [];
  for (let distance = 0; ordered.length < values.length; distance += 1) {
    const before = middle - distance;
    const after = middle + distance;
    if (before >= 0) ordered.push(values[before]!);
    if (distance > 0 && after < values.length) ordered.push(values[after]!);
  }
  return ordered;
}

export function dateRange(start: string, end: string): string[] {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  const dates: string[] = [];
  for (
    let current = startDate;
    current.getTime() <= endDate.getTime();
    current = new Date(current.getTime() + 86_400_000)
  ) {
    dates.push(current.toISOString().slice(0, 10));
  }
  return dates;
}

function addDays(value: string, days: number): string {
  const date = parseDate(value);
  return new Date(date.getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
