export type EmailPayload = {
  subject: string;
  text: string;
  html: string;
};

export type EmailSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string };

export interface EmailSender {
  send(payload: EmailPayload, options: { idempotencyKey: string }): Promise<EmailSendResult>;
}

export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #recipients: string[];

  constructor(options: {
    apiKey: string;
    from: string;
    recipients: string[];
  }) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#recipients = [...options.recipients];
  }

  async send(
    payload: EmailPayload,
    options: { idempotencyKey: string }
  ): Promise<EmailSendResult> {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          "idempotency-key": options.idempotencyKey
        },
        body: JSON.stringify({
          from: this.#from,
          to: this.#recipients,
          subject: payload.subject,
          text: payload.text,
          html: payload.html
        }),
        signal: AbortSignal.timeout(20_000)
      });
      const body = await response.json().catch(() => null) as {
        id?: string;
        name?: string;
      } | null;
      if (!response.ok) {
        const error = body?.name || `http_${response.status}`;
        console.error(JSON.stringify({
          event: "captain.conversation_review_email_failed",
          error,
          recipient_count: this.#recipients.length
        }));
        return { ok: false, error };
      }
      console.info(JSON.stringify({
        event: "captain.conversation_review_email_sent",
        recipient_count: this.#recipients.length
      }));
      return { ok: true, messageId: body?.id ?? null };
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      console.error(JSON.stringify({
        event: "captain.conversation_review_email_failed",
        error: name,
        recipient_count: this.#recipients.length
      }));
      return { ok: false, error: name };
    }
  }
}
