import type { SearchSpecRequest } from "./search-spec.js";

export const MAX_EXHAUSTIVE_DATE_COMBINATIONS = 49;

export class SearchWindowCombinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchWindowCombinationError";
  }
}

/** Expand every slice window into exact-date Cartesian-product requests. */
export function expandSearchDateCombinations(
  request: SearchSpecRequest,
  maximum = MAX_EXHAUSTIVE_DATE_COMBINATIONS
): SearchSpecRequest[] {
  if (request.slices.length === 0) {
    throw new SearchWindowCombinationError("Search is missing its first slice");
  }
  const datesBySlice = request.slices.map((slice) => {
    const dates = isoDateRange(slice.departureStart, slice.departureEnd);
    if (dates.length === 0) {
      throw new SearchWindowCombinationError(
        `Invalid departure window ${slice.departureStart}–${slice.departureEnd}`
      );
    }
    return dates;
  });
  const combinationCount = datesBySlice.reduce((count, dates) => count * dates.length, 1);
  if (combinationCount > maximum) {
    throw new SearchWindowCombinationError(
      `This trip has ${combinationCount} date combinations; narrow it to ${maximum} or fewer`
    );
  }
  let combinations: string[][] = [[]];
  for (const dates of datesBySlice) {
    combinations = combinations.flatMap((combination) =>
      dates.map((date) => [...combination, date])
    );
  }
  return combinations.map((dates) => ({
    ...request,
    slices: request.slices.map((slice, index) => ({
      ...slice,
      departureStart: dates[index]!,
      departureEnd: dates[index]!
    }))
  }));
}

function isoDateRange(start: string, end: string): string[] {
  const startMs = isoDateMs(start);
  const endMs = isoDateMs(end);
  if (startMs === null || endMs === null || startMs > endMs) return [];
  const dates: string[] = [];
  for (let value = startMs; value <= endMs; value += 86_400_000) {
    dates.push(new Date(value).toISOString().slice(0, 10));
  }
  return dates;
}

function isoDateMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? parsed
    : null;
}
