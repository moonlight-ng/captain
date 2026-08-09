import type {
  CanonicalFlightPayload,
  LegSearchSnapshot,
  TravellerProfile,
  TripCityLeg,
  TripPayload
} from "./domain.js";

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

/**
 * One flight inside a trip. Keyed by itinerary rather than offer id so the link
 * survives the re-checks that mint fresh offer ids for the same flight.
 */
export function flightHref(tripId: string, itineraryKey: string, mode?: string): string {
  const path = `/trip/${encodeURIComponent(tripId)}/flight/${encodeURIComponent(itineraryKey)}`;
  return withAccess(mode ? `${path}?${new URLSearchParams({ mode }).toString()}` : path);
}

/** The canonical flight URL contains no private trip identity. */
export function canonicalFlightHref(flightKey: string): string {
  // Never carry a legacy bearer fragment onto a URL intended for sharing.
  return `/flight/${encodeURIComponent(flightKey)}`;
}

/** Results for one edge of a multi-city trip. */
export function tripLegHref(tripId: string, legId: string): string {
  return withAccess(`/trip/${encodeURIComponent(tripId)}/leg/${encodeURIComponent(legId)}`);
}

/**
 * The booking handoff for one flight. Captain does not sell fares, so this is
 * a page that says so and points at whoever does.
 */
export function bookHref(tripId: string, itineraryKey: string): string {
  return withAccess(
    `/trip/${encodeURIComponent(tripId)}/flight/${encodeURIComponent(itineraryKey)}/book`
  );
}

/** The home screen, where trips are curated. Not `/` — Eve owns that landing page. */
export function homeHref(): string {
  return withAccess("/trips");
}

/** The trip dashboard, or the settings for that one trip. */
export function tripHref(tripId?: string, view: "trip" | "settings" = "trip"): string {
  if (!tripId) return withAccess("/trip");
  const path = `/trip/${encodeURIComponent(tripId)}`;
  return withAccess(view === "settings" ? `${path}/settings` : path);
}

/** The account surface: notifications and flight preferences. Never scoped to a trip. */
export function profileHref(): string {
  return withAccess("/profile");
}

function withAccess(target: string): string {
  if (!accessToken) return target;
  return `${target}#${new URLSearchParams({ access: accessToken }).toString()}`;
}

export function getSession(): Promise<{
  authenticated: true;
  displayName: string;
  credential: "session" | "legacy-bearer";
}> {
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
    | "priceRiseAlertsEnabled"
    | "betterOptionAlertsEnabled"
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

export async function submitFeedback(text: string): Promise<{
  feedbackId: string;
  submittedAt: string;
}> {
  return api("/api/me/feedback", {
    method: "POST",
    body: JSON.stringify({ text })
  });
}

export function getTrip(tripId?: string): Promise<TripPayload> {
  const search = tripId ? `?${new URLSearchParams({ trip: tripId }).toString()}` : "";
  return api(`/api/me/trip${search}`);
}

export function startTripLegSearch(legId: string): Promise<LegSearchSnapshot> {
  return api(`/api/me/trip/legs/${encodeURIComponent(legId)}/searches`, {
    method: "POST",
    body: "{}"
  });
}

export function getTripLegSearch(
  legId: string,
  searchId: string
): Promise<LegSearchSnapshot> {
  return api(
    `/api/me/trip/legs/${encodeURIComponent(legId)}/searches/${encodeURIComponent(searchId)}`
  );
}

export async function selectTripLegFlight(
  legId: string,
  flightKey: string
): Promise<TripCityLeg> {
  const result = await api<TripCityLeg | { leg: TripCityLeg }>(
    `/api/me/trip/legs/${encodeURIComponent(legId)}/selection`,
    { method: "POST", body: JSON.stringify({ flightKey }) }
  );
  return "leg" in result ? result.leg : result;
}

export function getCanonicalFlight(flightKey: string): Promise<CanonicalFlightPayload> {
  return api(`/api/flights/${encodeURIComponent(flightKey)}`);
}

export async function tripAction(
  type: "pause" | "resume" | "refresh" | "track" | "cancel",
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

export async function updateTripTitle(
  tripId: string,
  expectedVersion: number,
  title: string
): Promise<void> {
  await api(`/api/me/trip?${new URLSearchParams({ trip: tripId }).toString()}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion, title })
  });
}

export async function setTripFlightSelection(
  tripId: string,
  itineraryKey: string,
  selected: boolean
): Promise<{ tripId: string; itineraryKey: string; selected: boolean }> {
  return api(`/api/me/trip/selections?${new URLSearchParams({ trip: tripId }).toString()}`, {
    method: "POST",
    body: JSON.stringify({ itineraryKey, selected })
  });
}

export async function deleteAccount(): Promise<void> {
  await api("/api/me/account", { method: "DELETE", body: "{}" });
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
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
