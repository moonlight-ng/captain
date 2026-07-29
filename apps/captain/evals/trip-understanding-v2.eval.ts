import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Natural return wording becomes one grounded itinerary without redundant clarification.",
  tags: ["trip-planning", "request-understanding", "regression"],
  async test(t) {
    const confirmation = await t.send(
      "Let's track a trip to New York on Aug 17. Return to London on the 23rd."
    );
    confirmation.expectOk();
    t.check(confirmation.message, includes("LON → NYC"));
    t.check(confirmation.message, includes("17 Aug 2026"));
    t.check(confirmation.message, includes("23 Aug 2026"));
    t.judge.autoevals.closedQA([
      "The proposed Trip is a London to New York outbound flight on 17 August 2026",
      "and a New York to London return on 23 August 2026.",
      "The assistant does not ask for a return date because the traveller already supplied it.",
      "The assistant clearly asks the traveller to confirm before creating the Trip.",
      "No Trip is claimed as saved before confirmation."
    ].join(" ")).atLeast(0.95);
  }
});
