import { localDev } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";

import { getCaptainServices } from "../../services/app/services.js";

export default eveChannel({
  auth: [
    (request) => process.env.NODE_ENV === "production" ? null : localDev()(request)
  ],
  uploadPolicy: "disabled",
  async onMessage(context) {
    const auth = defaultEveAuth(context);
    if (!auth || process.env.NODE_ENV === "production") return null;
    const services = await getCaptainServices();
    const user = await services.platformStore.ensureTelegramUser({
      telegramUserId: 9_000_000_001,
      telegramChatId: 9_000_000_001,
      username: "captain_local_eval",
      firstName: "Local",
      lastName: "Traveller"
    }, new Date());
    return {
      auth: {
        ...auth,
        attributes: {
          ...auth.attributes,
          captain_principal: "traveller",
          captain_user_id: user.id
        }
      }
    };
  }
});
