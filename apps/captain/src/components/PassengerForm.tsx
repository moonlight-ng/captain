import { useState, type FormEvent } from "react";

import type { Passenger } from "../domain";

export type PassengerFormValues = {
  givenName: string;
  familyName: string;
  title: Passenger["title"];
  gender: Passenger["gender"];
  bornOn: string;
  email: string;
  phoneNumber: string;
};

export function emptyPassengerForm(prefill?: {
  givenName?: string;
  familyName?: string;
}): PassengerFormValues {
  return {
    givenName: prefill?.givenName ?? "",
    familyName: prefill?.familyName ?? "",
    title: null,
    gender: null,
    bornOn: "",
    email: "",
    phoneNumber: ""
  };
}

export function passengerToForm(passenger: Passenger): PassengerFormValues {
  return {
    givenName: passenger.givenName,
    familyName: passenger.familyName,
    title: passenger.title,
    gender: passenger.gender,
    bornOn: passenger.bornOn ?? "",
    email: passenger.email ?? "",
    phoneNumber: passenger.phoneNumber ?? ""
  };
}

export function PassengerForm({
  initial,
  busy,
  error,
  submitLabel,
  onSubmit
}: {
  initial: PassengerFormValues;
  busy: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (values: PassengerFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState(initial);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await onSubmit(values);
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <div className="form-grid two">
        <label>
          Given name
          <input
            required
            maxLength={40}
            value={values.givenName}
            onChange={(event) => setValues({ ...values, givenName: event.target.value })}
          />
        </label>
        <label>
          Family name
          <input
            required
            maxLength={40}
            value={values.familyName}
            onChange={(event) => setValues({ ...values, familyName: event.target.value })}
          />
        </label>
      </div>
      <p className="eyebrow" style={{ marginTop: 8 }}>Needed when you book</p>
      <div className="form-grid three">
        <label>
          Title
          <select
            value={values.title ?? ""}
            onChange={(event) => setValues({
              ...values,
              title: (event.target.value || null) as Passenger["title"]
            })}
          >
            <option value="">Optional</option>
            <option value="mr">Mr</option>
            <option value="ms">Ms</option>
            <option value="mrs">Mrs</option>
            <option value="miss">Miss</option>
            <option value="dr">Dr</option>
          </select>
        </label>
        <label>
          Gender
          <select
            value={values.gender ?? ""}
            onChange={(event) => setValues({
              ...values,
              gender: (event.target.value || null) as Passenger["gender"]
            })}
          >
            <option value="">Optional</option>
            <option value="m">Male</option>
            <option value="f">Female</option>
          </select>
        </label>
        <label>
          Date of birth
          <input
            type="date"
            value={values.bornOn}
            onChange={(event) => setValues({ ...values, bornOn: event.target.value })}
          />
        </label>
      </div>
      <div className="form-grid two">
        <label>
          Email
          <input
            type="email"
            value={values.email}
            onChange={(event) => setValues({ ...values, email: event.target.value })}
          />
        </label>
        <label>
          Phone
          <input
            type="tel"
            placeholder="+447700900123"
            value={values.phoneNumber}
            onChange={(event) => setValues({ ...values, phoneNumber: event.target.value })}
          />
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="save-button" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function readinessLabel(passenger: Pick<Passenger, "readyForBooking" | "bornOn">): string {
  if (passenger.readyForBooking) return "Ready";
  if (!passenger.bornOn) return "Needs date of birth";
  return "Needs booking details";
}

export function toPassengerPayload(values: PassengerFormValues) {
  return {
    givenName: values.givenName.trim(),
    familyName: values.familyName.trim(),
    title: values.title,
    gender: values.gender,
    bornOn: values.bornOn || null,
    email: values.email.trim() || null,
    phoneNumber: values.phoneNumber.trim() || null
  };
}
