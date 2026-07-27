import {
  createCaptainAccessLink,
  resolveCaptainAccessToken,
  type CaptainWebPath
} from "@agents/flight-domain";

export class CaptainWebAuth {
  readonly #publicUrl: string;
  readonly #secret: string;

  constructor(options: {
    publicUrl: string;
    secret: string;
  }) {
    this.#publicUrl = options.publicUrl.replace(/\/$/u, "");
    this.#secret = options.secret;
  }

  createAccessLink(
    userId: string,
    redirectPath: CaptainWebPath
  ): string {
    return createCaptainAccessLink(this.#publicUrl, redirectPath, userId, this.#secret);
  }

  resolve(request: Request): string | null {
    const authorization = request.headers.get("authorization");
    const token = /^Bearer\s+(\S+)$/iu.exec(authorization ?? "")?.[1];
    return token ? resolveCaptainAccessToken(token, this.#secret) : null;
  }
}
