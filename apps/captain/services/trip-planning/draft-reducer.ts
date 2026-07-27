import {
  stableJson,
  type TripPlanFieldSource,
  type TripPlanPartial,
  type TripPlanPendingField,
  type TripPlanTurnOperation,
  type TripPlanTurnState
} from "@agents/flight-domain";

import type { InterpretedTripTurn } from "./turn-interpreter.js";

export type ReducedTripDraft = {
  partial: TripPlanPartial;
  fieldSources: Record<string, TripPlanFieldSource>;
  operations: TripPlanTurnOperation[];
};

export function reduceTripDraft(input: {
  prior: TripPlanPartial;
  turnState: TripPlanTurnState;
  turn: InterpretedTripTurn;
  messageIndex: number;
}): ReducedTripDraft {
  const partial = canonicalizeTripPartial(input.prior);
  const fieldSources = { ...input.turnState.fieldSources };
  const operations: TripPlanTurnOperation[] = [];
  const pending = new Set(input.turnState.pendingFields.map((item) => item.field));
  const isEmpty = !hasRoute(partial) && !partial.departureDate;
  const replaceItinerary = input.turn.intent === "repair"
    || (isEmpty && input.turn.legs.length > 0)
    || (input.turn.correction && input.turn.legs.every((leg) =>
      leg.originAirports.length > 0 && leg.destinationAirports.length > 0
    ));
  const canFill = (field: TripPlanPendingField): boolean =>
    isEmpty || replaceItinerary || pending.has(field);

  if (input.turn.legs.length > 0) {
    if (replaceItinerary) {
      partial.legs = input.turn.legs.map((leg) => ({
        originAirports: [...leg.originAirports],
        destinationAirports: [...leg.destinationAirports],
        departureDate: leg.departureDate
      }));
      record("legs", null, "set", replaceItinerary && !isEmpty ? "explicit itinerary revision" : "new itinerary", input.turn.sourceText);
      source("legs", "explicit", input.turn.sourceText);
      input.turn.legs.forEach((leg, index) => {
        source(
          `legs.${index}.originAirports`,
          leg.originInferred ? "inferred" : "explicit",
          leg.sourceText
        );
        source(
          `legs.${index}.destinationAirports`,
          leg.destinationInferred ? "inferred" : "explicit",
          leg.sourceText
        );
      });
    } else if (input.turn.correction) {
      applyRouteCorrection();
    } else {
      applyPendingRoute();
    }
  }

  if (input.turn.departureDate) {
    if (canFill("departureDate") || !partial.legs[0]?.departureDate) {
      ensureFirstLeg(partial);
      setLegDate(0, input.turn.departureDate, "departureDate");
    } else if (partial.legs[0]?.departureDate !== input.turn.departureDate) {
      record("departureDate", 0, "reject", "an explicit departure needs correction language", input.turn.sourceText);
    }
  }
  if (input.turn.returnDate) {
    if (canFill("returnDate") || !returnLeg(partial)?.departureDate) {
      ensureReturnLeg(partial);
      setLegDate(partial.legs.length - 1, input.turn.returnDate, "returnDate");
    } else if (returnLeg(partial)?.departureDate !== input.turn.returnDate) {
      record("returnDate", partial.legs.length - 1, "reject", "an explicit return needs correction language", input.turn.sourceText);
    }
  }

  setDetail("travellers", input.turn.travellers, pending.has("travellers"));
  setDetail("cabin", input.turn.cabin, false);
  setDetail("maxStops", input.turn.maxStops, false);
  setDetail("currency", input.turn.currency, pending.has("currency"));
  setDetail("maximumPrice", input.turn.maximumPrice, false);
  setAirlines("preferredAirlines", input.turn.preferredAirlines);
  setAirlines("excludedAirlines", input.turn.excludedAirlines);

  synchronizeDerivedFields(partial);
  return { partial, fieldSources, operations };

  function applyPendingRoute(): void {
    const proposed = input.turn.legs;
    if (pending.has("itineraryLegs")) {
      partial.legs = proposed.map((leg) => ({
        originAirports: [...leg.originAirports],
        destinationAirports: [...leg.destinationAirports],
        departureDate: leg.departureDate
      }));
      record("legs", null, "set", "filled the pending itinerary", input.turn.sourceText);
      source("legs", "explicit", input.turn.sourceText);
      proposed.forEach((leg, index) => {
        source(
          `legs.${index}.originAirports`,
          leg.originInferred ? "inferred" : "explicit",
          leg.sourceText
        );
        source(
          `legs.${index}.destinationAirports`,
          leg.destinationInferred ? "inferred" : "explicit",
          leg.sourceText
        );
      });
      return;
    }
    ensureFirstLeg(partial);
    const candidate = proposed[0]!;
    if (pending.has("originAirports") && candidate.originAirports.length > 0) {
      partial.legs[0]!.originAirports = [...candidate.originAirports];
      if (partial.legs.length === 2 && partial.legs[1]!.destinationAirports.length === 0) {
        partial.legs[1]!.destinationAirports = [...candidate.originAirports];
      }
      record("originAirports", 0, "set", "answered the pending origin question", input.turn.sourceText);
      source("legs.0.originAirports", "explicit", input.turn.sourceText);
    }
    if (pending.has("destinationAirports") && candidate.destinationAirports.length > 0) {
      partial.legs[0]!.destinationAirports = [...candidate.destinationAirports];
      if (partial.legs.length === 2 && partial.legs[1]!.originAirports.length === 0) {
        partial.legs[1]!.originAirports = [...candidate.destinationAirports];
      }
      record("destinationAirports", 0, "set", "answered the pending destination question", input.turn.sourceText);
      source("legs.0.destinationAirports", "explicit", input.turn.sourceText);
    }
    if (pending.has("returnDate") && candidate.destinationAirports.length > 0) {
      ensureReturnLeg(partial);
      partial.legs.at(-1)!.destinationAirports = [...candidate.destinationAirports];
      record("destinationAirports", partial.legs.length - 1, "set", "completed the pending return leg", input.turn.sourceText);
      source(`legs.${partial.legs.length - 1}.destinationAirports`, "explicit", input.turn.sourceText);
    }
  }

  function applyRouteCorrection(): void {
    ensureFirstLeg(partial);
    const candidate = input.turn.legs[0]!;
    const isReturnCorrection = /\b(?:return(?:ing)?|back)\b/iu.test(input.turn.sourceText);
    if (isReturnCorrection && candidate.destinationAirports.length > 0) {
      ensureReturnLeg(partial);
      partial.legs.at(-1)!.destinationAirports = [...candidate.destinationAirports];
      record("destinationAirports", partial.legs.length - 1, "set", "explicit return destination revision", input.turn.sourceText);
      source(`legs.${partial.legs.length - 1}.destinationAirports`, "explicit", input.turn.sourceText);
      return;
    }
    if (candidate.originAirports.length > 0) {
      partial.legs[0]!.originAirports = [...candidate.originAirports];
      if (partial.legs.length === 2) {
        partial.legs[1]!.destinationAirports = [...candidate.originAirports];
      }
      record("originAirports", 0, "set", "explicit origin revision", input.turn.sourceText);
      source("legs.0.originAirports", "explicit", input.turn.sourceText);
    }
    if (candidate.destinationAirports.length > 0) {
      partial.legs[0]!.destinationAirports = [...candidate.destinationAirports];
      if (partial.legs.length === 2) {
        partial.legs[1]!.originAirports = [...candidate.destinationAirports];
      }
      record("destinationAirports", 0, "set", "explicit destination revision", input.turn.sourceText);
      source("legs.0.destinationAirports", "explicit", input.turn.sourceText);
    }
  }

  function setLegDate(index: number, value: string, field: "departureDate" | "returnDate"): void {
    partial.legs[index]!.departureDate = value;
    record(field, index, "set", `set the ${field === "returnDate" ? "return" : "departure"} date`, input.turn.sourceText);
    source(`legs.${index}.departureDate`, "explicit", input.turn.sourceText);
  }

  function setDetail<K extends "travellers" | "cabin" | "maxStops" | "currency" | "maximumPrice">(
    field: K,
    value: TripPlanPartial[K],
    pendingField: boolean
  ): void {
    if (value === null) return;
    const current = partial[field];
    if (current === null || input.turn.correction || input.turn.intent === "repair" || pendingField) {
      partial[field] = value;
      record(field, null, "set", current === null ? "filled an unset field" : "explicit field revision", input.turn.sourceText);
      source(field, "explicit", input.turn.sourceText);
    } else if (stableJson(current) !== stableJson(value)) {
      record(field, null, "reject", "an explicit value needs correction language", input.turn.sourceText);
    }
  }

  function setAirlines(
    field: "preferredAirlines" | "excludedAirlines",
    value: string[]
  ): void {
    if (value.length === 0) return;
    const current = partial[field];
    if (current.length === 0 || input.turn.correction || input.turn.intent === "repair") {
      partial[field] = [...value];
      record(field, null, "set", "explicit airline preference", input.turn.sourceText);
      source(field, "explicit", input.turn.sourceText);
    }
  }

  function source(field: string, kind: TripPlanFieldSource["kind"], text: string): void {
    fieldSources[field] = { kind, messageIndex: input.messageIndex, text: text.slice(0, 500) };
  }

  function record(
    field: string,
    legIndex: number | null,
    action: TripPlanTurnOperation["action"],
    reason: string,
    sourceText: string
  ): void {
    operations.push({
      field,
      legIndex,
      action,
      reason,
      sourceText: sourceText.slice(0, 500)
    });
  }
}

