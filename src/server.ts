import { parseConfig } from "./config/parseConfig.js";
import { IdempotencyStore } from "./idempotency/IdempotencyStore.js";
import { createJsonLogger } from "./logging/Logger.js";
import { createServer } from "./server/createServer.js";
import { SessionManager } from "./sessions/SessionManager.js";

const config = parseConfig();
const logger = createJsonLogger();
const sessionManager = new SessionManager(config, logger);
const idempotencyStore = new IdempotencyStore(
  config.idempotencyTtlMs,
  config.maxIdempotencyEntries,
);
const adapter = createServer({
  config,
  messageSender: sessionManager,
  idempotencyStore,
  logger,
});

await new Promise<void>((resolve, reject) => {
  const handleError = (error: Error) => reject(error);
  adapter.server.once("error", handleError);
  adapter.server.listen(config.port, config.host, () => {
    adapter.server.off("error", handleError);
    resolve();
  });
});
logger.info("adapter_started", { host: config.host, port: config.port });

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info("adapter_shutdown_started");
    adapter.setReady(false);
    const serverClosed = new Promise<void>((resolve) =>
      adapter.server.close(() => resolve()),
    );
    await sessionManager.shutdown(config.shutdownTimeoutMs);
    adapter.server.closeIdleConnections();
    await waitForServerClose(serverClosed, 1_000);
    adapter.server.closeAllConnections();
    logger.info("adapter_shutdown_completed");
  })();
  return shutdownPromise;
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

const waitForServerClose = async (
  serverClosed: Promise<void>,
  timeoutMs: number,
) => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      serverClosed,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
