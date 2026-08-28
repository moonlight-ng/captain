import { describe, expect, it, vi } from "vitest";

import type { OfferSnapshot } from "@agents/flight-domain";
import type { RecommendationSnapshot } from "@agents/flight-store";

import {
  acknowledgeVoiceClarification,
  CAPTAIN_CLEAR_COMMAND,
  CAPTAIN_CLEAR_CONFIRMATION,
  CAPTAIN_FEEDBACK_COMMAND,
  CAPTAIN_FEEDBACK_PROMPT,
  CAPTAIN_HOLDING_STATUS,
  CAPTAIN_NEW_USER_GREETINGS,
  CAPTAIN_OPENING_STATUS_VARIANTS,
  CAPTAIN_PLANNING_STATUS,
  CAPTAIN_PROVIDER_HOLDING_STATUS,
  captainNewUserGreeting,
  captainPlanningStages,
  captainSessionUserId,
  CAPTAIN_PROFILE_COMMAND,
  CAPTAIN_RETURNING_TRAVELLER_WELCOME,
  CAPTAIN_TRIP_COMMAND,
  CAPTAIN_TRIPS_COMMAND,
  CAPTAIN_VOICE_TURN_CONTEXT,
  promoteVoiceTranscriptToTelegramTurn,
  renderTelegramAssistantMessage,
  repliedToTelegramMessageId,
  replyIfCaptainArchived,
  returningTravellerWelcome,
  telegramCommandName,
  tripPlanReviewReplyMarkup
} from "../agent/channels/telegram.js";
import { CAPTAIN_ARCHIVED_TELEGRAM_MESSAGE } from "../services/app/archive.js";
import {
  explainNotification,
  explainRecommendation
} from "../services/trips/explain.js";
import {
  CAPTAIN_ONBOARDING_CAPABILITIES,
  CAPTAIN_ONBOARDING_COMMANDS,
  CAPTAIN_ONBOARDING_WORKSPACE
} from "../services/onboarding/followups.js";

