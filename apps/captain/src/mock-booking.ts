import type { VerifiedOffer } from "./domain.js";

export type MockBookingStatus = "confirmed" | "cancelled";

export type MockBooking = {
  version: 1;
  tripId: string;
  offer: VerifiedOffer;
  reference: string;
  bookedAt: string;
  status: MockBookingStatus;
  seat: string | null;
  checkedBags: number;
};

export type BookingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createMockBooking(
  tripId: string,
  offer: VerifiedOffer,
  now = new Date()
): MockBooking {
  return {
    version: 1,
    tripId,
    offer,
    reference: `CAP-${tripId.replace(/-/gu, "").slice(0, 4).toUpperCase()}-${offer.id.replace(/[^a-z0-9]/giu, "").slice(-4).toUpperCase()}`,
    bookedAt: now.toISOString(),
    status: "confirmed",
    seat: null,
    checkedBags: 0
  };
}

export function readMockBooking(
  tripId: string,
  storage: BookingStorage = window.localStorage
): MockBooking | null {
  try {
    const value = JSON.parse(storage.getItem(mockBookingKey(tripId)) ?? "null") as unknown;
    return isMockBooking(value, tripId) ? value : null;
  } catch {
    return null;
  }
}

export function writeMockBooking(
  booking: MockBooking,
  storage: BookingStorage = window.localStorage
): void {
  try {
    storage.setItem(mockBookingKey(booking.tripId), JSON.stringify(booking));
  } catch {
    // The demo still works in memory when browser storage is unavailable.
  }
}

export function removeMockBooking(
  tripId: string,
  storage: BookingStorage = window.localStorage
): void {
  try {
    storage.removeItem(mockBookingKey(tripId));
  } catch {
    // Ignore storage restrictions in private browsing modes.
  }
}

function mockBookingKey(tripId: string): string {
  return `captain:mock-booking:${tripId}`;
}

function isMockBooking(value: unknown, tripId: string): value is MockBooking {
  if (!value || typeof value !== "object") return false;
  const booking = value as Partial<MockBooking>;
  return booking.version === 1
    && booking.tripId === tripId
    && typeof booking.reference === "string"
    && typeof booking.bookedAt === "string"
    && ["confirmed", "cancelled"].includes(booking.status ?? "")
    && (booking.seat === null || typeof booking.seat === "string")
    && Number.isSafeInteger(booking.checkedBags)
    && typeof booking.offer === "object"
    && booking.offer !== null
    && typeof booking.offer.id === "string"
    && typeof booking.offer.itineraryKey === "string";
}
