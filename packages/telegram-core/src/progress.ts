export const TELEGRAM_PROGRESS_DELAY_MS = 1_000;
// An opening acknowledgement is the traveller's receipt that Captain heard
// them, so it goes up far sooner than a named step—but not instantly, or every
// one-line answer would flash a status message it never needed.
export const TELEGRAM_PROGRESS_OPENING_DELAY_MS = 400;
// How long one line may sit before it reads as a stall rather than as work.
export const TELEGRAM_PROGRESS_HOLDING_INTERVAL_MS = 7_000;
export const TELEGRAM_TYPING_KEEPALIVE_MS = 4_000;

export type TelegramTurnProgress = {
  chatId: string;
  messageId: string | null;
  turnId: string;
  statusText: string | null;
  renderedText: string | null;
  holdingLines: readonly string[];
  holdingIndex: number;
  holdingIntervalMs: number;
  holdingTimer: ReturnType<typeof setTimeout> | null;
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
   * Starts a turn on one status message that is posted, edited in place through
   * however many stages the work takes, and deleted before the real answer
   * lands. `opening` is what Captain says before it knows anything—an
   * acknowledgement, not a claim about the work. `holdingLines` take over when a
   * single step outlasts its welcome, so a slow turn still visibly moves.
   * Without either, the turn runs on the typing indicator alone until a named
   * step arrives.
   */
  start(input: {
    sessionId: string;
    chatId: string;
    turnId: string;
    onShow: (statusText: string) => string | null | Promise<string | null>;
    onEdit: (messageId: string, statusText: string) => void | Promise<void>;
    onDiscard: (messageId: string) => void | Promise<void>;
    onTyping?: () => void | Promise<void>;
    opening?: string;
    openingDelayMs?: number;
    holdingLines?: readonly string[];
    holdingIntervalMs?: number;
    delayMs?: number;
  }): TelegramTurnProgress {
    void this.clear(input.sessionId);
    const progress: TelegramTurnProgress = {
      chatId: input.chatId,
      messageId: null,
      turnId: input.turnId,
      statusText: null,
      renderedText: null,
      holdingLines: input.holdingLines ?? [],
      holdingIndex: -1,
      holdingIntervalMs: input.holdingIntervalMs ?? TELEGRAM_PROGRESS_HOLDING_INTERVAL_MS,
      holdingTimer: null,
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
    if (input.opening) {
      progress.statusText = input.opening;
      this.#scheduleShow(
        input.sessionId,
        progress,
        input.openingDelayMs ?? TELEGRAM_PROGRESS_OPENING_DELAY_MS
      );
    }
    return progress;
  }

  async setStatus(
    sessionId: string,
    turnId: string,
    statusText: string
  ): Promise<TelegramTurnProgress | undefined> {
    const progress = this.#bySession.get(sessionId);
    if (!progress || progress.turnId !== turnId) return undefined;
    // A repeated step is the same step still running: leave whatever line is on
    // screen alone rather than rewinding a holding line back to its status.
    if (progress.statusText === statusText) return progress;
    progress.statusText = statusText;
    progress.holdingIndex = -1;
    // A scheduled or in-flight post picks up the latest text by itself.
    if (progress.showTimer || progress.posting) return progress;
    if (!progress.messageId) {
      this.#scheduleShow(sessionId, progress, progress.delayMs);
      return progress;
    }
    await this.#edit(progress, statusText);
    this.#scheduleHold(sessionId, progress);
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
    if (progress.holdingTimer) {
      clearTimeout(progress.holdingTimer);
      progress.holdingTimer = null;
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

  #scheduleShow(
    sessionId: string,
    progress: TelegramTurnProgress,
    delayMs: number
  ): void {
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
          progress.renderedText = shown;
          if (progress.statusText && progress.statusText !== shown) {
            await this.#edit(progress, progress.statusText);
          }
          this.#scheduleHold(sessionId, progress);
        })
        .catch(() => undefined)
        .finally(() => {
          progress.posting = false;
        });
    }, delayMs);
    progress.showTimer.unref?.();
  }

  /**
   * Advances to the next holding line once the current one has been on screen
   * long enough to look stuck. The last line stays: Captain runs out of things
   * to say about waiting before it runs out of waiting.
   */
  #scheduleHold(sessionId: string, progress: TelegramTurnProgress): void {
    if (progress.holdingTimer) {
      clearTimeout(progress.holdingTimer);
      progress.holdingTimer = null;
    }
    if (progress.holdingIndex + 1 >= progress.holdingLines.length) return;
    progress.holdingTimer = setTimeout(() => {
      progress.holdingTimer = null;
      if (this.#bySession.get(sessionId) !== progress || !progress.messageId) return;
      progress.holdingIndex += 1;
      const line = progress.holdingLines[progress.holdingIndex];
      if (!line) return;
      void Promise.resolve(this.#edit(progress, line))
        .catch(() => undefined)
        .finally(() => {
          this.#scheduleHold(sessionId, progress);
        });
    }, progress.holdingIntervalMs);
    progress.holdingTimer.unref?.();
  }

  async #edit(progress: TelegramTurnProgress, text: string): Promise<void> {
    if (!progress.messageId || progress.renderedText === text) return;
    progress.renderedText = text;
    await Promise.resolve(progress.onEdit(progress.messageId, text)).catch(
      () => undefined
    );
  }
}
