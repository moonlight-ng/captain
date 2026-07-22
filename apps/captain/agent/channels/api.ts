import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { DELETE, GET, PATCH, POST, defineChannel } from "eve/channels";
import { z, ZodError } from "zod";
import {
  TripLimitError,
  TripNotFoundError,
  TripVersionConflictError,
  createTripSchema,
  tripActionSchema,
  updateTripSchema
} from "@agents/flight-domain";

import { getFlightAgentServices } from "../../services/app/services.js";
import {
  BridgeReplayGuard,
  requestHash,
  verifyBridgeRequest
} from "../../services/bridge/signature.js";
import {
  InvalidStateError,
  NotFoundError,
  VersionConflictError,
  agentStatusSchema,
  agentActionSchema,
  checkModeSchema,
  createFlightAgentSchema,
  type FlightAgentWorkspace
} from "../../services/domain/types.js";
import type { FlightAgentStore } from "../../services/store/contracts.js";
import { verifyCaptainSessionToken } from "../lib/session-token.js";

const MAX_BODY_BYTES = 512 * 1024;
const bridgeReplayGuard = new BridgeReplayGuard();
const internalCheckSchema = z.object({ mode: checkModeSchema }).strict();
const internalDeleteSchema = z.object({
  createIdempotencyKey: z.string().trim().min(8).max(200)
}).strict();
const PILOT_USER_ID = "00000000-0000-4000-8000-000000000001";

export default defineChannel({
  kindHint: "flight-agent-api",
  cors: {
    origin: ["http://127.0.0.1:4178", "https://opemipo-flight-agent.fly.dev"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    maxAge: 86_400
  },
  routes: [
    GET("/health", async () => Response.json({ status: "ok" })),
    GET("/ready", readiness),
    GET("/", serveIndex),
    GET("/agents/:agentKey", redirectLegacyAgent),
    GET("/trips/:tripId", owner(serveTrip)),
    GET("/assets/:asset", serveAsset),
    GET("/v1/agents", owner(listAgents)),
    POST("/v1/agents", owner(createAgent)),
    GET("/v1/agents/:agentKey", owner(getAgent)),
    POST("/v1/agents/:agentKey/actions", owner(agentAction)),
    GET("/v1/agents/:agentKey/flights", owner(listFlights)),
    GET("/v1/agents/:agentKey/flights/:flightId", owner(getFlight)),
    POST("/v1/agents/:agentKey/folders", owner(createFolder)),
    POST("/v1/agents/:agentKey/folders/:folderId", owner(renameFolder)),
    DELETE("/v1/agents/:agentKey/folders/:folderId", owner(deleteFolder)),
    POST("/v1/agents/:agentKey/folders/:folderId/members", owner(setFolderMembership)),
    GET("/v1/me/trips", traveller(listTrips)),
    POST("/v1/trips", traveller(createTrip)),
    GET("/v1/trips/:tripId", traveller(getTrip)),
    PATCH("/v1/trips/:tripId", traveller(updateTrip)),
    POST("/v1/trips/:tripId/actions", traveller(tripAction)),
    GET("/v1/trips/:tripId/offers", traveller(listTripOffers)),
    GET("/internal/v1/trips", internal(listInternalTrips)),
    POST("/internal/v1/trips", internal(createInternalTrip)),
    GET("/internal/v1/trips/:tripId", internal(getInternalTrip)),
    PATCH("/internal/v1/trips/:tripId", internal(updateInternalTrip)),
    POST("/internal/v1/trips/:tripId/actions", internal(internalTripAction)),
    GET("/internal/v1/trips/:tripId/offers", internal(listInternalTripOffers)),
    POST("/internal/v1/flight-agents", internal(createInternalAgent)),
    GET("/internal/v1/flight-agents", internal(listInternalAgents)),
    GET("/internal/v1/flight-agents/:agentKey", internal(getInternalAgent)),
    POST("/internal/v1/flight-agents/:agentKey/actions", internal(internalAgentAction)),
    DELETE("/internal/v1/flight-agents/:agentKey", internal(deleteInternalAgent)),
    POST("/internal/v1/flight-agents/:agentKey/checks", internal(createInternalCheck))
  ]
});

type RouteContext = { params: Readonly<Record<string, string>> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;
type TravellerHandler = (request: Request, context: RouteContext, userId: string) => Promise<Response>;

function traveller(handler: TravellerHandler): Handler {
  return async (request, context) => {
    const services = await getFlightAgentServices();
    const secret = services.env.captainSessionSecret;
    const authorization = request.headers.get("authorization");
    const userId = secret && authorization?.startsWith("Bearer ")
      ? verifyCaptainSessionToken(authorization.slice(7), secret)
      : null;
    if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
    const user = await services.platformStore.getUser(userId);
    if (!user || user.status !== "active") return Response.json({ error: "unauthorized" }, { status: 401 });
    return safely(() => handler(request, context, userId));
  };
}

function owner(handler: Handler): Handler {
  return async (request, context) => {
    const services = await getFlightAgentServices();
    if (services.env.mode === "production" && services.env.ownerAuthEnabled && !isOwnerRequest(
      request,
      services.env.basicUsername,
      services.env.basicPassword
    )) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="Flight Agent"' }
      });
    }
    return safely(() => handler(request, context));
  };
}

