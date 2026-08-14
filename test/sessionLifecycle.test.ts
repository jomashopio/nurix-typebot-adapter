import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer as createNodeServer } from "node:http";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
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

test("a refused WebSocket handshake does not leak an unhandled rejection", async (context) => {
  const handshakeServer = createNodeServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });
  handshakeServer.listen(0, "127.0.0.1");
  await once(handshakeServer, "listening");
  context.after(
    () =>
      new Promise<void>((resolve) => handshakeServer.close(() => resolve())),
  );

  const address = handshakeServer.address();
  if (!address || typeof address === "string")
    throw new Error("Could not determine handshake server address.");
  const manager = createManager(new URL(`ws://127.0.0.1:${address.port}`));
  context.after(() => manager.shutdown(100));
  let unhandledRejection: unknown;
  const handleUnhandledRejection = (reason: unknown) => {
    unhandledRejection = reason;
  };
  process.on("unhandledRejection", handleUnhandledRejection);

  try {
    await assert.rejects(
      manager.send({ ...request, message: "Hello" }),
      hasErrorCode("NURIX_REJECTED"),
    );
    await delay(25);
    assert.equal(unhandledRejection, undefined);
  } finally {
    process.off("unhandledRejection", handleUnhandledRejection);
  }
});

test("accepts a delayed pong within the configured deadline", async (context) => {
  let pingCount = 0;
  let responseCount = 0;
  const delayedPongAttempted = deferred<void>();
  const fixture = await createNurixFixture(context, (socket, payload) => {
    if (payload.interaction_type === "ping") {
      pingCount += 1;
      if (pingCount === 1) {
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(pongFrame);
          delayedPongAttempted.resolve();
        }, 55);
      } else socket.send(pongFrame);
      return;
    }
    if (payload.interaction_type !== "response_required") return;
    responseCount += 1;
    socket.send(
      responseFrame(`Reply ${responseCount}`, `message-${responseCount}`),
    );
  });
  const manager = createManager(fixture.url, {
    heartbeatIntervalMs: 25,
    pongTimeoutMs: 120,
    sessionIdleTimeoutMs: 1_000,
  });
  context.after(() => manager.shutdown(100));

  await manager.send({ ...request, message: "First" });
  await delayedPongAttempted.promise;
  const second = await manager.send({ ...request, message: "Second" });

  assert.equal(second.content, "Reply 2");
  assert.equal(fixture.connectionCount(), 1);
});

test("evicts and reconnects a session after a missed pong", async (context) => {
  let responseCount = 0;
  const fixture = await createNurixFixture(
    context,
    (socket, payload, connectionNumber) => {
      if (payload.interaction_type === "ping") {
        if (connectionNumber > 1) socket.send(pongFrame);
        return;
      }
      if (payload.interaction_type !== "response_required") return;
      responseCount += 1;
      socket.send(
        responseFrame(`Reply ${responseCount}`, `message-${responseCount}`),
      );
    },
  );
  const manager = createManager(fixture.url, {
    heartbeatIntervalMs: 20,
    pongTimeoutMs: 30,
    sessionIdleTimeoutMs: 1_000,
  });
  context.after(() => manager.shutdown(100));

  await manager.send({ ...request, message: "First" });
  await waitFor(() => manager.size === 0);
  const second = await manager.send({ ...request, message: "Second" });

  assert.equal(second.content, "Reply 2");
  assert.equal(fixture.connectionCount(), 2);
});

test("does not use a duplicate prior message ID for the next queued request", async (context) => {
  let responseCount = 0;
  const fixture = await createNurixFixture(context, (socket, payload) => {
    if (payload.interaction_type === "ping") {
      socket.send(pongFrame);
      return;
    }
    if (payload.interaction_type !== "response_required") return;
    responseCount += 1;
    if (responseCount === 1) {
      socket.send(responseFrame("First reply", "message-1"));
      return;
    }
    socket.send(responseFrame("Duplicate first reply", "message-1"));
    socket.send(responseFrame("Second reply", "message-2"));
  });
  const manager = createManager(fixture.url);
  context.after(() => manager.shutdown(100));

  const first = await manager.send({ ...request, message: "First" });
  const second = await manager.send({ ...request, message: "Second" });

  assert.equal(first.messageId, "message-1");
  assert.equal(second.content, "Second reply");
  assert.equal(second.messageId, "message-2");
  assert.equal(fixture.connectionCount(), 1);
});

