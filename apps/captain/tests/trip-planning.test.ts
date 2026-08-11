import { describe, expect, it } from "vitest";

import {
  EMPTY_TRIP_DRAFT_STATE,
  type TripBrief,
  type TripPlanDraft
} from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import {
  hasDeliveredTripConfirmation,
  isCaptainGreeting,
  isDuplicateTripConfirmationReply,
  parseTripPlanCallback,
  tripPlanConfirmationReplyMarkup,
  tripPlanReviewReplyMarkup
} from "../agent/channels/telegram.js";
import {
  isTripConfirmationText,
  TripPlanningService
} from "../services/trip-planning/service.js";
import type { TripDraftReadinessAssessor } from "../services/trip-planning/draft-readiness.js";
import {
  formatActiveTripList,
  formatTripPlanConfirmation,
  isExplicitPlanConsentPrompt,
  telegramDashboardMessage,
  type ActiveTripFormatInput
} from "../services/trip-planning/format.js";
import { TripService } from "../services/trips/service.js";
import { defaultTestBrief } from "./support.js";

const now = new Date("2025-07-01T12:00:00Z");

async function setup(clock = now, assessReadiness?: TripDraftReadinessAssessor) {
  const store = new MemoryCaptainPlatformStore();
  const user = await store.ensureTelegramUser({
    telegramUserId: 42,
    telegramChatId: 42,
    username: null,
    firstName: "Ada",
    lastName: null
  }, now);
  const trips = new TripService({ store, now: () => clock });
  const planning = new TripPlanningService({
    store,
    trips,
    apiKey: null,
    ...(assessReadiness ? { assessReadiness } : {}),
    now: () => clock,
    dashboardUrlForTrip: (_userId, tripId) =>
      `https://captain.example/t#test-${tripId}`
  });
  return { store, user, trips, planning };
}

/**
 * The smallest draft `formatTripPlanConfirmation` reads: the confirmation
 * snapshot's brief, plus the state fields it consults to decide which values
 * were the traveller's and which were Captain's.
 */
function confirmableDraft(overrides: Partial<TripBrief> = {}): TripPlanDraft {
  const brief = defaultTestBrief({
    tripType: "one_way",
    stayNights: null,
    ...overrides
  });
  return {
    state: {
      ...EMPTY_TRIP_DRAFT_STATE,
      tripType: brief.tripType,
      travellers: brief.travellers,
      cabin: brief.cabin,
      maxStops: brief.maxStops,
      currency: brief.currency
    },
    confirmationSnapshot: {
      input: { brief },
      departureDate: brief.departureWindow.start,
      returnDate: null
    }
  } as unknown as TripPlanDraft;
}

function legacyTripListEntry(
  destination: string,
  departureDate: string,
  dashboardUrl: string
): ActiveTripFormatInput {
  return {
    originAirports: ["LOS"],
    destinationAirports: [destination],
    departureDate,
    returnDate: null,
    stayNights: null,
    travellers: 1,
    cabin: "economy",
    maxStops: 2,
    currency: "USD",
    status: "tracking",
    dashboardUrl
  };
}

