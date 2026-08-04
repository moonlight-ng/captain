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
  statusTextForToolNames,
  storePendingSessionRotation,
  takePendingSessionRotation,
  TELEGRAM_TYPING_KEEPALIVE_MS,
  TelegramProgressTracker,
  telegramMessageUpdateKey,
  toolNamesFromActions,
  type PendingSessionRotation,
  type SessionLimitInputRequest
} from "@agents/telegram-core";
import {
  TripLimitError,
  type OfferSnapshot,
  type TravellerProfile,
  type TripPlanDraft,
  type TripPlanResult
} from "@agents/flight-domain";
import {
  BetaCapacityError,
  BetaLaunchGateError,
  type CaptainNotification,
  type CaptainUser,
  type RecommendationSnapshot
} from "@agents/flight-store";

import { getCaptainServices } from "../../services/app/services.js";
import { TripPlanningService } from "../../services/trip-planning/service.js";
import {
  formatTripPlanConfirmation,
  telegramDashboardMessage
} from "../../services/trip-planning/format.js";

const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const credentials = {
  botToken: () => required("TELEGRAM_BOT_TOKEN"),
  webhookSecretToken: () => required("TELEGRAM_WEBHOOK_SECRET_TOKEN")
};
const pendingSessionRotations = new Map<string, PendingSessionRotation>();
const agentProgress = new TelegramProgressTracker();
const pendingConfirmationPosts = new Set<string>();
// Only steps a traveller would recognise as work belong here. Tools left out
// —reading recent context, for one—run under the typing indicator alone.
const CAPTAIN_TOOL_STATUS: Readonly<Record<string, string>> = {
  prepare_trip: "Working through the route and dates…",
  select_trip_flight: "Comparing the flight options…",
  start_prepared_trip: "Starting your trip…",
  manage_trip: "Updating your trip…"
};
const PROCESSING_FAILURE_TEXT = "I hit a problem while processing that message. Your saved trip is unchanged—please try again.";
export const CAPTAIN_NEW_USER_GREETING =
  "Hi, I'm Captain! I can help you prepare for a flight by tracking suitable options and reporting price changes.";
export const CAPTAIN_PREFERENCES_INTRO = "Let's start with your preferences";
export const CAPTAIN_TRAVELLER_SETUP_PROMPT =
  "Save your traveller details and card so Captain is ready when booking opens.";
export const CAPTAIN_PROFILES_INTRO =
  "Manage traveller profiles and your saved card in Captain settings.";
export const CAPTAIN_PAYMENT_UNAVAILABLE =
  "Card setup isn’t available yet. Captain will let you know when it opens.";
export const CAPTAIN_PAYMENT_INTRO =
  "Add or replace your saved card in Captain settings.";
