import {
  MemoryCaptainPlatformStore,
  PostgresCaptainPlatformStore,
  type CaptainPlatformStore
} from "@agents/flight-store";

import { CaptainWebAuth } from "../auth/web-session.js";
import { TripPlanningService } from "../trip-planning/service.js";
import { TripService } from "../trips/service.js";
import { loadEnv, type CaptainEnv } from "./env.js";

export type CaptainServices = {
  env: CaptainEnv;
  platformStore: CaptainPlatformStore;
  auth: CaptainWebAuth;
  trips: TripService;
  tripPlanning: TripPlanningService;
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
  process.env.CAPTAIN_BETA_USER_LIMIT = String(env.betaUserLimit);
  process.env.CAPTAIN_PUBLIC_BETA_ENABLED = String(env.publicBetaEnabled);
  const platformStore: CaptainPlatformStore = env.databaseUrl
    ? PostgresCaptainPlatformStore.connect(env.databaseUrl, 8)
    : new MemoryCaptainPlatformStore();
  const auth = new CaptainWebAuth({
    publicUrl: env.publicUrl,
    secret: env.telegramBotToken ?? "captain-local-design-secret"
  });
  const trips = new TripService({ store: platformStore });
  return {
    env,
    platformStore,
    auth,
    trips,
    tripPlanning: new TripPlanningService({
      store: platformStore,
      trips,
      model: env.tripInterpreterModel,
      apiKey: env.aiGatewayApiKey,
      dashboardUrlForTrip: (userId, tripId) => {
        const url = new URL(auth.createAccessLink(userId, "/trip"));
        url.searchParams.set("trip", tripId);
        return url.toString();
      }
    })
  };
}
