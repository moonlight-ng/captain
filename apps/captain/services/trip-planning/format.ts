import {
  formatCalendarDate,
  totalTravellers,
  type TripCreationReceipt,
  type TripPlanDraft,
  type TripStatus
} from "@agents/flight-domain";

import { airportMarket, countryGuessForAirport } from "./airport-catalog.js";

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
    // Captured but previously unprinted. These carry no default — an absent
    // budget is no budget, not an assumed one — so they appear only when the
    // traveller actually set them, and never with a “(default)” marker.
    ...assumedAirportNotes(draft.state.assumedAirports ?? []),
    ...(brief.maximumPrice !== null
      ? [`• Budget: max ${brief.currency} ${brief.maximumPrice}`]
      : []),
    ...(brief.preferredAirlines.length > 0
      ? [`• Airlines: prefer ${brief.preferredAirlines.join(", ")}`]
      : []),
    ...(brief.excludedAirlines.length > 0
      ? [`• Avoiding: ${brief.excludedAirlines.join(", ")}`]
      : []),
    "",
    captainChose.size > 0
      ? "I filled the dates I marked from your itinerary. Tap Create or Cancel below, or reply with what you’d like to change."
      : "Tap Create or Cancel below, or reply with what you’d like to change."
  ];
  return lines.join("\n");
}

/**
 * Names the city Captain picked for a country the traveller named, and the
 * catalog cities it could swap to. Silent when the catalog holds only that one
 * city for the country — offering an alternative Captain cannot search would
 * be worse than offering none.
 */
function assumedAirportNotes(assumedAirports: string[]): string[] {
  return assumedAirports.flatMap((code) => {
    const market = airportMarket(code);
    const guess = countryGuessForAirport(code);
    if (!market || !guess) return [];
    return [
      `• ${market.label} for ${guess.countryLabel}${
        guess.alternatives.length > 0
          ? ` — say the word for ${formatList(guess.alternatives)}`
          : ""
      }`
    ];
  });
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

function formatDateWindow(window: { start: string; end: string }): string {
  return window.start === window.end
    ? formatCalendarDate(window.start)
    : `${formatCalendarDate(window.start)} – ${formatCalendarDate(window.end)}`;
}

export function formatTripCreationReceipt(receipt: TripCreationReceipt): string {
  return [
    "Itinerary ready to confirm.",
    "",
    ...formatTripItineraryLines(receipt),
    "",
    `Open trip: ${receipt.dashboardUrl}`
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

function formatTripItineraryLines(input: {
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
}): string[] {
  const legs = input.legs ?? [];
  const isMultiCity = legs.length >= 2;
  return [
    isMultiCity ? formatLegRoute(legs) : `${input.originAirports.join("/")} → ${input.destinationAirports.join("/")}`,
    ...(isMultiCity
      ? legs.map((leg, index) =>
          `Leg ${index + 1} · ${leg.originAirports.join("/")} → ${leg.destinationAirports.join("/")} · ${
            leg.departureWindow
              ? formatDateWindow(leg.departureWindow)
              : formatCalendarDate(leg.departureDate)
          }`
        )
      : [`Depart · ${formatCalendarDate(input.departureDate)}`]),
    ...(!isMultiCity && input.returnDate
      ? [
          `Return · ${formatCalendarDate(input.returnDate)}`,
          `Stay · ${input.stayNights} night${input.stayNights === 1 ? "" : "s"}`
        ]
      : [])
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

/**
 * Labelled fact lines from a trip confirmation. Shared by duplicate-confirmation
 * suppression on Telegram and by any caller that needs to compare two plan
 * restatements without depending on byte-identical wording.
 */
export function tripConfirmationFacts(message: string): string[] {
  return message
    .split("\n")
    .map((line) => line
      .trim()
      .replace(/^[•*-]\s*/u, "")
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en"))
    .filter((line) => /^(?:route|leg \d+|depart|return|stay|trip type|travellers|cabin|stops|currency|budget|airlines|avoiding):/u.test(line));
}

export function hasSameTripConfirmationFacts(expected: string, candidate: string): boolean {
  const expectedFacts = tripConfirmationFacts(expected);
  if (expectedFacts.length < 3) return false;
  const candidateFacts = new Set(tripConfirmationFacts(candidate));
  return expectedFacts.every((fact) => candidateFacts.has(fact));
}
