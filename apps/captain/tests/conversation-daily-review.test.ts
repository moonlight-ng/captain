import { describe, expect, it, vi } from "vitest";

import type {
  CaptainConversationReviewStore,
  ConversationReviewThread
} from "@agents/flight-store";

import {
  ConversationDailyReview,
  buildConversationReviewEmail,
  sanitizeConversationReview,
  type ConversationReviewNarrative
} from "../services/review/conversation-daily-review.js";
import {
  localDateRange,
  previousDayRange
} from "../services/review/review-time.js";

const THREADS: ConversationReviewThread[] = [{
  conversationId: "conversation-1",
  userId: "user-1",
  displayName: "Ada",
  username: "ada",
  messageCount: 2,
  travellerMessageCount: 1,
  captainMessageCount: 1,
  modelCalls: 3,
  costUsd: 0.012345,
  unresolvedCostCount: 1,
  messages: [
    {
      id: "context-1",
      role: "user",
      content: "I want to fly to London.",
      createdAt: "2026-08-12T14:00:00.000Z",
      inWindow: false
    },
    {
      id: "message-1",
      role: "assistant",
      content: "Which city are you departing from?",
      createdAt: "2026-08-13T10:00:00.000Z",
      inWindow: true
    },
    {
      id: "message-2",
      role: "user",
      content: "I already said Lagos <again>.",
      createdAt: "2026-08-13T10:01:00.000Z",
      inWindow: true
    }
  ]
}];

const NARRATIVE: ConversationReviewNarrative = {
  conversationSummaries: [
    {
      conversationId: "conversation-1",
      summary: "The traveller planned a London flight but had to repeat the departure city."
    },
    {
      conversationId: "not-real",
      summary: "This must be discarded."
    }
  ],
  insights: [{
    title: "Known details were asked for again",
    detail: "Captain lost a route detail that was already present in the conversation.",
    conversationIds: ["conversation-1", "not-real"]
  }],
  attention: [
    {
      conversationId: "missing-conversation",
      severity: "high",
      diagnosis: "Invented conversation",
      reason: "This must be discarded.",
      evidenceMessageIds: ["message-2"]
    },
    {
      conversationId: "conversation-1",
      severity: "medium",
      diagnosis: "Traveller had to repeat the origin",
      reason: "Captain asked for information that had already been supplied.",
      evidenceMessageIds: ["context-1", "message-2", "not-real"]
    }
  ]
};

