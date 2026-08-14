import { randomUUID } from "node:crypto";
import type { NurixSessionIdentity } from "./types.js";

export const buildNurixUrl = (
  baseUrl: URL,
  { apiKey, userId }: NurixSessionIdentity,
  accountId: string,
  connectionId: string = randomUUID(),
) => {
  const url = new URL(baseUrl);
  url.pathname = `/v2/chat/CHAT_WIDGET/${encodeURIComponent(accountId)}/${encodeURIComponent(connectionId)}`;
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("user_id", userId);
  return url;
};
