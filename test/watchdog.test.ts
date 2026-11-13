import { describe, expect, beforeEach, it } from "vitest";
import type { Queue } from "bullmq";
import { QuotaStore } from "../src/store";
import { config } from "../src/config";
import { runDeliveryWatchdog } from "../src/jobs";
import { setStore, setSubmitQueue } from "../src/deps";
import { FakeRedis } from "./fake-redis";

/**
 * The delivery watchdog exists because eTranslation is fire-and-forget: there
 * is no per-request status endpoint, so a delivery that never arrives is
 * invisible. The in-flight lease expires on its own and the gate reports idle,
 * which is why a 20 hour upstream stall looked like a healthy pipeline.
 */
describe("delivery watchdog", () => {
  let redis: FakeRedis;
  let store: QuotaStore;

  const TOKEN = "a1b2c3d4e5f60708";
  const META = {
    obj_url: "/en/learning-collaboration",
    obj_uid: "uid-1",
    serial_id: 42,
    sha: "deadbeef",
    langs: ["de", "fr", "tr"],
    request_id: "144124924",
    html: "<p>source</p>",
    deadlineMs: 45 * 60_000,
  };

  beforeEach(() => {
    redis = new FakeRedis();
    store = new QuotaStore(redis, config, () => redis.now());
  });

  it("tracks every requested language as pending", async () => {
    await store.armWatchdog(TOKEN, META);
    expect((await store.watchdogPending(TOKEN)).sort()).toEqual(["de", "fr", "tr"]);
  });

  it("is not due before the deadline and is due after it", async () => {
    await store.armWatchdog(TOKEN, META);

    redis.advance(44 * 60_000);
    expect(await store.dueWatchdogTokens()).toEqual([]);

    redis.advance(2 * 60_000);
    expect(await store.dueWatchdogTokens()).toEqual([TOKEN]);
  });

  it("stops being due once every language has been delivered", async () => {
    await store.armWatchdog(TOKEN, META);
    for (const lang of META.langs) await store.noteDelivery(TOKEN, lang);

    redis.advance(60 * 60_000);
    expect(await store.watchdogPending(TOKEN)).toEqual([]);
  });

  it("keeps a partially delivered submission due for the missing languages only", async () => {
    await store.armWatchdog(TOKEN, META);
    await store.noteDelivery(TOKEN, "de");
    await store.noteDelivery(TOKEN, "fr");

    redis.advance(60 * 60_000);
    expect(await store.dueWatchdogTokens()).toEqual([TOKEN]);
    expect(await store.watchdogPending(TOKEN)).toEqual(["tr"]);
  });

  it("ignores duplicate deliveries", async () => {
    await store.armWatchdog(TOKEN, META);
    await store.noteDelivery(TOKEN, "de");
    await store.noteDelivery(TOKEN, "de");
    expect(await store.watchdogPending(TOKEN)).toEqual(["fr", "tr"]);
  });

  it("keeps the payload needed to re-submit", async () => {
    await store.armWatchdog(TOKEN, META);
    const rec = await store.watchdogRecord(TOKEN);
    expect(rec?.obj_url).toBe(META.obj_url);
    expect(rec?.html).toBe(META.html);
    expect(rec?.request_id).toBe(META.request_id);
    expect(rec?.serial_id).toBe("42");
    expect(rec?.attempts).toBe(0);
  });

  it("counts re-submissions and re-arms the deadline", async () => {
    await store.armWatchdog(TOKEN, META);

    redis.advance(46 * 60_000);
    expect(await store.dueWatchdogTokens()).toEqual([TOKEN]);

    const attempts = await store.bumpWatchdog(TOKEN, 45 * 60_000);
    expect(attempts).toBe(1);
    // Re-armed, so it must not be due again immediately.
    expect(await store.dueWatchdogTokens()).toEqual([]);

    redis.advance(46 * 60_000);
    expect(await store.dueWatchdogTokens()).toEqual([TOKEN]);
    expect(await store.bumpWatchdog(TOKEN, 45 * 60_000)).toBe(2);
  });

  it("clearing removes the record, the pending set and the index entry", async () => {
    await store.armWatchdog(TOKEN, META);
    await store.clearWatchdog(TOKEN);

    redis.advance(60 * 60_000);
    expect(await store.dueWatchdogTokens()).toEqual([]);
    expect(await store.watchdogRecord(TOKEN)).toBeNull();
    expect(await store.watchdogPending(TOKEN)).toEqual([]);
  });

  it("a submission with no source html still reports its missing languages", async () => {
    await store.armWatchdog(TOKEN, { ...META, html: "" });
    const rec = await store.watchdogRecord(TOKEN);
    expect(rec?.html).toBe("");
    // The caller must be able to tell "cannot re-submit" from "nothing missing".
    expect(await store.watchdogPending(TOKEN)).toEqual(META.langs);
  });

  it("does not report tokens that were never armed", async () => {
    redis.advance(90 * 60_000);
    expect(await store.dueWatchdogTokens()).toEqual([]);
    expect(await store.watchdogRecord("nope")).toBeNull();
  });

  it("respects the batch limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.armWatchdog(`tok-${i}`, META);
    }
    redis.advance(60 * 60_000);
    expect((await store.dueWatchdogTokens(2)).length).toBe(2);
    expect((await store.dueWatchdogTokens()).length).toBe(5);
  });

  it("uses the LIMIT keyword, not a bare count", async () => {
    // Regression: ZRANGEBYSCORE key min max <n> is a syntax error in real
    // Redis. It raised ERR syntax error every 60s in production while the
    // tests passed, because the fake accepted the malformed call.
    for (let i = 0; i < 4; i++) {
      await store.armWatchdog(`tok-${i}`, META);
    }
    redis.advance(60 * 60_000);
    let syntaxOk = true;
    try {
      await store.dueWatchdogTokens(2);
    } catch {
      syntaxOk = false;
    }
    expect(syntaxOk).toBe(true);

    // The fake must reject the malformed form, or this guard is worthless.
    await expect(
      redis.zrangebyscore("cca:watch:idx", 0, redis.now(), 2),
    ).rejects.toThrow(/syntax error/i);
  });

  it("returns every due token when the limit is not positive", async () => {
    for (let i = 0; i < 3; i++) {
      await store.armWatchdog(`tok-${i}`, META);
    }
    redis.advance(60 * 60_000);
    expect((await store.dueWatchdogTokens(0)).length).toBe(3);
  });
});

