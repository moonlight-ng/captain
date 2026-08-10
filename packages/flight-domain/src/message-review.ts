/**
 * Removes internal planning labels and generic acknowledgement openers that
 * should never be shown to a traveller.
 *
 * Captain can still use its structured goal to decide what matters. The goal
 * field itself is implementation context, though, so a leaked `Goal:` line is
 * dropped at the final text boundary. Keeping this review deterministic makes
 * the rule apply equally to templated and model-authored replies.
 */
export function reviewCaptainMessage(message: string): string {
  const reviewed = message
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:[-*•]\s*)?(?:my\s+)?goal\s*:/iu.test(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (/^got it\s*[.!…]*$/iu.test(reviewed)) {
    return "What would you like me to do next?";
  }
  const withoutGenericOpening = reviewed
    .replace(/^got it(?:\s*[—–-]\s*|[,.!…:;]+\s*)/iu, "")
    .trim();
  return withoutGenericOpening.replace(/^\p{Ll}/u, (letter) =>
    letter.toLocaleUpperCase("en")
  );
}
