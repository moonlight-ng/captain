import type { TravellerProfile, TripPayload, Passenger, PaymentMethod } from "./domain";

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

export function accessHref(path: "/trip" | "/settings", tripId?: string): string {
  const search = tripId ? `?${new URLSearchParams({ trip: tripId }).toString()}` : "";
  if (!accessToken) return `${path}${search}`;
  return `${path}${search}#${new URLSearchParams({ access: accessToken }).toString()}`;
}

export function getSession(): Promise<{
  authenticated: true;
  displayName: string;
  paymentsEnabled: boolean;
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

export async function listPassengers(): Promise<Passenger[]> {
  return (await api<{ passengers: Passenger[] }>("/api/me/passengers")).passengers;
}

export async function createPassenger(
  input: Omit<Passenger, "id" | "userId" | "readyForBooking" | "createdAt" | "updatedAt" | "isDefault"> & {
    isDefault?: boolean;
  }
): Promise<Passenger> {
  return (await api<{ passenger: Passenger }>("/api/me/passengers", {
    method: "POST",
    body: JSON.stringify(input)
  })).passenger;
}

export async function updatePassenger(
  id: string,
  input: Partial<Pick<
    Passenger,
    "givenName" | "familyName" | "title" | "gender" | "bornOn" | "email" | "phoneNumber" | "isDefault"
  >>
): Promise<Passenger> {
  return (await api<{ passenger: Passenger }>(`/api/me/passengers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  })).passenger;
}

export async function deletePassenger(id: string): Promise<void> {
  await api(`/api/me/passengers/${id}`, { method: "DELETE", body: "{}" });
}

export async function setDefaultPassenger(id: string): Promise<Passenger> {
  return (await api<{ passenger: Passenger }>(`/api/me/passengers/${id}/default`, {
    method: "POST",
    body: "{}"
  })).passenger;
}

export async function setTripTravellers(
  tripId: string,
  passengerIds: string[]
): Promise<Passenger[]> {
  return (await api<{ passengers: Passenger[] }>(
    `/api/me/trip/travellers?${new URLSearchParams({ trip: tripId }).toString()}`,
    {
      method: "PUT",
      body: JSON.stringify({ passengerIds })
    }
  )).passengers;
}

export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  return (await api<{ cards: PaymentMethod[] }>("/api/me/payments/cards")).cards;
}

export async function createPaymentClientKey(setupIntentId: string): Promise<{
  clientKey: string;
  setupIntentId: string;
}> {
  return api("/api/me/payments/client-key", {
    method: "POST",
    body: JSON.stringify({ setupIntentId })
  });
}

export async function savePaymentMethod(input: {
  setupIntentId: string;
  cardId: string;
  brand: string;
  last4: string;
  cardholderName: string;
}): Promise<PaymentMethod> {
  return (await api<{ card: PaymentMethod }>("/api/me/payments/cards", {
    method: "POST",
    body: JSON.stringify(input)
  })).card;
}

export async function removePaymentMethod(id: string): Promise<void> {
  await api(`/api/me/payments/cards/${id}`, { method: "DELETE", body: "{}" });
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
