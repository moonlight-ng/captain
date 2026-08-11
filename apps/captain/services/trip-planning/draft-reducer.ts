import {
  EMPTY_TRIP_DRAFT_STATE,
  addIsoDays,
  daysBetween,
  isoDate,
  parseIsoDate,
  resolveTripDateIntent,
  resolveTripDateSequence,
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
  // A route naming several legs is a claim about a whole journey and has to
  // hold together. A single leg is a correction to one flight — mid-edit the
  // chain is allowed to be briefly broken.
  let statedWholeRoute = false;

  for (const operation of patch.operations) {
    if (operation.type === "set_route") {
      applyRoute(candidate, operation.legs);
      statedWholeRoute ||= operation.legs.length > 1;
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
  if (!issue && statedWholeRoute) {
    const breaks = routeDiscontinuities(candidate.legs);
    if (breaks.length > 0) {
      issue = `I lost track of the route at ${breaks.join(" and ")}.`
        + " Tell me which city comes in between and I'll rebuild it.";
    }
  }
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

/**
 * A route operation can add legs and rewrite the ones it names, but never
 * removes one — a sloppy partial route would otherwise delete a flight the
 * traveller had already given. Only `clear: route` empties the itinerary.
 *
 * Dates follow the *flight*, not the position. Inserting a city mid-itinerary
 * shifts every later leg along by one, and matching by index then slid each
 * date onto the wrong flight.
 */
function applyRoute(
  state: TripDraftState,
  legs: Array<{ originAirports: string[]; destinationAirports: string[] }>
): void {
  const prior = state.legs;
  const length = Math.max(prior.length, legs.length);
  state.legs = Array.from({ length }, (_, index) => {
    const positional = prior[index];
    const proposed = legs[index];
    if (!proposed && positional) return structuredClone(positional);
    // An empty value in a set operation means "not supplied", not "clear".
    const originAirports = proposed!.originAirports.length > 0
      ? unique(proposed!.originAirports)
      : [...(positional?.originAirports ?? [])];
    const destinationAirports = proposed!.destinationAirports.length > 0
      ? unique(proposed!.destinationAirports)
      : [...(positional?.destinationAirports ?? [])];
    const existing = prior.find((leg) => sameFlight(leg, originAirports, destinationAirports))
      ?? positional;
    return {
      originAirports,
      destinationAirports,
      // A route operation cannot clear or change a date.
      departure: existing?.departure ?? null,
      arriveBy: existing?.arriveBy ?? null,
      feasibleDepartureWindow: existing?.feasibleDepartureWindow ?? null,
      proposedDeparture: existing?.proposedDeparture ?? null
    };
  });
}

/**
 * Whether a leg already in the draft is this same flight. A side nobody has
 * named yet is unknown rather than different, so naming the origin of a leg
 * that only had a destination finds it — but at least one side has to be
 * known and agree, or every empty leg would match everything.
 */
function sameFlight(
  leg: TripDraftState["legs"][number],
  originAirports: string[],
  destinationAirports: string[]
): boolean {
  const originKnown = leg.originAirports.length > 0;
  const destinationKnown = leg.destinationAirports.length > 0;
  if (!originKnown && !destinationKnown) return false;
  if (originKnown && !sameAirports(leg.originAirports, originAirports)) return false;
  if (destinationKnown && !sameAirports(leg.destinationAirports, destinationAirports)) return false;
  return true;
}

/** Both sides known and equal. An unknown side matches nothing. */
function sameAirports(left: string[], right: string[]): boolean {
  return left.length > 0
    && left.length === right.length
    && left.every((code) => right.includes(code));
}

/**
 * Names the seams where a route stops being a journey — a leg that departs
 * from somewhere the previous one never reached. `validateMultiCityBrief`
 * catches this when a trip is finally built; catching it in the draft is what
 * stops a silently dropped city from passing as a shorter itinerary.
 */
function routeDiscontinuities(legs: TripDraftState["legs"]): string[] {
  return legs.flatMap((leg, index) => {
    const next = legs[index + 1];
    if (!next || leg.destinationAirports.length === 0 || next.originAirports.length === 0) {
      return [];
    }
    const landed = new Set(leg.destinationAirports);
    return next.originAirports.some((code) => landed.has(code))
      ? []
      : [`${leg.destinationAirports.join("/")} → ${next.originAirports.join("/")}`];
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
  const resolved = resolveDateSelection(expression, state.legs[index] ?? null, now, timeZone);
  if ("issue" in resolved) return resolved.issue;
  ensureLeg(state, index);
  state.legs[index]!.departure = resolved.selection;
  state.legs[index]!.proposedDeparture = null;
  return null;
}

function resolveDateSelection(
  expression: string,
  leg: TripDraftState["legs"][number] | null,
  now: Date,
  timeZone: string
): { selection: TripDraftDateSelection } | { issue: string } {
  const current = leg?.departure ?? null;
  const firstWeek = firstWeekSelection(expression, now, timeZone);
  if (firstWeek) return { selection: firstWeek };

  if (/\d\s*(?:-|–|—|to)\s*\d|\bbetween\b/iu.test(expression)) {
    const sequence = resolveTripDateSequence(expression, now, timeZone);
    if (!sequence.issue && sequence.dates.length >= 2) {
      return {
        selection: {
          kind: "window",
          start: sequence.dates[0]!,
          end: sequence.dates.at(-1)!,
          source: expression
        }
      };
    }
  }

  const weekday = weekdayIn(expression);
  if (weekday) {
    const direction = weekdayDirectionIn(expression);
    // The window the traveller is actually looking at wins: their own, then
    // the one Captain proposed to them, then the wider travel envelope.
    const proposed = !current ? leg?.proposedDeparture ?? null : null;
    const window = current?.kind === "window"
      ? { start: current.start, end: current.end, label: `“${current.source}”` }
      : proposed?.kind === "window"
        ? { start: proposed.start, end: proposed.end, label: `“${proposed.source}”` }
        : leg?.feasibleDepartureWindow
          ? {
              ...leg.feasibleDepartureWindow,
              label: `${leg.feasibleDepartureWindow.start} to ${leg.feasibleDepartureWindow.end}`
            }
          : null;
    if (window) {
      const matches: string[] = [];
      for (let date = window.start; daysBetween(date, window.end) >= 0; date = addIsoDays(date, 1)) {
        if (weekdayName(date).toLowerCase() === weekday) matches.push(date);
      }
      if (matches.length === 1) {
        return { selection: { kind: "exact", date: matches[0]! } };
      }
      // A direction word already says which end of the envelope is meant:
      // “before” the deadline is its last match, “after” it opens is the first.
      // Only a bare weekday matching more than once is genuinely the
      // traveller's to settle.
      if (matches.length > 1 && direction) {
        return {
          selection: {
            kind: "exact",
            date: direction === "before" ? matches.at(-1)! : matches[0]!
          }
        };
      }
      if (matches.length > 1) {
        return {
          issue: `${titleCase(weekday)} matches ${matches.join(" or ")} in ${window.label}. Which one should I use?`
        };
      }
      return {
        issue: `There is no ${titleCase(weekday)} in ${window.label}. I kept that date window. Which date should I use?`
      };
    }
    // No window to read it against, but the leg still has to land by a fixed
    // date. A traveller naming a weekday means the last one that arrives in
    // time — never the next one on this week's calendar.
    if (leg?.arriveBy) {
      // “After” counts forward from the day the envelope opens, and a leg with
      // only a deadline has no such day. Asking beats guessing a date the
      // traveller never named.
      if (direction === "after") {
        return {
          issue: `I only have the ${leg.arriveBy} arrival deadline for this flight, so I can’t tell which ${titleCase(weekday)} comes after. Which date should I use?`
        };
      }
      const date = latestWeekdayOnOrBefore(weekday, leg.arriveBy);
      if (date && daysBetween(isoDate(localDate(now, timeZone)), date) >= 0) {
        return { selection: { kind: "exact", date } };
      }
    }
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
        leg.arriveBy = null;
        leg.feasibleDepartureWindow = null;
        leg.proposedDeparture = null;
      });
      break;
    case "departureDate":
      if (state.legs[0]) {
        state.legs[0].departure = null;
        state.legs[0].arriveBy = null;
        state.legs[0].feasibleDepartureWindow = null;
        state.legs[0].proposedDeparture = null;
      }
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
  for (const leg of state.legs) {
    const selection = leg.departure;
    if (!selection) continue;
    const start = selection.kind === "exact" ? selection.date : selection.start;
    const end = selection.kind === "exact" ? selection.date : selection.end;
    // The deadline is the reason the window ends where it does, so a date past
    // it is named for what it actually misses.
    if (leg.arriveBy && end > leg.arriveBy) {
      return `That departure is after the ${leg.arriveBy} arrival deadline. I kept the previous dates.`;
    }
    if (
      leg.feasibleDepartureWindow
      && (
        start < leg.feasibleDepartureWindow.start
        || end > leg.feasibleDepartureWindow.end
      )
    ) {
      return `That date is outside the feasible ${leg.feasibleDepartureWindow.start} to ${leg.feasibleDepartureWindow.end} travel window. I kept the previous dates.`;
    }
  }
  return null;
}

function legIndexForTarget(state: TripDraftState, target: DateTarget): number {
  if (target.field === "leg") return target.legIndex;
  if (target.field === "departure") return 0;
  return Math.max(1, state.legs.length - 1);
}

/**
 * Grows the leg list to reach `index`. The second leg of a round trip is the
 * first one reversed, so it can be created from what is already known — but
 * only when the traveller asked for a return. Mirroring on any date that
 * mentioned "back" is what put a flight home on the end of a one-way trip.
 */
function ensureLeg(state: TripDraftState, index: number): void {
  while (state.legs.length <= index) {
    const first = state.legs[0];
    state.legs.push(index === 1 && first && state.tripType === "round_trip"
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

/** The direction the interpreter kept from “the Sunday before”, if any. */
function weekdayDirectionIn(expression: string): "before" | "after" | null {
  const match = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(before|after)\b/iu
    .exec(expression);
  return match ? match[1]!.toLowerCase() as "before" | "after" : null;
}

function latestWeekdayOnOrBefore(weekday: string, deadline: string): string | null {
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addIsoDays(deadline, -offset);
    if (weekdayName(date).toLowerCase() === weekday) return date;
  }
  return null;
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
