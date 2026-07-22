import { describe, expect, it, vi } from "vitest";

import { toBridgeAgent } from "../agent/channels/api.js";
import { FlightAgentRunner } from "../services/domain/runner.js";
import { MemoryFlightAgentStore } from "../services/store/memory-store.js";
import { defaultTestBrief, testOffer } from "./support.js";

describe("Captain bridge presentation", () => {
  it("returns current total-party price ranges and explicit outcome signals", async () => {
    const store = new MemoryFlightAgentStore();
    const runner = new FlightAgentRunner({
      store,
      flights: {
        provider: "duffel",
        async search() {
          return {
            provider: "duffel",
            searchId: "bridge-search",
            totalResults: 2,
            searchedAt: "2026-08-01T12:00:00Z",
            offers: [
              testOffer({ price: 420, code: "BA", airline: "British Airways" }),
              testOffer({ price: 610, code: "VS", airline: "Virgin Atlantic" })
            ]
          };
        }
      },
      research: { research: vi.fn().mockRejectedValue(new Error("not needed")) }
    });
    await store.createAgent("fa_bridge", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
    }, new Date("2026-08-01T00:00:00Z"));
    await runner.run("fa_bridge", "initial", true);

    let workspace = (await store.getWorkspace("fa_bridge"))!;
    const [first, second] = workspace.browseFlights;
    const retained = await store.applyAction("fa_bridge", {
      type: "retain_flight",
      expectedVersion: workspace.agent.version,
      flightKey: first!.id
    }, new Date("2026-08-01T12:01:00Z"));
    await store.applyAction("fa_bridge", {
      type: "dismiss_flight",
      expectedVersion: retained.version,
      flightKey: second!.id
    }, new Date("2026-08-01T12:02:00Z"));
    workspace = (await store.getWorkspace("fa_bridge"))!;

    const result = toBridgeAgent(workspace, "https://flight.example");
    expect(result.currentPriceRanges).toEqual([{
      currency: "GBP",
      minimum: 420,
      maximum: 610,
      itineraryCount: 2,
      observedAt: "2026-08-01T12:00:00Z",
      passengerCount: 1,
      pricingBasis: "total_party"
    }]);
    expect(result.outcomeSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewState: "retained", price: 420 }),
      expect.objectContaining({ reviewState: "dismissed", price: 610 })
    ]));
    expect(result.workspaceUrl).toBe("https://flight.example/agents/fa_bridge");
  });
});
