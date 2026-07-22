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

export type CaptainServices = {
  env: CaptainEnv;
  store: FlightAgentStore;
  agents: FlightAgentService;
  platformStore: CaptainPlatformStore;
  trips: TripService;
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
  return {
    env,
    store,
    agents: new FlightAgentService({ store, runner }),
    platformStore,
    trips: new TripService({ store: platformStore, liveMode: env.duffelLiveMode })
  };
}
