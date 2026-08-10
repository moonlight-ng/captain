import { describe, expect, it } from "vitest";

import { sanitizeFacts } from "../services/agent/conversation-memory.js";

const messages = [
  { id: "m1", role: "user" as const, content: "I always fly out of Lagos, and I never book Ryanair." },
  { id: "m2", role: "assistant" as const, content: "Noted. You prefer business class on long haul." },
  { id: "m3", role: "user" as const, content: "Business class for anything over six hours please." }
];

describe("traveller fact evidence", () => {
  it("keeps a fact whose evidence the traveller actually said", () => {
    expect(sanitizeFacts([
      { kind: "home_airport", value: "Usually departs Lagos", evidence: "I always fly out of Lagos" }
    ], messages)).toEqual([{
      kind: "home_airport",
      value: "Usually departs Lagos",
      evidence: "I always fly out of Lagos",
      sourceMessageId: "m1"
    }]);
  });

  // The failure this guards against is the transcript's, made durable: an
  // assumption the traveller never made, applied silently to every future trip.
  it("drops a fact the traveller never said", () => {
    expect(sanitizeFacts([
      { kind: "cabin_preference", value: "Prefers first class", evidence: "I only fly first" }
    ], messages)).toEqual([]);
  });

  it("refuses to learn from Captain's own words", () => {
    // The evidence appears verbatim — in the assistant's message. Captain
    // restating a guess must not become the proof of that guess.
    expect(sanitizeFacts([
      { kind: "cabin_preference", value: "Prefers business", evidence: "You prefer business class on long haul" }
    ], messages)).toEqual([]);
  });

  it("attributes each fact to the message that carried its evidence", () => {
    const facts = sanitizeFacts([
      { kind: "airline_affinity", value: "Avoids Ryanair", evidence: "I never book Ryanair" },
      { kind: "cabin_preference", value: "Business over six hours", evidence: "Business class for anything over six hours" }
    ], messages);
    expect(facts.map((fact) => fact.sourceMessageId)).toEqual(["m1", "m3"]);
  });

  it("matches evidence regardless of the model's capitalisation", () => {
    expect(sanitizeFacts([
      { kind: "home_airport", value: "Departs Lagos", evidence: "i ALWAYS fly out of lagos" }
    ], messages)).toHaveLength(1);
  });

  it("returns nothing when the model proposes nothing", () => {
    expect(sanitizeFacts([], messages)).toEqual([]);
  });
});
