import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError } from "../src/errors/AdapterError.js";
import { IdempotencyStore } from "../src/idempotency/IdempotencyStore.js";
import type { NurixReply } from "../src/nurix/types.js";

const request = {
  apiKey: "test-api-key",
  widgetId: "widget-1",
  agentId: "agent-1",
  userId: "customer-1",
  message: "Hello",
};

const reply: NurixReply = {
  content: "Reply",
  conversationId: "conversation-1",
  messageId: "message-1",
};

test("deduplicates concurrent requests while the operation is pending", async () => {
  const operationResult = deferred<NurixReply>();
  const store = new IdempotencyStore(1_000, 10);
  let operationCount = 0;
  const operation = () => {
    operationCount += 1;
    return operationResult.promise;
  };

  const first = store.execute(
    request.apiKey,
    "concurrent-key",
    request,
    operation,
  );
  const replay = store.execute(
    request.apiKey,
    "concurrent-key",
    request,
    operation,
  );
  await Promise.resolve();

  assert.equal(operationCount, 1);
  operationResult.resolve(reply);
  assert.deepEqual(await first, { value: reply, replayed: false });
  assert.deepEqual(await replay, { value: reply, replayed: true });
});

test("does not expire a pending operation", async () => {
  let currentTime = 0;
  const operationResult = deferred<NurixReply>();
  const store = new IdempotencyStore(100, 10, () => currentTime);
  let operationCount = 0;
  const operation = () => {
    operationCount += 1;
    return operationResult.promise;
  };

  const first = store.execute(
    request.apiKey,
    "pending-key",
    request,
    operation,
  );
  await Promise.resolve();
  currentTime = 101;
  const replay = store.execute(
    request.apiKey,
    "pending-key",
    request,
    operation,
  );

  assert.equal(operationCount, 1);
  operationResult.resolve(reply);
  assert.deepEqual(await first, { value: reply, replayed: false });
  assert.deepEqual(await replay, { value: reply, replayed: true });
});

test("expires a settled operation after its replay window", async () => {
  let currentTime = 0;
  const store = new IdempotencyStore(100, 10, () => currentTime);
  let operationCount = 0;
  const operation = () => {
    operationCount += 1;
    return Promise.resolve({
      ...reply,
      messageId: `message-${operationCount}`,
    });
  };

  await store.execute(request.apiKey, "expiring-key", request, operation);
  currentTime = 101;
  const second = await store.execute(
    request.apiKey,
    "expiring-key",
    request,
    operation,
  );

  assert.equal(operationCount, 2);
  assert.equal(second.replayed, false);
  assert.equal(second.value.messageId, "message-2");
});

test("executes again after a retry-safe failure", async () => {
  const store = new IdempotencyStore(1_000, 10);
  let operationCount = 0;
  const operation = () => {
    operationCount += 1;
    if (operationCount === 1)
      return Promise.reject(
        new AdapterError(
          503,
          "NURIX_UNAVAILABLE",
          "Nurix is temporarily unavailable.",
          true,
        ),
      );
    return Promise.resolve(reply);
  };

  await assert.rejects(
    store.execute(request.apiKey, "retryable-key", request, operation),
    hasErrorCode("NURIX_UNAVAILABLE"),
  );
  assert.deepEqual(
    await store.execute(request.apiKey, "retryable-key", request, operation),
    { value: reply, replayed: false },
  );
  assert.equal(operationCount, 2);
});

test("caches a terminal delivery-unknown failure", async () => {
  const store = new IdempotencyStore(1_000, 10);
  const deliveryUnknown = new AdapterError(
    504,
    "NURIX_DELIVERY_UNKNOWN",
    "The delivery outcome is unknown.",
    false,
  );
  let operationCount = 0;
  const operation = () => {
    operationCount += 1;
    return Promise.reject(deliveryUnknown);
  };

  await assert.rejects(
    store.execute(request.apiKey, "terminal-key", request, operation),
    hasErrorCode("NURIX_DELIVERY_UNKNOWN"),
  );
  await assert.rejects(
    store.execute(request.apiKey, "terminal-key", request, operation),
    hasErrorCode("NURIX_DELIVERY_UNKNOWN"),
  );
  assert.equal(operationCount, 1);
});

const hasErrorCode = (code: AdapterError["code"]) => (error: unknown) => {
  assert.ok(error instanceof AdapterError);
  assert.equal(error.code, code);
  return true;
};

const deferred = <T>() => {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};
