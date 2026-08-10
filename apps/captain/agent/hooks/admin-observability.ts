import { defineHook, type HookContext } from "eve/hooks";

import { getCaptainServices } from "../../services/app/services.js";

const model = () => process.env.AI_MODEL?.trim() || "anthropic/claude-sonnet-5";

export default defineHook({
  events: {
    async "session.started"(event, ctx) {
      await recordSession(ctx, "active", event.meta?.at);
    },
    async "turn.started"(event, ctx) {
      await recordSession(ctx, "active", event.meta?.at, { turnStarted: true });
    },
    async "step.completed"(event, ctx) {
      const usage = event.data.usage;
      const generationId = event.data.providerMetadata?.gateway.generationId ?? null;
      if (!usage && !generationId) return;
      const services = await getCaptainServices();
      const costUsd = finite(usage?.costUsd);
      await services.adminStore.recordModelUsage({
        eventKey: `eve:${ctx.session.id}:${event.data.turnId}:${event.data.stepIndex}`,
        userId: captainUserId(ctx),
        sessionId: ctx.session.id,
        source: "eve",
        operation: operationFor(ctx.channel.kind),
        model: model(),
        provider: generationId ? "gateway" : null,
        inputTokens: nonNegative(usage?.inputTokens),
        outputTokens: nonNegative(usage?.outputTokens),
        cacheReadTokens: nonNegative(usage?.cacheReadTokens),
        cacheWriteTokens: nonNegative(usage?.cacheWriteTokens),
        costUsd,
        gatewayGenerationId: generationId,
        lookupStatus: costUsd !== null
          ? "complete"
          : generationId ? "pending" : "unavailable",
        occurredAt: eventDate(event.meta?.at)
      });
    },
    async "session.waiting"(event, ctx) {
      await recordSession(ctx, "waiting", event.meta?.at);
    },
    async "turn.failed"(event, ctx) {
      await recordSession(ctx, "failed", event.meta?.at, {
        failureCode: event.data.code
      });
    },
    async "session.failed"(event, ctx) {
      await recordSession(ctx, "failed", event.meta?.at, {
        ended: true,
        failureCode: event.data.code
      });
    },
    async "session.completed"(event, ctx) {
      await recordSession(ctx, "completed", event.meta?.at, { ended: true });
    }
  }
});

async function recordSession(
  ctx: HookContext,
  status: "active" | "waiting" | "completed" | "failed",
  at: string | undefined,
  update: { turnStarted?: boolean; ended?: boolean; failureCode?: string | null } = {}
): Promise<void> {
  const services = await getCaptainServices();
  await services.adminStore.recordAgentSession({
    sessionId: ctx.session.id,
    userId: captainUserId(ctx),
    agentName: ctx.agent.name,
    channel: ctx.channel.kind ?? "unknown",
    model: model(),
    status,
    occurredAt: eventDate(at),
    ...update
  });
}

function captainUserId(ctx: HookContext): string | null {
  const current = ctx.session.auth.current?.attributes.captain_user_id;
  const initiator = ctx.session.auth.initiator?.attributes.captain_user_id;
  return stringValue(current) ?? stringValue(initiator);
}

function operationFor(channel: string | undefined): string {
  if (channel === "channel:telegram") return "owner_chat";
  if (channel === "subagent") return "subagent";
  return "agent_turn";
}

function eventDate(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date();
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function stringValue(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function finite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}
