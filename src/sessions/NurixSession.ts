import WebSocket from "ws";
import type { AdapterConfig } from "../config/parseConfig.js";
import { AdapterError, normalizeAdapterError } from "../errors/AdapterError.js";
import type { Logger } from "../logging/Logger.js";
import { buildNurixUrl } from "../nurix/buildNurixUrl.js";
import { parseNurixFrame } from "../nurix/parseNurixFrame.js";
import type { NurixReply, NurixSessionIdentity } from "../nurix/types.js";

type QueueItem = {
  message: string;
  resolve: (reply: NurixReply) => void;
  reject: (error: AdapterError) => void;
  queueTimer?: NodeJS.Timeout;
};

type ActiveItem = QueueItem & {
  dispatched: boolean;
  responseTimer?: NodeJS.Timeout;
};

type SessionConfig = Pick<
  AdapterConfig,
  | "nurixWsBaseUrl"
  | "handshakeTimeoutMs"
  | "responseTimeoutMs"
  | "heartbeatIntervalMs"
  | "pongTimeoutMs"
  | "sessionIdleTimeoutMs"
  | "maxPayloadBytes"
  | "maxResponseCharacters"
  | "maxQueueDepth"
  | "queueTimeoutMs"
>;

export type WebSocketFactory = (
  url: URL,
  options: WebSocket.ClientOptions,
) => WebSocket;

export class NurixSession {
  private socket: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private readonly queue: QueueItem[] = [];
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdOrder: string[] = [];
  private active: ActiveItem | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private accepting = true;
  private evicted = false;
  private resolveClosed: () => void = () => undefined;
  private readonly closedPromise: Promise<void>;

  constructor(
    readonly opaqueId: string,
    private readonly identity: NurixSessionIdentity,
    private readonly config: SessionConfig,
    private readonly createSocket: WebSocketFactory,
    private readonly logger: Logger,
    private readonly onEvicted: (session: NurixSession) => void,
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  send(message: string): Promise<NurixReply> {
    if (!this.accepting) return Promise.reject(serviceShuttingDownError());
    if (this.active && this.queue.length >= this.config.maxQueueDepth)
      return Promise.reject(
        new AdapterError(
          429,
          "SESSION_QUEUE_FULL",
          "The Nurix session queue is full.",
          true,
        ),
      );

    this.clearIdleTimer();
    return new Promise((resolve, reject) => {
      const queued: QueueItem = { message, resolve, reject };
      queued.queueTimer = setTimeout(() => {
        const index = this.queue.indexOf(queued);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(queueTimeoutError());
      }, this.config.queueTimeoutMs);
      this.queue.push(queued);
      this.drainQueue();
    });
  }

  beginDrain() {
    if (this.evicted) return;
    this.accepting = false;
    const error = serviceShuttingDownError();
    for (const queued of this.queue.splice(0)) {
      if (queued.queueTimer) clearTimeout(queued.queueTimer);
      queued.reject(error);
    }
    if (!this.active) this.evictGracefully("session_drained");
  }

  forceClose() {
    if (this.evicted) return;
    const activeError = this.active?.dispatched
      ? deliveryUnknownError()
      : serviceShuttingDownError();
    this.failSession(activeError, serviceShuttingDownError(), true);
  }

  whenClosed() {
    return this.closedPromise;
  }

  private drainQueue() {
    if (this.active || this.evicted) return;
    const queued = this.queue.shift();
    if (!queued) {
      if (this.accepting) this.scheduleIdleEviction();
      else this.evictGracefully("session_drained");
      return;
    }
    if (queued.queueTimer) clearTimeout(queued.queueTimer);

    this.active = { ...queued, dispatched: false };
    void this.connectAndDispatch();
  }

  private async connectAndDispatch() {
    try {
      await this.ensureConnected();
      if (this.evicted || !this.active) return;
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw unavailableError();

      const active = this.active;
      active.dispatched = true;
      active.responseTimer = setTimeout(
        () =>
          this.failSession(deliveryUnknownError(), unavailableError(), true),
        this.config.responseTimeoutMs,
      );
      try {
        socket.send(
          JSON.stringify({
            interaction_type: "response_required",
            user_id: this.identity.userId,
            text: active.message,
          }),
          (error) => {
            if (error && this.active === active)
              this.failSession(
                deliveryUnknownError(),
                unavailableError(),
                true,
              );
          },
        );
      } catch {
        this.failSession(deliveryUnknownError(), unavailableError(), true);
        return;
      }
    } catch (error) {
      if (this.evicted) return;
      this.failSession(normalizeAdapterError(error), unavailableError(), true);
    }
  }

  private async ensureConnected() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (!this.connectPromise) {
      const connection = this.openSocket();
      this.connectPromise = connection;
      void connection.then(
        () => {
          if (this.connectPromise === connection)
            this.connectPromise = undefined;
        },
        () => {
          if (this.connectPromise === connection)
            this.connectPromise = undefined;
        },
      );
    }
    await this.connectPromise;
  }

