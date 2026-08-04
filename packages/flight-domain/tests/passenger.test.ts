import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createCaptainAccessLink,
  createPassengerSchema,
  passengerReadyForBooking,
  passengerSchema,
  type Passenger
} from "../src/index.js";

describe("passenger schemas", () => {
  it("rejects names that contain digits", () => {
    expect(createPassengerSchema.safeParse({
      givenName: "Ada2",
      familyName: "Lovelace"
    }).success).toBe(false);
    expect(createPassengerSchema.safeParse({
      givenName: "Ada",
      familyName: "Love1ace"
    }).success).toBe(false);
  });

  it("rejects future and pre-1900 dates of birth", () => {
    expect(createPassengerSchema.safeParse({
      givenName: "Ada",
      familyName: "Lovelace",
      bornOn: "1899-12-31"
    }).success).toBe(false);
    expect(createPassengerSchema.safeParse({
      givenName: "Ada",
      familyName: "Lovelace",
      bornOn: "2099-01-01"
    }).success).toBe(false);
    expect(createPassengerSchema.safeParse({
      givenName: "Ada",
      familyName: "Lovelace",
      bornOn: "1990-05-10"
    }).success).toBe(true);
  });

  it("requires E.164 phone numbers", () => {
    expect(createPassengerSchema.safeParse({
      givenName: "Ada",
      familyName: "Lovelace",
      phoneNumber: "07123456789"
    }).success).toBe(false);
    expect(createPassengerSchema.safeParse({
      givenName: "Ada",
      familyName: "Lovelace",
      phoneNumber: "+447700900123"
    }).success).toBe(true);
  });

  it("reports booking readiness from the shared helper", () => {
    const incomplete: Passenger = passengerSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      givenName: "Ada",
      familyName: "Lovelace",
      title: null,
      gender: null,
      bornOn: null,
      email: null,
      phoneNumber: null,
      isDefault: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(passengerReadyForBooking(incomplete)).toBe(false);
    expect(passengerReadyForBooking({
      ...incomplete,
      title: "ms",
      gender: "f",
      bornOn: "1815-12-10",
      email: "ada@example.com",
      phoneNumber: "+447700900123"
    })).toBe(true);
  });

  it("keeps createCaptainAccessLink off session-only payment paths", () => {
    // @ts-expect-error payment is a CaptainSessionPath, not a CaptainWebPath
    createCaptainAccessLink("https://captain.example", "/payment", "11111111-1111-4111-8111-111111111111", "secret");
    expectTypeOf<Parameters<typeof createCaptainAccessLink>[1]>()
      .toEqualTypeOf<"/trip" | "/preferences" | "/settings">();
  });
});
