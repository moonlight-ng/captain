import { useState, type FormEvent } from "react";

import type { Passenger } from "../domain";

export type PassengerFormValues = {
  givenName: string;
  middleName: string;
  familyName: string;
  title: Passenger["title"];
  gender: Passenger["gender"];
  bornOn: string;
  email: string;
  phoneNumber: string;
  nationality: string;
  countryOfResidence: string;
  passportNumber: string;
  passportIssuingCountry: string;
  passportExpiresOn: string;
};

export function emptyPassengerForm(prefill?: {
  givenName?: string;
  familyName?: string;
}): PassengerFormValues {
  return {
    givenName: prefill?.givenName ?? "",
    middleName: "",
    familyName: prefill?.familyName ?? "",
    title: null,
    gender: null,
    bornOn: "",
    email: "",
    phoneNumber: "",
    nationality: "",
    countryOfResidence: "",
    passportNumber: "",
    passportIssuingCountry: "",
    passportExpiresOn: ""
  };
}

export function passengerToForm(passenger: Passenger): PassengerFormValues {
  return {
    givenName: passenger.givenName,
    middleName: passenger.middleName ?? "",
    familyName: passenger.familyName,
    title: passenger.title,
    gender: passenger.gender,
    bornOn: passenger.bornOn ?? "",
    email: passenger.email ?? "",
    phoneNumber: passenger.phoneNumber ?? "",
    nationality: passenger.nationality ?? "",
    countryOfResidence: passenger.countryOfResidence ?? "",
    passportNumber: "",
    passportIssuingCountry: passenger.passportIssuingCountry ?? "",
    passportExpiresOn: passenger.passportExpiresOn ?? ""
  };
}

