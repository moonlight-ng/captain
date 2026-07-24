import {
  downloadTelegramFile,
  getTelegramFile,
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  telegramChannel,
  type TelegramCallbackQuery,
  type TelegramContext,
  type TelegramMessage
} from "eve/channels/telegram";
import { NoTranscriptGeneratedError, transcribe } from "ai";
import {
  claimSessionLimitRequest,
  continueCallbackDataFromMarkup,
  isSessionLimitContinuationRequest,
  looksLikeSessionBudgetPrompt,
  partitionSessionLimitRequests,
  storePendingSessionRotation,
  takePendingSessionRotation,
  telegramMessageUpdateKey,
  type PendingSessionRotation,
  type SessionLimitInputRequest
} from "@agents/telegram-core";
import type { TripPlanResult } from "@agents/flight-domain";

import { getCaptainServices } from "../../services/app/services.js";
import { TripPlanningService } from "../../services/trip-planning/service.js";
import {
  formatTripList,
  telegramDashboardMessage
} from "../../services/trip-planning/format.js";

const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const credentials = {
  botToken: () => required("TELEGRAM_BOT_TOKEN"),
  webhookSecretToken: () => required("TELEGRAM_WEBHOOK_SECRET_TOKEN")
};
const pendingSessionRotations = new Map<string, PendingSessionRotation>();
const agentProgressMessages = new Map<string, { chatId: string; messageId: string }>();
const PLANNING_PROGRESS_TEXT = "Working through the route and dates…";
const AGENT_PROGRESS_TEXT = "Working on it…";
const PROCESSING_FAILURE_TEXT = "I hit a problem while processing that message. Your saved Trips are unchanged—please try again.";

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

    const services = await getCaptainServices();
    const user = await services.platformStore.ensureTelegramUser({
      telegramUserId,
      telegramChatId,
      username: message.from?.username ?? null,
      firstName: message.from?.firstName ?? null,
      lastName: message.from?.lastName ?? null
    }, new Date());
    const updateKey = telegramMessageUpdateKey("captain", telegramChatId, messageId);
    if (!await services.platformStore.claimTelegramUpdate(updateKey, user.id, new Date())) return null;
    if (user.status !== "active") {
      await ctx.telegram.post("Your Captain access is currently suspended. Please contact support if you think this is a mistake.");
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
        : formatTripList(
            trips,
            (tripId) => services.tripPlanning.dashboardUrlForTrip(user.id, tripId)
          );
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await postTelegramDashboardMessage(ctx, response);
      return null;
    }
    if (!content) {
      await ctx.telegram.post("Send me a destination and the dates you’re considering, by text or voice note.");
      return null;
    }

    const sourceMessageId = await services.platformStore.appendMessage(user.id, "user", content, new Date());
    await ctx.telegram.startTyping();

    if (isCaptainGreeting(content)) {
      const draft = await services.tripPlanning.findOpen(user.id);
      const response = draft
        ? "Hi! Your Trip draft is still here, and we can continue whenever you’re ready."
        : "Hi! Tell me where you’re flying from, where you want to go, and roughly when.";
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await ctx.telegram.post(response);
      return null;
    }

    try {
      const handled = await withPlanningProgress(ctx, async () => {
        const openDraftResult = await services.tripPlanning.handleOpenDraftText(
          user.id,
          content,
          sourceMessageId
        );
        if (openDraftResult) {
          await postTripPlanResult(ctx, user.id, openDraftResult);
          return true;
        }
        if (TripPlanningService.isWhereQuestion(content)) {
          const location = await services.tripPlanning.activeTripLocation(user.id);
          if (location) {
            await services.platformStore.appendMessage(user.id, "assistant", location, new Date());
            await postTelegramDashboardMessage(ctx, location);
            return true;
          }
        }
        if (TripPlanningService.isTripPlanningRequest(content)) {
          const planned = await services.tripPlanning.prepare(user.id, content, sourceMessageId);
          await postTripPlanResult(ctx, user.id, planned);
          return true;
        }
        return false;
      });
      if (handled) {
        return null;
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "captain.telegram_message_processing_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      await services.platformStore.appendMessage(
        user.id,
        "assistant",
        PROCESSING_FAILURE_TEXT,
        new Date()
      );
      await ctx.telegram.post(PROCESSING_FAILURE_TEXT);
      return null;
    }

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
  async onCallbackQuery(ctx, query) {
    if (!privateHumanCallback(query)) return;
    const action = parseTripPlanCallback(query.data);
    if (!action) return;
    const telegramUserId = safeId(query.from.id);
    const telegramChatId = safeId(query.message?.chat.id ?? "");
    if (telegramUserId === null || telegramChatId === null) return;
    const services = await getCaptainServices();
    const user = await services.platformStore.ensureTelegramUser({
      telegramUserId,
      telegramChatId,
      username: query.from.username ?? null,
      firstName: query.from.firstName ?? null,
      lastName: query.from.lastName ?? null
    }, new Date());
    if (user.status !== "active") {
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Captain access is suspended."
      });
      return;
    }
    try {
      if (action.type === "start") {
        await ctx.telegram.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Creating the Trip…"
        });
        await clearCallbackButtons(ctx, query);
        const result = await services.tripPlanning.confirm(
          user.id,
          action.draftId,
          action.revision
        );
        await postTripPlanResult(ctx, user.id, result);
        return;
      }
      if (action.type === "edit") {
        await services.tripPlanning.reopen(user.id, action.draftId, action.revision);
        await ctx.telegram.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Tell me what to change."
        });
        await clearCallbackButtons(ctx, query);
        const message = "What should I change in this Trip?";
        await services.platformStore.appendMessage(user.id, "assistant", message, new Date());
        await ctx.telegram.post(message);
        return;
      }
      const result = await services.tripPlanning.cancel(
        user.id,
        action.draftId,
        action.revision
      );
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Trip draft cancelled."
      });
      await clearCallbackButtons(ctx, query);
      await postTripPlanResult(ctx, user.id, result);
    } catch (error) {
      console.error(JSON.stringify({
        event: "captain.telegram_trip_plan_callback_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "That Trip draft changed. Please review the latest message."
      });
    }
  },
  events: {
    async "turn.started"(_data, channel, ctx) {
      await channel.telegram.startTyping();
      try {
        const posted = await channel.telegram.post(AGENT_PROGRESS_TEXT);
        if (posted.id) {
          agentProgressMessages.set(ctx.session.id, {
            chatId: channel.telegram.chatId,
            messageId: posted.id
          });
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: "captain.telegram_progress_start_failed",
          error: error instanceof Error ? error.name : "UnknownError"
        }));
      }
    },
    async "input.requested"(data, channel, ctx) {
      const requests = Array.isArray(data.requests)
        ? data.requests as unknown as SessionLimitInputRequest[]
        : [];
      const { limitRequests, otherRequests } = partitionSessionLimitRequests(requests);
      for (const request of limitRequests) {
        if (!claimSessionLimitRequest(request.requestId)) continue;
        const rendered = renderTelegramInputRequest(request as never, channel.state);
        const continueCallbackData = continueCallbackDataFromMarkup(rendered.replyMarkup);
        if (!continueCallbackData) {
          console.error(JSON.stringify({
            event: "captain.telegram_session_limit_missing_continue_callback",
            request_id: request.requestId
          }));
          continue;
        }
        const pending: PendingSessionRotation = {
          chatId: channel.telegram.chatId,
          requestId: request.requestId,
          continueCallbackData
        };
        pendingSessionRotations.set(ctx.session.id, pending);
        storePendingSessionRotation(channel.state, pending);
        console.info(JSON.stringify({
          event: "captain.telegram_session_limit_intercepted",
          request_id: request.requestId,
          session_id: ctx.session.id
        }));
      }
      for (const request of otherRequests) {
        if (
          isSessionLimitContinuationRequest(request)
          || looksLikeSessionBudgetPrompt(request.prompt)
        ) {
          continue;
        }
        const rendered = renderTelegramInputRequest(request as never, channel.state);
        const posted = await channel.telegram.post({
          text: rendered.text,
          ...(rendered.replyMarkup ? { reply_markup: rendered.replyMarkup } : {})
        });
        if (rendered.freeformRequestId !== undefined && posted.id) {
          registerTelegramFreeformPrompt(channel.state, {
            messageId: posted.id,
            requestId: rendered.freeformRequestId
          });
        }
      }
    },
    async "session.waiting"(_data, channel, ctx) {
      const pending = pendingSessionRotations.get(ctx.session.id)
        ?? takePendingSessionRotation(channel.state);
      if (!pending) return;
      pendingSessionRotations.delete(ctx.session.id);
      takePendingSessionRotation(channel.state);
      void answerSessionLimitContinue(pending).catch((error) => {
        console.error(JSON.stringify({
          event: "captain.telegram_session_limit_continue_failed",
          error: error instanceof Error ? error.name : "UnknownError"
        }));
      });
    },
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      await clearAgentProgress(channel, ctx.session.id);
      const userId = authUserId(ctx.session.auth.current?.attributes.captain_user_id);
      let message = data.message;
      if (userId) {
        const services = await getCaptainServices();
        message = await services.tripPlanning.groundAssistantMessage(userId, message);
        await services.platformStore.appendMessage(userId, "assistant", message, new Date());
      }
      await channel.telegram.post(message);
    },
    async "turn.completed"(_data, channel, ctx) {
      await clearAgentProgress(channel, ctx.session.id);
    },
    async "turn.failed"(_data, channel, ctx) {
      await clearAgentProgress(channel, ctx.session.id);
      await channel.telegram.post(PROCESSING_FAILURE_TEXT);
    }
  }
});

