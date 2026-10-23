import { describe, expect, beforeEach, it, vi } from "vitest";
import { Queue } from "bullmq";
import { contentSha, JOBS_MAPPING } from "../src/jobs";
import { QuotaStore } from "../src/store";
import { config } from "../src/config";
import { setStore, setSubmitQueue } from "../src/deps";
import { FakeRedis } from "./fake-redis";

const LANGS = [
  "de", "fr", "es", "it", "pl", "ro", "bg", "el", "hr", "cs",
  "da", "nl", "et", "fi", "hu", "ga", "lv", "lt", "mt", "pt",
  "sk", "sl", "sv", "nn", "is", "tr",
];
const HTML = "<html><body><p>climate content</p></body></html>";
// The cache key is scoped to the object, so tests must build it the same way.
const sha = (objUrl = "cca/en/a-page", html = HTML) => contentSha("uid-1", objUrl, html);

let redis: FakeRedis;
let store: QuotaStore;
let fetchCalls: { url: string; form: FormData }[];
let queueAdds: { name: string; data: any; opts: any }[];
let responses: any[];

function jsonResponse(body: any) {
  return {
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  redis = new FakeRedis();
  store = new QuotaStore(redis, config, () => redis.now());
  setStore(store);
  queueAdds = [];
  setSubmitQueue({
    add: async (name: string, data: any, opts: any) => {
      queueAdds.push({ name, data, opts });
    },
  } as unknown as Queue);

  fetchCalls = [];
  responses = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), form: init.body });
    const next = responses.shift() ?? { ok: true };
    if (next instanceof Error) throw next; // simulate a transport failure
    return jsonResponse(next);
  });

  config.groupingEnabled = false;
  config.maxInFlight = 40;
});

async function seedGroup(objUrl = "cca/en/a-page", langs = LANGS, serialId = 5, objUid = "uid-1") {
  for (const language of langs) {
    await store.collectGroup(objUrl, {
      obj_uid: objUid,
      serial_id: serialId,
      html: HTML,
      language,
    });
  }
}

describe("call_etranslation with grouping off (today's behaviour)", () => {
  it("submits one request per language and sends no ext_ref", async () => {
    responses.push({ transId: 1, externalRefId: "x" });
    const result = await JOBS_MAPPING.call_etranslation({
      obj_url: "cca/en/a-page",
      obj_uid: "uid-1",
      html: HTML,
      serial_id: 5,
      language: "de",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].form.get("target_lang")).toBe("de");
    expect(fetchCalls[0].form.get("ext_ref")).toBeNull();
    expect(fetchCalls[0].form.get("obj_path")).toBe(
      "cca/en/a-page?serial_id=5&language=de&obj_uid=uid-1",
    );
    expect(result).toMatchObject({ transId: 1 });
  });

  it("still throws on a quota error, exactly as before", async () => {
    responses.push({
      error_type: { message: "REST v2 eTranslation request failed: errorCode=-11200" },
    });
    await expect(
      JOBS_MAPPING.call_etranslation({
        obj_url: "cca/en/a-page", obj_uid: "u", html: HTML, serial_id: 1, language: "de",
      }),
    ).rejects.toThrow(/-11200/);
  });

  it("surfaces an eTranslation errorCode carried in the response body", async () => {
    responses.push({ errorCode: "-10003", errorMessage: "EXTERNAL_REFERENCE_TOO_LONG" });
    await expect(
      JOBS_MAPPING.call_etranslation({
        obj_url: "cca/en/a-page", obj_uid: "u", html: HTML, serial_id: 1, language: "de",
      }),
    ).rejects.toThrow(/errorCode=-10003 errorMessage=EXTERNAL_REFERENCE_TOO_LONG/);
  });
});

