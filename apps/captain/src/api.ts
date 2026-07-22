import type {
  AgentSummary,
  BrowsePreferences,
  CadenceHours,
  FlightAgent,
  FlightAgentBrief,
  FlightDetails,
  TrackingWindowDays,
  Workspace
} from "./domain";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function listAgents(): Promise<AgentSummary[]> {
  const result = await api<{ agents: AgentSummary[] }>("/v1/agents");
  return result.agents;
}

export async function createAgent(brief: FlightAgentBrief): Promise<FlightAgent> {
  const result = await api<{ agent: FlightAgent }>("/v1/agents", {
    method: "POST",
    body: JSON.stringify({ brief, cadenceHours: 6, requestedBy: "owner" }),
    idempotent: true
  });
  return result.agent;
}

export async function getWorkspace(key: string): Promise<Workspace> {
  const result = await api<{ workspace: Workspace }>(`/v1/agents/${encodeURIComponent(key)}`);
  return result.workspace;
}

export async function getFlightDetails(agentKey: string, flightId: string): Promise<FlightDetails> {
  const result = await api<{ details: FlightDetails }>(
    `/v1/agents/${encodeURIComponent(agentKey)}/flights/${encodeURIComponent(flightId)}`
  );
  return result.details;
}

export async function agentAction(
  agent: FlightAgent,
  action:
    | { type: "pause" | "resume" | "run" | "research" }
    | { type: "update_brief"; brief: FlightAgentBrief }
    | { type: "set_cadence"; cadenceHours: CadenceHours }
    | { type: "set_tracking_window"; trackingWindowDays: TrackingWindowDays }
    | { type: "set_browse_preferences"; preferences: BrowsePreferences }
    | { type: "retain_flight" | "dismiss_flight"; flightKey: string }
): Promise<FlightAgent> {
  const result = await api<{ agent: FlightAgent }>(`/v1/agents/${encodeURIComponent(agent.key)}/actions`, {
    method: "POST",
    body: JSON.stringify({ ...action, expectedVersion: agent.version }),
    idempotent: true
  });
  return result.agent;
}

export async function createFolder(agentKey: string, name: string): Promise<void> {
  await api(`/v1/agents/${encodeURIComponent(agentKey)}/folders`, {
    method: "POST",
    body: JSON.stringify({ name }),
    idempotent: true
  });
}

export async function renameFolder(agentKey: string, folderId: string, name: string): Promise<void> {
  await api(`/v1/agents/${encodeURIComponent(agentKey)}/folders/${encodeURIComponent(folderId)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
    idempotent: true
  });
}

export async function deleteFolder(agentKey: string, folderId: string): Promise<void> {
  await api(`/v1/agents/${encodeURIComponent(agentKey)}/folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
    idempotent: true
  });
}

export async function setFolderMembership(
  agentKey: string,
  folderId: string,
  flightId: string,
  included: boolean
): Promise<void> {
  await api(`/v1/agents/${encodeURIComponent(agentKey)}/folders/${encodeURIComponent(folderId)}/members`, {
    method: "POST",
    body: JSON.stringify({ flightId, included }),
    idempotent: true
  });
}

async function api<T = unknown>(
  path: string,
  options: RequestInit & { idempotent?: boolean } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  if (options.idempotent) headers.set("idempotency-key", crypto.randomUUID());
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json() as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // Preserve the HTTP fallback.
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
