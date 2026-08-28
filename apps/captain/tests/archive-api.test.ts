import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ services: null as unknown }));

vi.mock("../services/app/services.js", () => ({
  getCaptainServices: async () => state.services
}));

import apiChannel from "../agent/channels/api.js";

type RouteHandler = (
  request: Request,
  context: { params: Readonly<Record<string, string>> }
) => Promise<Response>;

describe("Captain archived HTTP surface", () => {
  beforeEach(() => {
    vi.stubEnv("CAPTAIN_ARCHIVED_MODE", "true");
    state.services = {
      env: {
        archivedMode: true,
        databaseUrl: "postgresql://captain.invalid/db"
      }
    };
  });

  afterEach(() => vi.unstubAllEnvs());

  it("serves a clear closure page instead of the traveller workspace", async () => {
    const response = await invoke("/trips");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("This journey has ended.");
    expect(body).toContain('href="https://opemipo.com/2026/08/28/agents-09/"');
  });

  it("closes the root and direct index entry points too", async () => {
    const root = await invoke("/");
    const index = await invoke("/:file", {}, { file: "index.html" });
    expect(await root.text()).toContain("This journey has ended.");
    expect(await index.text()).toContain("This journey has ended.");
  });

  it("rejects traveller mutations before authentication or storage", async () => {
    const response = await invoke("/api/me/trip/actions", { method: "POST" });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: "captain_archived",
      closingPostUrl: "https://opemipo.com/2026/08/28/agents-09/"
    });
  });

  it("retires the public canonical-flight API so stale fares are not presented as live", async () => {
    const response = await invoke("/api/flights/:flightKey", {}, { flightKey: "flight-key" });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: "captain_archived" });
  });

  it("keeps readiness available and explicitly reports archived mode", async () => {
    const response = await invoke("/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      storage: "postgres",
      mode: "archived"
    });
  });
});

async function invoke(
  path: string,
  init: RequestInit = {},
  params: Readonly<Record<string, string>> = {}
): Promise<Response> {
  const route = apiChannel.routes.find((candidate) => candidate.path === path);
  if (!route || !("handler" in route)) throw new Error(`Missing route ${path}`);
  const url = new URL(path.replace(/:[^/]+/gu, "value"), "https://captain.example");
  return (route.handler as RouteHandler)(new Request(url, init), { params });
}
