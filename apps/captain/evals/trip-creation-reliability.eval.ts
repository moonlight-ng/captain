import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Trip creation preserves normalized dates, requires confirmation, and returns a grounded receipt.",
  tags: ["trip-planning", "grounding"],
  async test(t) {
    const first = await t.send(
      "Set up a round trip from home to New York starting Sunday August 16 2026 and back Sunday the following week."
    );
    first.expectOk();
    t.check(first.message, includes(/Where are you flying from/iu));

    const confirmation = await t.send("Lagos just me");
    confirmation.expectOk();
    t.check(confirmation.message, includes("LOS → NYC"));
    t.check(confirmation.message, includes("Sunday, 16 Aug 2026"));
    t.check(confirmation.message, includes("Sunday, 23 Aug 2026"));
    t.check(confirmation.message, includes("7 nights"));
    t.check(confirmation.message, includes("At most 2 stops (default)"));

    const started = await t.send("Yes");
    started.expectOk();
    t.check(started.message, includes(/Trip is saved|already saved/iu));
    t.check(started.message, includes("Send /trips"));

    const where = await t.send("Where?");
    t.succeeded();
    t.check(where.message, includes("LOS"));
    t.check(where.message, includes("NYC"));
    t.calledTool("prepare_trip", { count: 2 });
    t.calledTool("start_prepared_trip", { count: 1 });
    t.judge.autoevals.closedQA([
      "The confirmation and receipt preserve a Sunday 16 August 2026 departure and Sunday 23 August 2026 return, which is seven nights.",
      "The route is Lagos LOS to the New York metropolitan area NYC for one traveller.",
      "One traveller comes from the traveller saying just me; Economy, at most two stops, the traveller profile currency, and adaptive tracking are clearly presented as defaults rather than user-supplied preferences.",
      "Creation is claimed only after confirmation and the saved Trip is available through /trips.",
      "The final Where reply identifies the saved Trip's Lagos LOS to New York NYC route instead of asking a generic clarification."
    ].join(" ")).atLeast(0.9);
  }
});
