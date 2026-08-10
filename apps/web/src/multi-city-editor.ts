import type { TripPayload } from "./domain.js";

export type EditableTripBrief = NonNullable<TripPayload["trip"]>["brief"];
export type EditableTripLeg = NonNullable<EditableTripBrief["legs"]>[number];

export function updateMultiCityLeg(
  brief: EditableTripBrief,
  index: number,
  update: Partial<EditableTripLeg>
): EditableTripBrief {
  const legs = cloneLegs(brief);
  const current = legs[index];
  if (!current) return brief;
  legs[index] = {
    ...current,
    ...update,
    originAirports: update.originAirports
      ? [...update.originAirports]
      : [...current.originAirports],
    destinationAirports: update.destinationAirports
      ? [...update.destinationAirports]
      : [...current.destinationAirports],
    departureWindow: update.departureWindow
      ? { ...update.departureWindow }
      : { ...current.departureWindow }
  };

  if (update.originAirports) {
    if (index > 0) legs[index - 1]!.destinationAirports = [...update.originAirports];
  }
  if (update.destinationAirports && index + 1 < legs.length) {
    legs[index + 1]!.originAirports = [...update.destinationAirports];
  }
  return withMultiCitySummary(brief, legs);
}

export function addMultiCityLeg(brief: EditableTripBrief): EditableTripBrief {
  const legs = cloneLegs(brief);
  if (legs.length === 0 || legs.length >= 6) return brief;
  const prior = legs.at(-1)!;
  legs.push({
    originAirports: [...prior.destinationAirports],
    destinationAirports: [],
    departureWindow: {
      start: prior.departureWindow.end,
      end: prior.departureWindow.end
    },
    arriveBy: null
  });
  return withMultiCitySummary(brief, legs);
}

export function removeMultiCityLeg(
  brief: EditableTripBrief,
  index: number
): EditableTripBrief {
  const legs = cloneLegs(brief);
  if (legs.length <= 2 || !legs[index]) return brief;
  legs.splice(index, 1);
  if (index > 0 && legs[index]) {
    legs[index]!.originAirports = [...legs[index - 1]!.destinationAirports];
  }
  return withMultiCitySummary(brief, legs);
}

function withMultiCitySummary(
  brief: EditableTripBrief,
  legs: EditableTripLeg[]
): EditableTripBrief {
  const first = legs[0];
  const last = legs.at(-1);
  if (!first || !last) return { ...brief, legs };
  return {
    ...brief,
    originAirports: [...first.originAirports],
    destinationAirports: [...last.destinationAirports],
    departureWindow: { ...first.departureWindow },
    legs
  };
}

function cloneLegs(brief: EditableTripBrief): EditableTripLeg[] {
  return (brief.legs ?? []).map((leg) => ({
    ...leg,
    originAirports: [...leg.originAirports],
    destinationAirports: [...leg.destinationAirports],
    departureWindow: { ...leg.departureWindow }
  }));
}
