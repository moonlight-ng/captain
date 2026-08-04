import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { DELETE, GET, PATCH, POST, PUT, defineChannel } from "eve/channels";
import {
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  createPassengerSchema,
  passengerReadyForBooking,
  reservePaymentClientKeySchema,
  savePaymentMethodSchema,
  tripActionSchema,
  updatePassengerSchema,
  updateTripBriefSchema,
  updateTravellerProfileSchema
} from "@agents/flight-domain";
import {
  PaymentMethodLimitError,
  PaymentSetupConflictError,
  PaymentSetupInProgressError
} from "@agents/flight-store";
import { ZodError, z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import {
  legacyBearerAllowed,
  type ResolvedAuth
} from "../../services/auth/legacy-bearer.js";
import { DuffelCardsClient, DuffelCardsError } from "../../services/payments/duffel-cards.js";

const MAX_BODY_BYTES = 64 * 1024;
const clientKeyThrottle = new Map<string, { at: number; setupIntentId: string }>();
const CLIENT_KEY_THROTTLE_MS = 10_000;
export default defineChannel({
  kindHint: "captain-api",
  routes: [
    GET("/health", async () => Response.json({ status: "ok" })),
    GET("/ready", readiness),
    GET("/", serveIndex),
    GET("/trip", serveIndex),
    GET("/trip/:id", serveIndex),
    GET("/trip/:id/settings", serveIndex),
    GET("/trip/:id/flight/:itineraryKey", serveIndex),
    GET("/profile", serveIndex),
    GET("/settings", serveIndex),
    GET("/preferences", serveIndex),
    GET("/travellers", serveIndex),
    GET("/payment", serveIndex),
    GET("/auth/link", exchangeLoginLink),
    GET("/assets/:asset", serveAsset),
    GET("/api/auth/session", authenticated(sessionStatus)),
    GET("/api/me/profile", authenticated(getProfile)),
    PATCH("/api/me/profile", authenticatedMutation(updateProfile)),
    GET("/api/me/trip", authenticated(getTrip)),
    PATCH("/api/me/trip", authenticatedMutation(updateTrip)),
    POST("/api/me/trip/actions", authenticatedMutation(tripAction)),
    POST("/api/me/trip/selections", authenticatedMutation(setTripSelection)),
    PUT("/api/me/trip/travellers", authenticatedMutation(requireSession(setTripTravellers))),
    GET("/api/me/passengers", authenticated(requireSession(listPassengers))),
    POST("/api/me/passengers", authenticatedMutation(requireSession(createPassenger))),
    PATCH("/api/me/passengers/:id", authenticatedMutation(requireSession(updatePassenger))),
    DELETE("/api/me/passengers/:id", authenticatedMutation(requireSession(deletePassenger))),
    POST("/api/me/passengers/:id/default", authenticatedMutation(requireSession(setDefaultPassenger))),
    POST("/api/me/payments/client-key", authenticatedMutation(requireSession(createPaymentClientKey))),
    GET("/api/me/payments/cards", authenticated(requireSession(listPaymentCards))),
    POST("/api/me/payments/cards", authenticatedMutation(requireSession(savePaymentCard))),
    DELETE("/api/me/payments/cards/:id", authenticatedMutation(requireSession(deletePaymentCard))),
    DELETE("/api/me/account", authenticatedMutation(requireSession(deleteAccount)))
  ]
});

type RouteContext = { params: Readonly<Record<string, string>> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;
type UserHandler = (
  request: Request,
  context: RouteContext,
  userId: string,
  auth: ResolvedAuth
) => Promise<Response>;

function safely(handler: Handler): Handler {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ZodError) {
        return Response.json({ error: "invalid_request", issues: error.issues }, { status: 400 });
      }
      if (error instanceof TripVersionConflictError) {
        return Response.json(
          { error: "version_conflict", currentVersion: error.currentVersion },
          { status: 409 }
        );
      }
      if (error instanceof TripNotFoundError) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (error instanceof TripLimitError) {
        return Response.json({ error: "trip_limit", limit: 3 }, { status: 409 });
      }
      if (error instanceof PaymentSetupInProgressError) {
        return Response.json({ error: "setup_in_progress" }, { status: 409 });
      }
      if (error instanceof PaymentMethodLimitError) {
        return Response.json({ error: "payment_method_limit", limit: error.limit }, { status: 409 });
      }
      if (error instanceof PaymentSetupConflictError) {
        return Response.json({ error: error.code }, { status: 409 });
      }
      if (error instanceof Error && error.message === "body_too_large") {
        return Response.json({ error: "body_too_large" }, { status: 413 });
      }
      console.error(JSON.stringify({
        event: "captain.api_error",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

function authenticated(handler: UserHandler): Handler {
  return safely(async (request, context) => {
    const services = await getCaptainServices();
    const auth = await services.auth.resolve(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const pathname = new URL(request.url).pathname;
    if (auth.credential === "legacy-bearer" && !legacyBearerAllowed(request.method, pathname)) {
      return Response.json({ error: "session_required" }, { status: 403 });
    }
    const user = await services.platformStore.getUser(auth.userId);
    if (!user || user.status !== "active") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return handler(request, context, auth.userId, auth);
  });
}

function authenticatedMutation(handler: UserHandler): Handler {
  return authenticated(async (request, context, userId, auth) => {
    const services = await getCaptainServices();
    // Cookie sessions make a missing Origin exploitable (cross-site POSTs without
    // Origin used to pass). SameSite=Lax + mandatory Origin match + JSON-only bodies
    // + no CORS + no state-changing GETs is sufficient — no double-submit token.
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(services.env.publicUrl).origin) {
      return Response.json({ error: "invalid_origin" }, { status: 403 });
    }
    return handler(request, context, userId, auth);
  });
}

function requireSession(handler: UserHandler): UserHandler {
  return async (request, context, userId, auth) => {
    if (auth.credential !== "session") {
      return Response.json({ error: "session_required" }, { status: 403 });
    }
    return handler(request, context, userId, auth);
  };
}

async function exchangeLoginLink(request: Request): Promise<Response> {
  const services = await getCaptainServices();
  const raw = new URL(request.url).searchParams.get("t")?.trim() ?? "";
  const exchanged = raw ? await services.auth.exchangeLoginToken(raw) : null;
  if (!exchanged) {
    return Response.redirect(new URL("/?e=expired", services.env.publicUrl).toString(), 302);
  }
  const location = services.auth.redirectAfterLogin(exchanged.redirectPath, request.url);
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": services.auth.sessionCookieHeader(exchanged.sessionRaw),
      "referrer-policy": "no-referrer",
      "cache-control": "no-store"
    }
  });
}

async function readiness(): Promise<Response> {
  try {
    const services = await getCaptainServices();
    return Response.json({
      status: "ready",
      storage: services.env.databaseUrl ? "postgres" : "memory"
    });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

async function sessionStatus(
  _request: Request,
  _context: RouteContext,
  userId: string,
  auth: ResolvedAuth
): Promise<Response> {
  const services = await getCaptainServices();
  const user = await services.platformStore.getUser(userId);
  return Response.json(
    {
      authenticated: true,
      displayName: user?.displayName ?? "",
      paymentsEnabled: services.env.paymentsEnabled,
      credential: auth.credential
    },
    { headers: noStore() }
  );
}

async function getProfile(
  _request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const profile = await services.platformStore.ensureProfile(userId, new Date());
  const user = await services.platformStore.getUser(userId);
  return Response.json({
    profile: { ...profile, timeZone: user?.timezone ?? "UTC" }
  }, { headers: noStore() });
}

async function updateProfile(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const body = z.record(z.string(), z.unknown()).parse(await requestJson(request));
  const timeZone = body.timeZone === undefined
    ? null
    : validTimeZone(z.string().trim().min(1).max(100).parse(body.timeZone));
  const profileBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "timeZone")
  );
  if (!timeZone && Object.keys(profileBody).length === 0) {
    throw new ZodError([{ code: "custom", path: [], message: "At least one preference must be updated" }]);
  }
  const now = new Date();
  const [profile, user] = await Promise.all([
    Object.keys(profileBody).length > 0
      ? services.platformStore.updateProfile(
          userId,
          updateTravellerProfileSchema.parse(profileBody),
          now
        )
      : services.platformStore.ensureProfile(userId, now),
    timeZone
      ? services.platformStore.updateUserTimezone(userId, timeZone, now)
      : services.platformStore.getUser(userId)
  ]);
  return Response.json({
    profile: { ...profile, timeZone: user?.timezone ?? "UTC" }
  }, { headers: noStore() });
}

async function getTrip(
  request: Request,
  _context: RouteContext,
  userId: string,
  auth: ResolvedAuth
): Promise<Response> {
  const services = await getCaptainServices();
  const trips = (await services.platformStore.listTrips(userId))
    .filter((trip) => !["cancelled", "completed", "archived"].includes(trip.status));
  const requestedTripId = new URL(request.url).searchParams.get("trip");
  const trip = requestedTripId
    ? trips.find((candidate) => candidate.id === requestedTripId) ?? null
    : await services.platformStore.getActiveTrip(userId);
  if (requestedTripId && !trip) throw new TripNotFoundError();
  if (!trip) {
    return Response.json(
      {
        trips,
        trip: null,
        watch: null,
        offers: [],
        recommendation: null,
        selections: [],
        activity: [],
        travellers: []
      },
      { headers: noStore() }
    );
  }
  await services.platformStore.markTripActivity(userId, trip.id, new Date());
  const [watch, offers, recommendation, selections, activity, travellers] = await Promise.all([
    services.platformStore.getWatch(userId, trip.id),
    services.trips.offers(userId, trip.id),
    services.platformStore.getRecommendation(userId, trip.id),
    services.platformStore.listTripFlightSelections(userId, trip.id),
    services.platformStore.listTripActivity(userId, trip.id),
    auth.credential === "session"
      ? services.platformStore.listTripPassengers(userId, trip.id)
      : Promise.resolve([])
  ]);
  return Response.json(
    {
      trips,
      trip,
      watch,
      offers,
      recommendation,
      selections,
      activity,
      travellers: travellers.map((passenger) => ({
        ...passenger,
        readyForBooking: passengerReadyForBooking(passenger)
      }))
    },
    { headers: noStore() }
  );
}

async function updateTrip(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const requestedTripId = new URL(request.url).searchParams.get("trip");
  if (!requestedTripId) throw new TripNotFoundError();
  const trip = await services.platformStore.getTrip(userId, requestedTripId);
  if (!trip || ["cancelled", "completed", "archived"].includes(trip.status)) {
    throw new TripNotFoundError();
  }
  const update = updateTripBriefSchema.parse(await requestJson(request));
  const updated = await services.trips.update(userId, trip.id, update);
  return Response.json({ trip: updated }, { headers: noStore() });
}

async function tripAction(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const requestedTripId = new URL(request.url).searchParams.get("trip");
  const trip = requestedTripId
    ? await services.platformStore.getTrip(userId, requestedTripId)
    : await services.platformStore.getActiveTrip(userId);
  if (!trip) throw new TripNotFoundError();
  if (["cancelled", "completed", "archived"].includes(trip.status)) throw new TripNotFoundError();
  const action = tripActionSchema.parse(await requestJson(request));
  const updated = await services.trips.action(userId, trip.id, action);
  return Response.json({ trip: updated }, { status: 202, headers: noStore() });
}

async function setTripSelection(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const requestedTripId = new URL(request.url).searchParams.get("trip");
  const trip = requestedTripId
    ? await services.platformStore.getTrip(userId, requestedTripId)
    : await services.platformStore.getActiveTrip(userId);
  if (!trip) throw new TripNotFoundError();
  if (["cancelled", "completed", "archived"].includes(trip.status)) throw new TripNotFoundError();
  const body = z.object({
    itineraryKey: z.string().trim().min(1).max(500),
    selected: z.boolean()
  }).strict().parse(await requestJson(request));
  const result = await services.trips.selectFlight(
    userId,
    trip.id,
    body.itineraryKey,
    body.selected
  );
  if (!result) throw new TripNotFoundError();
  return Response.json(result, { headers: noStore() });
}

async function setTripTravellers(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const tripId = new URL(request.url).searchParams.get("trip");
  if (!tripId) throw new TripNotFoundError();
  const body = z.object({
    passengerIds: z.array(z.uuid()).max(8)
  }).strict().parse(await requestJson(request));
  await services.platformStore.setTripPassengers(userId, tripId, body.passengerIds);
  const passengers = await services.platformStore.listTripPassengers(userId, tripId);
  return Response.json({
    passengers: passengers.map((passenger) => ({
      ...passenger,
      readyForBooking: passengerReadyForBooking(passenger)
    }))
  }, { headers: noStore() });
}

async function listPassengers(
  _request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const passengers = await services.platformStore.listPassengers(userId);
  return Response.json({
    passengers: passengers.map((passenger) => ({
      ...passenger,
      readyForBooking: passengerReadyForBooking(passenger)
    }))
  }, { headers: noStore() });
}

async function createPassenger(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const input = createPassengerSchema.parse(await requestJson(request));
  const passenger = await services.platformStore.createPassenger(userId, input, new Date());
  return Response.json({
    passenger: { ...passenger, readyForBooking: passengerReadyForBooking(passenger) }
  }, { status: 201, headers: noStore() });
}

async function updatePassenger(
  request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const input = updatePassengerSchema.parse(await requestJson(request));
  const passenger = await services.platformStore.updatePassenger(
    userId,
    context.params.id!,
    input,
    new Date()
  );
  return Response.json({
    passenger: { ...passenger, readyForBooking: passengerReadyForBooking(passenger) }
  }, { headers: noStore() });
}

async function deletePassenger(
  _request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  await services.platformStore.deletePassenger(userId, context.params.id!);
  return Response.json({ deleted: true }, { headers: noStore() });
}

async function setDefaultPassenger(
  _request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const passenger = await services.platformStore.setDefaultPassenger(
    userId,
    context.params.id!,
    new Date()
  );
  return Response.json({
    passenger: { ...passenger, readyForBooking: passengerReadyForBooking(passenger) }
  }, { headers: noStore() });
}

async function createPaymentClientKey(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  if (!services.env.paymentsEnabled) {
    return Response.json({ error: "payments_disabled" }, { status: 503 });
  }
  const body = reservePaymentClientKeySchema.parse(await requestJson(request));
  const client = duffelCardsClient(services.env);
  if (!client) {
    return Response.json({ error: "payments_unavailable" }, { status: 503 });
  }
  const last = clientKeyThrottle.get(userId);
  const now = Date.now();
  if (
    last
    && last.setupIntentId !== body.setupIntentId
    && now - last.at < CLIENT_KEY_THROTTLE_MS
  ) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    const issued = await services.platformStore.issuePaymentCardSetupClientKey(
      userId,
      body.setupIntentId,
      () => client.createComponentClientKey(),
      new Date()
    );
    clientKeyThrottle.set(userId, { at: now, setupIntentId: issued.setupIntentId });
    return Response.json({
      clientKey: issued.clientKey,
      setupIntentId: issued.setupIntentId
    }, { headers: noStore() });
  } catch (error) {
    if (error instanceof DuffelCardsError) {
      return Response.json({ error: error.code }, { status: statusForCardsError(error.code) });
    }
    throw error;
  }
}

async function listPaymentCards(
  _request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  if (!services.env.paymentsEnabled) {
    return Response.json({ error: "payments_disabled" }, { status: 503 });
  }
  const methods = await services.platformStore.listPaymentMethods(userId);
  return Response.json({
    cards: methods.map((method) => ({
      id: method.id,
      brand: method.brand,
      last4: method.last4,
      cardholderName: method.cardholderName,
      isDefault: method.isDefault
    }))
  }, { headers: noStore() });
}

async function savePaymentCard(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  if (!services.env.paymentsEnabled) {
    return Response.json({ error: "payments_disabled" }, { status: 503 });
  }
  const input = savePaymentMethodSchema.parse(await requestJson(request));
  const method = await services.platformStore.finalizePaymentMethod(userId, input, new Date());
  return Response.json({
    card: {
      id: method.id,
      brand: method.brand,
      last4: method.last4,
      cardholderName: method.cardholderName,
      isDefault: method.isDefault
    }
  }, { status: 201, headers: noStore() });
}

async function deletePaymentCard(
  _request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  if (!services.env.paymentsEnabled) {
    return Response.json({ error: "payments_disabled" }, { status: 503 });
  }
  const methods = await services.platformStore.listPaymentMethods(userId);
  const method = methods.find((candidate) => candidate.id === context.params.id);
  if (!method) return Response.json({ error: "not_found" }, { status: 404 });
  await services.platformStore.removePaymentMethod(userId, method.id, new Date());
  return Response.json({ deletion: "queued" }, { status: 202, headers: noStore() });
}

function duffelCardsClient(env: {
  duffelAccessToken: string | null;
  duffelBaseUrl: string;
  duffelCardsBaseUrl: string;
}): DuffelCardsClient | null {
  if (!env.duffelAccessToken) return null;
  return new DuffelCardsClient({
    accessToken: env.duffelAccessToken,
    baseUrl: env.duffelBaseUrl,
    cardsBaseUrl: env.duffelCardsBaseUrl
  });
}

function statusForCardsError(code: DuffelCardsError["code"]): number {
  switch (code) {
    case "unauthorized": return 401;
    case "invalid_request": return 422;
    case "rate_limited": return 429;
    case "not_found": return 404;
    default: return 502;
  }
}

async function deleteAccount(
  _request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  await services.auth.signOut(userId);
  await services.platformStore.deleteUser(userId);
  return Response.json({ deleted: true }, { headers: noStore() });
}

async function serveIndex(): Promise<Response> {
  try {
    return new Response(await readFile(resolve("dist/index.html")), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
    });
  } catch {
    return new Response("Captain UI has not been built", { status: 503 });
  }
}

async function serveAsset(
  _request: Request,
  context: RouteContext
): Promise<Response> {
  const asset = context.params.asset;
  if (!asset || !/^[a-zA-Z0-9._-]+$/u.test(asset)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    return new Response(await readFile(resolve("dist/assets", asset)), {
      headers: {
        "content-type": contentType(asset),
        "cache-control": "public, max-age=31536000, immutable"
      }
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function requestJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("body_too_large");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("body_too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ZodError([{ code: "custom", path: [], message: "Request body must be valid JSON" }]);
  }
}

function noStore(): HeadersInit {
  return { "cache-control": "no-store" };
}

function validTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(new Date());
    return value;
  } catch {
    throw new ZodError([{
      code: "custom",
      path: ["timeZone"],
      message: "Invalid IANA timezone"
    }]);
  }
}

function contentType(file: string): string {
  return ({
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
}
