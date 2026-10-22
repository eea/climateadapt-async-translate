/**
 * Redis-backed state for the quota-aware eTranslation pipeline.
 *
 * Three independent mechanisms, all of which expire so nothing can leak:
 *
 *  - grouping:    collapse the 26 per-language jobs Plone queues for one object
 *                 into a single submission
 *  - in-flight gate: a zset of submission leases, which is what actually keeps
 *                 us under eTranslation's 50-active-submission concurrency quota
 *  - cache:       languages already translated for byte-identical source HTML
 *
 * Every key carries a TTL. The store takes an injected client so it can be
 * driven by the in-memory fake used in tests.
 */

import type { Config } from "./config";

/** The subset of ioredis this module uses. */
export interface RedisLike {
  hset(key: string, value: Record<string, string>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hincrby(key: string, field: string, delta: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  scard(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  set(
    key: string,
    value: string,
    mode?: string,
    ttl?: number,
    nx?: string,
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  zcard(key: string): Promise<number>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  rename(key: string, target: string): Promise<string>;
}

export interface GroupRecord {
  obj_url: string;
  obj_uid: string;
  serial_id: number;
  html: string;
  langs: string[];
}

export interface Correlation {
  token: string;
  path: string;
  obj_uid: string;
  serial_id: string;
  sha: string;
  langs: string;
  request_id: string;
}

const PREFIX = "cca";

const grpKey = (key: string) => `${PREFIX}:grp:${key}`;
const langsKey = (key: string) => `${PREFIX}:grp:${key}:langs`;
const armedKey = (key: string) => `${PREFIX}:grp:${key}:armed`;
const corrKey = (token: string) => `${PREFIX}:corr:${token}`;
const inflightKey = (token: string) => `${PREFIX}:inflight:${token}`;
const doneKey = (sha: string) => `${PREFIX}:done:${sha}`;
const INDEX_KEY = `${PREFIX}:inflight:idx`;
const BREAKER_KEY = `${PREFIX}:breaker`;
const STATS_KEY = `${PREFIX}:stats`;

export class QuotaStore {
  constructor(
    private r: RedisLike,
    private cfg: Config,
    /** Injectable clock so lease behaviour can be exercised deterministically. */
    private clock: () => number = () => Date.now(),
  ) {}

  private now(): number {
    return this.clock();
  }

  // ---------------------------------------------------------------- grouping

  /**
   * Record one (object, language) job into its group. `serial_id` keeps the
   * highest value seen so the submission carries the freshest content.
   */
  async collectGroup(
    objUrl: string,
    entry: {
      obj_uid: string;
      serial_id: number;
      html: string;
      language: string;
    },
  ): Promise<number> {
    const key = grpKey(objUrl);
    const previous = await this.r.hget(key, "serial_id");
    const stored = Number(previous) || 0;
    const incoming = Number(entry.serial_id) || 0;

    // The html must belong to the same revision as the serial_id we keep, or a
    // group spanning two edits would submit one edit's text under another
    // edit's serial_id and Plone's staleness guard would accept the wrong pair.
    if (incoming >= stored) {
      await this.r.hset(key, {
        obj_url: objUrl,
        obj_uid: entry.obj_uid || "",
        serial_id: String(incoming),
        html: entry.html,
        created: String(this.now()),
      });
    }
    await this.r.expire(key, this.cfg.groupTtlSec);

    await this.r.sadd(langsKey(objUrl), entry.language);
    await this.r.expire(langsKey(objUrl), this.cfg.groupTtlSec);

    return this.r.scard(langsKey(objUrl));
  }

  /**
   * Claim the right to schedule a submission for this group. Only the first
   * caller within a window gets true, so exactly one submit job is queued.
   */
  async armWindow(objUrl: string): Promise<boolean> {
    const ttl = Math.ceil(
      Math.max(this.cfg.groupWindowMs * 6, this.cfg.leaseMs) / 1000,
    );
    const res = await this.r.set(armedKey(objUrl), "1", "EX", ttl, "NX");
    return res === "OK";
  }

  /**
   * Read the group and close it, so the next job for this object starts a fresh
   * window. Returns null when the group was already consumed.
   */
  async readAndCloseGroup(objUrl: string): Promise<GroupRecord | null> {
    const key = grpKey(objUrl);
    const langsKeyHere = langsKey(objUrl);

    // Close the window before reading. A job that arrives during the read then
    // arms its own submission instead of having its language deleted under it -
    // with the delete last, a language collected between the read and the
    // delete vanished and nothing was rescheduled for it.
    await this.r.del(armedKey(objUrl));

    const group = await this.r.hgetall(key);
    if (!group || !group.obj_url) {
      await this.r.del(key, langsKeyHere);
      return null;
    }

    // RENAME is atomic: a language added after this point lands in a fresh set
    // belonging to the next window, and one added before it is included here.
    let langs: string[] = [];
    if (await this.r.exists(langsKeyHere)) {
      const closing = `${langsKeyHere}:closing`;
      await this.r.rename(langsKeyHere, closing);
      langs = await this.r.smembers(closing);
      await this.r.del(closing);
    }
    await this.r.del(key);

    return {
      obj_url: group.obj_url,
      obj_uid: group.obj_uid || "",
      serial_id: Number(group.serial_id) || 0,
      html: group.html || "",
      langs,
    };
  }

  // ------------------------------------------------------------ in-flight gate

  /** Drop expired leases and report how many submissions are still active. */
  async inFlightCount(): Promise<number> {
    await this.r.zremrangebyscore(INDEX_KEY, 0, this.now());
    return this.r.zcard(INDEX_KEY);
  }

  /** Take a slot for a submission. */
  async reserve(
    token: string,
    meta: { request_id: string; remaining: number; langs: string[] },
  ): Promise<void> {
    const key = inflightKey(token);
    const now = this.now();
    await this.r.hset(key, {
      request_id: meta.request_id,
      remaining: String(meta.remaining),
      langs: meta.langs.join(","),
      submitted_at: String(now),
    });
    await this.r.expire(key, Math.ceil(this.cfg.leaseMs / 1000));
    await this.r.zadd(INDEX_KEY, now + this.cfg.leaseMs, token);
  }

  /** Free a slot early. */
  async release(token: string): Promise<void> {
    await this.r.zrem(INDEX_KEY, token);
    await this.r.del(inflightKey(token), `${inflightKey(token)}:seen`);
  }

  /**
   * One language of a bundled submission came back. Returns the number still
   * outstanding, or null when the record was already gone (expired lease or a
   * duplicate delivery).
   */
  async progress(token: string, language: string): Promise<number | null> {
    const key = inflightKey(token);
    // HINCRBY would happily create the key at -1, so a retried delivery of an
    // already-finished submission would leave a stray record behind.
    if (!(await this.r.exists(key))) return null;

    // Count distinct languages, not deliveries. eTranslation redelivers when a
    // callback fails, and decrementing per delivery frees the slot while other
    // languages of the same submission are still outstanding - which is how a
    // gate ends up over quota.
    const seenKey = `${key}:seen`;
    if ((await this.r.sadd(seenKey, language)) === 0) {
      const remaining = await this.r.hget(key, "remaining");
      return remaining === null ? null : Number(remaining);
    }
    await this.r.expire(seenKey, Math.ceil(this.cfg.leaseMs / 1000));

    const remaining = await this.r.hincrby(key, "remaining", -1);
    if (!Number.isFinite(remaining)) return null;
    if (remaining <= 0) {
      await this.release(token);
      return 0;
    }
    // A partially delivered submission must still expire: eTranslation can drop
    // a language without ever reporting a failure.
    await this.r.expire(inflightKey(token), Math.ceil(this.cfg.leaseMs / 1000));
    return remaining;
  }

  async openBreaker(): Promise<void> {
    await this.r.set(
      BREAKER_KEY,
      String(this.now()),
      "EX",
      Math.ceil(this.cfg.breakerMs / 1000),
    );
  }

  async breakerOpen(): Promise<boolean> {
    return (await this.r.exists(BREAKER_KEY)) === 1;
  }

  // ------------------------------------------------------------ correlation

  async saveCorrelation(corr: Correlation): Promise<void> {
    const key = corrKey(corr.token);
    await this.r.hset(key, {
      path: corr.path,
      obj_uid: corr.obj_uid,
      serial_id: corr.serial_id,
      sha: corr.sha,
      langs: corr.langs,
      request_id: corr.request_id,
    });
    await this.r.expire(key, this.cfg.corrTtlSec);
  }

  async getCorrelation(token: string): Promise<Correlation | null> {
    const data = await this.r.hgetall(corrKey(token));
    if (!data || !data.path) return null;
    return { token, ...data } as Correlation;
  }

  // ------------------------------------------------------------------- cache

  async translatedLangs(sha: string): Promise<string[]> {
    if (!this.cfg.skipCache || !sha) return [];
    return this.r.smembers(doneKey(sha));
  }

  async markTranslated(sha: string, language: string): Promise<void> {
    if (!this.cfg.skipCache || !sha || !language) return;
    const key = doneKey(sha);
    await this.r.sadd(key, language);
    await this.r.expire(key, this.cfg.skipCacheTtlSec);
  }

  // ------------------------------------------------------------------- stats

  async stat(field: string, delta = 1): Promise<number> {
    return this.r.hincrby(STATS_KEY, field, delta);
  }

  async stats(): Promise<Record<string, string>> {
    return this.r.hgetall(STATS_KEY);
  }
}
