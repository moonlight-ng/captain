import { MemoryCaptainAdminStore } from "@agents/flight-store";
import { describe, expect, it, vi } from "vitest";

import {
  CaptainUsageRecorder,
  type GatewayGenerationLookup
} from "../services/admin/usage.js";

describe("Captain exact-cost reconciliation", () => {
  it("records the generation first and replaces local usage with exact Gateway data", async () => {
    const store = new MemoryCaptainAdminStore();
    const getGenerationInfo = vi.fn(async () => ({
      totalCost: 0.004321,
      model: "openai/gpt-5.6-terra",
      providerName: "openai",
      promptTokens: 300,
      completionTokens: 44,
      cachedTokens: 220,
      cacheCreationTokens: 0,
      billableWebSearchCalls: 0
    }));
    const recorder = createRecorder(store, getGenerationInfo);
    await recorder.recordGatewayGeneration({
      userId: "user-1",
      operation: "trip_patch_interpretation",
      model: "openai/gpt-5.6-terra",
      providerMetadata: { gateway: { generationId: "generation-1" } },
      usage: { inputTokens: 10, outputTokens: 2 }
    });

    await vi.waitFor(async () => {
      expect((await store.getCosts("all", new Date(Date.now() + 1_000))).summary).toMatchObject({
        costUsd: 0.004321,
        inputTokens: 300,
        outputTokens: 44,
        cacheReadTokens: 220,
        unresolvedCostCount: 0
      });
    });
    expect(getGenerationInfo).toHaveBeenCalledWith({ id: "generation-1" });
  });

  it("keeps missing generation IDs visible as unavailable without estimating", async () => {
    const store = new MemoryCaptainAdminStore();
    const recorder = new CaptainUsageRecorder({ store, apiKey: null });
    await recorder.recordGatewayGeneration({
      userId: null,
      operation: "voice_transcription",
      model: "openai/gpt-4o-mini-transcribe"
    });

    const report = await store.getCosts("all", new Date(Date.now() + 1_000));
    expect(report.summary).toMatchObject({ costUsd: 0, calls: 1, unresolvedCostCount: 1 });
    expect(await store.listPendingModelUsage()).toEqual([]);
  });

  it("bounds failed Gateway lookups at six attempts", async () => {
    const store = new MemoryCaptainAdminStore();
    const getGenerationInfo = vi.fn(async () => { throw new Error("not ready"); });
    const recorder = createRecorder(store, getGenerationInfo);
    await recorder.recordGatewayGeneration({
      userId: null,
      operation: "owner_chat",
      model: "openai/gpt-5.6-terra",
      providerMetadata: { gateway: { generationId: "generation-failing" } }
    });
    await vi.waitFor(() => expect(getGenerationInfo).toHaveBeenCalledTimes(1));

    for (let attempt = 1; attempt < 6; attempt += 1) {
      await recorder.reconcilePending();
    }

    expect(getGenerationInfo).toHaveBeenCalledTimes(6);
    expect(await store.listPendingModelUsage()).toEqual([]);
    expect((await store.getCosts("all", new Date(Date.now() + 1_000))).summary.unresolvedCostCount).toBe(1);
  });
});

function createRecorder(
  store: MemoryCaptainAdminStore,
  getGenerationInfo: ReturnType<typeof vi.fn>
): CaptainUsageRecorder {
  return new CaptainUsageRecorder({
    store,
    apiKey: null,
    gateway: { getGenerationInfo } as unknown as GatewayGenerationLookup
  });
}
