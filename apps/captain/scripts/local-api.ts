import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ZodError } from "zod";

import { getCaptainServices } from "../services/app/services.js";
import {
  InvalidStateError,
  NotFoundError,
  VersionConflictError,
  agentActionSchema,
  createFlightAgentSchema
} from "../services/domain/types.js";

const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (request, response) => {
  setCors(response);
  if (request.method === "OPTIONS") return send(response, 204);
  try {
    const services = await getCaptainServices();
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/ready") return json(response, 200, { status: "ready", storage: services.env.databaseUrl ? "postgres" : "memory" });
    if (url.pathname === "/v1/agents" && request.method === "GET") {
      return json(response, 200, await services.agents.list({
        ...(url.searchParams.get("status") ? { status: url.searchParams.get("status")! } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {})
      }));
    }
    if (url.pathname === "/v1/agents" && request.method === "POST") {
      const agent = await services.agents.create(createFlightAgentSchema.parse(await body(request)));
      return json(response, 202, { agent, workspaceUrl: `${services.env.publicUrl}/agents/${agent.key}` });
    }
    const agentMatch = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (agentMatch && request.method === "GET") {
      const workspace = await services.agents.get(decodeURIComponent(agentMatch[1]!));
      if (!workspace) throw new NotFoundError("Flight agent not found");
      return json(response, 200, { workspace });
    }
    const actionMatch = /^\/v1\/agents\/([^/]+)\/actions$/.exec(url.pathname);
    if (actionMatch && request.method === "POST") {
      const agent = await services.agents.action(
        decodeURIComponent(actionMatch[1]!),
        agentActionSchema.parse(await body(request))
      );
      return json(response, 202, { agent });
    }
    const flightMatch = /^\/v1\/agents\/([^/]+)\/flights\/([^/]+)$/.exec(url.pathname);
    if (flightMatch && request.method === "GET") {
      const details = await services.agents.getFlight(
        decodeURIComponent(flightMatch[1]!),
        decodeURIComponent(flightMatch[2]!)
      );
      if (!details) throw new NotFoundError("Flight not found");
      return json(response, 200, { details });
    }
    const foldersMatch = /^\/v1\/agents\/([^/]+)\/folders$/.exec(url.pathname);
    if (foldersMatch && request.method === "POST") {
      const input = await body(request) as { name?: unknown };
      if (typeof input.name !== "string") throw new InvalidStateError("Folder name is required");
      return json(response, 201, { folder: await services.agents.createFolder(decodeURIComponent(foldersMatch[1]!), input.name) });
    }
    const folderMatch = /^\/v1\/agents\/([^/]+)\/folders\/([^/]+)$/.exec(url.pathname);
    if (folderMatch && request.method === "POST") {
      const input = await body(request) as { name?: unknown };
      if (typeof input.name !== "string") throw new InvalidStateError("Folder name is required");
      const folder = await services.agents.renameFolder(decodeURIComponent(folderMatch[1]!), decodeURIComponent(folderMatch[2]!), input.name);
      if (!folder) throw new NotFoundError("Folder not found");
      return json(response, 200, { folder });
    }
    if (folderMatch && request.method === "DELETE") {
      const deleted = await services.agents.deleteFolder(decodeURIComponent(folderMatch[1]!), decodeURIComponent(folderMatch[2]!));
      if (!deleted) throw new NotFoundError("Folder not found");
      return send(response, 204);
    }
    const memberMatch = /^\/v1\/agents\/([^/]+)\/folders\/([^/]+)\/members$/.exec(url.pathname);
    if (memberMatch && request.method === "POST") {
      const input = await body(request) as { flightId?: unknown; included?: unknown };
      if (typeof input.flightId !== "string" || typeof input.included !== "boolean") throw new InvalidStateError("flightId and included are required");
      await services.agents.setFolderMembership(decodeURIComponent(memberMatch[1]!), decodeURIComponent(memberMatch[2]!), input.flightId, input.included);
      return send(response, 204);
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ZodError) return json(response, 400, { error: "invalid_request", issues: error.issues });
    if (error instanceof VersionConflictError) return json(response, 409, { error: "version_conflict", currentVersion: error.currentVersion });
    if (error instanceof NotFoundError) return json(response, 404, { error: "not_found", message: error.message });
    if (error instanceof InvalidStateError) return json(response, 409, { error: "invalid_state", message: error.message });
    console.error(error);
    return json(response, 500, { error: "internal_error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.info(`Captain local API listening on http://127.0.0.1:${port}`);
});

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 512 * 1024) throw new InvalidStateError("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "http://127.0.0.1:4178");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,idempotency-key");
  response.setHeader("cache-control", "no-store");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function send(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.end();
}
