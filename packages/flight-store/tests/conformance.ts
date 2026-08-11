import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSearchSpecs, type CreateTripInput } from "@agents/flight-domain";
import type { CaptainPlatformStore } from "../src/index.js";

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

    it("carries a rolling summary and how far it consumed", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const now = new Date("2026-08-01T12:00:00Z");
      const first = await store.appendMessage(ada.id, "user", "Lagos to London", now);
      await store.appendMessage(ada.id, "assistant", "When would you fly?", now);

      // Never written before this: the column defaulted to '' and the agent's
      // injected context always read "No summary yet."
      await expect(store.getConversation(ada.id, 0)).resolves.toMatchObject({
        summary: "",
        summaryUpdatedAt: null,
        summaryThroughMessageId: null
      });

      const summarisedAt = new Date("2026-08-01T12:05:00Z");
      await store.setConversationSummary(
        ada.id,
        "Traveller is planning Lagos to London.",
        first,
        summarisedAt
      );

      await expect(store.getConversation(ada.id, 0)).resolves.toMatchObject({
        summary: "Traveller is planning Lagos to London.",
        summaryUpdatedAt: summarisedAt.toISOString(),
        summaryThroughMessageId: first
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

    it("materializes an ordered city and flight-leg graph without scheduling a Watch", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const input: CreateTripInput = {
        title: "London, Nairobi and Entebbe",
        brief: {
          ...tripInput.brief,
          originAirports: ["LHR"],
          destinationAirports: ["EBB"],
          tripType: "multi_city",
          departureWindow: { start: "2026-11-03", end: "2026-11-03" },
          legs: [
            {
              originAirports: ["LHR"],
              destinationAirports: ["NBO"],
              departureWindow: { start: "2026-11-03", end: "2026-11-03" },
              arriveBy: "2026-11-04"
            },
            {
              originAirports: ["NBO"],
              destinationAirports: ["EBB"],
              departureWindow: { start: "2026-11-15", end: "2026-11-18" },
              arriveBy: "2026-11-19"
            }
          ]
        }
      };
      const created = await store.createTrip(
        ada.id,
        input,
        buildSearchSpecs(input.brief),
        new Date("2026-08-01T12:00:00Z")
      );

      expect(created).toMatchObject({ watch: null, created: true, trip: { status: "draft" } });
      expect(await store.getTripGraph(ada.id, created.trip.id)).toMatchObject({
        cities: [
          { position: 0, label: "London", airportCodes: ["LHR"], departureWindow: { start: "2026-11-03", end: "2026-11-03" } },
          {
            position: 1,
            label: "Nairobi",
            airportCodes: ["NBO"],
            arrivalWindow: { start: "2026-11-04", end: "2026-11-04" },
            departureWindow: { start: "2026-11-15", end: "2026-11-18" }
          },
          {
            position: 2,
            label: "Entebbe",
            airportCodes: ["EBB"],
            arrivalWindow: { start: "2026-11-19", end: "2026-11-19" },
            departureWindow: null
          }
        ],
        legs: [
          {
            position: 0,
            departureWindow: { start: "2026-11-03", end: "2026-11-03" },
            arriveBy: "2026-11-04"
          },
          {
            position: 1,
            departureWindow: { start: "2026-11-15", end: "2026-11-18" },
            arriveBy: "2026-11-19"
          }
        ]
      });
      await expect(store.getWatch(ada.id, created.trip.id)).resolves.toBeNull();
      await expect(store.scheduleDueSearchRuns(new Date("2026-08-01T12:00:00Z"), 0, 100))
        .resolves.toBe(0);
    });

    it("persists optimistic leg-search snapshots and canonical flight selections", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const grace = await user(store, 2);
      const created = await store.createTrip(
        ada.id,
        tripInput,
        buildSearchSpecs(tripInput.brief),
        new Date("2026-08-01T12:00:00Z")
      );
      const leg = (await store.getTripGraph(ada.id, created.trip.id)).legs[0]!;
      const snapshot = await store.createLegSearchSnapshot(
        ada.id,
        created.trip.id,
        leg.id,
        { start: "2026-09-10", end: "2026-09-10" },
        ["2026-09-10"],
        new Date("2026-08-01T12:01:00Z")
      );
      const flight = {
        key: "BA982-LHR-BER-20260910",
        origin: "LHR",
        destination: "BER",
        departureDate: "2026-09-10",
        segments: [{
          origin: "LHR",
          destination: "BER",
          departure: "2026-09-10T09:00:00Z",
          arrival: "2026-09-10T11:00:00Z",
          marketingAirlineCode: "BA",
          marketingAirline: "British Airways",
          flightNumber: "BA982"
        }],
        primaryAirlineCode: "BA",
        participatingAirlineCodes: ["BA"],
        stops: 0,
        durationMinutes: 120
      };
      const revised = await store.reviseLegSearchSnapshot(
        ada.id,
        snapshot.id,
        1,
        {
          status: "completed",
          analysis: {
            complete: true,
            datesRequested: ["2026-09-10"],
            datesCompleted: ["2026-09-10"],
            failedDates: [],
            optionsChecked: 1,
            cheapest: {
              flightKey: flight.key, departureDate: "2026-09-10", priceAmount: "100",
              currency: "GBP", durationMinutes: 120, stops: 0
            },
            fastest: {
              flightKey: flight.key, departureDate: "2026-09-10", priceAmount: "100",
              currency: "GBP", durationMinutes: 120, stops: 0
            },
            balanced: {
              flightKey: flight.key, departureDate: "2026-09-10", priceAmount: "100",
              currency: "GBP", durationMinutes: 120, stops: 0
            },
            cheapestByDate: [{
              flightKey: flight.key, departureDate: "2026-09-10", priceAmount: "100",
              currency: "GBP", durationMinutes: 120, stops: 0
            }],
            observedAt: "2026-08-01T12:02:00Z"
          },
          flights: [flight],
          offers: [{
            offerId: "off_1",
            flightKey: flight.key,
            provider: "official_duffel",
            priceAmount: "100",
            currency: "GBP",
            evidence: [{ url: "https://ba.com/flight", title: "Verified fare", domain: "ba.com" }],
            observedAt: "2026-08-01T12:02:00Z",
            expiresAt: "2026-08-01T12:32:00Z"
          }],
          completedAt: "2026-08-01T12:02:00Z"
        },
        new Date("2026-08-01T12:02:00Z")
      );

      expect(revised).toMatchObject({ revision: 2, status: "completed" });
      await expect(store.getCanonicalFlight(
        flight.key,
        new Date("2026-08-01T12:10:00Z")
      )).resolves.toMatchObject({
        flight: { key: flight.key },
        offers: [{ offerId: "off_1", priceAmount: "100" }]
      });
      await expect(store.getCanonicalFlight(
        flight.key,
        new Date("2026-08-01T12:33:00Z")
      )).resolves.toMatchObject({ flight: { key: flight.key }, offers: [] });
      await expect(store.reviseLegSearchSnapshot(
        ada.id,
        snapshot.id,
        1,
        revised!,
        new Date("2026-08-01T12:03:00Z")
      )).resolves.toBeNull();
      await expect(store.getLegSearchSnapshot(grace.id, snapshot.id)).resolves.toBeNull();
      await expect(store.setTripLegFlight(
        ada.id,
        created.trip.id,
        leg.id,
        flight.key,
        "person",
        new Date("2026-08-01T12:04:00Z")
      )).resolves.toMatchObject({ selectedFlightKey: flight.key });
      await expect(store.listTripActivity(ada.id, created.trip.id)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "trip_leg_flight_selected",
            payload: expect.objectContaining({
              legId: leg.id,
              flightKey: flight.key,
              selectedBy: "person",
              previousFlightKey: null,
              flight: expect.objectContaining({
                airlineCode: "BA",
                flightNumber: "BA982",
                departureDate: "2026-09-10",
                stops: 0,
                priceAmount: "100",
                currency: "GBP"
              }),
              previousFlight: null
            })
          })
        ])
      );
      const otherFlight = {
        ...flight,
        key: "LH100-LHR-BER-20260910",
        primaryAirlineCode: "LH",
        participatingAirlineCodes: ["LH"],
        segments: [{
          ...flight.segments[0]!,
          marketingAirlineCode: "LH",
          marketingAirline: "Lufthansa",
          flightNumber: "LH100"
        }],
        stops: 1,
        durationMinutes: 180
      };
      await store.reviseLegSearchSnapshot(
        ada.id,
        snapshot.id,
        2,
        {
          status: "completed",
          analysis: {
            complete: true,
            datesRequested: ["2026-09-10"],
            datesCompleted: ["2026-09-10"],
            failedDates: [],
            optionsChecked: 2,
            cheapest: {
              flightKey: otherFlight.key, departureDate: "2026-09-10", priceAmount: "90",
              currency: "GBP", durationMinutes: 180, stops: 1
            },
            fastest: {
              flightKey: flight.key, departureDate: "2026-09-10", priceAmount: "100",
              currency: "GBP", durationMinutes: 120, stops: 0
            },
            balanced: {
              flightKey: flight.key, departureDate: "2026-09-10", priceAmount: "100",
              currency: "GBP", durationMinutes: 120, stops: 0
            },
            cheapestByDate: [{
              flightKey: otherFlight.key, departureDate: "2026-09-10", priceAmount: "90",
              currency: "GBP", durationMinutes: 180, stops: 1
            }],
            observedAt: "2026-08-01T12:04:30Z"
          },
          flights: [flight, otherFlight],
          offers: [{
            offerId: "off_1",
            flightKey: flight.key,
            provider: "official_duffel",
            priceAmount: "100",
            currency: "GBP",
            evidence: [{ url: "https://ba.com/flight", title: "Verified fare", domain: "ba.com" }],
            observedAt: "2026-08-01T12:02:00Z",
            expiresAt: "2026-08-01T12:32:00Z"
          }, {
            offerId: "off_2",
            flightKey: otherFlight.key,
            provider: "official_duffel",
            priceAmount: "90",
            currency: "GBP",
            evidence: [{ url: "https://lh.com/flight", title: "Verified fare", domain: "lh.com" }],
            observedAt: "2026-08-01T12:04:30Z",
            expiresAt: "2026-08-01T12:34:30Z"
          }],
          completedAt: "2026-08-01T12:04:30Z"
        },
        new Date("2026-08-01T12:04:30Z")
      );
      await expect(store.setTripLegFlight(
        ada.id,
        created.trip.id,
        leg.id,
        otherFlight.key,
        "agent",
        new Date("2026-08-01T12:04:45Z")
      )).resolves.toMatchObject({ selectedFlightKey: otherFlight.key });
      await expect(store.listTripActivity(ada.id, created.trip.id)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "trip_leg_flight_selected",
            payload: expect.objectContaining({
              legId: leg.id,
              flightKey: otherFlight.key,
              selectedBy: "agent",
              previousFlightKey: flight.key,
              flight: expect.objectContaining({
                airlineCode: "LH",
                flightNumber: "LH100",
                stops: 1,
                priceAmount: "90",
                currency: "GBP"
              }),
              previousFlight: expect.objectContaining({
                airlineCode: "BA",
                flightNumber: "BA982",
                priceAmount: "100",
                currency: "GBP"
              })
            })
          })
        ])
      );
      await expect(store.setTripLegFlight(
        ada.id,
        created.trip.id,
        leg.id,
        null,
        "person",
        new Date("2026-08-01T12:05:00Z")
      )).resolves.toMatchObject({ selectedFlightKey: null });
      await expect(store.listTripActivity(ada.id, created.trip.id)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: "trip_leg_flight_selected" }),
          expect.objectContaining({ eventType: "trip_leg_flight_unselected" })
        ])
      );
    });

    it("archives a replaced trip, clears its active pointer, and retires legacy work", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const created = await store.createTrip(
        ada.id,
        tripInput,
        buildSearchSpecs(tripInput.brief),
        new Date("2026-08-01T12:00:00Z")
      );

      await expect(store.archiveTripForReplacement(
        ada.id,
        created.trip.id,
        new Date("2026-08-01T12:05:00Z")
      )).resolves.toMatchObject({
        status: "archived",
        version: 2,
        archiveReason: "replaced",
        archivedAt: "2026-08-01T12:05:00.000Z"
      });
      await expect(store.getActiveTrip(ada.id)).resolves.toBeNull();
      await expect(store.getConversation(ada.id)).resolves.toMatchObject({ activeTripId: null });
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
      // Onboarding asks nothing, so claiming the greeting finishes it outright.
      await expect(store.getProfile(ada.id)).resolves.toMatchObject({
        onboardingStep: "complete",
        onboardingCompletedAt: now.toISOString()
      });
      // A traveller who has finished onboarding is never greeted again.
      await store.updateProfile(
        ada.id,
        { onboardingStep: "welcome", onboardingCompletedAt: now.toISOString() },
        now
      );
      await expect(store.claimOnboardingWelcome(ada.id, now)).resolves.toBe(false);
    });

    it("leases the staggered onboarding follow-ups only when each stage is due", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const startedAt = new Date("2026-08-01T10:00:00Z");
      await store.updateProfile(ada.id, { quietHoursEnabled: false }, startedAt);
      await expect(store.claimOnboardingWelcome(ada.id, startedAt)).resolves.toBe(true);

      await expect(store.claimDueOnboardingFollowups(
        new Date("2026-08-01T15:59:59Z"),
        300_000,
        10
      )).resolves.toEqual([]);
      const [capabilities] = await store.claimDueOnboardingFollowups(
        new Date("2026-08-01T16:00:00Z"),
        300_000,
        10
      );
      expect(capabilities).toMatchObject({
        userId: ada.id,
        telegramChatId: 1,
        stage: "capabilities",
        attempts: 1
      });
      await expect(store.revalidateOnboardingFollowup(
        ada.id,
        "capabilities",
        new Date("2026-08-01T16:00:00Z")
      )).resolves.toBe(true);
      await store.markOnboardingFollowupSent(
        ada.id,
        "capabilities",
        101,
        "Capabilities",
        new Date("2026-08-01T16:00:00Z")
      );
      await expect(store.claimDueOnboardingFollowups(
        new Date("2026-08-02T10:00:00Z"),
        300_000,
        10
      )).resolves.toEqual([expect.objectContaining({ stage: "workspace" })]);
    });

    it("moves onboarding follow-ups out of the traveller's quiet hours", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const startedAt = new Date("2026-08-01T16:00:00Z");
      await store.updateProfile(ada.id, {
        quietHoursEnabled: true,
        quietHoursStart: 22,
        quietHoursEnd: 7
      }, startedAt);
      await store.claimOnboardingWelcome(ada.id, startedAt);

      await expect(store.claimDueOnboardingFollowups(
        new Date("2026-08-02T06:59:59Z"),
        300_000,
        10
      )).resolves.toEqual([]);
      await expect(store.claimDueOnboardingFollowups(
        new Date("2026-08-02T07:00:00Z"),
        300_000,
        10
      )).resolves.toEqual([expect.objectContaining({ stage: "capabilities" })]);
    });

    it("deterministically suppresses follow-ups after the traveller self-onboards", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const startedAt = new Date("2026-08-01T10:00:00Z");
      await store.updateProfile(ada.id, { quietHoursEnabled: false }, startedAt);
      await store.appendMessage(ada.id, "user", "/start", new Date("2026-08-01T09:59:59Z"));
      await store.claimOnboardingWelcome(ada.id, startedAt);
      await store.appendMessage(ada.id, "user", "Lagos in September", new Date("2026-08-01T10:05:00Z"));

      await expect(store.claimDueOnboardingFollowups(
        new Date("2026-08-04T10:00:00Z"),
        300_000,
        10
      )).resolves.toEqual([]);
      await expect(store.revalidateOnboardingFollowup(
        ada.id,
        "capabilities",
        new Date("2026-08-04T10:00:00Z")
      )).resolves.toBe(false);
    });

    it("clears travellers and resets preferences without deleting the account", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const grace = await user(store, 2);
      const now = new Date("2026-08-01T12:00:00Z");
      await store.updateProfile(ada.id, {
        defaultCurrency: "NGN",
        rankingMode: "cheapest",
        preferredAirlineCodes: ["BA"],
        excludedAirlineCodes: ["KL"],
        notificationMode: "off",
        quietHoursEnabled: false,
        onboardingStep: "complete",
        onboardingCompletedAt: now.toISOString()
      }, now);
      const sourceMessageId = await store.appendMessage(ada.id, "user", "Clear this", now);
      await store.recordTravellerFacts(ada.id, [{
        kind: "cabin_preference",
        value: "Business on long haul",
        evidence: "Clear this",
        sourceMessageId
      }], now);
      const draft = await store.createTripPlanDraft(ada.id, "Plan a trip", sourceMessageId, now);
      await store.createTrip(ada.id, tripInput, buildSearchSpecs(tripInput.brief), now);
      await store.createTrip(grace.id, tripInput, buildSearchSpecs(tripInput.brief), now);
      await store.clearTravellerData(ada.id, now);
      const profile = await store.getProfile(ada.id);
      expect(profile).toMatchObject({
        defaultCurrency: "USD",
        rankingMode: "balanced",
        preferredAirlineCodes: [],
        excludedAirlineCodes: [],
        notificationMode: "changes_only",
        quietHoursEnabled: true,
        onboardingStep: "welcome",
        onboardingCompletedAt: null
      });
      await expect(store.getUser(ada.id)).resolves.toMatchObject({ id: ada.id });
      // Clearing takes every trip, not just the tracked one, and the half-typed
      // draft behind it—otherwise the next message would resume the old plan.
      await expect(store.listTrips(ada.id)).resolves.toEqual([]);
      await expect(store.getActiveTrip(ada.id)).resolves.toBeNull();
      await expect(store.getTripPlanDraft(ada.id, draft.id, now)).resolves.toBeNull();
      await expect(store.getConversation(ada.id)).resolves.toMatchObject({
        summary: "",
        // A summary describes the conversation being cleared, so it goes with
        // it — leaving it would carry the old trip into the next one.
        summaryUpdatedAt: null,
        summaryThroughMessageId: null,
        activeTripId: null,
        recentMessages: []
      });
      await expect(store.listTravellerFacts(ada.id)).resolves.toEqual([]);
      // One traveller clearing their own data leaves everyone else's alone.
      await expect(store.listTrips(grace.id)).resolves.toHaveLength(1);
    });

    it("records traveller facts, dismisses them, and refuses to re-learn a dismissed one", async () => {
      const store = await createStore();
      const ada = await user(store, 1);
      const now = new Date("2026-08-01T12:00:00Z");
      const sourceMessageId = await store.appendMessage(
        ada.id,
        "user",
        "I always fly out of Lagos",
        now
      );

      const [recorded] = await store.recordTravellerFacts(ada.id, [{
        kind: "home_airport",
        value: "Usually departs Lagos",
        evidence: "I always fly out of Lagos",
        sourceMessageId
      }], now);
      expect(recorded).toMatchObject({
        kind: "home_airport",
        value: "Usually departs Lagos",
        evidence: "I always fly out of Lagos",
        status: "active"
      });
      await expect(store.listTravellerFacts(ada.id)).resolves.toHaveLength(1);

      await expect(store.dismissTravellerFact(ada.id, recorded!.id, now)).resolves.toBe(true);
      await expect(store.listTravellerFacts(ada.id)).resolves.toEqual([]);

      // A dismissed fact stays dismissed: hearing the same sentence again must
      // not silently undo the traveller's correction.
      await expect(store.recordTravellerFacts(ada.id, [{
        kind: "home_airport",
        value: "Usually departs Lagos",
        evidence: "I always fly out of Lagos",
        sourceMessageId
      }], now)).resolves.toEqual([]);
      await expect(store.listTravellerFacts(ada.id)).resolves.toEqual([]);
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
