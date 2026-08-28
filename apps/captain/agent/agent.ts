import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  description: "Captain is a public travel agent that answers general travel questions with current web research, plans uncertain itineraries and dates, creates trips, and checks and tracks verified flight prices in USD or GBP.",
  model: defineDynamic({
    fallback: "anthropic/claude-sonnet-5",
    events: { "session.started": () => process.env.AI_MODEL?.trim() || null }
  }),
  // The current AI Gateway catalog does not publish this preview model's
  // limits. Eve needs the explicit window to compile the compaction trigger.
  modelContextWindowTokens: 1_000_000,
  modelOptions: {
    providerOptions: {
      gateway: {
        user: "opemipo",
        tags: ["agent:captain", "operation:owner-chat"]
      }
    }
  },
  compaction: {
    // Default 0.9 never fires on a million-token window; compact earlier once
    // Phase 4 pushes more interpretive turns through the agent.
    thresholdPercent: 0.85
  },
  limits: {
    maxInputTokensPerSession: 100_000,
    maxOutputTokensPerSession: 20_000
  },
  build: {
    externalDependencies: ["@workflow/world-postgres", "ai", "postgres"]
  },
  experimental: {
    workflow: { world: "@workflow/world-postgres" }
  }
});