export const CAPTAIN_SIGNOUT_CONFIRMATION =
  "Signed out of Captain on the web. Open a fresh link from Telegram to sign in again.";

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
    let user: CaptainUser;
    try {
      user = await services.platformStore.ensureTelegramUser({
        telegramUserId,
        telegramChatId,
        username: message.from?.username ?? null,
        firstName: message.from?.firstName ?? null,
        lastName: message.from?.lastName ?? null
      }, new Date());
    } catch (error) {
      if (error instanceof BetaCapacityError || error instanceof BetaLaunchGateError) {
        await ctx.telegram.post(error instanceof BetaLaunchGateError
          ? "Captain’s public beta isn’t open yet."
          : "Captain’s 25-person beta is full right now. Please try again later.");
        return null;
      }
      throw error;
    }
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
    const profile = await services.platformStore.ensureProfile(user.id, new Date());
    if (!profile.onboardingCompletedAt && profile.onboardingStep === "welcome") {
      if (content) {
        await services.platformStore.appendMessage(user.id, "user", content, new Date());
      }
      await postNewUserOnboarding(ctx, user.id);
      return null;
    }
    if (content === "/start") {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      if (!profile.onboardingCompletedAt) {
        await services.platformStore.updateProfile(
          user.id,
          { onboardingStep: "currency" },
          new Date()
        );
        await postCurrencyQuestion(ctx);
      } else {
        const welcome = "I’m Captain. I can watch up to three trips and let you know when prices or better options change.";
        await services.platformStore.appendMessage(user.id, "assistant", welcome, new Date());
        await postWithLink(
          ctx,
          welcome,
          "Edit preferences",
          await services.auth.createLoginLink(user.id, "/settings")
        );
      }
      return null;
    }
    if (!profile.onboardingCompletedAt) {
      await handleOnboardingText(ctx, user.id, profile, content);
      return null;
    }
    if (content === "/settings" || content === "/preferences") {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      await postWithLink(
        ctx,
        "Manage your traveller profile, saved card, flight preferences, and notifications in one place.",
        "Open settings",
        await services.auth.createLoginLink(user.id, "/settings")
      );
      return null;
    }
    if (content === "/trips") {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      const response = await services.tripPlanning.activeTripsLocation(user.id);
      if (!response) {
        await ctx.telegram.post("You don’t have a trip yet. Tell me where and when you want to fly.");
        return null;
      }
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await postTelegramDashboardMessage(ctx, response);
      return null;
    }
    if (content === "/profiles" || content === "/travellers") {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      await postWithLink(
        ctx,
        CAPTAIN_PROFILES_INTRO,
        "Open settings",
        await services.auth.createLoginLink(user.id, "/settings", { section: "profiles" })
      );
      return null;
    }
    if (content === "/payment") {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      if (!services.env.paymentsEnabled) {
        await ctx.telegram.post(CAPTAIN_PAYMENT_UNAVAILABLE);
        return null;
      }
      await postWithLink(
        ctx,
        CAPTAIN_PAYMENT_INTRO,
        "Open settings",
        await services.auth.createLoginLink(user.id, "/settings", { section: "payment" })
      );
      return null;
    }
    if (content === "/signout") {
      await services.auth.signOut(user.id);
      await ctx.telegram.post(CAPTAIN_SIGNOUT_CONFIRMATION);
      return null;
    }
    if (content === "/delete_account") {
      await services.auth.signOut(user.id);
      await services.platformStore.deleteUser(user.id);
      await ctx.telegram.post("Your Captain account, trip, sessions, and retained fare evidence have been deleted.");
      return null;
    }
    if (!content) {
      await ctx.telegram.post("Send me a destination and the dates you’re considering, by text or voice note.");
      return null;
    }

    const sourceMessageId = await services.platformStore.appendMessage(user.id, "user", content, new Date());
    await ctx.telegram.startTyping();

    const quotedMessageId = repliedToTelegramMessageId(message.raw);
    if (quotedMessageId !== null) {
      const notification = await services.platformStore.getNotificationByTelegramMessage(
        user.id,
        quotedMessageId
      );
      if (notification) {
        await services.platformStore.markTripActivity(user.id, notification.tripId, new Date());
      }
      const explanation = notification ? explainNotification(notification) : null;
      if (explanation) {
        await services.platformStore.appendMessage(user.id, "assistant", explanation, new Date());
        await ctx.telegram.post(explanation);
        return null;
      }
    }
    if (isExplanationQuestion(content)) {
      const trip = await services.platformStore.getActiveTrip(user.id);
      const recommendation = trip
        ? await services.platformStore.getRecommendation(user.id, trip.id)
        : null;
      if (recommendation) {
        await services.platformStore.markTripActivity(user.id, trip!.id, new Date());
        const explanation = explainRecommendation(recommendation.snapshot);
        await services.platformStore.appendMessage(user.id, "assistant", explanation, new Date());
        await ctx.telegram.post(explanation);
      } else {
        await ctx.telegram.post("I don’t have a recommendation for this trip yet. I’ll explain it as soon as I find one.");
      }
      return null;
    }

    if (isCaptainGreeting(content)) {
      const draft = await services.tripPlanning.findOpen(user.id);
      const response = draft
        ? "Hi! Your trip draft is still here, and we can continue whenever you’re ready."
        : "Hi! Tell me where you’re flying from, where you want to go, and roughly when.";
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await ctx.telegram.post(response);
      return null;
    }

    try {
      const handled = await withTypingIndicator(ctx, async () => {
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
      if (error instanceof TripLimitError) {
        const message = "You’re already tracking three trips. Open Agent settings and stop tracking one before creating another.";
        await services.platformStore.appendMessage(user.id, "assistant", message, new Date());
        await postWithLink(
          ctx,
          message,
          "Agent settings",
          await services.auth.createLoginLink(user.id, "/settings")
        );
        return null;
      }
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
    const profileAction = parseProfileCallback(query.data);
    if (profileAction) {
      try {
        await handleProfileCallback(ctx, query, profileAction);
      } catch (error) {
        if (!(error instanceof BetaCapacityError || error instanceof BetaLaunchGateError)) throw error;
        await ctx.telegram.answerCallbackQuery({
          callbackQueryId: query.id,
          text: error instanceof BetaLaunchGateError
            ? "Captain’s public beta isn’t open yet."
            : "Captain’s 25-person beta is full right now."
        });
      }
      return;
    }
    const trackingAction = parseTrackingCallback(query.data);
    if (trackingAction) {
      await handleTrackingCallback(ctx, query, trackingAction);
      return;
    }
    const action = parseTripPlanCallback(query.data);
    if (!action) return;
    const telegramUserId = safeId(query.from.id);
    const telegramChatId = safeId(query.message?.chat.id ?? "");
    if (telegramUserId === null || telegramChatId === null) return;
    const services = await getCaptainServices();
    let user: CaptainUser;
    try {
      user = await services.platformStore.ensureTelegramUser({
        telegramUserId,
        telegramChatId,
        username: query.from.username ?? null,
        firstName: query.from.firstName ?? null,
        lastName: query.from.lastName ?? null
      }, new Date());
    } catch (error) {
      if (!(error instanceof BetaCapacityError || error instanceof BetaLaunchGateError)) throw error;
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: error instanceof BetaLaunchGateError
          ? "Captain’s public beta isn’t open yet."
          : "Captain’s 25-person beta is full right now."
      });
      return;
    }
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
          text: "Creating the trip…"
        });
        const result = await services.tripPlanning.confirm(
          user.id,
          action.draftId,
          action.revision
        );
        await clearCallbackButtons(ctx, query);
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
        const message = "What should I change in this trip?";
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
      if (error instanceof TripLimitError) {
        await ctx.telegram.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "Three-trip limit reached."
        });
        await postWithLink(
          ctx,
          "You’re already tracking three trips. Stop tracking one before creating another.",
          "Agent settings",
          await services.auth.createLoginLink(user.id, "/settings")
        );
        return;
      }
      console.error(JSON.stringify({
        event: "captain.telegram_trip_plan_callback_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "That trip draft changed. Please review the latest message."
      });
    }
  },
  events: {
    async "turn.started"(data, channel, ctx) {
      await channel.telegram.startTyping();
      const chatId = channel.telegram.chatId;
      agentProgress.start({
        sessionId: ctx.session.id,
        chatId,
        turnId: data.turnId,
        onShow: async (statusText) => {
          try {
            const posted = await channel.telegram.post(statusText);
            return posted.id ?? null;
          } catch (error) {
            console.error(JSON.stringify({
              event: "captain.telegram_progress_start_failed",
              error: error instanceof Error ? error.name : "UnknownError"
            }));
            return null;
          }
        },
        onEdit: async (messageId, statusText) => {
          try {
            await channel.telegram.request("editMessageText", {
              chat_id: chatId,
              message_id: Number(messageId),
              text: statusText
            });
          } catch (error) {
            console.error(JSON.stringify({
              event: "captain.telegram_progress_update_failed",
              error: error instanceof Error ? error.name : "UnknownError"
            }));
          }
        },
        onDiscard: async (messageId) => {
          try {
            await channel.telegram.request("deleteMessage", {
              chat_id: chatId,
              message_id: Number(messageId)
            });
          } catch (error) {
            console.error(JSON.stringify({
              event: "captain.telegram_progress_clear_failed",
              error: error instanceof Error ? error.name : "UnknownError"
            }));
          }
        },
        onTyping: () => channel.telegram.startTyping()
      });
    },
    async "actions.requested"(data, channel, ctx) {
      await channel.telegram.startTyping();
      const label = statusTextForToolNames(
        toolNamesFromActions(data.actions as never),
        CAPTAIN_TOOL_STATUS
      );
      // Tools without a traveller-facing step keep the typing indicator only.
      if (!label) return;
      await agentProgress.setStatus(ctx.session.id, data.turnId, label);
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
      if (limitRequests.length > 0) {
        await recoverUndeliveredTripConfirmation(channel.telegram, ctx.session.auth.current?.attributes);
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
      await clearAgentProgress(ctx.session.id);
      const userId = authUserId(ctx.session.auth.current?.attributes.captain_user_id);
      let message = data.message;
      if (userId) {
        const services = await getCaptainServices();
        const grounded = await services.tripPlanning.groundAssistantMessage(userId, message);
        message = grounded.message;
        await services.platformStore.appendMessage(userId, "assistant", message, new Date());
        if (grounded.createdTrip) {
          await maybePostTravellerSetup(channel.telegram, userId);
        }
      }
      await channel.telegram.post(message);
    },
    async "turn.completed"(_data, _channel, ctx) {
      await clearAgentProgress(ctx.session.id);
    },
    async "turn.failed"(_data, channel, ctx) {
      await clearAgentProgress(ctx.session.id);
      await channel.telegram.post(PROCESSING_FAILURE_TEXT);
    }
  }
});