describe("call_etranslation as collector (grouping on)", () => {
  beforeEach(() => {
    config.groupingEnabled = true;
  });

  it("makes no eTranslation call at all", async () => {
    await JOBS_MAPPING.call_etranslation({
      obj_url: "cca/en/a-page", obj_uid: "u", html: HTML, serial_id: 1, language: "de",
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it("drops a collect job that has been sitting in Redis for weeks", async () => {
    // Pausing the etranslation queue parked 37k jobs for two months in
    // production. Their HTML is an old revision: collecting it builds a group
    // and spends quota on a submission Plone rejects on serial_id anyway.
    const stale = Date.now() - config.staleJobMaxAgeMs - 60_000;
    const result = await JOBS_MAPPING.call_etranslation(
      { obj_url: "cca/en/a-page", obj_uid: "u", html: HTML, serial_id: 1, language: "de" },
      { timestamp: stale, log: async () => {} } as any,
    );

    expect(result).toMatchObject({ status: "dropped", reason: "stale job" });
    expect(queueAdds).toHaveLength(0);
    expect(await store.inFlightCount()).toBe(0);
  });

  it("still collects a job that is merely old-ish", async () => {
    const recent = Date.now() - config.staleJobMaxAgeMs + 60_000;
    const result = await JOBS_MAPPING.call_etranslation(
      { obj_url: "cca/en/a-page", obj_uid: "u", html: HTML, serial_id: 1, language: "de" },
      { timestamp: recent, log: async () => {} } as any,
    );
    expect(result).toMatchObject({ status: "collected" });
    expect(queueAdds).toHaveLength(1);
  });

  it("schedules exactly one bundled submission for 26 per-language jobs", async () => {
    for (const language of LANGS) {
      await JOBS_MAPPING.call_etranslation({
        obj_url: "cca/en/a-page", obj_uid: "uid-1", html: HTML, serial_id: 5, language,
      });
    }
    expect(fetchCalls).toHaveLength(0);
    expect(queueAdds).toHaveLength(1);
    expect(queueAdds[0].name).toBe("submit_group");
    expect(queueAdds[0].data).toEqual({ key: "cca/en/a-page" });
    expect(queueAdds[0].opts.delay).toBe(config.groupWindowMs);
  });
});

describe("submit_group", () => {
  beforeEach(() => {
    config.groupingEnabled = true;
  });

  it("sends one request carrying every language and a short externalReference", async () => {
    await seedGroup();
    responses.push({ requestId: 4242 });

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(fetchCalls).toHaveLength(1);
    const form = fetchCalls[0].form;
    expect(String(form.get("target_lang")).split(",")).toHaveLength(26);
    const extRef = String(form.get("ext_ref"));
    expect(extRef).toMatch(/^cca-[0-9a-f]{16}$/);
    expect(extRef.length).toBeLessThanOrEqual(200);
    // obj_path keeps the staleness guard but must not pretend to know a language
    expect(String(form.get("obj_path"))).not.toContain("language=");

    expect(result).toMatchObject({ status: "submitted", requestId: "4242" });
    expect(await store.inFlightCount()).toBe(1);
  });

  it("turns -11200 into a delayed requeue instead of a failed job", async () => {
    await seedGroup();
    responses.push({
      error_type: {
        type: "ValueError",
        message:
          "REST v2 eTranslation request failed: status_code=400 errorCode=-11200 errorMessage=QUOTA_EXCEEDED",
      },
    });

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "requeued", reason: "quota_exceeded" });
    expect(await store.breakerOpen()).toBe(true);
    expect(await store.inFlightCount()).toBe(0);
    expect(queueAdds).toHaveLength(1);
    // the group was already closed, so the payload must ride with the job
    expect(queueAdds[0].data.payload.langs).toHaveLength(26);
  });

  it("backs off when the quota arrives as errorCode rather than error_type", async () => {
    // Plone can hand the service eTranslation's own error envelope. The shared
    // post helper turns it into an Error, and JSON.stringify(Error) is "{}",
    // so quota detection has to read the message.
    await seedGroup();
    responses.push({ errorCode: "-11200", errorMessage: "QUOTA_EXCEEDED" });

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "requeued", reason: "quota_exceeded" });
    expect(await store.breakerOpen()).toBe(true);
    expect(await store.inFlightCount()).toBe(0);
  });

  it("does not take a slot when Plone declines to call eTranslation", async () => {
    // transId="not-called" is a string, so `transId < 0` misses it. Treating it
    // as a success would park a phantom submission in the gate for the whole
    // lease and stall the pipeline.
    await seedGroup();
    responses.push({ transId: "not-called", reason: "localhost" });

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "skipped", reason: "localhost" });
    expect(await store.inFlightCount()).toBe(0);
    expect(queueAdds).toHaveLength(0);
  });

  it("requeues when eTranslation declines to queue the request", async () => {
    // transId < 0 is the existing "not queued" signal. It must not hard-fail:
    // the group is already consumed, so only a payload-carrying requeue saves
    // the translations.
    await seedGroup();
    responses.push({ transId: -1 });

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "requeued", reason: "not_queued" });
    expect(queueAdds[0].data.payload.langs).toHaveLength(26);
    expect(await store.inFlightCount()).toBe(0);
  });

  it("does not let one object's translations satisfy a different object's", async () => {
    // Different pages routinely convert to byte-identical HTML. If the cache
    // key were the HTML alone, the second page would be reported as already
    // translated and silently never submitted.
    await seedGroup();
    responses.push({ requestId: 4242 });
    const submitted: any = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });
    for (const language of LANGS) {
      responses.push({ url: "http://portal/x" });
      await JOBS_MAPPING.save_translated_html({
        obj_path: `cca-${submitted.token}`, html: "<p>x</p>", language,
      });
    }

    await seedGroup("cca/en/an-identical-looking-page", LANGS, 5, "uid-2");
    responses.push({ requestId: 4243 });
    const other: any = await JOBS_MAPPING.submit_group({ key: "cca/en/an-identical-looking-page" });

    expect(other.status).toBe("submitted");
    expect(other.langs).toHaveLength(LANGS.length);
  });

  it("keeps the translations when the submission call itself fails", async () => {
    // Plone 500 / dropped connection. The group is already consumed, so the
    // payload has to ride along with a retry or all 26 languages are lost.
    await seedGroup();
    responses.push(new Error("connection reset by peer"));

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "requeued", reason: "error" });
    expect(queueAdds[0].data.payload.langs).toHaveLength(26);
    expect(queueAdds[0].data.payload.attempt).toBe(1);
  });

  it("gives up rather than retrying a bad request forever", async () => {
    // Retrying is what saves the group, but a genuinely malformed request must
    // end up in the failed set instead of requeueing until it goes stale.
    const payload = {
      obj_url: "cca/en/a-page", obj_uid: "uid-1", serial_id: 5,
      html: HTML, langs: LANGS, sha: sha(), queued_at: Date.now(),
      attempt: config.submitMaxAttempts,
    };
    responses.push(new Error("connection reset by peer"));

    await expect(
      JOBS_MAPPING.submit_group({ key: "unused", payload }),
    ).rejects.toThrow(/connection reset/);
    expect(queueAdds).toHaveLength(0);
  });

  it("does not mistake another errorCode for a quota rejection", async () => {
    await seedGroup();
    responses.push({ errorCode: "-10003", errorMessage: "EXTERNAL_REFERENCE_TOO_LONG" });

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    // Retried like any other failure, but the breaker stays shut: this object
    // has a bad reference, not a quota problem, and must not stall the pipeline.
    expect(result).toMatchObject({ status: "requeued", reason: "error" });
    expect(await store.breakerOpen()).toBe(false);
    expect(queueAdds[0].data.payload.attempt).toBe(1);
  });

  it("waits for a free slot instead of submitting over the ceiling", async () => {
    config.maxInFlight = 1;
    await store.reserve("existing", { request_id: "r", remaining: 1, langs: ["de"] });
    await seedGroup();

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "requeued", reason: "at_capacity" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("skips languages already translated for identical source HTML", async () => {
    await seedGroup();
    for (const lang of LANGS) await store.markTranslated(sha(), lang);

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "cached", skipped: 26 });
    expect(fetchCalls).toHaveLength(0);
  });

  it("submits only the languages that are not cached yet", async () => {
    await seedGroup("cca/en/a-page", LANGS);
    for (const lang of LANGS.slice(1)) await store.markTranslated(sha(), lang);

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });
    expect(result).toMatchObject({ status: "submitted" });
    expect(String(fetchCalls[0].form.get("target_lang"))).toBe(LANGS[0]);
  });

  it("is a no-op when the group was already consumed", async () => {
    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/never-collected" });
    expect(result).toMatchObject({ status: "empty" });
    expect(fetchCalls).toHaveLength(0);
  });

  it("drops a backlog job instead of burning quota on stale content", async () => {
    await seedGroup();
    const result = await JOBS_MAPPING.submit_group({
      key: "cca/en/a-page",
      payload: {
        obj_url: "cca/en/a-page", obj_uid: "uid-1", serial_id: 5, html: HTML,
        langs: LANGS, sha: sha(), queued_at: Date.now() - config.staleJobMaxAgeMs - 1000,
      },
    });
    expect(result).toMatchObject({ status: "dropped", reason: "stale" });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("save_translated_html", () => {
  async function submitOnce(): Promise<string> {
    config.groupingEnabled = true;
    await seedGroup();
    responses.push({ requestId: 4242 });
    const result: any = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });
    return result.token;
  }

  it("resolves a bundled reference and releases the slot as deliveries land", async () => {
    const token = await submitOnce();
    expect(await store.inFlightCount()).toBe(1);

    for (const language of LANGS) {
      responses.push({ url: "http://portal/de/page" });
      await JOBS_MAPPING.save_translated_html({
        obj_path: `cca-${token}`, html: "<p>translated</p>", language,
      });
    }

    expect(await store.inFlightCount()).toBe(0);
    expect((await store.translatedLangs(sha())).sort()).toEqual([...LANGS].sort());
  });

  it("holds the slot when a language is silently never delivered", async () => {
    const token = await submitOnce();
    for (const language of LANGS.slice(1)) {
      responses.push({ url: "http://portal/de/page" });
      await JOBS_MAPPING.save_translated_html({
        obj_path: `cca-${token}`, html: "<p>translated</p>", language,
      });
    }
    // EN->ET never arrives: the lease, not the delivery, frees the slot
    expect(await store.inFlightCount()).toBe(1);
    redis.advance(config.leaseMs + 1);
    expect(await store.inFlightCount()).toBe(0);
  });

  it("posts a site-relative path for a bundled delivery", async () => {
    // @@save-etranslation traverses relative to the portal, so the correlation
    // record's "cca/en/a-page" has to arrive as "/en/a-page".
    const token = await submitOnce();
    responses.push({ url: "http://portal/de/page" });
    await JOBS_MAPPING.save_translated_html({
      obj_path: `cca-${token}`, html: "<p>translated</p>", language: "de",
    });

    const save = fetchCalls.filter((c) => c.url.includes("save-etranslation")).pop()!;
    expect(save.form.get("path")).toBe("/en/a-page");
    expect(save.form.get("serial_id")).toBe("5");
    expect(save.form.get("obj_uid")).toBe("uid-1");
  });

  it("refuses to save a bundled delivery whose language is unknown", async () => {
    const token = await submitOnce();
    await expect(
      JOBS_MAPPING.save_translated_html({ obj_path: `cca-${token}`, html: "<p>x</p>" }),
    ).rejects.toThrow(/without a language/);
    expect(fetchCalls.filter((c) => c.url.includes("save-etranslation"))).toHaveLength(0);
  });

  it("does not cache a translation Plone discarded, but still frees the slot", async () => {
    config.groupingEnabled = true;
    await seedGroup("cca/en/a-page", ["de"]);
    responses.push({ requestId: 4242 });
    const submitted: any = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });
    expect(await store.inFlightCount()).toBe(1);

    responses.push({ error_type: "mismatched serial id" });
    await expect(
      JOBS_MAPPING.save_translated_html({
        obj_path: `cca-${submitted.token}`, html: "<p>x</p>", language: "de",
      }),
    ).rejects.toBe("mismatched serial id");

    // the translation was thrown away, so it must be translatable again...
    expect(await store.translatedLangs(sha())).toEqual([]);
    // ...and the delivery was still consumed, so the slot must not be held
    expect(await store.inFlightCount()).toBe(0);
  });

  it("keeps working for legacy references already in flight", async () => {
    responses.push({ url: "http://portal/de/page" });
    const result = await JOBS_MAPPING.save_translated_html({
      obj_path: "cca/en/a-page?serial_id=5&language=de&obj_uid=uid-1",
      html: "<p>translated</p>",
    });
    const form = fetchCalls[0].form;
    expect(form.get("path")).toBe("/en/a-page");
    expect(form.get("language")).toBe("de");
    expect(form.get("serial_id")).toBe("5");
    expect(result).toMatchObject({ url: "http://portal/de/page" });
  });

  it("refuses a legacy reference that carries no language", async () => {
    await expect(
      JOBS_MAPPING.save_translated_html({
        obj_path: "cca/en/a-page?serial_id=5&obj_uid=uid-1",
        html: "<p>x</p>",
      }),
    ).rejects.toThrow(/carries no language/);
  });
});

