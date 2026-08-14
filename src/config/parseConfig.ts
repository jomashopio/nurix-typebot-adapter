export type AdapterConfig = {
  host: string;
  port: number;
  gatewaySharedSecret: string | undefined;
  nurixApiBaseUrl: URL;
  nurixWidgetOrigin: string | undefined;
  nurixWsBaseUrl: URL;
  nurixConfigTimeoutMs: number;
  handshakeTimeoutMs: number;
  responseTimeoutMs: number;
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
  sessionIdleTimeoutMs: number;
  maxPayloadBytes: number;
  maxConfigResponseBytes: number;
  maxHttpBodyBytes: number;
  maxMessageCharacters: number;
  maxResponseCharacters: number;
  maxSessions: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
  idempotencyTtlMs: number;
  maxIdempotencyEntries: number;
  shutdownTimeoutMs: number;
};

export const parseConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AdapterConfig => {
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  const host = environment.HOST?.trim() || "127.0.0.1";
  const nurixWsBaseUrl = parseWebSocketUrl(
    environment.NURIX_WS_BASE_URL ?? "wss://chat-us.nurixlabs.tech",
    nodeEnvironment,
    environment.ALLOW_INSECURE_WS === "true",
  );
  const nurixApiBaseUrl = parseHttpUrl(
    environment.NURIX_API_BASE_URL ?? "https://api-us.nurixlabs.tech/agentx/",
  );

  return {
    host,
    port: parseInteger(environment, "PORT", 3000, 1, 65_535),
    gatewaySharedSecret: parseGatewaySharedSecret(
      environment.GATEWAY_SHARED_SECRET,
      nodeEnvironment,
      environment.ALLOW_UNAUTHENTICATED_GATEWAY === "true",
      host,
    ),
    nurixApiBaseUrl,
    nurixWidgetOrigin: parseWidgetOrigin(
      environment.NURIX_WIDGET_ORIGIN,
      nodeEnvironment,
    ),
    nurixWsBaseUrl,
    nurixConfigTimeoutMs: parseInteger(
      environment,
      "NURIX_CONFIG_TIMEOUT_MS",
      10_000,
      100,
      120_000,
    ),
    handshakeTimeoutMs: parseInteger(
      environment,
      "HANDSHAKE_TIMEOUT_MS",
      10_000,
      100,
      120_000,
    ),
    responseTimeoutMs: parseInteger(
      environment,
      "RESPONSE_TIMEOUT_MS",
      60_000,
      100,
      300_000,
    ),
    heartbeatIntervalMs: parseInteger(
      environment,
      "HEARTBEAT_INTERVAL_MS",
      30_000,
      100,
      300_000,
    ),
    pongTimeoutMs: parseInteger(
      environment,
      "PONG_TIMEOUT_MS",
      10_000,
      100,
      120_000,
    ),
    sessionIdleTimeoutMs: parseInteger(
      environment,
      "SESSION_IDLE_TIMEOUT_MS",
      300_000,
      1_000,
      86_400_000,
    ),
    maxPayloadBytes: parseInteger(
      environment,
      "MAX_PAYLOAD_BYTES",
      1_048_576,
      1_024,
      16_777_216,
    ),
    maxConfigResponseBytes: parseInteger(
      environment,
      "MAX_CONFIG_RESPONSE_BYTES",
      1_048_576,
      1_024,
      16_777_216,
    ),
    maxHttpBodyBytes: parseInteger(
      environment,
      "MAX_HTTP_BODY_BYTES",
      65_536,
      1_024,
      1_048_576,
    ),
    maxMessageCharacters: parseInteger(
      environment,
      "MAX_MESSAGE_CHARACTERS",
      20_000,
      1,
      1_000_000,
    ),
    maxResponseCharacters: parseInteger(
      environment,
      "MAX_RESPONSE_CHARACTERS",
      10_000,
      1,
      100_000,
    ),
    maxSessions: parseInteger(environment, "MAX_SESSIONS", 1_000, 1, 100_000),
    maxQueueDepth: parseInteger(environment, "MAX_QUEUE_DEPTH", 10, 0, 1_000),
    queueTimeoutMs: parseInteger(
      environment,
      "QUEUE_TIMEOUT_MS",
      5_000,
      100,
      60_000,
    ),
    idempotencyTtlMs: parseInteger(
      environment,
      "IDEMPOTENCY_TTL_MS",
      3_600_000,
      1_000,
      604_800_000,
    ),
    maxIdempotencyEntries: parseInteger(
      environment,
      "MAX_IDEMPOTENCY_ENTRIES",
      5_000,
      1,
      1_000_000,
    ),
    shutdownTimeoutMs: parseInteger(
      environment,
      "SHUTDOWN_TIMEOUT_MS",
      30_000,
      1_000,
      300_000,
    ),
  };
};

const parseGatewaySharedSecret = (
  rawValue: string | undefined,
  nodeEnvironment: string,
  allowUnauthenticatedGateway: boolean,
  host: string,
) => {
  if (rawValue === undefined || rawValue === "") {
    if (
      nodeEnvironment === "development" &&
      allowUnauthenticatedGateway &&
      isLoopbackHost(host)
    )
      return undefined;
    throw new Error(
      "GATEWAY_SHARED_SECRET is required unless the explicit loopback-only development bypass is enabled.",
    );
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(rawValue))
    throw new Error(
      "GATEWAY_SHARED_SECRET must contain 43 to 128 base64url characters.",
    );
  return rawValue;
};

const isLoopbackHost = (host: string) =>
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "[::1]" ||
  host === "localhost";

const parseInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
) => {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim() === "") return defaultValue;

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  return value;
};

const parseWebSocketUrl = (
  rawUrl: string,
  nodeEnvironment: string,
  allowInsecureWebSocket: boolean,
) => {
  const url = new URL(rawUrl);
  const isSecure = url.protocol === "wss:";
  const isAllowedDevelopmentSocket =
    url.protocol === "ws:" &&
    nodeEnvironment === "development" &&
    allowInsecureWebSocket &&
    isLoopbackHost(url.hostname);

  if (!isSecure && !isAllowedDevelopmentSocket)
    throw new Error("NURIX_WS_BASE_URL must use wss://.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "NURIX_WS_BASE_URL cannot include credentials, query parameters, or a fragment.",
    );

  return url;
};

const parseHttpUrl = (rawUrl: string) => {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:")
    throw new Error("NURIX_API_BASE_URL must use https://.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "NURIX_API_BASE_URL cannot include credentials, query parameters, or a fragment.",
    );
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
};

const parseWidgetOrigin = (
  rawValue: string | undefined,
  nodeEnvironment: string,
) => {
  if (rawValue === undefined || rawValue.trim() === "") {
    if (nodeEnvironment === "production")
      throw new Error("NURIX_WIDGET_ORIGIN is required in production.");
    return undefined;
  }
  const url = new URL(rawValue);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("NURIX_WIDGET_ORIGIN must be a valid HTTP(S) origin.");
  return url.origin;
};
