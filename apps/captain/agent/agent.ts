import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  description: "Captain is a public travel agent that creates Trips, tracks verified flight prices in USD or GBP, discovers the strongest options, and explains important changes.",
  model: defineDynamic({
    fallback: "openai/gpt-5.6-terra",
    events: { "session.started": () => process.env.AI_MODEL?.trim() || null }
  }),
  modelOptions: {
    providerOptions: {
      gateway: {
        user: "opemipo",
        tags: ["agent:captain", "operation:owner-chat"]
      }
    }
  },
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
