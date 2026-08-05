import { useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  createPassenger,
  deletePassenger,
  listPassengers,
  setDefaultPassenger,
  setTripTravellers,
  tripHref,
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
import { fakeTravellerDetails, isMockMode } from "../mock-mode";

export function Travellers({
  displayName,
  onChanged,
  onEditingChange
}: {
  displayName: string;
  onChanged?: (passengers: Passenger[]) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const mockMode = isMockMode();
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | "new" | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("traveller");
    return requested || null;
  });
  const [formError, setFormError] = useState("");
  const returnTripId = useMemo(
    () => new URLSearchParams(window.location.search).get("trip"),
    []
  );
  // Deep-links from a trip open the editor directly; Back should return there.
  const [openedFromTripLink] = useState(
    () => Boolean(
      new URLSearchParams(window.location.search).get("traveller")
      && new URLSearchParams(window.location.search).get("trip")
    )
  );

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

  useEffect(() => {
    onEditingChange?.(selectedId !== null && !(mockMode && selectedId === "new"));
  }, [selectedId, onEditingChange, mockMode]);

  const nameParts = displayName.trim().split(/\s+/u).filter(Boolean);
  const prefill = useMemo(() => ({
    givenName: nameParts[0] ?? "",
    familyName: nameParts.slice(1).join(" ")
  }), [displayName]);

  const selected = selectedId && selectedId !== "new"
    ? passengers.find((passenger) => passenger.id === selectedId) ?? null
    : null;
  const creating = selectedId === "new";
  const editing = selectedId !== null && !(mockMode && creating);

  function syncTravellerParam(next: string | "new" | null) {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("traveller", next);
    else url.searchParams.delete("traveller");
    window.history.replaceState(null, "", url.toString());
  }

  function openEditor(id: string | "new") {
    setFormError("");
    setSelectedId(id);
    syncTravellerParam(id);
  }

  function leaveEditor(opts?: { afterSave?: boolean }) {
    if (returnTripId && (opts?.afterSave || openedFromTripLink)) {
      window.location.href = tripHref(returnTripId, "settings");
      return;
    }
    setSelectedId(null);
    setFormError("");
    syncTravellerParam(null);
  }

  async function addFakeTraveller() {
    setBusy(true);
    setFormError("");
    try {
      const created = await createPassenger({
        ...toPassengerPayload(fakeTravellerDetails(passengers.length)),
        isDefault: passengers.length === 0
      });
      if (returnTripId) {
        await setTripTravellers(returnTripId, [created.id]);
        leaveEditor({ afterSave: true });
        return;
      }
      await reload({ quiet: true });
      leaveEditor();
    } catch (cause) {
      setFormError(cause instanceof ApiError ? cause.message : "Could not save traveller.");
      setSelectedId(null);
      syncTravellerParam(null);
    } finally {
      setBusy(false);
    }
  }

  // Mock mode: skip the blank form and mint a complete fake traveller immediately.
  const mintingRef = useRef(false);
  useEffect(() => {
    if (!mockMode || selectedId !== "new" || loading || busy || mintingRef.current) return;
    mintingRef.current = true;
    void addFakeTraveller().finally(() => {
      mintingRef.current = false;
    });
  }, [mockMode, selectedId, loading]);

  if (loading || (mockMode && creating && !formError)) {
    return <section className="profile-empty-state"><p>{creating ? "Adding traveller…" : "Loading travellers…"}</p></section>;
  }
  if (error) return <section className="profile-empty-state form-error" role="alert">{error}</section>;
  if (formError && !editing) {
    return (
      <section className="profile-empty-state form-error" role="alert">
        <p>{formError}</p>
        <button type="button" className="profile-add-button" onClick={() => void addFakeTraveller()}>
          Try again
        </button>
      </section>
    );
  }

  if (editing) {
    const title = creating ? "Add traveller" : selected ? fullName(selected) : "Traveller";
    const missing = editing && !creating && !selected;

    return (
      <section className="traveller-editor">
        <header className="topbar">
          <button type="button" className="back-link" onClick={() => leaveEditor()}>
            ← {openedFromTripLink ? "Trip" : "Travellers"}
          </button>
          <span className="name">{creating ? "New" : selected ? readinessLabel(selected) : ""}</span>
        </header>

        <div className="traveller-editor-body">
          <div className="profile-section-heading traveller-detail-heading">
            <div>
              <p className="eyebrow">Traveller</p>
              <h1>{title}</h1>
            </div>
            {selected && (
              <span className={`readiness-badge ${selected.readyForBooking ? "ready" : "incomplete"}`}>
                {readinessLabel(selected)}
              </span>
            )}
          </div>

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
                  const created = await createPassenger({
                    ...toPassengerPayload(values),
                    isDefault: passengers.length === 0
                  });
                  if (returnTripId) {
                    await setTripTravellers(returnTripId, [created.id]);
                    leaveEditor({ afterSave: true });
                    return;
                  }
                  await reload({ quiet: true });
                  leaveEditor();
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
                    if (returnTripId) {
                      leaveEditor({ afterSave: true });
                      return;
                    }
                    await reload({ quiet: true });
                    leaveEditor();
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
                        leaveEditor();
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

          {missing && (
            <p className="set-note">That traveller is no longer available.</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="traveller-list-view">
      {passengers.length === 0 ? (
        <div className="profile-empty-state traveller-empty-state">
          <p>Add a traveller to book flights.</p>
          <button
            type="button"
            className="profile-add-button"
            disabled={busy}
            onClick={() => (mockMode ? void addFakeTraveller() : openEditor("new"))}
          >
            {busy ? "Adding…" : "Add traveller"}
          </button>
        </div>
      ) : (
        <>
          <div className="profile-section-heading">
            <div>
              <p className="eyebrow">Travellers</p>
              <p>Details used when booking.</p>
            </div>
            <button
              type="button"
              className="profile-add-button"
              disabled={busy}
              onClick={() => (mockMode ? void addFakeTraveller() : openEditor("new"))}
            >
              {busy ? "Adding…" : "Add traveller"}
            </button>
          </div>

          <div className="traveller-card-list">
            {passengers.map((passenger) => (
              <button
                type="button"
                className="traveller-summary-card"
                key={passenger.id}
                onClick={() => openEditor(passenger.id)}
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
        </>
      )}
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
