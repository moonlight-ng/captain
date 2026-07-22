import { describe, expect, it, vi } from "vitest";

import type { CaptainResearchClient } from "../services/bridge/captain-client.js";
import { FlightAgentRunner } from "../services/domain/runner.js";
import { InvalidStateError, type ResearchResult } from "../services/domain/types.js";
import { FlightProviderError, type FlightSearchClient } from "../services/flights/provider.js";
import { MemoryFlightAgentStore } from "../services/store/memory-store.js";
import { defaultTestBrief, testOffer } from "./support.js";

describe("FlightAgentRunner", () => {
  it("records price histories and deterministic notable promotions", async () => {
    const store = new MemoryFlightAgentStore();
    let pass = 0;
    const flights: FlightSearchClient = {
      provider: "duffel",
      async search() {
        pass += 1;
        return {
          provider: "duffel",
          searchId: `search-${pass}`,
          totalResults: 2,
          searchedAt: new Date(1_800_000_000_000 + pass * 1_000).toISOString(),
          offers: [
            testOffer({ price: 100, code: "AA", airline: "Alpha Air", id: `aa-${pass}` }),
            testOffer({ price: pass === 1 ? 130 : 120, code: "BA", airline: "Beta Air", id: `ba-${pass}` })
          ]
        };
      }
    };
    const research: CaptainResearchClient = {
      research: vi.fn(async (): Promise<ResearchResult> => {
        return { status: "completed", searchedAt: new Date().toISOString(), overview: "No material disruptions.", results: [], offers: [], gaps: [], error: null, metadata: { model: "test", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, durationMs: 1 } };
      })
    };
    const runner = new FlightAgentRunner({ store, flights, research });
    await store.createAgent("fa_test", { brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test" }, new Date("2026-08-01T00:00:00Z"));
    await runner.run("fa_test", "initial", true);
    let workspace = await store.getWorkspace("fa_test");
    expect(workspace?.browseFlights).toHaveLength(2);
    expect(workspace?.reviewFlights.map((flight) => flight.marketingAirlineCode)).toEqual(["AA"]);

    await runner.run("fa_test", "manual", true);
    workspace = await store.getWorkspace("fa_test");
    expect(workspace?.browseFlights.every((flight) => flight.observationCount === 2)).toBe(true);
    expect(workspace?.reviewFlights.map((flight) => flight.marketingAirlineCode).sort()).toEqual(["AA", "BA"]);
    const beta = workspace?.browseFlights.find((flight) => flight.marketingAirlineCode === "BA");
    expect(beta?.promotionReason).toContain("Fare dropped");
    expect(beta?.changePercent).toBeLessThan(-5);
    expect(research.research).not.toHaveBeenCalled();

    await runner.run("fa_test", "manual", true, "fare_and_research");
    workspace = await store.getWorkspace("fa_test");
    expect(research.research).toHaveBeenCalledTimes(1);
    expect(workspace?.agent.latestCheck?.mode).toBe("fare_and_research");
    expect(workspace?.agent.latestCheck?.research?.metadata?.model).toBe("test");

    const alpha = workspace?.browseFlights.find((flight) => flight.marketingAirlineCode === "AA");
    const trackingDefaults = await store.applyAction("fa_test", {
      type: "set_tracking_window",
      expectedVersion: workspace!.agent.version,
      trackingWindowDays: 7
    }, new Date("2026-08-01T00:55:00Z"));
    await store.applyAction("fa_test", {
      type: "retain_flight",
      flightKey: alpha!.id,
      expectedVersion: trackingDefaults.version
    }, new Date("2026-08-01T00:56:00Z"));
    workspace = await store.getWorkspace("fa_test");
    expect(workspace?.agent.trackingWindowDays).toBe(7);
    expect(workspace?.browseFlights.find((flight) => flight.id === alpha!.id)?.trackedUntilAt).toBe("2026-08-08T00:56:00.000Z");

    const folder = await store.createFolder("fa_test", "Shortlist", new Date("2026-08-01T01:00:00Z"));
    await store.setFolderMembership("fa_test", folder.id, alpha!.id, true, new Date("2026-08-01T01:01:00Z"));
    await store.applyAction("fa_test", {
      type: "dismiss_flight",
      flightKey: alpha!.id,
      expectedVersion: workspace!.agent.version
    }, new Date("2026-08-01T01:02:00Z"));
    workspace = await store.getWorkspace("fa_test");
    expect(workspace?.browseFlights.find((flight) => flight.id === alpha!.id)?.folderIds).toEqual([]);
    expect(workspace?.folders[0]?.flightCount).toBe(0);
    expect(workspace?.activity.some((item) => item.kind === "folder_member_added")).toBe(true);
  });

  it("rejects runs while paused", async () => {
    const store = new MemoryFlightAgentStore();
    const runner = new FlightAgentRunner({
      store,
      flights: null,
      research: { async research() { throw new Error("unused"); } }
    });
    const agent = await store.createAgent("fa_paused", { brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test" }, new Date());
    await store.applyAction("fa_paused", { type: "pause", expectedVersion: agent.version }, new Date());
    await expect(runner.run("fa_paused", "manual", true)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("uses capped 5/15/60 minute retries and honours longer provider delays", async () => {
    const store = new MemoryFlightAgentStore();
    let now = new Date("2026-08-01T00:00:00Z");
    let attempts = 0;
    const runner = new FlightAgentRunner({
      store,
      now: () => now,
      flights: {
        provider: "duffel",
        async search() {
          attempts += 1;
          throw new FlightProviderError("rate_limited", "Slow down", attempts === 1 ? 20 * 60_000 : undefined);
        }
      },
      research: { async research() { throw new Error("unused"); } }
    });
    await store.createAgent("fa_retry", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
    }, now);

    await runner.run("fa_retry", "initial", true);
    let workspace = await store.getWorkspace("fa_retry");
    expect(workspace?.agent.nextCheckAt).toBe("2026-08-01T00:20:00.000Z");

    now = new Date("2026-08-01T00:20:00Z");
    await runner.run("fa_retry", "retry", true);
    workspace = await store.getWorkspace("fa_retry");
    expect(workspace?.agent.nextCheckAt).toBe("2026-08-01T00:35:00.000Z");

    now = new Date("2026-08-01T00:35:00Z");
    await runner.run("fa_retry", "retry", true);
    workspace = await store.getWorkspace("fa_retry");
    expect(workspace?.agent.nextCheckAt).toBe("2026-08-01T01:35:00.000Z");
    expect(workspace?.agent.status).toBe("needs_attention");
  });

  it("allows only one check at a time and commits fares when research fails", async () => {
    const store = new MemoryFlightAgentStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = new FlightAgentRunner({
      store,
      flights: {
        provider: "duffel",
        async search() {
          await gate;
          return {
            provider: "duffel",
            searchId: "single-run",
            totalResults: 1,
            searchedAt: "2026-08-01T00:00:01Z",
            offers: [testOffer({ price: 500, code: "BA", airline: "British Airways" })]
          };
        }
      },
      research: { async research() { throw new Error("Codex unavailable"); } }
    });
    await store.createAgent("fa_single", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
    }, new Date("2026-08-01T00:00:00Z"));
    const first = runner.run("fa_single", "initial", true, "fare_and_research");
    await expect(runner.run("fa_single", "manual", true)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    const workspace = await store.getWorkspace("fa_single");
    expect(workspace?.agent.latestCheck?.status).toBe("partial");
    expect(workspace?.agent.latestCheck?.sourceRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "duffel", status: "completed" }),
      expect.objectContaining({ source: "codex_web", status: "failed" })
    ]));
    expect(workspace?.browseFlights).toHaveLength(1);
    expect(workspace?.agent.latestCheck?.research?.error).toContain("Codex unavailable");
  });

  it("returns an accepted check id before a cold Duffel check completes", async () => {
    const store = new MemoryFlightAgentStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = new FlightAgentRunner({
      store,
      flights: {
        provider: "duffel",
        async search() {
          await gate;
          return {
            provider: "duffel",
            searchId: "cold-start",
            totalResults: 0,
            searchedAt: "2026-08-01T00:00:01Z",
            offers: []
          };
        }
      },
      research: { async research() { throw new Error("must not run"); } }
    });
    await store.createAgent("fa_cold", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
    }, new Date("2026-08-01T00:00:00Z"));

    const started = await runner.start("fa_cold", "manual", true, "fare");
    expect(started?.checkId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await store.getWorkspace("fa_cold"))?.agent.latestCheck?.status).toBe("running");
    release();
    await started?.completion;
    expect((await store.getWorkspace("fa_cold"))?.agent.latestCheck?.status).toBe("completed");
  });

  it("publishes one representative flexible-date search before backfilling the window", async () => {
    const store = new MemoryFlightAgentStore();
    let now = new Date("2026-07-20T10:00:00Z");
    const search = vi.fn(async () => ({
      provider: "duffel" as const,
      searchId: crypto.randomUUID(),
      totalResults: 1,
      searchedAt: now.toISOString(),
      offers: [testOffer({ price: 500, code: "BA", airline: "British Airways" })]
    }));
    const runner = new FlightAgentRunner({
      store,
      now: () => now,
      flights: { provider: "duffel", search },
      research: { async research() { throw new Error("must not run"); } }
    });
    await store.createAgent("fa_flexible", {
      brief: defaultTestBrief({
        departureWindow: { start: "2026-08-24", end: "2026-08-30" },
        stayNights: { minimum: 4, preferred: 5, maximum: 7 }
      }),
      cadenceHours: 6,
      requestedBy: "test"
    }, now);

    await runner.run("fa_flexible", "initial", true);
    let workspace = await store.getWorkspace("fa_flexible");
    expect(search).toHaveBeenCalledTimes(1);
    expect(workspace?.agent.latestCheck?.matrix).toHaveLength(1);
    expect(workspace?.agent.nextCheckAt).toBe("2026-07-20T10:00:30.000Z");

    now = new Date("2026-07-20T10:00:30Z");
    await runner.run("fa_flexible", "scheduled", false);
    workspace = await store.getWorkspace("fa_flexible");
    expect(search).toHaveBeenCalledTimes(7);
    expect(workspace?.agent.latestCheck?.matrix).toHaveLength(6);
    expect(workspace?.agent.searchCursor).toBe(7);
    expect(workspace?.agent.nextCheckAt).toBe("2026-07-20T10:01:00.000Z");
  });

  it("keeps same-airline departures as distinct canonical itineraries", async () => {
    const store = new MemoryFlightAgentStore();
    const early = testOffer({ price: 500, code: "BA", airline: "British Airways", id: "ba-early" });
    const laterRoute = {
      ...early.outbound,
      segments: early.outbound.segments.map((segment) => ({
        ...segment,
        flightNumber: "BA202",
        departure: "2026-09-01T12:00:00Z",
        arrival: "2026-09-01T20:00:00Z"
      }))
    };
    const later = {
      ...early,
      id: "ba-later",
      price: 520,
      routes: [laterRoute],
      outbound: laterRoute
    };
    const runner = new FlightAgentRunner({
      store,
      flights: {
        provider: "duffel",
        async search() {
          return {
            provider: "duffel",
            searchId: "same-airline",
            totalResults: 2,
            searchedAt: "2026-08-01T00:00:01Z",
            offers: [early, later]
          };
        }
      },
      research: {
        async research() {
          return {
            status: "completed" as const,
            searchedAt: "2026-08-01T00:00:02Z",
            overview: "No additional supported offers.",
            results: [],
            offers: [],
            gaps: [],
            error: null,
            metadata: null
          };
        }
      }
    });
    await store.createAgent("fa_distinct", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
    }, new Date("2026-08-01T00:00:00Z"));
    await runner.run("fa_distinct", "initial", true);

    const workspace = await store.getWorkspace("fa_distinct");
    expect(workspace?.browseFlights).toHaveLength(2);
    expect(new Set(workspace?.browseFlights.map((flight) => flight.itineraryKey)).size).toBe(2);
  });

  it("publishes Duffel first, then merges a cheaper Codex offer into the same itinerary", async () => {
    const store = new MemoryFlightAgentStore();
    let releaseResearch!: () => void;
    const researchGate = new Promise<void>((resolve) => { releaseResearch = resolve; });
    const runner = new FlightAgentRunner({
      store,
      flights: {
        provider: "duffel",
        async search() {
          return {
            provider: "duffel",
            searchId: "parallel-duffel",
            totalResults: 1,
            searchedAt: "2026-08-01T00:00:01Z",
            offers: [testOffer({ price: 500, code: "BA", airline: "British Airways", id: "duffel-ba" })]
          };
        }
      },
      research: {
        async research() {
          await researchGate;
          return {
            status: "completed" as const,
            searchedAt: "2026-08-01T00:05:00Z",
            overview: "Skyscanner showed a cheaper matching itinerary.",
            results: [],
            offers: [{
              sourceName: "Skyscanner",
              sourceUrl: "https://www.skyscanner.net/transport/flights/lhr/jfk/260901/",
              bookingUrl: "https://seller.example/ba117",
              evidence: "direct" as const,
              origin: "LHR",
              destination: "JFK",
              travelDate: "2026-09-01",
              returnDate: "2026-09-08",
              marketingAirlineCode: "BA",
              marketingAirline: "British Airways",
              flightNumber: "BA101",
              route: "LHR → JFK",
              departure: "2026-09-01T10:00:00Z",
              arrival: "2026-09-01T18:00:00Z",
              durationSeconds: 28_800,
              stops: 0,
              cabin: "economy" as const,
              price: 450,
              currency: "GBP",
              passengerCount: 1,
              segments: [{
                airlineCode: "BA",
                airline: "British Airways",
                flightNumber: "BA101",
                origin: "LHR",
                destination: "JFK",
                departure: "2026-09-01T10:00:00Z",
                arrival: "2026-09-01T18:00:00Z"
              }],
              baggage: "Cabin bag included",
              fareConditions: null
            }],
            gaps: [],
            error: null,
            metadata: null
          };
        }
      }
    });
    await store.createAgent("fa_parallel", {
      brief: defaultTestBrief(), cadenceHours: 6, requestedBy: "test"
    }, new Date("2026-08-01T00:00:00Z"));

    const started = await runner.start("fa_parallel", "initial", true, "fare_and_research");
    await vi.waitFor(async () => {
      const workspace = await store.getWorkspace("fa_parallel");
      expect(workspace?.browseFlights).toHaveLength(1);
      expect(workspace?.agent.latestCheck?.status).toBe("running");
      expect(workspace?.agent.latestCheck?.sourceRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "duffel", status: "completed" }),
        expect.objectContaining({ source: "codex_web", status: "running" })
      ]));
    });

    releaseResearch();
    await started?.completion;
    const workspace = await store.getWorkspace("fa_parallel");
    expect(workspace?.browseFlights).toHaveLength(1);
    expect(workspace?.browseFlights[0]?.latest).toMatchObject({
      provider: "codex_web",
      sourceName: "Skyscanner",
      price: 450
    });
    expect(workspace?.agent.latestCheck?.sourceRuns.every((source) => source.status === "completed")).toBe(true);
    const details = await store.getFlightDetails("fa_parallel", workspace!.browseFlights[0]!.id);
    expect(details?.observations.map((observation) => observation.provider).sort()).toEqual(["codex_web", "duffel"]);
  });
});
