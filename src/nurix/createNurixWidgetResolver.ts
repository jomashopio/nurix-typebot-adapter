import type { AdapterConfig } from "../config/parseConfig.js";
import { AdapterError } from "../errors/AdapterError.js";
import type { NurixSessionIdentity, NurixWidgetConfig } from "./types.js";

type ResolverConfig = Pick<
  AdapterConfig,
  | "nurixApiBaseUrl"
  | "nurixWidgetOrigin"
  | "nurixConfigTimeoutMs"
  | "maxConfigResponseBytes"
>;

export type NurixWidgetResolver = (
  identity: NurixSessionIdentity,
  signal?: AbortSignal,
) => Promise<NurixWidgetConfig>;

export const createNurixWidgetResolver =
  (
    config: ResolverConfig,
    fetchRequest: typeof fetch = fetch,
  ): NurixWidgetResolver =>
  async ({ apiKey, gatewayApiKey, widgetId }, externalSignal) => {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      config.nurixConfigTimeoutMs,
    );
    timeout.unref();
    const signal = externalSignal
      ? AbortSignal.any([abortController.signal, externalSignal])
      : abortController.signal;

    try {
      const response = await fetchRequest(
        new URL("chat-widget/", config.nurixApiBaseUrl),
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            widgetId,
            widgetApiKey: apiKey,
            "x-api-key": gatewayApiKey,
            ...(config.nurixWidgetOrigin
              ? { Origin: config.nurixWidgetOrigin }
              : {}),
          },
          redirect: "error",
          signal,
        },
      );
      if (!response.ok) {
        if (response.body) await response.body.cancel().catch(ignoreError);
        throw rejectedError(response.status);
      }

      const body = await readLimitedBody(
        response,
        config.maxConfigResponseBytes,
      );

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        throw configurationError();
      }
      return { accountId: parseAccountId(payload) };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw unavailableError();
    } finally {
      clearTimeout(timeout);
    }
  };

const parseAccountId = (payload: unknown) => {
  if (!isRecord(payload) || !isRecord(payload.data)) throw configurationError();
  const accountId = payload.data.account_id;
  if (
    typeof accountId === "string" &&
    accountId.length > 0 &&
    accountId.length <= 512
  )
    return accountId;
  if (
    typeof accountId === "number" &&
    Number.isSafeInteger(accountId) &&
    accountId >= 0
  )
    return String(accountId);
  throw configurationError();
};

const rejectedError = (statusCode: number) => {
  const safeToRetry =
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500;
  return new AdapterError(
    safeToRetry ? 503 : 502,
    safeToRetry ? "NURIX_UNAVAILABLE" : "NURIX_REJECTED",
    safeToRetry
      ? "Nurix is temporarily unavailable."
      : "Nurix rejected the widget configuration.",
    safeToRetry,
    false,
  );
};

const readLimitedBody = async (response: Response, maximumBytes: number) => {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > maximumBytes
    ) {
      if (response.body) await response.body.cancel().catch(ignoreError);
      throw configurationError();
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(ignoreError);
        throw configurationError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, receivedBytes);
};

const configurationError = () =>
  new AdapterError(
    502,
    "NURIX_PROTOCOL_ERROR",
    "Nurix returned an invalid widget configuration.",
    false,
    false,
  );

const unavailableError = () =>
  new AdapterError(
    503,
    "NURIX_UNAVAILABLE",
    "Nurix is temporarily unavailable.",
    true,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ignoreError = () => undefined;
