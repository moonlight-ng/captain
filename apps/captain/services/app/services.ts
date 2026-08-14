import {
  MemoryCaptainAdminStore,
  MemoryCaptainConversationReviewStore,
  MemoryCaptainPlatformStore,
  PostgresCaptainAdminStore,
  PostgresCaptainConversationReviewStore,
  PostgresCaptainPlatformStore,
  type CaptainAdminStore,
  type CaptainPlatformStore
} from "@agents/flight-store";
import { DuffelFlightSearchProvider } from "@agents/provider-duffel";

import { CaptainWebAuth } from "../auth/web-session.js";
import { CaptainAdminAuth } from "../admin/auth.js";
import { CaptainUsageRecorder } from "../admin/usage.js";
import { ResendEmailSender } from "../email/resend.js";
import {
  createConversationMemoryWriter,
  type ConversationMemoryWriter
} from "../agent/conversation-memory.js";
import { LegSearchService } from "../flights/leg-search.js";
import { FlightLookupService } from "../flights/lookup.js";
import {
  DisabledFeedbackBridge,
  HttpTelegramFeedbackBridge,
  type FeedbackBridge
} from "../feedback/telegram-bridge.js";
import { TripPlanningService } from "../trip-planning/service.js";
import { TripService } from "../trips/service.js";
import {
  ConversationDailyReview,
  createConversationReviewNarrator
} from "../review/conversation-daily-review.js";
import { loadEnv, type CaptainEnv } from "./env.js";
import { assertCaptainDatabase } from "./project-guard.js";

export type CaptainServices = {
  env: CaptainEnv;
  platformStore: CaptainPlatformStore;
  adminStore: CaptainAdminStore;
  adminAuth: CaptainAdminAuth;
  usage: CaptainUsageRecorder;
  auth: CaptainWebAuth;
  trips: TripService;
  tripPlanning: TripPlanningService;
  flightLookup: FlightLookupService;
  legSearch: LegSearchService;
  feedback: FeedbackBridge;
  conversationReview: ConversationDailyReview | null;
  /**
   * Updates the rolling conversation summary and durable traveller facts.
   * Fire-and-forget: it must never sit between a traveller and their reply.
   */
  rememberConversation: ConversationMemoryWriter;
};

let servicesPromise: Promise<CaptainServices> | undefined;

export function getCaptainServices(): Promise<CaptainServices> {
  servicesPromise ??= createCaptainServices().catch((error) => {
    servicesPromise = undefined;
    throw error;
  });
  return servicesPromise;
}

export async function createCaptainServices(): Promise<CaptainServices> {
  const env = loadEnv();
  if (env.databaseUrl) await assertCaptainDatabase(env.databaseUrl);
  process.env.CAPTAIN_BETA_USER_LIMIT = String(env.betaUserLimit);
  process.env.CAPTAIN_PUBLIC_BETA_ENABLED = String(env.publicBetaEnabled);
  const platformStore: CaptainPlatformStore = env.databaseUrl
    ? PostgresCaptainPlatformStore.connect(env.databaseUrl, 4, 600)
    : new MemoryCaptainPlatformStore();
  const adminStore: CaptainAdminStore = env.databaseUrl
    ? PostgresCaptainAdminStore.connect(env.databaseUrl, 2)
    : new MemoryCaptainAdminStore();
  const conversationReviewStore = env.databaseUrl
    ? PostgresCaptainConversationReviewStore.connect(env.databaseUrl, 1)
    : new MemoryCaptainConversationReviewStore();
  const adminAuth = new CaptainAdminAuth({
    url: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    allowedEmails: env.adminEmails
  });
  const usage = new CaptainUsageRecorder({
    store: adminStore,
    apiKey: env.aiGatewayApiKey
  });
  const conversationReview = env.conversationReviewEnabled
    && env.resendApiKey
    && env.conversationReviewFrom
    && env.aiGatewayApiKey
    && env.conversationReviewRecipients.length > 0
    ? new ConversationDailyReview({
        store: conversationReviewStore,
        narrate: createConversationReviewNarrator({
          apiKey: env.aiGatewayApiKey,
          model: env.conversationReviewModel,
          recordUsage: (input) => usage.recordGatewayGeneration(input)
        }),
        email: new ResendEmailSender({
          apiKey: env.resendApiKey,
          from: env.conversationReviewFrom,
          recipients: env.conversationReviewRecipients
        }),
        config: {
          timeZone: env.conversationReviewTimeZone,
          recipients: env.conversationReviewRecipients,
          adminBaseUrl: env.publicUrl
        }
      })
    : null;
  const auth = new CaptainWebAuth({
    publicUrl: env.publicUrl,
    secret: env.telegramBotToken ?? "captain-local-design-secret",
    store: platformStore
  });
  const trips = new TripService({ store: platformStore });
  const feedback = env.feedbackBridgeUrl && env.feedbackBridgeSecret
    ? new HttpTelegramFeedbackBridge({
        baseUrl: env.feedbackBridgeUrl,
        secret: env.feedbackBridgeSecret
      })
    : new DisabledFeedbackBridge();
  const flightProvider = env.duffelAccessToken
    ? new DuffelFlightSearchProvider({
        accessToken: env.duffelAccessToken,
        baseUrl: env.duffelBaseUrl,
        timeoutMs: 70_000,
        supplierTimeoutMs: 60_000
      })
    : null;
  return {
    env,
    platformStore,
    adminStore,
    adminAuth,
    usage,
    auth,
    trips,
    feedback,
    conversationReview,
    flightLookup: new FlightLookupService({
      store: platformStore,
      trips,
      provider: flightProvider
    }),
    legSearch: new LegSearchService({
      store: platformStore,
      provider: flightProvider
    }),
    rememberConversation: createConversationMemoryWriter({
      store: platformStore,
      model: env.tripInterpreterModel,
      apiKey: env.aiGatewayApiKey,
      recordUsage: (input) => usage.recordGatewayGeneration(input)
    }),
    tripPlanning: new TripPlanningService({
      store: platformStore,
      trips,
      model: env.tripInterpreterModel,
      apiKey: env.aiGatewayApiKey,
      recordUsage: (input) => usage.recordGatewayGeneration(input),
      dashboardUrlForTrip: (userId, tripId) => {
        const url = new URL(auth.createAccessLink(userId, "/trip"));
        url.pathname = `/trip/${encodeURIComponent(tripId)}`;
        return url.toString();
      }
    })
  };
}
