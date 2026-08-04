import { lazy, Suspense, useEffect, useState } from "react";

import {
  ApiError,
  listPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod
} from "../api";
import type { PaymentMethod } from "../domain";
import { MOCK_PAYMENT_METHOD } from "../mock-payment";

const DuffelCardMount = lazy(() => import("../components/DuffelCardMount"));

export function Payment() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      setMethods(await listPaymentMethods());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load cards.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const displayed = methods.length > 0 ? methods : [MOCK_PAYMENT_METHOD];
  const showingMock = methods.length === 0;

  return (
    <section className="payment-tab-view">
      <div className="profile-section-heading">
        <div>
          <p className="eyebrow">Payment</p>
          <h1>Saved cards</h1>
          <p>Card numbers and CVCs stay inside Duffel’s secure card form. Captain stores tokenised references only.</p>
        </div>
        <button type="button" className="profile-add-button" onClick={() => setShowForm(true)}>
          Add card
        </button>
      </div>

      {loading && <section className="profile-empty-state"><p>Loading cards…</p></section>}
      {error && <p className="profile-empty-state form-error" role="alert">{error}</p>}

      {!loading && (
        <div className="payment-card-list">
          {displayed.map((method) => (
            <article className={`payment-method-card${method.isDefault ? " default" : ""}`} key={method.id}>
              <div className="payment-card-brand-row">
                <span className="payment-card-brand">{formatBrand(method.brand)}</span>
                <span className={`pill${showingMock ? " mock-pill" : ""}`}>
                  {showingMock ? "Mock default" : method.isDefault ? "Default" : "Saved"}
                </span>
              </div>
              <strong className="payment-card-number">•••• •••• •••• {method.last4}</strong>
              <span className="payment-card-holder">{method.cardholderName}</span>
              {showingMock ? (
                <p className="set-note">Display only. It cannot be charged and is never sent to Duffel.</p>
              ) : (
                <div className="payment-card-actions">
                  {!method.isDefault && (
                    <button
                      type="button"
                      className="quiet-link"
                      disabled={busyId === method.id}
                      onClick={() => void (async () => {
                        setBusyId(method.id);
                        setError("");
                        try {
                          await setDefaultPaymentMethod(method.id);
                          await reload();
                        } catch (cause) {
                          setError(cause instanceof ApiError ? cause.message : "Could not update the default card.");
                        } finally {
                          setBusyId(null);
                        }
                      })()}
                    >
                      Make default
                    </button>
                  )}
                  <button
                    type="button"
                    className="quiet-link danger-link"
                    disabled={busyId === method.id}
                    onClick={() => {
                      if (!window.confirm(`Remove the ${formatBrand(method.brand)} ending ${method.last4}?`)) return;
                      void (async () => {
                        setBusyId(method.id);
                        setError("");
                        try {
                          await removePaymentMethod(method.id);
                          await reload();
                        } catch (cause) {
                          setError(cause instanceof ApiError ? cause.message : "Could not remove card.");
                        } finally {
                          setBusyId(null);
                        }
                      })();
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {!loading && showForm && (
        <section className="profile-form-panel">
          <div className="card-form-heading">
            <div>
              <p className="eyebrow">Secure card</p>
              <h2>Add another card</h2>
            </div>
            <button type="button" className="quiet-link" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
          <Suspense fallback={<p>Loading secure card form…</p>}>
            <DuffelCardMount
              onSaved={async () => {
                setShowForm(false);
                await reload();
              }}
              onError={setError}
            />
          </Suspense>
        </section>
      )}
    </section>
  );
}

function formatBrand(brand: string): string {
  return brand.replace(/_/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}