function internal(handler: Handler): Handler {
  return async (request, context) => {
    const services = await getFlightAgentServices();
    const secret = services.env.captainToFlightAgentSecret;
    const body = request.method === "GET" ? "" : await limitedText(request);
    const timestamp = request.headers.get("x-bridge-timestamp");
    const signature = request.headers.get("x-bridge-signature");
    const isTripRoute = new URL(request.url).pathname.startsWith("/internal/v1/trips");
    if (isTripRoute && request.headers.get("x-bridge-service") !== "pilot") {
      return Response.json({ error: "unauthorized_service" }, { status: 401 });
    }
    if (!secret || !verifyBridgeRequest({
      secret,
      method: request.method,
      path: new URL(request.url).pathname,
      body,
      timestamp,
      signature
    })) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (signature && bridgeReplayGuard.isReplay(signature, Number(timestamp))) {
      return Response.json({ error: "replay_detected" }, { status: 409 });
    }
    const forwarded = body
      ? new Request(request.url, { method: request.method, headers: request.headers, body })
      : request;
    return safely(() => handler(forwarded, context));
  };
}

async function readiness(): Promise<Response> {
  try {
    const services = await getFlightAgentServices();
    await services.agents.list({ limit: 1 });
    return Response.json({ status: "ready", storage: services.env.databaseUrl ? "postgres" : "memory" });
  } catch (error) {
    logApiError("flight_agent.readiness_failed", error);
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

async function listTrips(_request: Request, _context: RouteContext, userId: string): Promise<Response> {
  const services = await getFlightAgentServices();
  return Response.json({ trips: await services.trips.list(userId) }, { headers: noStore() });
}

async function createTrip(request: Request, _context: RouteContext, userId: string): Promise<Response> {
  return createTripForUser(request, userId, `trip:create:${userId}`);
}

async function getTrip(_request: Request, context: RouteContext, userId: string): Promise<Response> {
  return getTripForUser(userId, requiredParam(context, "tripId"));
}

async function updateTrip(request: Request, context: RouteContext, userId: string): Promise<Response> {
  return updateTripForUser(request, userId, requiredParam(context, "tripId"));
}

async function tripAction(request: Request, context: RouteContext, userId: string): Promise<Response> {
  return tripActionForUser(request, userId, requiredParam(context, "tripId"));
}

async function listTripOffers(_request: Request, context: RouteContext, userId: string): Promise<Response> {
  return offersForUser(userId, requiredParam(context, "tripId"));
}

async function listInternalTrips(): Promise<Response> {
  const services = await getFlightAgentServices();
  return Response.json({ trips: await services.trips.list(PILOT_USER_ID) }, { headers: noStore() });
}

async function createInternalTrip(request: Request): Promise<Response> {
  return createTripForUser(request, PILOT_USER_ID, "internal:trip:create");
}

async function getInternalTrip(_request: Request, context: RouteContext): Promise<Response> {
  const tripReference = requiredParam(context, "tripId");
  const services = await getFlightAgentServices();
  const trip = await resolvePilotTrip(tripReference);
  if (!trip) throw new TripNotFoundError();
  return Response.json({
    trip,
    watch: await services.platformStore.getWatch(PILOT_USER_ID, trip.id),
    offers: await services.trips.offers(PILOT_USER_ID, trip.id)
  }, { headers: noStore() });
}

async function updateInternalTrip(request: Request, context: RouteContext): Promise<Response> {
  const trip = await resolvePilotTrip(requiredParam(context, "tripId"));
  if (!trip) throw new TripNotFoundError();
  return updateTripForUser(request, PILOT_USER_ID, trip.id);
}

async function internalTripAction(request: Request, context: RouteContext): Promise<Response> {
  const trip = await resolvePilotTrip(requiredParam(context, "tripId"));
  if (!trip) throw new TripNotFoundError();
  return tripActionForUser(request, PILOT_USER_ID, trip.id);
}

async function listInternalTripOffers(_request: Request, context: RouteContext): Promise<Response> {
  const trip = await resolvePilotTrip(requiredParam(context, "tripId"));
  if (!trip) throw new TripNotFoundError();
  return offersForUser(PILOT_USER_ID, trip.id);
}

async function resolvePilotTrip(reference: string) {
  const services = await getFlightAgentServices();
  return await services.trips.get(PILOT_USER_ID, reference)
    ?? await services.platformStore.getTripByLegacyKey(PILOT_USER_ID, reference);
}

async function createTripForUser(request: Request, userId: string, scope: string): Promise<Response> {
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const cached = await idempotentResponse(request, scope, text, services.store);
  if (cached) return cached;
  const result = await services.trips.create(userId, createTripSchema.parse(parseJson(text)));
  return rememberResponse(request, scope, text, 202, result, services.store);
}

async function getTripForUser(userId: string, tripId: string): Promise<Response> {
  const services = await getFlightAgentServices();
  const trip = await services.trips.get(userId, tripId);
  if (!trip) throw new TripNotFoundError();
  return Response.json({ trip }, { headers: noStore() });
}

async function updateTripForUser(request: Request, userId: string, tripId: string): Promise<Response> {
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const scope = `trip:update:${userId}:${tripId}`;
  const cached = await idempotentResponse(request, scope, text, services.store);
  if (cached) return cached;
  const trip = await services.trips.update(userId, tripId, updateTripSchema.parse(parseJson(text)));
  return rememberResponse(request, scope, text, 200, { trip }, services.store);
}

async function tripActionForUser(request: Request, userId: string, tripId: string): Promise<Response> {
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const scope = `trip:action:${userId}:${tripId}`;
  const cached = await idempotentResponse(request, scope, text, services.store);
  if (cached) return cached;
  const trip = await services.trips.action(userId, tripId, tripActionSchema.parse(parseJson(text)));
  return rememberResponse(request, scope, text, 202, { trip }, services.store);
}

async function offersForUser(userId: string, tripId: string): Promise<Response> {
  const services = await getFlightAgentServices();
  if (!await services.trips.get(userId, tripId)) throw new TripNotFoundError();
  return Response.json({ offers: await services.trips.offers(userId, tripId) }, { headers: noStore() });
}

async function createAgent(request: Request): Promise<Response> {
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const cached = await idempotentResponse(request, "create", text, services.store);
  if (cached) return cached;
  const input = createFlightAgentSchema.parse(parseJson(text));
  const agent = await services.agents.create(input);
  return rememberResponse(request, "create", text, 202, {
    agent,
    workspaceUrl: `${services.env.publicUrl}/agents/${agent.key}`
  }, services.store);
}

async function listAgents(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const services = await getFlightAgentServices();
  const result = await services.agents.list(listOptions(url));
  return Response.json(result, { headers: noStore() });
}

async function getAgent(_request: Request, context: RouteContext): Promise<Response> {
  const services = await getFlightAgentServices();
  const workspace = await services.agents.get(requiredParam(context, "agentKey"));
  if (!workspace) throw new NotFoundError("Flight agent not found");
  return Response.json({ workspace }, { headers: noStore() });
}

async function createInternalAgent(request: Request): Promise<Response> {
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const cached = await idempotentResponse(request, "internal:create", text, services.store);
  if (cached) return cached;
  const input = createFlightAgentSchema.parse(parseJson(text));
  const created = await services.agents.create(input);
  const workspace = await services.agents.get(created.key);
  if (!workspace) throw new NotFoundError("Flight agent not found after creation");
  return rememberResponse(request, "internal:create", text, 202, {
    agent: toBridgeAgent(workspace, services.env.publicUrl)
  }, services.store);
}

async function getInternalAgent(_request: Request, context: RouteContext): Promise<Response> {
  const services = await getFlightAgentServices();
  const workspace = await services.agents.get(requiredParam(context, "agentKey"));
  if (!workspace) throw new NotFoundError("Flight agent not found");
  return Response.json({
    agent: toBridgeAgent(workspace, services.env.publicUrl)
  }, { headers: noStore() });
}

async function listInternalAgents(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const services = await getFlightAgentServices();
  const page = await services.agents.list(listOptions(url));
  const agents = (await Promise.all(page.agents.map((agent) => services.agents.get(agent.key))))
    .filter((workspace): workspace is FlightAgentWorkspace => workspace !== null)
    .map((workspace) => toBridgeAgent(workspace, services.env.publicUrl));
  return Response.json({ agents, nextCursor: page.nextCursor }, { headers: noStore() });
}

async function createInternalCheck(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const text = await limitedText(request);
  if (!request.headers.get("idempotency-key")?.trim()) {
    return Response.json({ error: "idempotency_key_required" }, { status: 400 });
  }
  const services = await getFlightAgentServices();
  const scope = `internal:check:${key}`;
  const cached = await idempotentResponse(request, scope, text, services.store);
  if (cached) return cached;
  const { mode } = internalCheckSchema.parse(parseJson(text));
  const checkId = await services.agents.requestCheck(key, mode);
  const workspaceUrl = `${services.env.publicUrl}/agents/${encodeURIComponent(key)}`;
  return rememberResponse(request, scope, text, 202, {
    checkId,
    status: "accepted",
    workspaceUrl
  }, services.store);
}

async function internalAgentAction(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const text = await limitedText(request);
  if (!request.headers.get("idempotency-key")?.trim()) {
    return Response.json({ error: "idempotency_key_required" }, { status: 400 });
  }
  const services = await getFlightAgentServices();
  const scope = `internal:action:${key}`;
  const cached = await idempotentResponse(request, scope, text, services.store);
  if (cached) return cached;
  const action = agentActionSchema.parse(parseJson(text));
  await services.agents.action(key, action);
  const workspace = await services.agents.get(key);
  if (!workspace) throw new NotFoundError("Flight agent not found after update");
  return rememberResponse(request, scope, text, 202, {
    agent: toBridgeAgent(workspace, services.env.publicUrl)
  }, services.store);
}

async function deleteInternalAgent(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const text = await limitedText(request);
  if (!request.headers.get("idempotency-key")?.trim()) {
    return Response.json({ error: "idempotency_key_required" }, { status: 400 });
  }
  const services = await getFlightAgentServices();
  const { createIdempotencyKey } = internalDeleteSchema.parse(parseJson(text));
  const deleted = await services.agents.delete(key, createIdempotencyKey);
  if (!deleted) throw new NotFoundError("Flight agent not found");
  return Response.json({ deleted: true, agentKey: key });
}

async function agentAction(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const cached = await idempotentResponse(request, `action:${key}`, text, services.store);
  if (cached) return cached;
  const action = agentActionSchema.parse(parseJson(text));
  const agent = await services.agents.action(key, action);
  return rememberResponse(request, `action:${key}`, text, 202, { agent }, services.store);
}

async function listFlights(request: Request, context: RouteContext): Promise<Response> {
  const services = await getFlightAgentServices();
  const workspace = await services.agents.get(requiredParam(context, "agentKey"));
  if (!workspace) throw new NotFoundError("Flight agent not found");
  const scope = new URL(request.url).searchParams.get("scope");
  return Response.json({
    flights: scope === "review" ? workspace.reviewFlights : workspace.browseFlights
  }, { headers: noStore() });
}

async function getFlight(_request: Request, context: RouteContext): Promise<Response> {
  const services = await getFlightAgentServices();
  const details = await services.agents.getFlight(
    requiredParam(context, "agentKey"),
    requiredParam(context, "flightId")
  );
  if (!details) throw new NotFoundError("Flight not found");
  return Response.json({ details }, { headers: noStore() });
}

async function createFolder(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const cached = await idempotentResponse(request, `folder:create:${key}`, text, services.store);
  if (cached) return cached;
  const body = parseJson(text) as { name?: unknown };
  if (typeof body.name !== "string") throw new InvalidStateError("Folder name is required");
  const folder = await services.agents.createFolder(key, body.name);
  return rememberResponse(request, `folder:create:${key}`, text, 201, { folder }, services.store);
}

async function renameFolder(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const folderId = requiredParam(context, "folderId");
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const scope = `folder:rename:${key}:${folderId}`;
  const cached = await idempotentResponse(request, scope, text, services.store);
  if (cached) return cached;
  const body = parseJson(text) as { name?: unknown };
  if (typeof body.name !== "string") throw new InvalidStateError("Folder name is required");
  const folder = await services.agents.renameFolder(
    key,
    folderId,
    body.name
  );
  if (!folder) throw new NotFoundError("Folder not found");
  return rememberResponse(request, scope, text, 200, { folder }, services.store);
}

async function deleteFolder(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const folderId = requiredParam(context, "folderId");
  const services = await getFlightAgentServices();
  const scope = `folder:delete:${key}:${folderId}`;
  const cached = await idempotentResponse(request, scope, "", services.store);
  if (cached) return cached;
  const deleted = await services.agents.deleteFolder(key, folderId);
  if (!deleted) throw new NotFoundError("Folder not found");
  return rememberResponse(request, scope, "", 204, null, services.store);
}

async function setFolderMembership(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  const folderId = requiredParam(context, "folderId");
  const text = await limitedText(request);
  const services = await getFlightAgentServices();
  const scope = `folder:membership:${key}:${folderId}`;
  const cached = await idempotentResponse(request, scope, text, services.store);
  if (cached) return cached;
  const body = parseJson(text) as { flightId?: unknown; included?: unknown };
  if (typeof body.flightId !== "string" || typeof body.included !== "boolean") {
    throw new InvalidStateError("flightId and included are required");
  }
  await services.agents.setFolderMembership(key, folderId, body.flightId, body.included);
  return rememberResponse(request, scope, text, 204, null, services.store);
}

async function serveIndex(request: Request): Promise<Response> {
  const services = await getFlightAgentServices();
  if (services.env.mode === "production" && services.env.ownerAuthEnabled && !isOwnerRequest(
    request,
    services.env.basicUsername,
    services.env.basicPassword
  )) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="Flight Agent"' }
    });
  }
  try {
    return new Response(await readFile(resolve("dist/index.html")), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
    });
  } catch {
    return new Response("Flight Agent UI has not been built", { status: 503 });
  }
}

