import {
  DisabledCaptainResearchClient,
  HttpCaptainResearchClient
} from "../bridge/captain-client.js";
import { MemoryCaptainPlatformStore, PostgresCaptainPlatformStore, type CaptainPlatformStore } from "@agents/flight-store";
import { FlightAgentRunner } from "../domain/runner.js";
import { FlightAgentService } from "../domain/service.js";
import { DuffelClient } from "../flights/duffel-client.js";
import { MemoryFlightAgentStore } from "../store/memory-store.js";
import { PostgresFlightAgentStore } from "../store/postgres-store.js";
import type { FlightAgentStore } from "../store/contracts.js";
import { loadEnv, type FlightAgentEnv } from "./env.js";
import { TripService } from "../trips/service.js";

export type FlightAgentServices = {
  env: FlightAgentEnv;
  store: FlightAgentStore;
  agents: FlightAgentService;
  platformStore: CaptainPlatformStore;
  trips: TripService;
};

let servicesPromise: Promise<FlightAgentServices> | undefined;

export function getFlightAgentServices(): Promise<FlightAgentServices> {
  servicesPromise ??= createFlightAgentServices().catch((error) => {
    servicesPromise = undefined;
    throw error;
  });
  return servicesPromise;
}

export async function createFlightAgentServices(): Promise<FlightAgentServices> {
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
  const research = env.captainBaseUrl && env.flightAgentToCaptainSecret
    ? new HttpCaptainResearchClient({
        baseUrl: env.captainBaseUrl,
        secret: env.flightAgentToCaptainSecret
      })
    : new DisabledCaptainResearchClient();
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
