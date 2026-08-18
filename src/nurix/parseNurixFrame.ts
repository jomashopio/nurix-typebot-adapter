import { AdapterError } from "../errors/AdapterError.js";
import type { NurixFrame } from "./types.js";

export const parseNurixFrame = (
  message: string,
  maximumContentCharacters: number = 10_000,
): NurixFrame => {
  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch {
    throw protocolError("Nurix returned invalid JSON.");
  }

  if (!isRecord(payload) || typeof payload.response_type !== "string")
    return { type: "unknown" };

  if (payload.response_type === "ping_pong") return { type: "pong" };
  if (payload.response_type !== "response") return { type: "unknown" };

  const conversationId = parseIdentifier(payload.conversation_id);
  const messageId = parseIdentifier(payload.message_id);
  const conversationState =
    typeof payload.conversation_state === "string"
      ? payload.conversation_state.trim().toLowerCase()
      : "";

  if (
    typeof payload.content !== "string" ||
    payload.content.length > maximumContentCharacters ||
    !conversationId ||
    !messageId ||
    (payload.is_welcome_message !== undefined &&
      typeof payload.is_welcome_message !== "boolean")
  )
    throw protocolError("Nurix returned an invalid response frame.");

  return {
    type: "response",
    response: {
      content: payload.content,
      conversationState: /^[a-z][a-z0-9_-]{0,63}$/.test(conversationState)
        ? conversationState
        : "active",
      conversationId,
      messageId,
    },
    isWelcomeMessage: payload.is_welcome_message === true,
  };
};

const parseIdentifier = (value: unknown) => {
  if (typeof value === "string" && value.length > 0 && value.length <= 512)
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const protocolError = (message: string) =>
  new AdapterError(502, "NURIX_PROTOCOL_ERROR", message, false);
