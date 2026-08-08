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
  TelegramProgressTracker,
  telegramMessageUpdateKey,
  toolNamesFromActions,
  type PendingSessionRotation,
  type SessionLimitInputRequest
} from "@agents/telegram-core";
import {
  reviewCaptainMessage,
  TripLimitError,
  type OfferSnapshot,
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
import { tripRouteEcho } from "../../services/trip-planning/route-echo.js";

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
  prepare_trip: "Reading the route and dates…",
  search_trip_leg: "Checking dates and verified fares…",
  search_flights: "Checking verified fares…",
  select_trip_flight: "Putting the options side by side…",
  // Saving, not starting: creating a trip stores its legs and searches nothing
  // until the traveller asks.
  start_prepared_trip: "Saving your trip…",
  manage_trip: "Updating your trip…"
};
// Said before Captain knows anything, so it promises nothing but attention.
export const CAPTAIN_OPENING_STATUS = "Got it — let me check…";

/**
 * The opening acknowledgement, naming their route when they gave one plainly
 * enough to repeat. Echoing their own words costs nothing and says nothing
 * Captain has not been told, so it stays true however the search turns out.
 */
export function captainOpeningStatus(content: string): string {
  const route = tripRouteEcho(content);
  return route ? `Got it — ${route}. Checking…` : CAPTAIN_OPENING_STATUS;
}
// One line sitting still reads as a hang. These take over in order once a step
// outlasts its welcome, and stop once Captain has run out of honest things to
// say about waiting.
export const CAPTAIN_HOLDING_STATUS = [
  "Still on it…",
  "The providers are being slow. Still on it…",
  "Almost there — thanks for your patience…"
] as const;
// The deterministic planner interprets the request, resolves airports, and
// validates the calendar before any agent tool runs, so its stages are known up
// front and paced on a timer rather than reported by a tool.
export const CAPTAIN_PLANNING_STATUS = [
  CAPTAIN_TOOL_STATUS.prepare_trip!,
  ...CAPTAIN_HOLDING_STATUS
] as const;
const CAPTAIN_PLANNING_STAGE_MS = 3_000;
const PROCESSING_FAILURE_TEXT = "That one didn’t go through on my end. Your trip is untouched — try me again.";
// Onboarding is three messages and no questions. Everything the old interview
// asked for is seeded by DEFAULT_PROFILE and editable on /profile, so a new
// traveller learns what Captain is and can start planning without answering
// anything first.
export const CAPTAIN_NEW_USER_GREETING =
  "Hi, I’m Captain. I plan multi-city trips and compare real-time flight options across your possible dates.\n\n"
  + "I’m still in early testing, so I can only keep one trip at a time. I never book or pay for anything.";
export const CAPTAIN_DEFAULTS_INTRO =
  "You’re set up for USD fares and a balance of price and travel time. You can change these anytime.";
export const CAPTAIN_READY_PROMPT =
  "Send the cities and dates you’re considering by text or voice note. I’ll help turn them into flight legs and search the dates that work.";
// Captain introduces itself once, at the welcome step. A traveller who has
// already onboarded gets this instead.
export const CAPTAIN_RETURNING_TRAVELLER_WELCOME =
  "Welcome back. Where to next?";
// Someone who already has a trip is not being asked for one
// again—the welcome hands straight over to the one they have. Worded for one
// trip or several, since the summary below it counts them itself.
export const CAPTAIN_RETURNING_TRAVELLER_TRIP_WELCOME =
  "Welcome back. Here’s your saved trip.";
export const CAPTAIN_PROFILE_COMMAND = "/profile";
export const CAPTAIN_TRIP_COMMAND = "/trip";
export const CAPTAIN_TRIPS_COMMAND = "/trips";
export const CAPTAIN_CLEAR_COMMAND = "/clear";
export const CAPTAIN_FEEDBACK_COMMAND = "/feedback";
export const CAPTAIN_FEEDBACK_PROMPT =
  "Tell us what worked, what didn’t, or what you’d like Captain to do better.";
// Clearing drops the traveller's trips as well as their preferences, so the
// confirmation has to name both—otherwise the next /trip comes back empty
// and reads as Captain having lost something.
export const CAPTAIN_CLEAR_CONFIRMATION =
  "Cleared — trips and preferences both. I’ll be here when the next trip comes up.";