describe("Telegram profile onboarding", () => {
  it("answers every archived Telegram message without entering an active flow", async () => {
    const post = vi.fn(async () => undefined);
    await expect(replyIfCaptainArchived({ post }, {
      CAPTAIN_ARCHIVED_MODE: "true"
    })).resolves.toBe(true);
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(CAPTAIN_ARCHIVED_TELEGRAM_MESSAGE);
  });

  it("keeps the original Captain identity during automatic session-budget continuation", () => {
    const initiator = {
      attributes: { captain_user_id: "captain-user-1" }
    };
    expect(captainSessionUserId({ current: null, initiator })).toBe("captain-user-1");
    expect(captainSessionUserId({
      current: { attributes: { captain_user_id: "captain-user-2" } },
      initiator
    })).toBe("captain-user-2");
  });

  it("starts every new traveller with a conversational introduction", () => {
    expect([...CAPTAIN_NEW_USER_GREETINGS]).toEqual([
      "Hi, I’m Captain. Where do you want to go?",
      "Hi, I’m Captain. What’s the plan?",
      "Hi, I’m Captain. What’s on your mind?"
    ]);
    expect(CAPTAIN_ONBOARDING_CAPABILITIES).toBe(
      "I can help you figure out where to go, plan a multi-city trip, compare flight options across different dates, or watch for fare changes once your trip is set."
    );
    expect(CAPTAIN_ONBOARDING_WORKSPACE).toBe(
      "You can send requests via voice note or text and I’ll take it from there. Once we start a trip, you’ll also get a shared workspace to follow it."
    );
    expect(CAPTAIN_ONBOARDING_COMMANDS).toBe(
      "If you need any help, use the menu beside the message box to browse available commands."
    );
  });

  it("keeps the greeting warm and moves product orientation into follow-ups", () => {
    for (const greeting of CAPTAIN_NEW_USER_GREETINGS) {
      expect(greeting).not.toContain("early testing");
      expect(greeting).not.toContain("one trip at a time");
      expect(greeting).not.toContain("USD fares");
      expect(greeting).not.toContain("book or pay");
      // Every variant has to end in an open question, or a traveller who drew
      // it is left introduced to Captain with nothing asked of them.
      expect(greeting).toMatch(/\?$/u);
    }
    expect(CAPTAIN_ONBOARDING_CAPABILITIES).toContain("multi-city trip");
    expect(CAPTAIN_ONBOARDING_CAPABILITIES).toContain("once your trip is set");
    expect(CAPTAIN_ONBOARDING_WORKSPACE).toContain("voice note or text");
    expect(CAPTAIN_ONBOARDING_WORKSPACE).toContain("shared workspace");
    expect(CAPTAIN_ONBOARDING_COMMANDS).not.toContain("bottom left");
  });

  it("introduces Captain once and welcomes returning travellers differently", () => {
    for (const greeting of CAPTAIN_NEW_USER_GREETINGS) {
      expect(greeting).toMatch(/I['’]m Captain/u);
    }
    expect(CAPTAIN_ONBOARDING_CAPABILITIES).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_RETURNING_TRAVELLER_WELCOME).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_RETURNING_TRAVELLER_WELCOME).toBe(
      "Welcome back. Where to next?"
    );
  });

  it("greets a given traveller the same way every time and varies across them", () => {
    // The greeting is posted once and kept in the traveller's own conversation
    // history, so the variant has to be a function of who they are rather than
    // of when the line happened to be rendered.
    expect(captainNewUserGreeting("user-1")).toBe(captainNewUserGreeting("user-1"));
    expect(CAPTAIN_NEW_USER_GREETINGS).toContain(captainNewUserGreeting("user-1"));
    const drawn = new Set(
      Array.from({ length: 60 }, (_, index) => captainNewUserGreeting(`user-${index}`))
    );
    expect(drawn.size).toBe(CAPTAIN_NEW_USER_GREETINGS.length);
  });

  it("welcomes a returning traveller back to an existing trip", () => {
    const trip = "LOS → LHR\nSunday, 6 Sep 2026 · Draft\n\nOpen trip: https://captain.example/trip";
    const welcome = returningTravellerWelcome(trip);
    expect(welcome).toBe(`Welcome back. Here’s your saved trip.\n\n${trip}`);
    expect(welcome).not.toContain("Where to next?");
    expect(returningTravellerWelcome(null)).toBe(CAPTAIN_RETURNING_TRAVELLER_WELCOME);
  });

  it("accepts the singular and plural trip commands", () => {
    expect(CAPTAIN_TRIP_COMMAND).toBe("/trip");
    expect(CAPTAIN_TRIPS_COMMAND).toBe("/trips");
    expect(CAPTAIN_FEEDBACK_COMMAND).toBe("/feedback");
    expect(telegramCommandName("/trip")).toBe("trip");
    expect(telegramCommandName(" /trips ")).toBe("trips");
    expect(telegramCommandName("/trips@CaptainBot")).toBe("trips");
  });

  it("offers a concise feedback form prompt", () => {
    expect(CAPTAIN_FEEDBACK_PROMPT).toBe(
      "Tell us what worked, what didn’t, or what you’d like Captain to do better."
    );
    expect(telegramCommandName("/feedback")).toBe("feedback");
  });

  it("only parses complete Telegram commands", () => {
    expect(telegramCommandName("/trips please")).toBeNull();
    expect(telegramCommandName("show /trips")).toBeNull();
    expect(telegramCommandName("September 6")).toBeNull();
  });

  it("lifts Open trip links into buttons even without a draft review trip", () => {
    const message = [
      "Itinerary ready to confirm.",
      "",
      "LON → PAR → TYO → NYC",
      "Leg 1 · LON → PAR · Sunday, 1 Nov 2026",
      "",
      "Open trip: https://captain.example/trip/2d50a766-f60d-464e-8643-974ff50be8fe#access=v1.token"
    ].join("\n");
    expect(renderTelegramAssistantMessage(message, null)).toEqual({
      text: [
        "Itinerary ready to confirm.",
        "",
        "LON → PAR → TYO → NYC",
        "Leg 1 · LON → PAR · Sunday, 1 Nov 2026",
        ""
      ].join("\n").trimEnd(),
      replyMarkup: {
        inline_keyboard: [[{
          text: "Open trip",
          url: "https://captain.example/trip/2d50a766-f60d-464e-8643-974ff50be8fe#access=v1.token"
        }]]
      }
    });
  });

  it("lifts fare-digest Browse trip links into the requested Telegram button", () => {
    const url = "https://captain.example/trip/2d50a766-f60d-464e-8643-974ff50be8fe#access=v1.token";
    expect(renderTelegramAssistantMessage(
      `Prices today are looking lower.\n\nBrowse trip: ${url}`,
      null
    )).toEqual({
      text: "Prices today are looking lower.",
      replyMarkup: {
        inline_keyboard: [[{ text: "Browse trip", url }]]
      }
    });
  });

  it("uses Confirm and Review for a draft creation receipt", () => {
    const tripId = "2d50a766-f60d-464e-8643-974ff50be8fe";
    const dashboardUrl = `https://captain.example/trip/${tripId}#access=v1.token`;
    const message = `Itinerary ready to confirm.\n\nLON → PAR\n\nOpen trip: ${dashboardUrl}`;
    expect(renderTelegramAssistantMessage(message, {
      id: tripId,
      version: 1,
      status: "draft"
    })).toEqual({
      text: "Itinerary ready to confirm.\n\nLON → PAR",
      replyMarkup: tripPlanReviewReplyMarkup({
        tripId,
        version: 1,
        status: "draft",
        dashboardUrl
      })
    });
  });

  it("uses profile as the single user-facing account command", () => {
    expect(CAPTAIN_PROFILE_COMMAND).toBe("/profile");
  });

  it("says that clear resets the full first-person experience", () => {
    expect(CAPTAIN_CLEAR_COMMAND).toBe("/clear");
    expect(CAPTAIN_CLEAR_CONFIRMATION).toBe(
      "Cleared — trips, preferences, and conversation history. Tap Start to begin again."
    );
    expect(CAPTAIN_CLEAR_CONFIRMATION).toMatch(/trips/iu);
    expect(CAPTAIN_CLEAR_CONFIRMATION).toMatch(/preferences/iu);
    expect(CAPTAIN_CLEAR_CONFIRMATION).toMatch(/conversation history/iu);
    expect(CAPTAIN_CLEAR_CONFIRMATION).toMatch(/start/iu);
  });
});

