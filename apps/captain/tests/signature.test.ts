import { describe, expect, it } from "vitest";

import {
  BridgeReplayGuard,
  signBridgeRequest,
  verifyBridgeRequest
} from "../services/bridge/signature.js";

describe("bridge signatures", () => {
  it("authenticates the timestamp, method, path and body", () => {
    const signed = signBridgeRequest({
      secret: "secret",
      method: "POST",
      path: "/internal/v1/flight-agents",
      body: '{"a":1}',
      timestamp: "1000000"
    });
    expect(verifyBridgeRequest({
      secret: "secret",
      method: "POST",
      path: "/internal/v1/flight-agents",
      body: '{"a":1}',
      timestamp: signed.timestamp,
      signature: signed.signature,
      now: 1_000_100
    })).toBe(true);
    expect(verifyBridgeRequest({
      secret: "secret",
      method: "POST",
      path: "/internal/v1/flight-agents",
      body: '{"a":2}',
      timestamp: signed.timestamp,
      signature: signed.signature,
      now: 1_000_100
    })).toBe(false);
  });

  it("rejects stale signatures", () => {
    const signed = signBridgeRequest({ secret: "secret", method: "GET", path: "/x", body: "", timestamp: "1" });
    expect(verifyBridgeRequest({ secret: "secret", method: "GET", path: "/x", body: "", timestamp: signed.timestamp, signature: signed.signature, now: 600_000 })).toBe(false);
  });

  it("rejects a replay inside the signature window", () => {
    const guard = new BridgeReplayGuard();
    expect(guard.isReplay("signature", 1_000, 1_000)).toBe(false);
    expect(guard.isReplay("signature", 1_000, 1_100)).toBe(true);
    expect(guard.isReplay("signature", 1_000, 301_001)).toBe(false);
  });
});
