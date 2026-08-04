import { useEffect, useState } from "react";

import {
  ApiError,
  createPassenger,
  deletePassenger,
  listPassengers,
  setDefaultPassenger,
  updatePassenger
} from "../api";
import type { Passenger } from "../domain";
import {
  PassengerForm,
  emptyPassengerForm,
  passengerToForm,
  readinessLabel,
  toPassengerPayload
} from "../components/PassengerForm";

export function Travellers({
  displayName,
  paymentsEnabled,
  onBack,
  onChanged,
  embedded = false
}: {
  displayName: string;
  paymentsEnabled: boolean;
  onBack?: () => void;
  onChanged?: (passengers: Passenger[]) => void;
  embedded?: boolean;
}) {
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [formError, setFormError] = useState("");

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const next = await listPassengers();
      setPassengers(next);
      onChanged?.(next);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load travellers.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const nameParts = displayName.trim().split(/\s+/u).filter(Boolean);
  const prefill = {
    givenName: nameParts[0] ?? "",
    familyName: nameParts.slice(1).join(" ")
  };

  const content = (
    <>
      <section className="settings-card" id="traveller-profiles">
        <p className="eyebrow">Traveller profiles</p>
        <h1>Who’s flying</h1>
        <p>Names are saved securely for booking. Date of birth and gender are optional until you book.</p>
      </section>

      {loading && <p className="settings-card">Loading travellers…</p>}
      {error && <p className="settings-card form-error" role="alert">{error}</p>}

      {passengers.map((passenger) => (
        <details
          key={passenger.id}
          className="settings-card settings-disclosure"
          open={editingId === passenger.id}
        >
          <summary>
            <span>
              <strong>{passenger.givenName} {passenger.familyName}</strong>
              {passenger.isDefault ? " · Default" : ""}
            </span>
            <em>{readinessLabel(passenger)}</em>
          </summary>
          <div className="settings-body">
            {editingId === passenger.id ? (
              <PassengerForm
                initial={passengerToForm(passenger)}
                busy={busy}
                error={formError}
                submitLabel="Save traveller"
                onSubmit={async (values) => {
                  setBusy(true);
                  setFormError("");
                  try {
                    await updatePassenger(passenger.id, toPassengerPayload(values));
                    await reload();
                    setEditingId(null);
                  } catch (cause) {
                    setFormError(cause instanceof ApiError ? cause.message : "Could not save.");
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            ) : (
              <div className="settings-list">
                <div className="entity-row">
                  <span>{passenger.email || "No email"} · {passenger.phoneNumber || "No phone"}</span>
                  <div>
                    {!passenger.isDefault && (
                      <button
                        type="button"
                        className="quiet-link"
                        disabled={busy}
                        onClick={() => void (async () => {
                          setBusy(true);
                          try {
                            await setDefaultPassenger(passenger.id);
                            await reload();
                          } finally {
                            setBusy(false);
                          }
                        })()}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="quiet-link"
                      onClick={() => {
                        setFormError("");
                        setEditingId(passenger.id);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="quiet-link"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Remove ${passenger.givenName} ${passenger.familyName}?`)) return;
                        void (async () => {
                          setBusy(true);
                          try {
                            await deletePassenger(passenger.id);
                            await reload();
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </details>
      ))}

      <details
        className="settings-card settings-disclosure"
        open={editingId === "new" || passengers.length === 0}
      >
        <summary>
          <span><strong>Add traveller</strong></span>
          <em>New</em>
        </summary>
        <div className="settings-body">
          <PassengerForm
            initial={emptyPassengerForm(prefill)}
            busy={busy}
            error={formError}
            submitLabel="Save traveller"
            onSubmit={async (values) => {
              setBusy(true);
              setFormError("");
              try {
                await createPassenger({
                  ...toPassengerPayload(values),
                  isDefault: passengers.length === 0
                });
                setEditingId(null);
                await reload();
              } catch (cause) {
                setFormError(cause instanceof ApiError ? cause.message : "Could not save.");
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      </details>

      {paymentsEnabled && !embedded && (
        <p className="settings-card">
          Next, add a card in your <a className="quiet-link" href="/profile#payment">profile</a>.
        </p>
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
