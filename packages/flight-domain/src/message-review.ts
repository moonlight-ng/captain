/**
 * Removes internal planning labels that should never be shown to a traveller.
 *
 * Captain can still use its structured goal to decide what matters. The goal
 * field itself is implementation context, though, so a leaked `Goal:` line is
 * dropped at the final text boundary. Keeping this review deterministic makes
 * the rule apply equally to templated and model-authored replies.
 */
export function reviewCaptainMessage(message: string): string {
  return message
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:[-*•]\s*)?(?:my\s+)?goal\s*:/iu.test(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
