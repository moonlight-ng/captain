export type AdminChannelIdentity = {
  channel: string;
  displayName: string;
  username: string | null;
};

export type AgentSessionStatus = "active" | "waiting" | "completed" | "failed";

export type AgentSession = {
  sessionId: string;
  userId: string | null;
  agentName: string;
  channel: string;
  model: string;
  status: AgentSessionStatus;
  startedAt: string;
  lastEventAt: string;
  lastTurnAt: string | null;
  endedAt: string | null;
  failureCode: string | null;
};

export type ModelUsageLookupStatus = "pending" | "complete" | "unavailable";

export type ModelUsageEvent = {
  eventKey: string;
  userId: string | null;
  sessionId: string | null;
  operation: string;
  model: string;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchCalls: number;
  costUsd: number | null;
  gatewayGenerationId: string | null;
  lookupStatus: ModelUsageLookupStatus;
  occurredAt: string;
};

export type AdminConversationSummary = {
  conversationId: string;
  userId: string;
  identities: AdminChannelIdentity[];
  lastMessage: {
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  } | null;
  lastActivityAt: string;
  messageCount: number;
  sessionCount: number;
  costUsd: number;
  unresolvedCostCount: number;
};

export type AdminConversationPage = {
  conversations: AdminConversationSummary[];
  nextCursor: string | null;
};

export type AdminConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type AdminConversationDetail = {
  conversation: AdminConversationSummary;
  messages: AdminConversationMessage[];
  sessions: AgentSession[];
  olderCursor: string | null;
};

export type AdminOverview = {
  health: {
    service: "available";
    database: "available" | "memory";
  };
  agent: {
    name: "Captain";
    environment: "production";
    status: "operational";
    model: string;
    lastActivityAt: string | null;
    activeTurns: number;
  };
  models: Array<{
    key: "owner_chat" | "trip_interpretation" | "trip_update" | "voice_transcription";
    label: string;
    model: string;
  }>;
  metrics: {
    users: number;
    conversations: number;
    messages24h: number;
    modelCalls30d: number;
    costUsd30d: number;
    unresolvedCostCount: number;
  };
  trackingStartedAt: string;
  recentConversations: AdminConversationSummary[];
};

export type AdminCostRange = "7d" | "30d" | "all";

export type AdminCostBreakdown = {
  key: string;
  label: string;
  costUsd: number;
  calls: number;
};

export type AdminCostReport = {
  range: AdminCostRange;
  from: string;
  through: string;
  trackingStartedAt: string;
  summary: {
    costUsd: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    unresolvedCostCount: number;
  };
  daily: Array<{ date: string; costUsd: number; calls: number }>;
  byModel: AdminCostBreakdown[];
  byOperation: AdminCostBreakdown[];
  topConversations: AdminConversationSummary[];
};

export type AdminTripActivityChannel = "system" | "telegram" | "web";

/** Trip-scoped agent audit item — mirrors extended `trip_events` / TripActivity. */
export type AdminTripActivity = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  body: string | null;
  channel: AdminTripActivityChannel;
  notificationId: string | null;
  sourceMessageId: string | null;
};

export type AdminTripFlight = {
  id: string;
  legLabel: string;
  airlineCode: string | null;
  routeLabel: string;
  departureDate: string | null;
  priceAmount: string | null;
  currency: string | null;
  selectedBy: "agent" | "person" | null;
  flightKey: string | null;
};

export type AdminAutomationState = {
  automationId: string;
  purpose: "price_changes" | "fare_digest";
  status: "active" | "scheduled" | "paused" | "completed";
  digestHourLocal: number | null;
  digestTimeZone: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runStartedAt: string;
  runEndsAt: string;
  completedAt: string | null;
  checksCompleted: number;
  delayReason: string | null;
  updatedAt: string;
};

export type AdminAutomationSummary = AdminAutomationState & {
  tripId: string;
  userId: string;
  conversationId: string | null;
  title: string;
  tripStatus: string;
  routeLabel: string;
  identities: AdminChannelIdentity[];
};

export type AdminAutomationPage = {
  automations: AdminAutomationSummary[];
  nextCursor: string | null;
};

export type AdminTripSummary = {
  tripId: string;
  userId: string;
  conversationId: string | null;
  title: string;
  status: string;
  routeLabel: string;
  updatedAt: string;
  identities: AdminChannelIdentity[];
  flightCount: number;
  latestActivityLabel: string | null;
  automation: AdminAutomationState | null;
};

export type AdminTripPage = {
  trips: AdminTripSummary[];
  nextCursor: string | null;
};

export type AdminTripDetail = {
  trip: AdminTripSummary;
  activity: AdminTripActivity[];
  flights: AdminTripFlight[];
};