async function postNewUserOnboarding(
  ctx: TelegramContext,
  userId: string
): Promise<void> {
  const services = await getCaptainServices();
  await ctx.telegram.post(CAPTAIN_NEW_USER_GREETING);
  await services.platformStore.appendMessage(
    userId,
    "assistant",
    CAPTAIN_NEW_USER_GREETING,
    new Date()
  );
  await ctx.telegram.post(CAPTAIN_PREFERENCES_INTRO);
  await services.platformStore.appendMessage(
    userId,
    "assistant",
    CAPTAIN_PREFERENCES_INTRO,
    new Date()
  );
  await postCurrencyQuestion(ctx);
  await services.platformStore.updateProfile(
    userId,
    { onboardingStep: "currency" },
    new Date()
  );
}

async function postCurrencyQuestion(ctx: TelegramContext): Promise<void> {
  await ctx.telegram.post({
    text: "First, choose the currency you’d like me to use for fares.",
    reply_markup: {
      inline_keyboard: [[
        { text: "USD", callback_data: "captain-profile:currency:USD" },
        { text: "GBP", callback_data: "captain-profile:currency:GBP" }
      ]]
    }
  });
}

async function postRankingQuestion(ctx: TelegramContext): Promise<void> {
  await ctx.telegram.post({
    text: "What should Captain optimize for?",
    reply_markup: {
      inline_keyboard: [[
        { text: "Cheapest", callback_data: "captain-profile:ranking:cheapest" },
        { text: "Balanced", callback_data: "captain-profile:ranking:balanced" },
        { text: "Fastest", callback_data: "captain-profile:ranking:fastest" }
      ]]
    }
  });
}

