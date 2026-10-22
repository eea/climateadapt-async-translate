import { describe, expect, beforeEach, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { JOBS_MAPPING } from "../src/jobs";
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
const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

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
    return jsonResponse(responses.shift() ?? { ok: true });
  });

  config.groupingEnabled = false;
  config.maxInFlight = 40;
});

async function seedGroup(objUrl = "cca/en/a-page", langs = LANGS, serialId = 5) {
  for (const language of langs) {
    await store.collectGroup(objUrl, {
      obj_uid: "uid-1",
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
    expect(extRef).toMatch(/^cca-[0-9a-f]{10}$/);
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

  it("does not mistake another errorCode for a quota rejection", async () => {
    await seedGroup();
    responses.push({ errorCode: "-10003", errorMessage: "EXTERNAL_REFERENCE_TOO_LONG" });

    await expect(JOBS_MAPPING.submit_group({ key: "cca/en/a-page" })).rejects.toThrow(
      /errorCode=-10003/,
    );
    expect(await store.breakerOpen()).toBe(false);
    expect(queueAdds).toHaveLength(0);
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
    for (const lang of LANGS) await store.markTranslated(sha256(HTML), lang);

    const result = await JOBS_MAPPING.submit_group({ key: "cca/en/a-page" });

    expect(result).toMatchObject({ status: "cached", skipped: 26 });
    expect(fetchCalls).toHaveLength(0);
  });

  it("submits only the languages that are not cached yet", async () => {
    await seedGroup("cca/en/a-page", LANGS);
    for (const lang of LANGS.slice(1)) await store.markTranslated(sha256(HTML), lang);

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
        langs: LANGS, sha: sha256(HTML), queued_at: Date.now() - config.staleJobMaxAgeMs - 1000,
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
    expect((await store.translatedLangs(sha256(HTML))).sort()).toEqual([...LANGS].sort());
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
    expect(await store.translatedLangs(sha256(HTML))).toEqual([]);
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
