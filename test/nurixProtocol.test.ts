import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError } from "../src/errors/AdapterError.js";
import { buildNurixUrl } from "../src/nurix/buildNurixUrl.js";
import { parseNurixFrame } from "../src/nurix/parseNurixFrame.js";

test("buildNurixUrl encodes path and query values", () => {
  const url = buildNurixUrl(
    new URL("wss://chat-us.nurixlabs.tech"),
    {
      apiKey: "test-api key&secret",
      gatewayApiKey: "test-gateway-secret",
      widgetId: "widget/one",
      userId: "customer+one@example.com",
    },
    "account/one",
    "11111111-1111-4111-8111-111111111111",
  );

  assert.equal(url.protocol, "wss:");
  assert.equal(url.hostname, "chat-us.nurixlabs.tech");
  assert.equal(
    url.pathname,
    "/v2/chat/CHAT_WIDGET/account%2Fone/11111111-1111-4111-8111-111111111111",
  );
  assert.equal(url.searchParams.get("api_key"), "test-api key&secret");
  assert.equal(url.searchParams.get("user_id"), "customer+one@example.com");
  assert.equal(url.href.includes("test-gateway-secret"), false);
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
        conversation_id: 283216,
        message_id: 1658331,
        is_welcome_message: true,
      }),
    ),
    {
      type: "response",
      response: {
        content: "Welcome",
        conversationId: "283216",
        messageId: "1658331",
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
