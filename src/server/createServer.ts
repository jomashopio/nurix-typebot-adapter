import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNodeServer } from "node:http";
import type { AdapterConfig } from "../config/parseConfig.js";
import { AdapterError, normalizeAdapterError } from "../errors/AdapterError.js";
import type { IdempotencyStore } from "../idempotency/IdempotencyStore.js";
import type { Logger } from "../logging/Logger.js";
import type { MessageSender } from "../sessions/SessionManager.js";

type Dependencies = {
  config: AdapterConfig;
  messageSender: MessageSender;
  idempotencyStore: IdempotencyStore;
  logger: Logger;
};

export const createServer = ({
  config,
  messageSender,
  idempotencyStore,
  logger,
}: Dependencies) => {
  let ready = true;
  const server = createNodeServer((request, response) => {
    void route(request, response).catch((error) => {
      const adapterError = normalizeAdapterError(error);
      const requestId = parseRequestId(request) ?? randomUUID();
      request.resume();
      logger.warn("http_request_failed", {
        requestId,
        code: adapterError.code,
        status: adapterError.status,
      });
      sendError(response, adapterError, requestId);
    });
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", "http://adapter.local");

    if (requestUrl.pathname === "/health/live") {
      if (request.method !== "GET") throw methodNotAllowedError();
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (requestUrl.pathname === "/health/ready") {
      if (request.method !== "GET") throw methodNotAllowedError();
      sendJson(
        response,
        ready ? 200 : 503,
        ready ? { status: "ok" } : { status: "not_ready" },
      );
      return;
    }

    if (requestUrl.pathname !== "/v1/messages")
      throw new AdapterError(
        404,
        "NOT_FOUND",
        "The requested endpoint does not exist.",
        false,
      );
    if (request.method !== "POST") throw methodNotAllowedError();
    if (!ready)
      throw new AdapterError(
        503,
        "SERVICE_SHUTTING_DOWN",
        "The adapter is shutting down.",
        true,
      );

    assertTrustedGateway(request, config.gatewaySharedSecret);
    const requestId = parseRequestId(request) ?? randomUUID();
    const startedAt = performance.now();
    const apiKey = parseBearerApiKey(request);
    const gatewayApiKey = parseNurixGatewayApiKey(request);
    const idempotencyKey = parseIdempotencyKey(request);
    const requestBody = await parseRequestBody(request, config);
    const sendRequest = { apiKey, gatewayApiKey, ...requestBody };
    const { value, replayed } = await idempotencyStore.execute(
      idempotencyKey,
      sendRequest,
      () => messageSender.send(sendRequest),
    );

    logger.info("http_request_completed", {
      requestId,
      status: 200,
      replayed,
      durationMs: Math.round(performance.now() - startedAt),
    });
    sendJson(
      response,
      200,
      value,
      replayed ? { "Idempotency-Replayed": "true" } : undefined,
    );
  };

  return {
    server,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
};

const assertTrustedGateway = (
  request: IncomingMessage,
  expectedSecret: string | undefined,
) => {
  if (!expectedSecret) return;
  const providedSecret =
    getSingleHeader(request, "x-adapter-gateway-secret") ?? "";
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  const providedDigest = createHash("sha256").update(providedSecret).digest();
  if (!timingSafeEqual(expectedDigest, providedDigest))
    throw new AdapterError(
      401,
      "UNAUTHORIZED",
      "The request did not come through the trusted Nurix gateway.",
      false,
    );
};

const parseBearerApiKey = (request: IncomingMessage) => {
  const authorization = getSingleHeader(request, "authorization");
  if (!authorization)
    throw new AdapterError(
      401,
      "UNAUTHORIZED",
      "A valid Nurix API key is required.",
      false,
    );

  const match = /^Bearer ([^\s]{1,4096})$/.exec(authorization);
  if (!match?.[1])
    throw new AdapterError(
      401,
      "UNAUTHORIZED",
      "A valid Nurix API key is required.",
      false,
    );
  return match[1];
};

const parseNurixGatewayApiKey = (request: IncomingMessage) => {
  const gatewayApiKey = getSingleHeader(request, "x-nurix-gateway-api-key");
  if (
    !gatewayApiKey ||
    gatewayApiKey.trim() === "" ||
    /\s/.test(gatewayApiKey) ||
    gatewayApiKey.length > 4_096
  )
    throw new AdapterError(
      401,
      "UNAUTHORIZED",
      "Valid Nurix credentials are required.",
      false,
    );
  return gatewayApiKey;
};

const parseIdempotencyKey = (request: IncomingMessage) => {
  const key = getSingleHeader(request, "idempotency-key");
  if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    throw invalidRequestError(
      "Idempotency-Key must contain 8 to 128 safe ASCII characters.",
    );
  return key;
};

const parseRequestId = (request: IncomingMessage) => {
  const requestId = getSingleHeader(request, "x-request-id");
  return requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
    ? requestId
    : undefined;
};

const parseRequestBody = async (
  request: IncomingMessage,
  config: AdapterConfig,
) => {
  const contentType = getSingleHeader(request, "content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType))
    throw new AdapterError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
      false,
    );

  const contentEncoding = getSingleHeader(request, "content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity")
    throw new AdapterError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Compressed request bodies are not supported.",
      false,
    );

  const rawBody = await readBody(request, config.maxHttpBodyBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw invalidRequestError("The request body must contain valid JSON.");
  }

  if (!isRecord(payload))
    throw invalidRequestError("The request body must be a JSON object.");

  const allowedFields = new Set(["widgetId", "userId", "message"]);
  if (Object.keys(payload).some((key) => !allowedFields.has(key)))
    throw invalidRequestError("The request body contains unsupported fields.");

  return {
    widgetId: parseStringField(payload, "widgetId", 256),
    userId: parseStringField(payload, "userId", 512),
    message: parseStringField(payload, "message", config.maxMessageCharacters),
  };
};

const readBody = (request: IncomingMessage, maximumBytes: number) => {
  const contentLength = getSingleHeader(request, "content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)
      return Promise.reject(invalidRequestError("Content-Length is invalid."));
    if (declaredBytes > maximumBytes) {
      request.resume();
      return Promise.reject(payloadTooLargeError());
    }
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let tooLarge = false;

    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.once("end", () => {
      if (tooLarge) reject(payloadTooLargeError());
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", () =>
      reject(invalidRequestError("The request body could not be read.")),
    );
  });
};

const getSingleHeader = (request: IncomingMessage, name: string) => {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
};

const parseStringField = (
  payload: Record<string, unknown>,
  name: string,
  maximumCharacters: number,
) => {
  const value = payload[name];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximumCharacters
  )
    throw invalidRequestError(
      `${name} must be a non-empty string no longer than ${maximumCharacters} characters.`,
    );
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidRequestError = (message: string) =>
  new AdapterError(400, "INVALID_REQUEST", message, false);

const payloadTooLargeError = () =>
  new AdapterError(
    413,
    "PAYLOAD_TOO_LARGE",
    "The request body is too large.",
    false,
  );

const methodNotAllowedError = () =>
  new AdapterError(
    405,
    "METHOD_NOT_ALLOWED",
    "The HTTP method is not allowed for this endpoint.",
    false,
  );

const sendError = (
  response: ServerResponse,
  error: AdapterError,
  requestId: string,
) =>
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      safeToRetry: error.safeToRetry,
      requestId,
    },
  });

const sendJson = (
  response: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
) => {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
};