  private openSocket(): Promise<void> {
    let socket: WebSocket;
    try {
      socket = this.createSocket(
        buildNurixUrl(this.config.nurixWsBaseUrl, this.identity),
        {
          followRedirects: false,
          handshakeTimeout: this.config.handshakeTimeoutMs,
          maxPayload: this.config.maxPayloadBytes,
          perMessageDeflate: false,
        },
      );
    } catch {
      return Promise.reject(unavailableError());
    }

    this.socket = socket;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanupOpeningListeners = () => {
        socket.off("open", handleOpen);
        socket.off("close", handleOpeningFailure);
        socket.off("error", handleOpeningFailure);
        socket.off("unexpected-response", handleUnexpectedResponse);
      };
      const rejectOpening = (error: AdapterError) => {
        if (settled) return;
        settled = true;
        cleanupOpeningListeners();
        if (this.socket === socket) this.socket = undefined;
        terminateSocket(socket);
        reject(error);
      };
      const handleOpen = () => {
        if (settled) return;
        if (this.socket !== socket) {
          rejectOpening(unavailableError());
          return;
        }
        settled = true;
        cleanupOpeningListeners();
        this.installOpenSocketListeners(socket);
        this.startHeartbeat(socket);
        this.logger.info("nurix_session_connected", {
          sessionId: this.opaqueId,
        });
        resolve();
      };
      const handleOpeningFailure = (error: unknown) =>
        rejectOpening(openingFailureError(error));
      const handleUnexpectedResponse = (
        _request: import("node:http").ClientRequest,
        response: import("node:http").IncomingMessage,
      ) => {
        response.resume();
        rejectOpening(rejectedError(response.statusCode));
      };

      socket.once("open", handleOpen);
      socket.once("close", handleOpeningFailure);
      socket.once("error", handleOpeningFailure);
      socket.once("unexpected-response", handleUnexpectedResponse);
    });
  }

  private installOpenSocketListeners(socket: WebSocket) {
    socket.on("message", (data, isBinary) =>
      this.handleSocketMessage(socket, data, isBinary),
    );
    socket.once("close", () => this.handleSocketLoss(socket));
    socket.once("error", () => this.handleSocketLoss(socket));
  }

  private handleSocketMessage(
    socket: WebSocket,
    data: WebSocket.RawData,
    isBinary: boolean,
  ) {
    if (this.socket !== socket || this.evicted) return;
    if (isBinary) {
      this.failSession(this.frameError(), unavailableError(), true);
      return;
    }

    const message = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : data.toString("utf8");

    try {
      const frame = parseNurixFrame(message, this.config.maxResponseCharacters);
      if (frame.type === "unknown") return;
      if (frame.type === "pong") {
        this.clearPongTimer();
        return;
      }
      if (frame.isWelcomeMessage) return;
      if (this.seenMessageIds.has(frame.response.messageId)) return;
      if (!this.active?.dispatched) {
        this.failSession(
          this.active ? unavailableError() : protocolError(),
          unavailableError(),
          true,
        );
        return;
      }
      this.rememberMessageId(frame.response.messageId);
      this.finishActive(frame.response);
    } catch {
      this.failSession(this.frameError(), unavailableError(), true);
    }
  }

  private finishActive(reply: NurixReply) {
    const active = this.active;
    if (!active) return;
    if (active.responseTimer) clearTimeout(active.responseTimer);
    this.active = undefined;
    active.resolve(reply);

    if (!this.accepting) {
      this.evictGracefully("session_drained");
      return;
    }
    this.drainQueue();
  }

  private handleSocketLoss(socket: WebSocket) {
    if (this.socket !== socket || this.evicted) return;
    this.socket = undefined;
    this.clearHeartbeatTimers();
    this.failSession(
      this.active?.dispatched ? deliveryUnknownError() : unavailableError(),
      unavailableError(),
      true,
    );
  }

  private startHeartbeat(socket: WebSocket) {
    this.clearHeartbeatTimers();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN)
        return;
      if (this.pongTimer) return;

      try {
        this.pongTimer = setTimeout(
          () =>
            this.failSession(
              this.active?.dispatched
                ? deliveryUnknownError()
                : unavailableError(),
              unavailableError(),
              true,
            ),
          this.config.pongTimeoutMs,
        );
        socket.send(JSON.stringify({ interaction_type: "ping" }), (error) => {
          if (error && this.socket === socket)
            this.failSession(
              this.active?.dispatched
                ? deliveryUnknownError()
                : unavailableError(),
              unavailableError(),
              true,
            );
        });
      } catch {
        this.failSession(
          this.active?.dispatched ? deliveryUnknownError() : unavailableError(),
          unavailableError(),
          true,
        );
      }
    }, this.config.heartbeatIntervalMs);
  }

  private scheduleIdleEviction() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(
      () => this.evictGracefully("nurix_session_idle"),
      this.config.sessionIdleTimeoutMs,
    );
  }

  private failSession(
    activeError: AdapterError,
    queuedError: AdapterError,
    terminate: boolean,
  ) {
    if (this.evicted) return;
    this.accepting = false;
    const active = this.active;
    this.active = undefined;
    if (active?.responseTimer) clearTimeout(active.responseTimer);
    active?.reject(activeError);
    for (const queued of this.queue.splice(0)) {
      if (queued.queueTimer) clearTimeout(queued.queueTimer);
      queued.reject(queuedError);
    }
    this.logger.warn("nurix_session_failed", {
      sessionId: this.opaqueId,
      code: activeError.code,
    });
    this.evict(terminate);
  }

  private evictGracefully(event: string) {
    if (this.evicted || this.active || this.queue.length > 0) return;
    this.accepting = false;
    this.logger.info(event, { sessionId: this.opaqueId });
    this.evict(false);
  }

  private evict(terminate: boolean) {
    if (this.evicted) return;
    this.evicted = true;
    this.clearHeartbeatTimers();
    this.clearIdleTimer();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      if (terminate) terminateSocket(socket);
      else closeSocket(socket);
    }
    this.onEvicted(this);
    this.resolveClosed();
  }

  private clearHeartbeatTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.clearPongTimer();
  }

  private clearPongTimer() {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private rememberMessageId(messageId: string) {
    this.seenMessageIds.add(messageId);
    this.seenMessageIdOrder.push(messageId);
    if (this.seenMessageIdOrder.length <= 1_024) return;
    const oldestMessageId = this.seenMessageIdOrder.shift();
    if (oldestMessageId) this.seenMessageIds.delete(oldestMessageId);
  }

  private frameError() {
    return this.active && !this.active.dispatched
      ? unavailableError()
      : protocolError();
  }
}

