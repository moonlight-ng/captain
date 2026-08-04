import { lazy, Suspense, useEffect, useState } from "react";

import {
  ApiError,
  listPaymentMethods,
  removePaymentMethod
} from "../api";
import type { PaymentMethod } from "../domain";
import { MOCK_PAYMENT_METHOD } from "../mock-payment";

const DuffelCardMount = lazy(() => import("../components/DuffelCardMount"));

export function Payment() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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

  const primary = methods[0] ?? null;
  const displayed = primary ?? MOCK_PAYMENT_METHOD;
  const showingMock = primary === null;

  return (
    <>
      {loading && <p className="settings-card">Loading…</p>}
      {error && <p className="settings-card form-error" role="alert">{error}</p>}

      {!loading && !showForm && (
        <section className="settings-card">
          <div className="read-only-field">
            <strong>
              {formatBrand(displayed.brand)} ···· {displayed.last4}
            </strong>
            <div>{displayed.cardholderName}{showingMock ? " · Mock" : ""}</div>
          </div>
          <div className="entity-row" style={{ marginTop: 16 }}>
            <button type="button" className="quiet-link" onClick={() => setShowForm(true)}>
              {showingMock ? "Add card" : "Replace"}
            </button>
            {primary && (
              <button
                type="button"
                className="quiet-link"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Remove the saved card?")) return;
                  void (async () => {
                    setBusy(true);
                    try {
                      await removePaymentMethod(primary.id);
                      await reload();
                    } catch (cause) {
                      setError(cause instanceof ApiError ? cause.message : "Could not remove card.");
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                Remove
              </button>
            )}
          </div>
        </section>
      )}

      {!loading && showForm && (
        <section className="settings-card">
          <div className="card-form-heading">
            <h2>{primary ? "Replace card" : "Add card"}</h2>
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

      {!loading && !showForm && (
        <section className="settings-card">
          <p className="set-note">No invoices yet</p>
        </section>
      )}
    </>
  );
}

function formatBrand(brand: string): string {
  return brand.replace(/_/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}