describe("Captain progress copy", () => {
  it("varies its acknowledgement without promising a result", () => {
    expect(CAPTAIN_OPENING_STATUS_VARIANTS.length).toBeGreaterThan(1);
    for (const variant of CAPTAIN_OPENING_STATUS_VARIANTS) {
      const opening = `${variant.lead} — ${variant.genericAction}…`;
      expect(opening).not.toMatch(/got it/iu);
      // The opening is said before Captain has looked at anything, so it must
      // not name a fare or an outcome it cannot yet stand behind.
      expect(opening).not.toMatch(/found|fare|price|trip|cheap/iu);
    }
  });

  it("keeps holding lines honest about waiting", () => {
    expect(CAPTAIN_HOLDING_STATUS.length).toBeGreaterThan(0);
    for (const line of CAPTAIN_HOLDING_STATUS) {
      expect(line).toMatch(/…$/u);
      expect(line).not.toMatch(/!/u);
      // A holding line says Captain is still working, never what it found.
      expect(line).not.toMatch(/found|no results|error/iu);
    }
    expect(new Set(CAPTAIN_HOLDING_STATUS).size).toBe(CAPTAIN_HOLDING_STATUS.length);
  });

  it("names the planner's own step before falling back to waiting", () => {
    // The deterministic planner reports no tool events, so its first stage has
    // to name the work itself rather than open on a holding line.
    expect(CAPTAIN_PLANNING_STATUS[0]).toBe("Reading the route and dates…");
    expect(CAPTAIN_PLANNING_STATUS.slice(1)).toEqual([...CAPTAIN_HOLDING_STATUS]);
    expect(new Set(CAPTAIN_PLANNING_STATUS).size).toBe(CAPTAIN_PLANNING_STATUS.length);
  });

  it("blames a provider only where one is actually being waited on", () => {
    // A holding line advances on a timer that knows nothing about what is
    // running. The default set therefore cannot claim anyone else is slow —
    // it used to, and said so while Captain was reading a date.
    for (const line of CAPTAIN_HOLDING_STATUS) {
      expect(line).not.toMatch(/provider|airline|slow/iu);
    }
    expect(CAPTAIN_PROVIDER_HOLDING_STATUS.some((line) => /airlines/iu.test(line))).toBe(true);
  });

  it("wires an opening acknowledgement into every turn's stages", () => {
    // This is the assertion that was missing when the opening was dropped in
    // 16020b8: the copy stayed tested and stopped being used.
    const stages = captainPlanningStages("Lagos to London in September", "message-1");
    expect(stages.opening).toContain("Lagos to London");
    expect(stages.lines).toEqual([...CAPTAIN_HOLDING_STATUS]);
    expect(captainPlanningStages("find me something cheap", "message-2").opening)
      .toMatch(/…$/u);
  });
});

