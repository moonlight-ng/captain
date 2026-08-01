import { describe, expect, it } from "vitest";

import {
  DuffelCardsClient,
  DuffelCardsError,
  parseRetryAfterMs
} from "../src/cards.js";

describe("parseRetryAfterMs", () => {
  it("parses positive delta-seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2_000);
    expect(parseRetryAfterMs("120")).toBe(120_000);
  });

  it("parses future HTTP-date values", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:30 GMT", now)).toBe(30_000);
  });

  it("returns null for missing, zero, past, or invalid values", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("0")).toBeNull();
    expect(parseRetryAfterMs("-1")).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBeNull();
  });
});

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

  it("deletes cards on api.duffel.cards and treats 404 as success", async () => {
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

  it("maps 401, 422, and 429 to typed error codes including Retry-After", async () => {
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
        code,
        ...(status === 429 ? { retryAfterMs: 2_000 } : {})
      } satisfies Partial<DuffelCardsError>);
    }
  });

  it("ignores invalid Retry-After on 429", async () => {
    const client = new DuffelCardsClient({
      accessToken: "duffel_test_token",
      fetch: async () => new Response(JSON.stringify({
        errors: [{ message: "slow down" }]
      }), { status: 429, headers: { "retry-after": "0" } })
    });
    await expect(client.createComponentClientKey()).rejects.toMatchObject({
      name: "DuffelCardsError",
      code: "rate_limited",
      retryAfterMs: null
    } satisfies Partial<DuffelCardsError>);
  });
});
