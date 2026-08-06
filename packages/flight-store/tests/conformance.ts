import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { buildSearchSpecs, type CreateTripInput } from "@agents/flight-domain";
import type { CaptainPlatformStore, TripRecommendation } from "../src/index.js";

/**
 * Behaviour every `CaptainPlatformStore` implementation must share.
 *
 * Captain runs on `PostgresCaptainPlatformStore` but almost all of its tests
 * used to run against `MemoryCaptainPlatformStore`, so the two could drift
 * without anything failing. This suite is the contract both must satisfy.
 *
 * `createStore` must return a store with no residual state from earlier tests.
 * It may return a fresh instance each time or reset and reuse one.
 */
export function describeCaptainPlatformStore(
  label: string,
  createStore: () => Promise<CaptainPlatformStore>
): void {
  describe(label, () => {
    afterEach(() => vi.unstubAllEnvs());

    it("activates every new Telegram user", async () => {
      const store = await createStore();
      await expect(user(store, 1)).resolves.toMatchObject({ status: "active", telegramUserId: 1 });
    });

    it("gates every new profile behind the onboarding welcome", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await expect(
        store.ensureProfile(ada.id, new Date("2026-08-01T12:00:00Z"))
      ).resolves.toMatchObject({
        onboardingStep: "welcome",
        onboardingCompletedAt: null,
      });
    });

    it("stores the traveller timezone used by conversational date resolution", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await expect(store.updateUserTimezone(
        ada.id,
        "Africa/Lagos",
        new Date("2026-08-01T12:00:00Z")
      )).resolves.toMatchObject({ timezone: "Africa/Lagos" });
      await expect(store.getUser(ada.id)).resolves.toMatchObject({
        timezone: "Africa/Lagos"
      });
    });

    it("enforces the configured public beta capacity", async () => {
      vi.stubEnv("CAPTAIN_BETA_USER_LIMIT", "1");
      const store = await createStore();
      await user(store, 1);
      await expect(user(store, 2)).rejects.toMatchObject({
        name: "BetaCapacityError",
        limit: 1
      });
    });

    it("keeps new travellers out until the launch gate is explicitly opened", async () => {
      const store = await createStore();
      const existing = await user(store, 1);
      vi.stubEnv("CAPTAIN_PUBLIC_BETA_ENABLED", "false");

      await expect(user(store, 1)).resolves.toMatchObject({ id: existing.id });
      await expect(user(store, 2)).rejects.toMatchObject({
        name: "BetaLaunchGateError"
      });
    });

    it("does not return history when a caller requests structured state only", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await store.appendMessage(ada.id, "user", "Plan a Trip", new Date("2026-08-01T12:00:00Z"));

      await expect(store.getConversation(ada.id, 0)).resolves.toMatchObject({
        recentMessages: []
      });
    });

    it("permits only one concurrently-created open Trip draft per traveller", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const [first, second] = await Promise.all([
        store.createTripPlanDraft(ada.id, "Plan Lagos to New York", null, new Date("2026-08-01T12:00:00Z")),
        store.createTripPlanDraft(ada.id, "Plan Lagos to London", null, new Date("2026-08-01T12:00:00Z"))
      ]);

      expect(second.id).toBe(first.id);
    });

    it("keeps Trips tenant-scoped", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const grace = await user(store, 2);
      const created = await store.createTrip(ada.id, tripInput, buildSearchSpecs(tripInput.brief, false), new Date("2026-08-01T12:00:00Z"));
      expect(await store.getTrip(ada.id, created.trip.id)).not.toBeNull();
      expect(await store.getTrip(grace.id, created.trip.id)).toBeNull();
      expect(await store.listTrips(grace.id)).toEqual([]);
    });

    it("reuses an exact active Trip instead of creating a duplicate", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const specs = buildSearchSpecs(tripInput.brief, false);
      const first = await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      const retried = await store.createTrip(ada.id, { ...tripInput, title: "Same journey" }, specs, new Date("2026-08-01T12:00:01Z"));
      expect(retried.trip.id).toBe(first.trip.id);
      expect(await store.listTrips(ada.id)).toHaveLength(1);
    });

    it("deduplicates one shared search across two users", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const grace = await user(store, 2);
      const specs = buildSearchSpecs(tripInput.brief, false);
      await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      await store.createTrip(grace.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      expect(await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100)).toBe(1);
      const claimed = await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 4);
      expect(claimed).toHaveLength(1);
    });

    it("fans one result out into initial recommendations and notifications", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const specs = buildSearchSpecs(tripInput.brief, false);
      await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
      const run = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
      await store.completeSearchRun("worker-1", run.id, "orq_1", [{
        itineraryKey: "BA982|LHR|BER", provider: "flysoar_mcp", providerOfferId: "off_1",
        providerSearchId: "orq_1", price: 100, currency: "GBP",
        ...verifiedMetadata("100.00", "BA"),
        expiresAt: "2026-08-01T12:30:00Z", observedAt: "2026-08-01T12:00:01Z",
        snapshot: { route: "LHR → BER", airlineCodes: ["BA"], stops: 0, durationSeconds: 7_200, segments: [] }
      }], new Date("2026-08-01T12:00:01Z"));
      expect(await store.evaluateTripsForSearchSpec(run.searchSpecId, new Date("2026-08-01T12:00:02Z"))).toBe(0);
      const trip = (await store.listTrips(ada.id))[0]!;
      const [offer] = await store.listTripOffers(ada.id, trip.id, new Date("2026-08-01T12:00:03Z"));
      await store.setTripFlightSelection(
        ada.id,
        trip.id,
        offer!.itineraryKey,
        true,
        new Date("2026-08-01T12:00:04Z")
      );
      // Newest selection first: the person picked at 12:00:04, the agent
      // recommended at 12:00:01.
      expect(await store.listTripFlightSelections(ada.id, trip.id)).toEqual([
        expect.objectContaining({
          itineraryKey: offer!.itineraryKey,
          selectedBy: "person",
          selectedAt: "2026-08-01T12:00:04.000Z"
        }),
        expect.objectContaining({
          itineraryKey: offer!.itineraryKey,
          selectedBy: "agent",
          selectedAt: "2026-08-01T12:00:01.000Z"
        })
      ]);
      const notifications = await store.listPendingNotifications(new Date("2026-08-01T12:00:03Z"), 10);
      expect(notifications).toHaveLength(0);
    });

    it("recovers an expired lease without duplicating a live claim", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const specs = buildSearchSpecs(tripInput.brief, false);
      await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
      expect(await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1)).toHaveLength(1);
      expect(await store.claimSearchRuns("worker-2", new Date("2026-08-01T12:01:00Z"), 180_000, 1)).toHaveLength(0);
      expect(await store.claimSearchRuns("worker-2", new Date("2026-08-01T12:04:00Z"), 180_000, 1)).toHaveLength(1);
    });

    it("reuses fresh shared results for a newly attached Trip", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const grace = await user(store, 2);
      const specs = buildSearchSpecs(tripInput.brief, false);
      await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
      const run = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
      await store.completeSearchRun("worker-1", run.id, "orq_1", [{
        itineraryKey: "BA982|LHR|BER", provider: "flysoar_mcp", providerOfferId: "off_1",
        providerSearchId: "orq_1", price: 100, currency: "GBP",
        ...verifiedMetadata("100.00", "BA"),
        expiresAt: "2026-08-01T12:30:00Z", observedAt: "2026-08-01T12:00:01Z",
        snapshot: { route: "LHR → BER", airlineCodes: ["BA"], stops: 0, durationSeconds: 7_200, segments: [] }
      }], new Date("2026-08-01T12:00:01Z"));
      await store.evaluateTripsForSearchSpec(run.searchSpecId, new Date("2026-08-01T12:00:02Z"));
      const created = await store.createTrip(grace.id, tripInput, specs, new Date("2026-08-01T12:05:00Z"));
      expect(created.trip.status).toBe("recommended");
      expect(await store.scheduleDueSearchRuns(new Date("2026-08-01T12:05:00Z"), 900_000, 100)).toBe(0);
      const notifications = await store.listPendingNotifications(new Date("2026-08-01T12:05:01Z"), 10);
      expect(notifications.some((notification) => notification.userId === grace.id)).toBe(false);
    });

    it("checks daily and keeps tracking until the day of departure", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const input: CreateTripInput = {
        ...tripInput,
        brief: {
          ...tripInput.brief,
          departureWindow: { start: "2026-09-10", end: "2026-09-19" }
        }
      };
      const created = await store.createTrip(
        ada.id,
        input,
        buildSearchSpecs(input.brief, false),
        new Date("2026-08-01T12:00:00Z")
      );

      expect(await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100)).toBe(1);
      expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
        status: "active",
        trackingStartsAt: null,
        nextCheckAt: "2026-08-02T12:00:00.000Z",
        runEndsAt: "2026-09-10T23:59:59.999Z"
      });
      expect(await store.scheduleDueSearchRuns(new Date("2026-08-02T11:00:00Z"), 0, 100)).toBe(0);
    });

    it("replaces current results, keeps every compact offer, and preserves price-drop context", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await store.updateProfile(ada.id, {
        notificationMode: "changes_only",
        maxAlertsPerDay: 2
      }, new Date("2026-08-01T12:00:00Z"));
      const specs = buildSearchSpecs(tripInput.brief, false);
      const created = await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
      const firstRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
      await store.completeSearchRun(
        "worker-1",
        firstRun.id,
        "orq_1",
        Array.from({ length: 40 }, (_, index) => ({
          itineraryKey: `BA${100 + index}|LHR|BER`,
          provider: "flysoar_mcp" as const,
          providerOfferId: `old_${index}`,
          providerSearchId: "orq_1",
          price: 200 + index,
          currency: "GBP",
          ...verifiedMetadata(`${200 + index}.00`, "BA"),
          expiresAt: "2026-08-02T12:30:00Z",
          observedAt: "2026-08-01T12:00:01Z",
          snapshot: {
            route: "LHR → BER", airlineCodes: ["BA"], flightNumbers: [`BA${100 + index}`],
            stops: 0, durationSeconds: 7_200, segments: [], raw: { oversized: "x".repeat(10_000) }
          }
        })),
        new Date("2026-08-01T12:00:01Z")
      );
      expect(await store.evaluateTripsForSearchSpec(firstRun.searchSpecId, new Date("2026-08-01T12:00:02Z"))).toBe(1);
      const firstOffers = await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-01T12:00:03Z"));
      expect(firstOffers).toHaveLength(40);
      expect(firstOffers.every((offer) => !("raw" in offer.snapshot))).toBe(true);

      await store.scheduleDueSearchRuns(new Date("2026-08-02T12:00:00Z"), 900_000, 100);
      const secondRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-02T12:00:00Z"), 180_000, 1))[0]!;
      await store.completeSearchRun("worker-1", secondRun.id, "orq_2", Array.from({ length: 3 }, (_, index) => ({
        itineraryKey: `BA${100 + index}|LHR|BER`,
        provider: "flysoar_mcp" as const,
        providerOfferId: `new_${index}`,
        providerSearchId: "orq_2",
        price: 100 + index,
        currency: "GBP",
        ...verifiedMetadata(`${100 + index}.00`, "BA"),
        expiresAt: "2026-08-02T12:30:00Z",
        observedAt: "2026-08-02T12:00:01Z",
        snapshot: {
          route: "LHR → BER", airlineCodes: ["BA"], flightNumbers: [`BA${100 + index}`],
          stops: 0, durationSeconds: 7_200, segments: []
        }
      })), new Date("2026-08-02T12:00:01Z"));

      expect(await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-02T12:00:02Z"))).toHaveLength(3);
      expect(await store.evaluateTripsForSearchSpec(secondRun.searchSpecId, new Date("2026-08-02T12:00:03Z"))).toBe(1);
      expect(await store.listPendingNotifications(
        new Date("2026-08-03T08:00:00Z"),
        10
      )).toEqual([
        expect.objectContaining({
          kind: "new_best",
          payload: expect.objectContaining({
            snapshot: expect.objectContaining({ previous: expect.any(Object) })
          })
        })
      ]);
    });

    it("keeps previous offers when a later search returns no verified fares", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const specs = buildSearchSpecs(tripInput.brief, false);
      const created = await store.createTrip(ada.id, tripInput, specs, new Date("2026-08-01T12:00:00Z"));
      await store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 900_000, 100);
      const firstRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-01T12:00:00Z"), 180_000, 1))[0]!;
      await store.completeSearchRun("worker-1", firstRun.id, "orq_1", [{
        itineraryKey: "BA982|LHR|BER",
        provider: "flysoar_mcp",
        providerOfferId: "offer_1",
        providerSearchId: "orq_1",
        price: 199,
        currency: "GBP",
        ...verifiedMetadata("199.00", "BA"),
        expiresAt: "2026-08-02T12:30:00Z",
        observedAt: "2026-08-01T12:00:01Z",
        snapshot: {
          route: "LHR → BER", airlineCodes: ["BA"], flightNumbers: ["BA982"],
          stops: 0, durationSeconds: 7_200, segments: []
        }
      }], new Date("2026-08-01T12:00:01Z"));
      expect(await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-01T12:00:02Z"))).toHaveLength(1);

      await store.scheduleDueSearchRuns(new Date("2026-08-02T12:00:00Z"), 900_000, 100);
      const emptyRun = (await store.claimSearchRuns("worker-1", new Date("2026-08-02T12:00:00Z"), 180_000, 1))[0]!;
      await store.completeSearchRun("worker-1", emptyRun.id, "orq_empty", [], new Date("2026-08-02T12:00:01Z"));

      expect(await store.listTripOffers(ada.id, created.trip.id, new Date("2026-08-02T12:00:02Z"))).toHaveLength(1);
      expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
        delayReason: "No fares were found in the latest check."
      });
    });

    it("caps immediate changes at the default one alert in a rolling 24 hours", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const input: CreateTripInput = {
        ...tripInput,
        brief: {
          ...tripInput.brief,
          tripType: "one_way",
          departureWindow: { start: "2026-08-05", end: "2026-08-05" },
          stayNights: null
        }
      };
      const specs = buildSearchSpecs(input.brief, false);
      const created = await store.createTrip(ada.id, input, specs, new Date("2026-08-01T12:00:00Z"));
      const changes: number[] = [];

      for (const [index, price] of [100, 90, 80, 70].entries()) {
        const now = new Date(Date.parse("2026-08-01T12:00:00Z") + index * 6 * 3_600_000);
        // Checks are scheduled daily, so the extra same-day ones are manual refreshes.
        if (index > 0) {
          await store.applyTripAction(
            ada.id,
            created.trip.id,
            { type: "refresh", expectedVersion: (await store.getTrip(ada.id, created.trip.id))!.version },
            now
          );
        }
        await store.scheduleDueSearchRuns(now, 900_000, 100);
        const run = (await store.claimSearchRuns("worker-1", now, 180_000, 1))[0]!;
        await store.completeSearchRun("worker-1", run.id, `orq_${index}`, [{
          itineraryKey: "BA982|LHR|BER",
          provider: "flysoar_mcp",
          providerOfferId: `offer_${index}`,
          providerSearchId: `orq_${index}`,
          price,
          currency: "GBP",
          ...verifiedMetadata(`${price}.00`, "BA"),
          expiresAt: null,
          observedAt: now.toISOString(),
          snapshot: {
            route: "LHR → BER",
            airlineCodes: ["BA"],
            flightNumbers: ["BA982"],
            stops: 0,
            durationSeconds: 7_200,
            segments: []
          }
        }], now);
        changes.push(await store.evaluateTripsForSearchSpec(run.searchSpecId, now));
      }

      expect(changes).toEqual([0, 1, 0, 0]);
      expect(await store.listPendingNotifications(
        new Date("2026-08-01T22:00:00Z"),
        10
      )).toHaveLength(1);
    });

    it("tracks every new trip through to the day it departs", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      // One trip per traveller, so the distant departure needs its own owner.
      const grace = await user(store, 2);
      const now = new Date("2026-08-01T00:00:00Z");
      const boundary = inputFor("Berlin", "BER", "2026-08-31");
      const distant = inputFor("Paris", "CDG", "2026-09-01");

      const active = await store.createTrip(
        ada.id,
        boundary,
        buildSearchSpecs(boundary.brief, false),
        now
      );
      const future = await store.createTrip(
        grace.id,
        distant,
        buildSearchSpecs(distant.brief, false),
        now
      );

      expect(active.watch).toMatchObject({
        status: "active",
        trackingStartsAt: null,
        runEndsAt: "2026-08-31T23:59:59.999Z"
      });
      expect(future.watch).toMatchObject({
        status: "active",
        trackingStartsAt: null,
        runEndsAt: "2026-09-01T23:59:59.999Z"
      });
    });

    it("starts a fresh run when Track follows a departed trip", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const now = new Date("2026-08-01T12:00:00Z");
      const trip = inputFor("Berlin", "BER", "2026-09-10");
      const specs = buildSearchSpecs(trip.brief, false);
      const created = await store.createTrip(ada.id, trip, specs, now);
      // Nothing completes while the departure is still ahead.
      await expect(store.maintainTracking(new Date("2026-08-04T12:00:00Z")))
        .resolves.toEqual({ activated: 0, completed: 0 });
      await expect(store.maintainTracking(new Date("2026-09-11T12:00:00Z")))
        .resolves.toEqual({ activated: 0, completed: 1 });
      const completed = (await store.getTrip(ada.id, created.trip.id))!;
      const restarted = await store.applyTripAction(
        ada.id,
        created.trip.id,
        { type: "track", expectedVersion: completed.version },
        new Date("2026-09-11T12:00:00Z")
      );
      expect(restarted.status).toBe("tracking");
      expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
        status: "active",
        runStartedAt: "2026-09-11T12:00:00.000Z",
        // The departure is behind us, so the restarted run earns a single check.
        runEndsAt: "2026-09-12T12:00:00.000Z",
        completedAt: null,
        checksCompleted: 0,
        nextCheckAt: "2026-09-11T12:00:00.000Z"
      });
    });

    it("completes a run once and queues its decision summary", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await store.updateProfile(ada.id, {
        notificationMode: "smart",
        quietHoursEnabled: false
      }, new Date("2026-08-01T12:00:00Z"));
      const input = inputFor("Berlin", "BER", "2026-09-10");
      const specs = buildSearchSpecs(input.brief, false);
      const created = await store.createTrip(
        ada.id,
        input,
        specs,
        new Date("2026-08-01T12:00:00Z")
      );
      await expect(store.maintainTracking(new Date("2026-09-11T12:00:00Z"))).resolves.toEqual({
        activated: 0,
        completed: 1
      });
      expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
        status: "completed",
        completedAt: "2026-09-11T12:00:00.000Z",
        nextCheckAt: null
      });
      expect(await store.getTrip(ada.id, created.trip.id)).toMatchObject({ status: "recommended" });
      expect(await store.listPendingNotifications(
        new Date("2026-09-11T12:00:01Z"),
        10
      )).toEqual([expect.objectContaining({ kind: "tracking_summary" })]);
      await expect(store.maintainTracking(new Date("2026-09-11T12:02:00Z"))).resolves.toEqual({
        activated: 0,
        completed: 0
      });
    });

    it("digests the one active Trip and leaves a cancelled one out", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const now = new Date("2026-08-01T12:00:00Z");
      await store.updateProfile(ada.id, {
        notificationMode: "daily",
        digestHourLocal: 9,
        quietHoursEnabled: false
      }, now);
      // A traveller tracks one trip at a time, so the earlier trip has to be
      // cancelled before the next one can start.
      for (const [index, destination] of ["BER", "CDG"].entries()) {
        const input = inputFor(destination, destination, "2026-08-20");
        const specs = buildSearchSpecs(input.brief, false);
        const created = await store.createTrip(ada.id, input, specs, now);
        await runSearch(
          store,
          specs[0]!.id,
          new Date(now.getTime() + index * 1_000),
          `${destination}100|LHR|${destination}`,
          100 + index * 25,
          destination
        );
        if (destination === "BER") {
          await store.applyTripAction(
            ada.id,
            created.trip.id,
            {
              type: "cancel",
              expectedVersion: (await store.getTrip(ada.id, created.trip.id))!.version
            },
            now
          );
        }
      }

      expect(await store.enqueueDueDigests(new Date("2026-08-01T12:05:00Z"))).toBe(1);
      const notifications = await store.listPendingNotifications(
        new Date("2026-08-01T12:05:00Z"),
        10
      );
      expect(notifications).toEqual([
        expect.objectContaining({
          kind: "daily_digest",
          payload: expect.objectContaining({
            trips: [expect.objectContaining({ tripTitle: "CDG" })]
          })
        })
      ]);
      expect((notifications[0]!.payload.trips as unknown[])).toHaveLength(1);
    });

    it("carries a meaningful improvement into the digest after a later unchanged check", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await store.updateProfile(ada.id, {
        notificationMode: "daily",
        digestHourLocal: 9,
        quietHoursEnabled: false
      }, new Date("2026-08-01T00:00:00Z"));
      const input = inputFor("Berlin", "BER", "2026-08-20");
      const specs = buildSearchSpecs(input.brief, false);
      await store.createTrip(ada.id, input, specs, new Date("2026-08-01T00:00:00Z"));
      await runSearch(store, specs[0]!.id, new Date("2026-08-01T00:00:00Z"), "BA982|LHR|BER", 200, "BER");
      await runSearch(store, specs[0]!.id, new Date("2026-08-02T00:00:00Z"), "BA982|LHR|BER", 150, "BER");
      await runSearch(store, specs[0]!.id, new Date("2026-08-03T00:00:00Z"), "BA982|LHR|BER", 150, "BER");

      expect(await store.enqueueDueDigests(new Date("2026-08-03T12:05:00Z"))).toBe(1);
      const [digest] = await store.listPendingNotifications(
        new Date("2026-08-03T12:05:00Z"),
        10
      );
      // Telegram renders the digest from this shape, so it is part of the
      // contract: the snapshot sits directly on each trip entry.
      const trips = digest!.payload.trips as Array<{
        tripId: string;
        snapshot: TripRecommendation["snapshot"];
      }>;
      expect(trips[0]?.snapshot.pendingDigestChange).toMatchObject({
        current: { price: 150 },
        previous: { price: 200 },
        reasonCodes: ["better_balance"]
      });
      // Sending the digest clears the pending change by removing the key.
      expect((await store.getRecommendation(
        ada.id,
        trips[0]!.tripId
      ))?.snapshot.pendingDigestChange).toBeUndefined();
    });

    it("keeps tracking through a long silence, right up to departure", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await store.updateProfile(ada.id, {
        notificationMode: "smart",
        quietHoursEnabled: false
      }, new Date("2026-08-01T12:00:00Z"));
      const input = inputFor("Berlin", "BER", "2026-11-20");
      const created = await store.createTrip(
        ada.id,
        input,
        buildSearchSpecs(input.brief, false),
        new Date("2026-08-01T12:00:00Z")
      );

      // Months of silence used to trip an inactivity check-in and auto-pause.
      // A trip booked far ahead is exactly the one worth watching that long.
      await expect(store.maintainTracking(new Date("2026-09-15T12:00:00Z")))
        .resolves.toEqual({ activated: 0, completed: 0 });
      expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
        status: "active",
        runEndsAt: "2026-11-20T23:59:59.999Z"
      });
      expect(await store.getTrip(ada.id, created.trip.id)).toMatchObject({ status: "tracking" });
      expect(await store.listPendingNotifications(new Date("2026-09-15T12:00:01Z"), 10))
        .toEqual([]);

      await expect(store.maintainTracking(new Date("2026-11-21T00:00:01Z")))
        .resolves.toEqual({ activated: 0, completed: 1 });
      expect(await store.getTrip(ada.id, created.trip.id)).toMatchObject({ status: "recommended" });
      const pending = await store.listPendingNotifications(
        new Date("2026-11-21T00:00:02Z"),
        10
      );
      expect(pending.map((notification) => notification.kind)).toEqual(["tracking_summary"]);
    });

    it("rearms a price-rise warning only after the fare recovers", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      await store.updateProfile(ada.id, {
        notificationMode: "changes_only",
        maxAlertsPerDay: 2,
        betterOptionAlertsEnabled: false,
        quietHoursEnabled: false
      }, new Date("2026-08-01T00:00:00Z"));
      const input = inputFor("Berlin", "BER", "2026-08-20");
      const specs = buildSearchSpecs(input.brief, false);
      await store.createTrip(ada.id, input, specs, new Date("2026-08-01T00:00:00Z"));
      const changes = [];
      for (const [index, price] of [100, 125, 130, 104, 130].entries()) {
        changes.push(await runSearch(
          store,
          specs[0]!.id,
          new Date(Date.parse("2026-08-01T00:00:00Z") + index * 24 * 3_600_000),
          "BA982|LHR|BER",
          price,
          "BER"
        ));
      }
      expect(changes).toEqual([1, 1, 0, 0, 1]);
      const pending = await store.listPendingNotifications(
        new Date("2026-08-06T01:00:00Z"),
        10
      );
      expect(pending.filter((notification) => notification.kind === "price_rise")).toHaveLength(2);
    });

    it("delivers a completed-run summary after quiet hours", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const input = inputFor("Berlin", "BER", "2026-08-20");
      const created = await store.createTrip(
        ada.id,
        input,
        buildSearchSpecs(input.brief, false),
        new Date("2026-08-01T23:00:00Z")
      );

      await store.maintainTracking(new Date("2026-08-21T00:00:01Z"));
      expect(await store.getWatch(ada.id, created.trip.id)).toMatchObject({
        status: "completed",
        completedAt: "2026-08-21T00:00:01.000Z"
      });
      expect(await store.listPendingNotifications(
        new Date("2026-08-21T06:59:59Z"),
        10
      )).toHaveLength(0);
      expect(await store.listPendingNotifications(
        new Date("2026-08-21T07:00:01Z"),
        10
      )).toEqual([expect.objectContaining({ kind: "tracking_summary" })]);
    });

    it("reduces the former five-message sequence to two useful Trip updates", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const start = new Date("2026-08-01T00:00:00Z");
      await store.updateProfile(ada.id, {
        notificationMode: "changes_only",
        maxAlertsPerDay: 2,
        quietHoursEnabled: false
      }, start);

      const firstInput = inputFor("Berlin", "BER", "2026-08-20");
      const firstSpecs = buildSearchSpecs(firstInput.brief, false);
      const first = await store.createTrip(ada.id, firstInput, firstSpecs, start);
      await runSearch(store, firstSpecs[0]!.id, start, "BA982|LHR|BER", 100, "BER");
      expect(await store.enqueueInventoryGapForSearchSpec(firstSpecs[0]!.id, start)).toBe(0);
      // Cancelling frees the traveller's single trip slot; pausing does not.
      await store.applyTripAction(
        ada.id,
        first.trip.id,
        { type: "cancel", expectedVersion: (await store.getTrip(ada.id, first.trip.id))!.version },
        new Date("2026-08-01T00:01:00Z")
      );

      const secondInput = inputFor("Paris", "CDG", "2026-08-20");
      const secondSpecs = buildSearchSpecs(secondInput.brief, false);
      await store.createTrip(
        ada.id,
        secondInput,
        secondSpecs,
        new Date("2026-08-01T00:02:00Z")
      );
      await runSearch(
        store,
        secondSpecs[0]!.id,
        new Date("2026-08-01T00:02:00Z"),
        "BA304|LHR|CDG",
        200,
        "CDG"
      );
      expect(await store.enqueueInventoryGapForSearchSpec(secondSpecs[0]!.id, start)).toBe(0);
      await runSearch(
        store,
        secondSpecs[0]!.id,
        new Date("2026-08-02T00:02:00Z"),
        "BA304|LHR|CDG",
        150,
        "CDG"
      );

      const pending = await store.listPendingNotifications(
        new Date("2026-08-02T00:03:00Z"),
        10
      );
      expect(pending).toHaveLength(2);
      expect(pending.map((notification) => notification.kind).sort()).toEqual([
        "initial_results",
        "new_best"
      ]);
    });
    it("hands the welcome greeting to one caller only", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const now = new Date("2026-08-01T13:00:00Z");
      await expect(store.ensureProfile(ada.id, now)).resolves.toMatchObject({
        onboardingStep: "welcome"
      });
      const results = await Promise.all([
        store.claimOnboardingWelcome(ada.id, now),
        store.claimOnboardingWelcome(ada.id, now),
        store.claimOnboardingWelcome(ada.id, now)
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await expect(store.getProfile(ada.id)).resolves.toMatchObject({
        onboardingStep: "currency"
      });
      // A traveller who has finished onboarding is never greeted again.
      await store.updateProfile(
        ada.id,
        { onboardingStep: "welcome", onboardingCompletedAt: now.toISOString() },
        now
      );
      await expect(store.claimOnboardingWelcome(ada.id, now)).resolves.toBe(false);
    });

    it("clears travellers and resets preferences without deleting the account", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const now = new Date("2026-08-01T12:00:00Z");
      await store.updateProfile(ada.id, {
        defaultCurrency: "NGN",
        rankingMode: "cheapest",
        preferredAirlineCodes: ["BA"],
        excludedAirlineCodes: ["KL"],
        notificationMode: "off",
        quietHoursEnabled: false
      }, now);
      await store.createTrip(ada.id, tripInput, buildSearchSpecs(tripInput.brief), now);
      await store.clearTravellerData(ada.id, now);
      const profile = await store.getProfile(ada.id);
      expect(profile).toMatchObject({
        defaultCurrency: "USD",
        rankingMode: "balanced",
        preferredAirlineCodes: [],
        excludedAirlineCodes: [],
        notificationMode: "smart",
        quietHoursEnabled: true
      });
      await expect(store.getUser(ada.id)).resolves.toMatchObject({ id: ada.id });
      await expect(store.listTrips(ada.id)).resolves.toHaveLength(1);
    });

    it("clears all user-owned data when a user is deleted", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const grace = await user(store, 2);
      const now = new Date("2026-08-01T12:00:00Z");
      const expiresAt = new Date("2026-08-01T13:00:00Z");
      const loginToken = "d".repeat(64);
      const sessionToken = "e".repeat(64);
      await store.ensureProfile(ada.id, now);
      const sourceMessageId = await store.appendMessage(ada.id, "user", "Delete this", now);
      const draft = await store.createTripPlanDraft(ada.id, "Plan a trip", sourceMessageId, now);
      await store.createLoginToken(ada.id, loginToken, "/profile", expiresAt, now);
      await store.createWebSession(ada.id, sessionToken, expiresAt, now);
      await expect(store.claimTelegramUpdate("delete-me", ada.id, now)).resolves.toBe(true);
      await store.createTrip(ada.id, tripInput, buildSearchSpecs(tripInput.brief), now);
      await store.deleteUser(ada.id);
      await expect(store.getProfile(ada.id)).resolves.toBeNull();
      await expect(store.getConversation(ada.id)).rejects.toThrow("Conversation not found");
      await expect(store.listTrips(ada.id)).resolves.toEqual([]);
      await expect(store.getTripPlanDraft(ada.id, draft.id, now)).resolves.toBeNull();
      await expect(store.consumeLoginToken(loginToken, now)).resolves.toBeNull();
      await expect(store.resolveWebSession(sessionToken, now)).resolves.toBeNull();
      await expect(store.claimTelegramUpdate("delete-me", grace.id, now)).resolves.toBe(true);
      await expect(store.getUser(ada.id)).resolves.toBeNull();
    });

    it("accepts login tokens for session paths and rejects others at the type boundary", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const now = new Date("2026-08-01T12:00:00Z");
      const expiresAt = new Date("2026-08-01T12:15:00Z");
      await store.createLoginToken(ada.id, "a".repeat(64), "/profile", expiresAt, now);
      await store.createLoginToken(ada.id, "b".repeat(64), "/preferences", expiresAt, now);
      await expect(store.consumeLoginToken("a".repeat(64), now)).resolves.toMatchObject({
        userId: ada.id,
        redirectPath: "/profile"
      });
      await expect(store.consumeLoginToken("b".repeat(64), now)).resolves.toMatchObject({
        redirectPath: "/preferences"
      });
    });
  });
}

