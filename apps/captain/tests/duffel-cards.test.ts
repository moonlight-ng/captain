import { describe, expect, it } from "vitest";

import { DuffelCardsClient, DuffelCardsError } from "../services/payments/duffel-cards.js";

describe("DuffelCardsClient", () => {
  it("creates a component client key with the documented request shape", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DuffelCardsClient({
      accessToken: "duffel_test_token",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({
          data: { component_client_key: "eyJtest" }
        }), { status: 200 });
      }
    });
    await expect(client.createComponentClientKey()).resolves.toBe("eyJtest");
    expect(calls[0]?.url).toBe("https://api.duffel.com/identity/component_client_keys");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer duffel_test_token",
      "duffel-version": "v2"
    });
    expect(calls[0]?.init.body).toBe("{}");
  });

  it("deletes cards on api.duffel.cards and tolerates 404", async () => {
    const urls: string[] = [];
    const client = new DuffelCardsClient({
      accessToken: "duffel_test_token",
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 404 });
      }
    });
    await expect(client.deleteCard("tcd_abc")).resolves.toBeUndefined();
    expect(urls[0]).toBe("https://api.duffel.cards/payments/cards/tcd_abc");
  });

  it("maps 401, 422, and 429 to typed error codes", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [422, "invalid_request"],
      [429, "rate_limited"]
    ] as const) {
      const client = new DuffelCardsClient({
        accessToken: "duffel_test_token",
        fetch: async () => new Response(JSON.stringify({
          errors: [{ message: "nope" }]
        }), status === 429
          ? { status, headers: { "retry-after": "2" } }
          : { status })
      });
      await expect(client.createComponentClientKey()).rejects.toMatchObject({
        name: "DuffelCardsError",
        code
      } satisfies Partial<DuffelCardsError>);
    }
  });

  const live = process.env.DUFFEL_ACCESS_TOKEN?.trim()
    ? describe
    : describe.skip;

  live("live smoke", () => {
    it("mints a component client key against Duffel", async () => {
      const client = new DuffelCardsClient({
        accessToken: process.env.DUFFEL_ACCESS_TOKEN!
      });
      const key = await client.createComponentClientKey();
      expect(key.length).toBeGreaterThan(10);
    });
  });
});
