import { z } from "zod";

export const rankingModeSchema = z.enum(["cheapest", "balanced", "fastest"]);
export type RankingMode = z.infer<typeof rankingModeSchema>;
export const notificationModeSchema = z.enum(["smart", "daily", "changes_only", "off"]);
export type NotificationMode = z.infer<typeof notificationModeSchema>;

export const airlineCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/u);
export const currencyCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u);

export const travellerProfileSchema = z.object({
  userId: z.uuid(),
  defaultCurrency: currencyCodeSchema,
  rankingMode: rankingModeSchema,
  preferredAirlineCodes: z.array(airlineCodeSchema).max(12),
  excludedAirlineCodes: z.array(airlineCodeSchema).max(12),
  alertsEnabled: z.boolean(),
  notificationMode: notificationModeSchema,
  digestHourLocal: z.number().int().min(0).max(23),
  priceRiseAlertsEnabled: z.boolean(),
  betterOptionAlertsEnabled: z.boolean(),
  trackingCheckinsEnabled: z.boolean(),
  maxAlertsPerDay: z.number().int().min(1).max(2),
  quietHoursEnabled: z.boolean(),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  onboardingCompletedAt: z.iso.datetime().nullable(),
  onboardingStep: z.enum(["welcome", "currency", "ranking", "airlines", "complete"]),
  travellerSetupPromptedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export type TravellerProfile = z.infer<typeof travellerProfileSchema>;

export const updateTravellerProfileSchema = z.object({
  defaultCurrency: currencyCodeSchema.optional(),
  rankingMode: rankingModeSchema.optional(),
  preferredAirlineCodes: z.array(airlineCodeSchema).max(12).optional(),
  excludedAirlineCodes: z.array(airlineCodeSchema).max(12).optional(),
  alertsEnabled: z.boolean().optional(),
  notificationMode: notificationModeSchema.optional(),
  digestHourLocal: z.number().int().min(0).max(23).optional(),
  priceRiseAlertsEnabled: z.boolean().optional(),
  betterOptionAlertsEnabled: z.boolean().optional(),
  trackingCheckinsEnabled: z.boolean().optional(),
  maxAlertsPerDay: z.number().int().min(1).max(2).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: z.number().int().min(0).max(23).optional(),
  quietHoursEnd: z.number().int().min(0).max(23).optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one preference must be updated"
});
export type UpdateTravellerProfile = z.infer<typeof updateTravellerProfileSchema>;

export const DEFAULT_PROFILE = {
  defaultCurrency: "USD",
  rankingMode: "balanced",
  preferredAirlineCodes: [],
  excludedAirlineCodes: [],
  alertsEnabled: true,
  notificationMode: "smart",
  digestHourLocal: 9,
  priceRiseAlertsEnabled: true,
  betterOptionAlertsEnabled: true,
  trackingCheckinsEnabled: true,
  maxAlertsPerDay: 1,
  quietHoursEnabled: true,
  quietHoursStart: 22,
  quietHoursEnd: 7
} as const;
