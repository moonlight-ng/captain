import type { PaymentMethod } from "./domain.js";

/** Display-only fixture. It intentionally contains no payment credentials. */
export const TEST_PAYMENT_METHOD: PaymentMethod = {
  id: "test-card",
  brand: "visa",
  last4: "4242",
  cardholderName: "Sample traveller",
  isDefault: true
};
