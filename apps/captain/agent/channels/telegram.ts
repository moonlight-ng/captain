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
  type Trip,
  type TripCreationReceipt,
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
import {
  CAPTAIN_ARCHIVED_TELEGRAM_MESSAGE,
  isCaptainArchivedMode
} from "../../services/app/archive.js";
import { clearTelegramOwnerContext } from "../../services/agent/owner-context.js";
import { learnLanguageFromDeliveredExchange } from "../../services/agent/language-preference.js";
import {
  isTripConfirmationText,
  TripPlanningService
} from "../../services/trip-planning/service.js";
import {
  formatTripPlanConfirmation,
  hasSameTripConfirmationFacts,
  isTripPlanRestatement,
  looksLikeTripCreationReceipt,
  looksLikeTripPlanConfirmation,
  looksLikeTripSaveOffer,
  telegramDashboardMessage
} from "../../services/trip-planning/format.js";
import { tripRouteEcho } from "../../services/trip-planning/route-echo.js";
import { explainNotification } from "../../services/trips/explain.js";
import { clearPrepareTripTurn } from "../tools/prepare_trip.js";

const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const credentials = {
  botToken: () => required("TELEGRAM_BOT_TOKEN"),
  webhookSecretToken: () => required("TELEGRAM_WEBHOOK_SECRET_TOKEN")
};
const pendingSessionRotations = new Map<string, PendingSessionRotation>();
/**
 * What the traveller just said, so the turn's opening acknowledgement can echo
 * their own route back. `turn.started` fires with the session, not the
 * message, and Captain going quiet until some recognised tool fired is the
 * thing this is here to fix.
 */
const pendingTurnContent = new Map<string, { content: string; key: string }>();
const turnLanguageInputs = new Map<string, { userId: string; content: string }>();

/**
 * Text already sent this turn. A model that speaks before a tool call often
 * repeats itself in its final answer, and the traveller should not read the
 * same sentence twice.
 */
const turnMessagesSent = new Map<string, Set<string>>();

const turnsWithPreface = new Set<string>();

/**
 * Plans already restated this turn, kept as text so the next step is compared
 * on its facts and not its bytes — a model retyping its own plan changes a
 * quote mark, never the route. `message.completed` fires once per step, so a
 * turn that showed the Create/Cancel card and then created the trip sent the
 * same itinerary once per step and the traveller read their route three times.
 */
const turnPlansSent = new Map<string, string[]>();

/** Records this plan for the turn and reports whether it is new to it. */
export function claimTurnPlanRestatement(turnId: string, message: string): boolean {
  if (!isTripPlanRestatement(message)) return true;
  const sent = turnPlansSent.get(turnId) ?? [];
  if (sent.some((earlier) => hasSameTripConfirmationFacts(message, earlier))) return false;
  turnPlansSent.set(turnId, [...sent, message]);
  while (turnPlansSent.size > 64) {
    const oldest = turnPlansSent.keys().next();
    if (oldest.done) break;
    turnPlansSent.delete(oldest.value);
  }
  return true;
}

function claimTurnPreface(turnId: string): boolean {
  if (turnsWithPreface.has(turnId)) return false;
  turnsWithPreface.add(turnId);
  while (turnsWithPreface.size > 64) {
    const oldest = turnsWithPreface.values().next();
    if (oldest.done) break;
    turnsWithPreface.delete(oldest.value);
  }
  return true;
}

function claimTurnMessage(turnId: string, text: string): boolean {
  const sent = turnMessagesSent.get(turnId) ?? new Set<string>();
  if (sent.has(text)) return false;
  sent.add(text);
  turnMessagesSent.set(turnId, sent);
  while (turnMessagesSent.size > 64) {
    const oldest = turnMessagesSent.keys().next();
    if (oldest.done) break;
    turnMessagesSent.delete(oldest.value);
  }
  return true;
}

function rememberTurnContent(chatId: string, content: string, key: string): void {
  pendingTurnContent.set(chatId, { content, key });
  // A turn that never starts — a command handled inline, a dropped update —
  // must not leave its opening waiting for the next one.
  while (pendingTurnContent.size > 64) {
    const oldest = pendingTurnContent.keys().next();
    if (oldest.done) break;
    pendingTurnContent.delete(oldest.value);
  }
}
const agentProgress = new TelegramProgressTracker();
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
// Said before Captain knows anything, so every variant promises nothing but
// attention. Keeping the copy in one small palette makes the acknowledgement
// feel conversational without paying for a model call just to write a status.
export const CAPTAIN_OPENING_STATUS_VARIANTS = [
  { lead: "On it", genericAction: "taking a look", routeAction: "Taking a look" },
  { lead: "Alright", genericAction: "working through that", routeAction: "Working through it" },
  { lead: "Understood", genericAction: "one moment", routeAction: "One moment" },
  { lead: "Absolutely", genericAction: "I’m on it", routeAction: "I’m on it" },
  { lead: "Sounds good", genericAction: "looking into it", routeAction: "Looking into it" }
] as const;

/**
 * The opening acknowledgement, naming their route when they gave one plainly
 * enough to repeat. Echoing their own words costs nothing and says nothing
 * Captain has not been told, so it stays true however the search turns out.
 */
