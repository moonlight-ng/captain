export type FlightAgentEnv = {
  mode: "development" | "production";
  publicUrl: string;
  databaseUrl: string | null;
  basicUsername: string;
  basicPassword: string | null;
  ownerAuthEnabled: boolean;
  captainBaseUrl: string | null;
  captainToFlightAgentSecret: string | null;
  flightAgentToCaptainSecret: string | null;
  duffelAccessToken: string | null;
  duffelBaseUrl: string;
  duffelTimeoutMs: number;
  duffelSupplierTimeoutMs: number;
};

export function loadEnv(): FlightAgentEnv {
  const mode = process.env.NODE_ENV === "production" ? "production" : "development";
  const env: FlightAgentEnv = {
    mode,
    publicUrl: (process.env.FLIGHT_AGENT_PUBLIC_URL?.trim() || "http://127.0.0.1:4178").replace(/\/$/, ""),
    databaseUrl: optional("DATABASE_URL"),
    basicUsername: process.env.FLIGHT_AGENT_BASIC_USERNAME?.trim() || "flight-agent",
    basicPassword: optional("FLIGHT_AGENT_BASIC_PASSWORD"),
    ownerAuthEnabled: booleanValue("FLIGHT_AGENT_OWNER_AUTH_ENABLED", mode === "production"),
    captainBaseUrl: optional("CAPTAIN_BASE_URL"),
    captainToFlightAgentSecret: optional("CAPTAIN_TO_FLIGHT_AGENT_SECRET"),
    flightAgentToCaptainSecret: optional("FLIGHT_AGENT_TO_CAPTAIN_SECRET"),
    duffelAccessToken: optional("DUFFEL_ACCESS_TOKEN"),
    duffelBaseUrl: (process.env.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/, ""),
    duffelTimeoutMs: positiveInteger("FLIGHT_SEARCH_TIMEOUT_MS", 120_000),
    duffelSupplierTimeoutMs: positiveInteger("DUFFEL_SUPPLIER_TIMEOUT_MS", 20_000)
  };
  if (mode === "production") {
    for (const [name, value] of [
      ["DATABASE_URL", env.databaseUrl],
      ["CAPTAIN_BASE_URL", env.captainBaseUrl],
      ["CAPTAIN_TO_FLIGHT_AGENT_SECRET", env.captainToFlightAgentSecret],
      ["FLIGHT_AGENT_TO_CAPTAIN_SECRET", env.flightAgentToCaptainSecret],
      ["DUFFEL_ACCESS_TOKEN", env.duffelAccessToken]
    ] as const) {
      if (!value) throw new Error(`Missing required production environment variable: ${name}`);
    }
    if (env.ownerAuthEnabled && !env.basicPassword) {
      throw new Error("Missing required production environment variable: FLIGHT_AGENT_BASIC_PASSWORD");
    }
  }
  return env;
}

function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
