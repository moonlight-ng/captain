import { describe, expect, it } from "vitest";

import { reviewCaptainMessage } from "../src/message-review.js";

describe("Captain message review", () => {
  it("removes labeled internal goals and closes the blank-line gap", () => {
    expect(reviewCaptainMessage([
      "I found 43 fares.",
      "",
      "My goal: Get you LOS → LON on 6 Sept for the best balance.",
      "",
      "Open the trip to compare them."
    ].join("\n"))).toBe(
      "I found 43 fares.\n\nOpen the trip to compare them."
    );

    expect(reviewCaptainMessage("Goal: internal planning text\nUseful answer."))
      .toBe("Useful answer.");
  });

  it("preserves ordinary goal-oriented language", () => {
    const message = "I found a fare under your $500 target.";
    expect(reviewCaptainMessage(message)).toBe(message);
  });
});
