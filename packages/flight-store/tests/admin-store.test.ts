import { describe, expect, it } from "vitest";

import { MemoryCaptainAdminStore } from "../src/admin-store.js";

describe("Captain administrator usage storage", () => {
  it("upserts session lifecycle state without duplicating sessions", async () => {
    const store = new MemoryCaptainAdminStore();
    const started = new Date();
    await store.recordAgentSession(sessionInput(started, "active"));
    await store.recordAgentSession({
      ...sessionInput(new Date(started.getTime() + 1_000), "waiting"),
      turnStarted: true
    });

    const overview = await store.getOverview(new Date(started.getTime() + 2_000));
    expect(overview.activeTurns).toBe(0);
    expect(overview.lastActivityAt).toBe(new Date(started.getTime() + 1_000).toISOString());
  });

  it("deduplicates replayed events and unique Gateway generation IDs", async () => {
    const store = new MemoryCaptainAdminStore();
    const occurredAt = new Date();
    await store.recordModelUsage(usageInput("event-1", "generation-1", occurredAt));
    await store.recordModelUsage(usageInput("event-1", "generation-1", occurredAt));
    await store.recordModelUsage(usageInput("event-2", "generation-1", occurredAt));

    expect(await store.listPendingModelUsage()).toEqual([{
      eventKey: "event-1",
      gatewayGenerationId: "generation-1",
      lookupAttempts: 0
    }]);
  });

  it("keeps unresolved costs visible and aggregates exact amounts by UTC day", async () => {
    const store = new MemoryCaptainAdminStore();
    const now = new Date();
    await store.recordModelUsage(usageInput("resolved", "generation-1", now));
    await store.resolveModelUsage("resolved", {
      costUsd: 0.012345,
      model: "openai/gpt-5.6-terra",
      provider: "openai",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      webSearchCalls: 0
    });
    await store.recordModelUsage(usageInput("pending", "generation-2", now));

    const report = await store.getCosts("all", new Date(now.getTime() + 1_000));
    expect(report.summary).toMatchObject({
      costUsd: 0.012345,
      calls: 2,
      unresolvedCostCount: 1,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80
    });
    expect(report.daily.at(-1)).toMatchObject({
      date: now.toISOString().slice(0, 10),
      costUsd: 0.012345,
      calls: 2
    });
  });

  it("marks reconciliation unavailable after a bounded terminal failure", async () => {
    const store = new MemoryCaptainAdminStore();
    const now = new Date();
    await store.recordModelUsage(usageInput("event-1", "generation-1", now));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await store.failModelUsageLookup("event-1", attempt === 5);
    }
    expect(await store.listPendingModelUsage()).toEqual([]);
    expect((await store.getCosts("all", new Date(now.getTime() + 1_000))).summary.unresolvedCostCount).toBe(1);
  });
});

function sessionInput(occurredAt: Date, status: "active" | "waiting") {
  return {
    sessionId: "session-1",
    userId: null,
    agentName: "Captain",
    channel: "channel:telegram",
    model: "openai/gpt-5.6-terra",
    status,
    occurredAt
  } as const;
}

function usageInput(eventKey: string, generationId: string, occurredAt: Date) {
  return {
    eventKey,
    userId: null,
    sessionId: null,
    source: "gateway",
    operation: "trip_patch_interpretation",
    model: "openai/gpt-5.6-terra",
    gatewayGenerationId: generationId,
    lookupStatus: "pending",
    occurredAt
  } as const;
}
