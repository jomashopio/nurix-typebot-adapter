export type NurixReply = {
  content: string;
  conversationId: string;
  messageId: string;
};

export type NurixFrame =
  | { type: "response"; response: NurixReply; isWelcomeMessage: boolean }
  | { type: "pong" }
  | { type: "unknown" };

export type NurixSessionIdentity = {
  apiKey: string;
  widgetId: string;
  agentId: string;
  userId: string;
};

export type SendMessageRequest = NurixSessionIdentity & {
  message: string;
};