describe("Captain conversation daily review", () => {
  it("uses the previous Lagos calendar day", () => {
    expect(previousDayRange(
      new Date("2026-08-14T06:15:00.000Z"),
      "Africa/Lagos"
    )).toEqual({
      date: "2026-08-13",
      since: new Date("2026-08-12T23:00:00.000Z"),
      until: new Date("2026-08-13T23:00:00.000Z")
    });
    expect(localDateRange("2026-08-12", "Africa/Lagos")).toEqual({
      date: "2026-08-12",
      since: new Date("2026-08-11T23:00:00.000Z"),
      until: new Date("2026-08-12T23:00:00.000Z")
    });
  });

  it("discards invented references and only quotes in-window evidence", () => {
    const review = sanitizeConversationReview(NARRATIVE, THREADS);
    expect(review.conversations).toEqual([{
      thread: THREADS[0],
      summary: "The traveller planned a London flight but had to repeat the departure city."
    }]);
    expect(review.insights[0]?.conversationIds).toEqual(["conversation-1"]);
    expect(review.attention).toHaveLength(1);
    expect(review.attention[0]?.evidence.map((message) => message.id)).toEqual([
      "message-2"
    ]);

    const email = buildConversationReviewEmail({
      date: "2026-08-13",
      timeZone: "Africa/Lagos",
      threads: THREADS,
      review,
      adminBaseUrl: "https://captain.example"
    });
    expect(email.subject).toBe(
      "Captain conversation review · 13 Aug · 1 needs attention"
    );
    expect(email.text).toContain("Traveller: I already said Lagos <again>.");
    expect(email.text).toContain(
      "https://captain.example/admin/conversations/conversation-1"
    );
    expect(email.html).toContain("I already said Lagos &lt;again&gt;.");
    expect(email.text).not.toContain("Invented conversation");
    expect(email.text).toContain("Conversations\n- Ada: The traveller planned a London flight");
    expect(email.text).toContain("2 messages (1 traveller, 1 Captain)");
    expect(email.text).toContain("3 model calls");
    expect(email.text).toContain("$0.012345 AI spend");
    expect(email.text).toContain("1 cost pending");
    expect(email.html).toContain("<h2>Conversations</h2>");
    expect(email.html).not.toContain("<h2>Summary</h2>");
    expect(email.html).toContain("<table>");
    expect(email.html).toContain("<th>Tracked AI spend</th>");
    expect(email.html).not.toContain("class=\"metrics\"");
    const headingStyles = email.html.match(/h2\{([^}]*)\}/u)?.[1];
    expect(headingStyles).not.toContain("border-bottom");
  });

  it("claims, narrates, sends, and records one delivery", async () => {
    const store = storeFixture(THREADS);
    const narrate = vi.fn().mockResolvedValue(NARRATIVE);
    const send = vi.fn().mockResolvedValue({ ok: true, messageId: "email-1" });
    const review = new ConversationDailyReview({
      store,
      narrate,
      email: { send },
      config: {
        timeZone: "Africa/Lagos",
        recipients: ["owner@example.com", "reviewer@example.com"],
        adminBaseUrl: "https://captain.example"
      },
      now: () => new Date("2026-08-14T06:15:00.000Z")
    });

    await expect(review.reviewNow()).resolves.toEqual({
      date: "2026-08-13",
      conversationsReviewed: 1,
      travellersReviewed: 1,
      attentionCount: 1,
      emailSent: true,
      duplicate: false
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Captain conversation review · 13 Aug · 1 needs attention"
      }),
      { idempotencyKey: "captain-conversation-review/2026-08-13" }
    );
    expect(store.markConversationReviewDelivered).toHaveBeenCalledWith(
      "2026-08-13",
      "email-1",
      new Date("2026-08-14T06:15:00.000Z")
    );
  });

  it("does not narrate or send a duplicate date", async () => {
    const store = storeFixture(THREADS);
    vi.mocked(store.claimConversationReviewDelivery).mockResolvedValue("duplicate");
    const narrate = vi.fn();
    const send = vi.fn();
    const review = new ConversationDailyReview({
      store,
      narrate,
      email: { send },
      config: {
        timeZone: "Africa/Lagos",
        recipients: ["owner@example.com", "reviewer@example.com"],
        adminBaseUrl: "https://captain.example"
      },
      now: () => new Date("2026-08-14T06:15:00.000Z")
    });

    await expect(review.reviewNow()).resolves.toMatchObject({
      date: "2026-08-13",
      emailSent: false,
      duplicate: true
    });
    expect(narrate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("records a failed delivery without losing the original error", async () => {
    const store = storeFixture(THREADS);
    const review = new ConversationDailyReview({
      store,
      narrate: vi.fn().mockResolvedValue(NARRATIVE),
      email: {
        send: vi.fn().mockResolvedValue({ ok: false, error: "resend_error" })
      },
      config: {
        timeZone: "Africa/Lagos",
        recipients: ["owner@example.com", "reviewer@example.com"],
        adminBaseUrl: "https://captain.example"
      },
      now: () => new Date("2026-08-14T06:15:00.000Z")
    });

    await expect(review.reviewNow()).rejects.toThrow(
      "conversation_review_email_resend_error"
    );
    expect(store.markConversationReviewFailed).toHaveBeenCalledWith(
      "2026-08-13",
      "conversation_review_email_resend_error",
      new Date("2026-08-14T06:15:00.000Z")
    );
  });
});

function storeFixture(threads: ConversationReviewThread[]) {
  return {
    loadConversationReviewThreads: vi.fn().mockResolvedValue(threads),
    claimConversationReviewDelivery: vi.fn().mockResolvedValue("new"),
    markConversationReviewDelivered: vi.fn().mockResolvedValue(undefined),
    markConversationReviewFailed: vi.fn().mockResolvedValue(undefined)
  } satisfies CaptainConversationReviewStore;
}
