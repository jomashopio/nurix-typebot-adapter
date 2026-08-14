import { createHmac } from "node:crypto";
import WebSocket from "ws";
import type { AdapterConfig } from "../config/parseConfig.js";
import { AdapterError } from "../errors/AdapterError.js";
import type { Logger } from "../logging/Logger.js";
import {
  createNurixWidgetResolver,
  type NurixWidgetResolver,
} from "../nurix/createNurixWidgetResolver.js";
import type { NurixReply, SendMessageRequest } from "../nurix/types.js";
import { NurixSession, type WebSocketFactory } from "./NurixSession.js";

export type MessageSender = {
  send(request: SendMessageRequest): Promise<NurixReply>;
};

export class SessionManager implements MessageSender {
  private readonly sessions = new Map<string, NurixSession>();
  private accepting = true;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly config: AdapterConfig,
    private readonly logger: Logger,
    private readonly resolveWidget: NurixWidgetResolver = createNurixWidgetResolver(
      config,
    ),
    private readonly createSocket: WebSocketFactory = (url, options) =>
      new WebSocket(url, options),
  ) {}

  send(request: SendMessageRequest): Promise<NurixReply> {
    if (!this.accepting)
      return Promise.reject(
        new AdapterError(
          503,
          "SERVICE_SHUTTING_DOWN",
          "The adapter is shutting down.",
          true,
        ),
      );

    const key = createSessionKey(request);
    let session = this.sessions.get(key);
    if (!session) {
      if (this.sessions.size >= this.config.maxSessions)
        return Promise.reject(
          new AdapterError(
            503,
            "SESSION_CAPACITY_REACHED",
            "The adapter is at session capacity.",
            true,
          ),
        );

      session = new NurixSession(
        key.slice(0, 16),
        {
          apiKey: request.apiKey,
          gatewayApiKey: request.gatewayApiKey,
          widgetId: request.widgetId,
          userId: request.userId,
        },
        this.config,
        this.resolveWidget,
        this.createSocket,
        this.logger,
        (evictedSession) => {
          if (this.sessions.get(key) === evictedSession)
            this.sessions.delete(key);
        },
      );
      this.sessions.set(key, session);
    }

    return session.send(request.message);
  }

  get size() {
    return this.sessions.size;
  }

  shutdown(timeoutMs: number = this.config.shutdownTimeoutMs) {
    if (!this.shutdownPromise)
      this.shutdownPromise = this.performShutdown(timeoutMs);
    return this.shutdownPromise;
  }

  private async performShutdown(timeoutMs: number) {
    this.accepting = false;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.beginDrain();

    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(sessions.map((session) => session.whenClosed())),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (timedOut) {
      for (const session of sessions) session.forceClose();
      await Promise.all(sessions.map((session) => session.whenClosed()));
    }
  }
}

const createSessionKey = (request: SendMessageRequest) => {
  const digest = createHmac("sha256", request.apiKey);
  for (const value of [
    request.gatewayApiKey,
    request.widgetId,
    request.userId,
  ]) {
    digest.update(String(Buffer.byteLength(value)));
    digest.update(":");
    digest.update(value);
    digest.update(";");
  }
  return digest.digest("hex");
};
