import { describe, expect, it } from "vitest";

import type { OfferSnapshot } from "@agents/flight-domain";
import type { RecommendationSnapshot } from "@agents/flight-store";

import {
  acknowledgeVoiceClarification,
  CAPTAIN_CLEAR_COMMAND,
  CAPTAIN_CLEAR_CONFIRMATION,
  CAPTAIN_DEFAULTS_INTRO,
  CAPTAIN_FEEDBACK_COMMAND,
  CAPTAIN_FEEDBACK_PROMPT,
  CAPTAIN_NEW_USER_GREETING,
  CAPTAIN_PROFILE_COMMAND,
  CAPTAIN_READY_PROMPT,
  CAPTAIN_RETURNING_TRAVELLER_WELCOME,
  CAPTAIN_TRIP_COMMAND,
  CAPTAIN_TRIPS_COMMAND,
  CAPTAIN_VOICE_TURN_CONTEXT,
  explainNotification,
  explainRecommendation,
  promoteVoiceTranscriptToTelegramTurn,
  repliedToTelegramMessageId,
  returningTravellerWelcome,
  telegramCommandName
} from "../agent/channels/telegram.js";

describe("Telegram profile onboarding", () => {
  it("starts every new traveller with the fixed three-message introduction", () => {
    expect(CAPTAIN_NEW_USER_GREETING).toBe(
      "Hi, I’m Captain. I plan multi-city trips and compare real-time flight options across your possible dates.\n\n"
      + "I’m still in early testing, so I can only keep one trip at a time. I never book or pay for anything."
    );
    expect(CAPTAIN_DEFAULTS_INTRO).toBe(
      "You’re set up for USD fares and a balance of price and travel time. You can change these anytime."
    );
    expect(CAPTAIN_READY_PROMPT).toBe(
      "Send the cities and dates you’re considering by text or voice note. I’ll help turn them into flight legs and search the dates that work."
    );
  });

  it("sets expectations before asking for anything", () => {
    // The interview is gone: onboarding asks no questions, so the first
    // message has to carry the demo framing and the one-trip limit itself.
    expect(CAPTAIN_NEW_USER_GREETING).toContain("early testing");
    expect(CAPTAIN_NEW_USER_GREETING).toContain("one trip at a time");
    expect(CAPTAIN_DEFAULTS_INTRO).not.toContain("alert");
    expect(CAPTAIN_READY_PROMPT).toContain("voice note");
    expect(CAPTAIN_READY_PROMPT).toContain("flight legs");
    expect(CAPTAIN_NEW_USER_GREETING).toContain("real-time flight options");
  });

  it("introduces Captain once and welcomes returning travellers differently", () => {
    expect(CAPTAIN_NEW_USER_GREETING).toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_DEFAULTS_INTRO).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_READY_PROMPT).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_RETURNING_TRAVELLER_WELCOME).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_RETURNING_TRAVELLER_WELCOME).toBe(
      "Welcome back. Where to next?"
    );
  });

  it("welcomes a returning traveller back to an existing trip", () => {
    const trip = "Your trip is saved and ready to search.\n\n• LOS → LHR\n\nOpen trip: https://captain.example/trip";
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

  it("uses profile as the single user-facing account command", () => {
    expect(CAPTAIN_PROFILE_COMMAND).toBe("/profile");
  });

  it("says that clear removes trips as well as resetting preferences", () => {
    expect(CAPTAIN_CLEAR_COMMAND).toBe("/clear");
    expect(CAPTAIN_CLEAR_CONFIRMATION).toBe(
      "Your trips and preferences have been cleared. Looking forward to your next trip."
    );
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
    expect(CAPTAIN_VOICE_TURN_CONTEXT).toContain("acknowledge what you understood");
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
