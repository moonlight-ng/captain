import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ services: null as unknown }));

vi.mock("../services/app/services.js", () => ({
  getCaptainServices: async () => state.services
}));

import apiChannel from "../agent/channels/api.js";

type RouteHandler = (
  request: Request,
  context: { params: Readonly<Record<string, string>> }
) => Promise<Response>;

describe("Captain administrator API", () => {
  beforeEach(() => {
    state.services = servicesFixture();
  });

  it("keeps public configuration browser-safe and uncacheable", async () => {
    const response = await invoke("/api/admin/config");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      supabaseUrl: "https://captain.supabase.co",
      supabasePublishableKey: "sb_publishable_captain"
    });
  });

  it("returns distinct uncacheable authentication failures", async () => {
    const unauthorized = await invoke("/api/admin/session");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");

    const forbidden = await invoke("/api/admin/session", {
      headers: { authorization: "Bearer forbidden" }
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the verified administrator without transcript data", async () => {
    const response = await invoke("/api/admin/session", authenticated());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      identity: { id: "admin-1", email: "admin@example.com" }
    });
  });

  it("reports the configured model for each production AI path", async () => {
    const response = await invoke("/api/admin/overview", authenticated());
    expect(response.status).toBe(200);
    expect((await response.json() as { models: unknown }).models).toEqual([
      { key: "owner_chat", label: "Owner chat", model: "openai/gpt-5.6-terra" },
      { key: "trip_interpretation", label: "Trip interpretation", model: "openai/gpt-5.6-luna" },
      { key: "trip_update", label: "Trip updates", model: "openai/gpt-5.6-luna" },
      { key: "voice_transcription", label: "Voice transcription", model: "openai/gpt-4o-mini-transcribe" }
    ]);
  });

  it("forwards bounded search pagination and rejects invalid cost ranges", async () => {
    const listConversations = vi.fn(async () => ({ conversations: [], nextCursor: null }));
    (state.services as { adminStore: { listConversations: unknown } }).adminStore.listConversations = listConversations;

    const response = await invoke(
      "/api/admin/conversations",
      authenticated("?query=lagos&limit=999&cursor=next")
    );
    expect(response.status).toBe(200);
    expect(listConversations).toHaveBeenCalledWith({
      query: "lagos",
      cursor: "next",
      limit: 50
    });

    const invalid = await invoke("/api/admin/costs", authenticated("?range=90d"));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(await invalid.json()).toEqual({ error: "invalid_range" });
  });

  it("uses the requested conversation ID and preserves chronological store output", async () => {
    const detail = {
      conversation: { conversationId: "11111111-1111-4111-8111-111111111111" },
      messages: [
        { id: "old", createdAt: "2026-08-09T10:00:00.000Z" },
        { id: "new", createdAt: "2026-08-09T10:01:00.000Z" }
      ],
      sessions: [],
      olderCursor: null
    };
    const getConversation = vi.fn(async () => detail);
    (state.services as { adminStore: { getConversation: unknown } }).adminStore.getConversation = getConversation;
    const id = "11111111-1111-4111-8111-111111111111";
    const response = await invoke(
      "/api/admin/conversations/:conversationId",
      authenticated("?before=older&limit=20"),
      { conversationId: id }
    );

    expect(response.status).toBe(200);
    expect(getConversation).toHaveBeenCalledWith({ conversationId: id, before: "older", limit: 20 });
    expect((await response.json() as typeof detail).messages.map((message) => message.id)).toEqual(["old", "new"]);
  });
});

function servicesFixture() {
  return {
    env: {
      databaseUrl: "postgresql://captain.invalid/db",
      aiModel: "openai/gpt-5.6-terra",
      tripInterpreterModel: "openai/gpt-5.6-luna",
      transcriptionModel: "openai/gpt-4o-mini-transcribe"
    },
    adminAuth: {
      publicConfig: () => ({
        supabaseUrl: "https://captain.supabase.co",
        supabasePublishableKey: "sb_publishable_captain"
      }),
      authenticate: async (request: Request) => {
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (token === "forbidden") return { status: "forbidden" as const };
        if (token !== "allowed") return { status: "unauthorized" as const };
        return {
          status: "authenticated" as const,
          identity: { id: "admin-1", email: "admin@example.com" }
        };
      }
    },
    adminStore: {
      getOverview: async () => ({
        trackingStartedAt: "2026-08-09T10:00:00.000Z",
        lastActivityAt: null,
        activeTurns: 0,
        metrics: {
          users: 0,
          conversations: 0,
          messages24h: 0,
          modelCalls30d: 0,
          costUsd30d: 0,
          unresolvedCostCount: 0
        },
        recentConversations: []
      }),
      listConversations: async () => ({ conversations: [], nextCursor: null }),
      getConversation: async () => null,
      getCosts: async () => ({})
    }
  };
}

async function invoke(
  path: string,
  init: RequestInit & { search?: never } = {},
  params: Readonly<Record<string, string>> = {}
): Promise<Response> {
  const route = apiChannel.routes.find((candidate) => candidate.path === path);
  if (!route || !("handler" in route)) throw new Error(`Missing route ${path}`);
  const url = new URL(path.replace(/:[^/]+/gu, "value"), "https://captain.example");
  const requestPath = typeof init.body === "string" && init.body.startsWith("?") ? init.body : "";
  const requestInit = { ...init };
  delete requestInit.body;
  const request = new Request(`${url}${requestPath}`, requestInit);
  return (route.handler as RouteHandler)(request, { params });
}

function authenticated(search = ""): RequestInit {
  return {
    headers: { authorization: "Bearer allowed" },
    ...(search ? { body: search } : {})
  };
}
