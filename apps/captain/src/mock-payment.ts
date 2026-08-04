import type { PaymentMethod } from "./domain.js";

/** Display-only fixture. It intentionally contains no payment credentials. */
export const MOCK_PAYMENT_METHOD: PaymentMethod = {
  id: "mock-card",
  brand: "visa",
  last4: "4242",
  cardholderName: "Sample traveller",
  isDefault: true
};
