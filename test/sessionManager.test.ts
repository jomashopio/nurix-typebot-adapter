import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { AdapterError } from "../src/errors/AdapterError.js";
import { noopLogger } from "../src/logging/Logger.js";
import { SessionManager } from "../src/sessions/SessionManager.js";
import { createTestConfig } from "./testConfig.js";

const request = {
  apiKey: "test-api-key",
  widgetId: "widget-1",
  agentId: "agent-1",
  userId: "customer-1",
};

test("reuses one persistent socket across separate messages", async (context) => {
  let connectionCount = 0;
  const messages: string[] = [];
  const fixture = await createNurixFixture(context, (socket, payload) => {
    if (payload.interaction_type !== "response_required") return;
    messages.push(String(payload.text));
    socket.send(
      responseFrame(`Reply ${messages.length}`, `message-${messages.length}`),
    );
  });
  fixture.server.on("connection", () => {
    connectionCount += 1;
  });
  const manager = createManager(fixture.url);
  context.after(() => manager.shutdown(100));

  const first = await manager.send({ ...request, message: "First" });
  const second = await manager.send({ ...request, message: "Second" });

  assert.equal(connectionCount, 1);
  assert.deepEqual(messages, ["First", "Second"]);
  assert.equal(first.content, "Reply 1");
  assert.equal(second.content, "Reply 2");
});

test("serializes concurrent messages on the same socket", async (context) => {
  const received: Array<{ socket: WebSocket; text: string }> = [];
  const firstReceived = deferred<void>();
  const secondReceived = deferred<void>();
  const fixture = await createNurixFixture(context, (socket, payload) => {
    if (payload.interaction_type !== "response_required") return;
    received.push({ socket, text: String(payload.text) });
    if (received.length === 1) firstReceived.resolve();
    if (received.length === 2) secondReceived.resolve();
  });
  const manager = createManager(fixture.url);
  context.after(() => manager.shutdown(100));

  const firstReply = manager.send({ ...request, message: "First" });
  const secondReply = manager.send({ ...request, message: "Second" });
  await firstReceived.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    received.map(({ text }) => text),
    ["First"],
  );

  received[0]?.socket.send(responseFrame("First reply", "message-1"));
  await secondReceived.promise;
  assert.deepEqual(
    received.map(({ text }) => text),
    ["First", "Second"],
  );
  received[1]?.socket.send(responseFrame("Second reply", "message-2"));

  assert.equal((await firstReply).content, "First reply");
  assert.equal((await secondReply).content, "Second reply");
});

test("keeps application heartbeat active between HTTP-style calls", async (context) => {
  let connectionCount = 0;
  let pingCount = 0;
  const pingObserved = deferred<void>();
  const fixture = await createNurixFixture(context, (socket, payload) => {
    if (payload.interaction_type === "ping") {
      pingCount += 1;
      socket.send(
        JSON.stringify({ response_type: "ping_pong", timestamp: null }),
      );
      pingObserved.resolve();
      return;
    }
    if (payload.interaction_type === "response_required")
      socket.send(responseFrame("Reply", `message-${Date.now()}`));
  });
  fixture.server.on("connection", () => {
    connectionCount += 1;
  });
  const manager = createManager(fixture.url, {
    heartbeatIntervalMs: 20,
    pongTimeoutMs: 100,
    sessionIdleTimeoutMs: 1_000,
  });
  context.after(() => manager.shutdown(100));

  await manager.send({ ...request, message: "First" });
  await pingObserved.promise;
  await manager.send({ ...request, message: "Second" });

  assert.equal(connectionCount, 1);
  assert.ok(pingCount >= 1);
});

test("poisons a timed-out socket before accepting another message", async (context) => {
  let connectionCount = 0;
  const fixture = await createNurixFixture(context, (socket, payload) => {
    if (payload.interaction_type !== "response_required") return;
    if (String(payload.text) === "Second")
      socket.send(responseFrame("Recovered", "message-2"));
  });
  fixture.server.on("connection", () => {
    connectionCount += 1;
  });
  const manager = createManager(fixture.url, { responseTimeoutMs: 30 });
  context.after(() => manager.shutdown(100));

  await assert.rejects(
    manager.send({ ...request, message: "First" }),
    (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "NURIX_DELIVERY_UNKNOWN");
      return true;
    },
  );
  const second = await manager.send({ ...request, message: "Second" });

  assert.equal(connectionCount, 2);
  assert.equal(second.content, "Recovered");
});

const createManager = (
  nurixWsBaseUrl: URL,
  overrides: Parameters<typeof createTestConfig>[0] = {},
) =>
  new SessionManager(
    createTestConfig({ nurixWsBaseUrl, ...overrides }),
    noopLogger,
  );

const createNurixFixture = async (
  context: TestContext,
  onPayload: (socket: WebSocket, payload: Record<string, unknown>) => void,
) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const clients = new Set<WebSocket>();
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.send(
      JSON.stringify({
        response_type: "response",
        content: "Welcome",
        conversation_id: "conversation-1",
        message_id: "welcome-1",
        is_welcome_message: true,
      }),
    );
    socket.on("message", (raw) => {
      const payload: unknown = JSON.parse(raw.toString("utf8"));
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload)
      )
        onPayload(socket, payload as Record<string, unknown>);
    });
  });
  context.after(async () => {
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not determine WebSocket test address.");
  return { server, url: new URL(`ws://127.0.0.1:${address.port}`) };
};

const responseFrame = (content: string, messageId: string) =>
  JSON.stringify({
    response_type: "response",
    content,
    conversation_id: "conversation-1",
    message_id: messageId,
  });

const deferred = <T>() => {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};
