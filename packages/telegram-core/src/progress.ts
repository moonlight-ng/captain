export const TELEGRAM_PROGRESS_ATTRIBUTE = "telegram_progress_text";
export const TELEGRAM_PROGRESS_DELAY_MS = 1_000;
export const TELEGRAM_TYPING_KEEPALIVE_MS = 4_000;

export const GENERAL_PROGRESS_FALLBACK = "Thinking that through…";
export const TRAVEL_PROGRESS_FALLBACK = "Thinking through your trip…";

type ProgressContext = "general" | "travel";

type ProgressRule = {
  pattern: RegExp;
  text: string;
};

export type TelegramTurnProgress = {
  chatId: string;
  messageId: string | null;
  turnId: string;
  statusText: string;
  showTimer: ReturnType<typeof setTimeout> | null;
  keepalive: ReturnType<typeof setInterval> | null;
  onDiscard: (messageId: string) => void | Promise<void>;
};

const GENERAL_RULES: readonly ProgressRule[] = [
  {
    pattern: /\b(?:search|find|look\s*up|research|latest|current|online|web)\b|https?:\/\//iu,
    text: "Looking that up…"
  },
  {
    pattern: /\b(?:debug|fix|broken|bug|error|failing|failure|crash|issue)\b/iu,
    text: "Tracing the issue…"
  },
  {
    pattern: /\b(?:compare|recommend|choose|best|option|trade-?offs?)\b/iu,
    text: "Comparing the options…"
  },
  {
    pattern: /\b(?:summari[sz]e|summary|key points|tl;?dr)\b/iu,
    text: "Pulling out the key points…"
  },
  {
    pattern: /\b(?:review|audit|inspect|analy[sz]e|assess|evaluate|check)\b/iu,
    text: "Reviewing the details…"
  },
  {
    pattern: /\b(?:write|draft|rewrite|compose|edit|email|message|resume|cover letter)\b/iu,
    text: "Drafting that…"
  },
  {
    pattern: /\b(?:plan|outline|roadmap|strategy|steps|approach)\b/iu,
    text: "Putting a plan together…"
  },
  {
    pattern: /\b(?:calculate|count|estimate|budget|total|percentage|forecast)\b/iu,
    text: "Running the numbers…"
  },
  {
    pattern: /\b(?:remember|recall|memory|notes?|journal)\b/iu,
    text: "Checking what I remember…"
  },
  {
    pattern: /\b(?:explain|why|how does|how do|what does|what is)\b/iu,
    text: "Thinking through the explanation…"
  }
];

const TRAVEL_RULES: readonly ProgressRule[] = [
  {
    pattern: /\b(?:cancel|pause|resume|refresh|remove|stop tracking|change|update|edit)\b/iu,
    text: "Updating your trip…"
  },
  {
    pattern: /\b(?:why|explain|reason|recommendation)\b/iu,
    text: "Reviewing that recommendation…"
  },
  {
    pattern: /\b(?:compare|cheapest|fastest|best|option|fare|price|flight|airline)\b/iu,
    text: "Comparing the flight options…"
  },
  {
    pattern: /\b(?:where|status|current|tracked|tracking|trip)\b/iu,
    text: "Checking your trip…"
  }
];

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

export function progressTextForRequest(
  text: string,
  options: {
    context?: ProgressContext;
    hasAttachments?: boolean;
  } = {}
): string {
  const context = options.context ?? "general";
  const normalized = text.trim();
  const rules = context === "travel" ? TRAVEL_RULES : GENERAL_RULES;
  const match = rules.find((rule) => rule.pattern.test(normalized));
  if (match) return match.text;
  if (options.hasAttachments) return "Reading what you sent…";
  return context === "travel"
    ? TRAVEL_PROGRESS_FALLBACK
    : GENERAL_PROGRESS_FALLBACK;
}

export function progressTextFromAttribute(
  value: unknown,
  fallback: string
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || candidate.length > 96
    || /[\r\n]/u.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}

export function statusTextForToolNames(
  toolNames: readonly string[],
  statusByTool: Readonly<Record<string, string>> = {},
  fallback = GENERAL_PROGRESS_FALLBACK
): string {
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

  start(input: {
    sessionId: string;
    chatId: string;
    turnId: string;
    statusText: string;
    onShow: (statusText: string) => string | null | Promise<string | null>;
    onDiscard: (messageId: string) => void | Promise<void>;
    onTyping?: () => void | Promise<void>;
    delayMs?: number;
  }): TelegramTurnProgress {
    void this.clear(input.sessionId);
    const progress: TelegramTurnProgress = {
      chatId: input.chatId,
      messageId: null,
      turnId: input.turnId,
      statusText: input.statusText,
      showTimer: null,
      keepalive: null,
      onDiscard: input.onDiscard
    };

    const delayMs = input.delayMs ?? TELEGRAM_PROGRESS_DELAY_MS;
    progress.showTimer = setTimeout(() => {
      progress.showTimer = null;
      void Promise.resolve(input.onShow(progress.statusText))
        .then(async (messageId) => {
          if (!messageId) return;
          if (this.#bySession.get(input.sessionId) === progress) {
            progress.messageId = messageId;
            return;
          }
          await input.onDiscard(messageId);
        })
        .catch(() => undefined);
    }, delayMs);
    progress.showTimer.unref?.();

    if (input.onTyping) {
      progress.keepalive = setInterval(() => {
        void Promise.resolve(input.onTyping!()).catch(() => undefined);
      }, TELEGRAM_TYPING_KEEPALIVE_MS);
      progress.keepalive.unref?.();
    }

    this.#bySession.set(input.sessionId, progress);
    return progress;
  }

  updateStatus(sessionId: string, turnId: string): TelegramTurnProgress | undefined {
    const progress = this.#bySession.get(sessionId);
    if (!progress || progress.turnId !== turnId) return undefined;
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
}
