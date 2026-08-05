import { describe, expect, it } from "vitest";

import type { VerifiedOffer } from "../src/domain.js";
import {
  createMockBooking,
  readMockBooking,
  removeMockBooking,
  writeMockBooking,
  type BookingStorage
} from "../src/mock-booking.js";
import { TEST_PAYMENT_METHOD } from "../src/mock-payment.js";

describe("mock booking preview", () => {
  it("creates and persists only local demo state", () => {
    const storage = memoryStorage();
    const booking = createMockBooking(
      "11111111-1111-4111-8111-111111111111",
      offer(),
      new Date("2026-08-04T08:00:00Z")
    );

    expect(booking).toMatchObject({
      status: "confirmed",
      seat: null,
      checkedBags: 0,
      bookedAt: "2026-08-04T08:00:00.000Z",
      traveller: {
        givenName: "Sample",
        familyName: "Traveller",
        email: "sample@example.com",
        phoneNumber: ""
      }
    });
    expect(booking.reference).toMatch(/^CAP-[A-Z0-9]+-[A-Z0-9]+$/u);

    writeMockBooking(booking, storage);
    expect(readMockBooking(booking.tripId, storage)).toEqual(booking);
    removeMockBooking(booking.tripId, storage);
    expect(readMockBooking(booking.tripId, storage)).toBeNull();
  });

  it("rejects malformed or cross-trip stored state", () => {
    const storage = memoryStorage();
    storage.setItem("captain:mock-booking:trip-a", JSON.stringify({ version: 1, tripId: "trip-b" }));
    expect(readMockBooking("trip-a", storage)).toBeNull();
  });

  it("backfills traveller details for older stored bookings", () => {
    const storage = memoryStorage();
    const booking = createMockBooking(
      "11111111-1111-4111-8111-111111111111",
      offer(),
      new Date("2026-08-04T08:00:00Z")
    );
    const { traveller: _traveller, ...legacy } = booking;
    storage.setItem(`captain:mock-booking:${booking.tripId}`, JSON.stringify(legacy));
    expect(readMockBooking(booking.tripId, storage)?.traveller).toEqual({
      givenName: "Sample",
      familyName: "Traveller",
      email: "sample@example.com",
      phoneNumber: ""
    });
  });

  it("uses the permanent display-only test card rather than payment credentials", () => {
    expect(TEST_PAYMENT_METHOD).toEqual({
      id: "test-card",
      brand: "visa",
      last4: "4242",
      cardholderName: "Sample traveller",
      isDefault: true
    });
    expect(Object.keys(TEST_PAYMENT_METHOD)).not.toContain("cardNumber");
    expect(Object.keys(TEST_PAYMENT_METHOD)).not.toContain("cvc");
  });
});

function memoryStorage(): BookingStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }
  };
}

function offer(): VerifiedOffer {
  return {
    id: "off_mock1234",
    itineraryKey: "mock-itinerary",
    provider: "official_duffel",
    price: 450,
    priceAmount: "450.00",
    currency: "GBP",
    fareBasis: "one_adult_total",
    primaryAirlineCode: "BA",
    participatingAirlineCodes: ["BA"],
    evidence: [],
    verifiedAt: "2026-08-04T07:00:00Z",
    observedAt: "2026-08-04T07:00:00Z",
    snapshot: {
      route: "LHR-LOS",
      flightNumbers: ["BA75"],
      stops: 0,
      durationSeconds: 23_400,
      segments: [{
        airlineCode: "BA",
        airline: "British Airways",
        flightNumber: "BA75",
        origin: "LHR",
        destination: "LOS",
        departure: "2026-09-10T10:00:00Z",
        arrival: "2026-09-10T16:30:00Z"
      }]
    }
  };
}
