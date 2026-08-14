import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { AdapterError } from "../src/errors/AdapterError.js";
import { IdempotencyStore } from "../src/idempotency/IdempotencyStore.js";
import { noopLogger } from "../src/logging/Logger.js";
import type { SendMessageRequest } from "../src/nurix/types.js";
import { createServer } from "../src/server/createServer.js";
import type { MessageSender } from "../src/sessions/SessionManager.js";
import { createTestConfig } from "./testConfig.js";

test("exposes minimal liveness and readiness endpoints", async (context) => {
  const fixture = await createHttpFixture(context);

  assert.deepEqual(await getJson(`${fixture.url}/health/live`), {
    status: "ok",
  });
  assert.deepEqual(await getJson(`${fixture.url}/health/ready`), {
    status: "ok",
  });

  fixture.setReady(false);
  const response = await fetch(`${fixture.url}/health/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "not_ready" });
});

test("requires bearer authentication and never returns the credential", async (context) => {
  const fixture = await createHttpFixture(context);
  const secret = "secret-api-key-sentinel";

  const missing = await postMessage(fixture.url, undefined, "request-key-0001");
  assert.equal(missing.status, 401);
  assert.equal((await missing.text()).includes(secret), false);

  fixture.sender.error = new AdapterError(
    503,
    "NURIX_UNAVAILABLE",
    "Nurix is temporarily unavailable.",
    true,
  );
  const upstreamFailure = await postMessage(
    fixture.url,
    secret,
    "request-key-0002",
  );
  assert.equal(upstreamFailure.status, 503);
  assert.equal((await upstreamFailure.text()).includes(secret), false);
});

test("replays identical idempotent requests and rejects conflicting reuse", async (context) => {
  const fixture = await createHttpFixture(context);
  const apiKey = "test-api-key";

  const first = await postMessage(fixture.url, apiKey, "request-key-0003");
  const replay = await postMessage(fixture.url, apiKey, "request-key-0003");
  const conflict = await postMessage(fixture.url, apiKey, "request-key-0003", {
    message: "Different",
  });

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(conflict.status, 409);
  assert.equal(fixture.sender.calls.length, 1);
});

test("rejects oversized bodies before invoking the session manager", async (context) => {
  const fixture = await createHttpFixture(context, { maxHttpBodyBytes: 80 });
  const response = await postMessage(
    fixture.url,
    "test-api-key",
    "request-key-0004",
    { message: "x".repeat(200) },
  );

  assert.equal(response.status, 413);
  assert.equal(fixture.sender.calls.length, 0);
});

class FakeSender implements MessageSender {
  readonly calls: SendMessageRequest[] = [];
  error: AdapterError | undefined;

  async send(request: SendMessageRequest) {
    this.calls.push(request);
    if (this.error) throw this.error;
    return {
      content: "Reply",
      conversationId: "conversation-1",
      messageId: "message-1",
    };
  }
}

const createHttpFixture = async (
  context: TestContext,
  overrides: Parameters<typeof createTestConfig>[0] = {},
) => {
  const config = createTestConfig(overrides);
  const sender = new FakeSender();
  const adapter = createServer({
    config,
    messageSender: sender,
    idempotencyStore: new IdempotencyStore(
      config.idempotencyTtlMs,
      config.maxIdempotencyEntries,
    ),
    logger: noopLogger,
  });
  adapter.server.listen(0, "127.0.0.1");
  await once(adapter.server, "listening");
  context.after(
    () => new Promise<void>((resolve) => adapter.server.close(() => resolve())),
  );

  const address = adapter.server.address() as AddressInfo;
  return {
    ...adapter,
    sender,
    url: `http://127.0.0.1:${address.port}`,
  };
};

const postMessage = (
  baseUrl: string,
  apiKey: string | undefined,
  idempotencyKey: string,
  overrides: Partial<
    Record<"widgetId" | "agentId" | "userId" | "message", string>
  > = {},
) =>
  fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      widgetId: "widget-1",
      agentId: "agent-1",
      userId: "customer-1",
      message: "Hello",
      ...overrides,
    }),
  });

const getJson = async (url: string) => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
};
