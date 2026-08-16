import { signFeedback } from "../feedback/telegram-bridge.js";
import type {
  EmailPayload,
  EmailSender,
  EmailSendResult
} from "./resend.js";

const CAPTAIN_REVIEW_PATH = "/internal/v1/captain-conversation-review";
const REQUEST_TIMEOUT_MS = 20_000;

export class PilotBridgeEmailSender implements EmailSender {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: {
    baseUrl: string;
    secret: string;
    fetch?: typeof fetch;
    now?: () => Date;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async send(
    payload: EmailPayload,
    options: { idempotencyKey: string }
  ): Promise<EmailSendResult> {
    const now = this.#now();
    const body = JSON.stringify({
      version: 1,
      source: "captain",
      deliveryId: options.idempotencyKey,
      subject: payload.subject,
      text: payload.text,
      html: payload.html
    });
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    try {
      const response = await this.#fetch(`${this.#baseUrl}${CAPTAIN_REVIEW_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pilot-timestamp": timestamp,
          "x-pilot-signature": signFeedback(body, this.#secret, timestamp)
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const result = await response.json().catch(() => null) as {
        delivered?: unknown;
        deliveryId?: unknown;
        error?: unknown;
      } | null;
      if (
        !response.ok
        || result?.delivered !== true
        || result.deliveryId !== options.idempotencyKey
      ) {
        const error = typeof result?.error === "string"
          ? result.error
          : `http_${response.status}`;
        console.error(JSON.stringify({
          event: "captain.conversation_review_email_failed",
          transport: "pilot_bridge",
          error
        }));
        return { ok: false, error };
      }
      console.info(JSON.stringify({
        event: "captain.conversation_review_email_sent",
        transport: "pilot_bridge"
      }));
      return { ok: true, messageId: options.idempotencyKey };
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      console.error(JSON.stringify({
        event: "captain.conversation_review_email_failed",
        transport: "pilot_bridge",
        error: name
      }));
      return { ok: false, error: name };
    }
  }
}