async function redirectLegacyAgent(request: Request, context: RouteContext): Promise<Response> {
  const key = requiredParam(context, "agentKey");
  return Response.redirect(new URL(`/trips/${encodeURIComponent(key)}`, request.url), 308);
}

async function serveTrip(_request: Request, context: RouteContext): Promise<Response> {
  const trip = await resolvePilotTrip(requiredParam(context, "tripId"));
  if (!trip) throw new TripNotFoundError();
  const services = await getFlightAgentServices();
  const offers = await services.trips.offers(PILOT_USER_ID, trip.id);
  const offerRows = offers.slice(0, 20).map((offer) => {
    const summary = typeof offer.snapshot.route === "string" ? offer.snapshot.route : offer.itineraryKey;
    const flights = Array.isArray(offer.snapshot.flightNumbers) ? offer.snapshot.flightNumbers.join(", ") : "";
    return `<tr><td>${html(flights || "Flight")}</td><td>${html(summary)}</td><td>${html(`${offer.currency} ${offer.price.toFixed(2)}`)}</td><td>${html(new Date(offer.observedAt).toLocaleString("en-GB"))}</td></tr>`;
  }).join("");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(trip.title)} · Captain</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:48px auto;padding:0 24px;color:#18211d;background:#f7f4ec}a{color:inherit}header{margin-bottom:32px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:#607068}h1{font-size:38px;margin:8px 0}.meta{color:#607068}table{width:100%;border-collapse:collapse;background:white;border-radius:14px;overflow:hidden}th,td{text-align:left;padding:14px;border-bottom:1px solid #e7e3da}th{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#607068}.empty{padding:28px;background:white;border-radius:14px}</style></head><body><header><p class="eyebrow">Captain Trip · ${html(trip.status)}</p><h1>${html(trip.title)}</h1><p class="meta">${html(trip.brief.originAirports.join("/"))} → ${html(trip.brief.destinationAirports.join("/"))} · ${html(trip.brief.departureWindow.start)} to ${html(trip.brief.departureWindow.end)}</p></header>${offers.length > 0 ? `<table><thead><tr><th>Flight</th><th>Route</th><th>Current price</th><th>Observed</th></tr></thead><tbody>${offerRows}</tbody></table>` : '<p class="empty">Captain is tracking this Trip. Current results will appear after the flight worker completes its first search.</p>'}</body></html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function serveAsset(
  _request: Request,
  context: RouteContext
): Promise<Response> {
  const asset = requiredParam(context, "asset");
  if (!/^[a-zA-Z0-9._-]+$/.test(asset)) return new Response("Not found", { status: 404 });
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

async function safely(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_request", issues: error.issues }, { status: 400 });
    }
    if (error instanceof VersionConflictError) {
      return Response.json({ error: "version_conflict", currentVersion: error.currentVersion }, { status: 409 });
    }
    if (error instanceof NotFoundError) {
      return Response.json({ error: "not_found", message: error.message }, { status: 404 });
    }
    if (error instanceof InvalidStateError) {
      return Response.json({ error: "invalid_state", message: error.message }, { status: 409 });
    }
    if (error instanceof TripVersionConflictError) {
      return Response.json({ error: "version_conflict", currentVersion: error.currentVersion }, { status: 409 });
    }
    if (error instanceof TripNotFoundError) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof TripLimitError) {
      return Response.json({ error: "trip_limit", message: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message === "body_too_large") {
      return Response.json({ error: "body_too_large" }, { status: 413 });
    }
    logApiError("flight_agent.api_error", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

function logApiError(event: string, error: unknown): void {
  console.error(JSON.stringify({
    service: "flight-agent",
    agent_id: "flight-agent",
    event,
    run_id: crypto.randomUUID(),
    status: "failed",
    duration_ms: 0,
    error_code: error instanceof Error ? error.name : "UnknownError"
  }));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ZodError([{ code: "custom", path: [], message: "Request body must be valid JSON" }]);
  }
}

async function limitedText(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("body_too_large");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("body_too_large");
  return text;
}

function isOwnerRequest(request: Request, username: string, password: string | null): boolean {
  if (!password) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const expected = Buffer.from(`${username}:${password}`);
  const actual = Buffer.from(decoded);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function idempotentResponse(
  request: Request,
  scope: string,
  body: string,
  store: FlightAgentStore
): Promise<Response | null> {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) throw new InvalidStateError("Idempotency-Key header is required");
  const cached = await store.getIdempotency(scope, key);
  if (!cached) return null;
  if (cached.requestHash !== requestHash(body)) {
    throw new InvalidStateError("Idempotency-Key was already used for a different request");
  }
  return cached.responseStatus === 204
    ? new Response(null, { status: 204 })
    : Response.json(cached.responseBody, { status: cached.responseStatus });
}

async function rememberResponse(
  request: Request,
  scope: string,
  requestBody: string,
  status: number,
  responseBody: unknown,
  store: FlightAgentStore
): Promise<Response> {
  const key = request.headers.get("idempotency-key")!.trim();
  await store.putIdempotency(scope, key, {
    requestHash: requestHash(requestBody),
    responseStatus: status,
    responseBody
  });
  return status === 204
    ? new Response(null, { status: 204 })
    : Response.json(responseBody, { status });
}

function requiredParam(context: RouteContext, name: string): string {
  const value = context.params[name];
  if (!value) throw new NotFoundError();
  return value;
}

export function toBridgeAgent(workspace: FlightAgentWorkspace, publicUrl: string) {
  const latest = workspace.agent.latestCheck;
  return {
    key: workspace.agent.key,
    status: workspace.agent.status,
    version: workspace.agent.version,
    createdAt: workspace.agent.createdAt,
    brief: workspace.agent.brief,
    cadenceHours: workspace.agent.cadenceHours,
    lastCheckAt: workspace.agent.lastCheckAt,
    latestRun: latest ? {
      status: latest.status,
      trigger: latest.trigger,
      startedAt: latest.startedAt,
      completedAt: latest.completedAt,
      searched: latest.searched,
      offersFound: latest.offersFound,
      identitiesMatched: latest.identitiesMatched,
      promotions: latest.promotions,
      sources: latest.sourceRuns,
      error: latest.duffelError
    } : null,
    notableFlights: workspace.reviewFlights.slice(0, 10).map((flight) => ({
      key: flight.id,
      destination: flight.destination,
      departureDate: flight.travelDate,
      marketingAirline: flight.marketingAirline,
      marketingAirlineCode: flight.marketingAirlineCode,
      price: flight.latest.price,
      currency: flight.latest.currency,
      source: flight.latest.sourceName,
      bookingUrl: flight.latest.bookingUrl,
      changePercent: flight.changePercent,
      reviewState: flight.reviewState,
      reason: flight.promotionReason
    })),
    currentPriceRanges: currentPriceRanges(workspace),
    outcomeSignals: workspace.browseFlights
      .filter((flight) => flight.reviewState === "retained" || flight.reviewState === "dismissed")
      .slice(0, 100)
      .map((flight) => ({
        flightKey: flight.id,
        reviewState: flight.reviewState,
        origin: flight.latest.origin,
        destination: flight.latest.destination,
        departureDate: flight.latest.travelDate,
        returnDate: flight.latest.returnDate,
        marketingAirlineCode: flight.latest.marketingAirlineCode,
        stops: flight.latest.stops,
        cabin: flight.latest.cabin,
        price: flight.latest.price,
        currency: flight.latest.currency,
        observedAt: flight.latest.observedAt
      })),
    researchSummary: latest?.research ? {
      status: latest.research.status,
      overview: latest.research.overview,
      offersFound: latest.research.offers.length,
      gaps: latest.research.gaps,
      error: latest.research.error
    } : null,
    nextCheckAt: workspace.agent.nextCheckAt,
    workspaceUrl: `${publicUrl}/agents/${encodeURIComponent(workspace.agent.key)}`
  };
}

function currentPriceRanges(workspace: FlightAgentWorkspace) {
  const groups = new Map<string, {
    prices: number[];
    observedAt: string;
    passengerCount: number;
  }>();
  for (const flight of workspace.browseFlights) {
    const snapshot = flight.latest;
    const current = groups.get(snapshot.currency);
    if (!current) {
      groups.set(snapshot.currency, {
        prices: [snapshot.price],
        observedAt: snapshot.observedAt,
        passengerCount: snapshot.passengerCount
      });
      continue;
    }
    current.prices.push(snapshot.price);
    if (snapshot.observedAt > current.observedAt) current.observedAt = snapshot.observedAt;
    current.passengerCount = Math.max(current.passengerCount, snapshot.passengerCount);
  }
  return [...groups.entries()]
    .map(([currency, group]) => ({
      currency,
      minimum: Math.min(...group.prices),
      maximum: Math.max(...group.prices),
      itineraryCount: group.prices.length,
      observedAt: group.observedAt,
      passengerCount: group.passengerCount,
      pricingBasis: "total_party" as const
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

function listOptions(url: URL): { status?: string; cursor?: string; limit?: number } {
  const status = url.searchParams.get("status");
  if (status) agentStatusSchema.parse(status);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new InvalidStateError("limit must be an integer between 1 and 100");
  }
  return {
    ...(status ? { status } : {}),
    ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
    ...(limit === undefined ? {} : { limit })
  };
}

function noStore(): HeadersInit {
  return { "cache-control": "no-store" };
}

function contentType(file: string): string {
  return ({
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2"
  } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
}
