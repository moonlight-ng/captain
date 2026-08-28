import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { DELETE, GET, PATCH, POST, defineChannel } from "eve/channels";
import {
  type AdminCostRange,
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  formatTripGoal,
  tripGoalState,
  tripActionSchema,
  updateTripBriefSchema,
  updateTripTitleSchema,
  updateTravellerProfileSchema
} from "@agents/flight-domain";
import { ZodError, z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import {
  CAPTAIN_ARCHIVED_ERROR,
  CAPTAIN_ARCHIVED_MESSAGE,
  isCaptainArchivedMode
} from "../../services/app/archive.js";
import {
  FeedbackBridgeUnavailableError,
  FeedbackDeliveryError
} from "../../services/feedback/telegram-bridge.js";
import {
  legacyBearerAllowed,
  type ResolvedAuth
} from "../../services/auth/legacy-bearer.js";
import { toTrackedPriceHistory } from "../../services/trips/tracked-price-history.js";

const MAX_BODY_BYTES = 64 * 1024;
/** Vite copies `apps/web/public/*` into `dist/` root as single-segment files. */
const PUBLIC_DIST_FILE = /^[a-zA-Z0-9._-]+\.(?:avif|gif|ico|jpe?g|png|svg|webp|webmanifest|txt)$/u;

export default defineChannel({
  kindHint: "captain-api",
  routes: [
    GET("/health", async () => Response.json({
      status: "ok",
      mode: isCaptainArchivedMode() ? "archived" : "active"
    })),
    GET("/ready", readiness),
    GET("/", servePublicIndex),
    GET("/trips", servePublicIndex),
    GET("/trip", servePublicIndex),
    GET("/trip/:id", servePublicIndex),
    GET("/trip/:id/settings", servePublicIndex),
    GET("/trip/:id/leg/:legId", servePublicIndex),
    GET("/trip/:id/flight/:itineraryKey", servePublicIndex),
    GET("/trip/:id/flight/:itineraryKey/book", servePublicIndex),
    GET("/flight/:flightKey", servePublicIndex),
    GET("/profile", servePublicIndex),
    GET("/feedback", servePublicIndex),
    GET("/settings", servePublicIndex),
    GET("/preferences", servePublicIndex),
    GET("/travellers", servePublicIndex),
    GET("/payment", servePublicIndex),
    GET("/admin", serveIndex),
    GET("/admin/conversations", serveIndex),
    GET("/admin/conversations/:id", serveIndex),
    GET("/admin/automations", serveIndex),
    GET("/admin/trips", serveIndex),
    GET("/admin/trips/:id", serveIndex),
    GET("/admin/costs", serveIndex),
    GET("/auth/link", exchangeLoginLink),
    GET("/assets/:asset", serveAsset),
    GET("/api/auth/session", authenticated(sessionStatus)),
    GET("/api/admin/config", adminConfig),
    GET("/api/admin/session", adminAuthenticated(adminSession)),
    GET("/api/admin/overview", adminAuthenticated(adminOverview)),
    GET("/api/admin/conversations", adminAuthenticated(adminConversations)),
    GET("/api/admin/conversations/:conversationId", adminAuthenticated(adminConversation)),
    GET("/api/admin/automations", adminAuthenticated(adminAutomations)),
    GET("/api/admin/trips", adminAuthenticated(adminTrips)),
    GET("/api/admin/trips/:tripId", adminAuthenticated(adminTrip)),
    GET("/api/admin/costs", adminAuthenticated(adminCosts)),
    GET("/api/me/profile", authenticated(getProfile)),
    PATCH("/api/me/profile", authenticatedMutation(updateProfile)),
    GET("/api/me/facts", authenticated(listFacts)),
    DELETE("/api/me/facts/:id", authenticatedMutation(requireSession(dismissFact))),
    POST("/api/me/feedback", authenticatedMutation(requireSession(submitFeedback))),
    GET("/api/me/trip", authenticated(getTrip)),
    PATCH("/api/me/trip", authenticatedMutation(updateTrip)),
    POST("/api/me/trip/actions", authenticatedMutation(tripAction)),
    POST("/api/me/trip/selections", authenticatedMutation(setTripSelection)),
    POST("/api/me/trip/legs/:legId/searches", authenticatedMutation(startTripLegSearch)),
    GET("/api/me/trip/legs/:legId/searches/:searchId", authenticated(getTripLegSearch)),
    POST("/api/me/trip/legs/:legId/selection", authenticatedMutation(setTripLegSelection)),
    GET("/api/flights/:flightKey", availableWhenActive(safely(getCanonicalFlight))),
    DELETE("/api/me/account", authenticatedMutation(requireSession(deleteAccount))),
    // After SPA/API routes so `/trip` etc. keep winning; only extensioned
    // public files from `dist/` (Vite's copy of `apps/web/public`) land here.
    GET("/:file", serveDistRootFile)
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
type AdminHandler = (
  request: Request,
  context: RouteContext,
  identity: { id: string; email: string }
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
        return Response.json({ error: "trip_limit", limit: 1 }, { status: 409 });
      }
      if (error instanceof FeedbackBridgeUnavailableError) {
        return Response.json({ error: "feedback_unavailable" }, { status: 503 });
      }
      if (error instanceof FeedbackDeliveryError) {
        return Response.json({ error: "feedback_delivery_failed" }, { status: 502 });
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

function availableWhenActive(handler: Handler): Handler {
  return async (request, context) => isCaptainArchivedMode()
    ? archivedApiResponse()
    : handler(request, context);
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
    if (!services.env.archivedMode) {
      await services.platformStore.disableOnboardingFollowups(
        auth.userId,
        "workspace_opened",
        new Date()
      );
    }
    return handler(request, context, auth.userId, auth);
  });
}

function authenticatedMutation(handler: UserHandler): Handler {
  return availableWhenActive(authenticated(async (request, context, userId, auth) => {
    const services = await getCaptainServices();
    // Cookie sessions make a missing Origin exploitable (cross-site POSTs without
    // Origin used to pass). SameSite=Lax + mandatory Origin match + JSON-only bodies
    // + no CORS + no state-changing GETs is sufficient — no double-submit token.
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(services.env.publicUrl).origin) {
      return Response.json({ error: "invalid_origin" }, { status: 403 });
    }
    return handler(request, context, userId, auth);
  }));
}

function adminAuthenticated(handler: AdminHandler): Handler {
  return async (request, context) => {
    try {
      const services = await getCaptainServices();
      const auth = await services.adminAuth.authenticate(request);
      if (auth.status === "unconfigured") return adminError("admin_unconfigured", 503);
      if (auth.status === "unauthorized") return adminError("unauthorized", 401);
      if (auth.status === "forbidden") return adminError("forbidden", 403);
      return withNoStore(await handler(request, context, auth.identity));
    } catch (error) {
      console.error(JSON.stringify({
        event: "captain.admin_api_error",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      return adminError("internal_error", 500);
    }
  };
}

async function adminConfig(): Promise<Response> {
  try {
    const services = await getCaptainServices();
    const config = services.adminAuth.publicConfig();
    return config ? adminJson(config) : adminError("admin_unconfigured", 503);
  } catch {
    return adminError("admin_unconfigured", 503);
  }
}

async function adminSession(
  _request: Request,
  _context: RouteContext,
  identity: { id: string; email: string }
): Promise<Response> {
  return adminJson({ authenticated: true, identity });
}

async function adminOverview(): Promise<Response> {
  const services = await getCaptainServices();
  const overview = await services.adminStore.getOverview(new Date());
  return adminJson({
    health: {
      service: "available",
      database: services.env.databaseUrl ? "available" : "memory"
    },
    agent: {
      name: "Captain",
      environment: "production",
      status: services.env.archivedMode ? "archived" : "operational",
      model: services.env.aiModel,
      lastActivityAt: overview.lastActivityAt,
      activeTurns: overview.activeTurns
    },
    models: [
      { key: "owner_chat", label: "Owner chat", model: services.env.aiModel },
      { key: "trip_interpretation", label: "Trip interpretation", model: services.env.tripInterpreterModel },
      { key: "trip_update", label: "Trip updates", model: services.env.tripInterpreterModel },
      { key: "voice_transcription", label: "Voice transcription", model: services.env.transcriptionModel }
    ],
    metrics: overview.metrics,
    trackingStartedAt: overview.trackingStartedAt,
    recentConversations: overview.recentConversations
  });
}

async function adminConversations(request: Request): Promise<Response> {
  const services = await getCaptainServices();
  const search = new URL(request.url).searchParams;
  const limit = boundedInteger(search.get("limit"), 25, 1, 50);
  const query = search.get("query")?.trim().slice(0, 120) || undefined;
  const cursor = search.get("cursor")?.trim() || undefined;
  return adminJson(await services.adminStore.listConversations({
    limit,
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {})
  }));
}

async function adminConversation(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const conversationId = context.params.conversationId;
  if (!conversationId || !z.uuid().safeParse(conversationId).success) {
    return adminError("not_found", 404);
  }
  const services = await getCaptainServices();
  const search = new URL(request.url).searchParams;
  const before = search.get("before")?.trim() || undefined;
  const detail = await services.adminStore.getConversation({
    conversationId,
    limit: boundedInteger(search.get("limit"), 50, 1, 100),
    ...(before ? { before } : {})
  });
  return detail ? adminJson(detail) : adminError("not_found", 404);
}

async function adminTrips(request: Request): Promise<Response> {
  const services = await getCaptainServices();
  const search = new URL(request.url).searchParams;
  const limit = boundedInteger(search.get("limit"), 25, 1, 50);
  const query = search.get("query")?.trim().slice(0, 120) || undefined;
  const cursor = search.get("cursor")?.trim() || undefined;
  return adminJson(await services.adminStore.listTrips({
    limit,
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {})
  }));
}

async function adminAutomations(request: Request): Promise<Response> {
  const services = await getCaptainServices();
  const search = new URL(request.url).searchParams;
  const limit = boundedInteger(search.get("limit"), 25, 1, 50);
  const query = search.get("query")?.trim().slice(0, 120) || undefined;
  const cursor = search.get("cursor")?.trim() || undefined;
  return adminJson(await services.adminStore.listAutomations({
    limit,
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {})
  }));
}

async function adminTrip(
  _request: Request,
  context: RouteContext
): Promise<Response> {
  const tripId = context.params.tripId;
  if (!tripId || !z.uuid().safeParse(tripId).success) {
    return adminError("not_found", 404);
  }
  const services = await getCaptainServices();
  const detail = await services.adminStore.getTrip({ tripId });
  return detail ? adminJson(detail) : adminError("not_found", 404);
}

async function adminCosts(request: Request): Promise<Response> {
  const range = new URL(request.url).searchParams.get("range") ?? "30d";
  if (!(["7d", "30d", "all"] as string[]).includes(range)) {
    return adminError("invalid_range", 400);
  }
  const services = await getCaptainServices();
  return adminJson(await services.adminStore.getCosts(range as AdminCostRange, new Date()));
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
    return Response.redirect(new URL("/trips?e=expired", services.env.publicUrl).toString(), 302);
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
      storage: services.env.databaseUrl ? "postgres" : "memory",
      mode: services.env.archivedMode ? "archived" : "active"
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

async function listFacts(
  _request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const facts = await services.platformStore.listTravellerFacts(userId);
  return Response.json({ facts }, { headers: noStore() });
}

async function dismissFact(
  _request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const factId = z.string().uuid().parse(context.params.id);
  const services = await getCaptainServices();
  const dismissed = await services.platformStore.dismissTravellerFact(
    userId,
    factId,
    new Date()
  );
  if (!dismissed) {
    return Response.json({ error: "not_found" }, { status: 404, headers: noStore() });
  }
  return Response.json({ dismissed: true }, { headers: noStore() });
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

async function submitFeedback(
  request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  const body = z.object({
    text: z.string().trim().min(1).max(2_000)
  }).strict().parse(await requestJson(request));
  const user = await services.platformStore.getUser(userId);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const receipt = await services.feedback.send(body.text, {
    telegramUserId: user.telegramUserId,
    displayName: user.displayName
  });
  return Response.json(receipt, { headers: noStore() });
}

async function getTrip(
  request: Request,
  _context: RouteContext,
  userId: string
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
    const graphPayload = services.env.simplifiedMultiCityEnabled
      ? { cities: [], legs: [], latestSearches: {} }
      : {};
    return Response.json(
      {
        trips,
        trip: null,
        watch: null,
        offers: [],
        recommendation: null,
        selections: [],
        activity: [],
        priceHistory: null,
        goal: null,
        ...graphPayload
      },
      { headers: noStore() }
    );
  }
  await services.platformStore.markTripActivity(userId, trip.id, new Date());
  const [watch, offers, recommendation, selections, activity, tracked, graph] = await Promise.all([
    services.platformStore.getWatch(userId, trip.id),
    services.trips.offers(userId, trip.id),
    services.platformStore.getRecommendation(userId, trip.id),
    services.platformStore.listTripFlightSelections(userId, trip.id),
    services.platformStore.listTripActivity(userId, trip.id),
    services.platformStore.getTrackedFlightPrices(userId, trip.id),
    services.env.simplifiedMultiCityEnabled
      ? services.platformStore.getTripGraph(userId, trip.id)
      : Promise.resolve({ cities: [], legs: [] })
  ]);
  const latestSearchEntries = await Promise.all(graph.legs.map(async (leg) => [
    leg.id,
    await services.platformStore.getLatestLegSearchSnapshot(userId, trip.id, leg.id)
  ] as const));
  const latestSearches = Object.fromEntries(
    latestSearchEntries.filter((entry): entry is readonly [string, NonNullable<typeof entry[1]>] =>
      entry[1] !== null
    )
  );
  const priceHistory = toTrackedPriceHistory(tracked, trip.brief.departureWindow.start);
  const profile = await services.platformStore.ensureProfile(userId, new Date());
  return Response.json(
    {
      trips,
      trip,
      watch,
      offers,
      recommendation,
      selections,
      activity,
      priceHistory,
      goal: formatTripGoal({ brief: trip.brief, rankingMode: profile.rankingMode }),
      goalState: tripGoalState(trip.status),
      ...(services.env.simplifiedMultiCityEnabled
        ? { cities: graph.cities, legs: graph.legs, latestSearches }
        : {})
    },
    { headers: noStore() }
  );
}

async function startTripLegSearch(
  request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  if (!services.env.simplifiedMultiCityEnabled) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const trip = await services.platformStore.getActiveTrip(userId);
  const legId = context.params.legId;
  if (!trip || !legId) throw new TripNotFoundError();
  const body = z.object({
    requestedWindow: z.object({
      start: z.iso.date(),
      end: z.iso.date()
    }).strict().optional()
  }).strict().parse(await requestJson(request));
  const result = await services.legSearch.start(userId, {
    tripId: trip.id,
    legId,
    ...(body.requestedWindow ? { requestedWindow: body.requestedWindow } : {})
  });
  if (result.snapshot) return Response.json(result.snapshot, { status: 202, headers: noStore() });
  const status = result.status === "not_found"
    ? 404
    : result.status === "window_too_large" || result.status === "invalid_window"
      ? 422
      : result.status === "conflict"
        ? 409
        : 503;
  return Response.json(
    { error: result.code ?? result.status, message: result.message },
    { status, headers: noStore() }
  );
}

async function getTripLegSearch(
  _request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  if (!services.env.simplifiedMultiCityEnabled) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const trip = await services.platformStore.getActiveTrip(userId);
  const legId = context.params.legId;
  const searchId = context.params.searchId;
  if (!trip || !legId || !searchId) throw new TripNotFoundError();
  const snapshot = await services.legSearch.get(userId, trip.id, legId, searchId);
  if (!snapshot) throw new TripNotFoundError();
  return Response.json(snapshot, { headers: noStore() });
}

async function setTripLegSelection(
  request: Request,
  context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
  if (!services.env.simplifiedMultiCityEnabled) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const trip = await services.platformStore.getActiveTrip(userId);
  const legId = context.params.legId;
  if (!trip || !legId) throw new TripNotFoundError();
  const body = z.object({
    flightKey: z.string().trim().min(1).max(500).nullable()
  }).strict().parse(await requestJson(request));
  const leg = await services.platformStore.setTripLegFlight(
    userId,
    trip.id,
    legId,
    body.flightKey,
    "person",
    new Date()
  );
  return Response.json(leg, { headers: noStore() });
}

async function getCanonicalFlight(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const flightKey = context.params.flightKey?.trim();
  if (!flightKey) return Response.json({ error: "not_found" }, { status: 404 });
  const services = await getCaptainServices();
  if (!services.env.simplifiedMultiCityEnabled) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const resource = await services.legSearch.getFlight(flightKey);
  if (!resource) return Response.json({ error: "not_found" }, { status: 404 });
  const auth = await services.auth.resolve(request);
  let privateContext: {
    tripId: string;
    legId: string;
    routeLabel: string;
    selected: boolean;
  } | null = null;
  if (auth?.credential === "session") {
    const user = await services.platformStore.getUser(auth.userId);
    const trip = user?.status === "active"
      ? await services.platformStore.getActiveTrip(auth.userId)
      : null;
    if (trip) {
      const graph = await services.platformStore.getTripGraph(auth.userId, trip.id);
      const selectedLeg = graph.legs.find((candidate) => candidate.selectedFlightKey === flightKey);
      let leg = selectedLeg ?? null;
      let selected = Boolean(selectedLeg);
      if (!leg) {
        for (const candidate of graph.legs) {
          const snapshot = await services.platformStore.getLatestLegSearchSnapshot(
            auth.userId,
            trip.id,
            candidate.id
          );
          if (snapshot?.flights.some((flight) => flight.key === flightKey)) {
            leg = candidate;
            selected = false;
            break;
          }
        }
      }
      const origin = leg
        ? graph.cities.find((city) => city.id === leg.originCityId)
        : null;
      const destination = leg
        ? graph.cities.find((city) => city.id === leg.destinationCityId)
        : null;
      if (leg && origin && destination) {
        privateContext = {
          tripId: trip.id,
          legId: leg.id,
          routeLabel: `${origin.label} → ${destination.label}`,
          selected
        };
      }
    }
  }
  return Response.json(
    { ...resource, ...(privateContext ? { context: privateContext } : {}) },
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
  const body = await requestJson(request);
  const updated = body && typeof body === "object" && "title" in body
    ? await services.trips.rename(userId, trip.id, updateTripTitleSchema.parse(body))
    : await services.trips.update(userId, trip.id, updateTripBriefSchema.parse(body));
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

async function deleteAccount(
  _request: Request,
  _context: RouteContext,
  userId: string
): Promise<Response> {
  const services = await getCaptainServices();
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

async function servePublicIndex(): Promise<Response> {
  if (!isCaptainArchivedMode()) return serveIndex();
  return new Response(archivedPage(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

function archivedApiResponse(): Response {
  return Response.json(
    { error: CAPTAIN_ARCHIVED_ERROR, message: CAPTAIN_ARCHIVED_MESSAGE },
    { status: 410, headers: noStore() }
  );
}

function archivedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Captain has closed</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f1e8; color: #1e2928; }
    main { width: min(34rem, calc(100% - 3rem)); padding: 3rem 0; }
    p:first-child { margin: 0 0 1.25rem; font-size: .78rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #5c6b68; }
    h1 { margin: 0; font: 500 clamp(2.4rem, 8vw, 4.5rem)/.98 Georgia, serif; letter-spacing: -.04em; }
    p:last-child { margin: 1.5rem 0 0; max-width: 30rem; font-size: 1.08rem; line-height: 1.65; color: #53605e; }
  </style>
</head>
<body>
  <main>
    <p>Captain</p>
    <h1>This journey has ended.</h1>
    <p>${CAPTAIN_ARCHIVED_MESSAGE}</p>
  </main>
</body>
</html>`;
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

/** Vite copies `apps/web/public/*` to `dist/` root; hashed bundles live under `/assets`. */
async function serveDistRootFile(
  _request: Request,
  context: RouteContext
): Promise<Response> {
  const file = context.params.file;
  if (file === "index.html" && isCaptainArchivedMode()) {
    return servePublicIndex();
  }
  if (!file || file === "index.html" || !PUBLIC_DIST_FILE.test(file)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    return new Response(await readFile(resolve("dist", file)), {
      headers: {
        "content-type": contentType(file),
        "cache-control": "public, max-age=86400"
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

function adminJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore() });
}

function adminError(error: string, status: number): Response {
  return adminJson({ error }, status);
}

function withNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
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
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  } as Record<string, string>)[extname(file).toLowerCase()] ?? "application/octet-stream";
}
