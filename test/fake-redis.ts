/**
 * Minimal in-memory stand-in for the subset of Redis that QuotaStore uses.
 *
 * It models key expiry against an injectable clock, which is what lets the
 * tests exercise submission leases: a lease must free its slot when it expires,
 * because eTranslation can drop a language without ever reporting a failure.
 */

import type { RedisLike } from "../src/store";

type Kind = "string" | "hash" | "set" | "zset";

interface Entry {
  kind: Kind;
  value: any;
  expiresAt: number | null;
}

export class FakeRedis implements RedisLike {
  private store = new Map<string, Entry>();
  private clock = 0;

  /** Move the fake clock forward and let expiring keys die. */
  advance(ms: number): void {
    this.clock += ms;
    this.sweep();
  }

  now(): number {
    return this.clock;
  }

  keys(): string[] {
    this.sweep();
    return [...this.store.keys()];
  }

  private sweep(): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= this.clock) {
        this.store.delete(key);
      }
    }
  }

  private entryFor(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private open(key: string, kind: Kind): Entry {
    const existing = this.entryFor(key);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(`WRONGTYPE against ${key}: have ${existing.kind}, want ${kind}`);
      }
      return existing;
    }
    const value: any =
      kind === "hash" ? new Map() : kind === "set" ? new Set() : kind === "zset" ? new Map() : "";
    const entry: Entry = { kind, value, expiresAt: null };
    this.store.set(key, entry);
    return entry;
  }

  // ------------------------------------------------------------------ hashes

  async hset(key: string, value: Record<string, string>): Promise<number> {
    const entry = this.open(key, "hash");
    let added = 0;
    for (const [field, v] of Object.entries(value)) {
      if (!entry.value.has(field)) added += 1;
      entry.value.set(field, String(v));
    }
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const entry = this.entryFor(key);
    if (!entry || entry.kind !== "hash") return null;
    return entry.value.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const entry = this.entryFor(key);
    if (!entry || entry.kind !== "hash") return {};
    return Object.fromEntries(entry.value);
  }

  async hincrby(key: string, field: string, delta: number): Promise<number> {
    const entry = this.open(key, "hash");
    const next = (Number(entry.value.get(field) ?? 0) || 0) + delta;
    entry.value.set(field, String(next));
    return next;
  }

  // ------------------------------------------------------------------- sets

  async sadd(key: string, ...members: string[]): Promise<number> {
    const entry = this.open(key, "set");
    let added = 0;
    for (const member of members) {
      if (!entry.value.has(member)) {
        entry.value.add(member);
        added += 1;
      }
    }
    return added;
  }

  async scard(key: string): Promise<number> {
    return this.entryFor(key)?.value.size ?? 0;
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.entryFor(key);
    if (!entry || entry.kind !== "set") return [];
    return [...entry.value];
  }

  // ---------------------------------------------------------------- strings

  async set(
    key: string,
    value: string,
    mode?: string,
    ttl?: number,
    nx?: string,
  ): Promise<string | null> {
    if (nx === "NX" && this.entryFor(key)) return null;
    const entry = this.open(key, "string");
    entry.value = value;
    if (mode === "EX" && ttl !== undefined) {
      entry.expiresAt = this.clock + ttl * 1000;
    }
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entryFor(key);
    return entry && entry.kind === "string" ? entry.value : null;
  }

  async exists(key: string): Promise<number> {
    return this.entryFor(key) ? 1 : 0;
  }

  async rename(key: string, target: string): Promise<string> {
    const entry = this.entryFor(key);
    if (!entry) throw new Error(`ERR no such key: ${key}`);
    this.store.delete(key);
    this.store.set(target, entry);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
    }
    return removed;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.entryFor(key);
    if (!entry) return 0;
    entry.expiresAt = this.clock + seconds * 1000;
    return 1;
  }

  // ------------------------------------------------------------------- zsets

  async zadd(key: string, score: number, member: string): Promise<number> {
    const entry = this.open(key, "zset");
    const isNew = !entry.value.has(member);
    entry.value.set(member, score);
    return isNew ? 1 : 0;
  }

  async zrem(key: string, member: string): Promise<number> {
    const entry = this.entryFor(key);
    if (!entry || entry.kind !== "zset") return 0;
    return entry.value.delete(member) ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    const entry = this.entryFor(key);
    return entry && entry.kind === "zset" ? entry.value.size : 0;
  }

  async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number> {
    const entry = this.entryFor(key);
    if (!entry || entry.kind !== "zset") return 0;
    const low = min === "-inf" ? -Infinity : Number(min);
    const high = max === "+inf" ? Infinity : Number(max);
    let removed = 0;
    for (const [member, score] of [...entry.value]) {
      if (score >= low && score <= high) {
        entry.value.delete(member);
        removed += 1;
      }
    }
    return removed;
  }
}
