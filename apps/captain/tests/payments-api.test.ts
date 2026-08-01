import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { savePaymentMethodSchema } from "@agents/flight-domain";

const validInput = {
  setupIntentId: randomUUID(),
  cardId: "tcd_abc123",
  brand: "visa" as const,
  last4: "4242",
  cardholderName: "Ada Lovelace"
};

describe("payments API validation", () => {
  it("accepts a Duffel setup finalize payload without expiry fields", () => {
    expect(savePaymentMethodSchema.safeParse(validInput).success).toBe(true);
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      expiryMonth: 9,
      expiryYear: 2028
    }).success).toBe(false);
  });

  it("requires setupIntentId as a uuid", () => {
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      setupIntentId: "not-a-uuid"
    }).success).toBe(false);
  });

  it("rejects card IDs that are not Duffel tcd_ tokens", () => {
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      cardId: "4242424242424242"
    }).success).toBe(false);
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      cardId: "tcd_abc123"
    }).success).toBe(true);
  });

  it("rejects card IDs longer than 128 characters", () => {
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      cardId: `tcd_${"a".repeat(130)}`
    }).success).toBe(false);
  });

  it("rejects unknown brands and accepts the Duffel brand enum", () => {
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      brand: "amex"
    }).success).toBe(false);
    for (const brand of [
      "visa",
      "mastercard",
      "uatp",
      "american_express",
      "diners_club",
      "jcb",
      "discover"
    ]) {
      expect(savePaymentMethodSchema.safeParse({ ...validInput, brand }).success).toBe(true);
    }
  });

  it("rejects a 16-digit last4", () => {
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      last4: "4242424242424242"
    }).success).toBe(false);
  });

  it("caps cardholderName at 100 characters", () => {
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      cardholderName: "A".repeat(100)
    }).success).toBe(true);
    expect(savePaymentMethodSchema.safeParse({
      ...validInput,
      cardholderName: "A".repeat(101)
    }).success).toBe(false);
  });
});
