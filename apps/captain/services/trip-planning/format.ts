import {
  formatCalendarDate,
  addIsoDays,
  totalTravellers,
  type Trip,
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
    `• Travellers: ${travellers}${defaults.has("travellers") ? " (default)" : ""}`,
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
    `Open dashboard: ${receipt.dashboardUrl}`,
    receipt.accessHint
  ].join("\n");
}

export function formatActiveTripLocation(input: {
  title: string;
  tripId: string;
  originAirports: string[];
  destinationAirports: string[];
  dashboardUrl: string;
}): string {
  return [
    `It’s saved in Captain as “${input.title}” (${input.originAirports.join("/")} → ${input.destinationAirports.join("/")}).`,
    `Trip reference: ${input.tripId}`,
    `Open dashboard: ${input.dashboardUrl}`,
    "Send /trips to view your saved Trips."
  ].join("\n");
}

export function formatTripList(
  trips: Trip[],
  dashboardUrlForTrip: (tripId: string) => string
): string {
  return trips.map((trip) => {
    const legs = trip.brief.legs ?? [];
    const route = trip.brief.tripType === "multi_city" && legs.length > 0
      ? formatLegRoute(legs)
      : `${trip.brief.originAirports.join("/")} → ${trip.brief.destinationAirports.join("/")}`;
    const departureDate = legs[0]?.departureWindow.start ?? trip.brief.departureWindow.start;
    const finalDate = trip.brief.tripType === "multi_city"
      ? legs.at(-1)?.departureWindow.start ?? departureDate
      : trip.brief.tripType === "round_trip" && trip.brief.stayNights
        ? addIsoDays(departureDate, trip.brief.stayNights.preferred)
        : departureDate;
    return `• ${route} · ${formatDateRange(departureDate, finalDate)}\n  ${dashboardUrlForTrip(trip.id)}`;
  }).join("\n\n");
}

export function telegramDashboardMessage(message: string): {
  text: string;
  links: Array<{ text: string; url: string }>;
} {
  const lines = message.split("\n");
  const links: Array<{ text: string; url: string }> = [];
  const visibleLines = lines.filter((line, index) => {
    const match = /^\s*(?:Open dashboard:\s*)?(https:\/\/\S+)\s*$/u.exec(line);
    if (!match?.[1]) return true;
    const previous = [...lines.slice(0, index)].reverse().find((candidate) => candidate.trim()) ?? "";
    const route = /^•\s+(.+?)\s+·\s+/u.exec(previous)?.[1] ?? null;
    const label = route ? `Open ${route}` : "Open dashboard";
    links.push({ text: [...label].slice(0, 64).join(""), url: match[1] });
    return false;
  });
  return {
    text: visibleLines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd(),
    links
  };
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

function formatDateRange(start: string, end: string): string {
  const startDate = new Date(`${start}T12:00:00.000Z`);
  const endDate = new Date(`${end}T12:00:00.000Z`);
  const day = (date: Date) => date.getUTCDate();
  const month = (date: Date) => new Intl.DateTimeFormat("en-GB", {
    month: "short",
    timeZone: "UTC"
  }).format(date);
  const startYear = startDate.getUTCFullYear();
  const endYear = endDate.getUTCFullYear();
  if (start === end) return `${day(startDate)} ${month(startDate)} ${startYear}`;
  if (startYear === endYear && startDate.getUTCMonth() === endDate.getUTCMonth()) {
    return `${day(startDate)}–${day(endDate)} ${month(endDate)} ${endYear}`;
  }
  if (startYear === endYear) {
    return `${day(startDate)} ${month(startDate)}–${day(endDate)} ${month(endDate)} ${endYear}`;
  }
  return `${day(startDate)} ${month(startDate)} ${startYear}–${day(endDate)} ${month(endDate)} ${endYear}`;
}
