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
    t.check(started.message, includes("Send /trip"));

    const where = await t.send("Where?");
    t.succeeded();
    t.check(where.message, includes("LOS"));
    t.check(where.message, includes("NYC"));
    t.calledTool("prepare_trip", { count: 2 });
    t.calledTool("start_prepared_trip", { count: 1 });
  }
});