export function captainOpeningStatus(content: string, variationKey = content): string {
  const route = tripRouteEcho(content);
  const variant = CAPTAIN_OPENING_STATUS_VARIANTS[
    stableVariationIndex(variationKey, CAPTAIN_OPENING_STATUS_VARIANTS.length)
  ]!;
  return route
    ? `${variant.lead} — ${route}. ${variant.routeAction}…`
    : `${variant.lead} — ${variant.genericAction}…`;
}

function stableVariationIndex(seed: string, choices: number): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash, 31) + seed.charCodeAt(index) | 0;
  }
  return (hash >>> 0) % choices;
}
// One line sitting still reads as a hang. These take over in order once a step
// outlasts its welcome, and stop once Captain has run out of honest things to
// say about waiting.
export const CAPTAIN_HOLDING_STATUS = [
  "Still on it…",
  "Almost there — thanks for your patience…"
] as const;
/**
 * Only a step that is genuinely waiting on an airline gets to blame one. These
 * used to be the default for every step, on a timer with no idea what was
 * running, so Captain reported slow providers while it was reading a date.
 */
export const CAPTAIN_PROVIDER_HOLDING_STATUS = [
  "Still checking…",
  "The airlines are being slow to answer. Still checking…",
  "Almost there — thanks for your patience…"
] as const;
const CAPTAIN_PROVIDER_TOOLS = new Set(["search_trip_leg", "search_flights"]);
// The deterministic planner interprets the request, resolves airports, and
// validates the calendar before any agent tool runs, so its stages are known up
// front and paced on a timer rather than reported by a tool.
export const CAPTAIN_PLANNING_STATUS = [
  CAPTAIN_TOOL_STATUS.prepare_trip!,
  ...CAPTAIN_HOLDING_STATUS
] as const;
const CAPTAIN_PLANNING_STAGE_MS = 3_000;

/**
 * The status stages for one turn: what Captain says before it knows anything,
 * then the lines that take over while it works.
 *
 * Extracted so the wiring can be asserted. It was silently dropped in
 * 16020b8 — the opening acknowledgement went on existing, fully tested, and
 * called from nowhere, and travellers got silence until a recognised tool
 * happened to fire.
 */
export function captainPlanningStages(
  content: string,
  variationKey: string
): { opening: string; lines: readonly string[] } {
  return {
    opening: captainOpeningStatus(content, variationKey),
    lines: CAPTAIN_HOLDING_STATUS
  };
}
const PROCESSING_FAILURE_TEXT = "That one didn’t go through. Your trip is untouched — please try again.";
// Onboarding opens as a conversation. Capability and orientation messages are
// staggered later, and disappear as soon as the traveller finds their own way.
// The opening question varies, because a single scripted line is the one thing
// every traveller reads before deciding whether this is a person or a form.
// Each asks for the trip in its own way and leaves the traveller free to answer
// with as much or as little as they have.
export const CAPTAIN_NEW_USER_GREETINGS = [
  "Hi, I’m Captain. Where do you want to go?",
  "Hi, I’m Captain. What’s the plan?",
  "Hi, I’m Captain. What’s on your mind?"
] as const;
/**
 * A traveller meets Captain once, so the variant is picked from something
 * stable about them rather than rotated: the same person re-reading their own
 * chat history finds the greeting they were actually sent.
 */
export function captainNewUserGreeting(variationKey: string): string {
  return CAPTAIN_NEW_USER_GREETINGS[
    stableVariationIndex(variationKey, CAPTAIN_NEW_USER_GREETINGS.length)
  ]!;
}
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
// Clearing drops the traveller's trips, preferences, and stored conversation,
// then returns onboarding to its welcome step. The next /start should feel
// exactly like meeting Captain for the first time.
export const CAPTAIN_CLEAR_CONFIRMATION =
  "Cleared — trips, preferences, and conversation history. Tap Start to begin again.";
export const CAPTAIN_VOICE_TURN_CONTEXT =
  "The current user message was transcribed from a Telegram voice note. "
  + "Treat it as the traveller’s actual current request. Answer it directly or ask only for genuinely missing information. "
  + "If reflecting your understanding is useful, name the concrete route or dates instead of using a generic acknowledgement. "
  + "Do not replace it with a generic trip-opening question.";

