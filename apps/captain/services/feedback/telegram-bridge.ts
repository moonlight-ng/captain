import { createHmac, randomUUID } from "node:crypto";

const FEEDBACK_PATH = "/internal/v1/product-feedback";
const REQUEST_TIMEOUT_MS = 15_000;

export type FeedbackReporter = {
  telegramUserId: number;
  displayName: string;
};

export type FeedbackReceipt = {
  feedbackId: string;
  submittedAt: string;
};

export interface FeedbackBridge {
  send(text: string, reporter: FeedbackReporter): Promise<FeedbackReceipt>;
}

export class FeedbackBridgeUnavailableError extends Error {
  constructor() {
    super("The feedback bridge is not configured");
    this.name = "FeedbackBridgeUnavailableError";
  }
}

export class FeedbackDeliveryError extends Error {
  constructor(readonly status: number | null = null) {
    super(status === null
      ? "The feedback bridge request failed"
      : `The feedback bridge returned HTTP ${status}`);
    this.name = "FeedbackDeliveryError";
  }
}

export class DisabledFeedbackBridge implements FeedbackBridge {
  async send(): Promise<FeedbackReceipt> {
    throw new FeedbackBridgeUnavailableError();
  }
}

/**
 * Sends a bounded, signed event to Pilot's notification-only ingress. Pilot
 * forwards it to Telegram without opening an agent turn.
 */
export class HttpTelegramFeedbackBridge implements FeedbackBridge {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #feedbackId: () => string;

  constructor(options: {
    baseUrl: string;
    secret: string;
    fetch?: typeof fetch;
    now?: () => Date;
    feedbackId?: () => string;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#feedbackId = options.feedbackId ?? randomUUID;
  }

  async send(text: string, reporter: FeedbackReporter): Promise<FeedbackReceipt> {
    const submittedAt = this.#now();
    const feedbackId = this.#feedbackId();
    const body = JSON.stringify({
      version: 1,
      source: "captain",
      feedbackId,
      submittedAt: submittedAt.toISOString(),
      text,
      reporter: {
        ...reporter,
        displayName: reporter.displayName.trim() || "Captain traveller"
      }
    });
    const timestamp = String(Math.floor(submittedAt.getTime() / 1_000));
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${FEEDBACK_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pilot-timestamp": timestamp,
          "x-pilot-signature": signFeedback(body, this.#secret, timestamp)
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new FeedbackDeliveryError();
    }
    if (!response.ok) throw new FeedbackDeliveryError(response.status);
    const result = await response.json().catch(() => null) as {
      received?: unknown;
      feedbackId?: unknown;
    } | null;
    if (result?.received !== true || result.feedbackId !== feedbackId) {
      throw new FeedbackDeliveryError(response.status);
    }
    return { feedbackId, submittedAt: submittedAt.toISOString() };
  }
}

export function signFeedback(body: string, secret: string, timestamp: string): string {
  return `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
}
