import { describe, expect, it, vi } from "vitest";

import {
  VersionConflictError,
  flightAgentBriefSchema
} from "../services/domain/types.js";
import { MemoryFlightAgentStore } from "../services/store/memory-store.js";
import { defaultTestBrief } from "./support.js";

describe("Captain flight domain", () => {
  it("validates critical brief fields and the 31-day window", () => {
    expect(flightAgentBriefSchema.safeParse(defaultTestBrief()).success).toBe(true);
    expect(flightAgentBriefSchema.safeParse(defaultTestBrief({
      departureWindow: { start: "2026-09-01", end: "2026-10-02" }
    })).success).toBe(false);
    expect(flightAgentBriefSchema.safeParse(defaultTestBrief({
      originAirports: [],
      destinationAirports: []
    })).success).toBe(false);
  });

  it("enforces optimistic versions and stores idempotency records", async () => {
    const store = new MemoryFlightAgentStore();
    const agent = await store.createAgent("fa_version", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
    }, new Date("2026-08-01T00:00:00Z"));
    const updated = await store.applyAction("fa_version", {
      type: "set_cadence", expectedVersion: agent.version, cadenceHours: 12
    }, new Date("2026-08-01T00:01:00Z"));
    expect(updated.version).toBe(agent.version + 1);
    await expect(store.applyAction("fa_version", {
      type: "pause", expectedVersion: agent.version
    }, new Date("2026-08-01T00:02:00Z"))).rejects.toBeInstanceOf(VersionConflictError);

    await store.putIdempotency("create", "key", {
      requestHash: "hash", responseStatus: 202, responseBody: { key: "fa_version" }
    });
    await expect(store.getIdempotency("create", "key")).resolves.toEqual({
      requestHash: "hash", responseStatus: 202, responseBody: { key: "fa_version" }
    });
  });

  it("deletes only the requested agent and its create idempotency record", async () => {
    const store = new MemoryFlightAgentStore();
    await store.createAgent("fa_delete", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "smoke"
    }, new Date("2026-08-01T00:00:00Z"));
    await store.createAgent("fa_keep", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "owner"
    }, new Date("2026-08-01T00:00:01Z"));
    await store.putIdempotency("internal:create", "smoke-create", {
      requestHash: "hash", responseStatus: 202, responseBody: { agent: { key: "fa_delete" } }
    });

    await expect(store.deleteAgent("fa_keep", "smoke-create")).resolves.toBe(false);
    await expect(store.deleteAgent("fa_delete", "smoke-create")).resolves.toBe(true);
    await expect(store.getWorkspace("fa_delete")).resolves.toBeNull();
    await expect(store.getWorkspace("fa_keep")).resolves.not.toBeNull();
    await expect(store.getIdempotency("internal:create", "smoke-create")).resolves.toBeNull();
    await expect(store.deleteAgent("fa_missing", "smoke-create")).resolves.toBe(false);
  });

  it("counts check processing while excluding idle and paused time", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryFlightAgentStore();
      const createdAt = new Date("2026-08-01T00:00:00Z");
      vi.setSystemTime(createdAt);
      await store.createAgent("fa_processing", {
        brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
      }, createdAt);

      vi.setSystemTime(new Date("2026-08-01T01:00:00Z"));
      expect((await store.listAgents()).agents[0]?.processingTimeMs).toBe(0);

      const firstStartedAt = new Date();
      const first = await store.claimCheck("fa_processing", "initial", "fare_and_research", true, firstStartedAt);
      expect(first?.agent.processingStartedAt).toBe(firstStartedAt.toISOString());

      vi.setSystemTime(new Date("2026-08-01T01:00:45Z"));
      expect((await store.listAgents()).agents[0]?.processingTimeMs).toBe(45_000);
      await store.completeCheck("fa_processing", first!.check.id, {
        matrix: [],
        snapshots: [],
        searchCursor: 0,
        searched: 0,
        offersFound: 0,
        research: {
          status: "completed",
          searchedAt: new Date().toISOString(),
          overview: null,
          results: [],
          offers: [],
          gaps: [],
          error: null,
          metadata: {
            model: "test",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            durationMs: 999_999
          }
        },
        nextCheckAt: "2026-08-01T07:00:45Z"
      }, new Date());

      let workspace = await store.getWorkspace("fa_processing");
      expect(workspace?.agent.accumulatedProcessingMs).toBe(45_000);
      expect(workspace?.agent.processingStartedAt).toBeNull();

      vi.setSystemTime(new Date("2026-08-01T02:00:45Z"));
      expect((await store.listAgents()).agents[0]?.processingTimeMs).toBe(45_000);

      const paused = await store.applyAction("fa_processing", {
        type: "pause", expectedVersion: workspace!.agent.version
      }, new Date());
      vi.setSystemTime(new Date("2026-08-01T03:00:45Z"));
      const resumed = await store.applyAction("fa_processing", {
        type: "resume", expectedVersion: paused.version
      }, new Date());
      expect(resumed.accumulatedProcessingMs).toBe(45_000);
      expect(resumed.processingStartedAt).toBeNull();

      const second = await store.claimCheck("fa_processing", "retry", "fare", true, new Date());
      vi.setSystemTime(new Date("2026-08-01T03:01:05Z"));
      await store.failCheck("fa_processing", second!.check.id, {
        error: "Provider failed",
        matrix: [],
        searchCursor: 0,
        nextCheckAt: "2026-08-01T03:06:05Z"
      }, new Date());

      workspace = await store.getWorkspace("fa_processing");
      expect(workspace?.agent.accumulatedProcessingMs).toBe(65_000);
      expect((await store.listAgents()).agents[0]?.processingTimeMs).toBe(65_000);

      const state = store.exportState("fa_processing")!;
      const restored = new MemoryFlightAgentStore();
      restored.importState(state);
      const restoredWorkspace = await restored.getWorkspace("fa_processing");
      expect(restoredWorkspace?.agent.accumulatedProcessingMs).toBe(65_000);
      expect(restoredWorkspace?.agent.processingStartedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
