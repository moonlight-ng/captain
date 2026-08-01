import { z } from "zod";

const passengerNameSchema = z.string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^0-9]+$/u, "Names must not contain digits");

const passengerTitleSchema = z.enum(["mr", "ms", "mrs", "miss", "dr"]);
const passengerGenderSchema = z.enum(["m", "f"]);

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
  familyName: passengerNameSchema,
  title: passengerTitleSchema.nullable(),
  gender: passengerGenderSchema.nullable(),
  bornOn: z.iso.date().nullable(),
  email: z.email().nullable(),
  phoneNumber: phoneNumberSchema.nullable(),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export type Passenger = z.infer<typeof passengerSchema>;

export const createPassengerSchema = z.object({
  givenName: passengerNameSchema,
  familyName: passengerNameSchema,
  title: passengerTitleSchema.nullable().optional(),
  gender: passengerGenderSchema.nullable().optional(),
  bornOn: bornOnSchema.nullable().optional(),
  email: z.email().nullable().optional(),
  phoneNumber: phoneNumberSchema.nullable().optional(),
  isDefault: z.boolean().optional()
}).strict();
export type CreatePassengerInput = z.infer<typeof createPassengerSchema>;

export const updatePassengerSchema = z.object({
  givenName: passengerNameSchema.optional(),
  familyName: passengerNameSchema.optional(),
  title: passengerTitleSchema.nullable().optional(),
  gender: passengerGenderSchema.nullable().optional(),
  bornOn: bornOnSchema.nullable().optional(),
  email: z.email().nullable().optional(),
  phoneNumber: phoneNumberSchema.nullable().optional(),
  isDefault: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one passenger field must be updated"
});
export type UpdatePassengerInput = z.infer<typeof updatePassengerSchema>;

export const paymentMethodSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  provider: z.literal("duffel"),
  providerCardId: z.string().min(1),
  brand: z.string().min(1),
  last4: z.string().regex(/^\d{4}$/u),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000),
  cardholderName: z.string().min(1),
  status: z.enum(["active", "removed"]),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const savePaymentMethodSchema = z.object({
  cardId: z.string().regex(/^tcd_[A-Za-z0-9]+$/u),
  brand: z.string().min(1),
  last4: z.string().regex(/^\d{4}$/u),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000),
  cardholderName: z.string().min(1)
}).strict();
export type SavePaymentMethodInput = z.infer<typeof savePaymentMethodSchema>;

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