export default telegramChannel({
  route: "/eve/v1/telegram",
  credentials,
  uploadPolicy: { maxBytes: MAX_VOICE_BYTES, allowedMediaTypes: ["audio/*"] },
  async onMessage(ctx, message) {
    if (!privateHumanMessage(message)) return null;
    if (await replyIfCaptainArchived(ctx.telegram)) return null;
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
      await postTelegramAssistantMessage(
        ctx.telegram,
        "Your Captain access is currently suspended. Please contact support if you think this is a mistake.",
        null,
        user.id
      );
      return null;
    }

    let content = (message.text || message.caption || "").trim();
    const voice = voiceAttachment(message.raw);
    let voiceTranscript: string | null = null;
    if (!content && voice) {
      try {
        content = await transcribeVoice(voice, user.id);
        if (!content) throw new Error("No voice transcript was generated");
        voiceTranscript = content;
      } catch {
        await services.platformStore.disableOnboardingFollowups(
          user.id,
          "telegram_message",
          new Date()
        );
        await postTelegramAssistantMessage(
          ctx.telegram,
          "I couldn’t understand that voice note. Please try again or send the details as text.",
          null,
          user.id
        );
        return null;
      }
    }
    const command = telegramCommandName(content);
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
      if (command !== "start") {
        await services.platformStore.disableOnboardingFollowups(
          user.id,
          content.trimStart().startsWith("/") ? "telegram_command" : "telegram_message",
          new Date()
        );
      }
      return null;
    }
    await services.platformStore.disableOnboardingFollowups(
      user.id,
      content.trimStart().startsWith("/") ? "telegram_command" : "telegram_message",
      new Date()
    );
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
        await postTelegramDashboardMessage(ctx, welcome, user.id);
        return null;
      }
      await postWithLink(
        ctx,
        welcome,
        "Edit preferences",
        await services.auth.createLoginLink(user.id, "/profile"),
        user.id
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
        await services.auth.createLoginLink(user.id, "/profile"),
        user.id
      );
      return null;
    }
    if (command === CAPTAIN_FEEDBACK_COMMAND.slice(1)) {
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      await postWithLink(
        ctx,
        CAPTAIN_FEEDBACK_PROMPT,
        "Open feedback form",
        await services.auth.createLoginLink(user.id, "/feedback"),
        user.id
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
        await postTelegramAssistantMessage(ctx.telegram, "Nothing on the board yet. Where to next?", null, user.id);
        return null;
      }
      const delivered = await postTelegramDashboardMessage(ctx, response, user.id);
      await services.platformStore.appendMessage(user.id, "assistant", delivered.storedText, new Date());
      return null;
    }
    if (command === CAPTAIN_CLEAR_COMMAND.slice(1)) {
      await clearTelegramOwnerContext(telegramChatId, services.env.databaseUrl);
      await services.platformStore.clearTravellerData(user.id, new Date());
      const clearConfirmation = profile.preferredLanguageSource === "default"
        ? CAPTAIN_CLEAR_CONFIRMATION
        : await services.language.localize(
            CAPTAIN_CLEAR_CONFIRMATION,
            profile.preferredLanguage
          );
      await ctx.telegram.post(clearConfirmation);
      return null;
    }
    if (content.trimStart().startsWith("/")) {
      const response = "That command isn’t available. Use /trip for your trip, /profile for preferences, or /feedback to send feedback.";
      await services.platformStore.appendMessage(user.id, "user", content, new Date());
      const delivered = await postTelegramAssistantMessage(ctx.telegram, response, null, user.id);
      await services.platformStore.appendMessage(user.id, "assistant", delivered.storedText, new Date());
      return null;
    }
    if (!content) {
      await postTelegramAssistantMessage(
        ctx.telegram,
        "Send your trip by text or voice note. If you’re unsure about the dates, I’ll help you work them out.",
        null,
        user.id
      );
      return null;
    }

    const sourceMessageId = await services.platformStore.appendMessage(user.id, "user", content, new Date());
    // Detached: memory must never sit between a traveller and their answer.
    // Running it here rather than after the reply means the summary trails by
    // one turn, which is immaterial against an eight-message trigger, and it
    // covers every path below — the fast path and the agent alike.
    void services.rememberConversation(user.id).catch((error: unknown) => {
      console.warn(JSON.stringify({
        event: "captain.conversation_memory_dispatch_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
    });
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
        const delivered = await postTelegramAssistantMessage(ctx.telegram, explanation, null, user.id);
        await services.platformStore.appendMessage(user.id, "assistant", delivered.storedText, new Date());
        void learnLanguageAfterDelivery(user.id, content, delivered.visibleText);
        return null;
      }
    }
    if (isCaptainGreeting(content)) {
      const draft = await services.tripPlanning.findOpen(user.id);
      const response = draft
        ? "Hello. Your draft is still open — want to pick it back up?"
        : "Hello. Where to next?";
      const delivered = await postTelegramAssistantMessage(ctx.telegram, response, null, user.id);
      await services.platformStore.appendMessage(user.id, "assistant", delivered.storedText, new Date());
      void learnLanguageAfterDelivery(user.id, content, delivered.visibleText);
      return null;
    }

    try {
      // This path answers only what a single word can settle: a decision about
      // an open draft, or a “yes” to a trip waiting to be tracked. Everything
      // interpretive — questions about the trip, new itineraries, anything
      // needing a judgement about what the traveller meant — falls through to
      // the agent, which can read the trip before it answers.
      //
      // It used to route on verbs. “What's the best day to fly that week”
      // matched /fly/ and /best/, opened an empty draft, and answered a
      // question about an existing trip by asking where they were flying from.
      const reply = await withCaptainProgress(
        ctx,
        telegramChatId,
        user.id,
        captainPlanningStages(content, String(messageId)),
        async () => {
        const decision = await services.tripPlanning.handleDraftDecision(
          user.id,
          content,
          sourceMessageId
        );
        if (decision) {
          return { kind: "trip_plan" as const, result: decision };
        }
        const activeTrip = await services.platformStore.getActiveTrip(user.id);
        if (
          activeTrip?.status === "draft"
          && isTripConfirmationText(content)
          && await services.tripPlanning.lastAssistantAskedForPlanConsent(user.id)
        ) {
          await services.trips.action(user.id, activeTrip.id, {
            type: "track",
            expectedVersion: activeTrip.version
          });
          return { kind: "trip_confirmation_accepted" as const };
        }
        return null;
      }
      );
      if (reply) {
        if (reply.kind === "trip_confirmation_accepted") {
          const summary = await services.tripPlanning.activeTripsLocation(user.id);
          if (summary) {
            const delivered = await postTelegramDashboardMessage(ctx, summary, user.id);
            await services.platformStore.appendMessage(user.id, "assistant", delivered.storedText, new Date());
          }
          return null;
        }
        await postTripPlanResult(ctx, user.id, reply.result, {
          acknowledgeVoice: voiceTranscript !== null,
          languageInput: content
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
          await services.auth.createLoginLink(user.id, "/trip"),
          user.id
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
      await postTelegramAssistantMessage(ctx.telegram, PROCESSING_FAILURE_TEXT, null, user.id);
      return null;
    }

    if (voiceTranscript !== null) {
      promoteVoiceTranscriptToTelegramTurn(message, voiceTranscript);
    }
    rememberTurnContent(String(telegramChatId), content, String(messageId));
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
    if (isCaptainArchivedMode()) {
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Captain is closed and no longer accepts trip changes."
      });
      await ctx.telegram.post(CAPTAIN_ARCHIVED_TELEGRAM_MESSAGE);
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
      await answerLocalizedCallback(ctx, user.id, query.id, "Captain access is suspended.");
      return;
    }
    await services.platformStore.disableOnboardingFollowups(
      user.id,
      "telegram_callback",
      new Date()
    );
    try {
      if (action.type === "start") {
        await answerLocalizedCallback(ctx, user.id, query.id, "Setting it up…");
        const result = await services.tripPlanning.confirm(
          user.id,
          action.draftId,
          action.revision
        );
        await clearCallbackButtons(ctx, query);
        await postTripPlanResult(ctx, user.id, result);
        return;
      }
      if (action.type === "confirm") {
        await answerLocalizedCallback(ctx, user.id, query.id, "Confirming plan…");
        const trip = await services.trips.get(user.id, action.tripId);
        if (!trip) throw new Error("Trip not found");
        await services.trips.action(user.id, action.tripId, {
          type: "track",
          // Review may have renamed or edited the draft. Confirm the latest
          // reviewed version; the store still makes this transition atomic.
          expectedVersion: trip.status === "draft" ? trip.version : action.version
        });
        await clearCallbackButtons(ctx, query);
        // Tracking writes an immediate, durable acknowledgement to the
        // notification outbox. Let that be the one confirmation message;
        // reconstructing the itinerary here produced a second, conflicting
        // summary before the worker's acknowledgement arrived.
        return;
      }
      if (action.type === "edit") {
        await services.tripPlanning.reopen(user.id, action.draftId, action.revision);
        await answerLocalizedCallback(ctx, user.id, query.id, "Tell me what to change.");
        await clearCallbackButtons(ctx, query);
        const message = "What should I change in this trip?";
        const delivered = await postTelegramAssistantMessage(ctx.telegram, message, null, user.id);
        await services.platformStore.appendMessage(user.id, "assistant", delivered.storedText, new Date());
        return;
      }
      const result = await services.tripPlanning.cancel(
        user.id,
        action.draftId,
        action.revision
      );
      await answerLocalizedCallback(ctx, user.id, query.id, "Draft dropped.");
      await clearCallbackButtons(ctx, query);
      await postTripPlanResult(ctx, user.id, result);
    } catch (error) {
      if (error instanceof TripLimitError) {
        await answerLocalizedCallback(ctx, user.id, query.id, "One-trip limit reached.");
        await postWithLink(
          ctx,
          "You already have an active trip. Send the new itinerary and I’ll ask whether you want to replace the current one.",
          "Open trip",
          await services.auth.createLoginLink(user.id, "/trip"),
          user.id
        );
        return;
      }
      console.error(JSON.stringify({
        event: "captain.telegram_trip_plan_callback_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      await answerLocalizedCallback(
        ctx,
        user.id,
        query.id,
        "That trip draft changed. Please review the latest message."
      );
    }
  },
  events: {
    async "turn.started"(data, channel, ctx) {
      await channel.telegram.startTyping();
      const chatId = channel.telegram.chatId;
      const said = pendingTurnContent.get(chatId);
      pendingTurnContent.delete(chatId);
      const userId = captainSessionUserId(ctx.session.auth);
      if (said && userId) turnLanguageInputs.set(data.turnId, { userId, content: said.content });
      const stages = said ? captainPlanningStages(said.content, said.key) : null;
      agentProgress.start({
        sessionId: ctx.session.id,
        chatId,
        turnId: data.turnId,
        // Something is said within half a second of every turn, before Captain
        // knows anything — an acknowledgement, not a claim about the work.
        ...(stages ? { opening: stages.opening } : {}),
        holdingLines: CAPTAIN_HOLDING_STATUS,
        ...telegramProgressCallbacks(channel.telegram, chatId, userId),
        onTyping: () => channel.telegram.startTyping()
      });
    },
    async "actions.requested"(data, channel, ctx) {
      await channel.telegram.startTyping();
      const toolNames = toolNamesFromActions(data.actions as never);
      const label = statusTextForToolNames(toolNames, CAPTAIN_TOOL_STATUS);
      // Tools without a traveller-facing step keep the typing indicator only.
      if (!label) return;
      const waitsOnAirlines = toolNames.some((name) => CAPTAIN_PROVIDER_TOOLS.has(name));
      await agentProgress.setStatus(
        ctx.session.id,
        data.turnId,
        label,
        waitsOnAirlines ? CAPTAIN_PROVIDER_HOLDING_STATUS : CAPTAIN_HOLDING_STATUS
      );
    },
    /**
     * A failed tool used to leave no trace anywhere Captain's operators could
     * see — the model got the error and decided alone what to do with it. This
     * cannot rewrite what the model reads (that is each tool's own job), but
     * it does mean a failure is visible afterwards.
     */
    async "action.result"(data, _channel, ctx) {
      const result = data as unknown as {
        error?: { code?: string; message?: string };
        toolName?: string;
      };
      if (!result.error) return;
      console.error(JSON.stringify({
        event: "captain.tool_call_failed",
        session_id: ctx.session.id,
        tool: result.toolName ?? "unknown",
        code: result.error.code ?? "unknown"
      }));
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
        await recoverUndeliveredTripConfirmation(
          channel.telegram,
          captainSessionAuthAttributes(ctx.session.auth)
        );
      }
      const userId = captainSessionUserId(ctx.session.auth);
      for (const request of otherRequests) {
        if (
          isSessionLimitContinuationRequest(request)
          || looksLikeSessionBudgetPrompt(request.prompt)
        ) {
          continue;
        }
        const raw = renderTelegramInputRequest(request as never, channel.state);
        const rendered = userId ? await localizeTelegramInputRequest(userId, raw) : raw;
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
      if (!data.message) return;
      // Captain is told to leave a response before going off to do a job.
      // This used to throw exactly that message away, so the instruction was
      // unfollowable: a turn that reached for a tool said nothing until the
      // tool came back. It is delivered as its own message, and the status
      // line stays up because the work is still running.
      if (data.finishReason === "tool-calls") {
        const preface = reviewCaptainMessage(data.message).trim();
        const userId = captainSessionUserId(ctx.session.auth);
        if (!preface || !userId) return;
        // A plan is never a preface, whatever state the draft is in. This used
        // to be checked only against an awaiting draft, so the step that
        // created the trip could narrate the plan on its way past — the same
        // itinerary the traveller had just been shown for Create/Cancel.
        if (isTripPlanRestatement(preface)
          || looksLikeTripPlanConfirmation(preface)
          || looksLikeTripSaveOffer(preface)) {
          return;
        }
        // One only. A turn that reaches for four tools should not narrate all
        // four — "I've tried six different phrasings" is what that reads like.
        if (!claimTurnPreface(ctx.session.turn.id)) return;
        if (!claimTurnMessage(ctx.session.turn.id, preface)) return;
        const services = await getCaptainServices();
        // A claim about a trip belongs to the end of the turn too, where it is
        // checked against what was saved.
        const draft = await services.tripPlanning.findOpen(userId);
        if (draft?.status === "awaiting_confirmation") return;
        if (preface !== await services.tripPlanning.groundAssistantMessage(userId, preface)
          .then((grounded) => grounded.message)) {
          return;
        }
        const delivered = await postTelegramAssistantMessage(channel.telegram, preface, null, userId);
        await services.platformStore.appendMessage(userId, "assistant", delivered.storedText, new Date());
        return;
      }
      await clearAgentProgress(ctx.session.id);
      const userId = captainSessionUserId(ctx.session.auth);
      let message = data.message;
      let reviewTrip: Trip | null = null;
      if (userId) {
        const services = await getCaptainServices();
        const grounded = await services.tripPlanning.groundAssistantMessage(userId, message);
        const verbatim = await services.tripPlanning.enforceVerbatimPlanText(
          userId,
          grounded.message
        );
        message = reviewCaptainMessage(verbatim);
        // Both checks read the message as it would be sent, after verbatim
        // enforcement: that step replaces a bulleted paraphrase with the
        // canonical plan text, so it can put the card wording in a message that
        // did not arrive carrying it.
        //
        // Create/Cancel is not a step any more — a finished plan is saved and
        // sent as its Confirm/Review receipt — so this wording offers a tap that
        // exists nowhere. Unless the receipt is in the same message, where the
        // receipt is the point and dropping it would take the trip link with it.
        if (looksLikeTripPlanConfirmation(message) && !looksLikeTripCreationReceipt(message)) {
          console.info(JSON.stringify({
            event: "captain.telegram_stale_trip_confirmation_suppressed",
            turn_id: ctx.session.turn.id
          }));
          return;
        }
        // Checked before the store keeps it: a plan the traveller has already
        // read this turn must not reach them again, and must not land in the
        // conversation history as a confirmation Captain delivered.
        if (!claimTurnPlanRestatement(ctx.session.turn.id, message)) {
          console.info(JSON.stringify({
            event: "captain.telegram_repeated_plan_restatement_suppressed",
            turn_id: ctx.session.turn.id
          }));
          return;
        }
        const activeTrip = await services.platformStore.getActiveTrip(userId);
        if (activeTrip?.status === "draft" && grounded.createdTrip) {
          reviewTrip = activeTrip;
        }
      }
      // Receipt and /trip-style replies carry dashboard URLs in the body. Always
      // lift those into buttons — a plain post leaves "Open trip: https://…"
      // visible and skips Confirm/Review when the createdTrip gate misses.
      if (!claimTurnMessage(ctx.session.turn.id, message.trim())) return;
      const delivered = await postTelegramAssistantMessage(channel.telegram, message, reviewTrip, userId);
      if (userId) {
        const services = await getCaptainServices();
        await services.platformStore.appendMessage(userId, "assistant", delivered.storedText, new Date());
        const input = turnLanguageInputs.get(ctx.session.turn.id);
        if (input) {
          void learnLanguageAfterDelivery(input.userId, input.content, delivered.visibleText);
        }
      }
    },
    async "turn.completed"(_data, channel, ctx) {
      clearPrepareTripTurn(ctx.session.id, ctx.session.turn.id);
      turnMessagesSent.delete(ctx.session.turn.id);
      turnPlansSent.delete(ctx.session.turn.id);
      turnsWithPreface.delete(ctx.session.turn.id);
      turnLanguageInputs.delete(ctx.session.turn.id);
      await clearAgentProgress(ctx.session.id);
    },
    async "turn.failed"(_data, channel, ctx) {
      clearPrepareTripTurn(ctx.session.id, ctx.session.turn.id);
      turnMessagesSent.delete(ctx.session.turn.id);
      turnPlansSent.delete(ctx.session.turn.id);
      turnsWithPreface.delete(ctx.session.turn.id);
      turnLanguageInputs.delete(ctx.session.turn.id);
      await clearAgentProgress(ctx.session.id);
      const userId = captainSessionUserId(ctx.session.auth);
      await postTelegramAssistantMessage(channel.telegram, PROCESSING_FAILURE_TEXT, null, userId);
    }
  }
});

export async function replyIfCaptainArchived(
  telegram: { post(message: string): Promise<unknown> },
  source: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!isCaptainArchivedMode(source)) return false;
  await telegram.post(CAPTAIN_ARCHIVED_TELEGRAM_MESSAGE);
  return true;
}