async function postAirlineQuestion(ctx: TelegramContext): Promise<void> {
  await ctx.telegram.post(
    "Any airline preferences? Reply like “prefer KQ, avoid VS”, or send /skip. You can edit this later."
  );
}

async function handleOnboardingText(
  ctx: TelegramContext,
  userId: string,
  profile: TravellerProfile,
  content: string
): Promise<boolean> {
  const services = await getCaptainServices();
  if (profile.onboardingStep === "currency") {
    const currency = /^(USD|GBP)$/iu.test(content.trim()) ? content.trim().toUpperCase() : null;
    if (!currency) {
      await postCurrencyQuestion(ctx);
      return true;
    }
    await services.platformStore.updateProfile(
      userId,
      { defaultCurrency: currency, onboardingStep: "ranking" },
      new Date()
    );
    await postRankingQuestion(ctx);
    return true;
  }
  if (profile.onboardingStep === "ranking") {
    const ranking = /^(cheapest|balanced|fastest)$/iu.exec(content.trim())?.[1]?.toLowerCase();
    if (!ranking) {
      await postRankingQuestion(ctx);
      return true;
    }
    await services.platformStore.updateProfile(
      userId,
      {
        rankingMode: ranking as TravellerProfile["rankingMode"],
        onboardingStep: "airlines"
      },
      new Date()
    );
    await postAirlineQuestion(ctx);
    return true;
  }
  const preferences = parseAirlinePreferences(content);
  if (!preferences) {
    await postAirlineQuestion(ctx);
    return true;
  }
  await completeOnboarding(ctx, userId, preferences);
  return true;
}

