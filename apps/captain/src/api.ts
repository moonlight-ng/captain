import type { TravellerProfile, TripPayload } from "./domain";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

let accessToken = "";

export function initializeAccessToken(): boolean {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("access");
  accessToken = token?.trim() ?? "";
  return Boolean(accessToken);
}

export function accessHref(path: "/trip" | "/preferences", tripId?: string): string {
  const search = tripId ? `?${new URLSearchParams({ trip: tripId }).toString()}` : "";
  if (!accessToken) return `${path}${search}`;
  return `${path}${search}#${new URLSearchParams({ access: accessToken }).toString()}`;
}

export function getSession(): Promise<{ authenticated: true; displayName: string }> {
  return api("/api/auth/session");
}

export async function getProfile(): Promise<TravellerProfile> {
  return (await api<{ profile: TravellerProfile }>("/api/me/profile")).profile;
}

export async function updateProfile(
  update: Pick<
    TravellerProfile,
    | "timeZone"
    | "defaultCurrency"
    | "rankingMode"
    | "preferredAirlineCodes"
    | "excludedAirlineCodes"
    | "alertsEnabled"
    | "notificationMode"
    | "digestHourLocal"
    | "priceRiseAlertsEnabled"
    | "betterOptionAlertsEnabled"
    | "trackingCheckinsEnabled"
    | "maxAlertsPerDay"
    | "quietHoursEnabled"
    | "quietHoursStart"
    | "quietHoursEnd"
  >
): Promise<TravellerProfile> {
  return (await api<{ profile: TravellerProfile }>("/api/me/profile", {
    method: "PATCH",
    body: JSON.stringify(update)
  })).profile;
}

export function getTrip(tripId?: string): Promise<TripPayload> {
  const search = tripId ? `?${new URLSearchParams({ trip: tripId }).toString()}` : "";
  return api(`/api/me/trip${search}`);
}

export async function tripAction(
  type: "pause" | "resume" | "refresh" | "cancel",
  tripId: string,
  expectedVersion: number
): Promise<void> {
  await api(`/api/me/trip/actions?${new URLSearchParams({ trip: tripId }).toString()}`, {
    method: "POST",
    body: JSON.stringify({ type, expectedVersion })
  });
}

export async function updateTripBrief(
  tripId: string,
  expectedVersion: number,
  brief: NonNullable<TripPayload["trip"]>["brief"]
): Promise<void> {
  await api(`/api/me/trip?${new URLSearchParams({ trip: tripId }).toString()}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion, brief })
  });
}

export async function deleteAccount(): Promise<void> {
  await api("/api/me/account", { method: "DELETE", body: "{}" });
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `Request failed (${response.status})`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}
