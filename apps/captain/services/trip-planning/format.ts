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
          // A date the traveller never named is marked as suggested, so the
          // review is a check of the guesses rather than of the whole plan.
          + (captainChose.has(index) ? " (suggested)" : "")
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
      ? "Suggested dates are marked above. Tap Create or Cancel below, or reply with what you’d like to change."
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
    formatActiveTripRoute(input),
    `${formatActiveTripDates(input)} · ${label(input.status)}`,
    "",
    `Open trip: ${input.dashboardUrl}`
  ].join("\n");
}

export function formatActiveTripList(inputs: ActiveTripFormatInput[]): string {
  return [
    `You have ${inputs.length} saved trips:`,
    "",
    ...inputs.flatMap((input) => {
      const route = formatActiveTripRoute(input);
      return [
        `• ${route}`,
        `  ${formatActiveTripDates(input)} · ${label(input.status)}`,
        `Open ${route}: ${input.dashboardUrl}`
      ];
    })
  ].join("\n");
}

/**
 * Bare “Yes” must only settle Create/Cancel or replace-consent. Soft schedule
 * proposals (“Does that schedule work?”) are not consent — treating them as
 * such creates a partial trip and then trips the one-trip replace prompt.
 */
export function isExplicitPlanConsentPrompt(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (looksLikeTripPlanConfirmation(text)) return true;
  if (looksLikeTripCreationReceipt(text)) return true;
  if (/Replace it with this (?:one|new\b)/iu.test(text)) return true;
  // A bare "yes" only counts against a prompt that asked for one, so this has
  // to recognise the replace question in whatever wording it currently uses.
  if (/should I swap it for this one/iu.test(text)) return true;
  if (/already tracking .+\bswap\b/isu.test(text)) return true;
  if (/already have .+ as your active trip/iu.test(text) && /\breplace\b/iu.test(text)) {
    return true;
  }
  if (/already have an active trip/iu.test(text) && /\breplace\b/iu.test(text)) {
    return true;
  }
  return false;
}

/**
 * Whatever the planner prefixed above the plan's own header — the date conflict
 * it resolved, most often. `formatTripPlanConfirmation` owns the header down, so
 * anything above it was added for the traveller and has to survive a channel
 * that saves the plan instead of showing the card it was written onto.
 */
export function tripPlanConfirmationNote(confirmation: string): string | null {
  const header = confirmation.search(/^Ready to create this trip:/mu);
  if (header <= 0) return null;
  return confirmation.slice(0, header).trim() || null;
}

/**
 * Text that offers a plan for Create/Cancel — the card the service writes, or a
 * model restatement that kept its header or its instruction. The buttons live
 * on the message that carries them, so this wording with nothing awaiting
 * confirmation points the traveller at a tap that is not there.
 */
export function looksLikeTripPlanConfirmation(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/^Ready to create this trip:/imu.test(text)) return true;
  return /Tap Create or Cancel below/iu.test(text);
}

/**
 * A tool-call preface cannot ask whether to save the trip: by the time the
 * traveller sees that preface, the same turn is already saving it. Keep this
 * separate from the formal Create/Cancel card so it cannot count as consent.
 */
export function looksLikeTripSaveOffer(message: string): boolean {
  const text = message.replace(/\s+/gu, " ").trim();
  if (!text) return false;
  return /\b(?:want me to|would you like me to|shall I|should I)\s+(?:save|create|set up)\b/iu
    .test(text)
    || /\bready for me to\s+(?:save|create|set up)\b/iu.test(text);
}

/** Whether the text carries the receipt for a saved trip. */
export function looksLikeTripCreationReceipt(message: string): boolean {
  return /^Itinerary ready to confirm\./imu.test(message.trim());
}

function formatActiveTripRoute(input: ActiveTripFormatInput): string {
  return input.legs && input.legs.length >= 2
    ? formatLegRoute(input.legs)
    : `${input.originAirports.join("/")} → ${input.destinationAirports.join("/")}`;
}

function formatActiveTripDates(input: ActiveTripFormatInput): string {
  const legs = input.legs ?? [];
  if (legs.length >= 2) {
    const start = legs[0]!.departureWindow?.start ?? legs[0]!.departureDate;
    const end = legs.at(-1)!.departureWindow?.end
      ?? legs.at(-1)!.departureWindow?.start
      ?? legs.at(-1)!.departureDate;
    return start === end
      ? formatCalendarDate(start)
      : `${formatCalendarDate(start)} – ${formatCalendarDate(end)}`;
  }
  if (input.returnDate) {
    return `${formatCalendarDate(input.departureDate)} – ${formatCalendarDate(input.returnDate)}`;
  }
  return formatCalendarDate(input.departureDate);
}

export function telegramDashboardMessage(message: string): {
  text: string;
  links: Array<{ text: string; url: string }>;
} {
  const lines = message.split("\n");
  const links: Array<{ text: string; url: string }> = [];
  const visibleLines = lines.filter((line) => {
    const browse = /^\s*Browse trip:\s*(https:\/\/\S+)\s*$/u.exec(line);
    if (browse?.[1]) {
      links.push({ text: "Browse trip", url: browse[1] });
      return false;
    }
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

/**
 * Below this, two messages have too little labelled plan in them to be called
 * the same plan: a single "• Route:" line is a mention, not a restatement.
 */
const MIN_COMPARABLE_PLAN_FACTS = 3;

/** Whether the text restates a whole plan rather than mentioning part of one. */
export function isTripPlanRestatement(message: string): boolean {
  return tripConfirmationFacts(message).length >= MIN_COMPARABLE_PLAN_FACTS;
}

export function hasSameTripConfirmationFacts(expected: string, candidate: string): boolean {
  const expectedFacts = tripConfirmationFacts(expected);
  if (expectedFacts.length < MIN_COMPARABLE_PLAN_FACTS) return false;
  const candidateFacts = new Set(tripConfirmationFacts(candidate));
  return expectedFacts.every((fact) => candidateFacts.has(fact));
}