export function PassengerForm({
  initial,
  existingPassportLast4,
  busy,
  error,
  submitLabel,
  onSubmit
}: {
  initial: PassengerFormValues;
  existingPassportLast4?: string | null;
  busy: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (values: PassengerFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState(initial);
  const [showPassport, setShowPassport] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await onSubmit(values);
  }

  return (
    <form className="traveller-form" onSubmit={(event) => void handleSubmit(event)}>
      <section className="form-section">
        <div className="form-section-heading">
          <div>
            <p className="eyebrow">Government ID name</p>
            <h2>Name and identity</h2>
          </div>
          <span className="required-note">Required to book</span>
        </div>
        <p className="set-note">Enter the name exactly as it appears on the ID used for travel.</p>
        <div className="form-grid three">
          <label>
            Given name
            <input
              required
              autoComplete="given-name"
              maxLength={40}
              value={values.givenName}
              onChange={(event) => setValues({ ...values, givenName: event.target.value })}
            />
          </label>
          <label>
            Middle name
            <input
              autoComplete="additional-name"
              maxLength={40}
              value={values.middleName}
              onChange={(event) => setValues({ ...values, middleName: event.target.value })}
            />
          </label>
          <label>
            Family name
            <input
              required
              autoComplete="family-name"
              maxLength={40}
              value={values.familyName}
              onChange={(event) => setValues({ ...values, familyName: event.target.value })}
            />
          </label>
        </div>
        <div className="form-grid three">
          <label>
            Title
            <select
              required
              value={values.title ?? ""}
              onChange={(event) => setValues({
                ...values,
                title: (event.target.value || null) as Passenger["title"]
              })}
            >
              <option value="">Choose</option>
              <option value="mr">Mr</option>
              <option value="ms">Ms</option>
              <option value="mrs">Mrs</option>
              <option value="miss">Miss</option>
              <option value="dr">Dr</option>
            </select>
          </label>
          <label>
            Gender on ID
            <select
              required
              value={values.gender ?? ""}
              onChange={(event) => setValues({
                ...values,
                gender: (event.target.value || null) as Passenger["gender"]
              })}
            >
              <option value="">Choose</option>
              <option value="m">Male</option>
              <option value="f">Female</option>
            </select>
          </label>
          <label>
            Date of birth
            <input
              required
              type="date"
              autoComplete="bday"
              value={values.bornOn}
              onChange={(event) => setValues({ ...values, bornOn: event.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-heading">
          <div>
            <p className="eyebrow">Contact</p>
            <h2>Booking contact</h2>
          </div>
          <span className="required-note">Required to book</span>
        </div>
        <div className="form-grid two">
          <label>
            Traveller email
            <input
              required
              type="email"
              autoComplete="email"
              value={values.email}
              onChange={(event) => setValues({ ...values, email: event.target.value })}
            />
          </label>
          <label>
            Mobile number
            <input
              required
              type="tel"
              autoComplete="tel"
              placeholder="+447700900123"
              value={values.phoneNumber}
              onChange={(event) => setValues({ ...values, phoneNumber: event.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="form-section secure-document-section">
        <div className="form-section-heading">
          <div>
            <p className="eyebrow">Travel document</p>
            <h2>Passport</h2>
          </div>
          <span className="secure-label">Encrypted</span>
        </div>
        <p className="set-note">
          Some international offers require passport details at booking. The number is encrypted at rest and only its last four characters are shown again.
        </p>
        <div className="form-grid two">
          <label>
            Nationality
            <input
              maxLength={2}
              placeholder="GB"
              value={values.nationality}
              onChange={(event) => setValues({ ...values, nationality: event.target.value.toUpperCase() })}
            />
          </label>
          <label>
            Country of residence
            <input
              maxLength={2}
              placeholder="GB"
              value={values.countryOfResidence}
              onChange={(event) => setValues({ ...values, countryOfResidence: event.target.value.toUpperCase() })}
            />
          </label>
        </div>
        <div className="form-grid three">
          <label className="passport-number-field">
            Passport number
            <span className="input-with-action">
              <input
                type={showPassport ? "text" : "password"}
                autoComplete="off"
                maxLength={20}
                placeholder={existingPassportLast4 ? `Saved •••• ${existingPassportLast4}` : "Enter passport number"}
                value={values.passportNumber}
                onChange={(event) => setValues({
                  ...values,
                  passportNumber: event.target.value.toUpperCase().replace(/[^A-Z0-9]/gu, "")
                })}
              />
              <button type="button" onClick={() => setShowPassport((current) => !current)}>
                {showPassport ? "Hide" : "Show"}
              </button>
            </span>
            {existingPassportLast4 && <small>Leave blank to keep the saved passport.</small>}
          </label>
          <label>
            Issuing country
            <input
              maxLength={2}
              placeholder="GB"
              value={values.passportIssuingCountry}
              onChange={(event) => setValues({
                ...values,
                passportIssuingCountry: event.target.value.toUpperCase()
              })}
            />
          </label>
          <label>
            Expiry date
            <input
              type="date"
              value={values.passportExpiresOn}
              onChange={(event) => setValues({ ...values, passportExpiresOn: event.target.value })}
            />
          </label>
        </div>
      </section>

      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="save-button" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

export function readinessLabel(passenger: Pick<
  Passenger,
  "readyForBooking" | "readyForInternationalTravel" | "bornOn"
>): string {
  if (passenger.readyForBooking && passenger.readyForInternationalTravel) return "International ready";
  if (passenger.readyForBooking) return "Booking ready";
  if (!passenger.bornOn) return "Needs date of birth";
  return "Needs booking details";
}

export function missingBookingDetails(passenger: Passenger): string[] {
  const missing: string[] = [];
  if (!passenger.givenName || !passenger.familyName) missing.push("government ID name");
  if (!passenger.title) missing.push("title");
  if (!passenger.gender) missing.push("gender");
  if (!passenger.bornOn) missing.push("date of birth");
  if (!passenger.email) missing.push("email");
  if (!passenger.phoneNumber) missing.push("phone");
  return missing;
}

export function toPassengerPayload(values: PassengerFormValues, keepSavedPassport = false) {
  return {
    givenName: values.givenName.trim(),
    middleName: values.middleName.trim() || null,
    familyName: values.familyName.trim(),
    title: values.title,
    gender: values.gender,
    bornOn: values.bornOn || null,
    email: values.email.trim() || null,
    phoneNumber: values.phoneNumber.trim() || null,
    nationality: values.nationality.trim().toUpperCase() || null,
    countryOfResidence: values.countryOfResidence.trim().toUpperCase() || null,
    ...(!keepSavedPassport || values.passportNumber
      ? { passportNumber: values.passportNumber.trim().toUpperCase() || null }
      : {}),
    passportIssuingCountry: values.passportIssuingCountry.trim().toUpperCase() || null,
    passportExpiresOn: values.passportExpiresOn || null
  };
}
