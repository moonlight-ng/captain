import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  judge: { model: "openai/gpt-oss-20b" },
  maxConcurrency: 1,
  timeoutMs: 120_000
});

