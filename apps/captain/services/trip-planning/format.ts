import {
  formatCalendarDate,
  totalTravellers,
  type TripCreationReceipt,
  type TripPlanDraft,
  type TripStatus
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
      : !isMultiCity
        ? [`• Trip type: One-way${defaults.has("tripType") ? " (default)" : ""}`]
        : ["• Trip type: Multi-city"]),
    `• Travellers: ${travellers}${defaults.has("travellers") ? " (default)" : ""}`,
    `• Cabin: ${label(brief.cabin)}${defaults.has("cabin") ? " (default)" : ""}`,
    `• Stops: ${stopLabel(brief.maxStops)}${defaults.has("maxStops") ? " (default)" : ""}`,
    `• Currency: ${brief.currency}${defaults.has("currency") ? " (default)" : ""}`,
    "• Tracking: adaptive — every 12, 6, or 3 hours as departure approaches",
    "",
    "Reply Yes to create it, or tell me what to change."
  ];
  return lines.join("\n");
}

export function formatTripCreationReceipt(receipt: TripCreationReceipt): string {
  return [
    receipt.created ? "Your Trip is saved and tracking." : "That Trip was already saved; I’m using the existing one.",
    "",
    ...formatTripSummaryLines(receipt),
    "",
    `Open trip: ${receipt.dashboardUrl}`,
    receipt.accessHint
  ].join("\n");
}

export type ActiveTripFormatInput = {
  originAirports: string[];
  destinationAirports: string[];
  legs?: Array<{
    originAirports: string[];
    destinationAirports: string[];
    departureDate: string;
  }> | undefined;
  departureDate: string;
  returnDate: string | null;
  stayNights: number | null;
  travellers: number;
  cabin: TripCreationReceipt["cabin"];
  maxStops: number;
  currency: string;
  status: TripStatus;
  dashboardUrl: string;
};

export function formatActiveTripLocation(input: ActiveTripFormatInput): string {
  return [
    activeTripStatusLine(input.status),
    "",
    ...formatTripSummaryLines(input),
    "",
    `Open trip: ${input.dashboardUrl}`
  ].join("\n");
}

export function formatActiveTripList(inputs: ActiveTripFormatInput[]): string {
  return [
    `You’re tracking ${inputs.length} Trips:`,
    "",
    ...inputs.flatMap((input) => {
      const route = input.legs && input.legs.length >= 2
        ? formatLegRoute(input.legs)
        : `${input.originAirports.join("/")} → ${input.destinationAirports.join("/")}`;
      return [
        `• ${route}`,
        `  ${formatCalendarDate(input.departureDate)} · ${label(input.status)}`,
        `Open ${route}: ${input.dashboardUrl}`
      ];
    })
  ].join("\n");
}

export function telegramDashboardMessage(message: string): {
  text: string;
  links: Array<{ text: string; url: string }>;
} {
  const lines = message.split("\n");
  const links: Array<{ text: string; url: string }> = [];
  const visibleLines = lines.filter((line) => {
    const labelled = /^\s*Open ([^:]+):\s*(https:\/\/\S+)\s*$/u.exec(line);
    if (labelled?.[1] && labelled[2]) {
      links.push({ text: `Open ${labelled[1]}`, url: labelled[2] });
      return false;
    }
    const match = /^\s*(?:Open trip:\s*)?(https:\/\/\S+)\s*$/u.exec(line);
    if (!match?.[1]) return true;
    links.push({ text: "Open trip", url: match[1] });
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

function activeTripStatusLine(status: TripStatus): string {
  if (status === "recommended") return "Your Trip has verified results.";
  return `Your Trip is ${label(status).toLowerCase()}.`;
}

function formatTripSummaryLines(input: {
  originAirports: string[];
  destinationAirports: string[];
  legs?: Array<{
    originAirports: string[];
    destinationAirports: string[];
    departureDate: string;
  }> | undefined;
  departureDate: string;
  returnDate: string | null;
  stayNights: number | null;
  travellers: number;
  cabin: TripCreationReceipt["cabin"];
  maxStops: number;
  currency: string;
}): string[] {
  const travellers = `${input.travellers} traveller${input.travellers === 1 ? "" : "s"}`;
  const legs = input.legs ?? [];
  const isMultiCity = legs.length >= 2;
  return [
    `• ${isMultiCity ? formatLegRoute(legs) : `${input.originAirports.join("/")} → ${input.destinationAirports.join("/")}`}`,
    ...(isMultiCity
      ? legs.map((leg, index) =>
          `• Leg ${index + 1}: ${formatCalendarDate(leg.departureDate)}`
        )
      : [`• Depart: ${formatCalendarDate(input.departureDate)}`]),
    ...(!isMultiCity && input.returnDate
      ? [
          `• Return: ${formatCalendarDate(input.returnDate)}`,
          `• Stay: ${input.stayNights} night${input.stayNights === 1 ? "" : "s"}`
        ]
      : []),
    `• ${travellers}, ${label(input.cabin)}, ${stopLabel(input.maxStops)}, ${input.currency}`
  ];
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