test("times out work queued from the prior request fulfillment", {
  timeout: 1_000,
}, async (context) => {
  let secondSocket: WebSocket | undefined;
  let thirdWasDispatched = false;
  const secondReceived = deferred<void>();
  const fixture = await createNurixFixture(context, (socket, payload) => {
    if (payload.interaction_type === "ping") {
      socket.send(pongFrame);
      return;
    }
    if (payload.interaction_type !== "response_required") return;
    if (payload.text === "First") {
      setTimeout(
        () => socket.send(responseFrame("First reply", "message-1")),
        10,
      );
      return;
    }
    if (payload.text === "Second") {
      secondSocket = socket;
      secondReceived.resolve();
      return;
    }
    if (payload.text === "Third") thirdWasDispatched = true;
  });
  const manager = createManager(fixture.url, { queueTimeoutMs: 30 });
  context.after(() => manager.shutdown(100));

  const first = manager.send({ ...request, message: "First" });
  const second = manager.send({ ...request, message: "Second" });
  const third = first.then(() =>
    manager.send({ ...request, message: "Third" }),
  );

  await first;
  await secondReceived.promise;
  await assert.rejects(third, hasErrorCode("SESSION_QUEUE_TIMEOUT"));
  assert.equal(thirdWasDispatched, false);
  assert.ok(secondSocket);
  secondSocket.send(responseFrame("Second reply", "message-2"));
  assert.equal((await second).content, "Second reply");
});

test("shutdown does not retain its full deadline after sessions close", async () => {
  const sessionManagerModuleUrl = new URL(
    "../src/sessions/SessionManager.js",
    import.meta.url,
  ).href;
  const loggerModuleUrl = new URL("../src/logging/Logger.js", import.meta.url)
    .href;
  const script = `
    import { SessionManager } from ${JSON.stringify(sessionManagerModuleUrl)};
    import { noopLogger } from ${JSON.stringify(loggerModuleUrl)};
    const manager = new SessionManager({ shutdownTimeoutMs: 10_000 }, noopLogger);
    await manager.shutdown(10_000);
  `;

  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { timeout: 2_000, windowsHide: true },
  );
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
  onPayload: (
    socket: WebSocket,
    payload: Record<string, unknown>,
    connectionNumber: number,
  ) => void,
) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const clients = new Set<WebSocket>();
  let connectionCount = 0;
  server.on("connection", (socket) => {
    connectionCount += 1;
    const connectionNumber = connectionCount;
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.send(
      JSON.stringify({
        response_type: "response",
        content: "Welcome",
        conversation_id: "conversation-1",
        message_id: `welcome-${connectionNumber}`,
        is_welcome_message: true,
      }),
    );
    socket.on("message", (raw) => {
      const payload: unknown = JSON.parse(raw.toString("utf8"));
      if (isRecord(payload)) onPayload(socket, payload, connectionNumber);
    });
  });
  context.after(async () => {
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not determine WebSocket test address.");
  return {
    connectionCount: () => connectionCount,
    url: new URL(`ws://127.0.0.1:${address.port}`),
  };
};

const responseFrame = (content: string, messageId: string) =>
  JSON.stringify({
    response_type: "response",
    content,
    conversation_id: "conversation-1",
    message_id: messageId,
  });

const pongFrame = JSON.stringify({
  response_type: "ping_pong",
  timestamp: null,
});

const hasErrorCode = (code: AdapterError["code"]) => (error: unknown) => {
  assert.ok(error instanceof AdapterError);
  assert.equal(error.code, code);
  return true;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const waitFor = async (condition: () => boolean, timeoutMs: number = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail("Condition was not met in time.");
    await delay(5);
  }
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const deferred = <T>() => {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};