describe("translation_failed (eTranslation failure notification)", () => {
  beforeEach(() => {
    config.groupingEnabled = true;
  });

  async function submitAndGetToken(): Promise<string> {
    await seedGroup();
    responses.push({ requestId: 4242, transId: 4242 });
    const r: any = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });
    return r.token;
  }

  it("frees the slot when the outstanding languages are reported failed", async () => {
    // 25 delivered, one failing upstream. Before failure notifications that
    // slot sat for the whole lease with nothing to explain it.
    const token = await submitAndGetToken();
    for (const language of LANGS.slice(1)) {
      responses.push({ url: "http://portal/x" });
      await JOBS_MAPPING.save_translated_html({
        obj_path: `cca-${token}`, html: "<p>x</p>", language,
      });
    }
    expect(await store.inFlightCount()).toBe(1);

    const result = await JOBS_MAPPING.translation_failed({
      obj_path: `cca-${token}`,
      request_id: 4242,
      languages: [LANGS[0].toUpperCase()],
      error_code: -30000,
      error_message: "Cannot convert input file",
    });

    expect(result).toMatchObject({ status: "recorded", langs: [LANGS[0]], remaining: 0 });
    expect(await store.inFlightCount()).toBe(0);
  });

  it("counts distinct languages, so a redelivered notification cannot over-release", async () => {
    const token = await submitAndGetToken();
    await JOBS_MAPPING.translation_failed({ obj_path: `cca-${token}`, languages: ["de", "fr"] });
    await JOBS_MAPPING.translation_failed({ obj_path: `cca-${token}`, languages: ["de", "fr"] });
    expect(await store.inFlightCount()).toBe(1); // 24 still outstanding
  });

  it("leaves the slot to the lease when the notification names no language", async () => {
    const token = await submitAndGetToken();
    const result = await JOBS_MAPPING.translation_failed({
      obj_path: `cca-${token}`, languages: [],
    });
    expect(result).toMatchObject({ status: "recorded", unattributed: true });
    expect(await store.inFlightCount()).toBe(1);
  });

  it("ignores a notification whose correlation has expired", async () => {
    const result = await JOBS_MAPPING.translation_failed({
      obj_path: "cca-0123456789abcdef", languages: ["de"],
    });
    expect(result).toMatchObject({ status: "ignored", reason: "unknown token" });
    expect(await store.inFlightCount()).toBe(0);
  });

  it("ignores a legacy reference, which has no gate to free", async () => {
    const result = await JOBS_MAPPING.translation_failed({
      obj_path: "/en/a-page?serial_id=1&language=de", languages: ["de"],
    });
    expect(result).toMatchObject({ status: "ignored", reason: "unrecognised reference" });
  });
});
