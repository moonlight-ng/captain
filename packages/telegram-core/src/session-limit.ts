/** Eve session-limit HITL tool name from `eve/dist/.../session-limit-continuation.js`. */
export const SESSION_LIMIT_CONTINUATION_TOOL_NAME = "session_limit_continuation";
export const SESSION_LIMIT_STOP_OPTION_ID = "stop";
export const SESSION_LIMIT_CONTINUE_OPTION_ID = "continue";

export type SessionLimitInputRequest = {
  requestId: string;
  prompt: string;
  action?: {
    toolName?: string;
  };
  options?: ReadonlyArray<{ id: string; label: string }>;
};

export type PendingSessionRotation = {
  chatId: string;
  requestId: string;
  continueCallbackData: string;
};

const SESSION_LIMIT_STATE_KEY = "telegramSessionLimitRotation";
const lastTextByChat = new Map<string, string>();
const handledLimitRequestIds = new Set<string>();

export function rememberTelegramText(chatId: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed) lastTextByChat.set(chatId, trimmed);
}

export function takeRememberedTelegramText(chatId: string): string | null {
  const text = lastTextByChat.get(chatId) ?? null;
  lastTextByChat.delete(chatId);
  return text;
}

/** Compatibility aliases for Pilot callers while the shared helper rolls out. */
export const rememberOwnerTelegramText = rememberTelegramText;
export const takeRememberedOwnerTelegramText = takeRememberedTelegramText;

export function looksLikeSessionBudgetPrompt(prompt: string): boolean {
  return /input-token budget|output-token budget|fresh budget|token budget|Continue with a fresh budget/iu
    .test(prompt);
}

export function isSessionLimitContinuationRequest(
  request: SessionLimitInputRequest
): boolean {
  const toolName = request.action?.toolName;
  if (
    toolName === SESSION_LIMIT_CONTINUATION_TOOL_NAME
    || toolName?.includes("session_limit") === true
  ) {
    return true;
  }
  if (looksLikeSessionBudgetPrompt(request.prompt)) return true;
  const optionIds = new Set((request.options ?? []).map((option) => option.id));
  const optionLabels = new Set(
    (request.options ?? []).map((option) => option.label.trim().toLowerCase())
  );
  const hasContinueStop =
    (optionIds.has(SESSION_LIMIT_CONTINUE_OPTION_ID) && optionIds.has(SESSION_LIMIT_STOP_OPTION_ID))
    || (optionLabels.has("continue") && optionLabels.has("stop"));
  return hasContinueStop && looksLikeSessionBudgetPrompt(request.prompt);
}

export function partitionSessionLimitRequests(
  requests: readonly SessionLimitInputRequest[]
): {
  limitRequests: SessionLimitInputRequest[];
  otherRequests: SessionLimitInputRequest[];
} {
  const limitRequests: SessionLimitInputRequest[] = [];
  const otherRequests: SessionLimitInputRequest[] = [];
  for (const request of requests) {
    if (isSessionLimitContinuationRequest(request)) limitRequests.push(request);
    else otherRequests.push(request);
  }
  return { limitRequests, otherRequests };
}

export function claimSessionLimitRequest(requestId: string): boolean {
  if (handledLimitRequestIds.has(requestId)) return false;
  handledLimitRequestIds.add(requestId);
  if (handledLimitRequestIds.size > 100) {
    const oldest = handledLimitRequestIds.values().next().value;
    if (oldest !== undefined) handledLimitRequestIds.delete(oldest);
  }
  return true;
}

export function retiredContinuationToken(chatId: string, nowMs = Date.now()): string {
  return `${chatId}:retired:${nowMs}:`;
}

export function sessionLimitStopResponse(requestId: string): {
  requestId: string;
  optionId: string;
} {
  return { requestId, optionId: SESSION_LIMIT_STOP_OPTION_ID };
}

export function hitlCallbackDataFromMarkup(
  replyMarkup: unknown,
  label: string
): string | null {
  if (!replyMarkup || typeof replyMarkup !== "object") return null;
  const keyboard = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(keyboard)) return null;
  const wanted = label.trim().toLowerCase();
  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button || typeof button !== "object") continue;
      const text = "text" in button && typeof button.text === "string" ? button.text : "";
      const callbackData =
        "callback_data" in button && typeof button.callback_data === "string"
          ? button.callback_data
          : "";
      if (text.trim().toLowerCase() === wanted && callbackData.startsWith("eve:")) {
        return callbackData;
      }
    }
  }
  return null;
}

export function stopCallbackDataFromMarkup(replyMarkup: unknown): string | null {
  return hitlCallbackDataFromMarkup(replyMarkup, "stop");
}

export function continueCallbackDataFromMarkup(replyMarkup: unknown): string | null {
  return hitlCallbackDataFromMarkup(replyMarkup, "continue");
}

export function storePendingSessionRotation(
  state: object,
  pending: PendingSessionRotation
): void {
  (state as Record<string, unknown>)[SESSION_LIMIT_STATE_KEY] = pending;
}

export function takePendingSessionRotation(state: object): PendingSessionRotation | null {
  const recordState = state as Record<string, unknown>;
  const pending = recordState[SESSION_LIMIT_STATE_KEY];
  delete recordState[SESSION_LIMIT_STATE_KEY];
  if (!pending || typeof pending !== "object") return null;
  const record = pending as Record<string, unknown>;
  if (
    typeof record.chatId !== "string"
    || typeof record.requestId !== "string"
    || typeof record.continueCallbackData !== "string"
  ) {
    return null;
  }
  return {
    chatId: record.chatId,
    requestId: record.requestId,
    continueCallbackData: record.continueCallbackData
  };
}