describe("Captain trip planning", () => {
  it("saves the Nairobi–Uganda–Lagos draft with a trip link after two answers", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, store, user } = await setup(clock);
    const request = "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
      + "a birthday from Nov 10 - 14. The 19 - 22, Uganda. Then a wedding in Lagos Dec 10. "
      + "I want to spend Christmas in Lagos.";

    const first = await planning.prepare(user.id, request);
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected the origin question");
    expect(first.prompt).toContain("Where will you be flying from to Nairobi?");
    expect(first.draft.state.questionsAsked).toBe(1);

    const second = await planning.handleOpenDraftText(user.id, "From Lagos", null);
    expect(second?.status).toBe("needs_input");
    if (!second || second.status !== "needs_input") throw new Error("Expected the first-flight question");
    expect(second.prompt).toContain("When can you fly Lagos → Nairobi?");
    expect(second.prompt).toContain("arrive by Wednesday, 4 Nov 2026");
    expect(second.draft.state.questionsAsked).toBe(2);

    const saved = await planning.handleOpenDraftText(user.id, "The Sunday before", null);
    expect(saved?.status).toBe("started");
    if (!saved || saved.status !== "started") throw new Error("Expected a saved draft trip");
    expect(saved.message).toContain("Itinerary ready to confirm.");
    expect(saved.message).toContain("Leg 1 · LOS → NBO · Sunday, 1 Nov 2026");
    expect(saved.message).toContain("Open trip: https://captain.example/t#test-");
    expect(saved.message).not.toContain("traveller");
    expect(saved.message).not.toContain("Send /trip");
    expect(saved.receipt.status).toBe("draft");
    expect(await store.getTrip(user.id, saved.receipt.tripId)).toMatchObject({ status: "draft" });
  });

  it("can share an editable plan as soon as the draft has enough information", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, user } = await setup(clock, async () => true);

    const result = await planning.prepare(user.id, "Plan a trip from Lagos to Nairobi");
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected plan review");
    expect(result.draft.state.questionsAsked).toBe(0);
    expect(result.draft.confirmationSnapshot?.input.brief).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["NBO"]
    });
  });

  it("does not treat a correction as the signal to share a plan", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, user } = await setup(clock, async () => false);

    const first = await planning.prepare(user.id, "Plan a trip");
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected the route question");
    expect(first.prompt).toBe("Where are you flying from and to?");
    expect(first.draft.state.questionsAsked).toBe(1);

    const second = await planning.handleOpenDraftText(user.id, "Lagos to Nairobi", null);
    expect(second?.status).toBe("needs_input");
    if (!second || second.status !== "needs_input") throw new Error("Expected the date question");
    expect(second.prompt).toBe("What date would you like to depart?");
    expect(second.draft.state.questionsAsked).toBe(2);

    const correction = await planning.handleOpenDraftText(
      user.id,
      "Actually, Lagos to London instead",
      null
    );
    expect(correction?.status).toBe("needs_input");
    if (!correction || correction.status !== "needs_input") {
      throw new Error("Expected another date question after the correction");
    }
    expect(correction.draft.state.questionsAsked).toBe(3);
    expect(correction.prompt).toBe("What date would you like to depart?");
    expect(correction.draft.state.legs[0]?.destinationAirports).toEqual(["LON"]);
  });

  it("parses revision-bound Telegram confirmation buttons", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(tripPlanConfirmationReplyMarkup({ id, revision: 3 })).toEqual({
      inline_keyboard: [[{
        text: "Create",
        callback_data: `captain-trip:start:${id}:3`
      }, {
        text: "Cancel",
        callback_data: `captain-trip:cancel:${id}:3`
      }]]
    });
    expect(parseTripPlanCallback(`captain-trip:start:${id}:3`)).toEqual({
      type: "start",
      draftId: id,
      revision: 3
    });
    expect(parseTripPlanCallback(`captain-trip:start:${id}:0`)).toBeNull();
  });

  it("keeps prepare_trip on awaiting_confirmation instead of auto-creating", async () => {
    const { agentFacingPrepareResult } = await import("../agent/tools/prepare_trip.js");
    const draft = confirmableDraft();
    const confirmation = formatTripPlanConfirmation(draft);
    const result = agentFacingPrepareResult({
      status: "awaiting_confirmation",
      draft,
      confirmation
    });
    expect(result).toMatchObject({
      status: "awaiting_confirmation",
      confirmation,
      message: confirmation
    });
    expect(result).not.toHaveProperty("receipt");
  });

  it("binds Review and Confirm to the saved trip version", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(tripPlanReviewReplyMarkup({
      tripId: id,
      version: 4,
      status: "draft",
      dashboardUrl: "https://captain.example/trip"
    })).toEqual({
      inline_keyboard: [[{
        text: "Confirm",
        callback_data: `captain-trip:confirm:${id}:4`
      }, {
        text: "Review",
        url: "https://captain.example/trip"
      }]]
    });
    expect(parseTripPlanCallback(`captain-trip:confirm:${id}:4`)).toEqual({
      type: "confirm",
      tripId: id,
      version: 4
    });
  });

  it("recognizes concise text confirmation without treating review as consent", () => {
    expect(isTripConfirmationText("confirm")).toBe(true);
    expect(isTripConfirmationText("Yes.")).toBe(true);
    expect(isTripConfirmationText("review it first")).toBe(false);
  });

  it("distinguishes a delivered confirmation from an older button message", () => {
    const draft = { updatedAt: "2026-09-01T12:00:00.000Z" };
    expect(hasDeliveredTripConfirmation(draft, "Ready", [{
      role: "assistant",
      content: "Ready",
      createdAt: "2026-09-01T11:59:59.000Z"
    }])).toBe(false);
    expect(hasDeliveredTripConfirmation(draft, "Ready", [{
      role: "assistant",
      content: "Ready",
      createdAt: "2026-09-01T12:00:01.000Z"
    }])).toBe(true);
  });

  it("suppresses a repeated confirmation after the button message was delivered", () => {
    const draft = { updatedAt: "2026-09-01T12:00:00.000Z" };
    const confirmation = [
      "Ready to create this trip:",
      "",
      "• Route: LOS → LON",
      "• Depart: Sunday, 6 Sep 2026",
      "• Trip type: One-way (default)",
      "• Travellers: 1 (default)",
      "• Cabin: Economy (default)",
      "• Stops: At most 2 stops (default)",
      "• Currency: USD (default)",
      "",
      "Tap Create or Cancel below, or reply with what you’d like to change."
    ].join("\n");
    const echo = confirmation.replace(
      "Tap Create or Cancel below, or reply with what you’d like to change.",
      "Reply “Create” to start tracking, or tell me what you’d like to change."
    );
    const delivered = [{
      role: "assistant" as const,
      content: confirmation,
      createdAt: "2026-09-01T12:00:01.000Z"
    }];

    expect(isDuplicateTripConfirmationReply(draft, confirmation, echo, delivered)).toBe(true);
    expect(isDuplicateTripConfirmationReply(
      draft,
      confirmation,
      echo.replace("LOS → LON", "LOS → NYC"),
      delivered
    )).toBe(false);
  });

  it("routes only standalone greetings away from conversational history", () => {
    expect(isCaptainGreeting("Hi there")).toBe(true);
    expect(isCaptainGreeting("Good morning!")).toBe(true);
    expect(isCaptainGreeting("Hi, plan a trip to New York")).toBe(false);
    expect(isCaptainGreeting("Where is my trip?")).toBe(false);
  });

  it("routes a bare dated route directly to trip planning", () => {
    expect(TripPlanningService.isTripPlanningRequest(
      "Lagos to London September 6"
    )).toBe(true);
    expect(TripPlanningService.isTripPlanningRequest(
      "Lagos to London next weekend"
    )).toBe(true);
    expect(TripPlanningService.isTripPlanningRequest(
      "I moved from Lagos to London"
    )).toBe(false);
  });

  it("keeps exploratory itinerary and date planning in the conversation", () => {
    for (const request of [
      "I have a potential itinerary and need help figuring out what dates work",
      "Help me plan an itinerary to London and Paris; my dates are flexible",
      "I want to travel in September but I’m not sure which dates make sense"
    ]) {
      expect(TripPlanningService.isTripPlanningRequest(request)).toBe(true);
      expect(TripPlanningService.needsItineraryPlanningConversation(request)).toBe(true);
    }

    expect(TripPlanningService.needsItineraryPlanningConversation(
      "Lagos to London on 6 September 2026"
    )).toBe(false);
  });

  it("recognises event context as a multi-city flight-planning request", () => {
    const request = "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
      + "a birthday from Nov 10 - 14. Then 19 - 22, Uganda. Then a wedding, Dec 10. "
      + "I'll be in London and want to spend Christmas in Lagos.";

    expect(TripPlanningService.isTripPlanningRequest(request)).toBe(true);
    expect(TripPlanningService.needsItineraryPlanningConversation(request)).toBe(false);
  });

  it("grounds the Nairobi narrative before asking to replace the active trip", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, trips, store, user } = await setup(clock);
    const current = await trips.create(user.id, {
      title: "Existing London trip",
      brief: defaultTestBrief({
        originAirports: ["LOS"],
        destinationAirports: ["LHR"],
        tripType: "one_way",
        stayNights: null
      })
    });
    await planning.prepare(user.id, "Track a trip to New York on November 2");
    const narrative = "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
      + "a birthday from Nov 10 - 14. Then 19 - 22, Uganda. Then a wedding, Dec 10. "
      + "I'll be in London and want to spend Christmas in Lagos.";

    const originQuestion = await planning.handleOpenDraftText(user.id, narrative, null);
    expect(originQuestion?.status).toBe("needs_input");
    if (!originQuestion || originQuestion.status !== "needs_input") {
      throw new Error("Expected the missing origin question");
    }
    expect(originQuestion.prompt).toContain("Nairobi → Entebbe → London → Lagos");
    expect(originQuestion.prompt).toContain("Where will you be flying from to Nairobi?");
    expect(originQuestion.prompt).not.toContain("Replace it");
    expect(originQuestion.draft.confirmationSnapshot).toBeNull();
    expect(originQuestion.draft.state).toMatchObject({
      tripType: "multi_city",
      legs: [
        {
          originAirports: [],
          destinationAirports: ["NBO"],
          departure: null,
          feasibleDepartureWindow: { start: "2026-08-08", end: "2026-11-04" },
          proposedDeparture: { start: "2026-10-29", end: "2026-11-04" },
          arriveBy: "2026-11-04"
        },
        {
          originAirports: ["NBO"],
          destinationAirports: ["EBB"],
          departure: { start: "2026-11-15", end: "2026-11-19" },
          arriveBy: "2026-11-19"
        },
        {
          originAirports: ["EBB"],
          destinationAirports: ["LON"],
          departure: null,
          feasibleDepartureWindow: { start: "2026-11-23", end: "2026-12-10" },
          proposedDeparture: { start: "2026-12-04", end: "2026-12-10" },
          arriveBy: "2026-12-10"
        },
        {
          originAirports: ["LON"],
          destinationAirports: ["LOS"],
          departure: null,
          feasibleDepartureWindow: { start: "2026-12-11", end: "2026-12-25" },
          proposedDeparture: { start: "2026-12-19", end: "2026-12-25" },
          arriveBy: "2026-12-25"
        }
      ]
    });
    expect(await trips.get(user.id, current.trip.id)).toMatchObject({ status: "draft" });

    // Captain asks directly about the first flight, which has the tightest
    // arrival deadline.
    const departureQuestion = await planning.handleOpenDraftText(user.id, "Accra", null);
    expect(departureQuestion?.status).toBe("needs_input");
    if (!departureQuestion || departureQuestion.status !== "needs_input") {
      throw new Error("Expected the first-flight question");
    }
    expect(departureQuestion.prompt).toContain("When can you fly Accra → Nairobi?");
    expect(departureQuestion.prompt).toContain("arrive by Wednesday, 4 Nov 2026");

    // Once that answer arrives, the complete draft is grounded before Captain
    // asks for consent to replace the traveller's existing trip.
    const replacement = await planning.handleOpenDraftText(user.id, "The Sunday before", null);
    expect(replacement?.status).toBe("needs_input");
    if (!replacement || replacement.status !== "needs_input") {
      throw new Error("Expected replacement consent");
    }
    expect(replacement.prompt).toContain("Replace it");
    expect(replacement.prompt).toContain("/feedback");
    // The recap and the question are two turns. Bundled into one message the
    // question lands under a dozen dated bullets, where it is least likely to
    // be read and answered.
    expect(replacement.promptParts).toHaveLength(2);
    const [recap, question] = replacement.promptParts!;
    expect(recap).toContain("I mapped the flights as:");
    expect(recap).toContain("→");
    expect(recap).not.toContain("Replace it");
    expect(question).toContain("Replace it");
    expect(question).toContain("/feedback");
    expect(question).not.toContain("I mapped the flights as:");
    // `prompt` stays the single canonical string for anything that needs one.
    expect(replacement.prompt).toBe(`${recap}\n\n${question}`);
    expect(await trips.get(user.id, current.trip.id)).toMatchObject({ status: "draft" });

    const started = await planning.handleOpenDraftText(user.id, "Yes", null);
    expect(started?.status).toBe("started");
    if (!started || started.status !== "started") {
      throw new Error("Expected the draft to be saved after replacement consent");
    }
    expect(await trips.get(user.id, current.trip.id)).toMatchObject({
      status: "archived",
      archiveReason: "replaced"
    });
    const graph = await store.getTripGraph(user.id, started.receipt.tripId);
    expect(graph.cities.map((city) => city.airportCodes)).toEqual([
      ["ACC"], ["NBO"], ["EBB"], ["LON"], ["LOS"]
    ]);
    expect(graph.cities.map((city) => city.arrivalWindow)).toEqual([
      null,
      { start: "2026-11-04", end: "2026-11-04" },
      { start: "2026-11-19", end: "2026-11-19" },
      { start: "2026-12-10", end: "2026-12-10" },
      { start: "2026-12-25", end: "2026-12-25" }
    ]);
    expect(graph.legs.map((leg) => leg.arriveBy)).toEqual([
      "2026-11-04", "2026-11-19", "2026-12-10", "2026-12-25"
    ]);
  });

  it("keeps clarifying when the traveller declines a proposed window", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, user } = await setup(clock);
    const narrative = "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
      + "a birthday from Nov 10 - 14. Then 19 - 22, Uganda. Then a wedding, Dec 10. "
      + "I'll be in London and want to spend Christmas in Lagos.";

    await planning.prepare(user.id, narrative);
    const dateQuestion = await planning.handleOpenDraftText(user.id, "Accra", null);
    expect(dateQuestion?.status).toBe("needs_input");

    const declined = await planning.handleOpenDraftText(user.id, "No", null);
    expect(declined?.status).toBe("needs_input");
    if (!declined || declined.status !== "needs_input") {
      throw new Error("Expected a new date question");
    }
    expect(declined.draft.state.questionsAsked).toBe(3);
    expect(declined.draft.state.legs[0]?.proposedDeparture).toBeNull();
    expect(declined.prompt).toContain(
      "What seven-day window should I use for Accra → Nairobi"
    );
  });

  it("persists grounded flight windows for each adjacent city pair", async () => {
    const { planning, user } = await setup();
    const planned = await planning.prepare(
      user.id,
      "Create a multi-city trip Nairobi to Uganda November 15-18, "
        + "Uganda to London November 23-29, and London to Lagos December 18-24."
    );

    expect(planned.status).toBe("awaiting_confirmation");
    if (planned.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(planned.draft.confirmationSnapshot?.input.brief).toMatchObject({
      tripType: "multi_city",
      originAirports: ["NBO"],
      destinationAirports: ["LOS"],
      context: "",
      legs: [
        { originAirports: ["NBO"], destinationAirports: ["EBB"], departureWindow: { start: "2025-11-15", end: "2025-11-18" } },
        { originAirports: ["EBB"], destinationAirports: ["LON"], departureWindow: { start: "2025-11-23", end: "2025-11-29" } },
        { originAirports: ["LON"], destinationAirports: ["LOS"], departureWindow: { start: "2025-12-18", end: "2025-12-24" } }
      ]
    });
  });

  it("reproduces the Lagos-to-New-York conversation without changing dates", async () => {
    const { planning, trips, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Set up a round trip from home to New York for the week starting Sunday, August 17 and back Sunday the following week."
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected a clarification");
    expect(first.missingFields).toContain("originAirports");
    expect(first.missingFields).not.toContain("travellers");
    expect(first.prompt).toContain("Where are you flying from");

    const second = await planning.prepare(user.id, "Lagos just me", null, first.draft.id);
    expect(second.status).toBe("started");
    if (second.status !== "started") throw new Error("Expected the draft to be saved");
    expect(second.draft.confirmationSnapshot?.input.brief).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["NYC"],
      departureWindow: { start: "2025-08-17", end: "2025-08-17" },
      stayNights: { minimum: 7, preferred: 7, maximum: 7 },
      travellers: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxStops: 2,
      currency: "USD"
    });
    expect(second.message).toContain("Sunday, 17 Aug 2025");
    expect(second.message).toContain("Sunday, 24 Aug 2025");

    const started = second;
    expect(started.receipt).toMatchObject({
      created: true,
      originAirports: ["LOS"],
      destinationAirports: ["NYC"],
      departureDate: "2025-08-17",
      returnDate: "2025-08-24",
      stayNights: 7
    });
    expect(started.message).not.toContain("Send /trip");
    // The structured goal stays available for decision-making without being
    // printed as internal planning language in the traveller-facing receipt.
    expect(started.receipt.goal)
      .toBe("Get you LOS → NYC and back on 17 Aug for the best balance of fare and "
        + "journey time, using verified fares as prices change.");
    expect(started.message).not.toContain("Goal:");
    expect(started.message).not.toContain(started.receipt.goal);
    expect(started.message).toContain("Itinerary ready to confirm.");
    expect(started.message).toContain(`Open trip: https://captain.example/t#test-${started.receipt.tripId}`);
    expect(started.message).not.toContain("Trip reference");
    const renderedReceipt = telegramDashboardMessage(started.message);
    expect(renderedReceipt.text).not.toContain("Trip reference");
    expect(renderedReceipt.text).not.toContain(started.receipt.tripId);
    await expect(planning.groundAssistantMessage(user.id, started.message))
      .resolves.toEqual({ message: started.message, createdTrip: true });
    await expect(planning.groundAssistantMessage(
      user.id,
      `All set!\n\n${started.message}\n\nAnything else?`
    )).resolves.toEqual({ message: started.message, createdTrip: true });
    await expect(planning.groundAssistantMessage(
      user.id,
      `Your trip has been set up. trip reference: ${started.receipt.tripId}`
    )).resolves.toEqual({
      message: "I couldn’t verify a trip-creation receipt. Send /trip to check your trip.",
      createdTrip: false
    });
    await expect(planning.groundAssistantMessage(user.id, "Your trip has been set up."))
      .resolves.toEqual({
        message: "I couldn’t verify a trip-creation receipt. Send /trip to check your trip.",
        createdTrip: false
      });
    for (const greeting of [
      "Hi there! I can help you get started planning a trip. Where would you like to go?",
      "Let’s get your trip started. Where are you flying from?",
      "I can help you set up a trip whenever you’re ready."
    ]) {
      await expect(planning.groundAssistantMessage(user.id, greeting)).resolves.toEqual({
        message: greeting,
        createdTrip: false
      });
    }

    const retried = await planning.confirm(user.id, second.draft.id, second.draft.revision);
    expect(retried.status).toBe("started");
    if (retried.status !== "started") throw new Error("Expected idempotent result");
    expect(retried.receipt.created).toBe(false);
    expect(await trips.list(user.id)).toHaveLength(1);
  });

  it("prepares and starts a Lagos to New York to London multi-city trip", async () => {
    const { planning, trips, user } = await setup();
    expect(TripPlanningService.isTripPlanningRequest(
      "What are the best options to fly from Lagos to New York and back to London from Aug 16 - 23?"
    )).toBe(true);
    const ready = await planning.prepare(
      user.id,
      "Find the best flights from Lagos to New York and back to London from Aug 16 - 23."
    );

    expect(ready?.status).toBe("awaiting_confirmation");
    if (ready?.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.draft.confirmationSnapshot?.input).toMatchObject({
      title: "LOS to NYC to LON",
      brief: {
        originAirports: ["LOS"],
        destinationAirports: ["LON"],
        tripType: "multi_city",
        stayNights: null,
        legs: [
          {
            originAirports: ["LOS"],
            destinationAirports: ["NYC"],
            departureWindow: { start: "2025-08-16", end: "2025-08-16" }
          },
          {
            originAirports: ["NYC"],
            destinationAirports: ["LON"],
            departureWindow: { start: "2025-08-23", end: "2025-08-23" }
          }
        ]
      }
    });
    expect(ready.confirmation).toContain("LOS → NYC → LON");
    expect(ready.confirmation).toContain("Travellers: 1 (default)");
    expect(ready.confirmation).toContain(
      "Tap Create or Cancel below, or reply with what you’d like to change."
    );

    const started = await planning.confirm(user.id, ready.draft.id, ready.draft.revision);
    expect(started.status).toBe("started");
    if (started.status !== "started") throw new Error("Expected started trip");
    expect(started.receipt.legs).toHaveLength(2);
    expect(started.message).toContain("LOS → NYC → LON");
    const saved = await trips.list(user.id);
    expect(saved[0]?.brief.tripType).toBe("multi_city");
    expect(telegramDashboardMessage(
      `Trip saved\nOpen trip: https://captain.example/t#fresh-${started.receipt.tripId}`
    )).toEqual({
      text: "Trip saved",
      links: [{
        text: "Open trip",
        url: `https://captain.example/t#fresh-${started.receipt.tripId}`
      }]
    });
  });

  it("binds every date to its own leg in a longer multi-city trip", async () => {
    const { planning, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Fly from Lagos to New York on Aug 17, to London on the 20th, to Paris on the 23rd"
    );
    expect(ready?.status).toBe("awaiting_confirmation");
    if (ready?.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.draft.confirmationSnapshot?.input.brief.legs).toEqual([
      expect.objectContaining({
        originAirports: ["LOS"],
        destinationAirports: ["NYC"],
        departureWindow: { start: "2025-08-17", end: "2025-08-17" }
      }),
      expect.objectContaining({
        originAirports: ["NYC"],
        destinationAirports: ["LON"],
        departureWindow: { start: "2025-08-20", end: "2025-08-20" }
      }),
      expect.objectContaining({
        originAirports: ["LON"],
        destinationAirports: ["PAR"],
        departureWindow: { start: "2025-08-23", end: "2025-08-23" }
      })
    ]);
  });

  it("coalesces concurrent confirmations into one created and one reused receipt", async () => {
    const { planning, trips, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const results = await Promise.all([
      planning.confirm(user.id, ready.draft.id, ready.draft.revision),
      planning.confirm(user.id, ready.draft.id, ready.draft.revision)
    ]);
    expect(results.map((result) => result.status)).toEqual(["started", "started"]);
    const created = results.map((result) => result.status === "started" && result.receipt.created);
    expect(created.sort()).toEqual([false, true]);
    expect(await trips.list(user.id)).toHaveLength(1);
  });

  it("clarifies weekday conflicts and never creates the inconsistent trip", async () => {
    const { planning, trips, user } = await setup();
    const result = await planning.prepare(
      user.id,
      "Create a round trip from Lagos to New York departing Sunday August 17 2026 and returning Sunday August 24 2026 for one adult."
    );
    expect(result.status).toBe("needs_input");
    if (result.status !== "needs_input") throw new Error("Expected date clarification");
    expect(result.prompt).toContain("Monday, not Sunday");
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("resolves a relative departure and defaults an unspecified trip to one-way", async () => {
    const { planning, user } = await setup();
    const result = await planning.prepare(
      user.id,
      "Lagos to Anambra this Saturday"
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.confirmationSnapshot?.input.brief).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["ANA"],
      tripType: "one_way",
      departureWindow: { start: "2025-07-05", end: "2025-07-05" },
      maxStops: 1,
      currency: "USD"
    });
  });

  it("understands an implied-origin return and inherits the month for the second leg", async () => {
    const clock = new Date("2026-07-27T06:23:00Z");
    const { planning, user } = await setup(clock);
    const result = await planning.prepare(
      user.id,
      "Let's track a trip to New York on Aug 17. Return to London on the 23"
    );

    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.confirmationSnapshot?.input.brief).toMatchObject({
      originAirports: ["LON"],
      destinationAirports: ["NYC"],
      tripType: "round_trip",
      departureWindow: { start: "2026-08-17", end: "2026-08-17" },
      stayNights: { minimum: 6, preferred: 6, maximum: 6 }
    });
    expect(result.confirmation).toContain("LON → NYC");
    expect(result.confirmation).toContain("Monday, 17 Aug 2026");
    expect(result.confirmation).toContain("Sunday, 23 Aug 2026");
    expect(result.draft.state.legs).toMatchObject([
      { originAirports: ["LON"], destinationAirports: ["NYC"] },
      { originAirports: ["NYC"], destinationAirports: ["LON"] }
    ]);
  });

  // The traveller wrote "No return." and got a flight home anyway: the words
  // set tripType to round_trip, which outranked the leg count, collapsed the
  // itinerary to its first flight, and had the reducer mirror it.
  it("does not invent a flight home for a one-way multi-city trip", async () => {
    const { planning, user } = await setup(new Date("2026-08-08T12:00:00.000Z"));
    const result = await planning.prepare(
      user.id,
      "London to Paris on Nov 4, Paris to New York on Dec 9, "
      + "New York to Lagos on Dec 20. No return. Just me."
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    expect(result.draft.state.tripType).toBe("multi_city");
    expect(result.draft.state.legs.map((leg) => [
      leg.originAirports, leg.destinationAirports
    ])).toEqual([
      [["LON"], ["PAR"]],
      [["PAR"], ["NYC"]],
      [["NYC"], ["LOS"]]
    ]);

    const brief = result.draft.confirmationSnapshot!.input.brief;
    expect(brief.tripType).toBe("multi_city");
    expect(brief.legs).toHaveLength(3);
    expect(brief.destinationAirports).toEqual(["LOS"]);
    expect(brief.stayNights).toBeNull();
    // Nothing flies back to where the traveller started.
    expect(brief.legs!.some((leg) => leg.destinationAirports.includes("LON"))).toBe(false);
    expect(result.draft.confirmationSnapshot!.returnDate).toBeNull();
  });

  it("reads a genuine there-and-back pair as a round trip", async () => {
    const { planning, user } = await setup(new Date("2026-08-08T12:00:00.000Z"));
    const result = await planning.prepare(
      user.id,
      "Round trip from Lagos to New York departing 17 September 2026 "
      + "and returning 24 September 2026 for one adult."
    );
    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.confirmationSnapshot!.input.brief.tripType).toBe("round_trip");
    expect(result.draft.confirmationSnapshot!.returnDate).toBe("2026-09-24");
  });

  it("scopes a follow-up to the pending return leg without overwriting departure", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a round trip from Lagos to New York on Aug 17"
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected a return-date question");
    expect(first.missingFields).toContain("returnDate");

    const completed = await planning.prepare(
      user.id,
      "Aug 23 to Lagos",
      null,
      first.draft.id
    );
    expect(completed.status).toBe("started");
    if (completed.status !== "started") throw new Error("Expected the draft to be saved");
    expect(completed.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-17",
      returnDate: "2025-08-23"
    });
    expect(completed.draft.state.legs.map((leg) => leg.departure)).toEqual([
      { kind: "exact", date: "2025-08-17" },
      { kind: "exact", date: "2025-08-23" }
    ]);
  });

  it("applies only the route and date operations expressed by a follow-up", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on Aug 17"
    );
    expect(first.status).toBe("awaiting_confirmation");
    if (first.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const attemptedRewrite = await planning.prepare(
      user.id,
      "Aug 23 to London",
      null,
      first.draft.id
    );
    expect(attemptedRewrite.status).toBe("awaiting_confirmation");
    if (attemptedRewrite.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(attemptedRewrite.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-23",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"]
        }
      }
    });
  });

  it("applies a targeted correction without erasing unrelated explicit facts", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on Aug 17"
    );
    if (first.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const corrected = await planning.prepare(
      user.id,
      "Actually, make the destination London",
      null,
      first.draft.id
    );
    expect(corrected.status).toBe("awaiting_confirmation");
    if (corrected.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(corrected.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-17",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"]
        }
      }
    });
  });

  it("does not reconstruct missing facts from conversation history", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a trip to New York on Aug 17"
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected an origin question");
    expect(first.prompt).toBe("Where are you flying from?");

    const repair = await planning.prepare(
      user.id,
      "It's in the message",
      null,
      first.draft.id
    );
    expect(repair.status).toBe("needs_input");
    if (repair.status !== "needs_input") throw new Error("Expected a repaired clarification");
    expect(repair.prompt).toBe(first.prompt);
    expect(repair.draft.state).toEqual({
      ...first.draft.state,
      questionsAsked: 2
    });
  });

  it("does not let an open draft consume an unrelated Telegram message", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a trip to New York on Aug 17"
    );
    if (first.status !== "needs_input") throw new Error("Expected an origin question");

    await expect(planning.handleOpenDraftText(
      user.id,
      "What can you help me with?",
      null
    )).resolves.toBeNull();
    const unchanged = await planning.findOpen(user.id);
    expect(unchanged?.revision).toBe(first.draft.revision);
  });

  it("starts an explicitly new draft instead of forcing it into the open one", async () => {
    const { planning, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Track a trip to New York on Aug 17"
    );
    if (first.status !== "needs_input") throw new Error("Expected an origin question");

    const replacement = await planning.handleOpenDraftText(
      user.id,
      "Track another trip from Lagos to London on Aug 20",
      null
    );
    expect(replacement?.status).toBe("awaiting_confirmation");
    if (replacement?.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(replacement.draft.id).not.toBe(first.draft.id);
    expect(replacement.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-20",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"]
        }
      }
    });
  });

  it("replaces a stale draft when a complete track directive is repeated", async () => {
    const clock = new Date("2026-07-27T06:23:00Z");
    const { planning, user } = await setup(clock);
    const stale = await planning.prepare(
      user.id,
      "Track a round trip from New York to London on Aug 23"
    );
    expect(stale.status).toBe("needs_input");
    if (stale.status !== "needs_input") throw new Error("Expected an open stale draft");

    const replacement = await planning.handleOpenDraftText(
      user.id,
      "Let's track a trip to New York on Aug 17. Return to London on the 23",
      null
    );
    expect(replacement?.status).toBe("awaiting_confirmation");
    if (replacement?.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(replacement.draft.id).not.toBe(stale.draft.id);
    expect(replacement.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2026-08-17",
      returnDate: "2026-08-23",
      input: {
        brief: {
          originAirports: ["LON"],
          destinationAirports: ["NYC"],
          tripType: "round_trip"
        }
      }
    });
  });

  it("keeps route context and resolves a next-day return across follow-up turns", async () => {
    const clock = new Date("2026-07-27T07:55:00Z");
    const { planning, user } = await setup(clock);
    const first = await planning.prepare(
      user.id,
      "Let's do another trip to Abuja this Sunday"
    );
    expect(first.status).toBe("needs_input");
    if (first.status !== "needs_input") throw new Error("Expected an origin question");
    expect(first.prompt).toBe("Where are you flying from?");

    const completed = await planning.prepare(
      user.id,
      "Lagos as well. Return to Lagos next day",
      null,
      first.draft.id
    );
    expect(completed.status).toBe("started");
    if (completed.status !== "started") throw new Error("Expected the draft to be saved");
    expect(completed.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2026-08-02",
      returnDate: "2026-08-03",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["ABV"],
          tripType: "round_trip"
        }
      }
    });

    expect(completed.receipt).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["ABV"],
      departureDate: "2026-08-02",
      returnDate: "2026-08-03"
    });
  });

  it("inherits the month when answering with an ordinal weekday", async () => {
    const clock = new Date("2026-07-29T00:00:00Z");
    const { planning, user } = await setup(clock);
    const first = await planning.prepare(
      user.id,
      "Check for Lagos to London first week of September"
    );
    expect(first.status).toBe("awaiting_confirmation");
    if (first.status !== "awaiting_confirmation") throw new Error("Expected a window confirmation");

    const completed = await planning.prepare(
      user.id,
      "The first Sunday",
      null,
      first.draft.id
    );
    expect(completed.status).toBe("awaiting_confirmation");
    if (completed.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(completed.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2026-09-06",
      input: {
        brief: {
          originAirports: ["LOS"],
          destinationAirports: ["LON"],
          tripType: "one_way"
        }
      }
    });
  });

  it("applies an explicit ordinal-weekday date correction", async () => {
    const clock = new Date("2026-07-29T00:00:00Z");
    const { planning, user } = await setup(clock);
    const first = await planning.prepare(
      user.id,
      "Check for Lagos to London on August 2"
    );
    expect(first.status).toBe("awaiting_confirmation");
    if (first.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const corrected = await planning.prepare(
      user.id,
      "First Sunday September not August",
      null,
      first.draft.id
    );
    expect(corrected.status).toBe("awaiting_confirmation");
    if (corrected.status !== "awaiting_confirmation") throw new Error("Expected corrected confirmation");
    expect(corrected.draft.confirmationSnapshot?.departureDate).toBe("2026-09-06");
  });

  it("does not silently create a multi-traveller trip in the one-adult beta", async () => {
    const { planning, trips, user } = await setup();
    const result = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for two adults."
    );
    expect(result.status).toBe("needs_input");
    if (result.status !== "needs_input") throw new Error("Expected one-adult clarification");
    expect(result.prompt).toContain("exactly one adult");
    expect(result.missingFields).toContain("travellers");
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("rejects a return-date revision that moves before the preserved departure", async () => {
    const { planning, trips, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a round trip from Lagos to New York departing August 17 2025 and returning August 24 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    const revised = await planning.prepare(
      user.id,
      "Return August 10 2025 instead.",
      null,
      ready.draft.id
    );
    expect(revised.status).toBe("awaiting_confirmation");
    if (revised.status !== "awaiting_confirmation") throw new Error("Expected retained confirmation");
    expect(revised.confirmation).toContain("return date must be after");
    expect(revised.confirmation).toContain("I kept the previous dates");
    expect(revised.draft.confirmationSnapshot).toMatchObject({
      departureDate: "2025-08-17",
      returnDate: "2025-08-24"
    });
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("rejects stale confirmation revisions", async () => {
    const { planning, trips, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const revised = await planning.prepare(
      user.id,
      "Make it business class.",
      null,
      ready.draft.id
    );
    if (revised.status !== "awaiting_confirmation") throw new Error("Expected revised confirmation");

    await expect(planning.confirm(user.id, ready.draft.id, ready.draft.revision))
      .rejects.toThrow("stale");
    expect(await trips.list(user.id)).toHaveLength(0);
  });

  it("preserves a second request, then archives the active trip on replacement consent", async () => {
    const { planning, trips, user } = await setup();
    const current = await trips.create(user.id, {
      title: "Existing London trip",
      brief: defaultTestBrief({
        originAirports: ["LOS"],
        destinationAirports: ["LHR"],
        tripType: "one_way",
        stayNights: null
      })
    });
    const blocked = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    expect(blocked.status).toBe("needs_input");
    if (blocked.status !== "needs_input") throw new Error("Expected the trip limit prompt");
    expect(blocked.prompt).toContain("Existing London trip");
    expect(blocked.prompt).toContain("Replace it");
    expect(blocked.prompt).toContain("/feedback");
    expect(blocked.draft.confirmationSnapshot).toMatchObject({
      input: { brief: { originAirports: ["LOS"], destinationAirports: ["NYC"] } }
    });

    const saved = await trips.list(user.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: current.trip.id,
      status: "draft",
      archiveReason: null
    });

    const both = await planning.handleOpenDraftText(user.id, "I want to keep both", null);
    expect(both).toMatchObject({
      status: "needs_input",
      prompt: expect.stringContaining("/feedback")
    });
    expect(await trips.get(user.id, current.trip.id)).toMatchObject({
      status: "draft",
      archiveReason: null
    });

    const ready = await planning.handleOpenDraftText(user.id, "Yes", null);
    expect(ready?.status).toBe("awaiting_confirmation");
    if (!ready || ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(ready.draft.id).toBe(blocked.draft.id);
    expect(await trips.get(user.id, current.trip.id)).toMatchObject({
      status: "archived",
      archiveReason: "replaced"
    });
    const added = await planning.confirm(user.id, ready.draft.id, ready.draft.revision);
    expect(added.status).toBe("started");
    if (added.status !== "started") throw new Error("Expected started trip");
    expect(await trips.list(user.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: current.trip.id, status: "archived", archiveReason: "replaced" }),
      expect.objectContaining({ id: added.receipt.tripId, status: "draft" })
    ]));
  });

  it("keeps the open draft across a fresh planning-service session", async () => {
    const { planning, store, trips, user } = await setup();
    const first = await planning.prepare(
      user.id,
      "Set up a round trip from home to New York starting Sunday August 17 2025 and back Sunday the following week."
    );
    if (first.status !== "needs_input") throw new Error("Expected clarification");
    const resumed = new TripPlanningService({
      store,
      trips,
      apiKey: null,
      now: () => now,
      dashboardUrlForTrip: (_userId, tripId) =>
        `https://captain.example/t#resumed-${tripId}`
    });
    const ready = await resumed.prepare(user.id, "Lagos just me", null, first.draft.id);
    expect(ready.status).toBe("started");
    if (ready.status !== "started") throw new Error("Expected the resumed draft to be saved");
    expect(ready.draft.id).toBe(first.draft.id);
    expect(ready.draft.confirmationSnapshot?.returnDate).toBe("2025-08-24");
    expect(ready.message).toContain("Open trip: https://captain.example/t#resumed-");
  });

  it("supports typed confirmation, cancellation, edits, and grounded Where replies", async () => {
    const { planning, trips, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to New York on August 17 2025 for one adult."
    );
    expect(ready.status).toBe("awaiting_confirmation");
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const started = await planning.handleOpenDraftText(user.id, "Yes", null);
    expect(started?.status).toBe("started");
    expect(await planning.activeTripLocation(user.id)).toBe(
      "LOS → NYC\n"
      + "Sunday, 17 Aug 2025 · Draft\n\n"
      + `Open trip: https://captain.example/t#test-${started?.status === "started" ? started.receipt.tripId : ""}`
    );

    // Only one trip tracks at a time, so stop that one before planning another.
    const tracking = (await trips.list(user.id))[0]!;
    await trips.action(user.id, tracking.id, {
      type: "cancel",
      expectedVersion: tracking.version
    });
    const next = await planning.prepare(
      user.id,
      "Create a one-way trip from Lagos to London on August 20 2025 for one adult."
    );
    if (next.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    const revised = await planning.handleOpenDraftText(
      user.id,
      "Change the departure to August 21 2025",
      null
    );
    expect(revised?.status).toBe("awaiting_confirmation");
    if (revised?.status !== "awaiting_confirmation") throw new Error("Expected revised confirmation");
    expect(revised.draft.confirmationSnapshot?.departureDate).toBe("2025-08-21");
    const cancelled = await planning.cancel(user.id, revised.draft.id, revised.draft.revision);
    expect(cancelled.status).toBe("cancelled");
  });

  it("does not treat Yes to a soft schedule as Create/Cancel consent", async () => {
    const { planning, store, user } = await setup();
    const ready = await planning.prepare(
      user.id,
      "Create a one-way trip from London to Paris on November 4 2026 for one adult."
    );
    expect(ready.status).toBe("awaiting_confirmation");
    if (ready.status !== "awaiting_confirmation") throw new Error("Expected confirmation");

    await store.appendMessage(
      user.id,
      "assistant",
      [
        "Here's the shape of it:",
        "",
        "1. Nov 4: London → Paris",
        "2. Nov 8: Paris → Marseille",
        "",
        "Does that schedule work, or do you want to shift any of those dates before I price it out?"
      ].join("\n"),
      now
    );

    const softYes = await planning.handleDraftDecision(user.id, "Yes", null);
    expect(softYes).toBeNull();
    expect(await store.getActiveTrip(user.id)).toBeNull();
    expect(await planning.findOpen(user.id)).toMatchObject({
      status: "awaiting_confirmation",
      id: ready.draft.id
    });

    expect(isExplicitPlanConsentPrompt(ready.confirmation)).toBe(true);
    expect(isExplicitPlanConsentPrompt(
      "Does that schedule work, or do you want to shift any of those dates?"
    )).toBe(false);

    await store.appendMessage(user.id, "assistant", ready.confirmation, now);
    const started = await planning.handleDraftDecision(user.id, "Yes", null);
    expect(started?.status).toBe("started");
  });

  it("points Telegram at the traveller's one active trip", async () => {
    const { planning, trips, user } = await setup();
    const anambra = await trips.create(user.id, {
      title: "Anambra",
      brief: defaultTestBrief({
        originAirports: ["LOS"],
        destinationAirports: ["ANA"],
        departureWindow: { start: "2025-08-01", end: "2025-08-01" },
        currency: "NGN"
      })
    });

    const message = await planning.activeTripsLocation(user.id);
    expect(message).toBe(
      "LOS → ANA\n"
      + "Friday, 1 Aug 2025 – Friday, 8 Aug 2025 · Draft\n\n"
      + `Open trip: https://captain.example/t#test-${anambra.trip.id}`
    );
    const rendered = telegramDashboardMessage(message!);
    expect(rendered.links).toEqual([
      {
        text: "Open trip",
        url: `https://captain.example/t#test-${anambra.trip.id}`
      }
    ]);
    expect(rendered.text).not.toContain("https://");
  });

  // Travellers who already had several trips when the one-trip limit landed
  // still get a button per trip.
  it("keeps a button per trip for a legacy multi-trip listing", () => {
    const rendered = telegramDashboardMessage(formatActiveTripList([
      legacyTripListEntry("ANA", "2025-08-01", "https://captain.example/t#test-anambra"),
      legacyTripListEntry("LHR", "2025-09-01", "https://captain.example/t#test-london")
    ]));
    expect(rendered.links).toEqual([
      { text: "Open LOS → ANA", url: "https://captain.example/t#test-anambra" },
      { text: "Open LOS → LHR", url: "https://captain.example/t#test-london" }
    ]);
    expect(rendered.text).toContain("You have 2 saved trips:");
    expect(rendered.text).not.toContain("https://");
  });

  // A weekday tweak to a composed leg means the weekday that gets the
  // traveller there in time, not the next one on the calendar.
  it("reads a bare weekday against the leg's arrive-by deadline", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, user } = await setup(clock);
    await planning.prepare(
      user.id,
      "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
      + "a birthday from Nov 10 - 14. Then 19 - 22, Uganda. Then a wedding, Dec 10. "
      + "I'll be in London and want to spend Christmas in Lagos."
    );

    const dateQuestion = await planning.handleOpenDraftText(user.id, "From London", null);
    if (dateQuestion?.status !== "needs_input") {
      throw new Error("Expected the first-flight question");
    }
    expect(dateQuestion.prompt).toContain("When can you fly London → Nairobi?");
    expect(dateQuestion.prompt).toContain("arrive by Wednesday, 4 Nov 2026");

    const answered = await planning.handleOpenDraftText(user.id, "The sunday before", null);
    if (answered?.status !== "started") {
      throw new Error("Expected the saved itinerary");
    }
    // The Sunday before Wednesday 4 Nov 2026 — not 9 Aug 2026, the next
    // Sunday after today.
    expect(answered.draft.state.legs[0]).toMatchObject({
      originAirports: ["LON"],
      destinationAirports: ["NBO"],
      departure: { kind: "exact", date: "2026-11-01" }
    });
    // The plan comes back with the date in it, so the traveller can see which
    // Sunday Captain took.
    expect(answered.message).toContain("Leg 1 · LON → NBO · Sunday, 1 Nov 2026");
  });

  // A date past the deadline is refused rather than stored, and the traveller
  // is told which deadline it missed.
  it("refuses a departure that lands after the arrival deadline", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, user } = await setup(clock);
    await planning.prepare(
      user.id,
      "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
      + "a birthday from Nov 10 - 14. Then 19 - 22, Uganda. Then a wedding, Dec 10. "
      + "I'll be in London and want to spend Christmas in Lagos."
    );
    const dateQuestion = await planning.handleOpenDraftText(user.id, "From London", null);
    if (dateQuestion?.status !== "needs_input") {
      throw new Error("Expected the first-flight question");
    }

    const answered = await planning.handleOpenDraftText(user.id, "5 November", null);
    if (answered?.status !== "needs_input") {
      throw new Error("Expected another date answer after the refusal");
    }
    expect(answered.prompt).toContain("after the 2026-11-04 arrival deadline");
    // The refused date is not stored: the leg keeps the window Captain chose.
    expect(answered.draft.state.legs[0]!.departure).toBeNull();
    expect(answered.draft.state.legs[0]!.proposedDeparture).toMatchObject({
      start: "2026-10-29",
      end: "2026-11-04"
    });
  });

  // The creation receipt exposes every best-fit window, so the traveller can
  // inspect the assumptions before opening the GUI.
  it("summarizes every date it chose in the saved draft", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, user } = await setup(clock);
    await planning.prepare(
      user.id,
      "Let's plan for Nairobi in November. I'm going to a wedding from Nov 4 - 8, "
      + "a birthday from Nov 10 - 14. Then 19 - 22, Uganda. Then a wedding, Dec 10. "
      + "I'll be in London and want to spend Christmas in Lagos."
    );
    const dateQuestion = await planning.handleOpenDraftText(user.id, "From London", null);
    if (dateQuestion?.status !== "needs_input") {
      throw new Error("Expected the first-flight question");
    }
    const saved = await planning.handleOpenDraftText(user.id, "Yes", null);
    if (saved?.status !== "started") {
      throw new Error("Expected the itinerary to be saved");
    }
    expect(saved.message).toContain(
      "Leg 1 · LON → NBO · Thursday, 29 Oct 2026 – Wednesday, 4 Nov 2026"
    );
    expect(saved.message).toContain(
      "Leg 2 · NBO → EBB · Sunday, 15 Nov 2026 – Thursday, 19 Nov 2026"
    );
    expect(saved.message).toContain(
      "Leg 4 · LON → LOS · Saturday, 19 Dec 2026 – Friday, 25 Dec 2026"
    );
    expect(saved.message).toContain("Open trip:");
  });

  // Five questions are a safety ceiling, not the signal that a plan is ready.
  it("stops clarifying at the safety ceiling when a route is still missing", async () => {
    const clock = new Date("2026-08-08T12:00:00Z");
    const { planning, user } = await setup(clock);
    const first = await planning.prepare(user.id, "Plan a trip");
    if (first.status !== "needs_input") throw new Error("Expected the first route question");
    let currentDraft = first.draft;
    for (const answer of ["I'm not sure", "Still not sure", "I don't know", "Not yet"]) {
      const current = await planning.prepare(user.id, answer, null, currentDraft.id);
      if (current.status !== "needs_input") throw new Error("Expected another route question");
      currentDraft = current.draft;
    }
    const stopped = await planning.prepare(user.id, "I still don't know", null, currentDraft.id);
    if (stopped.status !== "needs_input") throw new Error("Expected the route guidance");
    expect(stopped.draft.state.questionsAsked).toBe(5);
    expect(stopped.prompt).toContain("Send it as “Lagos to Nairobi”");
    expect(stopped.prompt).not.toContain("?");
  });

  // A traveller asking for “max one-stop” had the constraint silently dropped:
  // the pattern required whitespace, so the hyphen fell through to the 2-stop
  // default and every fare was searched against the wrong ceiling.
  it.each([
    ["max one-stop", "Lagos to London on 12 September, max one-stop flights"],
    ["max 1-stop", "Lagos to London on 12 September, max 1-stop flights"],
    ["maximum one stop", "Lagos to London on 12 September, maximum one stop"],
    ["non-stop", "Lagos to London on 12 September, non-stop only"],
    ["nonstop", "Lagos to London on 12 September, nonstop only"]
  ])("keeps a %s constraint out of the two-stop default", async (label, request) => {
    const { planning, user } = await setup();
    const result = await planning.prepare(user.id, request);
    if (result.status !== "awaiting_confirmation") {
      throw new Error(`Expected confirmation for ${label}, got ${result.status}`);
    }
    const { maxStops } = result.draft.confirmationSnapshot!.input.brief;
    expect(maxStops).toBe(label.includes("non") ? 0 : 1);
    expect(result.confirmation).not.toContain("At most 2 stops");
  });

  it("echoes a stated budget in the confirmation without a default marker", async () => {
    const { planning, user } = await setup();
    const result = await planning.prepare(
      user.id,
      "Lagos to London on 12 September under USD 900"
    );
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.confirmationSnapshot?.input.brief.maximumPrice).toBe(900);
    expect(result.confirmation).toContain("• Budget: max USD 900");
    expect(result.confirmation).not.toContain("• Budget: max USD 900 (default)");
  });

  // The transcript verbatim. A traveller with a confirmed PAR→NYC trip asked
  // “What's the best day to fly that week” and was asked where they were
  // flying from — twice — because the request matched /fly/ and /best/, opened
  // an empty draft, and the reducer had nothing to put in it.
  describe("questions about an existing trip", () => {
    async function withConfirmedTrip() {
      const context = await setup();
      const planned = await context.planning.prepare(
        context.user.id,
        "Lagos to London on 12 September"
      );
      if (planned.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
      const started = await context.planning.confirm(
        context.user.id,
        planned.draft.id,
        planned.draft.revision
      );
      expect(started.status).toBe("started");
      return context;
    }

    it.each([
      "What's the best day to fly that week",
      "Yeah what's the best day to fly that week",
      "which day is cheapest"
    ])("does not turn %j into a new trip", async (question) => {
      const { planning, user } = await withConfirmedTrip();

      const result = await planning.prepare(user.id, question);

      expect(result.status).toBe("no_trip_change");
      if (result.status !== "no_trip_change") throw new Error("Expected no_trip_change");
      expect(result.trip.brief.originAirports).toEqual(["LOS"]);
    });

    it("leaves no draft behind to ask the same question on the next turn", async () => {
      const { planning, user } = await withConfirmedTrip();
      await planning.prepare(user.id, "What's the best day to fly that week");
      // The loop needed two turns: the first opened the draft, the second was
      // owned by it. An abandoned draft here would reinstate exactly that.
      expect(await planning.findOpen(user.id)).toBeNull();
    });

    it("still plans a new trip when the traveller actually gives one", async () => {
      const { planning, user } = await withConfirmedTrip();
      const result = await planning.prepare(user.id, "Abuja to Accra on 3 October");
      expect(result.status).not.toBe("no_trip_change");
    });
  });

  // The transcript's failure: the model rewrote the plan in its own words and
  // the “(default)” markers vanished, so a traveller confirmed a two-stop
  // ceiling they never asked for and could not see Captain had assumed.
  describe("verbatim plan enforcement", () => {
    async function awaitingConfirmation() {
      const context = await setup();
      const result = await context.planning.prepare(
        context.user.id,
        "Lagos to London on 12 September"
      );
      if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
      return { ...context, canonical: result.confirmation };
    }

    it("replaces a bulleted paraphrase with the service's own wording", async () => {
      const { planning, user, canonical } = await awaitingConfirmation();
      const paraphrase = [
        "Here's your plan:",
        "• Dates: 12 September 2025",
        "• Economy, 1 adult",
        "• Up to 2 stops",
        "• Prices in USD"
      ].join("\n");

      const enforced = await planning.enforceVerbatimPlanText(user.id, paraphrase);
      expect(enforced).toBe(canonical);
      expect(enforced).toContain("(default)");
    });

    it("replaces a soft schedule proposal with Create/Cancel wording", async () => {
      const { planning, user, canonical } = await awaitingConfirmation();
      const schedule = [
        "Here's the shape of it, all one-stop-max flights:",
        "",
        "1. Nov 4: London → Paris (4 nights)",
        "2. Nov 8: Paris → Marseille (6 nights)",
        "",
        "Does that schedule work, or do you want to shift any of those dates before I price it out?"
      ].join("\n");
      expect(await planning.enforceVerbatimPlanText(user.id, schedule)).toBe(canonical);
    });

    it("leaves prose about the plan alone", async () => {
      const { planning, user } = await awaitingConfirmation();
      const prose = "That route only has one nonstop a day. Want me to widen the dates?";
      expect(await planning.enforceVerbatimPlanText(user.id, prose)).toBe(prose);
    });

    it("passes the canonical confirmation through untouched", async () => {
      const { planning, user, canonical } = await awaitingConfirmation();
      expect(await planning.enforceVerbatimPlanText(user.id, canonical)).toBe(canonical);
    });

    it("does not police messages when no plan is pending", async () => {
      const { planning, user } = await setup();
      const bulleted = "• one\n• two\n• three";
      expect(await planning.enforceVerbatimPlanText(user.id, bulleted)).toBe(bulleted);
    });
  });

  it("marks the city it picked when the traveller named a country", async () => {
    const { planning, user } = await setup();
    const result = await planning.prepare(user.id, "Lagos to Japan on 12 September");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.confirmationSnapshot?.input.brief.destinationAirports)
      .toEqual(["TYO"]);
    expect(result.draft.state.assumedAirports).toEqual(["TYO"]);
    expect(result.confirmation).toContain("• Tokyo for Japan");
  });

  it("does not mark a city the traveller named outright", async () => {
    const { planning, user } = await setup();
    const result = await planning.prepare(user.id, "Lagos to Tokyo on 12 September");
    if (result.status !== "awaiting_confirmation") throw new Error("Expected confirmation");
    expect(result.draft.state.assumedAirports).toEqual([]);
    expect(result.confirmation).not.toContain("for Japan");
  });

  it("echoes airline preferences, and omits the lines entirely when unset", () => {
    const withAirlines = formatTripPlanConfirmation(confirmableDraft({
      preferredAirlines: ["BA", "VS"],
      excludedAirlines: ["RA"]
    }));
    expect(withAirlines).toContain("• Airlines: prefer BA, VS");
    expect(withAirlines).toContain("• Avoiding: RA");

    // An absent preference is no preference, not an assumed one, so the line
    // is dropped rather than printed with a “(default)” marker.
    const without = formatTripPlanConfirmation(confirmableDraft());
    expect(without).not.toContain("• Airlines:");
    expect(without).not.toContain("• Avoiding:");
    expect(without).not.toContain("• Budget:");
  });
});
