/**
 * Runtime configuration for the quota-aware eTranslation pipeline.
 *
 * Everything here defaults to "off / today's behaviour" so that the service can
 * be deployed before the matching Plone change lands. See
 * ../../../artifacts/ETRANSLATION-QUOTA-DESIGN.md
 */

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Ignoring non-numeric ${name}=${raw}, using ${fallback}`);
    return fallback;
  }
  return parsed;
}

export const config = {
  /**
   * Master switch. When false the worker behaves exactly as it always has: one
   * eTranslation submission per (object, language), no grouping, no gate.
   *
   * Must stay false until the Plone change that (a) accepts a comma separated
   * target_lang and an ext_ref on @@call-etranslation and (b) forwards
   * targetLanguage as "language" on @@translate-callback is deployed. Bundled
   * requests share a single externalReference, so without (b) the worker cannot
   * tell which language a delivery is for.
   */
  groupingEnabled: boolEnv("ETL_GROUPING_ENABLED", false),

  /** Debounce window used to collect the per-language jobs of one object. */
  groupWindowMs: intEnv("ETL_GROUP_WINDOW_MS", 10_000),

  /** How long a group record survives while it waits to be submitted. */
  groupTtlSec: intEnv("ETL_GROUP_TTL_SEC", 3600),

  /**
   * Ceiling on concurrent in-flight eTranslation submissions. The documented
   * per-client concurrency quota is 50 documents, so the default leaves headroom
   * for anything else sharing this account.
   */
  maxInFlight: intEnv("ETL_MAX_INFLIGHT", 40),

  /**
   * A submission slot is released when every language has been delivered, but a
   * language can silently never be delivered (observed with EN->ET), so the
   * lease is what guarantees slots come back.
   */
  leaseMs: intEnv("ETL_LEASE_MS", 15 * 60_000),

  /** How long intake pauses after a -11200 QUOTA_EXCEEDED. */
  breakerMs: intEnv("ETL_BREAKER_MS", 30_000),

  /** Skip languages already translated for byte-identical source HTML. */
  skipCache: boolEnv("ETL_SKIP_CACHE", true),
  skipCacheTtlSec: intEnv("ETL_SKIP_CACHE_TTL_SEC", 7 * 86_400),

  /** Correlation records must outlive the slowest translation round-trip. */
  corrTtlSec: intEnv("ETL_CORR_TTL_SEC", 86_400),

  /** Jobs older than this are dropped instead of submitted. */
  staleJobMaxAgeMs: intEnv("ETL_STALE_JOB_MAX_AGE_MS", 7 * 86_400),

  /**
   * How many times a submission may be retried after an unexpected failure
   * (Plone 500, network blip) before the job is allowed to fail. The group has
   * already been consumed by then, so retrying is the only way to keep the
   * translations - but a genuinely bad request must not loop for a week.
   */
  submitMaxAttempts: intEnv("ETL_SUBMIT_MAX_ATTEMPTS", 5),
  errorBackoffMs: intEnv("ETL_ERROR_BACKOFF_MS", 30_000),

  /** Queue used for the bundled submission stage. */
  submitQueue: process.env.ETL_SUBMIT_QUEUE || "etranslation_submit",
};

export type Config = typeof config;

export const DEFAULT_ENABLED_JOBS =
  "call_etranslation,save_translated_html,sync_translated_paths,delete_translation,submit_group,translation_failed";
export const DEFAULT_QUEUES =
  "etranslation,save_etranslation,sync_paths,delete_translation,etranslation_submit";
