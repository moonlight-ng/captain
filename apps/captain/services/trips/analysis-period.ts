import type { PriceAnalysisRange } from "@agents/flight-domain";

export type AnalysisPeriodPreset =
  | "last_7_days"
  | "last_30_days"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "all_history";

export type AnalysisPeriodSpec =
  | { preset: AnalysisPeriodPreset }
  | { startDate: string; endDate: string };

export function resolveAnalysisPeriod(
  spec: AnalysisPeriodSpec,
  now: Date
): PriceAnalysisRange {
  if ("startDate" in spec) {
    if (spec.startDate > spec.endDate) {
      throw new Error("The analysis period start date must be on or before its end date.");
    }
    return { startDay: spec.startDate, endDay: spec.endDate };
  }

  const today = startOfUtcDay(now);
  switch (spec.preset) {
    case "last_7_days":
      return range(addDays(today, -6), today);
    case "last_30_days":
      return range(addDays(today, -29), today);
    case "this_week":
      return range(startOfWeek(today), today);
    case "last_week": {
      const thisWeek = startOfWeek(today);
      return range(addDays(thisWeek, -7), addDays(thisWeek, -1));
    }
    case "this_month":
      return range(startOfMonth(today), today);
    case "last_month":
      return previousCalendarMonth(today);
    case "all_history":
      return { startDay: null, endDay: null };
  }
}

/** Resolves the natural calendar predecessor, or an equal-size custom window. */
export function resolvePreviousAnalysisPeriod(
  spec: AnalysisPeriodSpec,
  resolved: PriceAnalysisRange,
  now: Date
): PriceAnalysisRange | null {
  if ("preset" in spec) {
    const today = startOfUtcDay(now);
    switch (spec.preset) {
      case "last_7_days":
        return range(addDays(today, -13), addDays(today, -7));
      case "last_30_days":
        return range(addDays(today, -59), addDays(today, -30));
      case "this_week": {
        const thisWeek = startOfWeek(today);
        return range(addDays(thisWeek, -7), addDays(thisWeek, -1));
      }
      case "last_week": {
        const thisWeek = startOfWeek(today);
        return range(addDays(thisWeek, -14), addDays(thisWeek, -8));
      }
      case "this_month":
        return previousCalendarMonth(today);
      case "last_month": {
        const previousMonth = previousCalendarMonth(today);
        return previousCalendarMonth(parseDay(previousMonth.startDay!));
      }
      case "all_history":
        return null;
    }
  }

  if (!resolved.startDay || !resolved.endDay) return null;
  const start = parseDay(resolved.startDay);
  const end = parseDay(resolved.endDay);
  const durationDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const comparisonEnd = addDays(start, -1);
  return range(addDays(comparisonEnd, -(durationDays - 1)), comparisonEnd);
}

function previousCalendarMonth(day: Date): PriceAnalysisRange {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 0));
  return range(start, end);
}

function startOfWeek(day: Date): Date {
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  return addDays(day, -daysSinceMonday);
}

function startOfMonth(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(day: Date, amount: number): Date {
  return new Date(day.getTime() + amount * 86_400_000);
}

function range(start: Date, end: Date): PriceAnalysisRange {
  return { startDay: formatDay(start), endDay: formatDay(end) };
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function formatDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}
