import {
  downloadTelegramFile,
  getTelegramFile,
  telegramChannel,
  type TelegramMessage
} from "eve/channels/telegram";
import { NoTranscriptGeneratedError, transcribe } from "ai";
import { telegramMessageUpdateKey } from "@agents/telegram-core";

import { getFlightAgentServices } from "../../services/app/services.js";

const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const credentials = {
  botToken: () => required("TELEGRAM_BOT_TOKEN"),
  webhookSecretToken: () => required("TELEGRAM_WEBHOOK_SECRET_TOKEN")
};

export default telegramChannel({
  route: "/eve/v1/telegram",
  credentials,
  uploadPolicy: { maxBytes: MAX_VOICE_BYTES, allowedMediaTypes: ["audio/*"] },
  async onMessage(ctx, message) {
    if (!privateHumanMessage(message)) return null;
    const telegramUserId = safeId(message.from!.id);
    const telegramChatId = safeId(message.chat.id);
    const messageId = safeId(message.messageId);
    if (telegramUserId === null || telegramChatId === null || messageId === null) return null;

    const services = await getFlightAgentServices();
    const allowlisted = services.env.autoAllowlist || services.env.allowlistTelegramUserIds.includes(telegramUserId);
    const user = await services.platformStore.ensureTelegramUser({
      telegramUserId,
      telegramChatId,
      username: message.from?.username ?? null,
      firstName: message.from?.firstName ?? null,
      lastName: message.from?.lastName ?? null
    }, allowlisted, new Date());
    const updateKey = telegramMessageUpdateKey("captain", telegramChatId, messageId);
    if (!await services.platformStore.claimTelegramUpdate(updateKey, user.id, new Date())) return null;
    if (user.status !== "active") {
      await ctx.telegram.post("Captain is in a small private beta right now. You’re on the waitlist; I’ll let you know when access opens.");
      return null;
    }

    let content = (message.text || message.caption || "").trim();
    const voice = voiceAttachment(message.raw);
    if (!content && voice) {
      try {
        content = await transcribeVoice(voice);
      } catch {
        await ctx.telegram.post("I couldn’t understand that voice note. Please try again or send the details as text.");
        return null;
      }
    }
    if (content === "/start") {
      const welcome = "I’m Captain. Tell me where and roughly when you want to fly, and I’ll create a Trip, track prices, compare the strongest options, and message you when something important changes.";
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      await services.platformStore.appendMessage(user.id, "assistant", welcome, new Date());
      await ctx.telegram.post(welcome);
      return null;
    }
    if (content === "/trips") {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      const trips = await services.trips.list(user.id);
      const response = trips.length === 0
        ? "You don’t have any Trips yet. Tell me where and when you want to go."
        : trips.map((trip) => `• ${trip.title} — ${trip.status} (${trip.brief.originAirports.join("/")} → ${trip.brief.destinationAirports.join("/")})`).join("\n");
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await ctx.telegram.post(response);
      return null;
    }
    if (!content) {
      await ctx.telegram.post("Send me a destination and the dates you’re considering, by text or voice note.");
      return null;
    }

    await services.platformStore.appendMessage(user.id, "user", content, new Date());
    await ctx.telegram.startTyping();
    return {
      auth: {
        attributes: {
          captain_principal: "traveller",
          captain_user_id: user.id,
          telegram_user_id: String(telegramUserId),
          chat_id: String(telegramChatId),
          message_id: String(messageId)
        },
        authenticator: "captain-telegram-webhook",
        issuer: "telegram",
        principalId: `captain-user:${user.id}`,
        principalType: "user",
        subject: String(telegramUserId)
      },
      ...(voice ? { context: [`The traveller sent a voice note. Its transcript is: ${content}`] } : {})
    };
  },
  events: {
    async "turn.started"(_data, channel) {
      await channel.telegram.startTyping();
    },
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const userId = authUserId(ctx.session.auth.current?.attributes.captain_user_id);
      if (userId) {
        const services = await getFlightAgentServices();
        await services.platformStore.appendMessage(userId, "assistant", data.message, new Date());
      }
      await channel.telegram.post(data.message);
    }
  }
});

function privateHumanMessage(message: TelegramMessage): boolean {
  return message.chat.type === "private" && Boolean(message.from && !message.from.isBot);
}

function safeId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function authUserId(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function voiceAttachment(raw: Record<string, unknown>): { fileId: string; size?: number } | null {
  const candidate = record(raw.voice) ?? record(raw.audio);
  if (!candidate || typeof candidate.file_id !== "string") return null;
  return {
    fileId: candidate.file_id,
    ...(typeof candidate.file_size === "number" ? { size: candidate.file_size } : {})
  };
}

async function transcribeVoice(input: { fileId: string; size?: number }): Promise<string> {
  if (input.size !== undefined && input.size > MAX_VOICE_BYTES) throw new Error("Voice note is too large");
  const file = await getTelegramFile({ credentials, fileId: input.fileId });
  const response = await downloadTelegramFile({ credentials, filePath: file.filePath });
  if (!response.ok) throw new Error("Telegram audio download failed");
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0 || audio.byteLength > MAX_VOICE_BYTES) throw new Error("Voice note has an invalid size");
  try {
    return (await transcribe({
      model: process.env.TRANSCRIPTION_MODEL?.trim() || "openai/gpt-4o-mini-transcribe",
      audio
    })).text.trim();
  } catch (error) {
    if (NoTranscriptGeneratedError.isInstance(error)) return "";
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
