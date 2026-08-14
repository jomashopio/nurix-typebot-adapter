export type AdapterErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_CAPACITY_REACHED"
  | "SESSION_CAPACITY_REACHED"
  | "SESSION_QUEUE_FULL"
  | "SESSION_QUEUE_TIMEOUT"
  | "SERVICE_SHUTTING_DOWN"
  | "NURIX_UNAVAILABLE"
  | "NURIX_REJECTED"
  | "NURIX_PROTOCOL_ERROR"
  | "NURIX_DELIVERY_UNKNOWN"
  | "INTERNAL_ERROR";

export class AdapterError extends Error {
  readonly status: number;
  readonly code: AdapterErrorCode;
  readonly safeToRetry: boolean;
  readonly preserveIdempotency: boolean;

  constructor(
    status: number,
    code: AdapterErrorCode,
    message: string,
    safeToRetry: boolean,
    preserveIdempotency: boolean = !safeToRetry,
  ) {
    super(message);
    this.name = "AdapterError";
    this.status = status;
    this.code = code;
    this.safeToRetry = safeToRetry;
    this.preserveIdempotency = preserveIdempotency;
  }
}

export const normalizeAdapterError = (error: unknown) =>
  error instanceof AdapterError
    ? error
    : new AdapterError(
        500,
        "INTERNAL_ERROR",
        "The adapter could not complete the request.",
        false,
      );