const unavailableError = () =>
  new AdapterError(
    503,
    "NURIX_UNAVAILABLE",
    "Nurix is temporarily unavailable.",
    true,
  );

const deliveryUnknownError = () =>
  new AdapterError(
    504,
    "NURIX_DELIVERY_UNKNOWN",
    "The Nurix message delivery outcome is unknown and must not be retried automatically.",
    false,
  );

const protocolError = () =>
  new AdapterError(
    502,
    "NURIX_PROTOCOL_ERROR",
    "Nurix returned an invalid or unexpected message.",
    false,
  );

const rejectedError = (statusCode: number | undefined) => {
  const safeToRetry =
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500);
  return new AdapterError(
    502,
    "NURIX_REJECTED",
    "Nurix rejected the WebSocket connection.",
    safeToRetry,
    false,
  );
};

const openingFailureError = (error: unknown) => {
  const code = getErrorCode(error);
  if (code && permanentTlsErrorCodes.has(code))
    return new AdapterError(
      502,
      "NURIX_REJECTED",
      "The secure Nurix connection could not be established.",
      false,
      false,
    );
  return unavailableError();
};

const getErrorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
};

const permanentTlsErrorCodes = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const queueTimeoutError = () =>
  new AdapterError(
    503,
    "SESSION_QUEUE_TIMEOUT",
    "The Nurix session queue wait timed out before dispatch.",
    true,
  );

const serviceShuttingDownError = () =>
  new AdapterError(
    503,
    "SERVICE_SHUTTING_DOWN",
    "The adapter is shutting down.",
    true,
  );

const terminateSocket = (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.on("error", ignoreError);
  socket.terminate();
};

const closeSocket = (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.on("error", ignoreError);
  if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  else socket.terminate();
  const terminationTimer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 1_000);
  terminationTimer.unref();
};

const ignoreError = () => undefined;
