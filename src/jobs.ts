import type {
  CallETranslation,
  MoveInfo,
  SaveTranslation,
  SubmitGroup,
  TypeJobsMapping,
  DeleteTranslation,
} from "./types";
import mockData from "./mock-data.json";
import { RateLimitError, Job } from "bullmq";
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { getStore, getSubmitQueue } from "./deps";

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:8080/cca";
const TRANSLATION_AUTH_TOKEN =
  process.env.TRANSLATION_AUTH_TOKEN || "hello1234";

console.log("Portal URL: ", PORTAL_URL);

type Mapping = { [key: string]: any };

/**
 * externalReference prefix for a bundled submission. eTranslation echoes this
 * value back verbatim on every per-language delivery, and the REST v2 schema
 * caps it at 200 characters - the legacy obj_path form (path + serial_id +
 * language + obj_uid) measured 210 characters on a deep path and was rejected
 * with errorCode=-10003.
 */
const REF_PREFIX = "cca";
const TOKEN_RE = /^cca-([a-z0-9]{6,16})$/;

/** eTranslation's code for exceeding the concurrency quota. */
const QUOTA_EXCEEDED = "-11200";

function dataToForm(data: Mapping) {
  const form = new FormData();
  Object.entries(data).forEach(([name, value]) => {
    form.append(name, value);
  });
  return form;
}

async function processResponse(response: any) {
  const contentType = response.headers.get("Content-Type");
  const text = await response.text();

  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch (error: any) {
      error.reason = "Error converting response to json";
      error.responseText = text.substring(0, 1000);
      return { error_type: error };
    }
  }

  return { error_type: text, reason: "Unknown failure" };
}