function privateHumanMessage(message: TelegramMessage): boolean {
  return message.chat.type === "private" && Boolean(message.from && !message.from.isBot);
}

function privateHumanCallback(query: TelegramCallbackQuery): boolean {
  return Boolean(
    query.message?.chat.type === "private"
    && !query.from.isBot
    && query.message.chat.id === query.from.id
  );
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

async function postTripPlanResult(
  ctx: TelegramContext,
  userId: string,
  result: TripPlanResult
): Promise<void> {
  const services = await getCaptainServices();
  const message = result.status === "needs_input"
    ? result.prompt
    : result.status === "awaiting_confirmation"
      ? result.confirmation
      : result.message;
  await services.platformStore.appendMessage(userId, "assistant", message, new Date());
  if (result.status === "awaiting_confirmation") {
    await ctx.telegram.post({
      text: message,
      reply_markup: {
        inline_keyboard: [
          [{
            text: "Create Trip",
            callback_data: `captain-trip:start:${result.draft.id}:${result.draft.revision}`
          }],
          [{
            text: "Edit",
            callback_data: `captain-trip:edit:${result.draft.id}:${result.draft.revision}`
          }, {
            text: "Cancel",
            callback_data: `captain-trip:cancel:${result.draft.id}:${result.draft.revision}`
          }]
        ]
      }
    });
    return;
  }
  if (result.status === "started") {
    await postTelegramDashboardMessage(ctx, message);
    return;
  }
  await ctx.telegram.post(message);
}

async function postTelegramDashboardMessage(
  ctx: TelegramContext,
  message: string
): Promise<void> {
  const rendered = telegramDashboardMessage(message);
  if (rendered.links.length === 0) {
    await ctx.telegram.post(message);
    return;
  }
  await ctx.telegram.post({
    text: rendered.text,
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: rendered.links.map((link) => [{
        text: link.text,
        url: link.url
      }])
    }
  });
}

