import {
  DisabledPilotResearchClient,
  HttpPilotResearchClient
} from "../bridge/pilot-client.js";
import { MemoryCaptainPlatformStore, PostgresCaptainPlatformStore, type CaptainPlatformStore } from "@agents/flight-store";
import { FlightAgentRunner } from "../domain/runner.js";
import { FlightAgentService } from "../domain/service.js";
import { DuffelClient } from "../flights/duffel-client.js";
import { MemoryFlightAgentStore } from "../store/memory-store.js";
import { PostgresFlightAgentStore } from "../store/postgres-store.js";
import type { FlightAgentStore } from "../store/contracts.js";
import { loadEnv, type CaptainEnv } from "./env.js";
import { TripService } from "../trips/service.js";
import { TripPlanningService } from "../trip-planning/service.js";
import { tripDashboardUrl } from "../auth/trip-dashboard-token.js";

export type CaptainServices = {
  env: CaptainEnv;
  store: FlightAgentStore;
  agents: FlightAgentService;
  platformStore: CaptainPlatformStore;
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
  const store: FlightAgentStore = env.databaseUrl
    ? await PostgresFlightAgentStore.connect(env.databaseUrl)
    : new MemoryFlightAgentStore();
  const flights = env.duffelAccessToken
    ? new DuffelClient({
        accessToken: env.duffelAccessToken,
        baseUrl: env.duffelBaseUrl,
        timeoutMs: env.duffelTimeoutMs,
        supplierTimeoutMs: env.duffelSupplierTimeoutMs
      })
    : null;
  const research = env.pilotBaseUrl && env.captainToPilotSecret
    ? new HttpPilotResearchClient({
        baseUrl: env.pilotBaseUrl,
        secret: env.captainToPilotSecret
      })
    : new DisabledPilotResearchClient();
  const runner = new FlightAgentRunner({ store, flights, research });
  const platformStore: CaptainPlatformStore = env.databaseUrl
    ? PostgresCaptainPlatformStore.connect(env.databaseUrl, 8)
    : new MemoryCaptainPlatformStore();
  const trips = new TripService({ store: platformStore, liveMode: env.duffelLiveMode });
  const dashboardUrlForTrip = (userId: string, tripId: string) => tripDashboardUrl({
    publicUrl: env.publicUrl,
    secret: env.captainSessionSecret!,
    userId,
    tripId
  });
  return {
    env,
    store,
    agents: new FlightAgentService({ store, runner }),
    platformStore,
    trips,
    tripPlanning: new TripPlanningService({
      store: platformStore,
      trips,
      liveMode: env.duffelLiveMode,
      model: env.aiModel,
      apiKey: env.aiGatewayApiKey,
      dashboardUrlForTrip
    })
  };
}
