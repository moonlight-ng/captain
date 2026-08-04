import { z } from "zod";

const passengerNameSchema = z.string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^0-9]+$/u, "Names must not contain digits");

const passengerTitleSchema = z.enum(["mr", "ms", "mrs", "miss", "dr"]);
const passengerGenderSchema = z.enum(["m", "f"]);
const countryCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/u, "Use a 2-letter country code");
const passportNumberSchema = z.string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{5,20}$/u, "Passport number must be 5–20 letters or digits");

const bornOnSchema = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  if (year < 1900) return false;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return date.getTime() < todayUtc;
}, { message: "Date of birth must be past-dated and after 1900" });

const phoneNumberSchema = z.string().regex(/^\+[1-9]\d{6,14}$/u, "Phone must be E.164");

export const passengerSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  givenName: passengerNameSchema,
  middleName: passengerNameSchema.nullable(),
  familyName: passengerNameSchema,
  title: passengerTitleSchema.nullable(),
  gender: passengerGenderSchema.nullable(),
  bornOn: z.iso.date().nullable(),
  email: z.email().nullable(),
  phoneNumber: phoneNumberSchema.nullable(),
  nationality: countryCodeSchema.nullable(),
  countryOfResidence: countryCodeSchema.nullable(),
  passportLast4: z.string().regex(/^[A-Z0-9]{4}$/u).nullable(),
  passportIssuingCountry: countryCodeSchema.nullable(),
  passportExpiresOn: z.iso.date().nullable(),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export type Passenger = z.infer<typeof passengerSchema>;

export const createPassengerSchema = z.object({
  givenName: passengerNameSchema,
  middleName: passengerNameSchema.nullable().optional(),
  familyName: passengerNameSchema,
  title: passengerTitleSchema.nullable().optional(),
  gender: passengerGenderSchema.nullable().optional(),
  bornOn: bornOnSchema.nullable().optional(),
  email: z.email().nullable().optional(),
  phoneNumber: phoneNumberSchema.nullable().optional(),
  nationality: countryCodeSchema.nullable().optional(),
  countryOfResidence: countryCodeSchema.nullable().optional(),
  passportNumber: passportNumberSchema.nullable().optional(),
  passportIssuingCountry: countryCodeSchema.nullable().optional(),
  passportExpiresOn: z.iso.date().nullable().optional(),
  isDefault: z.boolean().optional()
}).strict();
export type CreatePassengerInput = z.infer<typeof createPassengerSchema>;

export const updatePassengerSchema = z.object({
  givenName: passengerNameSchema.optional(),
  middleName: passengerNameSchema.nullable().optional(),
  familyName: passengerNameSchema.optional(),
  title: passengerTitleSchema.nullable().optional(),
  gender: passengerGenderSchema.nullable().optional(),
  bornOn: bornOnSchema.nullable().optional(),
  email: z.email().nullable().optional(),
  phoneNumber: phoneNumberSchema.nullable().optional(),
  nationality: countryCodeSchema.nullable().optional(),
  countryOfResidence: countryCodeSchema.nullable().optional(),
  passportNumber: passportNumberSchema.nullable().optional(),
  passportIssuingCountry: countryCodeSchema.nullable().optional(),
  passportExpiresOn: z.iso.date().nullable().optional(),
  isDefault: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one passenger field must be updated"
});
export type UpdatePassengerInput = z.infer<typeof updatePassengerSchema>;

export const paymentCardBrandSchema = z.enum([
  "visa",
  "mastercard",
  "uatp",
  "american_express",
  "diners_club",
  "jcb",
  "discover"
]);
export type PaymentCardBrand = z.infer<typeof paymentCardBrandSchema>;

export const paymentMethodSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  provider: z.literal("duffel"),
  providerCardId: z.string().min(1).max(128),
  brand: paymentCardBrandSchema,
  last4: z.string().regex(/^\d{4}$/u),
  cardholderName: z.string().min(1).max(100),
  status: z.enum(["active", "removed"]),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const savePaymentMethodSchema = z.object({
  setupIntentId: z.uuid(),
  cardId: z.string().regex(/^tcd_[A-Za-z0-9]+$/u).max(128),
  brand: paymentCardBrandSchema,
  last4: z.string().regex(/^\d{4}$/u),
  cardholderName: z.string().trim().min(1).max(100)
}).strict();
export type SavePaymentMethodInput = z.infer<typeof savePaymentMethodSchema>;

export const reservePaymentClientKeySchema = z.object({
  setupIntentId: z.uuid()
}).strict();
export type ReservePaymentClientKeyInput = z.infer<typeof reservePaymentClientKeySchema>;

export type PaymentCardSetupIntent = {
  id: string;
  userId: string;
  status: "pending" | "completed" | "expired";
  paymentMethodId: string | null;
  /** Cached Duffel component key for this pending intent. Never mint a second key. */
  componentClientKey: string | null;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentCardDeletion = {
  id: string;
  provider: "duffel";
  providerCardId: string;
  paymentMethodId: string | null;
  status: "queued" | "running" | "failed";
  attempts: number;
  availableAt: string;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Single source of truth for passenger completeness before booking. */
export function passengerReadyForBooking(passenger: Pick<
  Passenger,
  "givenName" | "familyName" | "title" | "gender" | "bornOn" | "email" | "phoneNumber"
>): boolean {
  return Boolean(
    passenger.givenName.trim()
    && passenger.familyName.trim()
    && passenger.title
    && passenger.gender
    && passenger.bornOn
    && passenger.email
    && passenger.phoneNumber
  );
}

/** Passport data is offer-dependent, so it is tracked separately from core booking readiness. */
export function passengerReadyForInternationalTravel(passenger: Pick<
  Passenger,
  | "nationality"
  | "countryOfResidence"
  | "passportLast4"
  | "passportIssuingCountry"
  | "passportExpiresOn"
>): boolean {
  return Boolean(
    passenger.nationality
    && passenger.countryOfResidence
    && passenger.passportLast4
    && passenger.passportIssuingCountry
    && passenger.passportExpiresOn
    && Date.parse(`${passenger.passportExpiresOn}T23:59:59.999Z`) > Date.now()
  );
}