async function handleProfileCallback(
  ctx: TelegramContext,
  query: TelegramCallbackQuery,
  action:
    | { type: "currency"; value: string }
    | { type: "ranking"; value: TravellerProfile["rankingMode"] }
): Promise<void> {
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
  await clearCallbackButtons(ctx, query);
  if (action.type === "currency") {
    if (!/^(USD|GBP)$/u.test(action.value)) {
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Choose USD or GBP"
      });
      await postCurrencyQuestion(ctx);
      return;
    }
    await services.platformStore.updateProfile(
      user.id,
      { defaultCurrency: action.value, onboardingStep: "ranking" },
      new Date()
    );
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: `${action.value} selected`
    });
    await postRankingQuestion(ctx);
    return;
  }
  await services.platformStore.updateProfile(
    user.id,
    { rankingMode: action.value, onboardingStep: "airlines" },
    new Date()
  );
  await ctx.telegram.answerCallbackQuery({
    callbackQueryId: query.id,
    text: `${titleCase(action.value)} selected`
  });
  await postAirlineQuestion(ctx);
}

export function parseProfileCallback(
  data: string | undefined
):
  | { type: "currency"; value: string }
  | { type: "ranking"; value: TravellerProfile["rankingMode"] }
  | null {
  const currency = /^captain-profile:currency:([A-Z]{3})$/u.exec(data ?? "");
  if (currency?.[1]) return { type: "currency", value: currency[1] };
  const ranking = /^captain-profile:ranking:(cheapest|balanced|fastest)$/u.exec(data ?? "");
  return ranking?.[1]
    ? { type: "ranking", value: ranking[1] as TravellerProfile["rankingMode"] }
    : null;
}

export function parseTrackingCallback(data: string | undefined): {
  action: "keep" | "pause";
  tripId: string;
} | null {
  const match = /^captain-watch:(keep|pause):([0-9a-f-]{36})$/u.exec(data ?? "");
  return match?.[1] && match[2]
    ? { action: match[1] as "keep" | "pause", tripId: match[2] }
    : null;
}

async function handleTrackingCallback(
  ctx: TelegramContext,
  query: TelegramCallbackQuery,
  action: { action: "keep" | "pause"; tripId: string }
): Promise<void> {
  const telegramUserId = safeId(query.from.id);
  const telegramChatId = safeId(query.message?.chat.id ?? "");
  if (telegramUserId === null || telegramChatId === null) return;
  const services = await getCaptainServices();
  let user: CaptainUser;
  try {
    user = await services.platformStore.ensureTelegramUser({
      telegramUserId,
      telegramChatId,
      username: query.from.username ?? null,
      firstName: query.from.firstName ?? null,
      lastName: query.from.lastName ?? null
    }, new Date());
  } catch (error) {
    if (!(error instanceof BetaCapacityError || error instanceof BetaLaunchGateError)) throw error;
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "Captain isn’t available for this account right now."
    });
    return;
  }
  const claimed = await services.platformStore.claimTelegramUpdate(
    `captain:callback:${query.id}`,
    user.id,
    new Date()
  );
  if (!claimed) {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "Already updated."
    });
    return;
  }
  try {
    const trip = await services.platformStore.respondToTrackingCheckIn(
      user.id,
      action.tripId,
      action.action,
      new Date()
    );
    await clearCallbackButtons(ctx, query);
    const route = trip.title.replace(/\s+to\s+/giu, " → ");
    const message = action.action === "keep"
      ? `Got it — I’ll keep watching ${route}.`
      : `Okay — I paused ${route}. You can resume it from Agent settings.`;
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: action.action === "keep" ? "Tracking continues." : "Tracking paused."
    });
    await services.platformStore.appendMessage(user.id, "assistant", message, new Date());
    await ctx.telegram.post(message);
  } catch {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "I couldn’t update that trip."
    });
  }
}