function newToken(): string {
  // Exactly 10 chars of [a-z0-9]; keeps externalReference at a fixed 14 chars
  // and inside TOKEN_RE below.
  return randomBytes(8).toString("hex").slice(0, 10);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isQuotaExceeded(error: unknown): boolean {
  if (error instanceof Error) return error.message.includes(QUOTA_EXCEEDED);
  return JSON.stringify(error ?? "").includes(QUOTA_EXCEEDED);
}

export async function mockTranslationCallback(obj_path: string) {
  const form = dataToForm({ ...mockData, "external-reference": obj_path });
  const response = await fetch(`${PORTAL_URL}/@@translate-callback`, {
    method: "POST",
    body: form,
  });
  const result = await response.text();
  return result;
}

/**
 * Ask Plone to submit a translation. Returns the parsed response instead of
 * throwing, so callers can tell a quota rejection (retry later) from a genuine
 * bad request (fail the job).
 */
async function postCallETranslation(args: {
  html: string;
  targetLang: string;
  objPath: string;
  objUid: string;
  extRef?: string;
}): Promise<{ ok: boolean; result?: any; error?: any }> {
  const { html, targetLang, objPath, objUid, extRef } = args;

  const form = dataToForm({
    html,
    target_lang: targetLang,
    obj_path: objPath,
    obj_uid: objUid,
    ...(extRef ? { ext_ref: extRef } : {}),
  });

  const response = await fetch(`${PORTAL_URL}/@@call-etranslation`, {
    method: "POST",
    body: form,
    headers: {
      Authentication: TRANSLATION_AUTH_TOKEN,
    },
  });

  const result = await processResponse(response);

  if (result.error_type) {
    return { ok: false, error: result.error_type };
  }
  if (result.errorCode || result.errorMessage) {
    // Returned, not thrown: submit_group has to tell a quota rejection
    // (-11200) from any other failure and back off instead of burning retries.
    // The legacy path still raises it, via `if (!ok) throw error`.
    return {
      ok: false,
      error: new Error(
        `eTranslation failed: errorCode=${result.errorCode || "missing"} ` +
          `errorMessage=${result.errorMessage || "missing"}`,
      ),
    };
  }

  if (result.transId < 0) {
    return { ok: false, error: new RateLimitError("eTranslation not queued") };
  }
  return { ok: true, result };
}

/** The legacy obj_path shape: carries everything the save step needs. */
function legacyObjPath(data: CallETranslation): string {
  return `${data.obj_url}?serial_id=${data.serial_id}&language=${data.language
    }${data.obj_uid ? `&obj_uid=${data.obj_uid}` : ""}`;
}

/**
 * Turn a site-qualified path ("cca/en/a-page") into the site-relative form
 * (@@save-etranslation traverses relative to the portal, so "cca/en/x" would be
 * looked up as a child of the site and fail).
 */
function toSiteRelativePath(objPath: string): string {
  if (objPath.startsWith("/en")) return objPath;
  if (objPath.startsWith("en/")) return `/${objPath}`;
  if (objPath.startsWith("cca")) return objPath.replace("cca/", "/");
  return `/en/${objPath}`;
}

// ---------------------------------------------------------------------------
// Stage 1: collector
// ---------------------------------------------------------------------------

/**
 * Grouping-enabled replacement for `call_etranslation`. It performs no eTranslation
 * call at all: it folds the per-language jobs Plone queues for one object into a
 * group and schedules a single bundled submission. Cost: zero quota.
 */
async function collect_etranslation(data: CallETranslation, job?: Job) {
  const store = getStore();

  const count = await store.collectGroup(data.obj_url, {
    obj_uid: data.obj_uid || "",
    serial_id: data.serial_id,
    html: data.html,
    language: data.language,
  });

  const msg = `Collected ${data.language} for ${data.obj_url} (${count} language(s) in window)`;
  console.log(msg);
  if (job) await job.log(msg);

  if (await store.armWindow(data.obj_url)) {
    await getSubmitQueue().add(
      "submit_group",
      { key: data.obj_url },
      {
        delay: config.groupWindowMs,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );
    await store.stat("groups_scheduled");
  }

  return { status: "collected", langs: count };
}

/**
 * Original behaviour: one eTranslation submission per (object, language).
 * Kept verbatim so the service is byte-compatible with a Plone that has not
 * received the multi-language change yet.
 */
async function call_etranslation(data: CallETranslation, job?: Job) {
  if (config.groupingEnabled) {
    return collect_etranslation(data, job);
  }

  const obj_path = legacyObjPath(data);

  const startMsg = `Calling eTranslation for ${obj_path}`;
  console.log(startMsg);
  if (job) await job.log(startMsg);

  const { ok, result, error } = await postCallETranslation({
    html: data.html,
    targetLang: data.language,
    objPath: obj_path,
    objUid: data.obj_uid || "",
  });

  if (!ok) {
    throw error;
  }

  const doneMsg =
    `eTranslation queued requestId=${result.requestId || result.transId || "missing"} ` +
    `externalRefId=${result.externalRefId || obj_path}`;
  console.log(doneMsg);
  if (job) await job.log(doneMsg);

  return result;
}

// ---------------------------------------------------------------------------
// Stage 2: bundled submission
// ---------------------------------------------------------------------------

type GroupPayload = NonNullable<SubmitGroup["payload"]>;

async function requeueSubmit(payload: GroupPayload, reason: string, delay: number) {
  const jitter = Math.floor(Math.random() * 1000);
  await getSubmitQueue().add(
    "submit_group",
    { key: payload.obj_url, payload },
    { delay: delay + jitter, attempts: 1 },
  );
  await getStore().stat(`requeued_${reason}`);
  const msg = `Requeued submission for ${payload.obj_url}: ${reason} (in ${delay + jitter}ms)`;
  console.log(msg);
  return { status: "requeued", reason, delay: delay + jitter };
}

async function submit_group(data: SubmitGroup, job?: Job) {
  const store = getStore();
  await store.stat("submit_attempts");

  let payload = data.payload;

  if (!payload) {
    const group = await store.readAndCloseGroup(data.key);
    if (!group || group.langs.length === 0) {
      return { status: "empty", reason: "group already consumed" };
    }
    payload = { ...group, sha: sha256(group.html), queued_at: Date.now() };
  }

  if (Date.now() - payload.queued_at > config.staleJobMaxAgeMs) {
    await store.stat("dropped_stale");
    console.warn(`Dropping stale translation for ${payload.obj_url}`);
    return { status: "dropped", reason: "stale" };
  }

  // Skip languages already translated for byte-identical source HTML.
  const already = await store.translatedLangs(payload.sha);
  const langs = payload.langs.filter((lang) => !already.includes(lang));
  if (langs.length === 0) {
    await store.stat("cache_skipped");
    return { status: "cached", skipped: payload.langs.length };
  }

  // Concurrency gate: eTranslation allows 50 active submissions per client and
  // keeps rejecting until the number falls back below the quota.
  if (await store.breakerOpen()) {
    return requeueSubmit(payload, "breaker", config.breakerMs);
  }
  const inFlight = await store.inFlightCount();
  if (inFlight >= config.maxInFlight) {
    return requeueSubmit(payload, "at_capacity", 5000);
  }

  const token = newToken();
  const extRef = `${REF_PREFIX}-${token}`;

  // obj_path is used by Plone only for the serial_id / obj_uid staleness guard.
  // It deliberately carries no language: with a bundled request the language
  // comes back on each delivery, and a save that could not tell the two apart
  // would write one language's text into another.
  const objPath = `${payload.obj_url}?serial_id=${payload.serial_id}${payload.obj_uid ? `&obj_uid=${payload.obj_uid}` : ""
    }`;

  const startMsg = `Submitting ${langs.length} language(s) for ${payload.obj_url} as ${extRef} (in flight: ${inFlight})`;
  console.log(startMsg);
  if (job) await job.log(startMsg);

  const { ok, result, error } = await postCallETranslation({
    html: payload.html,
    targetLang: langs.join(","),
    objPath,
    objUid: payload.obj_uid,
    extRef,
  });

  if (!ok) {
    if (isQuotaExceeded(error)) {
      await store.openBreaker();
      await store.stat("quota_exceeded");
      console.warn(
        `event=etl.quota_backoff obj_url=${payload.obj_url} in_flight=${inFlight} limit=${config.maxInFlight}`,
      );
      return requeueSubmit(payload, "quota_exceeded", config.breakerMs);
    }
    throw error;
  }

  const requestId = String(result?.requestId ?? result?.transId ?? "");

  await store.saveCorrelation({
    token,
    path: payload.obj_url,
    obj_uid: payload.obj_uid,
    serial_id: String(payload.serial_id),
    sha: payload.sha,
    langs: langs.join(","),
    request_id: requestId,
  });

  await store.reserve(token, {
    request_id: requestId,
    remaining: langs.length,
    langs,
  });

  await store.stat("submissions");
  await store.stat("submitted_languages", langs.length);

  const doneMsg = `event=etl.submit token=${token} request_id=${requestId} langs=${langs.length} in_flight=${inFlight + 1}`;
  console.log(doneMsg);
  if (job) await job.log(doneMsg);

  return { status: "submitted", token, requestId, langs };
}

// ---------------------------------------------------------------------------
// Stage 3: ingestion
// ---------------------------------------------------------------------------

async function save_translated_html(data: SaveTranslation, job?: Job) {
  const store = getStore();
  const { obj_path, html } = data;

  let path: string;
  let language: string;
  let serialId: string;
  let objUid: string;
  let sha = "";
  let token: string | null = null;

  const bundled = TOKEN_RE.exec(obj_path);

  if (bundled) {
    token = bundled[1];
    const corr = await store.getCorrelation(token);
    if (!corr) {
      throw new Error(
        `Unknown eTranslation correlation token ${token} - the correlation record expired`,
      );
    }
    path = toSiteRelativePath(corr.path);
    serialId = corr.serial_id;
    objUid = corr.obj_uid;
    sha = corr.sha;

    // A bundled request has one externalReference shared by every delivery, so
    // the language can only come from the callback payload. Plone forwards it
    // as "language"; if it is absent the deployed Plone predates that change.
    language = (data as { language?: string }).language || "";
    if (!language) {
      throw new Error(
        `Bundled delivery for ${token} arrived without a language. The deployed ` +
        `Plone does not forward targetLanguage from @@translate-callback, so ` +
        `ETL_GROUPING_ENABLED must stay off.`,
      );
    }
    language = language.toLowerCase();
  } else {
    const url_path = `http://example.com${toSiteRelativePath(obj_path)}`;
    const url = new URL(url_path);

    path = url.pathname;
    language = url.searchParams.get("language") || "";
    serialId = url.searchParams.get("serial_id") || "missing";
    objUid = url.searchParams.get("obj_uid") || "";

    if (!language) {
      // A legacy-shaped reference with no language means a bundled submission
      // was answered by a Plone that ignored ext_ref. Saving would write one
      // language's text into every other language, so refuse instead.
      throw new Error(
        `Translation callback for ${path} carries no language; refusing to save`,
      );
    }
  }

  const form = dataToForm({
    path,
    html,
    language,
    serial_id: serialId,
    obj_uid: objUid,
  });

  const logMsg = `Saving translated HTML to ${path} (${language})`;
  console.log(logMsg);
  if (job) await job.log(logMsg);

  try {
    const response = await fetch(`${PORTAL_URL}/@@save-etranslation`, {
      method: "POST",
      body: form,
      headers: {
        Authentication: TRANSLATION_AUTH_TOKEN,
      },
    });

    const result = await processResponse(response);

    if (result.error_type) {
      throw result.error_type;
    }

    // Only a real save may poison the cache. "canonical object removed",
    // "skipped"/"object_replaced" and a mismatched serial id all mean the
    // translation was discarded and the object should be translated again.
    if (sha && result.url) {
      await store.markTranslated(sha, language);
    }

    return result;
  } finally {
    // The delivery arrived, so this language is finished with - whether or not
    // Plone accepted it. Releasing keeps the slot from being held until the
    // lease expires.
    if (token) {
      const remaining = await store.progress(token);
      if (remaining !== null) {
        console.log(
          `event=etl.delivered token=${token} language=${language} remaining=${remaining}`,
        );
      }
    }
  }
}

async function sync_translated_paths(data: MoveInfo, job?: Job) {
  const logMsg = `Syncing translated paths: ${data.oldName} -> ${data.newName}`;
  console.log(logMsg);
  if (job) await job.log(logMsg);
  const form = dataToForm(data);
  const response = await fetch(`${PORTAL_URL}/@@sync-translated-paths`, {
    method: "POST",
    body: form,
    headers: {
      Authentication: TRANSLATION_AUTH_TOKEN,
    },
  });

  const result = await processResponse(response);

  if (result.error_type) {
    throw result.error_type;
  }

  return result;
}

async function delete_translation(data: DeleteTranslation, job?: Job) {
  const logMsg = `Deleting translations for UIDs: ${data.uids.join(", ")}`;
  console.log(logMsg);
  if (job) await job.log(logMsg);
  const form = dataToForm({ uids: JSON.stringify(data.uids) });
  const response = await fetch(`${PORTAL_URL}/@@delete-translation`, {
    method: "POST",
    body: form,
    headers: {
      Authentication: TRANSLATION_AUTH_TOKEN,
    },
  });

  const result = await processResponse(response);

  if (result.error_type) {
    throw result.error_type;
  }

  return result;
}

export const JOBS_MAPPING: TypeJobsMapping = {
  call_etranslation,
  submit_group,
  save_translated_html,
  sync_translated_paths,
  delete_translation,
};