const tripInput: CreateTripInput = {
  title: "London to Berlin",
  brief: {
    originAirports: ["LHR"], destinationAirports: ["BER"], tripType: "one_way",
    departureWindow: { start: "2026-09-10", end: "2026-09-10" }, stayNights: null,
    legs: [],
    travellers: { adults: 1, childrenAges: [], infants: 0 }, cabin: "economy",
    maxStops: 1, currency: "GBP", maximumPrice: null,
    preferredAirlines: [], excludedAirlines: [], context: ""
  }
};

async function user(store: CaptainPlatformStore, telegramUserId: number) {
  return store.ensureTelegramUser({
    telegramUserId, telegramChatId: telegramUserId, username: null,
    firstName: `User ${telegramUserId}`, lastName: null
  }, new Date("2026-08-01T12:00:00Z"));
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("operation timed out")), milliseconds);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function inputFor(title: string, destination: string, departure: string): CreateTripInput {
  return {
    ...tripInput,
    title,
    brief: {
      ...tripInput.brief,
      destinationAirports: [destination],
      departureWindow: { start: departure, end: departure }
    }
  };
}

async function runSearch(
  store: CaptainPlatformStore,
  searchSpecId: string,
  now: Date,
  itineraryKey: string,
  price: number,
  destination: string
): Promise<number> {
  await store.scheduleDueSearchRuns(now, 0, 100);
  const run = (await store.claimSearchRuns("worker-test", now, 180_000, 1))[0]!;
  expect(run.searchSpecId).toBe(searchSpecId);
  await store.completeSearchRun("worker-test", run.id, `request-${now.toISOString()}`, [{
    itineraryKey,
    provider: "flysoar_mcp",
    providerOfferId: itineraryKey,
    providerSearchId: `request-${now.toISOString()}`,
    price,
    currency: "GBP",
    ...verifiedMetadata(price.toFixed(2), "BA"),
    expiresAt: null,
    observedAt: now.toISOString(),
    snapshot: {
      route: `LHR → ${destination}`,
      airlineCodes: ["BA"],
      flightNumbers: ["BA982"],
      stops: 0,
      durationSeconds: 7_200,
      segments: []
    }
  }], now);
  return store.evaluateTripsForSearchSpec(searchSpecId, now);
}

function verifiedMetadata(priceAmount: string, airlineCode: string) {
  return {
    priceAmount,
    fareBasis: "one_adult_total" as const,
    primaryAirlineCode: airlineCode,
    participatingAirlineCodes: [airlineCode],
    evidence: [{ url: "https://ba.com/flight", title: "Verified fare", domain: "ba.com" }],
    discoveryResponseId: "resp_discovery",
    verificationResponseId: "resp_verification",
    promptVersion: "test-v1",
    model: "gpt-5.6-sol",
    verifiedAt: "2026-08-01T12:00:01Z"
  };
}
