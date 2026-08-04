import { lazy, Suspense, useEffect, useState } from "react";

import {
  ApiError,
  listPaymentMethods,
  removePaymentMethod
} from "../api";
import type { PaymentMethod } from "../domain";
import { MOCK_PAYMENT_METHOD } from "../mock-payment";

const DuffelCardMount = lazy(() => import("../components/DuffelCardMount"));

export function Payment({
  onBack,
  embedded = false
}: {
  onBack?: () => void;
  embedded?: boolean;
}) {
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

  const content = (
    <>
      <section className="settings-card" id="payment">
        <p className="eyebrow">Payment</p>
        <h1>Payment card</h1>
        <p>
          Captain stores a tokenised card ID with Duffel — never the full number or CVC.
          The sample card below is mock; you can replace it with your real card securely.
        </p>
      </section>

      {loading && <p className="settings-card">Loading…</p>}
      {error && <p className="settings-card form-error" role="alert">{error}</p>}

      {!loading && !showForm && (
        <section className="settings-card">
          <div className="card-status-row">
            <span className={`pill${showingMock ? " mock-pill" : ""}`}>
              {showingMock ? "Mock card" : "Saved securely"}
            </span>
          </div>
          <div className="read-only-field">
            <strong>
              {formatBrand(displayed.brand)} ···· {displayed.last4}
            </strong>
            <div>{displayed.cardholderName}</div>
          </div>
          {showingMock && (
            <p className="set-note">
              Display only. This sample card is never stored, charged, or sent to Duffel.
            </p>
          )}
          <div className="entity-row" style={{ marginTop: 16 }}>
            <button type="button" className="quiet-link" onClick={() => setShowForm(true)}>
              {showingMock ? "Add real card" : "Replace"}
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
            <div>
              <p className="eyebrow">Secure card</p>
              <h2>{primary ? "Replace saved card" : "Add your card"}</h2>
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
    </>
  );

  if (embedded) return content;

  return (
    <main className="shell settings-shell">
      <header className="topbar">
        <a className="brand" href="/profile" aria-label="Captain profile">
          <span className="brand-mark">C</span>
          <span>Captain</span>
        </a>
        <div className="top-actions">
          {onBack && <button type="button" className="quiet-link" onClick={onBack}>Back</button>}
        </div>
      </header>
      {content}
    </main>
  );
}

function formatBrand(brand: string): string {
  return brand.replace(/_/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}
