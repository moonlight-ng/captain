import { randomBytes } from "node:crypto";

import type { FlightAgentRunner } from "./runner.js";
import {
  agentActionSchema,
  InvalidStateError,
  type CheckMode,
  createFlightAgentSchema,
  type AgentAction,
  type CreateFlightAgentInput
} from "./types.js";
import type { FlightAgentStore } from "../store/contracts.js";

export class FlightAgentService {
  readonly #store: FlightAgentStore;
  readonly #runner: FlightAgentRunner;
  readonly #now: () => Date;

  constructor(options: {
    store: FlightAgentStore;
    runner: FlightAgentRunner;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateFlightAgentInput, key = makeAgentKey()) {
    const parsed = createFlightAgentSchema.parse(input);
    const agent = await this.#store.createAgent(key, parsed, this.#now());
    void this.#runner.run(key, "initial", false, "fare").catch((error) =>
      logBackgroundError(error, key)
    );
    return agent;
  }

  list(options?: { status?: string; limit?: number; cursor?: string }) {
    return this.#store.listAgents(options);
  }

  get(key: string) {
    return this.#store.getWorkspace(key);
  }

  delete(key: string, createIdempotencyKey: string) {
    return this.#store.deleteAgent(key, createIdempotencyKey);
  }

  getFlight(key: string, flightId: string) {
    return this.#store.getFlightDetails(key, flightId);
  }

  async action(key: string, input: AgentAction) {
    const action = agentActionSchema.parse(input);
    const agent = await this.#store.applyAction(key, action, this.#now());
    if (["run", "research", "resume", "update_brief"].includes(action.type)) {
      const trigger = action.type === "run" ? "manual" : action.type === "resume" ? "resume" : "manual";
      const mode = action.type === "research" ? "fare_and_research" : "fare";
      void this.#runner.run(key, trigger, true, mode).catch((error) =>
        logBackgroundError(error, key)
      );
    }
    return agent;
  }

  async requestCheck(key: string, mode: CheckMode): Promise<string> {
    const started = await this.#runner.start(key, "manual", true, mode);
    if (!started) throw new InvalidStateError("Flight agent already has a running check");
    void started.completion.catch((error) => logBackgroundError(error, key, started.checkId));
    return started.checkId;
  }

  async tick(limit = 4): Promise<number> {
    const keys = await this.#store.listDueAgentKeys(this.#now(), limit);
    await Promise.all(keys.map(async (key) => {
      const workspace = await this.#store.getWorkspace(key);
      const trigger = workspace?.agent.latestCheck?.status === "failed" ? "retry" : "scheduled";
      return this.#runner.run(key, trigger, false, "fare");
    }));
    return keys.length;
  }

  createFolder(key: string, name: string) {
    return this.#store.createFolder(key, name, this.#now());
  }

  renameFolder(key: string, folderId: string, name: string) {
    return this.#store.renameFolder(key, folderId, name, this.#now());
  }

  deleteFolder(key: string, folderId: string) {
    return this.#store.deleteFolder(key, folderId, this.#now());
  }

  setFolderMembership(key: string, folderId: string, flightId: string, included: boolean) {
    return this.#store.setFolderMembership(key, folderId, flightId, included, this.#now());
  }
}

function makeAgentKey(): string {
  return `fa_${randomBytes(10).toString("base64url")}`;
}

function logBackgroundError(
  error: unknown,
  agentKey: string,
  runId: string = crypto.randomUUID()
): void {
  console.error(JSON.stringify({
    service: "captain",
    agent_id: "captain",
    event: "captain.background_run_failed",
    run_id: runId,
    status: "failed",
    duration_ms: 0,
    error_code: error instanceof Error ? error.name : "UnknownError",
    agent_key: agentKey
  }));
}
