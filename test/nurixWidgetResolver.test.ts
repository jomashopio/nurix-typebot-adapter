import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError } from "../src/errors/AdapterError.js";
import { createNurixWidgetResolver } from "../src/nurix/createNurixWidgetResolver.js";
import { createTestConfig } from "./testConfig.js";

const identity = {
  apiKey: "data-api-key-sentinel",
  gatewayApiKey: "gateway-api-key-sentinel",
  widgetId: "173",
  userId: "customer-1",
};

test("resolves the live v2 account ID with the documented widget headers", async () => {
  let observedUrl: URL | undefined;
  let observedHeaders: Headers | undefined;
  let observedMethod: string | undefined;
  const fetchRequest: typeof fetch = async (input, init) => {
    observedUrl =
      input instanceof Request ? new URL(input.url) : new URL(input);
    observedHeaders = new Headers(init?.headers);
    observedMethod = init?.method;
    return new Response(
      JSON.stringify({ data: { account_id: "1234567890" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const resolver = createNurixWidgetResolver(createTestConfig(), fetchRequest);

  assert.deepEqual(await resolver(identity), { accountId: "1234567890" });
  assert.equal(observedUrl?.pathname, "/agentx/chat-widget/");
  assert.equal(observedUrl?.search, "");
  assert.equal(observedMethod, "GET");
  assert.equal(observedHeaders?.get("widgetId"), "173");
  assert.equal(observedHeaders?.get("widgetApiKey"), identity.apiKey);
  assert.equal(observedHeaders?.get("x-api-key"), identity.gatewayApiKey);
  assert.equal(observedHeaders?.get("origin"), "http://localhost:3000");
  assert.equal(observedHeaders?.get("content-type"), "application/json");
});

test("normalizes numeric account IDs", async () => {
  const resolver = createNurixWidgetResolver(
    createTestConfig(),
    async () =>
      new Response(JSON.stringify({ data: { account_id: 1234567890 } })),
  );

  assert.deepEqual(await resolver(identity), { accountId: "1234567890" });
});

test("classifies widget configuration failures without exposing credentials", async () => {
  for (const expectation of [
    { status: 403, code: "NURIX_REJECTED", safeToRetry: false },
    { status: 429, code: "NURIX_UNAVAILABLE", safeToRetry: true },
    { status: 503, code: "NURIX_UNAVAILABLE", safeToRetry: true },
  ]) {
    const resolver = createNurixWidgetResolver(
      createTestConfig(),
      async () =>
        new Response(
          `${identity.apiKey}:${identity.gatewayApiKey}:upstream-details`,
          { status: expectation.status },
        ),
    );

    await assert.rejects(resolver(identity), (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, expectation.code);
      assert.equal(error.safeToRetry, expectation.safeToRetry);
      assert.equal(error.preserveIdempotency, false);
      assert.equal(error.message.includes(identity.apiKey), false);
      assert.equal(error.message.includes(identity.gatewayApiKey), false);
      assert.equal(error.message.includes("upstream-details"), false);
      return true;
    });
  }
});

test("rejects malformed and oversized widget configuration responses", async () => {
  for (const response of [
    new Response("not-json"),
    new Response(JSON.stringify({ data: {} })),
    new Response("x".repeat(33)),
  ]) {
    const resolver = createNurixWidgetResolver(
      createTestConfig({ maxConfigResponseBytes: 32 }),
      async () => response,
    );

    await assert.rejects(resolver(identity), (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "NURIX_PROTOCOL_ERROR");
      assert.equal(error.safeToRetry, false);
      return true;
    });
  }
});

test("classifies transport failures as retryable and redacts their messages", async () => {
  const resolver = createNurixWidgetResolver(createTestConfig(), async () =>
    Promise.reject(
      new Error(`${identity.apiKey}:${identity.gatewayApiKey}:network-error`),
    ),
  );

  await assert.rejects(resolver(identity), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, "NURIX_UNAVAILABLE");
    assert.equal(error.safeToRetry, true);
    assert.equal(error.preserveIdempotency, false);
    assert.equal(error.message.includes(identity.apiKey), false);
    assert.equal(error.message.includes(identity.gatewayApiKey), false);
    return true;
  });
});

test("aborts a pending widget configuration request", async () => {
  const externalAbortController = new AbortController();
  const fetchRequest: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  const resolver = createNurixWidgetResolver(createTestConfig(), fetchRequest);
  const resolution = resolver(identity, externalAbortController.signal);

  externalAbortController.abort();

  await assert.rejects(resolution, (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, "NURIX_UNAVAILABLE");
    assert.equal(error.safeToRetry, true);
    return true;
  });
});
