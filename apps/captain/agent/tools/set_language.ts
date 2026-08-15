import { languageDisplayName } from "@agents/telegram-core";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";
import { reportingFailures } from "../lib/tool-failure.js";

export default defineTool({
  description: [
    "Set the traveller's preferred response language only after an explicit request to change it.",
    "Accept a language name or BCP-47 tag. Return the confirmation verbatim in the saved language.",
    "Never call this merely because the traveller wrote one message in another language."
  ].join(" "),
  inputSchema: z.object({ language: z.string().trim().min(2).max(80) }).strict(),
  async execute({ language }, ctx) {
    return reportingFailures(async () => {
      const userId = requireCaptainUser(ctx);
      const services = await getCaptainServices();
      const languageTag = await services.language.resolveLanguageName(language);
      if (!languageTag) {
        return {
          status: "needs_input" as const,
          message: "Which language should I use? Name it plainly, for example French or Spanish."
        };
      }
      const current = await services.platformStore.ensureProfile(userId, new Date());
      const alreadySelected = current.preferredLanguage === languageTag
        && current.preferredLanguageSource !== "default";
      const profile = alreadySelected
        ? current
        : await services.platformStore.updateProfile(
            userId,
            { preferredLanguage: languageTag },
            new Date()
          );
      const name = languageDisplayName(languageTag, languageTag);
      const source = alreadySelected
        ? `${name} is already your preferred language.`
        : `Done. I’ll continue in ${name}.`;
      return {
        status: alreadySelected ? "unchanged" as const : "saved" as const,
        languageTag: profile.preferredLanguage,
        message: await services.language.localize(source, languageTag)
      };
    });
  }
});
