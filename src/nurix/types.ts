export type NurixReply = {
  content: string;
  conversationState: string;
  conversationId: string;
  messageId: string;
};

export type NurixFrame =
  | { type: "response"; response: NurixReply; isWelcomeMessage: boolean }
  | { type: "pong" }
  | { type: "unknown" };

export type NurixSessionIdentity = {
  apiKey: string;
  gatewayApiKey: string;
  widgetId: string;
  userId: string;
};

export type NurixWidgetConfig = {
  accountId: string;
};

export type SendMessageRequest = NurixSessionIdentity & {
  message: string;
};