async function postNewUserOnboarding(
  ctx: TelegramContext,
  userId: string
): Promise<void> {
  const services = await getCaptainServices();
  const remember = (text: string) =>
    services.platformStore.appendMessage(userId, "assistant", text, new Date());

  // The caller already completed onboarding by claiming the welcome step. The
  // remaining orientation is scheduled and only survives while they are idle.
  const greeting = captainNewUserGreeting(userId);
  await ctx.telegram.post(greeting);
  await remember(greeting);
}

async function postWithLink(
  telegramOrCtx: TelegramContext | Pick<TelegramContext["telegram"], "post">,
  text: string,
  label: string,
  url: string,
  userId?: string
): Promise<void> {
  const telegram = "telegram" in telegramOrCtx ? telegramOrCtx.telegram : telegramOrCtx;
  if (userId) {
    const services = await getCaptainServices();
    const profile = await services.platformStore.ensureProfile(userId, new Date());
    if (profile.preferredLanguageSource !== "default") {
      [text, label] = await Promise.all([
        services.language.localize(text, profile.preferredLanguage),
        services.language.localize(label, profile.preferredLanguage)
      ]);
    }
  }
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

type CaptainSessionAuth = {
  readonly current: {
    readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  } | null;
  readonly initiator: {
    readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  } | null;
};

/**
 * Eve's Telegram HITL callback deliberately has no current auth because the
 * callback is framework-generated rather than sent by the traveller. The
 * original authenticated caller remains the session initiator, so every
 * post-continuation operation must fall back to it instead of treating the
 * resumed turn as anonymous.
 */
export function captainSessionUserId(auth: CaptainSessionAuth): string | null {
  return authUserId(auth.current?.attributes.captain_user_id)
    ?? authUserId(auth.initiator?.attributes.captain_user_id);
}

function captainSessionAuthAttributes(
  auth: CaptainSessionAuth
): Readonly<Record<string, string | readonly string[]>> | undefined {
  return auth.current?.attributes ?? auth.initiator?.attributes;
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

async function transcribeVoice(
  input: { fileId: string; size?: number },
  userId: string
): Promise<string> {
  if (input.size !== undefined && input.size > MAX_VOICE_BYTES) throw new Error("Voice note is too large");
  const file = await getTelegramFile({ credentials, fileId: input.fileId });
  const response = await downloadTelegramFile({ credentials, filePath: file.filePath });
  if (!response.ok) throw new Error("Telegram audio download failed");
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0 || audio.byteLength > MAX_VOICE_BYTES) throw new Error("Voice note has an invalid size");
  try {
    const services = await getCaptainServices();
    const model = services.env.transcriptionModel;
    const result = await transcribe({
      model,
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
    });
    await services.usage.recordGatewayGeneration({
      userId,
      operation: "voice_transcription",
      model,
      providerMetadata: result.providerMetadata
    });
    return result.text.trim();
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
  planResult: TripPlanResult,
  options: { acknowledgeVoice?: boolean; languageInput?: string } = {}
): Promise<void> {
  const services = await getCaptainServices();
  // A finished plan is saved and sent as its Confirm/Review receipt. Chat used
  // to get a Create/Cancel card first, which asked for the same consent one
  // message earlier on a plan nothing had saved — so the traveller read the
  // itinerary twice and confirmed it twice.
  const result = planResult.status === "awaiting_confirmation"
    ? await services.tripPlanning.saveReviewableDraft(userId, planResult)
    : planResult;
  // Nothing about the trip changed, so there is nothing for the channel to
  // announce. The agent answers the question the traveller actually asked.
  if (result.status === "no_trip_change") return;
  // A prompt the service built from more than one turn is sent as more than one
  // message: a question bundled under a dozen dated bullets is where it is
  // least likely to be read and answered.
  let parts = result.status === "needs_input"
    ? [...(result.promptParts ?? [result.prompt])]
    // `invalid_legs` never reaches a channel: only the agent sends structured
    // legs, and it is told to fix the named field rather than relay this.
    : result.status === "invalid_legs"
      ? result.errors.map((error) => error.message)
      : [result.message];
  if (result.status === "needs_input" && options.acknowledgeVoice) {
    // The voice acknowledgement belongs on the first thing Captain says, not
    // on whichever part happens to carry the question.
    parts[0] = acknowledgeVoiceClarification(parts[0]!);
  }
  parts = parts.map(reviewCaptainMessage);
  const deliveredParts: string[] = [];
  for (const part of parts) {
    const reviewTrip = result.status === "started" && result.receipt.status === "draft"
      ? { id: result.receipt.tripId, version: result.receipt.version, status: result.receipt.status }
      : null;
    const delivered = await postTelegramAssistantMessage(ctx.telegram, part, reviewTrip, userId);
    deliveredParts.push(delivered.visibleText);
    await services.platformStore.appendMessage(userId, "assistant", delivered.storedText, new Date());
  }
  if (options.languageInput && deliveredParts.length > 0) {
    void learnLanguageAfterDelivery(userId, options.languageInput, deliveredParts.join("\n\n"));
  }
}

export function acknowledgeVoiceClarification(prompt: string): string {
  return `I understood your voice note as a trip request. ${prompt}`;
}

/**
 * A plan left unsaved because a session-limit interrupt ate the turn that would
 * have saved it. Delivered as the receipt the turn owed the traveller — the
 * draft is theirs either way, and leaving it unsaved is how a planned trip
 * disappears between two sessions.
 */
async function recoverUndeliveredTripConfirmation(
  telegram: Pick<TelegramContext["telegram"], "post">,
  attributes: Record<string, unknown> | undefined
): Promise<void> {
  const userId = authUserId(attributes?.captain_user_id);
  if (!userId) return;
  const services = await getCaptainServices();
  const draft = await services.tripPlanning.findOpen(userId);
  if (draft?.status !== "awaiting_confirmation" || !draft.confirmationSnapshot) return;
  const started = await services.tripPlanning.saveReviewableDraft(userId, {
    status: "awaiting_confirmation",
    draft,
    confirmation: formatTripPlanConfirmation(draft)
  });
  const delivered = await postTelegramAssistantMessage(
    telegram,
    started.message,
    started.receipt.status === "draft"
      ? { id: started.receipt.tripId, version: started.receipt.version, status: started.receipt.status }
      : null,
    userId
  );
  await services.platformStore.appendMessage(userId, "assistant", delivered.storedText, new Date());
}

export function tripPlanReviewReplyMarkup(
  receipt: Pick<TripCreationReceipt, "tripId" | "dashboardUrl" | "status" | "version">
) {
  return {
    inline_keyboard: [[{
      text: "Confirm",
      callback_data: `captain-trip:confirm:${receipt.tripId}:${receipt.version}`
    }, {
      text: "Review",
      url: receipt.dashboardUrl
    }]]
  };
}

async function postTelegramDashboardMessage(
  ctx: TelegramContext,
  message: string,
  userId?: string
): Promise<DeliveredTelegramMessage> {
  return postTelegramAssistantMessage(ctx.telegram, message, null, userId);
}

type DeliveredTelegramMessage = { visibleText: string; storedText: string };

async function postTelegramAssistantMessage(
  telegram: Pick<TelegramContext["telegram"], "post">,
  message: string,
  reviewTrip: Pick<Trip, "id" | "version" | "status"> | null,
  userId?: string | null
): Promise<DeliveredTelegramMessage> {
  const rendered = renderTelegramAssistantMessage(message, reviewTrip);
  const localized = userId ? await localizeRenderedTelegramMessage(userId, rendered) : rendered;
  if (!localized.replyMarkup) {
    await telegram.post(localized.text);
    return { visibleText: localized.text, storedText: localized.text };
  }
  await telegram.post({
    text: localized.text,
    link_preview_options: { is_disabled: true },
    reply_markup: localized.replyMarkup
  });
  const links = telegramDashboardMessage(message).links;
  return {
    visibleText: localized.text,
    storedText: links.length > 0
      ? `${localized.text}\n\n${links.map((link) => `Open trip: ${link.url}`).join("\n")}`
      : localized.text
  };
}

async function localizeRenderedTelegramMessage(
  userId: string,
  rendered: ReturnType<typeof renderTelegramAssistantMessage>
): Promise<ReturnType<typeof renderTelegramAssistantMessage>> {
  const services = await getCaptainServices();
  const profile = await services.platformStore.ensureProfile(userId, new Date());
  if (profile.preferredLanguageSource === "default") return rendered;
  const text = await services.language.localize(rendered.text, profile.preferredLanguage);
  if (!rendered.replyMarkup) return { text, replyMarkup: null };
  const inline_keyboard = await Promise.all(rendered.replyMarkup.inline_keyboard.map(async (row) =>
    Promise.all(row.map(async (button) => ({
      ...button,
      text: await services.language.localize(button.text, profile.preferredLanguage)
    })))
  ));
  return { text, replyMarkup: { inline_keyboard } } as ReturnType<typeof renderTelegramAssistantMessage>;
}

async function localizeTelegramInputRequest(
  userId: string,
  rendered: ReturnType<typeof renderTelegramInputRequest>
): Promise<ReturnType<typeof renderTelegramInputRequest>> {
  const services = await getCaptainServices();
  const profile = await services.platformStore.ensureProfile(userId, new Date());
  if (profile.preferredLanguageSource === "default") return rendered;
  const localize = (text: string) => services.language.localize(text, profile.preferredLanguage);
  const text = await localize(rendered.text);
  if (!rendered.replyMarkup) return { ...rendered, text };
  const replyMarkup: Record<string, unknown> = { ...rendered.replyMarkup };
  const keyboard = rendered.replyMarkup.inline_keyboard;
  if (Array.isArray(keyboard)) {
    replyMarkup.inline_keyboard = await Promise.all(keyboard.map(async (row) => {
      if (!Array.isArray(row)) return row;
      return Promise.all(row.map(async (button) => {
        if (!button || typeof button !== "object" || Array.isArray(button)) return button;
        const record = button as Record<string, unknown>;
        return typeof record.text === "string"
          ? { ...record, text: await localize(record.text) }
          : record;
      }));
    }));
  }
  if (typeof rendered.replyMarkup.input_field_placeholder === "string") {
    replyMarkup.input_field_placeholder = await localize(
      rendered.replyMarkup.input_field_placeholder
    );
  }
  return { ...rendered, text, replyMarkup };
}

async function learnLanguageAfterDelivery(
  userId: string,
  userText: string,
  assistantText: string
): Promise<void> {
  try {
    const services = await getCaptainServices();
    const result = await learnLanguageFromDeliveredExchange({
      userId,
      userText,
      assistantText,
      store: services.platformStore,
      detectMatchingLanguage: (user, assistant) =>
        services.language.detectMatchingLanguage(user, assistant)
    });
    if (result.claimed && result.language) {
      console.info(JSON.stringify({
        event: "captain.preferred_language_detected",
        user_id: userId,
        language: result.language
      }));
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: "captain.preferred_language_learning_failed",
      error: error instanceof Error ? error.name : "UnknownError"
    }));
  }
}

