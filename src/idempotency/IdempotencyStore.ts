import { createHash } from "node:crypto";
import { AdapterError } from "../errors/AdapterError.js";
import type { NurixReply, SendMessageRequest } from "../nurix/types.js";

type Entry = {
  fingerprint: string;
  expiresAt: number | undefined;
  promise: Promise<NurixReply>;
};

type Expiration = {
  scopedKey: string;
  entry: Entry;
  expiresAt: number;
};

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly expirations: Expiration[] = [];

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  execute(
    apiKey: string,
    idempotencyKey: string,
    request: SendMessageRequest,
    operation: () => Promise<NurixReply>,
  ): Promise<{ value: NurixReply; replayed: boolean }> {
    this.removeExpired();
    const scopedKey = `${hash(apiKey)}:${idempotencyKey}`;
    const fingerprint = fingerprintRequest(request);
    const existing = this.entries.get(scopedKey);

    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(
          new AdapterError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for a different request.",
            false,
          ),
        );
      return existing.promise.then((value) => ({ value, replayed: true }));
    }

    if (this.entries.size >= this.maxEntries)
      return Promise.reject(
        new AdapterError(
          503,
          "IDEMPOTENCY_CAPACITY_REACHED",
          "The adapter is at idempotency capacity.",
          true,
        ),
      );

    const entry: Entry = {
      fingerprint,
      expiresAt: undefined,
      promise: Promise.resolve().then(operation),
    };
    entry.promise = entry.promise.then(
      (value) => {
        this.scheduleExpiration(scopedKey, entry);
        return value;
      },
      (error: unknown) => {
        if (error instanceof AdapterError && !error.preserveIdempotency) {
          if (this.entries.get(scopedKey) === entry)
            this.entries.delete(scopedKey);
        } else {
          this.scheduleExpiration(scopedKey, entry);
        }
        throw error;
      },
    );
    this.entries.set(scopedKey, entry);

    return entry.promise.then((value) => ({ value, replayed: false }));
  }

  get size() {
    this.removeExpired();
    return this.entries.size;
  }

  private removeExpired() {
    const now = this.now();
    while (this.expirations[0]?.expiresAt !== undefined) {
      const expiration = this.expirations[0];
      if (!expiration || expiration.expiresAt > now) return;
      popExpiration(this.expirations);
      if (
        this.entries.get(expiration.scopedKey) === expiration.entry &&
        expiration.entry.expiresAt === expiration.expiresAt
      )
        this.entries.delete(expiration.scopedKey);
    }
  }

  private scheduleExpiration(scopedKey: string, entry: Entry) {
    const expiresAt = this.now() + this.ttlMs;
    entry.expiresAt = expiresAt;
    pushExpiration(this.expirations, { scopedKey, entry, expiresAt });
  }
}

const pushExpiration = (heap: Expiration[], expiration: Expiration) => {
  heap.push(expiration);
  let index = heap.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const current = heap[index];
    const parent = heap[parentIndex];
    if (!current || !parent || parent.expiresAt <= current.expiresAt) return;
    heap[index] = parent;
    heap[parentIndex] = current;
    index = parentIndex;
  }
};

const popExpiration = (heap: Expiration[]) => {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    const current = heap[index];
    const left = heap[leftIndex];
    const right = heap[rightIndex];
    if (!current) return first;
    let smallestIndex = index;
    if (left && left.expiresAt < current.expiresAt) smallestIndex = leftIndex;
    const smallest = heap[smallestIndex];
    if (right && smallest && right.expiresAt < smallest.expiresAt)
      smallestIndex = rightIndex;
    if (smallestIndex === index) return first;
    const replacement = heap[smallestIndex];
    if (!replacement) return first;
    heap[index] = replacement;
    heap[smallestIndex] = current;
    index = smallestIndex;
  }
};

const fingerprintRequest = (request: SendMessageRequest) => {
  const digest = createHash("sha256");
  for (const value of [
    request.apiKey,
    request.widgetId,
    request.agentId,
    request.userId,
    request.message,
  ]) {
    digest.update(String(Buffer.byteLength(value)));
    digest.update(":");
    digest.update(value);
    digest.update(";");
  }
  return digest.digest("hex");
};

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
