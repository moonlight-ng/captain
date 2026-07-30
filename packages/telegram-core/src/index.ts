export * from "./session-limit.js";
export * from "./progress.js";

export type TelegramIdentity = {
  telegramUserId: number;
  chatId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

export function telegramUpdateKey(botId: string, updateId: number): string {
  if (!botId.trim()) throw new Error("Telegram bot ID is required");
  if (!Number.isSafeInteger(updateId)) throw new Error("Telegram update ID must be a safe integer");
  return `${botId.trim()}:${updateId}`;
}

export function telegramMessageUpdateKey(botId: string, chatId: number, messageId: number): string {
  if (!botId.trim()) throw new Error("Telegram bot ID is required");
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) {
    throw new Error("Telegram chat and message IDs must be safe integers");
  }
  return `${botId.trim()}:message:${chatId}:${messageId}`;
}

export function telegramDisplayName(identity: Pick<TelegramIdentity, "firstName" | "username" | "telegramUserId">): string {
  return identity.firstName?.trim() || (identity.username ? `@${identity.username}` : `traveller ${identity.telegramUserId}`);
}
