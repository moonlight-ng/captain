import { TEST_PAYMENT_METHOD } from "../mock-payment";

/** Prototype payment surface: the fixed fixture is never sent to a payment provider. */
export function Payment() {
  return (
    <section className="settings-card payment-settings">
      <div className="payment-card-list">
        <article className="payment-method-row">
          <div className="read-only-field">
            <strong>
              {formatBrand(TEST_PAYMENT_METHOD.brand)} ···· {TEST_PAYMENT_METHOD.last4} · Test card
            </strong>
            <div>{TEST_PAYMENT_METHOD.cardholderName}</div>
          </div>
        </article>
      </div>
      <p className="set-note" style={{ marginTop: 16 }}>
        Prototype only. Captain never collects or charges a real card.
      </p>
    </section>
  );
}

function formatBrand(brand: string): string {
  return brand.replace(/_/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}
