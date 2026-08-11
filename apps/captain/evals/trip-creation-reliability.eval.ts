import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Trip creation preserves normalized dates and returns one grounded receipt to confirm.",
  tags: ["trip-planning", "grounding"],
  async test(t) {
    const first = await t.send(
      "Set up a round trip from home to New York starting Sunday August 16 2026 and back Sunday the following week."
    );
    first.expectOk();
    t.check(first.message, includes(/Where are you flying from/iu));

    // The answered plan comes back saved, as the receipt the traveller confirms
    // or opens. Captain does not ask them to create it first.
    const confirmation = await t.send("Lagos just me");
    confirmation.expectOk();
    t.check(confirmation.message, includes("Itinerary ready to confirm."));
    t.check(confirmation.message, includes("LOS → NYC"));
    t.check(confirmation.message, includes("Sunday, 16 Aug 2026"));
    t.check(confirmation.message, includes("Sunday, 23 Aug 2026"));

    const started = await t.send("Yes");
    started.expectOk();
    t.check(started.message, includes(/Trip is saved|already saved/iu));
    t.check(started.message, includes("Send /trip"));

    const where = await t.send("Where?");
    t.succeeded();
    t.check(where.message, includes("LOS"));
    t.check(where.message, includes("NYC"));
    t.calledTool("prepare_trip", { count: 2 });
  }
});
