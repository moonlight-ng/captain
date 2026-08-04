import { lazy, Suspense, useEffect, useState } from "react";

import {
  ApiError,
  listPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod
} from "../api";
import type { PaymentMethod } from "../domain";
import { MOCK_PAYMENT_METHOD } from "../mock-payment";
import { Invoices } from "./Invoices";

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
    <>
      {loading && <p className="settings-card">Loading…</p>}
      {error && <p className="settings-card form-error" role="alert">{error}</p>}

      {!loading && !showForm && (
        <section className="settings-card">
          <div className="payment-card-list">
            {displayed.map((method) => (
              <article key={method.id} className="payment-method-row">
                <div className="read-only-field">
                  <strong>
                    {formatBrand(method.brand)} ···· {method.last4}
                    {!showingMock && method.isDefault ? " · Default" : ""}
                    {showingMock ? " · Mock" : ""}
                  </strong>
                  <div>{method.cardholderName}</div>
                </div>
                {!showingMock && (
                  <div className="entity-row" style={{ marginTop: 12 }}>
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
                            setError(cause instanceof ApiError ? cause.message : "Could not update default.");
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
                      className="quiet-link"
                      disabled={busyId === method.id}
                      onClick={() => {
                        if (!window.confirm(`Remove card ···· ${method.last4}?`)) return;
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
          <div className="entity-row" style={{ marginTop: 16 }}>
            <button type="button" className="quiet-link" onClick={() => setShowForm(true)}>
              {showingMock ? "Add card" : "Add another"}
            </button>
          </div>
        </section>
      )}

      {!loading && showForm && (
        <section className="settings-card">
          <div className="card-form-heading">
            <h2>{showingMock ? "Add card" : "Add another card"}</h2>
            <button type="button" className="quiet-link" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
          <Suspense fallback={<p>Loading…</p>}>
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

      {!loading && !showForm && <Invoices />}
    </>
  );
}

function formatBrand(brand: string): string {
  return brand.replace(/_/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}
