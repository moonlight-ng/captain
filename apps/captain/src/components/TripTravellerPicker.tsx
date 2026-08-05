import { useEffect, useState } from "react";

import { ApiError, listPassengers, profileHref, setTripTravellers } from "../api";
import type { Passenger } from "../domain";

export function TripTravellerPicker({
  tripId,
  assigned,
  sessionCredential,
  onChanged,
  onError,
  onBook
}: {
  tripId: string;
  assigned: Passenger[];
  sessionCredential: boolean;
  onChanged: (passengers: Passenger[]) => void;
  onError: (message: string) => void;
  onBook?: () => void;
}) {
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [loading, setLoading] = useState(sessionCredential);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionCredential) return;
    void (async () => {
      try {
        setPassengers(await listPassengers());
      } catch (cause) {
        onError(cause instanceof ApiError ? cause.message : "Could not load travellers.");
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionCredential]);

  const selected = assigned[0] ?? null;
  const selectedId = selected?.id ?? null;
  const canBook = Boolean(
    onBook
    && selected?.readyForBooking
    && selected.readyForInternationalTravel
  );

  async function choose(passenger: Passenger) {
    if (passenger.id === selectedId) return;
    setBusyId(passenger.id);
    onError("");
    try {
      onChanged(await setTripTravellers(tripId, [passenger.id]));
    } catch (cause) {
      onError(cause instanceof ApiError ? cause.message : "Could not choose that traveller.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="trip-traveller-picker">
      <div className="trip-traveller-heading">
        <p className="eyebrow">Traveller</p>
        <a className="quiet-link" href={travellerProfileHref(tripId)}>Manage</a>
      </div>

      {!sessionCredential ? (
        <p className="set-note">Open Captain from Telegram to choose a saved traveller.</p>
      ) : loading ? (
        <p className="set-note">Loading travellers…</p>
      ) : passengers.length === 0 ? (
        <a className="traveller-picker-empty" href={travellerProfileHref(tripId, "new")}>
          <span><strong>Add a traveller</strong><small>Needed before booking.</small></span>
          <span aria-hidden="true">›</span>
        </a>
      ) : (
        <div className="traveller-picker-list">
          {passengers.map((passenger) => {
            const isSelected = passenger.id === selectedId;
            return (
              <button
                type="button"
                key={passenger.id}
                className={isSelected ? "selected" : ""}
                aria-pressed={isSelected}
                disabled={busyId !== null}
                onClick={() => void choose(passenger)}
              >
                <span className="traveller-picker-radio" aria-hidden="true" />
                <span className="traveller-picker-person">
                  <strong>{fullName(passenger)}</strong>
                  <small>{travellerMeta(passenger)}</small>
                </span>
                <span className={`readiness-badge ${passenger.readyForBooking ? "ready" : "incomplete"}`}>
                  {passenger.readyForInternationalTravel
                    ? "Ready"
                    : passenger.readyForBooking ? "Passport needed" : "Incomplete"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {onBook && (
        <div className="traveller-book-row">
          <button type="button" className="primary-action" disabled={!canBook} onClick={onBook}>
            Book flight
          </button>
        </div>
      )}
    </section>
  );
}

export function travellerProfileHref(tripId: string, passengerId?: string): string {
  const url = new URL(profileHref("travellers"), window.location.origin);
  url.searchParams.set("trip", tripId);
  if (passengerId) url.searchParams.set("traveller", passengerId);
  return `${url.pathname}${url.search}${url.hash}`;
}

function fullName(passenger: Passenger): string {
  return [passenger.givenName, passenger.middleName, passenger.familyName].filter(Boolean).join(" ");
}

function travellerMeta(passenger: Passenger): string {
  const country = passenger.nationality || passenger.countryOfResidence;
  const dob = passenger.bornOn ? formatDate(passenger.bornOn) : null;
  if (country && dob) return `${country} · ${dob}`;
  if (country) return country;
  if (dob) return dob;
  return "Details missing";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
}