async function withPlanningProgress<T>(
  ctx: TelegramContext,
  operation: () => Promise<T>
): Promise<T> {
  let statusMessageId: string | null = null;
  let posting: Promise<void> | null = null;
  const timer = setTimeout(() => {
    posting = (async () => {
      await ctx.telegram.startTyping();
      const posted = await ctx.telegram.post(PLANNING_PROGRESS_TEXT);
      statusMessageId = posted.id ?? null;
    })().catch((error) => {
      console.error(JSON.stringify({
        event: "captain.telegram_planning_progress_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
    });
  }, 750);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    await posting;
    if (statusMessageId) {
      try {
        await ctx.telegram.request("deleteMessage", {
          chat_id: ctx.telegram.chatId,
          message_id: Number(statusMessageId)
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: "captain.telegram_planning_progress_clear_failed",
          error: error instanceof Error ? error.name : "UnknownError"
        }));
      }
    }
  }
}

async function clearAgentProgress(
  channel: {
    telegram: {
      request(method: string, body?: Record<string, unknown>): Promise<unknown>;
    };
  },
  sessionId: string
): Promise<void> {
  const progress = agentProgressMessages.get(sessionId);
  if (!progress) return;
  agentProgressMessages.delete(sessionId);
  try {
    await channel.telegram.request("deleteMessage", {
      chat_id: progress.chatId,
      message_id: Number(progress.messageId)
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "captain.telegram_progress_clear_failed",
      error: error instanceof Error ? error.name : "UnknownError"
    }));
  }
}

export function parseTripPlanCallback(data: string | undefined): {
  type: "start" | "edit" | "cancel";
  draftId: string;
  revision: number;
} | null {
  const match = /^captain-trip:(start|edit|cancel):([0-9a-f-]{36}):(\d+)$/u.exec(data ?? "");
  if (!match) return null;
  const revision = Number(match[3]);
  return Number.isSafeInteger(revision) && revision > 0
    ? {
        type: match[1] as "start" | "edit" | "cancel",
        draftId: match[2]!,
        revision
      }
    : null;
}

export function isCaptainGreeting(text: string): boolean {
  return /^(?:hi|hello|hey|hi\s+there|hello\s+there|good\s+(?:morning|afternoon|evening))[!,. ]*$/iu
    .test(text.trim());
}

async function clearCallbackButtons(
  ctx: TelegramContext,
  query: TelegramCallbackQuery
): Promise<void> {
  if (!query.message?.messageId) return;
  await ctx.telegram.editMessageReplyMarkup({
    messageId: query.message.messageId,
    replyMarkup: { inline_keyboard: [] }
  });
}

async function answerSessionLimitContinue(pending: PendingSessionRotation): Promise<void> {
  const services = await getCaptainServices();
  const userId = Number(pending.chatId);
  if (!Number.isSafeInteger(userId)) throw new Error("Invalid Telegram chat ID");
  const updateId = Date.now() % 1_000_000_000;
  const response = await fetch(`${services.env.publicUrl}/eve/v1/telegram`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": required("TELEGRAM_WEBHOOK_SECRET_TOKEN")
    },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `captain-session-limit-continue-${updateId}`,
        data: pending.continueCallbackData,
        from: { id: userId, is_bot: false, first_name: "Traveller" },
        chat_instance: pending.chatId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          text: "Session budget reached",
          chat: { id: userId, type: "private" },
          from: { id: userId, is_bot: false, first_name: "Traveller" }
        }
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Telegram session-limit continue webhook failed (${response.status})`);
  }
}