/**
 * Turns dashboard URLs embedded in assistant copy into Telegram buttons.
 * Draft creation receipts get Confirm + Review; everything else with an
 * Open-trip link gets a URL button and the raw link is stripped from the text.
 */
export function renderTelegramAssistantMessage(
  message: string,
  reviewTrip: Pick<Trip, "id" | "version" | "status"> | null
): {
  text: string;
  replyMarkup: ReturnType<typeof tripPlanReviewReplyMarkup> | {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  } | null;
} {
  const rendered = telegramDashboardMessage(message);
  if (rendered.links.length === 0) {
    return { text: message, replyMarkup: null };
  }
  const dashboardUrl = rendered.links[0]!.url;
  if (reviewTrip?.status === "draft") {
    return {
      text: rendered.text,
      replyMarkup: tripPlanReviewReplyMarkup({
        tripId: reviewTrip.id,
        version: reviewTrip.version,
        status: reviewTrip.status,
        dashboardUrl
      })
    };
  }
  return {
    text: rendered.text,
    replyMarkup: {
      inline_keyboard: rendered.links.map((link) => [{ text: link.text, url: link.url }])
    }
  };
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
  userId: string,
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
    ...telegramProgressCallbacks(ctx.telegram, String(chatId), userId),
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
  chatId: string,
  userId?: string | null
) {
  return {
    onShow: async (statusText: string) => {
      try {
        const posted = await telegram.post(
          userId ? await localizeTextForUser(userId, statusText) : statusText
        );
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
          text: userId ? await localizeTextForUser(userId, statusText) : statusText
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

async function localizeTextForUser(userId: string, text: string): Promise<string> {
  const services = await getCaptainServices();
  const profile = await services.platformStore.ensureProfile(userId, new Date());
  return profile.preferredLanguageSource === "default"
    ? text
    : services.language.localize(text, profile.preferredLanguage);
}

async function answerLocalizedCallback(
  ctx: TelegramContext,
  userId: string,
  callbackQueryId: string,
  text: string
): Promise<void> {
  await ctx.telegram.answerCallbackQuery({
    callbackQueryId,
    text: await localizeTextForUser(userId, text)
  });
}

async function clearAgentProgress(sessionId: string): Promise<void> {
  await agentProgress.clear(sessionId);
}

export function parseTripPlanCallback(data: string | undefined): {
  type: "start" | "edit" | "cancel";
  draftId: string;
  revision: number;
} | {
  type: "confirm";
  tripId: string;
  version: number;
} | null {
  const confirm = /^captain-trip:confirm:([0-9a-f-]{36}):(\d+)$/u.exec(data ?? "");
  if (confirm) {
    const version = Number(confirm[2]);
    return Number.isSafeInteger(version) && version > 0
      ? { type: "confirm", tripId: confirm[1]!, version }
      : null;
  }
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
