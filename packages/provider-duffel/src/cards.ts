import { z } from "zod";

const componentClientKeySchema = z.object({
  data: z.object({
    component_client_key: z.string().min(1)
  })
});

const errorSchema = z.object({
  errors: z.array(z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    title: z.string().optional()
  })).default([])
});

export type DuffelCardsErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "not_found";

export class DuffelCardsError extends Error {
  constructor(
    readonly code: DuffelCardsErrorCode,
    message?: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(message ?? `Duffel cards request failed: ${code}`);
    this.name = "DuffelCardsError";
  }
}

/** Parse Retry-After as positive delta-seconds or an HTTP-date. Invalid/missing → null. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  }
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return null;
  const delta = when - now;
  return delta > 0 ? delta : null;
}

export class DuffelCardsClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #cardsBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    accessToken: string;
    baseUrl?: string;
    cardsBaseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#token = options.accessToken.trim();
    if (!this.#token) throw new Error("DUFFEL_ACCESS_TOKEN is required");
    this.#baseUrl = (options.baseUrl ?? "https://api.duffel.com").replace(/\/$/u, "");
    this.#cardsBaseUrl = (options.cardsBaseUrl ?? "https://api.duffel.cards").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async createComponentClientKey(): Promise<string> {
    const payload = await this.#request(
      this.#baseUrl,
      "POST",
      "/identity/component_client_keys",
      {}
    );
    const parsed = componentClientKeySchema.safeParse(payload);
    if (!parsed.success) {
      throw new DuffelCardsError("invalid_response", "Invalid component client key response");
    }
    return parsed.data.data.component_client_key;
  }

  async deleteCard(cardId: string, timeoutMs = this.#timeoutMs): Promise<void> {
    try {
      await this.#request(
        this.#cardsBaseUrl,
        "DELETE",
        `/payments/cards/${encodeURIComponent(cardId)}`,
        undefined,
        timeoutMs
      );
    } catch (error) {
      if (error instanceof DuffelCardsError && error.code === "not_found") return;
      throw error;
    }
  }

  async #request(
    host: string,
    method: string,
    path: string,
    body: unknown,
    timeoutMs = this.#timeoutMs
  ): Promise<unknown> {
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          "duffel-version": "v2",
          ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        signal: AbortSignal.timeout(timeoutMs)
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await this.#fetch(`${host}${path}`, init);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DuffelCardsError("timeout");
      }
      throw new DuffelCardsError("unavailable");
    }

    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (response.ok) return payload;

    const parsed = errorSchema.safeParse(payload);
    const detail = parsed.success
      ? parsed.data.errors.map((entry) => entry.message || entry.title || entry.code).filter(Boolean).join("; ")
      : undefined;
    if (response.status === 401 || response.status === 403) {
      throw new DuffelCardsError("unauthorized", detail);
    }
    if (response.status === 404) {
      throw new DuffelCardsError("not_found", detail);
    }
    if (response.status === 422 || response.status === 400) {
      throw new DuffelCardsError("invalid_request", detail);
    }
    if (response.status === 429) {
      throw new DuffelCardsError(
        "rate_limited",
        detail,
        parseRetryAfterMs(response.headers.get("retry-after"))
      );
    }
    throw new DuffelCardsError("unavailable", detail);
  }
}
