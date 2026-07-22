import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  description: "A private flight exploration agent that searches Duffel, tracks fares, and exposes its workings.",
  model: defineDynamic({
    fallback: "openai/gpt-oss-20b",
    events: { "session.started": () => process.env.AI_MODEL?.trim() || null }
  }),
  limits: {
    maxInputTokensPerSession: 100_000,
    maxOutputTokensPerSession: 20_000,
    maxSubagents: 1
  },
  build: {
    externalDependencies: ["@workflow/world-postgres", "postgres"]
  },
  experimental: {
    workflow: { world: "@workflow/world-postgres" }
  }
});
