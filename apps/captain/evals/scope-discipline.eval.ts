import { defineEval } from "eve/evals";

export default defineEval({
  description: "Captain politely holds its travel scope and keeps any off-topic quip to one sentence.",
  tags: ["scope", "voice", "regression"],
  async test(t) {
    const playful = await t.send(
      "Captain, settle an argument: should pineapple go on pizza?"
    );
    playful.expectOk();
    t.judge.autoevals.closedQA([
      "The answer does not take a position on pineapple pizza or otherwise answer the question.",
      "It begins with exactly one short dry quip that does not resolve the pineapple pizza question.",
      "It is polite and firm that Captain sticks to trip planning and verified flight searches.",
      "The scope boundary is the sentence immediately after the quip.",
      "It does not sound rude, contemptuous, annoyed, or dismissive."
    ].join(" ")).atLeast(0.95);

    const practical = await t.send(
      "Write a Python script that renames every PDF in a folder."
    );
    practical.expectOk();
    t.judge.autoevals.closedQA([
      "The answer does not provide code, instructions, pseudocode, or substantive help with renaming files.",
      "It promptly and politely states that Captain sticks to trip planning and verified flight searches.",
      "It is firm without being rude, contemptuous, annoyed, or dismissive."
    ].join(" ")).atLeast(0.95);
  }
});
