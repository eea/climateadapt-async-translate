import type {
  CallETranslation,
  MoveInfo,
  SaveTranslation,
  TypeJobsMapping,
  DeleteTranslation,
} from "./types";
import mockData from "./mock-data.json";
import { RateLimitError, Job } from "bullmq";

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:8080/cca";
const TRANSLATION_AUTH_TOKEN =
  process.env.TRANSLATION_AUTH_TOKEN || "hello1234";

console.log("Portal URL: ", PORTAL_URL);

type Mapping = { [key: string]: any };

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

  if (contentType === "application/json") {
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

export async function mockTranslationCallback(obj_path: string) {
  const form = dataToForm({ ...mockData, "external-reference": obj_path });
  const response = await fetch(`${PORTAL_URL}/@@translate-callback`, {
    method: "POST",
    body: form,
  });
  const result = await response.text();
  return result;
}

async function call_etranslation(data: CallETranslation, job?: Job) {
  // TODO: reimplement the call here directly
  const obj_path = `${data.obj_url}?serial_id=${data.serial_id}&language=${data.language
    }${data.obj_uid ? `&obj_uid=${data.obj_uid}` : ""}`;

  // here we call plone view which calls eTranslation with the necessary info
  const startMsg = `Calling eTranslation for ${obj_path}`;
  console.log(startMsg);
  if (job) await job.log(startMsg);

  const form = dataToForm({
    html: data.html,
    target_lang: data.language,
    obj_path,
    obj_uid: data.obj_uid || "",
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
    throw result.error_type;
  }

  if (result.transId < 0) {
    throw new RateLimitError("eTranslation not queued");
  }

  return result;
}

async function save_translated_html(data: SaveTranslation, job?: Job) {
  const { obj_path, html } = data;
  const fragpath = obj_path.startsWith("/en")
    ? obj_path
    : obj_path.startsWith("en/")
      ? `/${obj_path}`
      : obj_path.startsWith("cca")
        ? obj_path.replace("cca/", "/")
        : `/en/${obj_path}`;
  const url_path = `http://example.com${fragpath}`;
  const url = new URL(url_path);
  const form = dataToForm({
    path: url.pathname,
    html,
    language: url.searchParams.get("language") || "missing",
    serial_id: url.searchParams.get("serial_id") || "missing",
    obj_uid: url.searchParams.get("obj_uid") || "",
  });

  const logMsg = `Saving translated HTML to ${url.pathname}`;
  console.log(logMsg);
  if (job) await job.log(logMsg);

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
  return result;
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
  save_translated_html,
  sync_translated_paths,
  delete_translation,
};
