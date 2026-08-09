import { createWorld } from "@workflow/world-postgres";

type OwnerContextWorld = Pick<ReturnType<typeof createWorld>, "events" | "hooks">;

const OWNER_CONTEXT_CANCEL_REASON = "Captain traveller cleared owner context";

export function telegramOwnerContinuationToken(telegramChatId: number): string {
  return `telegram:${telegramChatId}::`;
}

export async function cancelTelegramOwnerContext(
  world: OwnerContextWorld,
  telegramChatId: number
): Promise<boolean> {
  let hook: Awaited<ReturnType<OwnerContextWorld["hooks"]["getByToken"]>>;
  try {
    hook = await world.hooks.getByToken(
      telegramOwnerContinuationToken(telegramChatId),
      { resolveData: "none" }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "HookNotFoundError") return false;
    throw error;
  }
  await world.events.create(hook.runId, {
    eventType: "run_cancelled",
    eventData: { cancelReason: OWNER_CONTEXT_CANCEL_REASON }
  });
  return true;
}

export async function clearTelegramOwnerContext(
  telegramChatId: number,
  databaseUrl: string | null
): Promise<void> {
  const workflowDatabaseUrl = process.env.WORKFLOW_POSTGRES_URL?.trim() || databaseUrl;
  const world = workflowDatabaseUrl
    ? createWorld({ connectionString: workflowDatabaseUrl })
    : createWorld();
  try {
    await cancelTelegramOwnerContext(world, telegramChatId);
  } finally {
    await world.close?.();
  }
}
