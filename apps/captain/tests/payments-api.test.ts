import { describe, expect, it } from "vitest";

import { savePaymentMethodSchema } from "@agents/flight-domain";

describe("payments API validation", () => {
  it("rejects card IDs that are not Duffel tcd_ tokens", () => {
    expect(savePaymentMethodSchema.safeParse({
      cardId: "4242424242424242",
      brand: "visa",
      last4: "4242",
      expiryMonth: 9,
      expiryYear: 2028,
      cardholderName: "Ada"
    }).success).toBe(false);
    expect(savePaymentMethodSchema.safeParse({
      cardId: "tcd_abc123",
      brand: "visa",
      last4: "4242",
      expiryMonth: 9,
      expiryYear: 2028,
      cardholderName: "Ada"
    }).success).toBe(true);
  });

  it("rejects a 16-digit last4", () => {
    expect(savePaymentMethodSchema.safeParse({
      cardId: "tcd_abc123",
      brand: "visa",
      last4: "4242424242424242",
      expiryMonth: 9,
      expiryYear: 2028,
      cardholderName: "Ada"
    }).success).toBe(false);
  });
});