describe("Telegram voice notes", () => {
  it("promotes a transcript into the user turn for the agent to answer", () => {
    const message = {
      attachments: [],
      caption: "",
      chat: { id: "1", type: "private" as const },
      from: { id: "1", isBot: false },
      messageId: "42",
      raw: {},
      text: ""
    };

    promoteVoiceTranscriptToTelegramTurn(message, "Why did the fare go up?");

    expect(message.text).toBe("Why did the fare go up?");
    expect(CAPTAIN_VOICE_TURN_CONTEXT).toContain("actual current request");
    expect(CAPTAIN_VOICE_TURN_CONTEXT).toContain("name the concrete route or dates");
    expect(CAPTAIN_VOICE_TURN_CONTEXT).not.toContain("Briefly acknowledge");
    expect(CAPTAIN_VOICE_TURN_CONTEXT).not.toContain("Where would you like to fly to");
  });

  it("acknowledges a spoken trip request before asking for a missing detail", () => {
    expect(acknowledgeVoiceClarification("Where would you like to fly to?")).toBe(
      "I understood your voice note as a trip request. Where would you like to fly to?"
    );
  });
});

describe("quoted recommendation explanations", () => {
  it("resolves the quoted Telegram message and explains its immutable comparison", () => {
    expect(repliedToTelegramMessageId({
      reply_to_message: { message_id: 42 }
    })).toBe(42);

    const snapshot: RecommendationSnapshot = {
      previous: offer("old", "1124.77", 172_800),
      current: offer("new", "949.00", 86_400),
      rankingMode: "cheapest",
      reasonCodes: ["lower_price"],
      createdAt: "2026-08-01T12:00:00.000Z"
    };
    const explanation = explainRecommendation(snapshot);

    expect(explanation).toContain("GBP 1124.77");
    expect(explanation).toContain("£175.77");
    expect(explanation).toContain("GBP 949.00");
    expect(explanation).toContain("https://ba.com/verified-fare");
  });

  it("explains the exact historical price-rise alert", () => {
    const current = offer("current", "125.00", 7_200);
    const explanation = explainNotification({
      id: "notification",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "price_rise",
      attempts: 0,
      telegramMessageId: 42,
      payload: {
        current,
        increase: 25,
        sevenDayLow: 100,
        percent: 25
      }
    });

    expect(explanation).toContain("up £25.00 (25%)");
    expect(explanation).toContain("seven-day low of £100.00");
    expect(explanation).toContain("https://ba.com/verified-fare");
  });
});

function offer(id: string, priceAmount: string, durationSeconds: number): OfferSnapshot {
  return {
    id,
    searchRunId: "run",
    searchSpecId: "spec",
    itineraryKey: id,
    provider: "flysoar_mcp",
    providerOfferId: id,
    providerSearchId: "search",
    price: Number(priceAmount),
    priceAmount,
    currency: "GBP",
    fareBasis: "one_adult_total",
    primaryAirlineCode: "BA",
    participatingAirlineCodes: ["BA"],
    evidence: [{
      url: "https://ba.com/verified-fare",
      title: "Verified fare",
      domain: "ba.com"
    }],
    discoveryResponseId: "discovery",
    verificationResponseId: "verification",
    promptVersion: "v1",
    model: "gpt-5.6-sol",
    verifiedAt: "2026-08-01T12:00:00.000Z",
    expiresAt: null,
    observedAt: "2026-08-01T12:00:00.000Z",
    snapshot: { durationSeconds, stops: 1 }
  };
}
