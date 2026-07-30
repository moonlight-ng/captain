import { createGateway } from "ai";

const CAPTAIN_GATEWAY_HEADERS = {
  "http-referer": "https://dr-captain.fly.dev",
  "x-title": "Captain"
} as const;

export function createCaptainGateway(apiKey: string) {
  return createGateway({
    apiKey,
    headers: CAPTAIN_GATEWAY_HEADERS
  });
}
