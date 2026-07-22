import type {
  AgentAction,
  AgentCheck,
  CheckMode,
  CreateFlightAgentInput,
  FlightAgent,
  FlightAgentSummary,
  FlightAgentWorkspace,
  FlightSource,
  FlightFolder,
  FlightSnapshot,
  FlightWorkspaceItem,
  PriceObservation,
  ResearchResult
} from "../domain/types.js";

export type CheckTrigger = AgentCheck["trigger"];

export type ClaimedCheck = {
  agent: FlightAgent;
  check: AgentCheck;
};

export type CompletedCheck = {
  matrix: AgentCheck["matrix"];
  snapshots: FlightSnapshot[];
  searchCursor: number;
  searched: number;
  offersFound: number;
  research: ResearchResult | null;
  status?: "completed" | "partial";
  duffelError?: string | null;
  identitiesMatched?: number;
  nextCheckAt: string;
};

export type RecordedCheckSource = {
  source: FlightSource;
  status: "completed" | "failed";
  snapshots: FlightSnapshot[];
  searched: number;
  offersFound: number;
  error: string | null;
  research: ResearchResult | null;
};

export type FailedCheck = {
  error: string;
  matrix: AgentCheck["matrix"];
  searchCursor: number;
  nextCheckAt: string;
};

export type FlightDetails = {
  flight: FlightWorkspaceItem;
  observations: PriceObservation[];
  relatedChecks: AgentCheck[];
  research: ResearchResult[];
};

export type IdempotencyRecord = {
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
};

export interface FlightAgentStore {
  createAgent(key: string, input: CreateFlightAgentInput, now: Date): Promise<FlightAgent>;
  deleteAgent(key: string, createIdempotencyKey: string): Promise<boolean>;
  listAgents(options?: { status?: string; limit?: number; cursor?: string }): Promise<{
    agents: FlightAgentSummary[];
    nextCursor: string | null;
  }>;
  getWorkspace(key: string): Promise<FlightAgentWorkspace | null>;
  getFlightDetails(key: string, flightId: string): Promise<FlightDetails | null>;
  claimCheck(key: string, trigger: CheckTrigger, mode: CheckMode, force: boolean, now: Date): Promise<ClaimedCheck | null>;
  listDueAgentKeys(now: Date, limit: number): Promise<string[]>;
  recordCheckSource(key: string, checkId: string, result: RecordedCheckSource, now: Date): Promise<void>;
  completeCheck(key: string, checkId: string, result: CompletedCheck, now: Date): Promise<void>;
  failCheck(key: string, checkId: string, result: FailedCheck, now: Date): Promise<void>;
  applyAction(key: string, action: AgentAction, now: Date): Promise<FlightAgent>;
  createFolder(key: string, name: string, now: Date): Promise<FlightFolder>;
  renameFolder(key: string, folderId: string, name: string, now: Date): Promise<FlightFolder | null>;
  deleteFolder(key: string, folderId: string, now: Date): Promise<boolean>;
  setFolderMembership(key: string, folderId: string, flightId: string, included: boolean, now: Date): Promise<void>;
  getIdempotency(scope: string, key: string): Promise<IdempotencyRecord | null>;
  putIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void>;
  close(): Promise<void>;
}
