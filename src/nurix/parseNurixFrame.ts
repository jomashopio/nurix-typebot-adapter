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

  if (
    typeof payload.content !== "string" ||
    payload.content.length > maximumContentCharacters ||
    typeof payload.conversation_id !== "string" ||
    payload.conversation_id.length === 0 ||
    payload.conversation_id.length > 512 ||
    typeof payload.message_id !== "string" ||
    payload.message_id.length === 0 ||
    payload.message_id.length > 512 ||
    (payload.is_welcome_message !== undefined &&
      typeof payload.is_welcome_message !== "boolean")
  )
    throw protocolError("Nurix returned an invalid response frame.");

  return {
    type: "response",
    response: {
      content: payload.content,
      conversationId: payload.conversation_id,
      messageId: payload.message_id,
    },
    isWelcomeMessage: payload.is_welcome_message === true,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const protocolError = (message: string) =>
  new AdapterError(502, "NURIX_PROTOCOL_ERROR", message, false);
