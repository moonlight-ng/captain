import type { AdminAutomationState } from "@agents/flight-domain/admin";

export function automationPurposeLabel(purpose: AdminAutomationState["purpose"]): string {
  return purpose === "fare_digest" ? "Daily fare digest" : "Price tracking";
}

export function automationStatusLabel(automation: Pick<AdminAutomationState, "purpose" | "status">): string {
  const subject = automation.purpose === "fare_digest" ? "Daily digest" : "Price tracking";
  const status = automation.status === "completed" ? "complete" : automation.status;
  return `${subject} ${status}`;
}

export function automationScheduleLabel(
  automation: Pick<AdminAutomationState, "purpose" | "digestHourLocal" | "digestTimeZone">
): string {
  if (
    automation.purpose === "fare_digest"
    && automation.digestHourLocal !== null
    && automation.digestTimeZone
  ) {
    return `Daily at ${String(automation.digestHourLocal).padStart(2, "0")}:00 · ${automation.digestTimeZone}`;
  }
  return "Every 24 hours";
}

export function tripResultStatusLabel(status: string): string {
  if (status === "recommended") return "Recommendation ready";
  return humanize(status);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
