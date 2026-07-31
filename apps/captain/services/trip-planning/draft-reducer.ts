import {
  EMPTY_TRIP_DRAFT_STATE,
  addIsoDays,
  daysBetween,
  isoDate,
  parseIsoDate,
  resolveTripDateIntent,
  tripDraftStateSchema,
  weekdayName,
  type TripDraftDateSelection,
  type TripDraftState
} from "@agents/flight-domain";

import type {
  ClearableField,
  DateTarget,
  TripDraftOperation,
  TripTurnPatch
} from "./turn-interpreter.js";
import { tripTurnPatchSchema } from "./turn-interpreter.js";

export type AppliedTripTurnPatch = {
  state: TripDraftState;
  appliedOperations: TripDraftOperation[];
  issue: string | null;
};

/**
 * The only writer for TripDraftState.
 *
 * All operations are applied to a candidate and validated together. If any
 * operation cannot be resolved, the entire patch is rejected and the previous
 * state is returned unchanged.
 */
export function applyTripTurnPatch(input: {
  state: TripDraftState;
  patch: TripTurnPatch;
  now: Date;
  timeZone: string;
}): AppliedTripTurnPatch {
  const prior = tripDraftStateSchema.parse(input.state);
  const patch = tripTurnPatchSchema.parse(input.patch);
  const candidate = structuredClone(prior);
  let issue: string | null = null;

  for (const operation of patch.operations) {
    if (operation.type === "set_route") {
      applyRoute(candidate, operation.legs);
      continue;
    }
    if (operation.type === "set_date") {
      issue = applyDate(candidate, operation.target, operation.expression, input.now, input.timeZone);
      if (issue) break;
      continue;
    }
    if (operation.type === "set_option") {
      applyOption(candidate, operation.field, operation.value);
      continue;
    }
    applyClear(candidate, operation.target);
  }

  if (!issue) issue = validateStateDates(candidate, input.now, input.timeZone);
  if (issue) {
    return { state: structuredClone(prior), appliedOperations: [], issue };
  }

  return {
    state: tripDraftStateSchema.parse(candidate),
    appliedOperations: patch.operations,
    issue: null
  };
}

export function emptyTripDraftState(): TripDraftState {
  return structuredClone(EMPTY_TRIP_DRAFT_STATE);
}

function applyRoute(
  state: TripDraftState,
  legs: Array<{ originAirports: string[]; destinationAirports: string[] }>
): void {
  const prior = state.legs;
  const length = Math.max(prior.length, legs.length);
  state.legs = Array.from({ length }, (_, index) => {
    const existing = prior[index];
    const proposed = legs[index];
    if (!proposed && existing) return structuredClone(existing);
    return {
      // An empty value in a set operation means "not supplied", not "clear".
      originAirports: proposed!.originAirports.length > 0
        ? unique(proposed!.originAirports)
        : [...(existing?.originAirports ?? [])],
      destinationAirports: proposed!.destinationAirports.length > 0
        ? unique(proposed!.destinationAirports)
        : [...(existing?.destinationAirports ?? [])],
      // A route operation cannot clear or change a date.
      departure: existing?.departure ?? null
    };
  });
}

function applyDate(
  state: TripDraftState,
  target: DateTarget,
  expression: string,
  now: Date,
  timeZone: string
): string | null {
  const index = legIndexForTarget(state, target);
  const current = state.legs[index]?.departure ?? null;
  const resolved = resolveDateSelection(expression, current, now, timeZone);
  if ("issue" in resolved) return resolved.issue;
  ensureLeg(state, index);
  state.legs[index]!.departure = resolved.selection;
  return null;
}

function resolveDateSelection(
  expression: string,
  current: TripDraftDateSelection | null,
  now: Date,
  timeZone: string
): { selection: TripDraftDateSelection } | { issue: string } {
  const firstWeek = firstWeekSelection(expression, now, timeZone);
  if (firstWeek) return { selection: firstWeek };

  const weekday = weekdayIn(expression);
  if (weekday && current?.kind === "window") {
    const matches: string[] = [];
    for (let date = current.start; daysBetween(date, current.end) >= 0; date = addIsoDays(date, 1)) {
      if (weekdayName(date).toLowerCase() === weekday) matches.push(date);
    }
    if (matches.length === 1) {
      return { selection: { kind: "exact", date: matches[0]! } };
    }
    if (matches.length > 1) {
      return {
        issue: `${titleCase(weekday)} matches ${matches.join(" or ")} in “${current.source}”. Which one should I use?`
      };
    }
    return {
      issue: `There is no ${titleCase(weekday)} in “${current.source}”. I kept that date window. Which date should I use?`
    };
  }

  const resolved = resolveTripDateIntent(expression, now, timeZone);
  if (resolved.issue) return { issue: resolved.issue };
  const date = resolved.departureDate ?? resolved.returnDate;
  if (!date) {
    return {
      issue: `I couldn’t resolve “${expression}” to a calendar date, so I kept the existing date.`
    };
  }
  return { selection: { kind: "exact", date } };
}