describe("runDeliveryWatchdog", () => {
  let redis: FakeRedis;
  let store: QuotaStore;
  let adds: Array<{ name: string; data: any; opts: any }>;

  const TOKEN = "a1b2c3d4e5f60708";
  const META = {
    obj_url: "/en/learning-collaboration",
    obj_uid: "uid-1",
    serial_id: 42,
    sha: "deadbeef",
    langs: ["de", "fr", "tr"],
    request_id: "144124924",
    html: "<p>source</p>",
    deadlineMs: 45 * 60_000,
  };

  beforeEach(() => {
    redis = new FakeRedis();
    store = new QuotaStore(redis, config, () => redis.now());
    setStore(store);
    adds = [];
    setSubmitQueue({
      add: async (name: string, data: any, opts: any) => {
        adds.push({ name, data, opts });
      },
    } as unknown as Queue);
  });

  it("does nothing while deliveries are still inside the deadline", async () => {
    await store.armWatchdog(TOKEN, META);
    redis.advance(10 * 60_000);
    expect(await runDeliveryWatchdog()).toBe(0);
    expect(adds).toHaveLength(0);
  });

  it("re-submits only the languages that never came back", async () => {
    await store.armWatchdog(TOKEN, META);
    await store.noteDelivery(TOKEN, "de");
    await store.noteDelivery(TOKEN, "fr");

    redis.advance(46 * 60_000);
    expect(await runDeliveryWatchdog()).toBe(1);

    expect(adds).toHaveLength(1);
    expect(adds[0].name).toBe("submit_group");
    expect(adds[0].data.payload.langs).toEqual(["tr"]);
    expect(adds[0].data.payload.html).toBe(META.html);
    expect(adds[0].data.payload.obj_url).toBe(META.obj_url);
    expect(adds[0].opts.attempts).toBe(1);
  });

  it("does not burn quota on languages the portal already registered", async () => {
    await store.armWatchdog(TOKEN, META);
    await store.markTranslated(META.sha, "de");
    await store.markTranslated(META.sha, "fr");
    await store.markTranslated(META.sha, "tr");

    redis.advance(46 * 60_000);
    expect(await runDeliveryWatchdog()).toBe(0);
    expect(adds).toHaveLength(0);
    // The record must be released, not left to fire every pass.
    expect(await store.dueWatchdogTokens()).toEqual([]);
  });

  it("stops re-submitting after the configured attempts", async () => {
    await store.armWatchdog(TOKEN, META);

    for (let i = 0; i <= config.watchdogMaxResubmits; i++) {
      redis.advance(46 * 60_000);
      await runDeliveryWatchdog();
    }

    expect(adds).toHaveLength(config.watchdogMaxResubmits);
    // Given up: the record is gone rather than looping forever.
    expect(await store.watchdogRecord(TOKEN)).toBeNull();
  });

  it("cannot re-submit without the source html but leaves the record cleared", async () => {
    await store.armWatchdog(TOKEN, { ...META, html: "" });
    redis.advance(46 * 60_000);

    expect(await runDeliveryWatchdog()).toBe(0);
    expect(adds).toHaveLength(0);
    expect(await store.watchdogRecord(TOKEN)).toBeNull();
  });

  it("re-arms so a still-missing language is tried again later", async () => {
    await store.armWatchdog(TOKEN, META);

    redis.advance(46 * 60_000);
    await runDeliveryWatchdog();
    expect(await store.dueWatchdogTokens()).toEqual([]);

    redis.advance(46 * 60_000);
    expect(await runDeliveryWatchdog()).toBe(1);
    expect(adds).toHaveLength(2);
  });
});
