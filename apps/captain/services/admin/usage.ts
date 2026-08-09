import { randomUUID } from "node:crypto";

import type { CaptainAdminStore } from "@agents/flight-store";

import { createCaptainGateway } from "../ai/gateway.js";

export type GatewayGenerationUsageInput = {
  userId: string | null;
  sessionId?: string | null;
  operation: string;
  model: string;
  providerMetadata?: Record<string, Record<string, unknown>> | undefined;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: {
      cacheReadTokens?: number | undefined;
      cacheWriteTokens?: number | undefined;
    } | undefined;
  } | undefined;
  occurredAt?: Date;
};

export type GatewayGenerationLookup = Pick<
  ReturnType<typeof createCaptainGateway>,
  "getGenerationInfo"
>;

export class CaptainUsageRecorder {
  readonly #store: CaptainAdminStore;
  readonly #gateway: GatewayGenerationLookup | null;

  constructor(options: {
    store: CaptainAdminStore;
    apiKey: string | null;
    gateway?: GatewayGenerationLookup | null;
  }) {
    this.#store = options.store;
    this.#gateway = options.gateway === null
      ? null
      : options.gateway ?? (options.apiKey ? createCaptainGateway(options.apiKey) : null);
  }

  async recordGatewayGeneration(input: GatewayGenerationUsageInput): Promise<void> {
    const generationId = stringValue(input.providerMetadata?.gateway?.generationId);
    const eventKey = generationId ? `gateway:${generationId}` : `gateway:missing:${randomUUID()}`;
    try {
      await this.#store.recordModelUsage({
        eventKey,
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        source: "gateway",
        operation: input.operation,
        model: input.model,
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        cacheReadTokens: input.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteTokens: input.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        gatewayGenerationId: generationId,
        lookupStatus: generationId && this.#gateway ? "pending" : "unavailable",
        occurredAt: input.occurredAt ?? new Date()
      });
      if (generationId && this.#gateway) {
        void this.#resolve(eventKey, generationId, 0);
      }
    } catch (error) {
      logUsageFailure("captain.usage_record_failed", error);
    }
  }

  async reconcilePending(limit = 25): Promise<void> {
    if (!this.#gateway) return;
    const pending = await this.#store.listPendingModelUsage(limit);
    await Promise.all(pending.map((item) =>
      this.#resolve(item.eventKey, item.gatewayGenerationId, item.lookupAttempts)
    ));
  }

  async #resolve(eventKey: string, generationId: string, attempts: number): Promise<void> {
    if (!this.#gateway) return;
    const now = new Date();
    try {
      const generation = await this.#gateway.getGenerationInfo({ id: generationId });
      await this.#store.resolveModelUsage(eventKey, {
        costUsd: generation.totalCost,
        model: generation.model,
        provider: generation.providerName,
        inputTokens: generation.promptTokens,
        outputTokens: generation.completionTokens,
        cacheReadTokens: generation.cachedTokens,
        cacheWriteTokens: generation.cacheCreationTokens,
        webSearchCalls: generation.billableWebSearchCalls
      }, now);
    } catch (error) {
      try {
        await this.#store.failModelUsageLookup(eventKey, attempts + 1 >= 6, now);
      } catch (storeError) {
        logUsageFailure("captain.usage_lookup_state_failed", storeError);
      }
      logUsageFailure("captain.usage_lookup_failed", error);
    }
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function logUsageFailure(event: string, error: unknown): void {
  console.warn(JSON.stringify({
    event,
    error: error instanceof Error ? error.name : "UnknownError"
  }));
}
