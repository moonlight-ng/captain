import { useEffect, useMemo, useState } from "react";

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
import { CloseIcon } from "../components/icons";

export function Travellers({
  displayName,
  onChanged
}: {
  displayName: string;
  onChanged?: (passengers: Passenger[]) => void;
}) {
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | "new" | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("traveller");
    return requested || null;
  });
  const [formError, setFormError] = useState("");

  async function reload(opts?: { quiet?: boolean }) {
    if (!opts?.quiet) setLoading(true);
    setError("");
    try {
      const next = await listPassengers();
      setPassengers(next);
      onChanged?.(next);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load travellers.");
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const nameParts = displayName.trim().split(/\s+/u).filter(Boolean);
  const prefill = useMemo(() => ({
    givenName: nameParts[0] ?? "",
    familyName: nameParts.slice(1).join(" ")
  }), [displayName]);

  const sheetOpen = selectedId !== null;
  const selected = selectedId && selectedId !== "new"
    ? passengers.find((passenger) => passenger.id === selectedId) ?? null
    : null;
  const creating = selectedId === "new";

  function closeSheet() {
    setSelectedId(null);
    setFormError("");
    const url = new URL(window.location.href);
    if (url.searchParams.has("traveller")) {
      url.searchParams.delete("traveller");
      window.history.replaceState(null, "", url.toString());
    }
  }

  if (loading) return <section className="profile-empty-state"><p>Loading travellers…</p></section>;
  if (error) return <section className="profile-empty-state form-error" role="alert">{error}</section>;

  return (
    <section className="traveller-list-view">
      <div className="profile-section-heading">
        <div>
          <p className="eyebrow">Travellers</p>
          <p>Government ID, contact, and passport details for booking.</p>
        </div>
        <button type="button" className="profile-add-button" onClick={() => {
          setFormError("");
          setSelectedId("new");
        }}>
          Add traveller
        </button>
      </div>

      {passengers.length === 0 ? (
        <p className="set-note">No travellers yet. Add one to book.</p>
      ) : (
        <div className="traveller-card-list">
          {passengers.map((passenger) => (
            <button
              type="button"
              className="traveller-summary-card"
              key={passenger.id}
              onClick={() => {
                setFormError("");
                setSelectedId(passenger.id);
              }}
            >
              <span className="traveller-avatar" aria-hidden="true">
                {passenger.givenName.slice(0, 1)}{passenger.familyName.slice(0, 1)}
              </span>
              <span className="traveller-card-main">
                <span>
                  <strong>{fullName(passenger)}</strong>
                  {passenger.isDefault && <small>Default traveller</small>}
                </span>
                <small>
                  {passenger.bornOn ? `Born ${formatDate(passenger.bornOn)}` : "Date of birth missing"}
                  {passenger.passportLast4 ? ` · Passport •••• ${passenger.passportLast4}` : " · No passport"}
                </small>
              </span>
              <span className={`readiness-badge ${passenger.readyForBooking ? "ready" : "incomplete"}`}>
                {readinessLabel(passenger)}
              </span>
              <span className="card-chevron" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      )}

      <div
        className="sheet-backdrop traveller-sheet-backdrop"
        data-open={sheetOpen}
        aria-hidden={!sheetOpen}
        role="presentation"
        onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeSheet();
        }}
      >
        <section
          className="bottom-sheet traveller-sheet"
          role="dialog"
          aria-modal={sheetOpen}
          aria-label={creating ? "Add traveller" : selected ? fullName(selected) : "Traveller"}
        >
          <header>
            <span>
              <strong>{creating ? "Add traveller" : selected ? fullName(selected) : "Traveller"}</strong>
              {selected && (
                <small className={selected.readyForBooking ? "ready" : "incomplete"}>
                  {readinessLabel(selected)}
                </small>
              )}
              {creating && <small>Use the traveller’s government ID and contact details.</small>}
            </span>
            <button type="button" className="icon-button" aria-label="Close traveller" onClick={closeSheet}>
              <CloseIcon />
            </button>
          </header>

          <div className="sheet-scroll">
            {creating && (
              <PassengerForm
                key="new"
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
                    await reload({ quiet: true });
                    closeSheet();
                  } catch (cause) {
                    setFormError(cause instanceof ApiError ? cause.message : "Could not save traveller.");
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}

            {selected && (
              <>
                <PassengerForm
                  key={selected.id}
                  initial={passengerToForm(selected)}
                  existingPassportLast4={selected.passportLast4}
                  busy={busy}
                  error={formError}
                  submitLabel="Save changes"
                  onSubmit={async (values) => {
                    setBusy(true);
                    setFormError("");
                    try {
                      await updatePassenger(
                        selected.id,
                        toPassengerPayload(values, Boolean(selected.passportLast4))
                      );
                      await reload({ quiet: true });
                      closeSheet();
                    } catch (cause) {
                      setFormError(cause instanceof ApiError ? cause.message : "Could not save traveller.");
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <div className="traveller-detail-actions">
                  {!selected.isDefault && (
                    <button
                      type="button"
                      className="quiet-link"
                      disabled={busy}
                      onClick={() => void (async () => {
                        setBusy(true);
                        try {
                          await setDefaultPassenger(selected.id);
                          await reload({ quiet: true });
                        } finally {
                          setBusy(false);
                        }
                      })()}
                    >
                      Make default traveller
                    </button>
                  )}
                  <button
                    type="button"
                    className="quiet-link danger-link"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Remove ${fullName(selected)}?`)) return;
                      void (async () => {
                        setBusy(true);
                        try {
                          await deletePassenger(selected.id);
                          await reload({ quiet: true });
                          closeSheet();
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    Remove traveller
                  </button>
                </div>
              </>
            )}

            {sheetOpen && !creating && !selected && (
              <p className="set-note">That traveller is no longer available.</p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function fullName(passenger: Passenger): string {
  return [passenger.givenName, passenger.middleName, passenger.familyName].filter(Boolean).join(" ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${value}T00:00:00Z`));
}
