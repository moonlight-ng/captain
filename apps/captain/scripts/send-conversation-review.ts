import { getCaptainServices } from "../services/app/services.js";

const services = await getCaptainServices();
if (!services.env.conversationReviewEnabled) {
  throw new Error("CAPTAIN_CONVERSATION_REVIEW_ENABLED must be true");
}
if (!services.conversationReview) {
  throw new Error(
    "Conversation review requires DATABASE_URL, AI_GATEWAY_API_KEY, "
    + "and either the Pilot bridge or configured Resend delivery"
  );
}

const requestedDate = process.argv.find((argument) => argument.startsWith("--date="))
  ?.slice("--date=".length);
const result = requestedDate
  ? await services.conversationReview.reviewDate(requestedDate)
  : await services.conversationReview.reviewNow();
await new Promise<void>((resolve) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => resolve());
});
// Service pools intentionally stay open in the long-lived Eve process. This
// command is a one-shot operator action, so exit after the durable delivery
// state and result have both been written.
process.exit(0);
