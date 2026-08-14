import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { parseConfig } from "../src/config/parseConfig.js";
import { IdempotencyStore } from "../src/idempotency/IdempotencyStore.js";
import { noopLogger } from "../src/logging/Logger.js";
import type { SendMessageRequest } from "../src/nurix/types.js";
import { createServer } from "../src/server/createServer.js";
import type { MessageSender } from "../src/sessions/SessionManager.js";
import { createTestConfig } from "./testConfig.js";

const gatewaySharedSecret = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef";

test("requires a gateway secret unless the loopback development bypass is explicit", () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: "production" }),
    /GATEWAY_SHARED_SECRET is required/,
  );
  assert.throws(
    () => parseConfig({ NODE_ENV: "development", HOST: "127.0.0.1" }),
    /GATEWAY_SHARED_SECRET is required/,
  );
  assert.throws(
    () =>
      parseConfig({
        NODE_ENV: "development",
        HOST: "0.0.0.0",
        ALLOW_UNAUTHENTICATED_GATEWAY: "true",
      }),
    /GATEWAY_SHARED_SECRET is required/,
  );

  const config = parseConfig({
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    ALLOW_UNAUTHENTICATED_GATEWAY: "true",
  });
  assert.equal(config.gatewaySharedSecret, undefined);
});

test("accepts a valid gateway secret configuration", () => {
  const config = parseConfig({
    NODE_ENV: "production",
    GATEWAY_SHARED_SECRET: gatewaySharedSecret,
  });

  assert.equal(config.gatewaySharedSecret, gatewaySharedSecret);
});

test("rejects weak or non-header-safe gateway secrets", () => {
  for (const secret of [
    "a".repeat(42),
    `${"a".repeat(42)}\n`,
    `é${"a".repeat(42)}`,
  ])
    assert.throws(
      () =>
        parseConfig({
          NODE_ENV: "production",
          GATEWAY_SHARED_SECRET: secret,
        }),
      /43 to 128 base64url characters/,
    );
});

test("rejects message requests that do not carry the trusted gateway header", async (context) => {
  const fixture = await createHttpFixture(context);

  const missing = await postMessage(fixture.url, undefined);
  const incorrect = await postMessage(fixture.url, "incorrect-gateway-secret");
  const accepted = await postMessage(fixture.url, gatewaySharedSecret);

  assert.equal(missing.status, 401);
  assert.equal(incorrect.status, 401);
  assert.equal(accepted.status, 200);
  assert.equal(fixture.sender.calls.length, 1);
  assert.equal((await missing.text()).includes(gatewaySharedSecret), false);
  assert.equal((await incorrect.text()).includes(gatewaySharedSecret), false);
});

class FakeSender implements MessageSender {
  readonly calls: SendMessageRequest[] = [];

  async send(request: SendMessageRequest) {
    this.calls.push(request);
    return {
      content: "Reply",
      conversationId: "conversation-1",
      messageId: "message-1",
    };
  }
}

const createHttpFixture = async (context: TestContext) => {
  const config = createTestConfig({ gatewaySharedSecret });
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

  const address: AddressInfo = getAddress(adapter.server.address());
  return {
    sender,
    url: `http://127.0.0.1:${address.port}`,
  };
};

const postMessage = (
  baseUrl: string,
  providedGatewaySecret: string | undefined,
) =>
  fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "gateway-test-key",
      ...(providedGatewaySecret
        ? { "X-Adapter-Gateway-Secret": providedGatewaySecret }
        : {}),
    },
    body: JSON.stringify({
      widgetId: "widget-1",
      agentId: "agent-1",
      userId: "customer-1",
      message: "Hello",
    }),
  });

const getAddress = (
  address: ReturnType<import("node:http").Server["address"]>,
) => {
  if (!address || typeof address === "string")
    throw new Error("Could not determine HTTP test address.");
  return address;
};