export function parseAirlinePreferences(content: string): {
  preferredAirlineCodes: string[];
  excludedAirlineCodes: string[];
} | null {
  if (/^\/?skip$/iu.test(content.trim())) {
    return { preferredAirlineCodes: [], excludedAirlineCodes: [] };
  }
  const upper = content.toUpperCase();
  const preferredPart = /\bPREFER(?:RED)?\s+(.+?)(?=\s*(?:;?\s*\b(?:AVOID|EXCLUDE)\b|$))/u.exec(upper)?.[1] ?? "";
  const excludedPart = /\b(?:AVOID|EXCLUDE)\s+(.+)$/u.exec(upper)?.[1] ?? "";
  const codes = (value: string) => [...new Set(
    [...value.replace(/\bAND\b/gu, " ").matchAll(/\b[A-Z0-9]{2,3}\b/gu)]
      .map((match) => match[0])
  )].slice(0, 12);
  const preferredAirlineCodes = codes(preferredPart);
  const excludedAirlineCodes = codes(excludedPart)
    .filter((code) => !preferredAirlineCodes.includes(code));
  return preferredAirlineCodes.length > 0 || excludedAirlineCodes.length > 0
    ? { preferredAirlineCodes, excludedAirlineCodes }
    : null;
}

async function completeOnboarding(
  ctx: TelegramContext,
  userId: string,
  preferences: {
    preferredAirlineCodes: string[];
    excludedAirlineCodes: string[];
  }
): Promise<void> {
  const services = await getCaptainServices();
  await services.platformStore.updateProfile(
    userId,
    {
      ...preferences,
      onboardingStep: "complete",
      onboardingCompletedAt: new Date().toISOString()
    },
    new Date()
  );
  await postWithLink(
    ctx,
    "Preferences set. Tell me where and roughly when you want to fly. I can track up to three trips at a time.",
    "Edit preferences",
    await services.auth.createLoginLink(userId, "/settings", { section: "profiles" })
  );
}

async function postWithLink(
  telegramOrCtx: TelegramContext | Pick<TelegramContext["telegram"], "post">,
  text: string,
  label: string,
  url: string
): Promise<void> {
  const telegram = "telegram" in telegramOrCtx ? telegramOrCtx.telegram : telegramOrCtx;
  await telegram.post({
    text,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: label, url }]] }
  });
}

export function repliedToTelegramMessageId(raw: Record<string, unknown>): number | null {
  const reply = record(raw.reply_to_message);
  const value = Number(reply?.message_id);
  return Number.isSafeInteger(value) ? value : null;
}

function isExplanationQuestion(content: string): boolean {
  return /\b(?:why|explain|better|recommend)\b/iu.test(content);
}

function snapshotFromPayload(payload: Record<string, unknown>): RecommendationSnapshot | null {
  const snapshot = record(payload.snapshot);
  return snapshot?.current && snapshot.rankingMode
    ? snapshot as unknown as RecommendationSnapshot
    : null;
}

