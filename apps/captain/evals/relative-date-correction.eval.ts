import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "An ordinal weekday resolves to a calendar date and a correction replaces the prior month.",
  tags: ["daily", "trip-planning", "request-understanding", "regression"],
  async test(t) {
    const confirmation = await t.send(
      "Track Lagos to London on the first Sunday of September 2030."
    );
    confirmation.expectOk();
    t.check(confirmation.message, includes("LOS → LON"));
    t.check(confirmation.message, includes("Sunday, 1 Sept 2030"));
    t.check(confirmation.message, includes("One-way (default)"));

    const edited = await t.send(
      "Actually, use the first Sunday of October 2030, not September."
    );
    edited.expectOk();
    t.check(edited.message, includes("Sunday, 6 Oct 2030"));
    t.judge.autoevals.closedQA([
      "The final proposed Trip is a one-way Lagos LOS to London LON journey.",
      "It departs on the first Sunday of October 2030, Sunday 6 October 2030.",
      "The correction replaces September with October.",
      "The assistant clearly asks the traveller to confirm before creating the Trip.",
      "No Trip is claimed as saved before confirmation."
    ].join(" ")).atLeast(0.95);
  }
});
