import { describe, expect, beforeEach, it } from "vitest";
import { QuotaStore } from "../src/store";
import { config } from "../src/config";
import { FakeRedis } from "./fake-redis";

const LANGS = [
  "de", "fr", "es", "it", "pl", "ro", "bg", "el", "hr", "cs",
  "da", "nl", "et", "fi", "hu", "ga", "lv", "lt", "mt", "pt",
  "sk", "sl", "sv", "nn", "is", "tr",
];

describe("QuotaStore grouping", () => {
  let redis: FakeRedis;
  let store: QuotaStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new QuotaStore(redis, config, () => redis.now());
  });

  it("collects the per-language jobs of one object into a single group", async () => {
    for (const lang of LANGS) {
      await store.collectGroup("cca/en/some-page", {
        obj_uid: "uid-1",
        serial_id: 7,
        html: "<html>body</html>",
        language: lang,
      });
    }

    const group = await store.readAndCloseGroup("cca/en/some-page");
    expect(group?.langs.sort()).toEqual([...LANGS].sort());
    expect(group?.serial_id).toBe(7);
    expect(group?.obj_uid).toBe("uid-1");
  });

  it("keeps the highest serial_id seen, so the freshest content is submitted", async () => {
    await store.collectGroup("p", { obj_uid: "u", serial_id: 3, html: "old", language: "de" });
    await store.collectGroup("p", { obj_uid: "u", serial_id: 9, html: "new", language: "fr" });
    await store.collectGroup("p", { obj_uid: "u", serial_id: 4, html: "older", language: "it" });

    const group = await store.readAndCloseGroup("p");
    expect(group?.serial_id).toBe(9);
    expect(group?.html).toBe("new");
  });

  it("arms only the first job of a window, so exactly one submission is scheduled", async () => {
    await store.collectGroup("p", { obj_uid: "u", serial_id: 1, html: "h", language: "de" });
    expect(await store.armWindow("p")).toBe(true);

    for (const lang of LANGS.slice(1)) {
      await store.collectGroup("p", { obj_uid: "u", serial_id: 1, html: "h", language: lang });
      expect(await store.armWindow("p")).toBe(false);
    }
  });

  it("re-arms after the group is consumed, so a later edit still gets translated", async () => {
    await store.collectGroup("p", { obj_uid: "u", serial_id: 1, html: "h", language: "de" });
    await store.armWindow("p");
    await store.readAndCloseGroup("p");

    await store.collectGroup("p", { obj_uid: "u", serial_id: 2, html: "h2", language: "nl" });
    expect(await store.armWindow("p")).toBe(true);
    const second = await store.readAndCloseGroup("p");
    expect(second?.langs).toEqual(["nl"]);
  });

  it("returns null when a group was already consumed (duplicate submit job)", async () => {
    await store.collectGroup("p", { obj_uid: "u", serial_id: 1, html: "h", language: "de" });
    await store.readAndCloseGroup("p");
    expect(await store.readAndCloseGroup("p")).toBeNull();
  });
});

describe("QuotaStore in-flight gate", () => {
  let redis: FakeRedis;
  let store: QuotaStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new QuotaStore(redis, config, () => redis.now());
  });

  it("counts reserved submissions against the ceiling", async () => {
    expect(await store.inFlightCount()).toBe(0);
    await store.reserve("tok1", { request_id: "1", remaining: 2, langs: ["de", "fr"] });
    await store.reserve("tok2", { request_id: "2", remaining: 1, langs: ["de"] });
    expect(await store.inFlightCount()).toBe(2);
  });

  it("reclaims a slot when every language of a bundled submission is delivered", async () => {
    await store.reserve("tok", { request_id: "1", remaining: 3, langs: ["a", "b", "c"] });
    expect(await store.progress("tok")).toBe(2);
    expect(await store.progress("tok")).toBe(1);
    expect(await store.inFlightCount()).toBe(1);
    expect(await store.progress("tok")).toBe(0);
    expect(await store.inFlightCount()).toBe(0);
  });

  it("holds a partially delivered slot and then reclaims it when the lease expires", async () => {
    // 26 languages requested, 25 delivered: EN->ET silently never arrives.
    await store.reserve("tok", { request_id: "1", remaining: 26, langs: LANGS }, 0);
    for (let i = 0; i < 25; i++) await store.progress("tok");
    expect(await store.inFlightCount()).toBe(1);

    redis.advance(config.leaseMs + 1);
    expect(await store.inFlightCount()).toBe(0);
  });

  it("releases early on a duplicate delivery without going negative", async () => {
    await store.reserve("tok", { request_id: "1", remaining: 1, langs: ["de"] });
    expect(await store.progress("tok")).toBe(0);
    // record is gone; a retried delivery must not resurrect or corrupt it
    expect(await store.progress("tok")).toBeNull();
    expect(await store.inFlightCount()).toBe(0);
  });

  it("trips a breaker that blocks intake until it expires", async () => {
    expect(await store.breakerOpen()).toBe(false);
    await store.openBreaker();
    expect(await store.breakerOpen()).toBe(true);
    redis.advance(config.breakerMs + 1000);
    expect(await store.breakerOpen()).toBe(false);
  });
});

describe("QuotaStore correlation and cache", () => {
  let redis: FakeRedis;
  let store: QuotaStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new QuotaStore(redis, config, () => redis.now());
  });

  it("round-trips a correlation record", async () => {
    await store.saveCorrelation({
      token: "abc123",
      path: "cca/en/page",
      obj_uid: "uid",
      serial_id: "12",
      sha: "deadbeef",
      langs: "de,fr",
      request_id: "99",
    });
    const corr = await store.getCorrelation("abc123");
    expect(corr).toMatchObject({ path: "cca/en/page", serial_id: "12", sha: "deadbeef" });
    expect(await store.getCorrelation("nope")).toBeNull();
  });

  it("records translated languages per source hash and reports them back", async () => {
    await store.markTranslated("sha1", "de");
    await store.markTranslated("sha1", "fr");
    await store.markTranslated("sha2", "de");
    expect((await store.translatedLangs("sha1")).sort()).toEqual(["de", "fr"]);
    expect(await store.translatedLangs("sha2")).toEqual(["de"]);
    expect(await store.translatedLangs("unknown")).toEqual([]);
  });

  it("expires correlation records so they cannot accumulate", async () => {
    await store.saveCorrelation({
      token: "t", path: "p", obj_uid: "", serial_id: "1", sha: "s", langs: "de", request_id: "1",
    });
    redis.advance(config.corrTtlSec * 1000 + 1000);
    expect(await store.getCorrelation("t")).toBeNull();
  });
});