export function explainNotification(notification: CaptainNotification): string | null {
  const snapshot = snapshotFromPayload(notification.payload);
  if (snapshot) return explainRecommendation(snapshot);
  if (notification.kind === "price_rise") {
    const current = record(notification.payload.current) as unknown as OfferSnapshot | null;
    if (!current) return null;
    const increase = Number(notification.payload.increase);
    const low = Number(notification.payload.sevenDayLow);
    const percent = Number(notification.payload.percent);
    if (![increase, low, percent].every(Number.isFinite)) return null;
    const evidence = current.evidence[0];
    return [
      `The option was ${current.currency} ${current.priceAmount}, up ${formatMoney(increase, current.currency)} (${Math.round(percent)}%) from its seven-day low of ${formatMoney(low, current.currency)}.`,
      evidence ? `I checked it here: ${evidence.url}` : ""
    ].filter(Boolean).join("\n");
  }
  if (notification.kind === "daily_digest" && Array.isArray(notification.payload.trips)) {
    const lines = notification.payload.trips.flatMap((value) => {
      const trip = record(value);
      if (!trip) return [];
      // Digest entries carry the snapshot directly. Older queued digests
      // nested it under `recommendation`, so both are still read here.
      const snapshot = record(trip.snapshot)
        ?? record(record(trip.recommendation)?.snapshot);
      const digestSnapshot = snapshotFromPayload(
        snapshot?.pendingDigestChange
          ? { snapshot: snapshot.pendingDigestChange }
          : { snapshot }
      );
      const current = digestSnapshot?.current;
      if (!current) return [];
      return [`• ${String(trip.tripTitle ?? "trip")}: ${current.currency} ${current.priceAmount}, checked ${new Date(current.observedAt).toISOString()}.`];
    });
    return lines.length > 0
      ? ["That update used the saved results available when I sent it:", ...lines].join("\n")
      : null;
  }
  return null;
}

export function explainRecommendation(snapshot: RecommendationSnapshot): string {
  const current = snapshot.current;
  const previous = snapshot.previous;
  const currentDuration = snapshotNumber(current.snapshot, "durationSeconds");
  const previousDuration = previous ? snapshotNumber(previous.snapshot, "durationSeconds") : 0;
  const evidence = current.evidence[0];
  const source = evidence ? `\nEvidence: ${evidence.url}` : "";
  if (!previous) {
    return [
      `This was the first ${titleCase(snapshot.rankingMode)} option I found for the trip.`,
      `It was ${current.currency} ${current.priceAmount}, ${durationLabel(currentDuration)}, ${stopLabel(snapshotNumber(current.snapshot, "stops"))}.`,
      "Prices and availability can change, so use the source below to check the latest details."
    ].join("\n") + source;
  }
  const priceChange = previous.price - current.price;
  const durationChange = previousDuration - currentDuration;
  const comparison = snapshot.rankingMode === "cheapest"
    ? `It saves ${formatMoney(Math.max(0, priceChange), current.currency)} (${percentage(priceChange, previous.price)}).`
    : snapshot.rankingMode === "fastest"
      ? `It cuts journey time by ${durationLabel(Math.max(0, durationChange))}.`
      : [
          "Balanced uses 50% price regret, 35% duration regret, and 15% stops, with a small preferred-airline credit.",
          [
            priceChange > 0 ? `${formatMoney(priceChange, current.currency)} cheaper` : "",
            durationChange > 0 ? `${durationLabel(durationChange)} shorter` : "",
            snapshotNumber(previous.snapshot, "stops") > snapshotNumber(current.snapshot, "stops")
              ? "fewer stops"
              : ""
          ].filter(Boolean).join(", ") || "Its combined score improved by at least 10%."
        ].join("\n");
  return [
    `Captain compared this alert with the exact earlier result it replaced (${previous.currency} ${previous.priceAmount}, ${durationLabel(previousDuration)}).`,
    comparison,
    `New result: ${current.currency} ${current.priceAmount}, ${durationLabel(currentDuration)}, ${stopLabel(snapshotNumber(current.snapshot, "stops"))}.`
  ].join("\n") + source;
}