function firstWeekSelection(
  expression: string,
  now: Date,
  timeZone: string
): TripDraftDateSelection | null {
  const match = /\b(?:the\s+)?(?:first|1st)\s+week(?:\s+of)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:[\s,]+(20\d{2}))?\b/iu.exec(expression);
  if (!match) return null;
  const months: Readonly<Record<string, number>> = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sept: 8, sep: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11
  };
  const month = months[match[1]!.toLowerCase()]!;
  const today = localDate(now, timeZone);
  let year = match[2] ? Number(match[2]) : today.getUTCFullYear();
  if (!match[2] && month < today.getUTCMonth()) year += 1;
  const start = isoDate(new Date(Date.UTC(year, month, 1)));
  return {
    kind: "window",
    start,
    end: addIsoDays(start, 6),
    source: match[0]
  };
}

function applyOption(
  state: TripDraftState,
  field: Exclude<TripDraftOperation, { type: "set_route" | "set_date" | "clear" }>["field"],
  value: Exclude<TripDraftOperation, { type: "set_route" | "set_date" | "clear" }>["value"]
): void {
  switch (field) {
    case "tripType":
      if (typeof value === "string") state.tripType = value as TripDraftState["tripType"];
      break;
    case "travellers":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        state.travellers = value as NonNullable<TripDraftState["travellers"]>;
      }
      break;
    case "cabin":
      if (typeof value === "string") state.cabin = value as TripDraftState["cabin"];
      break;
    case "maxStops":
      if (typeof value === "number") state.maxStops = value;
      break;
    case "currency":
      if (typeof value === "string") state.currency = value.toUpperCase();
      break;
    case "maximumPrice":
      if (typeof value === "number") state.maximumPrice = value;
      break;
    case "preferredAirlines":
      if (Array.isArray(value)) state.preferredAirlines = unique(value);
      break;
    case "excludedAirlines":
      if (Array.isArray(value)) state.excludedAirlines = unique(value);
      break;
  }
}

function applyClear(state: TripDraftState, target: ClearableField): void {
  switch (target) {
    case "route":
      state.legs = [];
      break;
    case "dates":
      state.legs.forEach((leg) => {
        leg.departure = null;
      });
      break;
    case "departureDate":
      if (state.legs[0]) state.legs[0].departure = null;
      break;
    case "returnDate":
      if (state.legs.at(-1) && state.legs.length > 1) state.legs.at(-1)!.departure = null;
      break;
    case "tripType":
      state.tripType = null;
      break;
    case "travellers":
      state.travellers = null;
      break;
    case "cabin":
      state.cabin = null;
      break;
    case "maxStops":
      state.maxStops = null;
      break;
    case "currency":
      state.currency = null;
      break;
    case "maximumPrice":
      state.maximumPrice = null;
      break;
    case "preferredAirlines":
      state.preferredAirlines = [];
      break;
    case "excludedAirlines":
      state.excludedAirlines = [];
      break;
  }
}

function validateStateDates(state: TripDraftState, now: Date, timeZone: string): string | null {
  const exactDates = state.legs.map((leg) =>
    leg.departure?.kind === "exact" ? leg.departure.date : null
  );
  const today = isoDate(localDate(now, timeZone));
  if (exactDates[0] && daysBetween(today, exactDates[0]) < 0) {
    return "The departure date is in the past. I kept the previous date.";
  }
  if (
    state.tripType === "round_trip"
    && exactDates[0]
    && exactDates.at(-1)
    && daysBetween(exactDates[0], exactDates.at(-1)!) <= 0
  ) {
    return "The return date must be after the departure date. I kept the previous dates.";
  }
  for (let index = 1; index < exactDates.length; index += 1) {
    const prior = exactDates[index - 1];
    const current = exactDates[index];
    if (prior && current && daysBetween(prior, current) < 0) {
      return "Trip leg dates must be in order. I kept the previous dates.";
    }
  }
  return null;
}

function legIndexForTarget(state: TripDraftState, target: DateTarget): number {
  if (target.field === "leg") return target.legIndex;
  if (target.field === "departure") return 0;
  return Math.max(1, state.legs.length - 1);
}

function ensureLeg(state: TripDraftState, index: number): void {
  while (state.legs.length <= index) {
    const first = state.legs[0];
    state.legs.push(index === 1 && first
      ? {
          originAirports: [...first.destinationAirports],
          destinationAirports: [...first.originAirports],
          departure: null
        }
      : { originAirports: [], destinationAirports: [], departure: null });
  }
}

function weekdayIn(expression: string): string | null {
  return /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu
    .exec(expression)?.[1]?.toLowerCase() ?? null;
}

function localDate(now: Date, timeZone: string): Date {
  try {
    const value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
    return parseIsoDate(value);
  } catch {
    return parseIsoDate(now.toISOString().slice(0, 10));
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function titleCase(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
