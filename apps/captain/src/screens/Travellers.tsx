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
  missingBookingDetails,
  passengerToForm,
  readinessLabel,
  toPassengerPayload
} from "../components/PassengerForm";

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
  const prefill = useMemo(() => ({
    givenName: nameParts[0] ?? "",
    familyName: nameParts.slice(1).join(" ")
  }), [displayName]);
  const selected = selectedId && selectedId !== "new"
    ? passengers.find((passenger) => passenger.id === selectedId) ?? null
    : null;

  if (loading) return <section className="profile-empty-state"><p>Loading travellers…</p></section>;
  if (error) return <section className="profile-empty-state form-error" role="alert">{error}</section>;

  if (selectedId === "new" || (passengers.length === 0 && selectedId === null)) {
    return (
      <section className="profile-detail-view">
        {passengers.length > 0 && (
          <button type="button" className="back-link" onClick={() => setSelectedId(null)}>
            ← Travellers
          </button>
        )}
        <div className="profile-section-heading">
          <div>
            <p className="eyebrow">New traveller</p>
            <h1>{passengers.length === 0 ? "Your traveller details" : "Add a traveller"}</h1>
            <p>{passengers.length === 0
              ? "We’ve pre-filled what Captain knows. Complete the government-ID details before booking."
              : "Use the traveller’s own government ID and contact details."}</p>
          </div>
        </div>
        <PassengerForm
          initial={emptyPassengerForm(prefill)}
          busy={busy}
          error={formError}
          submitLabel="Save traveller"
          onSubmit={async (values) => {
            setBusy(true);
            setFormError("");
            try {
              const passenger = await createPassenger({
                ...toPassengerPayload(values),
                isDefault: passengers.length === 0
              });
              await reload();
              setSelectedId(passenger.id);
            } catch (cause) {
              setFormError(cause instanceof ApiError ? cause.message : "Could not save traveller.");
            } finally {
              setBusy(false);
            }
          }}
        />
      </section>
    );
  }

  if (selected) {
    const missing = missingBookingDetails(selected);
    return (
      <section className="profile-detail-view">
        <button type="button" className="back-link" onClick={() => setSelectedId(null)}>
          ← Travellers
        </button>
        <div className="profile-section-heading traveller-detail-heading">
          <div>
            <p className="eyebrow">Traveller</p>
            <h1>{fullName(selected)}</h1>
            <p>{selected.readyForBooking
              ? "Core details are complete for booking."
              : `Still needed: ${missing.join(", ")}.`}</p>
          </div>
          <span className={`readiness-badge ${selected.readyForBooking ? "ready" : "incomplete"}`}>
            {readinessLabel(selected)}
          </span>
        </div>
        {selected.passportLast4 && (
          <div className="secure-summary">
            <span>Passport on file</span>
            <strong>•••• {selected.passportLast4}</strong>
            <small>{selected.passportIssuingCountry ?? "—"} · expires {selected.passportExpiresOn ?? "—"}</small>
          </div>
        )}
        <PassengerForm
          initial={passengerToForm(selected)}
          existingPassportLast4={selected.passportLast4}
          busy={busy}
          error={formError}
          submitLabel="Save changes"
          onSubmit={async (values) => {
            setBusy(true);
            setFormError("");
            try {
              await updatePassenger(selected.id, toPassengerPayload(values, Boolean(selected.passportLast4)));
              await reload();
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
                  await reload();
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
                  await reload();
                  setSelectedId(null);
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            Remove traveller
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="traveller-list-view">
      <div className="profile-section-heading">
        <div>
          <p className="eyebrow">Travellers</p>
          <h1>Who can Captain book for?</h1>
          <p>Open a traveller to review government-ID, contact, and passport readiness.</p>
        </div>
        <button type="button" className="profile-add-button" onClick={() => setSelectedId("new")}>
          Add traveller
        </button>
      </div>
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
