export const TELEGRAM_PROGRESS_DELAY_MS = 1_000;
export const TELEGRAM_TYPING_KEEPALIVE_MS = 4_000;

export type TelegramTurnProgress = {
  chatId: string;
  messageId: string | null;
  turnId: string;
  statusText: string | null;
  delayMs: number;
  posting: boolean;
  showTimer: ReturnType<typeof setTimeout> | null;
  keepalive: ReturnType<typeof setInterval> | null;
  onShow: (statusText: string) => string | null | Promise<string | null>;
  onEdit: (messageId: string, statusText: string) => void | Promise<void>;
  onDiscard: (messageId: string) => void | Promise<void>;
};

const GENERIC_TOOL_STATUS: Readonly<Record<string, string>> = {
  ask_question: "Narrowing down one detail…",
  web_search: "Searching the web…",
  web_fetch: "Reading the source…",
  read_file: "Reading the relevant files…",
  grep: "Searching the files…",
  glob: "Finding the relevant files…",
  write_file: "Making the changes…",
  bash: "Running the next step…",
  agent: "Coordinating the next step…"
};

/**
 * Progress copy names work that is actually running, so an unrecognised tool
 * reports nothing and the chat keeps Telegram's typing indicator on its own.
 */
export function statusTextForToolNames(
  toolNames: readonly string[],
  statusByTool: Readonly<Record<string, string>> = {},
  fallback: string | null = null
): string | null {
  for (const rawName of toolNames) {
    const name = rawName.trim();
    if (!name) continue;
    const status = statusByTool[name] ?? GENERIC_TOOL_STATUS[name];
    if (status) return status;
  }
  return fallback;
}

export function toolNamesFromActions(
  actions: ReadonlyArray<{ toolName?: string; name?: string }>
): string[] {
  const names: string[] = [];
  for (const action of actions) {
    const name = action.toolName ?? action.name;
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return names;
}

export class TelegramProgressTracker {
  readonly #bySession = new Map<string, TelegramTurnProgress>();

  get(sessionId: string): TelegramTurnProgress | undefined {
    return this.#bySession.get(sessionId);
  }

  /**
   * Starts a turn with the typing indicator alone. A status message is posted
   * only once `setStatus` reports a step worth naming, and only if that step is
   * still running after the delay.
   */
  start(input: {
    sessionId: string;
    chatId: string;
    turnId: string;
    onShow: (statusText: string) => string | null | Promise<string | null>;
    onEdit: (messageId: string, statusText: string) => void | Promise<void>;
    onDiscard: (messageId: string) => void | Promise<void>;
    onTyping?: () => void | Promise<void>;
    delayMs?: number;
  }): TelegramTurnProgress {
    void this.clear(input.sessionId);
    const progress: TelegramTurnProgress = {
      chatId: input.chatId,
      messageId: null,
      turnId: input.turnId,
      statusText: null,
      delayMs: input.delayMs ?? TELEGRAM_PROGRESS_DELAY_MS,
      posting: false,
      showTimer: null,
      keepalive: null,
      onShow: input.onShow,
      onEdit: input.onEdit,
      onDiscard: input.onDiscard
    };

    if (input.onTyping) {
      progress.keepalive = setInterval(() => {
        void Promise.resolve(input.onTyping!()).catch(() => undefined);
      }, TELEGRAM_TYPING_KEEPALIVE_MS);
      progress.keepalive.unref?.();
    }

    this.#bySession.set(input.sessionId, progress);
    return progress;
  }

  async setStatus(
    sessionId: string,
    turnId: string,
    statusText: string
  ): Promise<TelegramTurnProgress | undefined> {
    const progress = this.#bySession.get(sessionId);
    if (!progress || progress.turnId !== turnId) return undefined;
    if (progress.statusText === statusText) return progress;
    progress.statusText = statusText;
    // A scheduled or in-flight post picks up the latest text by itself.
    if (progress.showTimer || progress.posting) return progress;
    if (!progress.messageId) {
      this.#scheduleShow(sessionId, progress);
      return progress;
    }
    await Promise.resolve(progress.onEdit(progress.messageId, statusText)).catch(
      () => undefined
    );
    return progress;
  }

  async clear(sessionId: string): Promise<TelegramTurnProgress | undefined> {
    const progress = this.#bySession.get(sessionId);
    if (!progress) return undefined;
    this.#bySession.delete(sessionId);
    if (progress.showTimer) {
      clearTimeout(progress.showTimer);
      progress.showTimer = null;
    }
    if (progress.keepalive) {
      clearInterval(progress.keepalive);
      progress.keepalive = null;
    }
    if (progress.messageId) {
      await Promise.resolve(progress.onDiscard(progress.messageId)).catch(
        () => undefined
      );
    }
    return progress;
  }

  #scheduleShow(sessionId: string, progress: TelegramTurnProgress): void {
    progress.showTimer = setTimeout(() => {
      progress.showTimer = null;
      const shown = progress.statusText;
      if (!shown) return;
      progress.posting = true;
      void Promise.resolve(progress.onShow(shown))
        .then(async (messageId) => {
          if (!messageId) return;
          if (this.#bySession.get(sessionId) !== progress) {
            await progress.onDiscard(messageId);
            return;
          }
          progress.messageId = messageId;
          if (progress.statusText && progress.statusText !== shown) {
            await progress.onEdit(messageId, progress.statusText);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          progress.posting = false;
        });
    }, progress.delayMs);
    progress.showTimer.unref?.();
  }
}
