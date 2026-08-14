import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError } from "../src/errors/AdapterError.js";
import { buildNurixUrl } from "../src/nurix/buildNurixUrl.js";
import { parseNurixFrame } from "../src/nurix/parseNurixFrame.js";

test("buildNurixUrl encodes path and query values", () => {
  const url = buildNurixUrl(new URL("wss://chat-in.nurixlabs.tech"), {
    apiKey: "api key&secret",
    widgetId: "widget/one",
    agentId: "agent two",
    userId: "customer+one@example.com",
  });

  assert.equal(url.protocol, "wss:");
  assert.equal(url.hostname, "chat-in.nurixlabs.tech");
  assert.equal(url.pathname, "/chat/CHAT_WIDGET/widget%2Fone/agent%20two");
  assert.equal(url.searchParams.get("api_key"), "api key&secret");
  assert.equal(url.searchParams.get("user_id"), "customer+one@example.com");
});

test("parseNurixFrame classifies documented and future frames", () => {
  assert.deepEqual(
    parseNurixFrame(
      JSON.stringify({ response_type: "ping_pong", timestamp: null }),
    ),
    { type: "pong" },
  );
  assert.deepEqual(
    parseNurixFrame(
      JSON.stringify({
        response_type: "response",
        content: "Welcome",
        conversation_id: "conversation-1",
        message_id: "message-1",
        is_welcome_message: true,
      }),
    ),
    {
      type: "response",
      response: {
        content: "Welcome",
        conversationId: "conversation-1",
        messageId: "message-1",
      },
      isWelcomeMessage: true,
    },
  );
  assert.deepEqual(
    parseNurixFrame(JSON.stringify({ response_type: "future_event" })),
    { type: "unknown" },
  );
});

test("parseNurixFrame rejects malformed known frames without echoing payloads", () => {
  const secret = "protocol-secret-sentinel";
  assert.throws(
    () =>
      parseNurixFrame(
        JSON.stringify({ response_type: "response", content: secret }),
      ),
    (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "NURIX_PROTOCOL_ERROR");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("parseNurixFrame bounds retained response content and identifiers", () => {
  for (const payload of [
    {
      response_type: "response",
      content: "x".repeat(11),
      conversation_id: "conversation-1",
      message_id: "message-1",
    },
    {
      response_type: "response",
      content: "Reply",
      conversation_id: "conversation-1",
      message_id: "x".repeat(513),
    },
  ])
    assert.throws(
      () => parseNurixFrame(JSON.stringify(payload), 10),
      (error) => {
        assert.ok(error instanceof AdapterError);
        assert.equal(error.code, "NURIX_PROTOCOL_ERROR");
        return true;
      },
    );
});