function snapshotNumber(snapshot: Record<string, unknown>, key: string): number {
  const value = Number(snapshot[key]);
  return Number.isFinite(value) ? value : 0;
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

function durationLabel(seconds: number): string {
  if (seconds <= 0) return "unknown duration";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.round((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

function stopLabel(value: number): string {
  return value === 0 ? "nonstop" : `${value} stop${value === 1 ? "" : "s"}`;
}

function percentage(change: number, previous: number): string {
  return previous > 0 ? `${Math.max(0, Math.round(change / previous * 100))}%` : "an improvement";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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
      audio,
      providerOptions: {
        gateway: {
          user: "opemipo",
          tags: [
            "agent:captain",
            "operation:owner-voice-transcription"
          ]
        }
      }
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
  let message = result.status === "needs_input"
    ? result.prompt
    : result.status === "awaiting_confirmation"
      ? result.confirmation
      : result.message;
  if (result.status === "awaiting_confirmation") {
    await postTripConfirmationOnce(ctx.telegram, userId, result.draft, message);
    return;
  }
  await services.platformStore.appendMessage(userId, "assistant", message, new Date());
  if (result.status === "started") {
    await postTelegramDashboardMessage(ctx, message);
    await maybePostTravellerSetup(ctx.telegram, userId);
    return;
  }
  await ctx.telegram.post(message);
}

async function maybePostTravellerSetup(
  telegram: Pick<TelegramContext["telegram"], "post">,
  userId: string
): Promise<void> {
  const services = await getCaptainServices();
  const prompted = await services.platformStore.markTravellerSetupPrompted(userId, new Date());
  if (!prompted) return;
  await services.platformStore.appendMessage(userId, "assistant", CAPTAIN_TRAVELLER_SETUP_PROMPT, new Date());
  await postWithLink(
    telegram,
    CAPTAIN_TRAVELLER_SETUP_PROMPT,
    "Add traveller details",
    await services.auth.createLoginLink(userId, "/settings", { section: "profiles" })
  );
}

async function recoverUndeliveredTripConfirmation(
  telegram: Pick<TelegramContext["telegram"], "post">,
  attributes: Record<string, unknown> | undefined
): Promise<void> {
  const userId = authUserId(attributes?.captain_user_id);
  if (!userId) return;
  const services = await getCaptainServices();
  const draft = await services.tripPlanning.findOpen(userId);
  if (draft?.status !== "awaiting_confirmation") return;
  await postTripConfirmationOnce(
    telegram,
    userId,
    draft,
    formatTripPlanConfirmation(draft)
  );
}

async function postTripConfirmationOnce(
  telegram: Pick<TelegramContext["telegram"], "post">,
  userId: string,
  draft: TripPlanDraft,
  message: string
): Promise<void> {
  const key = `${draft.id}:${draft.revision}`;
  if (pendingConfirmationPosts.has(key)) return;
  pendingConfirmationPosts.add(key);
  try {
    const services = await getCaptainServices();
    const conversation = await services.platformStore.getConversation(userId, 8);
    if (hasDeliveredTripConfirmation(draft, message, conversation.recentMessages)) return;
    await telegram.post({
      text: message,
      reply_markup: tripPlanConfirmationReplyMarkup(draft)
    });
    await services.platformStore.appendMessage(userId, "assistant", message, new Date());
  } finally {
    pendingConfirmationPosts.delete(key);
  }
}

export function tripPlanConfirmationReplyMarkup(
  draft: Pick<TripPlanDraft, "id" | "revision">
) {
  return {
    inline_keyboard: [[{
      text: "Create",
      callback_data: `captain-trip:start:${draft.id}:${draft.revision}`
    }, {
      text: "Cancel",
      callback_data: `captain-trip:cancel:${draft.id}:${draft.revision}`
    }]]
  };
}

export function hasDeliveredTripConfirmation(
  draft: Pick<TripPlanDraft, "updatedAt">,
  message: string,
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>
): boolean {
  const updatedAt = Date.parse(draft.updatedAt);
  return recentMessages.some((candidate) =>
    candidate.role === "assistant"
    && candidate.content === message
    && Date.parse(candidate.createdAt) >= updatedAt
  );
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

/**
 * Keeps Telegram's typing indicator alive while the deterministic path works
 * out what the message is. Nothing is posted here: the traveller sees the
 * standard placeholder until a real step has something to report.
 */
async function withTypingIndicator<T>(
  ctx: TelegramContext,
  operation: () => Promise<T>
): Promise<T> {
  const keepalive = setInterval(() => {
    void Promise.resolve(ctx.telegram.startTyping()).catch((error) => {
      console.error(JSON.stringify({
        event: "captain.telegram_typing_keepalive_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
    });
  }, TELEGRAM_TYPING_KEEPALIVE_MS);
  keepalive.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(keepalive);
  }
}

async function clearAgentProgress(sessionId: string): Promise<void> {
  await agentProgress.clear(sessionId);
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