export function canonicalizeTripPartial(value: TripPlanPartial): TripPlanPartial {
  const partial = structuredClone(value);
  if (partial.legs.length === 0 && (
    partial.originAirports.length > 0
    || partial.destinationAirports.length > 0
    || partial.departureDate
  )) {
    partial.legs = [{
      originAirports: [...partial.originAirports],
      destinationAirports: [...partial.destinationAirports],
      departureDate: partial.departureDate
    }];
    if (partial.tripType === "round_trip") {
      partial.legs.push({
        originAirports: [...partial.destinationAirports],
        destinationAirports: [...partial.originAirports],
        departureDate: partial.returnDate
      });
    }
  }
  synchronizeDerivedFields(partial);
  return partial;
}

export function synchronizeDerivedFields(partial: TripPlanPartial): void {
  const usable = partial.legs.filter((leg) =>
    leg.originAirports.length > 0 || leg.destinationAirports.length > 0 || leg.departureDate
  );
  partial.legs = usable;
  const first = usable[0];
  const last = usable.at(-1);
  const roundTrip = usable.length === 2
    && sameAirports(usable[0]!.originAirports, usable[1]!.destinationAirports)
    && sameAirports(usable[0]!.destinationAirports, usable[1]!.originAirports);
  partial.tripType = usable.length >= 2 ? (roundTrip ? "round_trip" : "multi_city") : partial.tripType;
  if (usable.length === 1 && partial.tripType !== "round_trip") partial.tripType = "one_way";
  partial.originAirports = [...(first?.originAirports ?? [])];
  partial.destinationAirports = [
    ...(roundTrip ? first?.destinationAirports ?? [] : last?.destinationAirports ?? [])
  ];
  partial.departureDate = first?.departureDate ?? null;
  partial.returnDate = roundTrip ? last?.departureDate ?? null : null;
}

function ensureFirstLeg(partial: TripPlanPartial): void {
  partial.legs[0] ??= {
    originAirports: [...partial.originAirports],
    destinationAirports: [...partial.destinationAirports],
    departureDate: partial.departureDate
  };
}

function ensureReturnLeg(partial: TripPlanPartial): void {
  ensureFirstLeg(partial);
  if (partial.legs.length < 2) {
    const outbound = partial.legs[0]!;
    partial.legs.push({
      originAirports: [...outbound.destinationAirports],
      destinationAirports: [...outbound.originAirports],
      departureDate: partial.returnDate
    });
  }
}

function returnLeg(partial: TripPlanPartial): TripPlanPartial["legs"][number] | null {
  return partial.legs.length >= 2 ? partial.legs.at(-1)! : null;
}

function hasRoute(partial: TripPlanPartial): boolean {
  return partial.legs.some((leg) =>
    leg.originAirports.length > 0 || leg.destinationAirports.length > 0
  );
}

function sameAirports(left: string[], right: string[]): boolean {
  return stableJson(left) === stableJson(right);
}
