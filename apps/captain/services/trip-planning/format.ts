import {
  formatCalendarDate,
  totalTravellers,
  type TripCreationReceipt,
  type TripPlanDraft
} from "@agents/flight-domain";

export function formatTripPlanConfirmation(draft: TripPlanDraft): string {
  if (!draft.plan) throw new Error("Cannot confirm an incomplete Trip draft");
  const { brief } = draft.plan.input;
  const travellers = totalTravellers(brief.travellers);
  const defaults = new Set(Object.keys(draft.inferredFields));
  const legs = brief.legs ?? [];
  const isMultiCity = brief.tripType === "multi_city";
  const lines = [
    "Ready to create this Trip:",
    "",
    `• Route: ${isMultiCity ? formatLegRoute(legs) : `${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")}`}`,
    ...(isMultiCity
      ? legs.map((leg, index) =>
          `• Leg ${index + 1}: ${leg.originAirports.join("/")} → ${leg.destinationAirports.join("/")} · ${formatCalendarDate(leg.departureWindow.start)}`
        )
      : [`• Depart: ${formatCalendarDate(draft.plan.departureDate)}`]),
    ...(!isMultiCity && draft.plan.returnDate
      ? [
          `• Return: ${formatCalendarDate(draft.plan.returnDate)}`,
          `• Stay: ${brief.stayNights!.preferred} night${brief.stayNights!.preferred === 1 ? "" : "s"}`
        ]
      : !isMultiCity ? ["• Trip type: One-way"] : ["• Trip type: Multi-city"]),
    `• Travellers: ${travellers}`,
    `• Cabin: ${label(brief.cabin)}${defaults.has("cabin") ? " (default)" : ""}`,
    `• Stops: ${stopLabel(brief.maxStops)}${defaults.has("maxStops") ? " (default)" : ""}`,
    `• Currency: ${brief.currency}${defaults.has("currency") ? " (default)" : ""}`,
    `• Tracking: every ${draft.plan.input.cadenceHours} hours${defaults.has("cadenceHours") ? " (default)" : ""}`,
    "",
    "Reply Yes to create it, or tell me what to change."
  ];
  return lines.join("\n");
}

export function formatTripCreationReceipt(receipt: TripCreationReceipt): string {
  const travellers = `${receipt.travellers} traveller${receipt.travellers === 1 ? "" : "s"}`;
  const legs = receipt.legs ?? [];
  const isMultiCity = legs.length >= 2;
  return [
    receipt.created ? "Your Trip is saved and tracking." : "That Trip was already saved; I’m using the existing one.",
    "",
    `• ${isMultiCity ? formatLegRoute(legs) : `${receipt.originAirports.join("/")} → ${receipt.destinationAirports.join("/")}`}`,
    ...(isMultiCity
      ? legs.map((leg, index) =>
          `• Leg ${index + 1}: ${formatCalendarDate(leg.departureDate)}`
        )
      : [`• Depart: ${formatCalendarDate(receipt.departureDate)}`]),
    ...(!isMultiCity && receipt.returnDate
      ? [
          `• Return: ${formatCalendarDate(receipt.returnDate)}`,
          `• Stay: ${receipt.stayNights} night${receipt.stayNights === 1 ? "" : "s"}`
        ]
      : []),
    `• ${travellers}, ${label(receipt.cabin)}, ${stopLabel(receipt.maxStops)}, ${receipt.currency}`,
    `• Trip reference: ${receipt.tripId}`,
    "",
    receipt.accessHint
  ].join("\n");
}

export function formatActiveTripLocation(input: {
  title: string;
  tripId: string;
  originAirports: string[];
  destinationAirports: string[];
}): string {
  return [
    `It’s saved in Captain as “${input.title}” (${input.originAirports.join("/")} → ${input.destinationAirports.join("/")}).`,
    `Trip reference: ${input.tripId}`,
    "Send /trips to view your saved Trips."
  ].join("\n");
}

function stopLabel(maxStops: number): string {
  if (maxStops === 0) return "Nonstop only";
  return `At most ${maxStops} stop${maxStops === 1 ? "" : "s"}`;
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatLegRoute(
  legs: Array<{ originAirports: string[]; destinationAirports: string[] }>
): string {
  if (legs.length === 0) return "";
  return [
    legs[0]!.originAirports.join("/"),
    ...legs.map((leg) => leg.destinationAirports.join("/"))
  ].join(" → ");
}
