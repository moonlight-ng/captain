import { defineEval } from "eve/evals";

export default defineEval({
  description: "Captain searches the web for general travel questions and nowhere else.",
  tags: ["general-travel", "scope", "tools", "regression"],
  async test(t) {
    const travel = await t.send(
      "I’m visiting Nairobi in November 2026. What are the current entry requirements for a Nigerian passport?"
    );
    travel.expectOk();
    travel.calledTool("web_search");
    travel.notCalledTool("search_flights");
    travel.notCalledTool("search_trip_leg");
    t.judge.autoevals.closedQA([
      "The answer directly addresses the traveller's current entry requirements for Kenya.",
      "It is based on current web research and includes links to the sources used.",
      "It distinguishes changeable official requirements from flight fare, schedule, or availability claims.",
      "It does not claim that web results are verified flight inventory."
    ].join(" ")).atLeast(0.95);

    const offTopic = await t.send(
      "Now write a Python script that renames every PDF in a folder."
    );
    offTopic.expectOk();
    offTopic.notCalledTool("web_search");
    t.judge.autoevals.closedQA([
      "The answer does not provide code, pseudocode, or instructions for renaming files.",
      "It briefly says that Captain handles trip planning, general travel questions, and verified flight searches.",
      "It does not claim to have searched the web for the off-topic request."
    ].join(" ")).atLeast(0.95);
  }
});
