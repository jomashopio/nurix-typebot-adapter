import type { NurixSessionIdentity } from "./types.js";

export const buildNurixUrl = (
  baseUrl: URL,
  { apiKey, widgetId, agentId, userId }: NurixSessionIdentity,
) => {
  const url = new URL(baseUrl);
  url.pathname = `/chat/CHAT_WIDGET/${encodeURIComponent(widgetId)}/${encodeURIComponent(agentId)}`;
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("user_id", userId);
  return url;
};
