import type { TravellerProfile } from "@agents/flight-domain";

export type LanguagePreferenceStore = {
  ensureProfile(userId: string, now: Date): Promise<TravellerProfile>;
  claimDetectedLanguage(
    userId: string,
    language: string,
    now: Date
  ): Promise<{ claimed: boolean; profile: TravellerProfile }>;
};

export async function learnLanguageFromDeliveredExchange(input: {
  userId: string;
  userText: string;
  assistantText: string;
  store: LanguagePreferenceStore;
  detectMatchingLanguage(userText: string, assistantText: string): Promise<string | null>;
  now?: () => Date;
}): Promise<{ claimed: boolean; language: string | null }> {
  const now = input.now ?? (() => new Date());
  const profile = await input.store.ensureProfile(input.userId, now());
  if (profile.preferredLanguageSource !== "default") {
    return { claimed: false, language: null };
  }
  const language = await input.detectMatchingLanguage(input.userText, input.assistantText);
  if (!language) return { claimed: false, language: null };
  const result = await input.store.claimDetectedLanguage(input.userId, language, now());
  return { claimed: result.claimed, language };
}