export const CAPTAIN_VOICE_TURN_CONTEXT =
  "The current user message was transcribed from a Telegram voice note. "
  + "Treat it as the traveller’s actual current request. Briefly acknowledge what you understood, "
  + "then answer it or ask only for genuinely missing information. Do not replace it with a generic trip-opening question.";

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
    let voiceTranscript: string | null = null;
    if (!content && voice) {
      try {
        content = await transcribeVoice(voice);
        if (!content) throw new Error("No voice transcript was generated");
        voiceTranscript = content;
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
      // Two updates can land on the welcome step together—Telegram's own
      // /start plus whatever the traveller typed next. Only the update that
      // claims the step introduces Captain; the other stays quiet.
      if (await services.platformStore.claimOnboardingWelcome(user.id, new Date())) {
        await postNewUserOnboarding(ctx, user.id);
      }
      return null;
    }
    const command = telegramCommandName(content);
    if (command === "start") {
      // Claiming the welcome step completes onboarding, so anyone reaching
      // here has already been introduced.
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      // Someone who already has a trip is welcomed back to it rather
      // than asked for one they have—same summary /trip would give them.
      const tracked = await services.tripPlanning.activeTripsLocation(user.id);
      const welcome = returningTravellerWelcome(tracked);
      await services.platformStore.appendMessage(user.id, "assistant", welcome, new Date());
      if (tracked) {
        await postTelegramDashboardMessage(ctx, welcome);
        return null;
      }
      await postWithLink(
        ctx,
        welcome,
        "Edit preferences",
        await services.auth.createLoginLink(user.id, "/profile")
      );
      return null;
    }
    if (
      command === CAPTAIN_PROFILE_COMMAND.slice(1)
      || command === "settings"
      || command === "preferences"
    ) {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      await postWithLink(
        ctx,
        "Choose how Captain notifies you, and how it ranks the flights it finds.",
        "Open profile",
        await services.auth.createLoginLink(user.id, "/profile")
      );
      return null;
    }
    if (command === CAPTAIN_FEEDBACK_COMMAND.slice(1)) {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      await postWithLink(
        ctx,
        CAPTAIN_FEEDBACK_PROMPT,
        "Open feedback form",
        await services.auth.createLoginLink(user.id, "/feedback")
      );
      return null;
    }
    if (
      command === CAPTAIN_TRIP_COMMAND.slice(1)
      || command === CAPTAIN_TRIPS_COMMAND.slice(1)
    ) {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      const response = await services.tripPlanning.activeTripsLocation(user.id);
      if (!response) {
        await ctx.telegram.post("Nothing on the board yet. Where to next?");
        return null;
      }
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await postTelegramDashboardMessage(ctx, response);
      return null;
    }
    if (command === CAPTAIN_CLEAR_COMMAND.slice(1)) {
      await services.platformStore.clearTravellerData(user.id, new Date());
      await ctx.telegram.post(CAPTAIN_CLEAR_CONFIRMATION);
      return null;
    }
    if (content.trimStart().startsWith("/")) {
      const response = "That’s not one of mine. /trip for your trip, /profile for preferences, /feedback to send feedback.";
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await ctx.telegram.post(response);
      return null;
    }
    if (!content) {
      await ctx.telegram.post("Send your trip by text or voice note. If you’re unsure about the dates, I’ll help you work them out.");
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
        ? "Hello. Your draft is still open — want to pick it back up?"
        : "Hello. Where to next?";
      await services.platformStore.appendMessage(user.id, "assistant", response, new Date());
      await ctx.telegram.post(response);
      return null;
    }

    try {
      // Trip planning is the only turn this path is certain to answer itself.
      // Anything else may fall through to the agent, which posts its own
      // acknowledgement—so those turns stay on the typing indicator rather than
      // posting a status message and deleting it a second later.
      const stages = TripPlanningService.isTripPlanningRequest(content)
        && !TripPlanningService.needsItineraryPlanningConversation(content)
        ? { opening: captainOpeningStatus(content), lines: CAPTAIN_PLANNING_STATUS }
        : null;
      // The reply is worked out under the progress message and posted after it
      // is gone, so the traveller never sees Captain's answer land underneath
      // its own "still on it".
      const reply = await withCaptainProgress(ctx, telegramChatId, stages, async () => {
        const openDraftResult = await services.tripPlanning.handleOpenDraftText(
          user.id,
          content,
          sourceMessageId
        );
        if (openDraftResult) {
          return { kind: "trip_plan" as const, result: openDraftResult };
        }
        if (TripPlanningService.isWhereQuestion(content)) {
          const location = await services.tripPlanning.activeTripLocation(user.id);
          if (location) return { kind: "dashboard" as const, message: location };
        }
        if (
          TripPlanningService.isTripPlanningRequest(content)
          && !TripPlanningService.needsItineraryPlanningConversation(content)
        ) {
          const planned = await services.tripPlanning.prepare(user.id, content, sourceMessageId);
          return { kind: "trip_plan" as const, result: planned };
        }
        return null;
      });
      if (reply) {
        if (reply.kind === "dashboard") {
          await services.platformStore.appendMessage(user.id, "assistant", reply.message, new Date());
          await postTelegramDashboardMessage(ctx, reply.message);
          return null;
        }
        await postTripPlanResult(ctx, user.id, reply.result, {
          acknowledgeVoice: voiceTranscript !== null
        });
        return null;
      }
    } catch (error) {
      if (error instanceof TripLimitError) {
        const message = "You already have an active trip. Send the new itinerary and I’ll ask whether you want to replace the current one.";
        await services.platformStore.appendMessage(user.id, "assistant", message, new Date());
        await postWithLink(
          ctx,
          message,
          "Open trip",
          await services.auth.createLoginLink(user.id, "/trip")
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

    if (voiceTranscript !== null) {
      promoteVoiceTranscriptToTelegramTurn(message, voiceTranscript);
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
      ...(voiceTranscript !== null ? { context: [CAPTAIN_VOICE_TURN_CONTEXT] } : {})
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
          text: "Setting it up…"
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
        text: "Draft dropped."
      });
      await clearCallbackButtons(ctx, query);
      await postTripPlanResult(ctx, user.id, result);
    } catch (error) {
      if (error instanceof TripLimitError) {
        await ctx.telegram.answerCallbackQuery({
          callbackQueryId: query.id,
          text: "One-trip limit reached."
        });
        await postWithLink(
          ctx,
          "You already have an active trip. Send the new itinerary and I’ll ask whether you want to replace the current one.",
          "Open trip",
          await services.auth.createLoginLink(user.id, "/trip")
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
        opening: CAPTAIN_OPENING_STATUS,
        holdingLines: CAPTAIN_HOLDING_STATUS,
        ...telegramProgressCallbacks(channel.telegram, chatId),
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
        const draft = await services.tripPlanning.findOpen(userId);
        if (draft?.status === "awaiting_confirmation") {
          const confirmation = formatTripPlanConfirmation(draft);
          const conversation = await services.platformStore.getConversation(userId, 8);
          if (isDuplicateTripConfirmationReply(
            draft,
            confirmation,
            message,
            conversation.recentMessages
          )) {
            console.info(JSON.stringify({
              event: "captain.telegram_duplicate_trip_confirmation_suppressed",
              draft_id: draft.id,
              revision: draft.revision
            }));
            return;
          }
        }
        const grounded = await services.tripPlanning.groundAssistantMessage(userId, message);
        message = reviewCaptainMessage(grounded.message);
        await services.platformStore.appendMessage(userId, "assistant", message, new Date());
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
  const remember = (text: string) =>
    services.platformStore.appendMessage(userId, "assistant", text, new Date());

  // The caller already completed onboarding by claiming the welcome step, so
  // these three messages are the whole of it.
  await ctx.telegram.post(CAPTAIN_NEW_USER_GREETING);
  await remember(CAPTAIN_NEW_USER_GREETING);
  await postWithLink(
    ctx,
    CAPTAIN_DEFAULTS_INTRO,
    "Preferences",
    await services.auth.createLoginLink(userId, "/profile")
  );
  await remember(CAPTAIN_DEFAULTS_INTRO);
  await ctx.telegram.post(CAPTAIN_READY_PROMPT);
  await remember(CAPTAIN_READY_PROMPT);
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

export function telegramCommandName(content: string): string | null {
  const match = /^\/([a-z][a-z0-9_]*)(?:@[a-z][a-z0-9_]*)?$/iu.exec(content.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

export function returningTravellerWelcome(trackedTrips: string | null): string {
  return trackedTrips
    ? `${CAPTAIN_RETURNING_TRAVELLER_TRIP_WELCOME}\n\n${trackedTrips}`
    : CAPTAIN_RETURNING_TRAVELLER_WELCOME;
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

// Eve builds the model turn from this same parsed message after onMessage
// returns. Its Telegram hook does not currently expose a message override, so
// promoting the transcript here makes the spoken words the actual user turn
// instead of leaving the model with an empty message and background context.
export function promoteVoiceTranscriptToTelegramTurn(
  message: TelegramMessage,
  transcript: string
): void {
  Object.assign(message, { text: transcript });
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
  result: TripPlanResult,
  options: { acknowledgeVoice?: boolean } = {}
): Promise<void> {
  const services = await getCaptainServices();
  // A prompt the service built from more than one turn is sent as more than one
  // message: a question bundled under a dozen dated bullets is where it is
  // least likely to be read and answered.
  let parts = result.status === "needs_input"
    ? [...(result.promptParts ?? [result.prompt])]
    : [result.status === "awaiting_confirmation" ? result.confirmation : result.message];
  if (result.status === "needs_input" && options.acknowledgeVoice) {
    // The voice acknowledgement belongs on the first thing Captain says, not
    // on whichever part happens to carry the question.
    parts[0] = acknowledgeVoiceClarification(parts[0]!);
  }
  parts = parts.map(reviewCaptainMessage);
  if (result.status === "awaiting_confirmation") {
    await postTripConfirmationOnce(ctx.telegram, userId, result.draft, parts[0]!);
    return;
  }
  for (const part of parts) {
    await services.platformStore.appendMessage(userId, "assistant", part, new Date());
    if (result.status === "started") {
      await postTelegramDashboardMessage(ctx, part);
      continue;
    }
    await ctx.telegram.post(part);
  }
}

export function acknowledgeVoiceClarification(prompt: string): string {
  return `I understood your voice note as a trip request. ${prompt}`;
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

export function isDuplicateTripConfirmationReply(
  draft: Pick<TripPlanDraft, "updatedAt">,
  confirmation: string,
  candidate: string,
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>
): boolean {
  if (!hasSameTripConfirmationFacts(confirmation, candidate)) return false;
  const updatedAt = Date.parse(draft.updatedAt);
  return recentMessages.some((recent) =>
    recent.role === "assistant"
    && Date.parse(recent.createdAt) >= updatedAt
    && hasSameTripConfirmationFacts(confirmation, recent.content)
  );
}

function hasSameTripConfirmationFacts(expected: string, candidate: string): boolean {
  const expectedFacts = tripConfirmationFacts(expected);
  if (expectedFacts.length < 3) return false;
  const candidateFacts = new Set(tripConfirmationFacts(candidate));
  return expectedFacts.every((fact) => candidateFacts.has(fact));
}

function tripConfirmationFacts(message: string): string[] {
  return message
    .split("\n")
    .map((line) => line
      .trim()
      .replace(/^[•*-]\s*/u, "")
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en"))
    .filter((line) => /^(?:route|leg \d+|depart|return|stay|trip type|travellers|cabin|stops|currency):/u.test(line));
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
 * Runs the deterministic path under the same disappearing status message the
 * agent turns use. With `stages`, it acknowledges the traveller and then walks
 * that script on a timer; with `null` it keeps the typing indicator alone. The
 * message is deleted in `finally`—before the caller posts anything—so a thrown
 * TripLimitError leaves no orphan status behind.
 *
 * Deterministic turns have no Eve session, so they are keyed on the chat under
 * a prefix that cannot collide with a session id.
 */
async function withCaptainProgress<T>(
  ctx: TelegramContext,
  chatId: number,
  stages: { opening: string; lines: readonly string[] } | null,
  operation: () => Promise<T>
): Promise<T> {
  const sessionId = `captain-telegram-chat:${chatId}`;
  agentProgress.start({
    sessionId,
    chatId: String(chatId),
    turnId: "deterministic",
    ...(stages ? { opening: stages.opening, holdingLines: stages.lines } : {}),
    holdingIntervalMs: CAPTAIN_PLANNING_STAGE_MS,
    ...telegramProgressCallbacks(ctx.telegram, String(chatId)),
    onTyping: () => ctx.telegram.startTyping()
  });
  try {
    return await operation();
  } finally {
    await clearAgentProgress(sessionId);
  }
}

/**
 * Posting, editing, and deleting the one status message. Every failure is
 * logged and swallowed: progress copy is never worth losing a turn over.
 */
function telegramProgressCallbacks(
  telegram: Pick<TelegramContext["telegram"], "post" | "request">,
  chatId: string
) {
  return {
    onShow: async (statusText: string) => {
      try {
        const posted = await telegram.post(statusText);
        return posted.id ?? null;
      } catch (error) {
        console.error(JSON.stringify({
          event: "captain.telegram_progress_start_failed",
          error: error instanceof Error ? error.name : "UnknownError"
        }));
        return null;
      }
    },
    onEdit: async (messageId: string, statusText: string) => {
      try {
        await telegram.request("editMessageText", {
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
    onDiscard: async (messageId: string) => {
      try {
        await telegram.request("deleteMessage", {
          chat_id: chatId,
          message_id: Number(messageId)
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: "captain.telegram_progress_clear_failed",
          error: error instanceof Error ? error.name : "UnknownError"
        }));
      }
    }
  };
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
