/**
 * Shared singletons (Redis client, quota store, submit queue) so that job
 * handlers can reach them without importing index.ts and creating an import
 * cycle. Tests replace these with in-memory doubles via setStore/setSubmitQueue.
 */

import IORedis from "ioredis";
import { Queue } from "bullmq";
import { config } from "./config";
import { QuotaStore, type RedisLike } from "./store";

let store: QuotaStore | null = null;
let submitQueue: Queue | null = null;
let quotaConnection: IORedis | null = null;

export function initDeps(opts: {
  host: string;
  port: number;
  /** The BullMQ connection, reused for queue objects but not for raw commands. */
  bullConnection: IORedis;
}): QuotaStore {
  // BullMQ manages its own connections; keep our raw command traffic on a
  // separate client so the two never contend.
  quotaConnection = new IORedis({
    host: opts.host,
    port: opts.port,
    maxRetriesPerRequest: null,
  });
  store = new QuotaStore(quotaConnection as unknown as RedisLike, config);
  submitQueue = new Queue(config.submitQueue, { connection: opts.bullConnection });
  return store;
}

export function getStore(): QuotaStore {
  if (!store) {
    throw new Error("Quota store is not initialised - initDeps() was not called");
  }
  return store;
}

export function getSubmitQueue(): Queue {
  if (!submitQueue) {
    throw new Error(`Submit queue is not initialised - initDeps() was not called`);
  }
  return submitQueue;
}

/** Test seams. */
export function setStore(s: QuotaStore | null): void {
  store = s;
}

export function setSubmitQueue(q: Queue | null): void {
  submitQueue = q;
}

export async function closeDeps(): Promise<void> {
  if (quotaConnection) {
    await quotaConnection.quit();
    quotaConnection = null;
  }
  store = null;
  submitQueue = null;
}
