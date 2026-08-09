import {
  formatCalendarDate,
  totalTravellers,
  type TripCreationReceipt,
  type TripPlanDraft,
  type TripStatus
} from "@agents/flight-domain";

export function formatTripPlanConfirmation(draft: TripPlanDraft): string {
  if (!draft.confirmationSnapshot) {
    throw new Error("Cannot confirm an incomplete trip draft");
  }
  const { brief } = draft.confirmationSnapshot.input;
  const travellers = totalTravellers(brief.travellers);
  const defaults = new Set([
    ...(!draft.state.tripType ? ["tripType"] : []),
    ...(!draft.state.travellers ? ["travellers"] : []),
    ...(!draft.state.cabin ? ["cabin"] : []),
    ...(draft.state.maxStops === null ? ["maxStops"] : []),
    ...(!draft.state.currency ? ["currency"] : [])
  ]);
  const legs = brief.legs ?? [];
  const isMultiCity = brief.tripType === "multi_city";
  const captainChose = new Set(
    draft.state.legs.flatMap((leg, index) =>
      !leg.departure && leg.proposedDeparture ? [index] : []
    )
  );
  const lines = [
    "Ready to create this trip:",
    "",
    `• Route: ${isMultiCity ? formatLegRoute(legs) : `${brief.originAirports.join("/")} → ${brief.destinationAirports.join("/")}`}`,
    ...(isMultiCity
      ? legs.map((leg, index) =>
          `• Leg ${index + 1}: ${leg.originAirports.join("/")} → ${leg.destinationAirports.join("/")} · ${formatDateWindow(leg.departureWindow)}`
          // A date the traveller never named is marked as Captain's, so the
          // review is a check of the guesses rather than of the whole plan.
          + (captainChose.has(index) ? " (my pick)" : "")
          + (leg.arriveBy ? ` · arrive by ${formatCalendarDate(leg.arriveBy)}` : "")
        )
      : [`• Depart: ${formatDateWindow(brief.departureWindow)}`]),
    ...(!isMultiCity && draft.confirmationSnapshot.returnDate
      ? [
          `• Return: ${formatCalendarDate(draft.confirmationSnapshot.returnDate)}`,
          `• Stay: ${brief.stayNights!.preferred} night${brief.stayNights!.preferred === 1 ? "" : "s"}`
        ]
      : !isMultiCity
        ? [`• Trip type: One-way${defaults.has("tripType") ? " (default)" : ""}`]
        : ["• Trip type: Multi-city"]),
    `• Travellers: ${travellers}${defaults.has("travellers") ? " (default)" : ""}`,
    `• Cabin: ${label(brief.cabin)}${defaults.has("cabin") ? " (default)" : ""}`,
    `• Stops: ${stopLabel(brief.maxStops)}${defaults.has("maxStops") ? " (default)" : ""}`,
    `• Currency: ${brief.currency}${defaults.has("currency") ? " (default)" : ""}`,
    "",
    captainChose.size > 0
      ? "I filled the dates I marked from your itinerary. Tap Create or Cancel below, or reply with what you’d like to change."
      : "Tap Create or Cancel below, or reply with what you’d like to change."
  ];
  return lines.join("\n");
}

function formatDateWindow(window: { start: string; end: string }): string {
  return window.start === window.end
    ? formatCalendarDate(window.start)
    : `${formatCalendarDate(window.start)} – ${formatCalendarDate(window.end)}`;
}

export function formatTripCreationReceipt(receipt: TripCreationReceipt): string {
  return [
    receipt.created
      ? "Ok, here's what I have. Review or confirm to start exploring flights."
      : "Ok, here's the trip I already have. Review or confirm to start exploring flights.",
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
    departureWindow?: { start: string; end: string } | undefined;
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
    `You have ${inputs.length} saved trips:`,
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
  if (status === "recommended") return "I’ve found some flights for your trip.";
  if (status === "draft") return "Your trip is saved and ready to search.";
  return `Your trip is ${label(status).toLowerCase()}.`;
}

function formatTripSummaryLines(input: {
  originAirports: string[];
  destinationAirports: string[];
  legs?: Array<{
    originAirports: string[];
    destinationAirports: string[];
    departureDate: string;
    departureWindow?: { start: string; end: string } | undefined;
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
          `• Leg ${index + 1}: ${leg.originAirports.join("/")} → ${leg.destinationAirports.join("/")} · ${
            leg.departureWindow
              ? formatDateWindow(leg.departureWindow)
              : formatCalendarDate(leg.departureDate)
          }`
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
